// ── Player (0.3) + Inventory (3.6) + Equipment (3.8) + Skills (4.1-4.3) ──────
// Everything about a connected player

const SPAWN_X = 100, SPAWN_Y = 100;
const INV_SIZE = 28;
const BANK_SIZE = 816;

// OSRS XP table: XP needed for level L
function xpForLevel(level) {
  let total = 0;
  for (let i = 1; i < level; i++) {
    total += Math.floor(i + 300 * Math.pow(2, i / 7));
  }
  return Math.floor(total / 4);
}

// Build XP table once
const XP_TABLE = [0];
for (let i = 1; i <= 126; i++) XP_TABLE[i] = xpForLevel(i);

function levelForXp(xp) {
  for (let i = 1; i < XP_TABLE.length; i++) {
    if (xp < XP_TABLE[i]) return i - 1;
  }
  return 99;
}

const SKILLS = [
  'attack', 'strength', 'defence', 'hitpoints', 'ranged', 'prayer', 'magic',
  'runecrafting', 'construction', 'agility', 'herblore', 'thieving',
  'crafting', 'fletching', 'slayer', 'hunter', 'mining', 'smithing',
  'fishing', 'cooking', 'firemaking', 'woodcutting', 'farming',
];

const COMBAT_SKILLS = ['attack', 'strength', 'defence', 'hitpoints', 'ranged', 'prayer', 'magic'];

const EQUIP_SLOTS = ['head', 'cape', 'neck', 'ammo', 'weapon', 'shield', 'body', 'legs', 'hands', 'feet', 'ring'];

function createPlayer(id, name) {
  const skills = {};
  for (const s of SKILLS) {
    skills[s] = { xp: 0, level: 1 };
  }
  skills.hitpoints = { xp: xpForLevel(10), level: 10 }; // Start at 10 HP

  return {
    id,
    name,
    admin: false,
    x: SPAWN_X,
    y: SPAWN_Y,
    layer: 0,
    path: [],
    running: false,
    runEnergy: 10000, // 100.0%
    weight: 0,

    // Combat
    hp: 10,
    maxHp: 10,
    combatTarget: null,
    attackStyle: 'accurate', // accurate, aggressive, defensive, controlled
    autoRetaliate: true,
    specialEnergy: 1000, // 100%
    nextAttackTick: 0,
    skull: 0, // ticks remaining
    activePrayers: new Set(),
    prayerPoints: 1, // = prayer level

    // Skills
    skills,

    // Inventory (array of {id, name, count} or null for empty slot)
    inventory: new Array(INV_SIZE).fill(null),

    // Bank
    bank: [],

    // Equipment
    equipment: {},

    // State
    busy: false, // doing an action (fishing, cooking, etc.)
    busyAction: null,
    connected: true,
    loginTick: 0,
  };
}

function combatLevel(p) {
  const base = 0.25 * (getLevel(p, 'defence') + getLevel(p, 'hitpoints') + Math.floor(getLevel(p, 'prayer') / 2));
  const melee = 0.325 * (getLevel(p, 'attack') + getLevel(p, 'strength'));
  const ranged = 0.325 * Math.floor(getLevel(p, 'ranged') * 1.5);
  const magic = 0.325 * Math.floor(getLevel(p, 'magic') * 1.5);
  return Math.floor(base + Math.max(melee, ranged, magic));
}

function getLevel(p, skill) {
  return p.skills[skill]?.level || 1;
}

function getXp(p, skill) {
  return p.skills[skill]?.xp || 0;
}

function addXp(p, skill, amount) {
  if (!p.skills[skill]) return;
  const before = p.skills[skill].level;
  p.skills[skill].xp = Math.min(200000000, p.skills[skill].xp + Math.floor(amount));
  p.skills[skill].level = levelForXp(p.skills[skill].xp);
  if (skill === 'hitpoints') {
    p.maxHp = p.skills.hitpoints.level;
    p.hp = Math.min(p.hp, p.maxHp);
  }
  if (skill === 'prayer') {
    p.prayerPoints = p.skills.prayer.level;
  }
  const after = p.skills[skill].level;
  return after > before ? after : null; // Returns new level if leveled up
}

function totalLevel(p) {
  let total = 0;
  for (const s of SKILLS) total += getLevel(p, s);
  return total;
}

// Inventory operations
function invAdd(p, itemId, name, count = 1, stackable = false) {
  if (stackable) {
    // Find existing stack
    const idx = p.inventory.findIndex(s => s && s.id === itemId);
    if (idx >= 0) { p.inventory[idx].count += count; return true; }
  }
  // Find empty slot
  for (let i = 0; i < INV_SIZE; i++) {
    if (!p.inventory[i]) {
      p.inventory[i] = { id: itemId, name, count: stackable ? count : 1 };
      if (!stackable && count > 1) {
        // Add remaining to next slots
        for (let j = 1; j < count; j++) {
          const slot = p.inventory.findIndex(s => s === null);
          if (slot < 0) return false; // Inv full
          p.inventory[slot] = { id: itemId, name, count: 1 };
        }
      }
      return true;
    }
  }
  return false; // Full
}

function invRemove(p, itemId, count = 1) {
  let removed = 0;
  for (let i = 0; i < INV_SIZE && removed < count; i++) {
    if (p.inventory[i] && p.inventory[i].id === itemId) {
      if (p.inventory[i].count <= (count - removed)) {
        removed += p.inventory[i].count;
        p.inventory[i] = null;
      } else {
        p.inventory[i].count -= (count - removed);
        removed = count;
      }
    }
  }
  return removed;
}

function invCount(p, itemId) {
  let total = 0;
  for (const slot of p.inventory) {
    if (slot && slot.id === itemId) total += slot.count;
  }
  return total;
}

function invFreeSlots(p) {
  return p.inventory.filter(s => s === null).length;
}

// Equipment
function equip(p, slot, item) {
  const old = p.equipment[slot] || null;
  p.equipment[slot] = item;
  if (old) invAdd(p, old.id, old.name, 1);
  return old;
}

function unequip(p, slot) {
  const item = p.equipment[slot];
  if (!item) return null;
  if (invFreeSlots(p) < 1) return null; // No room
  delete p.equipment[slot];
  invAdd(p, item.id, item.name, 1);
  return item;
}

module.exports = {
  createPlayer, combatLevel,
  getLevel, getXp, addXp, totalLevel,
  invAdd, invRemove, invCount, invFreeSlots,
  equip, unequip,
  SKILLS, COMBAT_SKILLS, EQUIP_SLOTS, INV_SIZE, BANK_SIZE,
  SPAWN_X, SPAWN_Y,
  XP_TABLE, xpForLevel, levelForXp,
};
