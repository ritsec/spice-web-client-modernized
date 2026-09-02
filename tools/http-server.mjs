// Minimal static file server for the Spice Web Client repository.
// Shared by tools/serve.mjs (manual browsing) and tools/run-tests.mjs (test driver).
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
	'.map': 'application/json; charset=utf-8'
};

export function createStaticServer(rootDir) {
	const root = path.resolve(rootDir);
	return createServer((req, res) => {
		(async () => {
			try {
				const url = new URL(req.url, 'http://127.0.0.1');
				const decoded = decodeURIComponent(url.pathname);

				// Candidate paths to resolve, in order.
				// The app spawns Web Workers from root-relative paths (e.g.
				// new Worker('application/WorkerProcess.js')); the real app page sits at
				// /index.html so those resolve, but the test harness page is served from
				// /unittest/. For such requests, also try the path with the /unittest/
				// prefix stripped so worker scripts resolve exactly as in the real app.
				const candidates = [decoded];
				if (decoded.startsWith('/unittest/')) {
					candidates.push(decoded.slice('/unittest'.length));
				}

				for (const candidate of candidates) {
					const file = path.resolve(root, '.' + candidate);
					if (file !== root && !file.startsWith(root + path.sep)) { continue; }
					let st;
					try { st = await stat(file); } catch { continue; }
					if (!st.isFile()) { continue; }
					const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
					res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
					res.end(await readFile(file));
					return;
				}

				res.writeHead(404, { 'Content-Type': 'text/plain' });
				res.end('not found');
			} catch {
				if (!res.headersSent) {
					res.writeHead(404, { 'Content-Type': 'text/plain' });
				}
				res.end('not found');
			}
		})();
	});
}
