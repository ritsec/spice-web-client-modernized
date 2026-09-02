# Development & testing

The Spice Web Client is plain HTML5/JavaScript with **no build step and no npm
dependencies**. The unit-test suite (`unittest/`) runs in a **Docker-only,
headless-Chromium** environment — you do not need a local Node installation.

Everything below assumes you are at the repository root.

## Prerequisites

- Docker (with a working `docker build`).
- That's it. The test stack ships its own vendored libraries in
  `unittest/vendor/` (jQuery, QUnit-style runner, chai, sinon) — there is no
  `npm install`.

## Build the development image

```sh
docker build -t spice-web-client-dev .
```

The image (`node:24-bookworm-slim` + Chromium + fonts) does **not** contain the
repository. You mount your checkout at runtime, so edits to tests are picked up
immediately without rebuilding.

## Run the tests

```sh
# full suite (prints a per-test PASS/FAIL stream, then a summary + RESULT line)
docker run --rm -v "$PWD":/app spice-web-client-dev

# only tests whose name contains a substring (case-insensitive)
docker run --rm -v "$PWD":/app spice-web-client-dev --filter queue

# list every registered test and exit
docker run --rm -v "$PWD":/app spice-web-client-dev --list

# use a specific browser binary (rarely needed inside the image)
docker run --rm -v "$PWD":/app spice-web-client-dev --browser /usr/bin/chromium

# longer overall deadline (default 300s); also settable via env
docker run --rm -v "$PWD":/app spice-web-client-dev --timeout 600000
TEST_TIMEOUT_MS=600000 docker run --rm -v "$PWD":/app spice-web-client-dev

# drop into a shell in the environment
docker run --rm -it -v "$PWD":/app --entrypoint sh spice-web-client-dev

# run an arbitrary node script against the mounted repo
docker run --rm -v "$PWD":/app --entrypoint node spice-web-client-dev -e 'console.log("hi")'
```

> Note: `--filter` matches **any** part of a test name, including the suite
> prefix. E.g. `--filter Graphic` hits both the `Graphic suite` and the
> `GraphicTest` suites. Use a distinctive substring to isolate a single test.

### Exit codes

|Code|Meaning|
|---|---|
|`0`|all tests passed|
|`1`|one or more tests failed|
|`2`|harness/infrastructure error (no browser, no tests registered, timeout, …)|

## How the harness works

`tools/run-tests.mjs` drives the whole run with zero npm dependencies:

1. Starts a tiny static file server (`tools/http-server.mjs`) on an
   **ephemeral** port bound to `127.0.0.1`.
2. Launches headless Chromium against
   `http://127.0.0.1:<port>/unittest/index.html`, in a fresh temp profile
   (`/tmp/spice-web-client-*`).
3. Talks to Chromium over its DevTools (CDP) WebSocket using Node's built-in
   `WebSocket`.
4. Reports the result that `unittest/runner.js` publishes.

### Result detection — console stream first, CDP second

The primary signal is the runner's **summary line** on the console stream:

```
tests: N  passed: N  failed: N  skipped: N  [filtered out: N]  time: Nms
```

This is matched from the buffered `Runtime.consoleAPICalled` events. It is used
on purpose because, after a finished run, the page can go **unresponsive to
`Runtime.evaluate`**; the console events are still delivered. Reading
`window.__wdi_test_results` over CDP is kept only as a **fallback** (and is the
primary path for `--list` mode). If neither ever appears, the run fails with a
harness timeout (exit 2).

A safety-net timer forces a process exit at `TEST_TIMEOUT_MS + 15s` regardless
of state, so a wedged CDP session cannot hang the driver forever.

### Timeouts

- **Per-test** timeout is fixed in `unittest/runner.js` at **10000 ms**
  (`TEST_TIMEOUT_MS` there). A test that neither calls `done()` nor throws
  within 10 s is marked failed ("test timed out after 10000ms").
- The suite-level `this.timeout(...)` calls inside test files are **not honored**
  by the custom runner — the 10 s per-test limit applies.
- `TEST_TIMEOUT_MS` (env, default 300000 ms) is the **overall** driver deadline,
  distinct from the per-test limit.

## Known hazards (why things are the way they are)

These are the sharp edges hit while building this suite. They are documented so
a future editor does not "simplify" them back into a broken state.

- **`sinon.test` + sync tests leak fake timers/XHR.** `sinon.test` treats a
  trailing function argument as an async `done`, deferring its
  `verifyAndRestore()` (which restores fake timers + the fake XHR server) to a
  wrapper that a sync body never calls. The runner therefore hands `doneFn` to a
  test only when the test genuinely takes a callback
  (`t.fn.length > 0`). See `unittest/runner.js` `run()`.

- **`global` is undefined in Chromium.** Use `globalThis`. In headless Chromium
  there is no bare `global`; the app's global `setTimeout`/`clearTimeout`
  resolve against `globalThis`, so timer stubs/mocks must target `globalThis`,
  never `global`.

- **Socket URIs use the page port, not the config port.** The app's
  `wdi.Utils.generateWebSocketUrl` builds
  `ws(s)://<host>:<document.location.port>/?ver=2&token=<config.port>`. The path
  port is the **harness's ephemeral HTTP port** (changes every run); `config.port`
  only appears as the `token=` query param. Tests asserting these URIs must build
  the expectation from `document.location.port`, not a hardcoded port.

- **`wdi.exceptionHandling` decides throw-vs-log.** When true, the app swallows
  errors through `processExceptionHandled`; when false it throws. A test that
  wants the throwing path must set `wdi.exceptionHandling = false` in setup and
  restore it in teardown.

- **`EventObject.removeEvent` sets the key to `undefined`, it does not delete
  it.** `this.eyeEvents[name] = undefined;` — so assert the value is `undefined`,
  not that the key is absent (`'name' in obj` is still `true`).

- **`new ArrayBuffer([1,2,3,4])` is a zero-byte buffer.** The `ArrayBuffer`
  constructor takes a byte **length**, not an array — `Number([…])` is `NaN` →
  `0`. Code that then runs `new ImageData(u8, w, h)` throws
  `InvalidStateError: The input data has zero elements.` Build the buffer with
  the real byte count (`w*h*4`).

- **A stubbed accessor returning an undefined free variable only throws when
  called.** In `graphictest.test.js`, `getCanvas()` originally returned an
  undeclared `canvasOrigin`; it was latent because only `drawAlphaBlend`
  actually calls `clientGui.getCanvas()`. The fix is to return the real canvas
  element (`ctxOrigin.canvas`). When a test times out rather than fails, suspect
  a swallowed exception in an async callback (e.g. inside a jQuery `done`) that
  prevents `done()` from being called.

- **Shared prototype state in `DisplayPreProcess`.** The legacy `$.spcExtend()`
  copies prototype arrays (consumers/idleConsumers/queued/inProcess) by
  reference, so instances share one pool. `graphictest.test.js` resets this in
  teardown or a previous test's consumer fires inside the wrong window.

## Cleanup / process hygiene

- The driver kills **only** its own Chromium (by process group,
  `process.kill(-pid, 'SIGKILL')`) and removes its own temp profile. It never
  touches unrelated browsers.
- When manually cleaning up between runs, target only the harness artifacts:
  processes matching `/tmp/spice-web-client-*` and containers based on
  `spice-web-client-dev`. Do **not** kill the user's own browser
  crashpad/handlers.

## What you must not do

- **App code is read-only for tests.** `lib/`, `network/`, `application/`,
  `process/` are the product. All fixes in this project are made on the
  **test side** (`unittest/*`) or the **harness** (`tools/*`). If a test fails
  because the app genuinely misbehaves, that is an app bug to report — do not
  edit the app to make the test pass, and do not relax a test's assertions just
  to green it.
