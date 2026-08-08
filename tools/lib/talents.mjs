// Talent numbers live in C#, not in data.
//
// A talent asset carries only its name key and icon; the per-level values are
// `level switch` expressions inside the talent's script, and the localized text
// has `{[VALUE_1]}` placeholders that the client fills in at runtime. So the
// values are read out of the source, and anything that does not parse cleanly is
// reported rather than guessed — a wrong number in a wiki is worse than none.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

/**
 * `FP._0_10 + FP._0_05` -> 0.15, `20` -> 20.
 * Returns null when the arm is anything other than a sum of FP constants or a
 * plain integer.
 */
function evalArm(expr) {
  const text = expr.trim().replace(/[,;]$/, '');
  if (/^\d+$/.test(text)) return Number(text);

  const terms = text.split('+').map((t) => t.trim());
  let total = 0;
  for (const term of terms) {
    const fp = /^FP\._(\d+)(?:_(\d+))?$/.exec(term);
    if (!fp) return null;
    total += Number(`${fp[1]}.${fp[2] ?? '0'}`);
  }
  // Floating point sums like 0.1 + 0.05 need rounding back to a clean decimal.
  return Math.round(total * 1e6) / 1e6;
}

/** Every `Name(int level) => level switch { 1 => …, … }` in a file, by name. */
function parseGetters(source) {
  const getters = new Map();
  const re = /(?:private|public|internal)?\s*static\s+\w+\s+(\w+)\s*\(\s*int\s+level\s*\)[\s\S]*?level switch\s*\{([\s\S]*?)\}/g;

  for (const [, name, body] of source.matchAll(re)) {
    const arms = new Map();
    for (const [, level, value] of body.matchAll(/(\d+)\s*=>\s*([^,\n]+)/g)) {
      // Some switches carry a defensive `0 =>` arm; talents start at level 1.
      if (Number(level) < 1) continue;
      const parsed = evalArm(value);
      if (parsed !== null) arms.set(Number(level), parsed);
    }
    if (arms.size) getters.set(name, arms);
  }
  return getters;
}

/**
 * `{ValueParam1, FPMath.RoundToInt(GetX(level) * 100).ToString()}` ->
 * `{ param: 'VALUE_1', getter: 'GetX', percent: true }`, in source order.
 */
function parseParamMapping(source) {
  const block = /GetLocalizationParams\s*\(\s*int\s+level\s*\)([\s\S]*?)\n\s{8}\}/.exec(source)?.[1] ?? source;
  const mapping = [];
  for (const [, index, expr] of block.matchAll(/\{\s*ValueParam(\d)\s*,([^}]+)\}/g)) {
    const getter = /\b(Get\w+)\s*\(\s*level\s*\)/.exec(expr)?.[1];
    if (!getter) continue;
    mapping.push({ param: `VALUE_${index}`, getter, percent: /\*\s*100/.test(expr) });
  }
  return mapping;
}

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

/**
 * `{ 'ArcanistTalent': { levels: Map(level -> {VALUE_1: 20}), max } }` for every
 * talent script in `files`. `onWarn` is called with anything unresolved.
 */
export function readTalentValues(files, onWarn = () => {}) {
  const byScript = new Map();

  for (const file of files) {
    const name = basename(file, '.cs');
    const source = readFileSync(file, 'utf8');
    const getters = parseGetters(source);
    const mapping = parseParamMapping(source);

    if (!mapping.length) { onWarn(`${name}: no ValueParam mapping found — levels not published`); continue; }

    const levels = new Map();
    let maxLevel = 0;
    for (const { param, getter, percent } of mapping) {
      const arms = getters.get(getter);
      if (!arms) { onWarn(`${name}: ${getter}(level) is not a plain level switch — ${param} unresolved`); continue; }
      for (const [level, value] of arms) {
        if (!levels.has(level)) levels.set(level, {});
        levels.get(level)[param] = percent ? Math.round(value * 100) : value;
        maxLevel = Math.max(maxLevel, level);
      }
    }

    if (!levels.size) { onWarn(`${name}: no level values resolved`); continue; }
    byScript.set(name, { levels, maxLevel });
  }

  return byScript;
}

/** Fill `{[VALUE_1]}` / `{[ROMAN_LETTER]}` in a localized talent string. */
export function fillTalentText(text, values, level) {
  if (text == null) return null;
  let out = String(text);
  out = out.replace(/\{\[ROMAN_LETTER\]\}/g, ROMAN[level] ?? String(level));
  out = out.replace(/\{\[(VALUE_\d)\]\}/g, (whole, param) => (
    values && values[param] != null ? String(values[param]) : whole
  ));
  return out.replace(/\s+/g, ' ').trim();
}

export const romanNumeral = (n) => ROMAN[n] ?? String(n);
