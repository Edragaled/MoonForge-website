// The wiki's own chrome, which the game's spreadsheet does not contain.
//
// Game text — item names, skill descriptions, biome names — comes from
// I2Languages and is authoritative. But the game has no wiki, so nothing in the
// sheet says "Where it drops" or "Toughest monsters". Those live in tools/ui/,
// one file per language, keyed identically.
//
// `en.json` is the reference: any key it has and another language lacks is
// reported, and that language falls back to English for it rather than showing a
// blank. A key only some other language has is reported too — it is almost always
// a typo.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

const PLACEHOLDER = /\{(\w+)\}/g;
const placeholders = (s) => new Set(String(s).match(PLACEHOLDER) ?? []);

/**
 * `Map<code, Record<key, string>>`, every entry complete. `known` is the set of
 * language codes the game declares; a file for anything else is reported and
 * ignored, and a declared language with no file falls back entirely to English.
 */
export function loadUiStrings(dir, known, onWarn = () => {}) {
  if (!existsSync(dir)) throw new Error(`No UI string directory at ${dir}`);

  const files = new Map();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const code = basename(file, '.json');
    const parsed = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    // `_comment` documents the file for whoever edits it next; it is not a string.
    delete parsed._comment;
    files.set(code, parsed);
  }

  const english = files.get('en');
  if (!english) throw new Error(`No en.json in ${dir} — it is the reference for every other language`);

  const out = new Map();
  for (const code of known) {
    const own = files.get(code);
    if (!own) {
      if (code !== 'en') onWarn(`no tools/ui/${code}.json — the wiki's own text stays English in ${code}`);
      out.set(code, { ...english });
      continue;
    }

    for (const key of Object.keys(own)) {
      if (!(key in english)) onWarn(`tools/ui/${code}.json has "${key}", which en.json does not — likely a typo`);
    }

    const merged = { ...english };
    for (const [key, value] of Object.entries(english)) {
      const translated = own[key];
      if (translated === undefined || translated === '') { onWarn(`tools/ui/${code}.json is missing "${key}"`); continue; }

      // A dropped or renamed placeholder renders as a literal `{n}` on the page,
      // so it is worth catching here rather than in a screenshot.
      const expected = placeholders(value);
      const actual = placeholders(translated);
      const missing = [...expected].filter((p) => !actual.has(p));
      if (missing.length) onWarn(`tools/ui/${code}.json "${key}" lost ${missing.join(', ')}`);

      merged[key] = translated;
    }
    out.set(code, merged);
  }

  for (const code of files.keys()) {
    if (!known.includes(code)) onWarn(`tools/ui/${code}.json is not a language the game declares — ignored`);
  }

  return out;
}
