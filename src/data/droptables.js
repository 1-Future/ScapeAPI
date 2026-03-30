// ── Drop Table System (9.1) ───────────────────────────────────────────────────
// Weighted drop tables with always/main/tertiary separation

const tables = new Map(); // monsterId → { always, main, tertiary }

function define(monsterId, opts) {
  tables.set(monsterId, {
    always: opts.always || [], // always dropped
    main: opts.main || [], // weighted main table
    tertiary: opts.tertiary || [], // rare independent rolls (pet, clue)
  });
}

function roll(monsterId) {
  const table = tables.get(monsterId);
  if (!table) return [];
  const drops = [];

  // Always drops
  for (const d of table.always) {
    const count = d.min + Math.floor(Math.random() * (d.max - d.min + 1));
    if (count > 0) drops.push({ id: d.id, name: d.name, count });
  }

  // Main table (weighted)
  if (table.main.length > 0) {
    const totalWeight = table.main.reduce((s, d) => s + d.weight, 0);
    let r = Math.random() * totalWeight;
    for (const d of table.main) {
      r -= d.weight;
      if (r <= 0) {
        if (d.id === 0) break; // "Nothing" drop
        const count = d.min + Math.floor(Math.random() * (d.max - d.min + 1));
        if (count > 0) drops.push({ id: d.id, name: d.name, count });
        break;
      }
    }
  }

  // Tertiary (independent rolls)
  for (const d of table.tertiary) {
    if (Math.random() < 1 / d.rate) {
      drops.push({ id: d.id, name: d.name, count: d.count || 1 });
    }
  }

  return drops;
}

// ── Define drop tables ────────────────────────────────────────────────────────

define('chicken', {
  always: [{ id: 100, name: 'Bones', min: 1, max: 1 }, { id: 104, name: 'Feather', min: 5, max: 15 }],
  main: [
    { id: 105, name: 'Raw chicken', weight: 10, min: 1, max: 1 },
  ],
});

define('cow', {
  always: [{ id: 100, name: 'Bones', min: 1, max: 1 }, { id: 102, name: 'Cowhide', min: 1, max: 1 }],
  main: [
    { id: 103, name: 'Raw beef', weight: 10, min: 1, max: 1 },
  ],
});

define('goblin', {
  always: [{ id: 100, name: 'Bones', min: 1, max: 1 }],
  main: [
    { id: 101, name: 'Coins', weight: 10, min: 1, max: 5 },
    { id: 270, name: 'Air rune', weight: 3, min: 1, max: 6 },
    { id: 274, name: 'Mind rune', weight: 3, min: 1, max: 4 },
    { id: 0, name: 'Nothing', weight: 5, min: 0, max: 0 },
  ],
  tertiary: [
    { id: 900, name: 'Clue scroll (beginner)', rate: 128, count: 1 },
  ],
});

define('guard', {
  always: [{ id: 100, name: 'Bones', min: 1, max: 1 }],
  main: [
    { id: 101, name: 'Coins', weight: 8, min: 15, max: 60 },
    { id: 212, name: 'Iron ore', weight: 2, min: 1, max: 1 },
    { id: 251, name: 'Iron bar', weight: 1, min: 1, max: 1 },
    { id: 0, name: 'Nothing', weight: 3, min: 0, max: 0 },
  ],
});

define('hill_giant', {
  always: [{ id: 106, name: 'Big bones', min: 1, max: 1 }],
  main: [
    { id: 101, name: 'Coins', weight: 6, min: 10, max: 80 },
    { id: 212, name: 'Iron ore', weight: 3, min: 1, max: 1 },
    { id: 279, name: 'Law rune', weight: 1, min: 1, max: 2 },
    { id: 278, name: 'Nature rune', weight: 2, min: 2, max: 6 },
    { id: 322, name: 'Limpwurt root', weight: 2, min: 1, max: 1 },
    { id: 0, name: 'Nothing', weight: 4, min: 0, max: 0 },
  ],
  tertiary: [
    { id: 901, name: 'Giant key', rate: 128, count: 1 },
  ],
});

define('lesser_demon', {
  always: [{ id: 100, name: 'Bones', min: 1, max: 1 }],
  main: [
    { id: 101, name: 'Coins', weight: 5, min: 30, max: 132 },
    { id: 273, name: 'Fire rune', weight: 3, min: 2, max: 12 },
    { id: 276, name: 'Chaos rune', weight: 2, min: 2, max: 6 },
    { id: 253, name: 'Gold bar', weight: 1, min: 1, max: 1 },
    { id: 254, name: 'Mithril bar', weight: 1, min: 1, max: 1 },
    { id: 430, name: 'Mithril scimitar', weight: 1, min: 1, max: 1 },
    { id: 0, name: 'Nothing', weight: 4, min: 0, max: 0 },
  ],
});

define('green_dragon', {
  always: [{ id: 107, name: 'Dragon bones', min: 1, max: 1 }],
  main: [
    { id: 101, name: 'Coins', weight: 4, min: 44, max: 220 },
    { id: 278, name: 'Nature rune', weight: 3, min: 3, max: 12 },
    { id: 255, name: 'Adamantite bar', weight: 1, min: 1, max: 1 },
    { id: 440, name: 'Adamant scimitar', weight: 1, min: 1, max: 1 },
    { id: 0, name: 'Nothing', weight: 3, min: 0, max: 0 },
  ],
});

module.exports = { define, roll, tables };
