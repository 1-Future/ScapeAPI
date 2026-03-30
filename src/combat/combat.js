// ── Combat System (Tier 5) ────────────────────────────────────────────────────
// OSRS-accurate: accuracy roll, max hit, attack speed, XP distribution

const player = require('../player/player');

// Attack styles and their XP distribution
const STYLES = {
  accurate:   { atk: 4, str: 0, def: 0, bonus: 'attack', invisible: 3 },
  aggressive: { atk: 0, str: 4, def: 0, bonus: 'strength', invisible: 3 },
  defensive:  { atk: 0, str: 0, def: 4, bonus: 'defence', invisible: 3 },
  controlled: { atk: 1.33, str: 1.33, def: 1.33, bonus: 'shared', invisible: 1 },
};

// Prayer multipliers { prayer_name: { attack, strength, defence } }
const PRAYER_BOOSTS = {
  clarity_of_thought:  { attack: 1.05 },
  improved_reflexes:   { attack: 1.10 },
  incredible_reflexes: { attack: 1.15 },
  mystic_will:         { attack: 1.05, defence: 1.05 },
  burst_of_strength:   { strength: 1.05 },
  superhuman_strength: { strength: 1.10 },
  ultimate_strength:   { strength: 1.15 },
  thick_skin:          { defence: 1.05 },
  rock_skin:           { defence: 1.10 },
  steel_skin:          { defence: 1.15 },
  chivalry:            { attack: 1.15, strength: 1.18, defence: 1.20 },
  piety:               { attack: 1.20, strength: 1.23, defence: 1.25 },
};

function getPrayerMultiplier(activePrayers, stat) {
  let mult = 1.0;
  for (const prayer of activePrayers) {
    const boost = PRAYER_BOOSTS[prayer];
    if (boost && boost[stat]) mult = Math.max(mult, boost[stat]);
  }
  return mult;
}

// Equipment bonus from equipment object { slot: { stats: { ... } } }
function getEquipBonus(equipment, stat) {
  let total = 0;
  for (const item of Object.values(equipment)) {
    if (item?.stats?.[stat]) total += item.stats[stat];
  }
  return total;
}

// Effective level = (base_level + style_bonus + 8) × prayer_mult
function effectiveLevel(p, skill) {
  const style = STYLES[p.attackStyle] || STYLES.accurate;
  const base = player.getLevel(p, skill);
  const styleBonus = style.bonus === skill || style.bonus === 'shared' ? style.invisible : 0;
  const prayerMult = getPrayerMultiplier(p.activePrayers, skill);
  return Math.floor((base + styleBonus + 8) * prayerMult);
}

// Max hit (melee) = floor(0.5 + effective_str × (str_bonus + 64) / 640)
function maxHitMelee(p) {
  const effStr = effectiveLevel(p, 'strength');
  const strBonus = getEquipBonus(p.equipment, 'melee_strength');
  return Math.floor(0.5 + effStr * (strBonus + 64) / 640);
}

// Attack roll = effective_attack × (equipment_bonus + 64)
function attackRoll(p, bonusType = 'slash') {
  const effAtk = effectiveLevel(p, 'attack');
  const equipBonus = getEquipBonus(p.equipment, bonusType);
  return effAtk * (equipBonus + 64);
}

// Defence roll for NPC
function npcDefenceRoll(npc, bonusType = 'slash') {
  const defLevel = npc.stats?.defence || 1;
  const defBonus = npc.stats?.[`def_${bonusType}`] || 0;
  return (defLevel + 9) * (defBonus + 64);
}

// Accuracy: if atk > def, acc = 1 - (def+2)/(2×(atk+1)); else acc = atk/(2×(def+1))
function accuracy(atkRoll, defRoll) {
  if (atkRoll > defRoll) {
    return 1 - (defRoll + 2) / (2 * (atkRoll + 1));
  } else {
    return atkRoll / (2 * (defRoll + 1));
  }
}

// Perform a melee attack
function meleeAttack(attacker, defender) {
  const atkRoll = attackRoll(attacker);
  const defRoll = typeof defender.stats !== 'undefined'
    ? npcDefenceRoll(defender)
    : attackRoll(defender); // PvP: use defender's defence roll

  const hitChance = accuracy(atkRoll, defRoll);
  const hit = Math.random() < hitChance;
  const maxDmg = maxHitMelee(attacker);
  const damage = hit ? Math.floor(Math.random() * (maxDmg + 1)) : 0;

  return { hit, damage, maxHit: maxDmg, accuracy: hitChance };
}

// XP from combat damage
function combatXp(p, damage) {
  const style = STYLES[p.attackStyle] || STYLES.accurate;
  const results = {};
  if (style.atk > 0) {
    const xp = damage * style.atk;
    const lvl = player.addXp(p, 'attack', xp);
    results.attack = xp;
    if (lvl) results.levelUp = { skill: 'attack', level: lvl };
  }
  if (style.str > 0) {
    const xp = damage * style.str;
    const lvl = player.addXp(p, 'strength', xp);
    results.strength = xp;
    if (lvl) results.levelUp = { skill: 'strength', level: lvl };
  }
  if (style.def > 0) {
    const xp = damage * style.def;
    const lvl = player.addXp(p, 'defence', xp);
    results.defence = xp;
    if (lvl) results.levelUp = { skill: 'defence', level: lvl };
  }
  // Always get 1.33 HP XP per damage
  const hpXp = damage * 1.33;
  const hpLvl = player.addXp(p, 'hitpoints', hpXp);
  results.hitpoints = hpXp;
  if (hpLvl) results.hpLevelUp = { skill: 'hitpoints', level: hpLvl };
  return results;
}

// Attack speed (ticks between attacks). Default unarmed = 4
function getAttackSpeed(p) {
  const weapon = p.equipment.weapon;
  return weapon?.speed || 4;
}

module.exports = {
  STYLES, meleeAttack, combatXp, maxHitMelee,
  attackRoll, npcDefenceRoll, accuracy,
  effectiveLevel, getEquipBonus, getAttackSpeed, getPrayerMultiplier,
};
