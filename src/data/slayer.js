// ── Slayer System (9.2) ───────────────────────────────────────────────────────
// Task assignments, masters, rewards, streaks

const masters = new Map();
const rewards = [];

function defineMaster(id, opts) {
  masters.set(id, {
    id, name: opts.name, combatReq: opts.combatReq || 1, slayerReq: opts.slayerReq || 1,
    tasks: opts.tasks || [], // [{ monster, weight, min, max, combatReq, slayerReq }]
  });
}

function assignTask(player, masterId, getLevel) {
  const master = masters.get(masterId);
  if (!master) return null;
  if (getLevel(player, 'slayer') < master.slayerReq) return null;

  // Filter eligible tasks
  const eligible = master.tasks.filter(t =>
    (!t.slayerReq || getLevel(player, 'slayer') >= t.slayerReq) &&
    (!t.combatReq || true) // simplified
  );
  if (!eligible.length) return null;

  // Check blocked list
  const blocked = player.slayerBlocked || [];
  const unblocked = eligible.filter(t => !blocked.includes(t.monster));
  const pool = unblocked.length ? unblocked : eligible;

  // Weighted random
  const totalWeight = pool.reduce((s, t) => s + t.weight, 0);
  let r = Math.random() * totalWeight;
  for (const t of pool) {
    r -= t.weight;
    if (r <= 0) {
      const count = t.min + Math.floor(Math.random() * (t.max - t.min + 1));
      return { monster: t.monster, count, remaining: count };
    }
  }
  return null;
}

function completeTask(player) {
  if (!player.slayerStreak) player.slayerStreak = 0;
  player.slayerStreak++;
  let points = 5; // base
  if (player.slayerStreak % 10 === 0) points = 25;
  if (player.slayerStreak % 50 === 0) points = 75;
  if (player.slayerStreak % 100 === 0) points = 150;
  if (player.slayerStreak % 250 === 0) points = 375;
  if (!player.slayerPoints) player.slayerPoints = 0;
  player.slayerPoints += points;
  player.slayerTask = null;
  return { points, totalPoints: player.slayerPoints, streak: player.slayerStreak };
}

// ── Define masters ────────────────────────────────────────────────────────────
defineMaster('turael', {
  name: 'Turael', combatReq: 3, slayerReq: 1,
  tasks: [
    { monster: 'chicken', weight: 6, min: 15, max: 50 },
    { monster: 'cow', weight: 6, min: 15, max: 50 },
    { monster: 'goblin', weight: 8, min: 15, max: 50 },
    { monster: 'spider', weight: 5, min: 15, max: 50 },
    { monster: 'rat', weight: 5, min: 15, max: 50 },
    { monster: 'zombie', weight: 4, min: 15, max: 50 },
    { monster: 'skeleton', weight: 4, min: 15, max: 50 },
  ],
});

defineMaster('vannaka', {
  name: 'Vannaka', combatReq: 40, slayerReq: 1,
  tasks: [
    { monster: 'hill giant', weight: 6, min: 30, max: 80 },
    { monster: 'lesser demon', weight: 4, min: 30, max: 80 },
    { monster: 'green dragon', weight: 3, min: 20, max: 60, combatReq: 50 },
    { monster: 'fire giant', weight: 5, min: 30, max: 80 },
    { monster: 'moss giant', weight: 5, min: 30, max: 80 },
    { monster: 'ice warrior', weight: 4, min: 30, max: 80 },
    { monster: 'blue dragon', weight: 3, min: 20, max: 60 },
    { monster: 'hellhound', weight: 3, min: 30, max: 80, slayerReq: 1 },
  ],
});

module.exports = { defineMaster, assignTask, completeTask, masters };
