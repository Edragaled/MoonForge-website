// Every language in I2Languages, not just English.
//
// The wiki is generated once per language, so each language needs a complete term
// map. A language column is ~99.6% filled, and the holes are not the same in every
// column, so each map starts as a copy of English and is then overwritten with the
// values that language actually has. That way a missing translation degrades to
// English instead of to an empty string, and no caller has to think about it.

import { readUnityYaml } from './unity-yaml.mjs';

/**
 * `{ languages: [{ code, name }], maps: Map<code, Map<term, string>> }`.
 *
 * The surrounding `mSource` config also holds the Google Sheets service URL and
 * password; nothing here reads them.
 */
export function loadLanguages(assetPath, onWarn = () => {}) {
  const src = readUnityYaml(assetPath)[0].body.mSource;
  const declared = src.mLanguages ?? [];
  if (!declared.length) throw new Error('No languages in I2Languages');

  const enIndex = declared.findIndex((l) => l.Code === 'en');
  if (enIndex === -1) throw new Error('No English language in I2Languages');

  const terms = src.mTerms ?? [];
  const value = (term, index) => {
    const v = term.Languages?.[index];
    return typeof v === 'string' && v !== '' ? v : null;
  };

  const english = new Map();
  for (const term of terms) {
    const v = value(term, enIndex);
    if (v !== null) english.set(term.Term, v);
  }

  const languages = [];
  const maps = new Map();
  declared.forEach((language, index) => {
    const code = String(language.Code ?? '').trim();
    if (!code) { onWarn(`language #${index} has no code — skipped`); return; }

    const map = new Map(english);
    let own = 0;
    for (const term of terms) {
      const v = value(term, index);
      if (v !== null) { map.set(term.Term, v); own += 1; }
    }

    languages.push({ code, name: String(language.Name ?? code) });
    maps.set(code, map);
    if (code !== 'en' && own < english.size * 0.9) {
      onWarn(`language ${code} has only ${own} of ${english.size} terms — the rest falls back to English`);
    }
  });

  return { languages, maps };
}
