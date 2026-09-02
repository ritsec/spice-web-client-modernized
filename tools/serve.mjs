#!/usr/bin/env node
// Serves the repository root for manual development:
//   node tools/serve.mjs [port]     (default 8080, PORT env wins)
// Then open http://127.0.0.1:<port>/index.html        (the client)
//              http://127.0.0.1:<port>/unittest/index.html  (tests, in-browser report)
import { createStaticServer } from './http-server.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.PORT || process.argv[2] || 8080);

const server = createStaticServer(root);
server.listen(port, '127.0.0.1', () => {
	console.log(`Serving ${root}`);
	console.log(`  client:  http://127.0.0.1:${port}/index.html`);
	console.log(`  tests:   http://127.0.0.1:${port}/unittest/index.html`);
});
