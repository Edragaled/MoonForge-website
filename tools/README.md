# Build notes

Developer notes for this repository. The site itself needs no build step; this is
about the wiki generator in `tools/`.

The wiki is not hand-written: items, monsters, loot chances, recipes, item sets,
buildings, the Adventure chapters, the dungeon and the raid are read out of the Unity project's
ScriptableObjects and entity prefabs on every run. Run all commands from the
repository root, not from `tools/`.

```
PixelChronicles website/       ← this repo IS the website; push it and it deploys
  index.html                     landing page
  terms.html                       privacy-policy.html             > legal, wording preserved verbatim
  contact.html                   /
  404.html
  style.css                      shared theme for the pages above
  CNAME                          www.moonforge-games.com — do not edit
  ads.txt                        AdMob publisher verification — do not edit
  app-ads.txt                    AdMob publisher verification — do not edit
  .nojekyll                      stops GitHub from running Jekyll over the files
  assets/                        logo, hero art, studio mark (generated)
  wiki/                          the wiki app
    index.html, styles.css, app.js
    data/*.json                  generated
    icons/**/*.png               generated (copied from the project sprites)
  tools/                         the generator — not part of the site
    extract.mjs                  reads the Unity project, writes wiki/ + assets/
    bundle.mjs                   single-file previews
    package.mjs                  zips the site for upload
    lib/unity-yaml.mjs           minimal reader for Unity YAML
    lib/quantum-guid.mjs         resolves Photon Quantum AssetGuid references
    lib/sprite.mjs               sprite refs, incl. sprite-sheet sub-rects
    lib/enums.mjs                mirrors of the C# enums and the rarity palette
```

The marketing pages and the wiki share one palette and type scale, so the site
reads as a single thing even though `/wiki/` is a separate app.

`CNAME`, `ads.txt` and `app-ads.txt` are carried over byte-identical. The two
ads files are how AdMob verifies the publisher account — changing or losing them
breaks ad serving, so they must sit at the domain root.

## Where the Unity project has to be

This repo lives **outside** the game project and only ever reads from it, so it
has to locate it. In order of precedence:

1. `--project <path>` on the command line
2. the `PIXEL_CHRONICLES` environment variable
3. `../PixelChronicles` — a sibling folder, which needs no configuration
4. `..` — in case you ever check this out inside the project

If none of those hold a `Assets/Resources_moved/ScriptableObjects` folder, the
generator says so and lists what it tried instead of failing obscurely.

## Regenerate

Requires Node 18+ (tested on 24). No dependencies, no install step.

```bash
node tools/extract.mjs
```

It reads `Assets/Resources_moved/ScriptableObjects/**`, the monster prefabs under
`Assets/QuantumUser/Simulation/Entities/Monsters/**`, and English strings from
`Assets/Resources/I2Languages.asset`. It writes `wiki/data`, `wiki/icons` and
`assets/`, and **never** modifies the Unity project. A run takes about
10 seconds, most of it the project-wide scan that decides which items are actually
used.

It only writes generated folders, so the hand-written pages (`index.html`,
`terms.html`, `style.css`, …) are never touched.

Re-run it after any balance change and republish — the site has no other source
of truth.

## Preview locally

Served over HTTP — this is the real thing, wiki included:

```bash
npx --yes serve .
```

The landing page and legal pages also open fine straight from the filesystem. The
wiki does not: it fetches its JSON, and browsers block `fetch` on `file://`. For
that, build the self-contained previews:

```bash
node tools/bundle.mjs
```

- `preview.html` — the whole wiki in one file (~0.6 MB), CSS, JS, JSON and all
  315 icons inlined.
- `preview-home.html` — the landing page in one file (~530 KB). Links to the other
  pages stay relative and will not resolve; it is a visual preview only.

Both are throwaway artefacts, not the deployment. Rebuild them after every
`extract.mjs` run, since they embed a snapshot.

## Publish to GitHub Pages

**This folder is the repository.** Push it to `edragaled.github.io` and the site is
live — nothing to copy into place, no build step, no server config. The pages are
plain static files with relative paths, and the wiki routes on the URL hash.

First time only — adopt the existing repository's history instead of overwriting
it. The `reset --soft` is what makes this safe: it points HEAD at the published
commit while leaving every file here untouched, so the next commit is an ordinary
change on top rather than a rewrite. No `--force`, nothing lost.

```bash
git init -b main
git remote add origin https://github.com/edragaled/edragaled.github.io.git
git fetch origin main
git reset --soft origin/main
git add -A
git commit -m "Rebuild site: landing page, shared theme, Pixel Chronicles wiki"
git push origin main
```

Afterwards it is the usual loop:

```bash
node tools/extract.mjs
git add -A && git commit -m "Update wiki data" && git push
```

That gives `https://www.moonforge-games.com/` for the landing page and
`https://www.moonforge-games.com/wiki/` for the wiki.

`CNAME`, `ads.txt` and `app-ads.txt` have to sit at the repository root, which is
why the site is not tucked into a subfolder. `.nojekyll` stops GitHub running
Jekyll over the files — without it, Jekyll silently ignores anything it considers
special.

`tools/` ends up served as static files too. That is harmless — they are inert
`.mjs` text files, and no credentials pass through them — but if you would rather
they were not public, move the folder out and run it from there.

For an upload instead of a push, build a zip of just the published files
(`tools/`, the README and the previews are skipped):

```bash
node tools/package.mjs
```

That writes `moonforge-site.zip` (~625 KB, 339 files). It is written by hand
instead of with PowerShell's `Compress-Archive`, which stores Windows backslashes
in the entry names. The ZIP format mandates forward slashes, and such an archive
unpacks into a single flat directory of files literally named
`icons\items\coal.png` on macOS, Linux and in GitHub's uploader — every asset then
404s.

> If you ever get 404s on icons after a rename, check the case of the filenames.
> Windows is case-insensitive but GitHub Pages is not — the generator clears
> `wiki/icons/` before each run precisely to keep the two in sync.

## What is included

Scope is deliberately narrow for now. Left out, each easy to switch back on:

| Excluded | Where |
|---|---|
| Accessories (15 items) | `EXCLUDED_ITEM_CATEGORIES` in `extract.mjs` — they are procedurally rolled and deserve their own tab |
| Raid/dungeon bosses (Noxyros, Copper Goliath) | `isRaidExclusiveBoss()` |
| Shiny monster variants | not extracted, to keep them a surprise |
| `Recipes/Unused/**` | skipped in `extractRecipes()` — test recipes |
| `TestEventSummonConfig` | `EXCLUDED_SUMMON_CONFIGS` — development scaffolding |
| `LootTables/Tutorial/**` | `EXCLUDED_LOOT_KINDS` — scripted one-offs, not farmable |
| Items nothing references (21 more) | `findUnreferencedItems()` — see below |
| Event summon banners | skipped in `extractSummons()` — limited-time, so not static data |
| Non-purchasable buildings | `extractBuildings()` — ruins repaired in place, not bought |
| Bastion, PvP and Arena modes | exist in the project but are not extracted yet |
| Unreleased dungeons | a location with no waves anywhere excludes itself — see below |

## What the data means

- **Monster stats** are the level‑1 values on the entity prefab, before the
  per-level and per-difficulty multipliers a stage applies. Values a variant does
  not override are inherited from `Monster base.prefab`, and the generator follows
  that chain.
- **Drop chances** are listed per difficulty (Normal / Hard / Master) exactly as
  stored on the loot entry. The **Amount** column is the RNGNeeds weighted
  distribution, e.g. `1 (80%), 2 (20%)`.
- **Only items the project actually uses are published.** An item is kept when
  something points at it — a recipe, a loot table, a building cost, a shop product,
  a quest, a tutorial step. Two kinds of reference have to be followed: most systems
  store an asset guid, but shop products are serialized as a JSON blob naming items
  by `_friendlyId`, so a guid-only scan would wrongly condemn everything on sale.
  Twenty-one items survive nowhere and are dropped (Ninja Katana, Demon Sword,
  Long Dao, the Crusader and Savage armour sets, boss materials like Cyclops Eye
  and Werewolf Fur, …); the full list is `unreferencedItems` in `meta.json`.
  Two exclusions matter for correctness: `UnityDB.prefab` is the Quantum asset
  registry and lists *every* asset, so counting it makes everything look used; and
  content the wiki already treats as dead (`Recipes/Unused/`, tutorial loot tables,
  `PlayerBot.prefab`'s loadout) must not vouch for an item either. Both are in
  `NOT_EVIDENCE`.
- **Item type tags are additive and behaviour-based.** `Material` is not "sits in
  the Materials folder": it is anything a monster drops or that a Material recipe
  produces, on top of the folder. There is no `Premium` tag — that described where
  an asset lives, not what the item is; item bags, shards, candies and totems
  therefore carry no type tag and are reachable only under **All**.
- **Only released content appears under Game modes.** A location is published when at least one
  of its levels has waves. Ancient Tree, Witch's Castle, Cursed Pyramid and Frosted Prison have
  `DungeonData` assets but no waves anywhere, so they exclude themselves — fill the waves in and they
  show up with no code change. Antique Ruins (9 tiers) and Shadow's Citadel (Normal/Hard) are the two
  that qualify today.
- **Dungeons roll an accessory rather than dropping an item.** `AccessoryDrop` holds two independent
  weighted pools, one for the tier and one for the rarity, and both are published per tier.
- **Raid loot comes from named pools.** `ItemDrop.Pools` is a list of pools, each a weighted list of
  items that each carry their own amount distribution. Shadow's Citadel has a main pool and a rare pool.
- **A wave can show a monster that has no wiki page.** The two hidden raid/dungeon bosses still appear
  in their own waves, with their name and icon but no link, because the encounter is real even though
  the monster is not listed.
- **Wave roles (Basic / Elite / Boss) are read but never published.** The same
  monster is Basic in one stage and Elite in another — the label describes the
  encounter, not the monster. Their only use is spotting raid bosses: a monster is
  hidden when *every* appearance is a Boss role *and* none is in a story chapter,
  which separates the raid/dungeon bosses from the chapter bosses players farm.
  Inside a wave the type *is* published, precisely because there it belongs to the
  encounter.
- **Buildings are the purchasable ones only**, using the game's own test from
  `BuildingBuyCostTitleDataProvider`: `!StartsAtLevelZero && BuyBuildingCost != null`.
  That leaves out Workshop, Shop, Portal and Monster Altar, which start as ruins on
  the island and are repaired rather than bought. `BuildingCosts` is indexed by
  level − 1, so entry 0 is the purchase and the rest are upgrades.
- **Adventure levels: document order in the asset is not stable.** Normal levels
  serialize `CombatLevelData` first, Hard levels serialize the `CombatLevelConfig`
  first, so both documents are located by content (`LevelConfigRef` for the data,
  the referenced asset guid for the config). Reading `docs[0]` silently reported
  every Hard level as 0 energy / 0 XP / 0 coins.
- **Appearing in no wave does not mean unavailable.** Six monsters (Tyrios, Anubis,
  Werewolf, Tetranos, Lunadrya, Ophidia) are obtained purely by summoning, so wave
  data alone would misrepresent them. Availability comes from the summon configs:
  `SummonConfigData` → `SummonPools` → each pool's monster list. 41 of the 42
  monsters are summonable; only Lunar Bear is in no pool, and its `Obtainable` flag
  is false too, so that is consistent.
- **No summon rates are extracted, by design.** Which banners and which rarity pool
  carry a monster is recorded; the odds are not. Rates are retuned with every banner
  (and some events are handled specially), and the client already shows them — a
  copy here would go stale silently. The monster page points players at the in-game
  banner instead. If you ever do want them, they are `m_BaseProbability` on the pool
  entry × the same field on the monster inside the pool.
- **Sixteen monsters have no personal loot table** and drop through their stage's
  reward pool instead, which is why their loot section is empty.
- **Resource biomes** cannot be read off the resource: several biomes share one
  prefab (all ores live in a single `Rocks/` folder) and several prefabs share one
  loot table (every tree variant drops from `Tree_LootTable`). The authority is the
  per-biome, per-difficulty `ResourceGenerator`, so the wiki walks
  generator → EntityPrototype → prefab → loot table. Coal Ore correctly comes out
  as all six biomes.
- **A resource's icon is `WorldResource.ResourceIcon`**, not the scene renderer's
  sprite. For trees, cacti and swamp trunks the renderer points at one cell of an
  animation sheet, so serving that PNG would show every frame at once. Chests
  declare no `ResourceIcon` of their own and inherit it from `Chest.prefab`, so the
  variant chain is followed.
- **Sprite-sheet cells are cropped in the browser, not re-encoded.** When a sprite
  reference is not `fileID: 21300000` it is one cell of a sheet; the sub-rect comes
  from the texture's `.meta` (keyed by `internalID`, with y flipped from Unity's
  bottom-left origin to CSS's top-left) and ships as `{ src, crop }`. The site sizes
  a clipping box to the cell's aspect ratio and offsets an oversized image inside
  it, all in percentages, so it stays correct at 22 px in a table and 84 px on a
  detail page. Five sources need this today; items and monsters use whole textures.
- **Rarity colours are the game's own**, lifted from `ItemData.View.cs` and
  `SummonPool.cs`. Items and monsters use different scales for the same name: a
  Common item is white, a Common monster is green. Text has to be shifted off those
  hues for contrast, and that mixing is done in **oklab**, not srgb: srgb blending
  pulls Rare's blue and Epic's purple toward the same pale lavender until they are
  indistinguishable. Keep `--rarity-mix-amount` low for the same reason — every
  extra percent buys contrast and spends hue separation.
- **Skill numbering** comes from the skill asset's name (`Tyrios_Skill_3`), not its
  index in the prefab array — Noxyros has `_Skill_5` at index 2. Skill 3 is the
  monster's special.
- **Item keys** are `_friendlyId` (`iron_sword`), not the display name — the five
  rarities of Ring/Necklace/Bracelet all share the localization key `Ring`, so the
  name cannot identify an item.
- **Fixed-point numbers** (attack speed, set bonuses) are Photon Quantum `FP`
  values, decoded as `RawValue / 65536`.

## Resolving Quantum references

A reference like `LootTable.Id.Value: 534217536395022092` is a Quantum
`AssetGuid`; that number appears nowhere near the asset it points at.
ScriptableObjects store their own in an `Identifier` block, so those are read
directly. Prefab EntityPrototypes do not: each prefab has a sibling
`<Name>EntityPrototype.qprototype`, and the AssetGuid is a deterministic hash of
*that* file's Unity guid, reimplemented in `lib/quantum-guid.mjs`.

The hash is verified against every `Identifier` in the project — 1278 of 1279
match. The remaining one has a manual guid override in `QuantumEditorSettings`,
which is why a stored `Identifier` always wins over a computed hash.
`AssetGuid.ReservedBits` lives in `Quantum.Engine.dll`; its value
(`0x4000000000000000`) was recovered by diffing computed against stored guids.

## Known data gaps

`wiki/data/meta.json` carries a `warnings` array from the last run. Currently one:

- `Monsters/Desert/DesertTree_LootTable` is a harvestable resource filed under
  `LootTables/Monsters/`. Being indexed under `WorldObjects/WorldResources` settles
  what it really is, so the wiki lists it as a resource and warns. Moving the asset
  into `LootTables/Resources/` would silence it.

Ones the run no longer reports:

- `RawRuby` used to warn about a missing sprite. The item asset itself is no longer
  in the project, so it simply stopped being extracted — item count went 143 → 142.
- `Unused/MoonlightSwordRecipe` lists an ingredient guid that no longer resolves;
  excluded with the rest of `Recipes/Unused/`.
- `LunarBear`'s passive skill asset has no icon assigned; the skill renders without
  one.

These are inconsistencies in the project, not extraction failures.

## Adding a section

The current scope is items, monsters, loot and crafting, in English. The project
also holds quests (254), combat levels/chapters (123), shop entries, buildings,
talents, summons and status effects, plus eleven languages in `I2Languages.asset` —
all reachable with the same parser, and combat levels are already being scanned for
monster roles and resource generators. To add one:

1. Find the C# type's `m_Script` guid and add it to `SCRIPT` in `extract.mjs`.
2. Write an `extractX()` that walks its folder and maps the fields.
3. Emit a `data/x.json`, load it in `boot()`, and add a route + render function.

## Security note

`Assets/Resources/I2Languages.asset` stores the Google Sheets web-service URL and
sync password in clear text. The generator reads only the term list and the English
column, so neither value can reach the published site. That secret is still in the Unity
project, though — worth rotating.
