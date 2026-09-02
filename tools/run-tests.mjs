#!/usr/bin/env node
// Headless test driver for the Spice Web Client.
//
// Serves the repository, opens unittest/index.html in a headless Chromium and
// reports the result published by unittest/runner.js (window.__wdi_test_results).
//
// Zero npm dependencies: Chromium is driven over its DevTools (CDP) endpoint
// with Node's built-in WebSocket/fetch. Requires Node >= 22.
//
// Usage:
//   node tools/run-tests.mjs                  run the full suite
//   node tools/run-tests.mjs --filter queue   only tests whose name contains "queue"
//   node tools/run-tests.mjs --list           list registered tests and exit
//   node tools/run-tests.mjs --browser <path> use a specific Chromium/Chrome
//   TEST_TIMEOUT_MS=300000 node tools/run-tests.mjs
//
// Browser discovery: --browser > $CHROME_PATH > /usr/bin/chromium* > /usr/bin/google-chrome*
//
// In Docker (preferred; see DEVELOPMENT.md):
//   docker build -t spice-web-client-dev .
//   docker run --rm -v "$PWD":/app spice-web-client-dev [same options]
//
// Exit codes: 0 = all tests passed, 1 = test failures, 2 = harness/infrastructure error.
import { createStaticServer } from './http-server.mjs';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';


const root = fileURLToPath(new URL('..', import.meta.url));
const HELP = `usage: node tools/run-tests.mjs [options]
  --filter <substring>   only run tests whose full name contains <substring>
  --list                 list all registered test names and exit
  --browser <path>       Chromium/Chrome executable (default: $CHROME_PATH or auto-detect)
  --timeout <ms>         overall budget for the page to report (default 300000, env TEST_TIMEOUT_MS)
exit codes: 0 all passed, 1 test failures, 2 harness/infrastructure error`;

function parseArgs(argv) {
	const args = { filter: null, list: false, browser: null, help: false, timeoutMs: Number(process.env.TEST_TIMEOUT_MS || 300000) };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--filter') args.filter = argv[++i];
		else if (a === '--list') args.list = true;
		else if (a === '--browser') args.browser = argv[++i];
		else if (a === '--timeout') args.timeoutMs = Number(argv[++i]);
		else if (a === '--help' || a === '-h') args.help = true;
		else { console.error('unknown argument: ' + a); args.help = true; }
	}
	if (args.help) { console.log(HELP); process.exit(0); }
	return args;
}

function findBrowser(explicit) {
	const candidates = [explicit, process.env.CHROME_PATH,
		'/usr/bin/chromium', '/usr/bin/chromium-browser',
		'/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'].filter(Boolean);
	for (const c of candidates) { if (existsSync(c)) { return c; } }
	return null;
}

async function httpJson(url, init) {
	const res = await fetch(url, init);
	if (!res.ok) { throw new Error(`HTTP ${res.status} for ${url}`); }
	return res.json();
}

// Minimal CDP client over a single target's WebSocket endpoint.
class CDP {
	constructor(wsUrl) {
		this.wsUrl = wsUrl;
		this.id = 0;
		this.pending = new Map();
		this.eventHandlers = [];
	}
	connect() {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(this.wsUrl);
			ws.onopen = () => resolve();
			ws.onerror = () => reject(new Error('DevTools websocket error for ' + this.wsUrl));
			ws.onclose = () => {
				for (const [, p] of this.pending) { p.reject(new Error('DevTools connection closed')); }
				this.pending.clear();
			};
			ws.onmessage = (ev) => {
				let msg;
				try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()); }
				catch { return; }
				if (msg.id && this.pending.has(msg.id)) {
					const p = this.pending.get(msg.id);
					this.pending.delete(msg.id);
					if (msg.error) { p.reject(new Error(msg.error.message || 'CDP error')); }
					else { p.resolve(msg.result); }
				} else if (msg.method) {
					for (const h of this.eventHandlers) { h(msg); }
				}
			};
			this.ws = ws;
		});
	}
	send(method, params = {}) {
		const id = ++this.id;
		this.ws.send(JSON.stringify({ id, method, params }));
		return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
	}
	onEvent(h) { this.eventHandlers.push(h); }
	close() { try { this.ws.close(); } catch { /* already closed */ } }
}

async function launchChromium(exe, pageUrl) {
	const userDataDir = mkdtempSync(path.join(tmpdir(), 'spice-web-client-'));
	const proc = spawn(exe, [
		'--headless',
		'--no-sandbox',
		'--disable-gpu',
		'--disable-dev-shm-usage',
		'--force-device-scale-factor=1',
		'--hide-scrollbars',
		`--user-data-dir=${userDataDir}`,
		'--remote-debugging-port=0',
		pageUrl
	], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });

	return new Promise((resolve, reject) => {
		let buf = '';
		const timer = setTimeout(() => {
			proc.kill('SIGKILL');
			reject(new Error('chromium did not open a DevTools endpoint within 20s:\n' + buf.slice(-800)));
		}, 20000);
		const onExit = (code, sig) => {
			clearTimeout(timer);
			reject(new Error(`chromium exited early (code=${code}, signal=${sig}):\n` + buf.slice(-800)));
		};
		proc.on('exit', onExit);
		proc.stderr.on('data', (d) => {
			buf += d.toString();
			const m = buf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
			if (m) {
				clearTimeout(timer);
				proc.removeListener('exit', onExit);
				resolve({ proc, wsUrl: m[1], userDataDir });
			}
		});
	});
}

async function findPageTarget(devtoolsHttpPort) {
	// The initial about:blank/test page is the single "page" target.
	for (let i = 0; i < 40; i++) {
		const targets = await httpJson(`http://127.0.0.1:${devtoolsHttpPort}/json/list`);
		const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
		if (page) { return page; }
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error('no DevTools page target found');
}

function consoleArgText(arg) {
	if (arg.value !== undefined) { return String(arg.value); }
	if (arg.unserializableValue !== undefined) { return arg.unserializableValue; }
	return arg.description || arg.type || '';
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	// Safety net: guarantee the driver always exits even if CDP or teardown wedges.
	const safetyNet = setTimeout(() => {
		console.error('\nharness: safety-net timeout — forcing exit');
		process.exit(process.exitCode === undefined ? 2 : process.exitCode);
	}, args.timeoutMs + 15000);
	safetyNet.unref();

	const browserPath = findBrowser(args.browser);
	if (!browserPath) {
		console.error('error: no Chromium/Chrome executable found.');
		console.error('       set CHROME_PATH or pass --browser <path>.');
		process.exit(2);
	}

	const server = createStaticServer(root);
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const port = server.address().port;

	const qs = new URLSearchParams();
	if (args.filter) { qs.set('filter', args.filter); }
	if (args.list) { qs.set('list', '1'); }
	const pageUrl = `http://127.0.0.1:${port}/unittest/index.html${qs.toString() ? '?' + qs.toString() : ''}`;

	console.log(`serving: ${root}`);
	console.log(`browser: ${browserPath}`);
	console.log(`running: ${pageUrl}`);
	console.log('');

	let launched = null;
	let cdp = null;
	try {
		launched = await launchChromium(browserPath, pageUrl);
		const m = launched.wsUrl.match(/127\.0\.0\.1:(\d+)/);
		const target = await findPageTarget(m[1]);

		cdp = new CDP(target.webSocketDebuggerUrl);
		await cdp.connect();
		await cdp.send('Runtime.enable');

		// Accumulate the page's console stream so results can be detected even when
		// the page goes unresponsive to CDP Runtime.evaluate after the run.
		const consoleLines = [];
		cdp.onEvent((msg) => {
			if (msg.method === 'Runtime.consoleAPICalled') {
				const line = msg.params.args.map(consoleArgText).join(' ');
				consoleLines.push(line);
				if (msg.params.type === 'error') { console.error(line); }
				else { console.log(line); }
			} else if (msg.method === 'Runtime.exceptionThrown') {
				const d = msg.params.exceptionDetails;
				console.error('[pageexception] ' + (d.text || '') + ((d.exception && d.exception.description) ? '\n' + d.exception.description : ''));
			}
		});

		const deadline = Date.now() + args.timeoutMs;
		let results = null;
		const probeTimeoutMs = 5000;
		const race = (p) => Promise.race([
			p,
			new Promise((_, rej) => setTimeout(() => rej(new Error('CDP call timed out')), probeTimeoutMs))
		]);
		const summaryRe = /^tests:\s*(\d+)\s+passed:\s*(\d+)\s+failed:\s*(\d+)\s+skipped:\s*(\d+).*?time:\s*(\d+)\s*ms/;
		const readResultsCDP = async () => {
			try {
				const probe = await race(cdp.send('Runtime.evaluate', { expression: 'window.__wdi_test_results !== undefined', returnByValue: true }));
				if (!probe.result || !probe.result.value) { return null; }
				const out = await race(cdp.send('Runtime.evaluate', { expression: 'JSON.stringify(window.__wdi_test_results)', returnByValue: true }));
				return JSON.parse(out.result.value);
			} catch (e) {
				return null;
			}
		};
		for (;;) {
			// Primary: detect the runner's summary in the console stream (works even when the
			// page goes unresponsive to Runtime.evaluate after the run).
			let match = null;
			for (const line of consoleLines) {
				const m = line.match(summaryRe);
				if (m) { match = m; break; }
			}
			if (match) {
				results = { total: Number(match[1]), passed: Number(match[2]), failed: Number(match[3]), skipped: Number(match[4]), durationMs: Number(match[5]), failures: [] };
				break;
			}
			// Fallback: read window.__wdi_test_results over CDP (covers --list mode).
			const cdpResults = await readResultsCDP();
			if (cdpResults) { results = cdpResults; break; }
			if (Date.now() > deadline) { throw new Error(`timed out after ${args.timeoutMs}ms waiting for the test runner to report`); }
			await new Promise((r) => setTimeout(r, 300));
		}

		if (Array.isArray(results.list)) {
			results.list.forEach((n) => console.log(n));
			console.log(`\n${results.list.length} tests registered`);
			process.exitCode = 0;
			return;
		}
		if (results.error) {
			console.error(`\nharness error: ${results.error}`);
			process.exitCode = 2;
			return;
		}
		if (!Array.isArray(results.failures) || results.total === 0) {
			console.error('\nharness error: no tests were registered (check script load order in unittest/index.html)');
			process.exitCode = 2;
			return;
		}

		if (results.failed === 0) {
			console.log(`\nRESULT: PASS — ${results.passed} passed, ${results.skipped} skipped, ${results.total} total, ${results.durationMs}ms`);
			process.exitCode = 0;
		} else {
			console.log(`\nRESULT: FAIL — ${results.failed} failed, ${results.passed} passed, ${results.skipped} skipped, ${results.total} total, ${results.durationMs}ms`);
			process.exitCode = 1;
		}
	} catch (e) {
		console.error('\nharness/infrastructure error: ' + String((e && e.message) || e));
		process.exitCode = 2;
	} finally {
		if (cdp) { cdp.close(); }
		if (launched) {
			try { process.kill(-launched.proc.pid, 'SIGKILL'); } catch { process.kill(launched.proc.pid, 'SIGKILL'); }
			await new Promise((resolve) => {
				if (launched.proc.exitCode !== null) { return resolve(); }
				const t = setTimeout(resolve, 2000);
				launched.proc.once('exit', () => { clearTimeout(t); resolve(); });
			});
			rmSync(launched.userDataDir, { recursive: true, force: true });
		}
		await new Promise((resolve) => { try { server.close(resolve); } catch { resolve(); } }).catch(() => {});
	}
}

main();
