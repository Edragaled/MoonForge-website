// Bastion's roguelike upgrades describe themselves the same way the game's
// upgrade cards do.
//
// Each upgrade asset holds a `Levels[]` array of a struct that is different for
// every upgrade, and the mapping from those fields to localized lines lives in the
// upgrade's `PopulateEffectsAtLevel`. That method is read here and replayed: which
// lines a level shows, which field fills which `{[PLACEHOLDER]}`, and in which of
// the three formats.
//
// Formatting mirrors `UpgradeValue.FormatValue` exactly, including the detail that
// `Seconds` *truncates* (`value.AsInt`) where percentages round.
//
// Anything that does not parse cleanly is reported instead of guessed.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

/* ------------------------------------------------------------------ parsing */

const VALUE_CALL = /\["([A-Z_]+)"\]\s*=\s*UpgradeValue\.(Percent|Seconds|Flat)\(([^)]*)\)(\s*\.WithNoPlusSign\(\))?/g;

/** `FP._0_50` -> 0.5, `FP._1 + FP._0_05` -> 1.05, `5` -> 5. Null otherwise. */
function evalFp(expr) {
  const text = String(expr).trim().replace(/[,;]$/, '');
  if (/^-?\d+$/.test(text)) return Number(text);

  let total = 0;
  for (const term of text.split('+')) {
    const m = /^(-?)FP\._(\d+)(?:_(\d+))?$/.exec(term.trim());
    if (!m) return null;
    total += Number(`${m[2]}.${m[3] ?? '0'}`) * (m[1] ? -1 : 1);
  }
  return Math.round(total * 1e6) / 1e6;
}

/**
 * `if (level.Defense != 0)` -> `{ kind: 'compare', path: 'level.Defense', op: '!=' }`
 * `if (level.X.Data.IsValid)` -> `{ kind: 'valid', path: 'level.X.Data' }`
 * `if (level.X.Y.Length > 0)` / `.Any()` -> `{ kind: 'nonEmpty', path: 'level.X.Y' }`
 * `if (level.Flag)` -> `{ kind: 'truthy', path: 'level.Flag' }`
 */
function parseGuard(text) {
  const condition = text.trim();

  let m = /^([\w.]+)\s*(!=|>|>=)\s*0$/.exec(condition);
  if (m) return { kind: 'compare', path: m[1], op: m[2] };

  m = /^([\w.]+)\.IsValid$/.exec(condition);
  if (m) return { kind: 'valid', path: m[1] };

  m = /^([\w.]+)\.Length\s*>\s*0$/.exec(condition);
  if (m) return { kind: 'nonEmpty', path: m[1] };

  m = /^([\w.]+)\.Any\(\)$/.exec(condition);
  if (m) return { kind: 'nonEmpty', path: m[1] };

  m = /^([\w.]+)$/.exec(condition);
  if (m) return { kind: 'truthy', path: m[1] };

  return null;
}

/** `LabelKey = "Immunity" + x.NameKey` and friends. */
function parseLabel(text) {
  const expr = text.trim().replace(/,$/, '');

  let m = /^"([^"]*)"$/.exec(expr);
  if (m) return { kind: 'literal', key: m[1] };

  // `"Immunity" + statusEffectData.NameKey` — a prefix plus the status effect's own key.
  m = /^"([^"]*)"\s*\+\s*(\w+)\.NameKey$/.exec(expr);
  if (m) return { kind: 'statusName', prefix: m[1], from: m[2] };

  // `f.FindAsset(effect.Data).NameKey` — same thing with no prefix, through an asset ref.
  m = /^f\.FindAsset\((\w+)\.Data\)\.NameKey$/.exec(expr);
  if (m) return { kind: 'statusName', prefix: '', from: m[1], through: 'Data' };

  return null;
}

/** Statement-level parse of one `PopulateEffectsAtLevel` body. */
function parseEffects(body, source, onWarn, name) {
  // `var debuff = level.HitData.EnemyStatusEffects.First();` — an alias for a path,
  // used so the same value is not written three times in the Values map.
  const aliases = new Map();
  for (const [, alias, path] of body.matchAll(/var\s+(\w+)\s*=\s*(level\.[\w.]+(?:\(\))?)\s*;/g)) {
    // `.First()` picks the first entry of a list; `resolve` does that for arrays
    // anyway, so the call is simply dropped.
    aliases.set(alias, path.replace(/\.First\(\)$/, ''));
  }

  // A few upgrades read a class constant rather than a level field.
  const constants = new Map();
  for (const [, field, expr] of source.matchAll(/private\s+(?:readonly\s+)?FP\s+(\w+)\s*=\s*([^;]+);/g)) {
    const value = evalFp(expr);
    if (value !== null) constants.set(field, value);
    else onWarn(`${name}: cannot evaluate the constant ${field}`);
  }

  const effects = [];

  // Each `effects.Add(new UpgradeEffect { … })` preceded by its enclosing
  // `if (…)` or `foreach (…)`. Splitting on the Add keeps the two in one chunk.
  const chunks = body.split('effects.Add(');
  for (let i = 1; i < chunks.length; i += 1) {
    const before = chunks[i - 1];
    const block = chunks[i];

    const label = parseLabel(/LabelKey\s*=\s*([^,\n}]+)/.exec(block)?.[1] ?? '');
    if (!label) { onWarn(`${name}: cannot read a LabelKey — that effect line is not published`); continue; }

    // The nearest preceding `if` / `foreach` is this effect's condition. One level
    // of nesting is allowed, because a condition can itself be a call: `.Any()`.
    const guardText = [...before.matchAll(/\bif\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)].pop()?.[1];
    const loopText = [...before.matchAll(/\bforeach\s*\(\s*var\s+(\w+)\s+in\s+([\w.]+)\s*\)/g)].pop();

    // A `foreach` after the last `if` means the effect repeats per item.
    const loopIsCloser = loopText && before.lastIndexOf('foreach') > before.lastIndexOf('if (');
    const iterate = loopIsCloser ? { alias: loopText[1], path: loopText[2] } : null;
    const guard = iterate ? null : (guardText === undefined ? null : parseGuard(guardText));
    if (!iterate && guardText !== undefined && !guard) {
      onWarn(`${name}: cannot read the condition \`${guardText.trim()}\` — that effect line is not published`);
      continue;
    }

    const values = {};
    for (const [, param, type, arg, noPlus] of block.matchAll(VALUE_CALL)) {
      const path = arg.trim();
      if (!/^[\w.]+$/.test(path)) { onWarn(`${name}: ${param} reads \`${path}\`, which is not a plain field`); continue; }
      values[param] = { type, path, noPlus: Boolean(noPlus) };
    }

    effects.push({ label, guard, iterate, values });
  }

  return { effects, aliases, constants };
}

/** `{ 'BastionUpgradeBulwark': { effects, aliases } }` for every upgrade script. */
export function readUpgradeScripts(files, onWarn = () => {}) {
  const byScript = new Map();
  for (const file of files) {
    const name = basename(file, '.cs');
    const source = readFileSync(file, 'utf8');
    const body = /PopulateEffectsAtLevel\s*\([^)]*\)\s*\{([\s\S]*?)\n\s{8}\}/.exec(source)?.[1];
    if (body === undefined) { onWarn(`${name}: no PopulateEffectsAtLevel — skipped`); continue; }
    byScript.set(name, parseEffects(body, source, onWarn, name));
  }
  return byScript;
}

/* --------------------------------------------------------------- evaluation */

const FP_DIVISOR = 65536;

/** Follow `level.A.B` through the parsed YAML of one level. */
function resolve(root, path, aliases, constants) {
  const parts = path.split('.');
  if (parts.length === 1 && constants?.has(parts[0])) return constants.get(parts[0]);
  // An alias stands in for a `level.…` path; splice it back in.
  if (aliases?.has(parts[0])) parts.splice(0, 1, ...aliases.get(parts[0]).split('.'));

  let node = root;
  for (const part of parts) {
    if (part === 'level') continue;
    if (node == null) return undefined;
    // An alias may stand for a list that the source read through `.First()`; step
    // into the first entry *before* taking the field, not instead of it.
    if (Array.isArray(node)) node = node[0];
    node = node?.[part];
  }
  return node;
}

/** A serialized FP is `{RawValue: n}`; a plain int is just a number. */
function numberOf(node) {
  if (node == null) return null;
  if (typeof node === 'object') {
    return node.RawValue === undefined ? null : Number(node.RawValue) / FP_DIVISOR;
  }
  const n = Number(node);
  return Number.isFinite(n) ? n : null;
}

/**
 * Whether an asset reference points at anything. Quantum writes `Id.Value: 0` for
 * an empty reference; a wrapper struct like `GhostUnit` holds the reference one
 * level down, so a single nested `Id.Value` counts as the wrapper's own.
 */
function refValue(node) {
  if (node == null || typeof node !== 'object') return 0;
  if (node.Id?.Value !== undefined) return Number(node.Id.Value);
  if (node.Data?.Id?.Value !== undefined) return Number(node.Data.Id.Value);
  for (const child of Object.values(node)) {
    if (child && typeof child === 'object' && child.Id?.Value !== undefined) return Number(child.Id.Value);
  }
  // A Unity asset reference, which is a guid rather than a Quantum id.
  return node.guid ? 1 : 0;
}

/** Reproduces `UpgradeValue.FormatValue`. */
function format(type, raw, noPlus) {
  let text;
  if (type === 'Percent') {
    const n = Math.round(raw * 100);
    text = n > 0 ? `+${n}%` : `${n}%`;
  } else if (type === 'Seconds') {
    // `FP.AsInt` truncates toward zero; it does not round.
    text = `${Math.trunc(raw)}s`;
  } else {
    text = `+${Math.trunc(raw)}`;
  }
  return noPlus ? text.replaceAll('+', '') : text;
}

function guardHolds(guard, level, aliases, constants) {
  const node = resolve(level, guard.path, aliases, constants);
  if (guard.kind === 'valid') return refValue(node) !== 0;
  if (guard.kind === 'nonEmpty') return Array.isArray(node) && node.length > 0;

  const value = numberOf(node);
  if (guard.kind === 'truthy') return Boolean(value);
  if (value == null) return false;
  return guard.op === '!=' ? value !== 0 : guard.op === '>=' ? value >= 0 : value > 0;
}

/**
 * The lines one level of one upgrade shows: `[{ labelKey, values: { VALUE: '+20%' } }]`.
 *
 * `statusNameOf(node)` resolves a status-effect reference to its `NameKey`, which
 * two upgrades use as part of the label — the caller owns that lookup because it
 * needs the project's guid indexes.
 */
export function effectsForLevel(script, level, statusNameOf, onWarn = () => {}, name = '') {
  const { effects, aliases, constants } = script;
  const lines = [];

  /**
   * `item` is set only inside a `foreach`: a value path starting with the loop
   * variable is then read from the item rather than from the level.
   */
  const emit = (effect, item, itemAlias) => {
    let label = effect.label.key;
    if (effect.label.kind === 'statusName') {
      const source = effect.label.from === itemAlias ? item : resolve(level, effect.label.from, aliases, constants);
      const status = statusNameOf(source);
      if (!status) { onWarn(`${name}: cannot resolve the status effect behind a "${effect.label.prefix}…" label`); return; }
      label = `${effect.label.prefix}${status}`;
    }

    const values = {};
    for (const [param, spec] of Object.entries(effect.values)) {
      const parts = spec.path.split('.');
      const node = parts[0] === itemAlias
        ? parts.slice(1).reduce((acc, key) => (acc == null ? acc : acc[key]), item)
        : resolve(level, spec.path, aliases, constants);

      const raw = numberOf(node);
      if (raw == null) { onWarn(`${name}: ${label}.${param} has no value in the asset`); continue; }
      values[param] = format(spec.type, raw, spec.noPlus);
    }
    lines.push({ labelKey: label, values });
  };

  for (const effect of effects) {
    if (effect.iterate) {
      const list = resolve(level, effect.iterate.path, aliases, constants);
      if (!Array.isArray(list)) continue;
      for (const item of list) emit(effect, item, effect.iterate.alias);
      continue;
    }

    if (effect.guard && !guardHolds(effect.guard, level, aliases, constants)) continue;
    emit(effect, null, null);
  }

  return lines;
}

/** Fill `{[VALUE]}` placeholders in a localized upgrade line. */
export function fillUpgradeLine(template, values, onWarn = () => {}, context = '') {
  if (template == null) return null;
  let out = String(template).replace(/\{\[(\w+)\]\}/g, (whole, param) => values[param] ?? whole);
  const missing = [...out.matchAll(/\{\[(\w+)\]\}/g)].map((m) => m[1]);
  if (missing.length) onWarn(`${context}: ${missing.join(', ')} left unfilled`);
  out = out.replace(/\s+/g, ' ').trim();
  return out;
}

export const PLAYER_UPGRADE_RARITIES = ['Common', 'Rare', 'Epic', 'Legendary'];
export const PLAYER_UPGRADE_CATEGORIES = ['Offensive', 'Defensive', 'Utility', 'Specialist'];
