#!/usr/bin/env node
// Zips the published website — marketing pages and wiki — for anyone who would
// rather upload than push:
//
//   node tools/package.mjs
//
// The repository root *is* the site, so the generator and the docs sit alongside
// the pages. Those are skipped here, because the archive should be only what a
// visitor can reach.
//
// Written by hand rather than with PowerShell's Compress-Archive, which stores
// Windows path separators (`data\items.json`). The ZIP format mandates forward
// slashes, and archives with backslashes unpack into a single flat directory of
// oddly named files on macOS, Linux and inside GitHub's own uploader — the site
// then 404s on every asset.
//
// Only Node's built-in zlib is used: an uncompressed-or-deflated store with a
// hand-rolled central directory, no dependencies.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, crc32 } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = join(HERE, '..');   // the repository root is the website
const OUT = join(SITE, 'moonforge-site.zip');

/** Repo-relative paths that are development files, not part of the website. */
const NOT_PUBLISHED = [
  /^tools[\\/]/,
  /^\.git([\\/]|$)/,
  /^\.gitignore$/,
  /^README\.md$/,
  /^preview.*\.html$/,
  /\.zip$/,
];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** DOS date/time, which is what a ZIP local header carries. */
function dosStamp(date) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f);
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, day };
}

function main() {
  if (!existsSync(join(SITE, 'wiki', 'data'))) {
    console.error('No wiki/data — run `node tools/extract.mjs` first.');
    process.exit(1);
  }

  const files = walk(SITE)
    .filter((file) => {
      const rel = relative(SITE, file);
      return !NOT_PUBLISHED.some((r) => r.test(rel));
    })
    .sort();
  const stamp = dosStamp(new Date());
  const locals = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const name = relative(SITE, file).split(sep).join('/'); // the whole point
    const raw = readFileSync(file);
    const deflated = deflateRawSync(raw, { level: 9 });
    // Storing is honest when compression does not help — PNGs are already deflated.
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);
    const nameBytes = Buffer.from(name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // local file header signature
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0x0800, 6);       // UTF-8 filename flag
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);           // no extra field
    locals.push(local, nameBytes, body);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);   // central directory signature
    entry.writeUInt16LE(20, 4);           // version made by
    entry.writeUInt16LE(20, 6);           // version needed
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(stamp.time, 12);
    entry.writeUInt16LE(stamp.day, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(0, 38);           // external attributes
    entry.writeUInt32LE(offset, 42);      // offset of local header
    central.push(entry, nameBytes);

    offset += local.length + nameBytes.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);       // end of central directory
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  writeFileSync(OUT, Buffer.concat([...locals, centralBuf, end]));
  console.log(`Wrote ${relative(SITE, OUT)} — ${(statSync(OUT).size / 1024).toFixed(0)} KB, ${files.length} files`);
}

main();
