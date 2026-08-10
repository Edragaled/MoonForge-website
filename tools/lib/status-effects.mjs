// Status effect descriptions are assembled the way the game assembles them.
//
// A status effect asset holds the tunable numbers; the localized description is a
// sentence with `{[ATTACK]}`-style placeholders; and the mapping between the two
// lives in each effect's `GetEffectValues` override, which also picks the number
// format. So the override is read out of the C# and replayed here.
//
// Formatting mirrors `StatusEffectData.EffectValue.FormatValue` exactly — the
// point of a wiki is that its numbers read the same as the ones in the game.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

/** `FP._0_20 + FP._0_10` -> 0.30, `2` -> 2. Null when it is neither. */
function evalExpr(expr) {
  const text = expr.trim().replace(/[,;]$/, '');
  if (/^-?\d+$/.test(text)) return Number(text);

  let total = 0;
  for (const term of text.split('+')) {
    const fp = /^(-?)FP\._(\d+)(?:_(\d+))?$/.exec(term.trim());
    if (!fp) return null;
    total += Number(`${fp[2]}.${fp[3] ?? '0'}`) * (fp[1] ? -1 : 1);
  }
  return Math.round(total * 1e6) / 1e6;
}

/** `public FP HealAmount = FP._0_05;` -> { HealAmount: 0.05 }. */
function parseFieldDefaults(source) {
  const defaults = new Map();
  for (const [, name, expr] of source.matchAll(/public\s+FP\s+(\w+)\s*(?:=\s*([^;]+))?;/g)) {
    if (expr === undefined) { defaults.set(name, 0); continue; }
    const value = evalExpr(expr);
    if (value !== null) defaults.set(name, value);
  }
  return defaults;
}

/**
 * The `GetEffectValues` body, in source order:
 * `EffectValue.Percent("HEAL", -HealTakenDecrease)` ->
 * `{ param: 'HEAL', type: 'Percent', field: 'HealTakenDecrease', negate: true }`.
 *
 * A `Get…()` call with no arguments is a constant helper, so its body is inlined
 * as a literal instead of being looked up on the asset.
 */
function parseEffectValues(source, onWarn, name) {
  const body = /GetEffectValues\s*\([^)]*\)\s*\{([\s\S]*?)\n\s{8}\}/.exec(source)?.[1];
  if (body === undefined) return [];

  const values = [];
  for (const line of body.split('\n')) {
    if (!line.includes('EffectValue.')) continue;

    // The argument capture is greedy on purpose: `GetReviveHealth()` contains a
    // `)` of its own, and a lazy match would stop inside it.
    const call = /EffectValue\.(Percent|PercentNoPlus|Seconds|Flat)\s*\(\s*"([A-Z_]+)"\s*,\s*(.+)\)\s*\)\s*;/.exec(line);
    if (!call) { onWarn(`${name}: cannot read effect value from \`${line.trim()}\``); continue; }

    const [, type, param, arg] = call;
    const negate = arg.startsWith('-');
    const operand = negate ? arg.slice(1) : arg;

    const helper = /^(\w+)\(\s*\)$/.exec(operand.trim());
    if (helper) {
      const declared = new RegExp(`static\\s+FP\\s+${helper[1]}\\s*\\(\\s*\\)\\s*=>\\s*([^;]+);`).exec(source)?.[1];
      const constant = declared === undefined ? null : evalExpr(declared);
      if (constant === null) { onWarn(`${name}: ${helper[1]}() is not a constant expression — ${param} unresolved`); continue; }
      values.push({ param, type, literal: negate ? -constant : constant });
      continue;
    }

    if (!/^\w+$/.test(operand)) { onWarn(`${name}: ${param} reads \`${operand}\`, which is not a plain field`); continue; }
    values.push({ param, type, field: operand, negate });
  }
  return values;
}

/** How `EffectValue.FormatValue` renders a number, reproduced exactly. */
function formatValue(type, raw) {
  if (type === 'Seconds') {
    const rounded = Math.round(raw * 1000) / 1000;
    return `${rounded}s`;
  }
  if (type === 'Flat') {
    const n = Math.trunc(raw);
    return n > 0 ? `+${n}` : String(n);
  }
  const n = Math.round(raw * 100);
  // PercentNoPlus is always signed positive in the game, even for damage-over-time.
  return type === 'PercentNoPlus' || n > 0 ? `+${n}%` : `${n}%`;
}

/** `{ 'BurnDebuff': { values: [...], defaults: Map } }` for every effect script. */
export function readStatusEffectScripts(files, onWarn = () => {}) {
  const byScript = new Map();
  for (const file of files) {
    const name = basename(file, '.cs');
    const source = readFileSync(file, 'utf8');
    byScript.set(name, {
      values: parseEffectValues(source, onWarn, name),
      defaults: parseFieldDefaults(source),
    });
  }
  return byScript;
}

/**
 * Fill a localized description. `fields` are the asset's own numbers, which win
 * over the C# initializer — the initializer only matters for a field Unity did
 * not serialize.
 *
 * Returns `{ text, parts }`: the whole sentence, and it split on the double space
 * the game's strings use to separate one effect from the next.
 */
export function describeStatusEffect(template, script, fields, onWarn = () => {}, name = '') {
  if (template == null) return null;

  let text = String(template);
  for (const value of script.values) {
    const raw = value.literal !== undefined
      ? value.literal
      : (() => {
        const own = fields.get(value.field);
        if (own === undefined) {
          onWarn(`${name}: field ${value.field} is not in the asset — using the C# default`);
          return script.defaults.get(value.field) ?? null;
        }
        return value.negate ? -own : own;
      })();

    if (raw === null) { onWarn(`${name}: no value for ${value.param}`); continue; }
    text = text.replaceAll(`{[${value.param}]}`, formatValue(value.type, raw));
  }

  const leftover = [...text.matchAll(/\{\[(\w+)\]\}/g)].map((m) => m[1]);
  if (leftover.length) onWarn(`${name}: description still has ${leftover.join(', ')} unfilled`);

  // The strings separate clauses with a double space; a list reads better than a
  // run-on sentence on a wide page.
  const parts = text.split(/ {2,}/).map((s) => s.trim()).filter(Boolean);
  return { text: parts.join(' · '), parts };
}
