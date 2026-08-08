/* Pixel Chronicles wiki — hash router over the JSON emitted by wiki/tools/extract.mjs.
   No build step, no dependencies: this file is served as-is. */

'use strict';

const DB = { items: [], monsters: [], loot: [], recipes: [], sets: [], buildings: [], gamemodes: [], meta: null };
const IX = {
  item: new Map(), monster: new Map(), loot: new Map(), recipe: new Map(),
  set: new Map(), building: new Map(), mode: new Map(), chapter: new Map(),
};

const view = document.getElementById('view');
const searchInput = document.getElementById('search');
const suggestions = document.getElementById('suggestions');

/* ------------------------------------------------------------------- utils */

const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content; };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const slug = (s) => encodeURIComponent(String(s));
const cls = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
const nf = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));
const round = (n, d = 2) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

/** Game text carries Unity rich-text tags; strip them rather than render them. */
const plain = (s) => String(s ?? '').replace(/<\/?(?:color|link|size|b|i|u|sprite)[^>]*>/gi, '').replace(/\s+/g, ' ').trim();

/**
 * Every icon URL passes through here. Served normally they stay relative paths;
 * the single-file preview built by `wiki/tools/bundle.mjs` populates
 * `window.__WIKI_ICONS__` with inline data URIs instead.
 */
const iconSrc = (path) => window.__WIKI_ICONS__?.[path] ?? path;

/**
 * An icon is either a path, or `{ src, crop }` when the artwork is one cell of a
 * sprite sheet — the trees, cacti and swamp trunks all share an animation sheet,
 * and showing the file would show every frame at once.
 *
 * The crop is done with percentages so it holds at any rendered size: the outer
 * span carries the sprite's aspect ratio and clips, and the image inside is blown
 * up to `sheet / cell` and offset by the cell's position.
 */
function iconImg(icon, alt = '') {
  if (!icon) return '';
  if (typeof icon === 'string') {
    return `<img src="${esc(iconSrc(icon))}" alt="${esc(alt)}" loading="lazy" decoding="async">`;
  }

  const { src, crop: c } = icon;
  const pct = (n) => Math.round(n * 1e4) / 1e4;
  return `<span class="sprite" style="aspect-ratio:${c.w}/${c.h}"><img
    src="${esc(iconSrc(src))}" alt="${esc(alt)}" loading="lazy" decoding="async"
    style="width:${pct((c.sheetW / c.w) * 100)}%;height:${pct((c.sheetH / c.h) * 100)}%;left:${pct((-c.x / c.w) * 100)}%;top:${pct((-c.y / c.h) * 100)}%"></span>`;
}

function thumb(icon, alt, sizeClass = '') {
  if (!icon) return `<span class="thumb empty ${sizeClass}" role="img" aria-label="No icon"></span>`;
  return `<span class="thumb ${sizeClass}">${iconImg(icon, alt)}</span>`;
}

/** `scale` picks the game's item or monster palette — a Common item is white,
 *  a Common monster is green. */
const rarityBadge = (r, scale = 'item') => `<span class="badge rarity ${scale === 'monster' ? 'mr' : 'r'}-${cls(r)}">${esc(r)}</span>`;

const elementBadge = (e, icon) => `<span class="badge element e-${cls(e)}">${
  icon ? iconImg(icon) : ''}${esc(e)}</span>`;

const biomeBadges = (biomes) => (
  biomes?.length
    ? `<span class="biome-list">${biomes.map((b) => `<span class="badge">${esc(b)}</span>`).join('')}</span>`
    : '—'
);

function chanceCell(p) {
  if (p == null) return '<span class="chance">—</span>';
  return `<span class="chance"><i><b style="width:${Math.min(100, p)}%"></b></i>${p}%</span>`;
}

const amountsText = (amounts) => (
  !amounts?.length ? '1'
    : amounts.length === 1 ? String(amounts[0].amount)
      : amounts.map((a) => `${a.amount} (${a.chance}%)`).join(', ')
);

const linkItem = (key) => {
  const it = IX.item.get(key);
  return it ? `<a href="#/item/${slug(key)}">${esc(it.name)}</a>` : esc(key ?? '—');
};

/* ------------------------------------------------------------------ filters
   Filter state lives in the hash query so any filtered view is linkable. */

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, query = ''] = raw.split('?');
  return { parts: path.split('/').filter(Boolean).map(decodeURIComponent), params: new URLSearchParams(query) };
}

function setParam(key, value) {
  const { parts, params } = parseHash();
  if (value == null || value === '' || value === 'all') params.delete(key);
  else params.set(key, value);
  const q = params.toString();
  location.hash = `/${parts.map(encodeURIComponent).join('/')}${q ? `?${q}` : ''}`;
}

/** Renders a row of single-select chips bound to a hash parameter. */
function chipGroup(label, key, values, current, labels = {}) {
  const options = ['all', ...values];
  return `<div class="filter-group"><span>${esc(label)}</span>${options.map((v) => `
    <button type="button" class="chip" data-param="${esc(key)}" data-value="${esc(v)}"
            aria-pressed="${String(v === current)}">${esc(labels[v] ?? (v === 'all' ? 'All' : v))}</button>`).join('')}</div>`;
}

function sortSelect(key, options, current) {
  return `<div class="filter-group"><span>Sort</span><select class="chip" data-param="${esc(key)}">${
    options.map(([v, label]) => `<option value="${esc(v)}"${v === current ? ' selected' : ''}>${esc(label)}</option>`).join('')
  }</select></div>`;
}

function wireFilters(root) {
  root.querySelectorAll('.chip[data-param][data-value]').forEach((btn) => {
    btn.addEventListener('click', () => setParam(btn.dataset.param, btn.dataset.value));
  });
  root.querySelectorAll('select.chip[data-param]').forEach((sel) => {
    sel.addEventListener('change', () => setParam(sel.dataset.param, sel.value));
  });
}

/** Click-to-sort table headers. `cols` entries: { label, num, sort, render }. */
function sortableTable(cols, rows, sortKey, dir, onSort) {
  const active = cols.find((c) => c.sort === sortKey);
  const sorted = rows.slice();
  if (active?.sort) {
    sorted.sort((a, b) => {
      const av = active.value(a);
      const bv = active.value(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      const c = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
      return dir === 'desc' ? -c : c;
    });
  }

  const head = cols.map((c) => {
    const sortable = c.sort ? ' sortable' : '';
    const aria = c.sort === sortKey ? ` aria-sort="${dir === 'desc' ? 'descending' : 'ascending'}"` : '';
    return `<th class="${c.num ? 'num' : ''}${sortable}"${aria} data-sort="${esc(c.sort ?? '')}">${esc(c.label)}</th>`;
  }).join('');

  const body = sorted.map((r) => `<tr>${cols.map((c) => `<td class="${c.num ? 'num' : ''}">${c.render(r)}</td>`).join('')}</tr>`).join('');

  const frag = el(`<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`);
  frag.querySelectorAll('th.sortable').forEach((th) => {
    th.addEventListener('click', () => onSort(th.dataset.sort));
  });
  return frag;
}

/* -------------------------------------------------------------------- views */

function renderHome() {
  const c = DB.meta?.counts ?? {};
  const dropCount = DB.loot.reduce((n, t) => n + t.entries.length, 0);

  const featured = DB.monsters
    .filter((m) => m.rarityIndex >= 2)
    .sort((a, b) => b.stats.health - a.stats.health)
    .slice(0, 8);

  const frag = el(`<div>
    <div class="hero">
      <h1>Pixel Chronicles Wiki</h1>
      <p class="subtitle">Every item, monster, drop chance and recipe, read straight out of the game project.</p>
    </div>

    <div class="stat-row">
      <a class="stat-tile" href="#/items"><b>${nf(c.items)}</b><span>Items</span></a>
      <a class="stat-tile" href="#/monsters"><b>${nf(c.monsters)}</b><span>Monsters</span></a>
      <a class="stat-tile" href="#/loot"><b>${nf(dropCount)}</b><span>Drop entries</span></a>
      <a class="stat-tile" href="#/recipes"><b>${nf(c.recipes)}</b><span>Recipes</span></a>
      <a class="stat-tile" href="#/buildings"><b>${nf(c.buildings)}</b><span>Buildings</span></a>
      <a class="stat-tile" href="#/modes"><b>${nf(c.levels)}</b><span>Adventure levels</span></a>
    </div>

    <h2>Toughest monsters</h2>
    <div class="grid" id="featured"></div>

    <h2>Legendary &amp; relic gear</h2>
    <div class="grid" id="best"></div>
  </div>`);

  frag.getElementById('featured').append(...featured.map(monsterCard));
  const best = DB.items.filter((i) => i.rarityIndex >= 4).slice(0, 12);
  frag.getElementById('best').append(...best.map(itemCard));
  return frag;
}

/** Slot is only informative for gear; elsewhere the category says more. */
const EQUIPPABLE = new Set(['Weapon', 'Armor']);
const itemKind = (i) => (EQUIPPABLE.has(i.category) && i.slot ? i.slot : i.tags[0]) ?? null;

const itemCard = (i) => el(`<a class="card r-${cls(i.rarity)}" href="#/item/${slug(i.key)}">
  ${thumb(i.icon, i.name)}
  <span class="card-body">
    <span class="card-title">${esc(i.name)}</span>
    <span class="card-sub">${esc(i.rarity)}${itemKind(i) ? ` · ${esc(itemKind(i))}` : ''}</span>
  </span></a>`);

const monsterCard = (m) => el(`<a class="card mr-${cls(m.rarity)}" href="#/monster/${slug(m.key)}">
  ${thumb(m.icon, m.name)}
  <span class="card-body">
    <span class="card-title">${esc(m.name)}</span>
    <span class="card-sub">${esc(m.element)} · ${nf(m.stats.health)} HP</span>
  </span></a>`);

function renderItems(params) {
  const tag = params.get('tag') ?? 'all';
  const rarity = params.get('rarity') ?? 'all';
  const slot = params.get('slot') ?? 'all';
  const sort = params.get('sort') ?? 'name';

  let rows = DB.items;
  if (tag !== 'all') rows = rows.filter((i) => i.tags.includes(tag));
  if (rarity !== 'all') rows = rows.filter((i) => i.rarity === rarity);
  if (slot !== 'all') rows = rows.filter((i) => (i.slot ?? 'None') === slot);

  const sorters = {
    name: (a, b) => a.name.localeCompare(b.name),
    rarity: (a, b) => b.rarityIndex - a.rarityIndex || a.name.localeCompare(b.name),
    attack: (a, b) => (b.stats?.attack ?? 0) - (a.stats?.attack ?? 0),
    defense: (a, b) => (b.stats?.defense ?? 0) - (a.stats?.defense ?? 0),
    health: (a, b) => (b.stats?.health ?? 0) - (a.stats?.health ?? 0),
  };
  rows = rows.slice().sort(sorters[sort] ?? sorters.name);

  const tags = [...new Set(DB.items.flatMap((i) => i.tags))].sort();
  const slots = [...new Set(DB.items.map((i) => i.slot).filter(Boolean))].sort();

  const frag = el(`<div>
    <h1>Items</h1>
    <p class="subtitle">${nf(DB.items.length)} items — stats, rarity, where they drop and how they are crafted.</p>
    <div class="filters">
      ${chipGroup('Type', 'tag', tags, tag)}
      ${chipGroup('Rarity', 'rarity', DB.meta.rarities, rarity)}
      ${chipGroup('Slot', 'slot', slots, slot)}
      ${sortSelect('sort', [['name', 'Name'], ['rarity', 'Rarity'], ['attack', 'Attack'], ['defense', 'Defense'], ['health', 'Health']], sort)}
      <span class="count">${nf(rows.length)} shown</span>
    </div>
    <div class="grid" id="list"></div>
    ${rows.length ? '' : '<p class="empty-note">No item matches these filters.</p>'}
  </div>`);

  frag.getElementById('list').append(...rows.map(itemCard));
  wireFilters(frag);
  return frag;
}

function renderMonsters(params) {
  const element = params.get('element') ?? 'all';
  const rarity = params.get('rarity') ?? 'all';
  const env = params.get('env') ?? 'all';
  const sort = params.get('sort') ?? 'name';
  const dir = params.get('dir') ?? (sort === 'name' ? 'asc' : 'desc');

  let rows = DB.monsters;
  if (element !== 'all') rows = rows.filter((m) => m.element === element);
  if (rarity !== 'all') rows = rows.filter((m) => m.rarity === rarity);
  if (env !== 'all') rows = rows.filter((m) => m.environment === env);

  const envs = [...new Set(DB.monsters.map((m) => m.environment).filter(Boolean))].sort();

  const cols = [
    { label: 'Monster', sort: 'name', value: (m) => m.name, render: (m) => `<span class="with-icon">${iconImg(m.icon)}<a href="#/monster/${slug(m.key)}">${esc(m.name)}</a></span>` },
    { label: 'Element', sort: 'element', value: (m) => m.element, render: (m) => elementBadge(m.element, m.elementIcon) },
    { label: 'Rarity', sort: 'rarity', value: (m) => m.rarityIndex, render: (m) => rarityBadge(m.rarity, 'monster') },
    { label: 'Biome', sort: 'env', value: (m) => m.environment, render: (m) => esc(m.environment ?? '—') },
    { label: 'HP', num: true, sort: 'health', value: (m) => m.stats.health, render: (m) => nf(m.stats.health) },
    { label: 'ATK', num: true, sort: 'attack', value: (m) => m.stats.attack, render: (m) => nf(m.stats.attack) },
    { label: 'DEF', num: true, sort: 'defense', value: (m) => m.stats.defense, render: (m) => nf(m.stats.defense) },
    { label: 'ATK spd', num: true, sort: 'speed', value: (m) => m.stats.attackSpeed, render: (m) => (m.stats.attackSpeed == null ? '—' : round(m.stats.attackSpeed).toFixed(2)) },
    { label: 'Drops', num: true, sort: 'drops', value: (m) => (IX.loot.get(m.lootTable)?.entries.length ?? 0), render: (m) => (m.lootTable ? `<a href="#/loot/${slug(m.lootTable)}">${IX.loot.get(m.lootTable).entries.length}</a>` : '—') },
  ];

  const frag = el(`<div>
    <h1>Monsters</h1>
    <p class="subtitle">${nf(DB.monsters.length)} monsters, ${nf(DB.monsters.filter((m) => m.summonable).length)} of them summonable —
      several appear in no combat level and can only be summoned. Base stats are the level‑1 values on the
      entity prefab, before the per‑level multipliers a stage applies.</p>
    <div class="filters">
      ${chipGroup('Element', 'element', DB.meta.elements, element)}
      ${chipGroup('Rarity', 'rarity', DB.meta.monsterRarities, rarity)}
      ${chipGroup('Biome', 'env', envs, env)}
      <span class="count">${nf(rows.length)} shown</span>
    </div>
    <div id="table"></div>
  </div>`);

  frag.getElementById('table').append(sortableTable(cols, rows, sort, dir, (key) => {
    const nextDir = key === sort && dir === 'asc' ? 'desc' : key === sort ? 'asc' : (key === 'name' ? 'asc' : 'desc');
    const { parts, params: p } = parseHash();
    p.set('sort', key); p.set('dir', nextDir);
    location.hash = `/${parts.join('/')}?${p}`;
  }));
  wireFilters(frag);
  return frag;
}

function renderItemDetail(key) {
  const i = IX.item.get(key);
  if (!i) return notFound('item', key);

  const set = i.set ? IX.set.get(i.set) : null;
  const recipes = i.craftedBy.map((id) => IX.recipe.get(id)).filter(Boolean);
  const usedIn = i.usedIn.map((id) => IX.recipe.get(id)).filter(Boolean);
  const drops = i.droppedBy.slice().sort((a, b) => (b.chance.normal ?? 0) - (a.chance.normal ?? 0));

  const statRows = i.stats ? [
    ['Attack', i.stats.attack],
    ['Defense', i.stats.defense],
    ['Health', i.stats.health],
    ['Attack speed', i.stats.attackSpeed == null ? null : round(i.stats.attackSpeed).toFixed(2)],
  ].filter(([, v]) => v) : [];

  const frag = el(`<div>
    <p class="crumbs"><a href="#/items">Items</a>${i.tags.length ? ` <span class="arrow">/</span> ${esc(i.tags[0])}` : ''}</p>

    <div class="detail-head">
      ${thumb(i.icon, i.name)}
      <div>
        <h1>${esc(i.name)}</h1>
        <div class="detail-meta">
          ${rarityBadge(i.rarity)}
          ${i.tags.map((t) => `<span class="badge">${esc(t)}</span>`).join('')}
          ${i.slot ? `<span class="badge">${esc(i.slot)}</span>` : ''}
          ${i.maxStack > 1 ? `<span class="badge">Stacks ×${nf(i.maxStack)}</span>` : ''}
          ${i.upgradable && i.slot ? '<span class="badge">Upgradable</span>' : ''}
        </div>
      </div>
    </div>

    <div class="panels">
      ${statRows.length || i.tool ? `<section class="panel">
        <h3>Stats</h3>
        <dl class="stats">
          ${statRows.map(([label, v]) => `<div><dt>${esc(label)}</dt><dd>${esc(v)}</dd></div>`).join('')}
          ${i.maxCharges ? `<div><dt>Skill charges</dt><dd>${nf(i.maxCharges)}</dd></div>` : ''}
          ${i.tool ? `
            <div><dt>Tool type</dt><dd>${esc(i.tool.type)}</dd></div>
            <div><dt>Tool tier</dt><dd>${nf(i.tool.tier)}</dd></div>
            <div><dt>Tool damage</dt><dd>${nf(i.tool.damage)}</dd></div>` : ''}
        </dl>
      </section>` : ''}

      ${recipes.length ? `<section class="panel">
        <h3>Crafting</h3>
        ${recipes.map(recipePanelBody).join('<hr style="border:0;border-top:1px solid var(--line-soft);margin:12px 0">')}
      </section>` : ''}

      ${set ? `<section class="panel">
        <h3>Set — ${esc(set.name)}</h3>
        <ul class="ingredients">
          ${set.pieces.map((p) => `<li>${pieceRow(p)}</li>`).join('')}
          ${set.associatedWeapon ? `<li>${pieceRow(set.associatedWeapon)}</li>` : ''}
        </ul>
        <h3 style="margin-top:14px">Set bonus</h3>
        <dl class="stats">${set.bonuses.map((b) => `<div><dt>${esc(b.stat)}</dt><dd>+${nf(b.value)}${b.unit === '%' ? '%' : ''}</dd></div>`).join('')}</dl>
      </section>` : ''}

      ${usedIn.length ? `<section class="panel">
        <h3>Used in ${usedIn.length} recipe${usedIn.length > 1 ? 's' : ''}</h3>
        <ul class="ingredients">${usedIn.map((r) => {
          const amount = r.ingredients.find((x) => x.item === i.key)?.amount ?? 0;
          const out = IX.item.get(r.output);
          return `<li>${out?.icon ? iconImg(out.icon) : ''}
            <a href="#/recipe/${slug(r.id)}">${esc(r.outputName)}</a>
            <span class="amount">×${nf(amount)}</span></li>`;
        }).join('')}</ul>
      </section>` : ''}
    </div>

    <h2>Where it drops</h2>
    <div id="drops"></div>
  </div>`);

  const dropsHost = frag.getElementById('drops');
  if (!drops.length) {
    dropsHost.append(el('<p class="empty-note">Not in any loot table — obtained by crafting, the shop, or stage rewards.</p>'));
  } else {
    dropsHost.append(sortableTable([
      { label: 'Source', render: (d) => `<span class="with-icon">${iconImg(d.icon)}${
        d.monster ? `<a href="#/monster/${slug(d.monster)}">${esc(d.source)}</a>` : `<a href="#/loot/${slug(d.table)}">${esc(d.source)}</a>`}</span>` },
      { label: 'Kind', render: (d) => `<span class="badge">${esc(d.kind === 'Monsters' ? 'Monster' : d.kind)}</span>` },
      { label: 'Biome', render: (d) => biomeBadges(d.biomes) },
      { label: 'Normal', num: true, render: (d) => chanceCell(d.chance.normal) },
      { label: 'Hard', num: true, render: (d) => chanceCell(d.chance.hard) },
      { label: 'Master', num: true, render: (d) => chanceCell(d.chance.master) },
      { label: 'Amount', num: true, render: (d) => esc(amountsText(d.amounts)) },
    ], drops, null, 'asc', () => {}));
  }
  return frag;
}

const pieceRow = (key) => {
  const p = IX.item.get(key);
  if (!p) return esc(key);
  return `${iconImg(p.icon)}<a href="#/item/${slug(key)}">${esc(p.name)}</a>
    <span class="amount">${esc(p.slot ?? p.category)}</span>`;
};

function recipePanelBody(r) {
  return `<ul class="ingredients">${r.ingredients.map((ing) => {
    const it = IX.item.get(ing.item);
    return `<li>${it?.icon ? iconImg(it.icon) : ''}${linkItem(ing.item)}<span class="amount">×${nf(ing.amount)}</span></li>`;
  }).join('')}</ul>
  <dl class="stats" style="margin-top:11px">
    <div><dt>Station</dt><dd>${esc(r.station)}${r.stationLevel ? ` Lv.${r.stationLevel}` : ''}</dd></div>
    <div><dt>Output</dt><dd>×${nf(r.outputAmount)}</dd></div>
  </dl>
  <p style="margin:9px 0 0"><a href="#/recipe/${slug(r.id)}">Open recipe →</a></p>`;
}

function renderMonsterDetail(key) {
  const m = IX.monster.get(key);
  if (!m) return notFound('monster', key);

  const table = m.lootTable ? IX.loot.get(m.lootTable) : null;
  const maxHp = Math.max(...DB.monsters.map((x) => x.stats.health ?? 0));
  const maxAtk = Math.max(...DB.monsters.map((x) => x.stats.attack ?? 0));
  const maxDef = Math.max(...DB.monsters.map((x) => x.stats.defense ?? 0));

  const bar = (label, value, max) => `<div><dt>${esc(label)}</dt><dd>${nf(value)}</dd></div>
    <div class="bar" style="grid-column:1/-1"><i style="width:${max ? Math.round((value / max) * 100) : 0}%"></i></div>`;

  const frag = el(`<div>
    <p class="crumbs"><a href="#/monsters">Monsters</a> <span class="arrow">/</span> ${esc(m.element)}</p>

    <div class="detail-head">
      ${thumb(m.icon, m.name)}
      <div>
        <h1>${esc(m.name)}</h1>
        <div class="detail-meta">
          ${rarityBadge(m.rarity, 'monster')}
          ${elementBadge(m.element, m.elementIcon)}
          ${m.environment ? `<span class="badge">${esc(m.environment)}</span>` : ''}
          <span class="badge">${m.obtainable ? 'Obtainable' : 'Not obtainable'}</span>
        </div>
      </div>
    </div>

    <div class="panels">
      <section class="panel">
        <h3>Base stats (level 1)</h3>
        <dl class="stats">
          ${bar('Health', m.stats.health, maxHp)}
          ${bar('Attack', m.stats.attack, maxAtk)}
          ${bar('Defense', m.stats.defense, maxDef)}
          <div><dt>Attack speed</dt><dd>${m.stats.attackSpeed == null ? '—' : round(m.stats.attackSpeed).toFixed(2)}</dd></div>
          <div><dt>Attack interval</dt><dd>${m.stats.attackInterval == null ? '—' : `${round(m.stats.attackInterval).toFixed(2)}s`}</dd></div>
          ${m.stats.weightedStats ? `<div><dt>Stat weight</dt><dd>${nf(m.stats.weightedStats)}</dd></div>` : ''}
        </dl>
      </section>

      ${summonPanel(m)}

      ${m.skills.length ? `<section class="panel">
        <h3>Skills</h3>
        ${m.skills.map((s) => `<div class="skill">
          <div class="skill-head">
            <span class="skill-icon">${iconImg(s.icon)}</span>
            <span><span class="skill-name">${esc(s.name)}</span><span class="skill-kind ${cls(s.kind)}">${esc(s.kind)}</span></span>
          </div>
          ${s.description ? `<p>${esc(plain(s.description))}</p>` : ''}
        </div>`).join('')}
      </section>` : ''}
    </div>

    <h2>Loot</h2>
    <div id="loot"></div>
  </div>`);

  const host = frag.getElementById('loot');
  if (!table?.entries.length) {
    host.append(el('<p class="empty-note">No personal loot table. Bosses and elites drop through their stage’s reward pool instead.</p>'));
  } else {
    host.append(lootEntriesTable(table.entries));
  }
  return frag;
}

function lootEntriesTable(entries) {
  return sortableTable([
    { label: 'Item', render: (e) => {
      const it = IX.item.get(e.item);
      return `<span class="with-icon">${it?.icon ? iconImg(it.icon) : ''}${linkItem(e.item)}</span>`;
    } },
    { label: 'Rarity', render: (e) => { const it = IX.item.get(e.item); return it ? rarityBadge(it.rarity) : '—'; } },
    { label: 'Normal', num: true, render: (e) => chanceCell(e.chance.normal) },
    { label: 'Hard', num: true, render: (e) => chanceCell(e.chance.hard) },
    { label: 'Master', num: true, render: (e) => chanceCell(e.chance.master) },
    { label: 'Amount', num: true, render: (e) => esc(amountsText(e.amounts)) },
  ], entries.slice().sort((a, b) => (b.chance.normal ?? 0) - (a.chance.normal ?? 0)), null, 'asc', () => {});
}

function renderLootList(params) {
  const kind = params.get('kind') ?? 'all';
  const biome = params.get('biome') ?? 'all';
  const itemQuery = params.get('item') ?? '';
  const needle = itemQuery.trim().toLowerCase();

  let rows = DB.loot;
  if (kind !== 'all') rows = rows.filter((t) => t.kind === kind);
  if (biome !== 'all') rows = rows.filter((t) => t.biomes.includes(biome));
  if (needle) {
    rows = rows.filter((t) => t.entries.some((e) => {
      const item = IX.item.get(e.item);
      return (item?.name ?? e.itemName ?? '').toLowerCase().includes(needle)
        || String(e.item ?? '').toLowerCase().includes(needle);
    }));
  }

  const kinds = [...new Set(DB.loot.map((t) => t.kind))].sort();
  const biomes = [...new Set(DB.loot.flatMap((t) => t.biomes))].sort();
  const matchedItems = needle ? countMatchedDrops(rows, needle) : 0;

  const frag = el(`<div>
    <h1>Loot tables</h1>
    <p class="subtitle">${nf(DB.loot.length)} tables. Chances are per kill or per harvest, listed for each difficulty.</p>
    <div class="filters">
      <div class="filter-group" style="flex:1 1 220px">
        <span>Drops item</span>
        <input id="loot-item" type="search" class="chip" style="flex:1;min-width:150px"
               placeholder="e.g. Iron Bar" value="${esc(itemQuery)}" aria-label="Filter tables by dropped item">
      </div>
      ${chipGroup('Kind', 'kind', kinds, kind)}
      ${chipGroup('Biome', 'biome', biomes, biome)}
      <span class="count">${nf(rows.length)} table${rows.length === 1 ? '' : 's'}${needle ? ` · ${nf(matchedItems)} matching drop${matchedItems === 1 ? '' : 's'}` : ''}</span>
    </div>
    <div id="table"></div>
    ${rows.length ? '' : '<p class="empty-note">No loot table matches these filters.</p>'}
  </div>`);

  frag.getElementById('table').append(sortableTable([
    { label: 'Source', sort: 'name', value: (t) => t.sourceName, render: (t) => `<span class="with-icon">${
      t.icon ? iconImg(t.icon) : ''}<a href="#/loot/${slug(t.id)}">${esc(t.sourceName)}</a></span>` },
    { label: 'Kind', sort: 'kind', value: (t) => t.kind, render: (t) => `<span class="badge">${esc(t.kind === 'Monsters' ? 'Monster' : t.kind)}</span>` },
    { label: 'Biome', sort: 'biome', value: (t) => t.biomes.join(', '), render: (t) => biomeBadges(t.biomes) },
    { label: 'Entries', num: true, sort: 'entries', value: (t) => t.entries.length, render: (t) => nf(t.entries.length) },
    // With an item filter active, show only the drops that matched.
    { label: 'Items', render: (t) => {
      const shown = needle
        ? t.entries.filter((e) => matchesItem(e, needle))
        : t.entries;
      const head = shown.slice(0, 4).map((e) => `${linkItem(e.item)}${
        e.chance.normal == null ? '' : ` <span class="chance">${e.chance.normal}%</span>`}`).join(', ');
      return head + (shown.length > 4 ? ` +${shown.length - 4}` : '');
    } },
  ], rows, params.get('sort') ?? 'name', params.get('dir') ?? 'asc', (key) => {
    const { parts, params: p } = parseHash();
    p.set('sort', key);
    p.set('dir', key === (params.get('sort') ?? 'name') && (params.get('dir') ?? 'asc') === 'asc' ? 'desc' : 'asc');
    location.hash = `/${parts.join('/')}?${p}`;
  }));

  wireFilters(frag);
  wireLootItemFilter(frag);
  return frag;
}

const matchesItem = (entry, needle) => {
  const item = IX.item.get(entry.item);
  return (item?.name ?? entry.itemName ?? '').toLowerCase().includes(needle)
    || String(entry.item ?? '').toLowerCase().includes(needle);
};

const countMatchedDrops = (rows, needle) =>
  rows.reduce((n, t) => n + t.entries.filter((e) => matchesItem(e, needle)).length, 0);

/** Set while the user is typing, so the caret survives the re-render. */
let refocusLootFilter = false;

/** Debounced so typing does not push a hash entry per keystroke. */
function wireLootItemFilter(root) {
  const input = root.getElementById('loot-item');
  if (!input) return;

  let timer;
  const commit = () => { refocusLootFilter = true; setParam('item', input.value.trim()); };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(commit, 220); });
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { clearTimeout(timer); commit(); } });

  if (refocusLootFilter) {
    refocusLootFilter = false;
    // Deferred: the node is not in the document until route() swaps it in.
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  }
}

function renderLootDetail(id) {
  const t = IX.loot.get(id);
  if (!t) return notFound('loot table', id);
  const monster = t.monster ? IX.monster.get(t.monster) : null;

  const frag = el(`<div>
    <p class="crumbs"><a href="#/loot">Loot tables</a> <span class="arrow">/</span> ${esc(t.kind)}</p>
    <div class="detail-head">
      ${thumb(t.icon, t.sourceName)}
      <div>
        <h1>${esc(t.sourceName)}</h1>
        <div class="detail-meta">
          <span class="badge">${esc(t.kind === 'Monsters' ? 'Monster' : t.kind)}</span>
          ${t.biomes.map((b) => `<span class="badge">${esc(b)}</span>`).join('')}
          <span class="badge">${nf(t.entries.length)} entr${t.entries.length === 1 ? 'y' : 'ies'}</span>
        </div>
        ${monster ? `<p style="margin:9px 0 0"><a href="#/monster/${slug(monster.key)}">Open monster →</a></p>` : ''}
      </div>
    </div>
    <div id="table" style="margin-top:20px"></div>
    ${t.spawns.length ? '<h2>Where it spawns</h2><div id="spawns"></div>' : ''}
  </div>`);

  const host = frag.getElementById('table');
  if (!t.entries.length) host.append(el('<p class="empty-note">This table is empty.</p>'));
  else host.append(lootEntriesTable(t.entries));

  const spawnHost = frag.getElementById('spawns');
  if (spawnHost) {
    spawnHost.append(sortableTable([
      { label: 'Biome', render: (s) => `<span class="badge">${esc(s.biome)}</span>` },
      { label: 'Difficulty', render: (s) => esc(s.difficulty) },
      { label: 'Prop', render: (s) => esc(prettifyName(s.resource)) },
      { label: 'Spawn chance', num: true, render: (s) => chanceCell(s.spawnChance) },
    ], t.spawns, null, 'asc', () => {}));
  }
  return frag;
}

/**
 * Which permanent banners carry the monster, and from which rarity pool — never
 * the odds, which are retuned constantly and already shown in the client. Limited
 * event banners are left out of the payload entirely.
 */
function summonPanel(m) {
  if (!m.summon.length) {
    return `<section class="panel"><h3>How to obtain</h3>
      <p class="empty-note">In no summon pool — not currently obtainable.</p>
    </section>`;
  }

  const pools = [...new Set(m.summon.map((s) => s.poolRarity))];

  return `<section class="panel">
    <h3>How to obtain</h3>
    <p class="empty-note" style="margin-bottom:11px">
      Summoned from the <strong>${pools.map(esc).join(' / ')}</strong> pool.
      Check the in-game banner for current rates.
    </p>
    <ul class="pill-list">${m.summon.map((s) => `<li><span class="badge">${esc(s.bannerName)}</span></li>`).join('')}</ul>
  </section>`;
}

const prettifyName = (s) => String(s ?? '')
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .replace(/\s+/g, ' ')
  .trim();

function renderRecipes(params) {
  const category = params.get('category') ?? 'all';
  const station = params.get('station') ?? 'all';

  let rows = DB.recipes;
  if (category !== 'all') rows = rows.filter((r) => r.category === category);
  if (station !== 'all') rows = rows.filter((r) => r.station === station);

  const categories = [...new Set(DB.recipes.map((r) => r.category))].sort();
  const stations = [...new Set(DB.recipes.map((r) => r.station))].sort();

  const frag = el(`<div>
    <h1>Recipes</h1>
    <p class="subtitle">${nf(DB.recipes.length)} recipes.</p>
    <div class="filters">
      ${chipGroup('Category', 'category', categories, category)}
      ${chipGroup('Station', 'station', stations, station)}
      <span class="count">${nf(rows.length)} shown</span>
    </div>
    <div id="table"></div>
  </div>`);

  frag.getElementById('table').append(sortableTable([
    { label: 'Result', sort: 'name', value: (r) => r.outputName, render: (r) => {
      const it = IX.item.get(r.output);
      return `<span class="with-icon">${it?.icon ? iconImg(it.icon) : ''}<a href="#/recipe/${slug(r.id)}">${esc(r.outputName)}</a>${r.outputAmount > 1 ? ` ×${r.outputAmount}` : ''}</span>`;
    } },
    { label: 'Category', sort: 'category', value: (r) => r.category, render: (r) => `<span class="badge">${esc(r.category)}</span>` },
    { label: 'Station', sort: 'station', value: (r) => r.station, render: (r) => esc(r.station) },
    { label: 'Lv.', num: true, sort: 'level', value: (r) => r.stationLevel, render: (r) => nf(r.stationLevel) },
    { label: 'Ingredients', render: (r) => r.ingredients.map((ing) => `${linkItem(ing.item)} ×${nf(ing.amount)}`).join(', ') },
  ], rows, params.get('sort') ?? 'name', params.get('dir') ?? 'asc', (key) => {
    const { parts, params: p } = parseHash();
    p.set('sort', key);
    p.set('dir', key === (params.get('sort') ?? 'name') && (params.get('dir') ?? 'asc') === 'asc' ? 'desc' : 'asc');
    location.hash = `/${parts.join('/')}?${p}`;
  }));
  wireFilters(frag);
  return frag;
}

function renderRecipeDetail(id) {
  const r = IX.recipe.get(id);
  if (!r) return notFound('recipe', id);
  const out = IX.item.get(r.output);

  return el(`<div>
    <p class="crumbs"><a href="#/recipes">Recipes</a> <span class="arrow">/</span> ${esc(r.category)}</p>
    <div class="detail-head">
      ${thumb(out?.icon, r.outputName)}
      <div>
        <h1>${esc(r.outputName)}${r.outputAmount > 1 ? ` ×${r.outputAmount}` : ''}</h1>
        <div class="detail-meta">
          ${out ? rarityBadge(out.rarity) : ''}
          <span class="badge">${esc(r.category)}</span>
          <span class="badge">${esc(r.station)}${r.stationLevel ? ` Lv.${r.stationLevel}` : ''}</span>
        </div>
        ${out ? `<p style="margin:9px 0 0"><a href="#/item/${slug(out.key)}">Open item →</a></p>` : ''}
      </div>
    </div>

    <div class="panels" style="margin-top:20px">
      <section class="panel">
        <h3>Ingredients</h3>
        <ul class="ingredients">${r.ingredients.map((ing) => {
          const it = IX.item.get(ing.item);
          return `<li>${it?.icon ? iconImg(it.icon) : ''}${linkItem(ing.item)}<span class="amount">×${nf(ing.amount)}</span></li>`;
        }).join('')}</ul>
      </section>
      ${subRecipesPanel(r)}
    </div>
  </div>`);
}

/** Ingredients that are themselves craftable, so the chain is visible. */
function subRecipesPanel(r) {
  const subs = r.ingredients
    .map((ing) => IX.item.get(ing.item))
    .filter((it) => it?.craftedBy.length)
    .map((it) => IX.recipe.get(it.craftedBy[0]))
    .filter(Boolean);
  if (!subs.length) return '';

  return `<section class="panel">
    <h3>Crafted from crafted parts</h3>
    ${subs.map((s) => `<div class="skill">
      <span class="skill-name"><a href="#/recipe/${slug(s.id)}">${esc(s.outputName)}</a></span>
      <span class="skill-kind">${esc(s.station)}${s.stationLevel ? ` Lv.${s.stationLevel}` : ''}</span>
      <p>${s.ingredients.map((ing) => `${esc(ing.itemName)} ×${nf(ing.amount)}`).join(' · ')}</p>
    </div>`).join('')}
  </section>`;
}

function renderSets() {
  const frag = el(`<div>
    <h1>Item sets</h1>
    <p class="subtitle">${nf(DB.sets.length)} sets. Wearing every piece grants the listed bonus.</p>
    <div class="panels" id="list"></div>
  </div>`);

  frag.getElementById('list').append(...DB.sets.map((s) => el(`<section class="panel">
    <h3>${esc(s.name)}</h3>
    <ul class="ingredients">
      ${s.pieces.map((p) => `<li>${pieceRow(p)}</li>`).join('')}
      ${s.associatedWeapon ? `<li>${pieceRow(s.associatedWeapon)}</li>` : ''}
    </ul>
    <h3 style="margin-top:14px">Set bonus</h3>
    <dl class="stats">${s.bonuses.map((b) => `<div><dt>${esc(b.stat)}</dt><dd>+${nf(b.value)}${b.unit === '%' ? '%' : ''}</dd></div>`).join('')}</dl>
  </section>`)));
  return frag;
}

/* ---------------------------------------------------------------- buildings */

const duration = (seconds) => {
  if (!seconds) return 'instant';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h && `${h}h`, m && `${m}m`, s && `${s}s`].filter(Boolean).join(' ');
};

const costText = (c) => {
  const parts = [];
  if (c.amount) parts.push(`${nf(c.amount)} ${c.currency}`);
  for (const m of c.materials) parts.push(`${esc(m.itemName)} ×${nf(m.amount)}`);
  return parts.length ? parts.join(' · ') : 'free';
};

function renderBuildings(params) {
  const category = params.get('category') ?? 'all';
  let rows = DB.buildings;
  if (category !== 'all') rows = rows.filter((b) => b.category === category);

  const categories = [...new Set(DB.buildings.map((b) => b.category))].sort();

  const frag = el(`<div>
    <h1>Buildings</h1>
    <p class="subtitle">${nf(DB.buildings.length)} buildings you can buy. The ones that start as ruins on your island
      and are repaired rather than purchased are left out.</p>
    <div class="filters">
      ${chipGroup('Category', 'category', categories, category)}
      <span class="count">${nf(rows.length)} shown</span>
    </div>
    <div class="panels" id="list"></div>
  </div>`);

  frag.getElementById('list').append(...rows.map((b) => el(`<section class="panel">
    <div class="skill-head" style="margin-bottom:10px">
      <span class="thumb" style="width:44px;height:44px;flex:none">${iconImg(b.icon, b.name)}</span>
      <span>
        <span class="skill-name" style="font-size:16px">${esc(b.name)}</span>
        <span class="skill-kind">${esc(b.category)}</span>
      </span>
    </div>
    ${b.description ? `<p style="margin:0 0 12px;font-size:13px;color:var(--text-dim)">${esc(plain(b.description))}</p>` : ''}
    <dl class="stats">
      <div><dt>Buy</dt><dd>${costText(b.purchase)}</dd></div>
      ${b.purchase.buildSeconds ? `<div><dt>Build time</dt><dd>${esc(duration(b.purchase.buildSeconds))}</dd></div>` : ''}
      <div><dt>Max level</dt><dd>${nf(b.maxLevel)}</dd></div>
    </dl>
    ${b.upgrades.length ? `<h3 style="margin:14px 0 8px">Upgrades</h3>
      <div class="table-wrap"><table><thead><tr><th>Lv.</th><th>Cost</th><th>Time</th></tr></thead><tbody>
        ${b.upgrades.map((u) => `<tr><td>${u.level}</td><td>${costText(u)}</td><td>${esc(duration(u.buildSeconds))}</td></tr>`).join('')}
      </tbody></table></div>` : ''}
  </section>`)));

  wireFilters(frag);
  return frag;
}

/* --------------------------------------------------------------- game modes */

function renderModes() {
  const frag = el(`<div>
    <h1>Game modes</h1>
    <p class="subtitle">Adventure is documented; the other modes are not in the wiki yet.</p>
    <div class="grid" id="list"></div>
  </div>`);

  frag.getElementById('list').append(...DB.gamemodes.map((m) => {
    const levels = m.chapters.reduce((n, c) => n + c.difficulties.reduce((k, d) => k + d.levels.length, 0), 0);
    return el(`<a class="card" href="#/mode/${slug(m.key)}">
      ${thumb(m.icon, m.name)}
      <span class="card-body">
        <span class="card-title">${esc(m.name)}</span>
        <span class="card-sub">${nf(m.chapters.length)} chapters · ${nf(levels)} levels</span>
      </span></a>`);
  }));
  return frag;
}

function renderMode(key) {
  const mode = IX.mode.get(key);
  if (!mode) return notFound('game mode', key);

  const frag = el(`<div>
    <p class="crumbs"><a href="#/modes">Game modes</a></p>
    <div class="detail-head">
      ${thumb(mode.icon, mode.name)}
      <div>
        <h1>${esc(mode.name)}</h1>
        <div class="detail-meta"><span class="badge">${nf(mode.chapters.length)} chapters</span></div>
      </div>
    </div>
    <h2>Chapters</h2>
    <div class="grid" id="list"></div>
  </div>`);

  frag.getElementById('list').append(...mode.chapters.map((c, index) => {
    const levels = c.difficulties.reduce((n, d) => n + d.levels.length, 0);
    return el(`<a class="card" href="#/chapter/${slug(c.key)}">
      <span class="thumb" style="width:40px;height:40px;flex:none;font:600 15px var(--mono);color:var(--text-dim)">${index + 1}</span>
      <span class="card-body">
        <span class="card-title">${esc(c.name)}</span>
        <span class="card-sub">${c.biome ? `${esc(c.biome)} · ` : ''}${nf(levels)} levels</span>
      </span></a>`);
  }));
  return frag;
}

function renderChapter(key, params) {
  const found = IX.chapter.get(key);
  if (!found) return notFound('chapter', key);
  const { chapter, mode } = found;

  const available = chapter.difficulties.map((d) => d.difficulty);
  const difficulty = available.includes(params.get('difficulty')) ? params.get('difficulty') : available[0];
  const levels = chapter.difficulties.find((d) => d.difficulty === difficulty)?.levels ?? [];

  const frag = el(`<div>
    <p class="crumbs"><a href="#/modes">Game modes</a> <span class="arrow">/</span>
      <a href="#/mode/${slug(mode.key)}">${esc(mode.name)}</a></p>
    <h1>${esc(chapter.name)}</h1>
    <p class="subtitle">${chapter.biome ? `${esc(chapter.biome)} biome. ` : ''}Waves are listed in the order they spawn.</p>
    <div class="filters">
      <div class="filter-group"><span>Difficulty</span>${available.map((d) => `
        <button type="button" class="chip" data-param="difficulty" data-value="${esc(d)}"
                aria-pressed="${String(d === difficulty)}">${esc(d)}</button>`).join('')}</div>
      <span class="count">${nf(levels.length)} levels</span>
    </div>
    <div id="levels"></div>
  </div>`);

  frag.getElementById('levels').append(...levels.map((l) => el(`<section class="panel" style="margin-bottom:14px">
    <div class="skill-head" style="justify-content:space-between;margin-bottom:10px">
      <span><span class="skill-name" style="font-size:16px">Level ${l.index}</span>
        <span class="skill-kind">${nf(l.waves.length)} waves</span></span>
      <span class="biome-list">
        <span class="badge">${nf(l.cost)} ${esc(l.costCurrency)}</span>
        <span class="badge">${nf(l.xp)} XP</span>
        <span class="badge">${nf(l.coins[0])}–${nf(l.coins[1])} coins</span>
        ${l.teamSlots ? `<span class="badge">${nf(l.teamSlots)} slots</span>` : ''}
      </span>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Wave</th><th>Enemies</th></tr></thead>
      <tbody>${l.waves.map((w) => `<tr>
        <td class="num">${w.index}</td>
        <td>${w.enemies.map((e) => `<span class="with-icon" style="display:inline-flex;margin-right:14px">
          ${iconImg(e.icon, e.name)}
          ${e.monster ? `<a href="#/monster/${slug(e.monster)}">${esc(e.name)}</a>` : esc(e.name)}
          ${e.count > 1 ? ` ×${e.count}` : ''}
          <span class="skill-kind${e.type === 'Boss' ? ' special' : ''}">Lv.${e.level}${e.type === 'Basic' ? '' : ` ${e.type}`}</span>
        </span>`).join('')}</td>
      </tr>`).join('')}</tbody>
    </table></div>
  </section>`)));

  wireFilters(frag);
  return frag;
}

const notFound = (kind, key) => el(`<div>
  <h1>Not found</h1>
  <p class="subtitle">No ${esc(kind)} named “${esc(key)}”.</p>
  <p><a href="#/">Back to the wiki home →</a></p>
</div>`);

/* ------------------------------------------------------------------ search */

function searchAll(query) {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];

  const score = (name, key) => {
    const n = name.toLowerCase();
    if (n === q) return 0;
    if (n.startsWith(q)) return 1;
    if (n.includes(q)) return 2;
    if (String(key).toLowerCase().includes(q)) return 3;
    return -1;
  };

  const hits = [];
  const push = (kind, name, href, icon, key) => {
    const s = score(name, key);
    if (s >= 0) hits.push({ kind, name, href, icon, s });
  };

  for (const i of DB.items) push('Item', i.name, `#/item/${slug(i.key)}`, i.icon, i.key);
  for (const m of DB.monsters) push('Monster', m.name, `#/monster/${slug(m.key)}`, m.icon, m.key);
  for (const r of DB.recipes) push('Recipe', r.outputName, `#/recipe/${slug(r.id)}`, IX.item.get(r.output)?.icon, r.id);
  for (const s of DB.sets) push('Set', s.name, `#/sets`, null, s.key);
  for (const t of DB.loot) push('Loot', t.sourceName, `#/loot/${slug(t.id)}`, t.icon, t.id);
  for (const b of DB.buildings) push('Building', b.name, `#/buildings`, b.icon, b.key);
  for (const m of DB.gamemodes) {
    for (const c of m.chapters) push('Chapter', c.name, `#/chapter/${slug(c.key)}`, null, c.key);
  }

  hits.sort((a, b) => a.s - b.s || a.name.localeCompare(b.name));
  return hits.slice(0, 12);
}

let activeSuggestion = -1;

function renderSuggestions(hits) {
  activeSuggestion = -1;
  if (!hits.length) { closeSuggestions(); return; }
  suggestions.innerHTML = hits.map((h) => `<li role="option" aria-selected="false">
    <a href="${h.href}">
      ${h.icon ? iconImg(h.icon) : '<span class="thumb" style="width:24px;height:24px"></span>'}
      <span>${esc(h.name)}</span><span class="kind">${esc(h.kind)}</span>
    </a></li>`).join('');
  suggestions.hidden = false;
  searchInput.setAttribute('aria-expanded', 'true');
}

function closeSuggestions() {
  suggestions.hidden = true;
  suggestions.innerHTML = '';
  activeSuggestion = -1;
  searchInput.setAttribute('aria-expanded', 'false');
}

function moveSuggestion(delta) {
  const options = [...suggestions.querySelectorAll('li')];
  if (!options.length) return;
  options.forEach((li) => li.setAttribute('aria-selected', 'false'));
  activeSuggestion = (activeSuggestion + delta + options.length) % options.length;
  options[activeSuggestion].setAttribute('aria-selected', 'true');
  options[activeSuggestion].scrollIntoView({ block: 'nearest' });
}

searchInput.addEventListener('input', () => renderSuggestions(searchAll(searchInput.value)));

searchInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'ArrowDown') { ev.preventDefault(); moveSuggestion(1); }
  else if (ev.key === 'ArrowUp') { ev.preventDefault(); moveSuggestion(-1); }
  else if (ev.key === 'Enter') {
    const options = [...suggestions.querySelectorAll('li a')];
    const target = options[activeSuggestion] ?? options[0];
    if (target) { ev.preventDefault(); location.hash = target.getAttribute('href').slice(1); searchInput.blur(); }
  } else if (ev.key === 'Escape') { closeSuggestions(); searchInput.blur(); }
});

suggestions.addEventListener('click', (ev) => { if (ev.target.closest('a')) { closeSuggestions(); searchInput.value = ''; } });

document.addEventListener('click', (ev) => {
  if (!ev.target.closest('.search')) closeSuggestions();
});

document.addEventListener('keydown', (ev) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '');
  if (ev.key === '/' && !typing) { ev.preventDefault(); searchInput.focus(); searchInput.select(); }
});

/* -------------------------------------------------------------------- theme */

const themeBtn = document.getElementById('theme');
const storedTheme = localStorage.getItem('pc-wiki-theme');
if (storedTheme) document.documentElement.dataset.theme = storedTheme;
themeBtn.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('pc-wiki-theme', next);
});

/* ------------------------------------------------------------------- router */

function route() {
  const { parts, params } = parseHash();
  const [section, ...rest] = parts;
  const key = rest.join('/');

  let content;
  switch (section) {
    case undefined: content = renderHome(); break;
    case 'items': content = renderItems(params); break;
    case 'item': content = renderItemDetail(key); break;
    case 'monsters': content = renderMonsters(params); break;
    case 'monster': content = renderMonsterDetail(key); break;
    case 'loot': content = key ? renderLootDetail(key) : renderLootList(params); break;
    case 'recipes': content = renderRecipes(params); break;
    case 'recipe': content = renderRecipeDetail(key); break;
    case 'sets': content = renderSets(); break;
    case 'buildings': content = renderBuildings(params); break;
    case 'modes': content = renderModes(); break;
    case 'mode': content = renderMode(key); break;
    case 'chapter': content = renderChapter(key, params); break;
    default: content = notFound('page', section);
  }

  view.replaceChildren(content);

  const TAB_OF = { item: 'items', monster: 'monsters', recipe: 'recipes', mode: 'modes', chapter: 'modes' };
  const active = TAB_OF[section] ?? section;
  document.querySelectorAll('#tabs a').forEach((a) => {
    if (a.getAttribute('href') === `#/${active}`) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });

  document.title = section ? `${titleFor(section, key)} — Pixel Chronicles Wiki` : 'Pixel Chronicles Wiki';
  closeSuggestions();
  if (!rest.length) window.scrollTo(0, 0);
}

function titleFor(section, key) {
  if (section === 'item') return IX.item.get(key)?.name ?? 'Item';
  if (section === 'monster') return IX.monster.get(key)?.name ?? 'Monster';
  if (section === 'recipe') return IX.recipe.get(key)?.outputName ?? 'Recipe';
  if (section === 'loot' && key) return IX.loot.get(key)?.sourceName ?? 'Loot table';
  if (section === 'mode') return IX.mode.get(key)?.name ?? 'Game mode';
  if (section === 'chapter') return IX.chapter.get(key)?.chapter.name ?? 'Chapter';
  return section.charAt(0).toUpperCase() + section.slice(1);
}

window.addEventListener('hashchange', route);

/* --------------------------------------------------------------------- boot */

async function boot() {
  const names = ['items', 'monsters', 'loot', 'recipes', 'sets', 'buildings', 'gamemodes', 'meta'];
  try {
    // The preview bundle inlines the payloads, so it can run from file:// where
    // fetch is blocked.
    const payloads = window.__WIKI_DATA__
      ? names.map((n) => {
        const payload = window.__WIKI_DATA__[n];
        if (payload === undefined) throw new Error(`the bundled preview has no "${n}" payload — rebuild it with wiki/tools/bundle.mjs`);
        return payload;
      })
      : await Promise.all(names.map(async (n) => {
        const res = await fetch(`data/${n}.json`, { cache: 'no-cache' });
        if (!res.ok) throw new Error(`data/${n}.json → HTTP ${res.status}`);
        return res.json();
      }));

    // Indexing lives inside the try as well: a payload that loads but is not what
    // the page expects used to throw here and leave "Loading game data…" on
    // screen forever, with the real error only in the console.
    install(payloads);
  } catch (err) {
    view.replaceChildren(el(`<div class="warn"><b>Could not load the wiki data.</b>
      <p style="margin:6px 0 0">${esc(err.message)}</p>
      <p style="margin:6px 0 0">Run <code>node wiki/tools/extract.mjs</code>, and serve this folder over HTTP
      (<code>npx serve wiki/site</code>) — opening index.html from the filesystem blocks fetch.</p></div>`));
    return;
  }

  route();
}

/** Populate DB and the lookup indexes from the loaded payloads. */
function install(payloads) {
  [DB.items, DB.monsters, DB.loot, DB.recipes, DB.sets, DB.buildings, DB.gamemodes, DB.meta] = payloads;

  for (const i of DB.items) IX.item.set(i.key, i);
  for (const m of DB.monsters) IX.monster.set(m.key, m);
  for (const t of DB.loot) IX.loot.set(t.id, t);
  for (const r of DB.recipes) IX.recipe.set(r.id, r);
  for (const s of DB.sets) IX.set.set(s.key, s);
  for (const b of DB.buildings) IX.building.set(b.key, b);
  for (const mode of DB.gamemodes) {
    IX.mode.set(mode.key, mode);
    for (const chapter of mode.chapters) IX.chapter.set(chapter.key, { chapter, mode });
  }

  injectRarityColors(DB.meta.rarityColors);

  const when = new Date(DB.meta.generatedAt);
  document.getElementById('footer-meta').textContent =
    `Data generated ${when.toISOString().slice(0, 10)}`;
}

/**
 * The palette is the game's, read out of the C# source by the extractor, so the
 * two stay in step. `r-*` is the item scale, `mr-*` the monster one.
 */
function injectRarityColors(colors) {
  if (!colors) return;
  const rules = [];
  for (const [rarity, hex] of Object.entries(colors.item ?? {})) rules.push(`.r-${cls(rarity)}{--rarity:${hex}}`);
  for (const [rarity, hex] of Object.entries(colors.monster ?? {})) rules.push(`.mr-${cls(rarity)}{--rarity:${hex}}`);
  const style = document.createElement('style');
  style.textContent = rules.join('');
  document.head.append(style);
}

boot();
