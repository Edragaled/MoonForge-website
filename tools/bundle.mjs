#!/usr/bin/env node
// Builds the two throwaway single-file previews:
//
//   node tools/bundle.mjs
//
//   preview.html       the whole wiki — CSS, JS, JSON and every icon inlined
//   preview-home.html  the landing page, images inlined
//
// They exist because the wiki fetches its JSON and browsers block `fetch` on
// `file://`, so the served site cannot simply be double-clicked. Neither file is
// the deployment: the repository root is (see README).

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative, extname, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');   // the repository root is the website
const SITE = join(ROOT, 'wiki');
const OUT = join(ROOT, 'preview.html');

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

const posix = (p) => p.split(sep).join('/');

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const dataUri = (file) => `data:${MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'};base64,${readFileSync(file).toString('base64')}`;

function main() {
  const dataDir = join(SITE, 'data');
  if (!existsSync(dataDir)) {
    console.error('No wiki/data — run `node tools/extract.mjs` first.');
    process.exit(1);
  }

  // Read whatever extract.mjs produced rather than a hardcoded list: a list here
  // silently drifts when a new payload is added, and the page then hangs on
  // "Loading game data…" because one of the names app.js asks for is missing.
  const payloads = {};
  for (const file of readdirSync(dataDir)) {
    if (file.endsWith('.json')) payloads[basename(file, '.json')] = JSON.parse(readFileSync(join(dataDir, file), 'utf8'));
  }
  console.log(`  payloads: ${Object.keys(payloads).sort().join(', ')}`);

  const icons = {};
  for (const file of walk(join(SITE, 'icons'))) {
    icons[posix(relative(SITE, file))] = dataUri(file);
  }

  const html = readFileSync(join(SITE, 'index.html'), 'utf8');
  const css = readFileSync(join(SITE, 'styles.css'), 'utf8');
  const js = readFileSync(join(SITE, 'app.js'), 'utf8');

  // `</script>` inside JSON would close the tag early.
  const embed = (value) => JSON.stringify(value).replace(/<\//g, '<\\/');

  // The tags carry a `?v=<hash>` cache buster stamped by extract.mjs, so match
  // them loosely rather than by exact string.
  const bundled = html
    .replace(/<link rel="stylesheet" href="styles\.css(?:\?[^"]*)?">/, `<style>\n${css}\n</style>`)
    .replace(
      /<script src="app\.js(?:\?[^"]*)?"><\/script>/,
      `<script>window.__WIKI_DATA__=${embed(payloads)};window.__WIKI_ICONS__=${embed(icons)};</script>\n<script>\n${js}\n</script>`,
    );

  if (/href="styles\.css/.test(bundled) || /src="app\.js/.test(bundled)) {
    console.error('index.html no longer matches the tags bundle.mjs replaces — update this script.');
    process.exit(1);
  }

  writeFileSync(OUT, bundled);
  console.log(`Wrote ${posix(relative(ROOT, OUT))} — ${(statSync(OUT).size / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  ${Object.keys(icons).length} icons inlined`);

  bundleLandingPage();
}

/**
 * The landing page as one self-contained file, for looking at it without a
 * server. Links to the other pages stay as they are and will not resolve — this
 * is a visual preview, not a working copy of the site.
 */
function bundleLandingPage() {
  const root = ROOT;
  const out = join(ROOT, 'preview-home.html');
  const page = join(root, 'index.html');
  if (!existsSync(page)) return;

  let html = readFileSync(page, 'utf8');

  html = html.replace(/<link rel="stylesheet" href="([^"]+)">/g, (whole, href) => {
    const file = join(root, href);
    return existsSync(file) ? `<style>\n${readFileSync(file, 'utf8')}\n</style>` : whole;
  });

  // Every local image and the favicon become data URIs.
  html = html.replace(/(<(?:img|link)\b[^>]*?(?:src|href)=")([^"]+)(")/g, (whole, before, url, after) => {
    if (/^(https?:|data:|mailto:|#|\/$)/.test(url)) return whole;
    const file = join(root, url);
    return existsSync(file) && /\.(png|jpe?g|gif|webp)$/i.test(url)
      ? `${before}${dataUri(file)}${after}`
      : whole;
  });

  writeFileSync(out, html);
  console.log(`Wrote ${posix(relative(ROOT, out))} — ${(statSync(out).size / 1024).toFixed(0)} KB`);
}

main();
