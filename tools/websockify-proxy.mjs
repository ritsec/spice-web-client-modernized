#!/usr/bin/env node
// Local reverse proxy for developing/testing the SPICE client against the RITSEC gateway.
// - Serves the client's static files from the repo root.
// - GET /spice-token: fetches a fresh (single-use) SPICE token via the OpenStack CLI and stores it.
// - Proxies WebSocket connections at /websockify to the real gateway, injecting auth cookies.
//   The stored token (from /spice-token) is reused for transport auth so it matches the client's
//   SPICE ticket (spice_password). If none is stored, a fresh one is fetched.
// Secrets are read from the environment, never hardcoded.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';

const require = createRequire(import.meta.url);
let wsModule;
try { wsModule = require('ws'); } catch (e) { wsModule = require('/usr/share/nodejs/ws'); }
const { WebSocket, WebSocketServer } = wsModule;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = parseInt(process.env.PORT || '8081', 10);
const VM_ID = process.env.VM_ID || 'c99d75a2-0b76-4d98-b0f3-ad0dbb66593a';
const UPSTREAM_HOST = process.env.UPSTREAM_HOST || 'stack.ritsec.cloud';
const UPSTREAM_PORT = parseInt(process.env.UPSTREAM_PORT || '6082', 10);
const SESSIONID = process.env.SESSIONID || '';
const CSRF = process.env.CSRFTOKEN || '';
const RECENT = process.env.RECENT_PROJECT || '';

let storedToken = null;

function getFreshToken() {
  const cmd = `. "${process.env.HOME}/.openstack-ritsec.env" 2>/dev/null; openstack console url show --spice ${VM_ID} -f value -c url 2>/dev/null`;
  return new Promise((resolve, reject) => {
    execFile('/bin/bash', ['-c', cmd], { timeout: 45000 }, (err, stdout) => {
      if (err) return reject(err);
      const m = String(stdout).match(/token=([a-f0-9-]+)/);
      if (!m) return reject(new Error('no token in output: ' + String(stdout).slice(0, 200)));
      resolve(m[1]);
    });
  });
}

function resolveToken() {
  if (process.env.TOKEN) return Promise.resolve(process.env.TOKEN);
  if (storedToken) return Promise.resolve(storedToken);
  return getFreshToken();
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
};

function serveStatic(req, res) {
  let urlPath;
  try { urlPath = decodeURIComponent(req.url.split('?')[0]); } catch (e) { urlPath = req.url; }
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found: ' + urlPath); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  if (req.url === '/__health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  if (req.url === '/spice-token') {
    getFreshToken().then((t) => {
      storedToken = t;
      console.log(`[proxy] issued token ${t}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ token: t }));
    }).catch((e) => {
      console.error('[proxy] /spice-token fail:', e.message);
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('token fail: ' + e.message);
    });
    return;
  }
  serveStatic(req, res);
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (!req.url || !req.url.startsWith('/websockify')) { socket.destroy(); return; }
  const t0 = Date.now();
  resolveToken()
    .then((token) => {
      const cookieParts = [`token=${token}`];
      if (SESSIONID) cookieParts.push(`sessionid=${SESSIONID}`);
      if (CSRF) cookieParts.push(`csrftoken=${CSRF}`);
      if (RECENT) cookieParts.push(`recent_project=${RECENT}`);
      const cookie = cookieParts.join('; ');
      wss.handleUpgrade(req, socket, head, (clientWs) => {
        const upstreamUrl = `wss://${UPSTREAM_HOST}:${UPSTREAM_PORT}/websockify`;
        const upstream = new WebSocket(upstreamUrl, { headers: { Cookie: cookie }, protocol: 'binary' });
        const buffered = [];
        let upOpen = false;
        clientWs.on('message', (d) => { if (upOpen && upstream.readyState === 1) upstream.send(d); else buffered.push(d); });
        upstream.on('message', (d) => { if (clientWs.readyState === 1) clientWs.send(d); });
        upstream.on('open', () => {
          upOpen = true;
          const n = buffered.length;
          for (const d of buffered) { try { upstream.send(d); } catch (e) {} }
          buffered.length = 0;
          console.log(`[proxy] upstream OPEN in ${Date.now() - t0}ms, flushed ${n} buffered frame(s)`);
        });
        clientWs.on('close', () => { try { upstream.close(); } catch (e) {} });
        upstream.on('close', (code) => { console.log(`[proxy] upstream CLOSE code=${code}`); try { clientWs.close(); } catch (e) {} });
        clientWs.on('error', (e) => { console.error('[proxy] client err', e.message); try { upstream.close(); } catch (e) {} });
        upstream.on('error', (e) => { console.error('[proxy] upstream err', e.message); try { clientWs.close(); } catch (e) {} });
      });
    })
    .catch((e) => {
      console.error('[proxy] token/connect fail:', e.message);
      socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      socket.destroy();
    });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`websockify proxy on http://127.0.0.1:${PORT} (VM ${VM_ID}, upstream ${UPSTREAM_HOST}:${UPSTREAM_PORT})`);
});
