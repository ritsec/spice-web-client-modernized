/*
 * WDI test runner
 * ===============
 * Browser-side test harness for the legacy eyeOS test API used by every file
 * in unittest/*.test.js:  suite / setup / teardown / test / test.skip
 * plus sinon (mocks, stubs, spies) and chai (`assert`).
 *
 * Semantics (kept source-compatible with the original framework):
 *   - suite(name, fn)      nested test groups; registered in call order.
 *   - setup(fn)            runs before every test in the enclosing suite
 *                          (parent suites' setup run first).
 *   - teardown(fn)         runs after every test in the enclosing suite
 *                          (inner suites' teardown run first).
 *   - test(name, fn)       synchronous when fn declares no `done` parameter.
 *                          When fn declares `done` (fn.length > 0) the test is
 *                          async and must call done() or done(err) before it
 *                          counts; otherwise it fails after TEST_TIMEOUT_MS.
 *   - test.skip(name, fn)  registered but never executed, reported as skipped.
 *   - `this` inside setup/test/teardown is a single object per test, shared
 *     by all three (the tests rely on this: setup stores `this.sut`, etc.).
	 *   - this.mock(obj), this.stub(obj[, key[, val]]), this.spy(obj[, key])
	 *     create sinon fakes that are auto-restored after the test (skipped when
	 *     the test's own teardown has already restored them). A fake whose
	 *     restore() throws fails the test.
 *   - Tests may also build fakes directly (`this.mock = sinon.mock(x)`) and
 *     restore them in their own teardown; that pattern is untouched.
 *
 * URL parameters:
 *   ?filter=<substring>   only run tests whose full name contains <substring>
 *   ?list=1               list all test names without running them
 *
 * On completion the page exposes:
 *   window.__wdi_test_results = {
 *     total, passed, failed, skipped, filtered, durationMs,
 *     failures: [{ name, error }], harnessErrors: [string]
 *   }
 * (or `{ list: [name, ...] }` in list mode).
 *
 * Loading contract:
 *   - this file MUST be loaded BEFORE any unittest/*.test.js file (they call
 *     suite/setup/teardown/test while being evaluated);
 *   - execution does NOT start on load. The host page calls window.wdiTestRun()
 *     after all test files have registered.
 */
(function (global) {
	'use strict';

	var root = { name: '', suites: [], tests: [], setup: [], teardown: [] };
	var current = root;

	function makeNode(name) {
		return { name: String(name), suites: [], tests: [], setup: [], teardown: [], timeout: function () {} };
	}

	global.suite = function suite(name, fn) {
		var node = makeNode(name);
		current.suites.push(node);
		var prev = current;
		current = node;
		try {
			fn.call(node);
		} finally {
			current = prev;
		}
	};

	global.setup = function (fn) { current.setup.push(fn); };
	global.teardown = function (fn) { current.teardown.push(fn); };

	global.test = function test(name, fn) {
		current.tests.push({ name: String(name), fn: fn, skipped: false });
	};
	global.test.skip = function (name, fn) {
		current.tests.push({ name: String(name), fn: fn, skipped: true });
	};
	global.suite.skip = function suiteSkip(name, fn) {
		var node = makeNode(name);
		node.skippedSuite = true;
		current.suites.push(node);
		var prev = current;
		current = node;
		try {
			fn.call(node);
		} finally {
			current = prev;
		}
	};

	// Diagnostic pool: uncaught page errors (e.g. assertions failing inside
	// async callbacks) are attributed to the still-running test on timeout.
	var pageErrors = [];
	if (global.addEventListener) {
		global.addEventListener('error', function (e) {
			pageErrors.push(String((e && e.message) || e) + ((e && e.filename) ? ' @ ' + e.filename + ':' + e.lineno : ''));
			if (pageErrors.length > 25) { pageErrors.shift(); }
		});
	}

	var TEST_TIMEOUT_MS = 10000;

	function errText(e) {
		if (!e) { return 'unknown error'; }
		if (typeof e === 'string') { return e; }
		var msg = (e.name || 'Error') + ': ' + (e.message || String(e));
		return e.stack ? msg + '\n' + e.stack : msg;
	}

	function buildPlan() {
		var plan = [];
		(function walk(node, prefix, setups, teardowns, inheritedSkip) {
			var s = setups.concat(node.setup);
			var t = node.teardown.concat(teardowns);
			var p = prefix ? prefix + ' > ' + node.name : node.name;
			var skip = inheritedSkip || node.skippedSuite;
			var i, j;
			for (i = 0; i < node.tests.length; i++) {
				plan.push({
					name: p ? p + ' > ' + node.tests[i].name : node.tests[i].name,
					fn: node.tests[i].fn,
					skipped: node.tests[i].skipped || skip,
					setup: s,
					teardown: t
				});
			}
			for (j = 0; j < node.suites.length; j++) {
				walk(node.suites[j], p || node.name, s, t, skip);
			}
		})(root, '', [], []);
		return plan;
	}

	function makeContext(auto) {
		var ctx = {};
		function track(fake) {
			if (typeof fake.restore !== 'function') { auto.push({ fake: fake, restored: true }); return fake; }
			var entry = { fake: fake, restored: false };
			auto.push(entry);
			var originalRestore = fake.restore;
			fake.restore = function () {
				entry.restored = true;
				return originalRestore.apply(fake, arguments);
			};
			return fake;
		}
		ctx.mock = function (obj) { return track(sinon.mock(obj)); };
		ctx.stub = function (obj, key, val) {
			var s = (key === undefined) ? sinon.stub(obj) : sinon.stub(obj, key, val);
			return track(s);
		};
		ctx.spy = function (obj, key) { return track(sinon.spy(obj, key)); };
		return ctx;
	}

	function run(plan, filter, onDone) {
		var stats = { total: 0, passed: 0, failed: 0, skipped: 0, filtered: 0, failures: [] };
		var startedAt = Date.now();
		var idx = 0;

		function next() {
			if (idx >= plan.length) {
				onDone(stats, Date.now() - startedAt);
				return;
			}
			var t = plan[idx++];
			if (filter && t.name.toLowerCase().indexOf(filter) === -1) {
				stats.filtered++;
				next();
				return;
			}
			if (t.skipped) {
				stats.skipped++;
				console.log('SKIP ' + t.name);
				next();
				return;
			}
			stats.total++;

			var auto = [];
			var ctx = makeContext(auto);
			var settled = false;
			var timer = null;
			var isAsync = t.fn.length > 0;

			function settle(ok, error) {
				if (settled) { return; }
				settled = true;
				clearTimeout(timer);

				var i, k;
				// Teardowns run before the auto-restore so legacy teardown code
				// can still use the fakes it was given via this.mock/stub/spy.
				for (k = 0; k < t.teardown.length; k++) {
					try {
						t.teardown[k].call(ctx);
					} catch (e) {
						if (ok && !error) { ok = false; error = e; }
					}
				}

				var restoreError = null;
				for (i = 0; i < auto.length; i++) {
					if (auto[i].restored) { continue; }
					try {
						auto[i].fake.restore();
					} catch (e) {
						if (!restoreError) { restoreError = e; }
					}
				}
				if (!ok) {
					stats.failed++;
					stats.failures.push({ name: t.name, error: errText(error) });
					console.error('FAIL ' + t.name);
				} else if (restoreError) {
					stats.failed++;
					stats.failures.push({ name: t.name, error: 'mock expectation not met: ' + errText(restoreError) });
					console.error('FAIL ' + t.name + ' (mock expectation not met)');
				} else {
					stats.passed++;
					console.log('PASS ' + t.name);
				}
				next();
			}

			if (isAsync) {
				timer = setTimeout(function () {
					var detail = '';
					if (pageErrors.length) {
						detail = '\nrecent page error(s):\n' + pageErrors.slice(-5).join('\n');
					}
					settle(false, new Error('test timed out after ' + TEST_TIMEOUT_MS + 'ms' + detail));
				}, TEST_TIMEOUT_MS);
			}

			function doneFn(err) {
				if (err) { settle(false, err instanceof Error ? err : new Error(String(err))); }
				else { settle(true, null); }
			}

			try {
				for (var i = 0; i < t.setup.length; i++) { t.setup[i].call(ctx); }
			} catch (e) {
				settle(false, e);
				return;
			}

			try {
				// Only hand doneFn to genuinely async tests (t.fn.length > 0). sinon.test
				// treats a trailing function argument as an async `done`, deferring its
				// sandbox.restore() to a sinonDone wrapper that sync bodies never call —
				// leaking its fake timers + fake XHR into every later test. Passing doneFn
				// to sync tests made sinon.test skip verifyAndRestore(), so the first
				// sinon.test test poisoned the whole rest of the run.
				if (isAsync) { t.fn.call(ctx, doneFn); } else { t.fn.call(ctx); }
			} catch (e) {
				settle(false, e);
				return;
			}

			if (!isAsync && !settled) { settle(true, null); }
		}

		next();
	}

	function start() {
		if (typeof global.chai === 'undefined' || !global.chai.assert) {
			global.__wdi_test_results = { error: 'chai failed to load (check unittest/vendor/chai-3.5.0.min.js)' };
			console.error('WDI RUNNER: chai is missing');
			return;
		}
		global.assert = global.chai.assert;
		if (typeof global.sinon === 'undefined') {
			global.__wdi_test_results = { error: 'sinon failed to load (check unittest/vendor/sinon-1.17.7.js)' };
			console.error('WDI RUNNER: sinon is missing');
			return;
		}

		// The real app's Application constructor calls wdi.GlobalPool.init(); unit
		// tests build no Application, so initialize the pool once here (guard:
		// init() is not idempotent).
		if (global.wdi && global.wdi.GlobalPool && global.wdi.GlobalPool.retained === null) {
			global.wdi.GlobalPool.init();
		}

		var params = new URLSearchParams(global.location.search);
		var plan = buildPlan();

		if (params.get('list') === '1') {
			var names = plan.map(function (t) { return t.name; });
			global.__wdi_test_results = { list: names };
			names.forEach(function (n) { console.log('LIST ' + n); });
			return;
		}

		var filter = params.get('filter') ? params.get('filter').toLowerCase() : null;

		run(plan, filter, function (stats, durationMs) {
			global.__wdi_test_results = {
				total: stats.total,
				passed: stats.passed,
				failed: stats.failed,
				skipped: stats.skipped,
				filtered: stats.filtered,
				durationMs: durationMs,
				failures: stats.failures,
				harnessErrors: pageErrors.slice()
			};
			console.log('');
			console.log('===== WDI TEST RUNNER =====');
			console.log('tests: ' + stats.total + '  passed: ' + stats.passed + '  failed: ' + stats.failed +
				'  skipped: ' + stats.skipped + (filter ? '  filtered out: ' + stats.filtered : '') +
				'  time: ' + durationMs + 'ms');
			if (stats.failures.length) {
				console.log('');
				stats.failures.forEach(function (f) {
					console.error('  FAIL ' + f.name);
					String(f.error).split('\n').forEach(function (line) { console.error('       ' + line); });
				});
			}
			console.log('===========================');
			console.log('');
		});
	}

	global.wdiTestRun = start;
})(typeof window !== 'undefined' ? window : this);
