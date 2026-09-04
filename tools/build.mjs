#!/usr/bin/env node
// Build the SPICE web client into a single file.
// Extracts <script src="..."> tags from index.html in document order,
// concatenates them, and optionally minifies with esbuild.
// This preserves the global scope (wdi.*, $, jQuery, etc.) that the
// codebase relies on — unlike esbuild's IIFE bundling which would scope them.
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const OUTPUT = path.join(DIST, 'spice-client.js');

// Read index.html and extract script tags in document order
const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map(m => m[1]);

if (scripts.length === 0) {
  console.error('No script tags found in index.html');
  process.exit(1);
}

console.log(`Concatenating ${scripts.length} scripts...`);

// Concatenate all files in order, preserving global scope
mkdirSync(DIST, { recursive: true });
// Some project files assign to bare globals (e.g. `Application = $.spcExtend(...)`)
// without a `var` declaration. When concatenated with a library that carries a
// top-level "use strict" (e.g. lib/images/png.js), the whole bundle becomes
// strict-mode and those bare assignments throw a ReferenceError. Declaring the
// globals up front keeps them valid in either mode. `Application` is the one
// project bare-global that lacks a `var`; the others are already declared.
const BARE_GLOBAL_PRELUDE = [
  'Application',
  'inactivityClosed',
  'inactivityCountdown',
  'inactivityCountdownSecs',
  'inactivityCountdownTimer',
  'inactivityTimer',
].filter(Boolean);
let output = '/* SPICE Web Client - built ' + new Date().toISOString() + ' */\n';
if (BARE_GLOBAL_PRELUDE.length) {
  output += '// declare bare globals so strict-mode concatenation is safe\n';
  output += 'var ' + BARE_GLOBAL_PRELUDE.join(', ') + ';\n';
}
let missing = [];
for (const src of scripts) {
  const filePath = path.join(ROOT, src);
  try {
    const content = readFileSync(filePath, 'utf8');
    output += '\n// === ' + src + ' ===\n' + content + '\n';
  } catch (e) {
    missing.push(src);
  }
}
writeFileSync(OUTPUT, output);

if (missing.length > 0) {
  console.warn(`Warning: ${missing.length} file(s) not found:`);
  missing.forEach(f => console.warn(`  - ${f}`));
}

// Minify with esbuild (optional)
let finalSize;
if (process.argv.includes('--minify')) {
  execFileSync('esbuild', [OUTPUT, '--minify', `--outfile=${OUTPUT}`, '--allow-overwrite', '--log-level=error'], { stdio: 'inherit' });
  console.log('Minified with esbuild.');
}

finalSize = (statSync(OUTPUT).size / 1024).toFixed(1);
console.log(`Build complete: dist/spice-client.js (${finalSize} KB)`);
