// ── OpenScapeAPI Server ───────────────────────────────────────────────────────
// Command-based game engine. The game is the API.

const WebSocket = require('ws');
const http = require('http');

// Engine
const tick = require('./engine/tick');
const events = require('./engine/events');
const commands = require('./engine/commands');
const persistence = require('./engine/persistence');
const plugins = require('./engine/plugins');

// World
const tiles = require('./world/tiles');
const walls = require('./world/walls');
const pathfinding = require('./world/pathfinding');
const npcs = require('./world/npcs');
const objects = require('./world/objects');

// Player
const { createPlayer, combatLevel, getLevel, getXp, addXp, totalLevel,
  invAdd, invRemove, invCount, invFreeSlots, SKILLS, EQUIP_SLOTS,
  SPAWN_X, SPAWN_Y, INV_SIZE, xpForLevel, levelForXp } = require('./player/player');

// Combat
const combat = require('./combat/combat');

// ── State ─────────────────────────────────────────────────────────────────────
const PORT = 2223;
const players = new Map(); // ws → player
const playersByName = new Map(); // name → player
const groundItems = []; // [{ id, name, x, y, layer, count, owner, despawnTick }]
let nextItemId = 1;

// ── Helper ────────────────────────────────────────────────────────────────────
function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function sendText(ws, text) { send(ws, { t: 'msg', text }); }

function broadcast(msg) {
  for (const [ws] of players) send(ws, msg);
}

function findPlayer(name) {
  return playersByName.get(name.toLowerCase());
}

// ── Movement Tick ─────────────────────────────────────────────────────────────
function movementTick(currentTick) {
  for (const [ws, p] of players) {
    if (p.path.length === 0) continue;

    // Walk 1 tile
    const step = p.path.shift();
    p.x = step.x;
    p.y = step.y;

    // If running and path still has steps, take a second step
    if (p.running && p.path.length > 0 && p.runEnergy > 0) {
      const step2 = p.path.shift();
      p.x = step2.x;
      p.y = step2.y;
      // Drain energy: 67 + (67 × weight/64)
      const drain = Math.floor(67 + (67 * Math.max(0, p.weight) / 64));
      p.runEnergy = Math.max(0, p.runEnergy - drain);
      if (p.runEnergy <= 0) {
        p.running = false;
        sendText(ws, "You're out of run energy.");
      }
    }

    events.emit('player_move', { player: p, ws });
  }

  // Regen run energy for stationary players
  for (const [ws, p] of players) {
    if (p.path.length === 0 && p.runEnergy < 10000) {
      const agilityLevel = getLevel(p, 'agility');
      const regen = Math.floor(agilityLevel * 0.45) + 8;
      p.runEnergy = Math.min(10000, p.runEnergy + regen);
    }
  }
}

// ── Combat Tick ───────────────────────────────────────────────────────────────
function combatTick(currentTick) {
  for (const [ws, p] of players) {
    if (!p.combatTarget) continue;
    const npc = npcs.getNpc(p.combatTarget);
    if (!npc || npc.dead) { p.combatTarget = null; p.busy = false; continue; }

    // Check range (must be adjacent)
    const dist = Math.abs(p.x - npc.x) + Math.abs(p.y - npc.y);
    if (dist > 1) {
      // Path to target
      const path = pathfinding.findPath(p.x, p.y, npc.x, npc.y, p.layer);
      if (path && path.length > 1) p.path = path.slice(0, -1); // Walk to adjacent
      continue;
    }

    // Attack on cooldown
    if (currentTick < p.nextAttackTick) continue;
    p.nextAttackTick = currentTick + combat.getAttackSpeed(p);

    const result = combat.meleeAttack(p, npc);
    npc.hp = Math.max(0, npc.hp - result.damage);

    let msg = result.hit
      ? `You hit the ${npc.name} for ${result.damage} damage.`
      : `You miss the ${npc.name}.`;

    if (npc.hp <= 0) {
      npc.dead = true;
      npc.respawnAt = currentTick + npc.respawnTicks;
      p.combatTarget = null;
      p.busy = false;
      msg += ` The ${npc.name} is dead!`;

      // Drop loot
      const drops = npcs.rollDrops(npc);
      for (const drop of drops) {
        groundItems.push({ id: nextItemId++, ...drop, x: npc.x, y: npc.y, layer: npc.layer, owner: p.id, despawnTick: currentTick + 200 });
        msg += `\n  Loot: ${drop.name} x${drop.count}`;
      }

      // Combat XP
      const xpResult = combat.combatXp(p, result.damage);
      if (xpResult.levelUp) msg += `\n  Level up! ${xpResult.levelUp.skill} → ${xpResult.levelUp.level}`;
      if (xpResult.hpLevelUp) msg += `\n  Level up! hitpoints → ${xpResult.hpLevelUp.level}`;
    } else {
      // Combat XP even on non-kill hits
      combat.combatXp(p, result.damage);
    }

    sendText(ws, msg);

    // NPC retaliates
    if (!npc.dead && npc.combat > 0) {
      npc.target = p.id;
      if (currentTick >= npc.nextAttackTick) {
        npc.nextAttackTick = currentTick + npc.attackSpeed;
        const npcHit = Math.random() < 0.5;
        const npcDmg = npcHit ? Math.floor(Math.random() * (npc.maxHit + 1)) : 0;
        p.hp = Math.max(0, p.hp - npcDmg);
        if (npcDmg > 0) sendText(ws, `The ${npc.name} hits you for ${npcDmg} damage. HP: ${p.hp}/${p.maxHp}`);
        if (p.hp <= 0) {
          sendText(ws, 'Oh dear, you are dead!');
          p.hp = p.maxHp;
          p.x = SPAWN_X; p.y = SPAWN_Y;
          p.combatTarget = null; p.busy = false; p.path = [];
          events.emit('player_death', { player: p, ws, killer: npc });
        }
      }
    }
  }
}

// ── World Tick ────────────────────────────────────────────────────────────────
function worldTick(currentTick) {
  npcs.npcTick(currentTick);
  objects.objectTick(currentTick);

  // Despawn ground items
  for (let i = groundItems.length - 1; i >= 0; i--) {
    if (currentTick >= groundItems[i].despawnTick) groundItems.splice(i, 1);
  }

  // HP regen every 100 ticks (60 seconds)
  if (currentTick % 100 === 0) {
    for (const [ws, p] of players) {
      if (p.hp < p.maxHp && !p.combatTarget) {
        p.hp = Math.min(p.maxHp, p.hp + 1);
      }
    }
  }

  // Prayer drain
  for (const [ws, p] of players) {
    if (p.activePrayers.size > 0 && currentTick % 3 === 0) {
      p.prayerPoints = Math.max(0, p.prayerPoints - p.activePrayers.size);
      if (p.prayerPoints <= 0) {
        p.activePrayers.clear();
        sendText(ws, 'You have run out of prayer points.');
      }
    }
  }
}

// ── Register Commands ─────────────────────────────────────────────────────────

// General
commands.register('help', {
  help: 'Show commands',
  aliases: ['?', 'commands'],
  category: 'General',
  fn: (p, args) => {
    if (args[0]) {
      const lines = commands.getHelp(args[0]);
      return lines.length ? `${args[0]}:\n${lines.join('\n')}` : 'No commands in that category.';
    }
    const cats = commands.getCategories();
    let out = 'Categories: ' + cats.join(', ') + '\nType `help [category]` for details.\n\n';
    for (const cat of cats) {
      const lines = commands.getHelp(cat);
      out += `── ${cat} ──\n${lines.join('\n')}\n\n`;
    }
    return out;
  }
});

commands.register('tick', { help: 'Show current tick', category: 'General', fn: () => `Tick: ${tick.getTick()}` });
commands.register('whoami', { help: 'Show your info', category: 'General', fn: (p) => `${p.name} | Combat: ${combatLevel(p)} | Pos: (${p.x}, ${p.y}) | Layer: ${p.layer} | HP: ${p.hp}/${p.maxHp}` });
commands.register('players', { help: 'List online players', category: 'General', fn: () => {
  const list = [...playersByName.values()].map(p => `  ${p.name} (combat ${combatLevel(p)}) at (${p.x}, ${p.y})`);
  return `Online: ${list.length}\n${list.join('\n')}`;
}});

// Navigation
commands.register('pos', { help: 'Show position', aliases: ['coords', 'where'], category: 'Navigation',
  fn: (p) => {
    const area = tiles.getArea(p.x, p.y, p.layer);
    return `Position: (${p.x}, ${p.y}) Layer: ${p.layer}${area ? ` — ${area.name}` : ''}`;
  }
});

commands.register('look', { help: 'Look around', aliases: ['l'], category: 'Navigation',
  fn: (p) => {
    const tile = tiles.getTileName(tiles.tileAt(p.x, p.y, p.layer));
    const area = tiles.getArea(p.x, p.y, p.layer);
    const nearby = npcs.getNpcsNear(p.x, p.y, 5, p.layer);
    const objs = objects.getObjectsNear(p.x, p.y, 3, p.layer);
    const items = groundItems.filter(i => Math.abs(i.x - p.x) <= 3 && Math.abs(i.y - p.y) <= 3 && i.layer === p.layer);
    const nearbyPlayers = [...playersByName.values()].filter(o => o !== p && Math.abs(o.x - p.x) <= 10 && Math.abs(o.y - p.y) <= 10 && o.layer === p.layer);

    let out = `You are at (${p.x}, ${p.y}). Ground: ${tile}.`;
    if (area) out += ` Area: ${area.name}.`;
    // Walls
    const w = walls.getWallEdge(p.x, p.y, p.layer);
    if (w) {
      const sides = [];
      if (w & 1) sides.push('north');
      if (w & 2) sides.push('east');
      if (w & 4) sides.push('south');
      if (w & 8) sides.push('west');
      out += `\nWalls: ${sides.join(', ')}`;
    }
    // Doors
    const d = walls.getDoorEdge(p.x, p.y, p.layer);
    if (d) {
      const sides = [];
      if (d & 1) sides.push('north' + (walls.isDoorOpen(p.x, p.y, 1, p.layer) ? ' (open)' : ' (closed)'));
      if (d & 2) sides.push('east' + (walls.isDoorOpen(p.x, p.y, 2, p.layer) ? ' (open)' : ' (closed)'));
      if (d & 4) sides.push('south' + (walls.isDoorOpen(p.x, p.y, 4, p.layer) ? ' (open)' : ' (closed)'));
      if (d & 8) sides.push('west' + (walls.isDoorOpen(p.x, p.y, 8, p.layer) ? ' (open)' : ' (closed)'));
      out += `\nDoors: ${sides.join(', ')}`;
    }
    if (nearby.length) out += '\nNPCs: ' + nearby.map(n => `${n.name} (lvl ${n.combat}, HP ${n.hp}/${n.maxHp})`).join(', ');
    if (objs.length) out += '\nObjects: ' + objs.filter(o => !o.depleted).map(o => o.name).join(', ');
    if (items.length) out += '\nItems: ' + items.map(i => `${i.name} x${i.count}`).join(', ');
    if (nearbyPlayers.length) out += '\nPlayers: ' + nearbyPlayers.map(o => o.name).join(', ');
    return out;
  }
});

// Direction shortcuts
const DIR_MAP = { n: [0,-1], s: [0,1], e: [1,0], w: [-1,0], ne: [1,-1], nw: [-1,-1], se: [1,1], sw: [-1,1] };
for (const [dir, [dx, dy]] of Object.entries(DIR_MAP)) {
  commands.register(dir, { help: `Walk ${dir}`, category: 'Navigation',
    fn: (p) => {
      const nx = p.x + dx, ny = p.y + dy;
      if (!tiles.isWalkable(nx, ny, p.layer)) return `Blocked — ${tiles.getTileName(tiles.tileAt(nx, ny, p.layer))} is not walkable.`;
      if (walls.isEdgeBlocked(p.x, p.y, nx, ny, p.layer)) return 'Blocked — there\'s a wall in the way.';
      p.x = nx; p.y = ny;
      events.emit('player_move', { player: p });
      const tile = tiles.getTileName(tiles.tileAt(p.x, p.y, p.layer));
      return `Moved ${dir} to (${p.x}, ${p.y}). Ground: ${tile}.`;
    }
  });
}

commands.register('goto', { help: 'Walk to coordinates: goto [x] [y]', aliases: ['walk', 'moveto'], category: 'Navigation',
  fn: (p, args) => {
    const x = parseInt(args[0]), y = parseInt(args[1]);
    if (isNaN(x) || isNaN(y)) return 'Usage: goto [x] [y]';
    const path = pathfinding.findPath(p.x, p.y, x, y, p.layer);
    if (!path) return `No path to (${x}, ${y}).`;
    p.path = path;
    return `Walking to (${x}, ${y}) — ${path.length} tiles.`;
  }
});

commands.register('run', { help: 'Toggle run / run to coords', aliases: ['toggle_run'], category: 'Navigation',
  fn: (p, args) => {
    if (args.length >= 2) {
      const x = parseInt(args[0]), y = parseInt(args[1]);
      if (!isNaN(x) && !isNaN(y)) {
        const path = pathfinding.findPath(p.x, p.y, x, y, p.layer);
        if (!path) return `No path to (${x}, ${y}).`;
        p.path = path;
        p.running = true;
        return `Running to (${x}, ${y}) — ${path.length} tiles. Energy: ${(p.runEnergy / 100).toFixed(0)}%`;
      }
    }
    p.running = !p.running;
    return `Running: ${p.running ? 'ON' : 'OFF'}. Energy: ${(p.runEnergy / 100).toFixed(0)}%`;
  }
});

commands.register('energy', { help: 'Show run energy', category: 'Navigation',
  fn: (p) => `Run energy: ${(p.runEnergy / 100).toFixed(0)}%`
});

commands.register('teleport', { help: 'Teleport to coords: teleport [x] [y]', aliases: ['tp'], category: 'Navigation',
  fn: (p, args) => {
    const x = parseInt(args[0]), y = parseInt(args[1]);
    if (isNaN(x) || isNaN(y)) return 'Usage: teleport [x] [y]';
    p.x = x; p.y = y; p.path = [];
    return `Teleported to (${x}, ${y}).`;
  }
});

commands.register('layer', { help: 'Show/change layer', category: 'Navigation',
  fn: (p, args) => {
    if (args[0] !== undefined) {
      p.layer = parseInt(args[0]) || 0;
      return `Layer: ${p.layer}`;
    }
    return `Layer: ${p.layer}`;
  }
});

// Doors
commands.register('open', { help: 'Open a door: open [n/e/s/w]', category: 'Navigation',
  fn: (p, args) => {
    const dir = (args[0] || '').toLowerCase();
    const edge = { n: 1, e: 2, s: 4, w: 8 }[dir];
    if (!edge) return 'Usage: open [n/e/s/w]';
    if (!(walls.getDoorEdge(p.x, p.y, p.layer) & edge)) return 'No door there.';
    if (walls.isDoorOpen(p.x, p.y, edge, p.layer)) return 'Already open.';
    walls.toggleDoor(p.x, p.y, edge, p.layer);
    return `Opened ${dir} door.`;
  }
});

commands.register('close', { help: 'Close a door: close [n/e/s/w]', category: 'Navigation',
  fn: (p, args) => {
    const dir = (args[0] || '').toLowerCase();
    const edge = { n: 1, e: 2, s: 4, w: 8 }[dir];
    if (!edge) return 'Usage: close [n/e/s/w]';
    if (!(walls.getDoorEdge(p.x, p.y, p.layer) & edge)) return 'No door there.';
    if (!walls.isDoorOpen(p.x, p.y, edge, p.layer)) return 'Already closed.';
    walls.toggleDoor(p.x, p.y, edge, p.layer);
    return `Closed ${dir} door.`;
  }
});

// Combat
commands.register('attack', { help: 'Attack an NPC: attack [name]', aliases: ['fight', 'kill'], category: 'Combat',
  fn: (p, args) => {
    const name = args.join(' ');
    if (!name) return 'Usage: attack [npc name]';
    const npc = npcs.findNpcByName(name, p.x, p.y, 15, p.layer);
    if (!npc) return `No "${name}" nearby.`;
    if (npc.combat === 0) return `You can't attack the ${npc.name}.`;
    p.combatTarget = npc.id;
    p.busy = true;
    return `Attacking ${npc.name} (lvl ${npc.combat}, HP ${npc.hp}/${npc.maxHp}).`;
  }
});

commands.register('flee', { help: 'Stop fighting', aliases: ['retreat', 'stop'], category: 'Combat',
  fn: (p) => { p.combatTarget = null; p.busy = false; p.path = []; return 'You stop fighting.'; }
});

commands.register('style', { help: 'Set attack style: style [accurate/aggressive/defensive/controlled]', category: 'Combat',
  fn: (p, args) => {
    if (!args[0]) return `Attack style: ${p.attackStyle}`;
    const style = args[0].toLowerCase();
    if (!combat.STYLES[style]) return 'Styles: accurate, aggressive, defensive, controlled';
    p.attackStyle = style;
    return `Attack style: ${style}`;
  }
});

commands.register('hp', { help: 'Show HP', category: 'Combat',
  fn: (p) => `HP: ${p.hp}/${p.maxHp}`
});

commands.register('combat', { help: 'Show combat level', category: 'Combat',
  fn: (p) => `Combat level: ${combatLevel(p)}` });

commands.register('maxhit', { help: 'Show max hit', category: 'Combat',
  fn: (p) => `Max hit: ${combat.maxHitMelee(p)}` });

commands.register('retaliate', { help: 'Toggle auto-retaliate', category: 'Combat',
  fn: (p) => { p.autoRetaliate = !p.autoRetaliate; return `Auto-retaliate: ${p.autoRetaliate ? 'ON' : 'OFF'}`; }
});

commands.register('pray', { help: 'Toggle prayer: pray [name] or pray off', category: 'Combat',
  fn: (p, args) => {
    if (!args[0] || args[0] === 'off') { p.activePrayers.clear(); return 'All prayers off.'; }
    const name = args.join('_').toLowerCase();
    if (p.activePrayers.has(name)) { p.activePrayers.delete(name); return `${name} off.`; }
    p.activePrayers.add(name);
    return `${name} on. Prayer points: ${p.prayerPoints}`;
  }
});

// Skills
commands.register('skills', { help: 'Show all skills', aliases: ['stats'], category: 'Skills',
  fn: (p) => {
    let out = `Total level: ${totalLevel(p)} | Combat: ${combatLevel(p)}\n`;
    for (const skill of SKILLS) {
      const lvl = getLevel(p, skill);
      const xp = getXp(p, skill);
      const next = xpForLevel(lvl + 1);
      out += `  ${skill.padEnd(14)} ${String(lvl).padStart(3)} | ${xp.toLocaleString()} XP${lvl < 99 ? ` (${(next - xp).toLocaleString()} to ${lvl + 1})` : ''}\n`;
    }
    return out;
  }
});

commands.register('skill', { help: 'Show specific skill: skill [name]', category: 'Skills',
  fn: (p, args) => {
    const name = (args[0] || '').toLowerCase();
    if (!p.skills[name]) return `Unknown skill: ${name}. Skills: ${SKILLS.join(', ')}`;
    const lvl = getLevel(p, name);
    const xp = getXp(p, name);
    const next = xpForLevel(lvl + 1);
    return `${name}: Level ${lvl} | ${xp.toLocaleString()} XP${lvl < 99 ? ` | ${(next - xp).toLocaleString()} to level ${lvl + 1}` : ' (MAX)'}`;
  }
});

// Inventory
commands.register('inventory', { help: 'Show inventory', aliases: ['inv', 'i'], category: 'Items',
  fn: (p) => {
    const items = p.inventory.filter(s => s !== null);
    if (!items.length) return 'Inventory is empty.';
    let out = `Inventory (${items.length}/${INV_SIZE}):\n`;
    for (let i = 0; i < INV_SIZE; i++) {
      const s = p.inventory[i];
      if (s) out += `  [${i}] ${s.name}${s.count > 1 ? ` x${s.count}` : ''}\n`;
    }
    return out;
  }
});

commands.register('pickup', { help: 'Pick up an item: pickup [name]', aliases: ['take', 'get'], category: 'Items',
  fn: (p, args) => {
    const name = args.join(' ').toLowerCase();
    if (!name) return 'Usage: pickup [item name]';
    const idx = groundItems.findIndex(i =>
      i.name.toLowerCase() === name && i.x === p.x && i.y === p.y && i.layer === p.layer
    );
    if (idx < 0) return `No "${name}" here.`;
    if (invFreeSlots(p) < 1) return 'Inventory is full.';
    const item = groundItems.splice(idx, 1)[0];
    invAdd(p, item.id, item.name, item.count);
    return `Picked up: ${item.name} x${item.count}`;
  }
});

commands.register('drop', { help: 'Drop an item: drop [name]', category: 'Items',
  fn: (p, args) => {
    const name = args.join(' ').toLowerCase();
    const slot = p.inventory.findIndex(s => s && s.name.toLowerCase() === name);
    if (slot < 0) return `You don't have "${name}".`;
    const item = p.inventory[slot];
    p.inventory[slot] = null;
    groundItems.push({ id: nextItemId++, name: item.name, count: item.count, x: p.x, y: p.y, layer: p.layer, owner: p.id, despawnTick: tick.getTick() + 200 });
    return `Dropped: ${item.name} x${item.count}`;
  }
});

commands.register('equip', { help: 'Equip an item: equip [name]', aliases: ['wear', 'wield'], category: 'Items',
  fn: (p, args) => {
    const name = args.join(' ').toLowerCase();
    const slot = p.inventory.findIndex(s => s && s.name.toLowerCase() === name);
    if (slot < 0) return `You don't have "${name}".`;
    const item = p.inventory[slot];
    if (!item.slot) return `${item.name} is not equippable.`;
    p.inventory[slot] = null;
    const old = p.equipment[item.slot];
    p.equipment[item.slot] = item;
    if (old) { invAdd(p, old.id, old.name, 1); return `Equipped ${item.name} (replaced ${old.name}).`; }
    return `Equipped ${item.name}.`;
  }
});

commands.register('unequip', { help: 'Unequip a slot: unequip [slot]', aliases: ['remove'], category: 'Items',
  fn: (p, args) => {
    const slot = (args[0] || '').toLowerCase();
    if (!p.equipment[slot]) return `Nothing equipped in ${slot}. Slots: ${EQUIP_SLOTS.join(', ')}`;
    if (invFreeSlots(p) < 1) return 'Inventory is full.';
    const item = p.equipment[slot];
    delete p.equipment[slot];
    invAdd(p, item.id, item.name, 1);
    return `Unequipped ${item.name}.`;
  }
});

commands.register('equipment', { help: 'Show equipment', aliases: ['gear'], category: 'Items',
  fn: (p) => {
    let out = 'Equipment:\n';
    for (const slot of EQUIP_SLOTS) {
      const item = p.equipment[slot];
      out += `  ${slot.padEnd(8)} ${item ? item.name : '—'}\n`;
    }
    return out;
  }
});

// NPCs
commands.register('npcs', { help: 'List nearby NPCs', category: 'World',
  fn: (p) => {
    const nearby = npcs.getNpcsNear(p.x, p.y, 15, p.layer);
    if (!nearby.length) return 'No NPCs nearby.';
    return 'NPCs:\n' + nearby.map(n => `  ${n.name} (lvl ${n.combat}) at (${n.x}, ${n.y}) HP: ${n.hp}/${n.maxHp}`).join('\n');
  }
});

commands.register('talk', { help: 'Talk to an NPC: talk [name]', category: 'World',
  fn: (p, args) => {
    const name = args.join(' ');
    const npc = npcs.findNpcByName(name, p.x, p.y, 5, p.layer);
    if (!npc) return `No "${name}" nearby.`;
    if (!npc.dialogue) return `The ${npc.name} has nothing to say.`;
    return `${npc.name}: "${npc.dialogue}"`;
  }
});

commands.register('examine', { help: 'Examine something: examine [target]', aliases: ['inspect'], category: 'World',
  fn: (p, args) => {
    const name = args.join(' ').toLowerCase();
    if (!name) return 'Usage: examine [target]';
    const npc = npcs.findNpcByName(name, p.x, p.y, 15, p.layer);
    if (npc) return `${npc.name}: ${npc.examine} (Combat: ${npc.combat})`;
    const obj = objects.findObjectByName(name, p.x, p.y, 15, p.layer);
    if (obj) return `${obj.name}: ${obj.examine}`;
    return `Nothing called "${name}" nearby.`;
  }
});

// Gathering
commands.register('chop', { help: 'Chop a tree', category: 'Gathering',
  fn: (p, args) => {
    const name = args.join(' ') || 'tree';
    const obj = objects.findObjectByName(name, p.x, p.y, 3, p.layer);
    if (!obj) return `No "${name}" nearby.`;
    if (obj.skill !== 'woodcutting') return `You can't chop the ${obj.name}.`;
    if (getLevel(p, 'woodcutting') < obj.levelReq) return `You need Woodcutting level ${obj.levelReq}.`;
    if (obj.depleted) return `The ${obj.name} is depleted.`;
    // Instant attempt for text game
    if (Math.random() < 0.7) {
      if (obj.product) invAdd(p, obj.product.id, obj.product.name, obj.product.count || 1);
      const lvl = addXp(p, 'woodcutting', obj.xp);
      if (Math.random() < obj.depletionChance) { obj.depleted = true; obj.respawnAt = tick.getTick() + obj.respawnTicks; }
      let msg = `You chop the ${obj.name}. +${obj.xp} WC XP.`;
      if (obj.product) msg += ` Got: ${obj.product.name}.`;
      if (lvl) msg += ` Woodcutting level: ${lvl}!`;
      return msg;
    }
    return `You swing your axe at the ${obj.name}...`;
  }
});

commands.register('mine', { help: 'Mine a rock', category: 'Gathering',
  fn: (p, args) => {
    const name = args.join(' ') || 'rock';
    const obj = objects.findObjectByName(name, p.x, p.y, 3, p.layer);
    if (!obj) return `No "${name}" nearby.`;
    if (obj.skill !== 'mining') return `You can't mine the ${obj.name}.`;
    if (getLevel(p, 'mining') < obj.levelReq) return `You need Mining level ${obj.levelReq}.`;
    if (obj.depleted) return `The ${obj.name} is depleted.`;
    if (Math.random() < 0.7) {
      if (obj.product) invAdd(p, obj.product.id, obj.product.name, obj.product.count || 1);
      const lvl = addXp(p, 'mining', obj.xp);
      if (Math.random() < obj.depletionChance) { obj.depleted = true; obj.respawnAt = tick.getTick() + obj.respawnTicks; }
      let msg = `You mine the ${obj.name}. +${obj.xp} Mining XP.`;
      if (obj.product) msg += ` Got: ${obj.product.name}.`;
      if (lvl) msg += ` Mining level: ${lvl}!`;
      return msg;
    }
    return `You swing your pickaxe at the ${obj.name}...`;
  }
});

commands.register('fish', { help: 'Fish at a spot', category: 'Gathering',
  fn: (p, args) => {
    const name = args.join(' ') || 'fishing spot';
    const obj = objects.findObjectByName(name, p.x, p.y, 3, p.layer);
    if (!obj) return `No "${name}" nearby.`;
    if (obj.skill !== 'fishing') return `You can't fish the ${obj.name}.`;
    if (getLevel(p, 'fishing') < obj.levelReq) return `You need Fishing level ${obj.levelReq}.`;
    if (Math.random() < 0.6) {
      if (obj.product) invAdd(p, obj.product.id, obj.product.name, obj.product.count || 1);
      const lvl = addXp(p, 'fishing', obj.xp);
      let msg = `You catch a fish. +${obj.xp} Fishing XP.`;
      if (obj.product) msg += ` Got: ${obj.product.name}.`;
      if (lvl) msg += ` Fishing level: ${lvl}!`;
      return msg;
    }
    return 'You attempt to catch a fish...';
  }
});

// Chat
commands.register('say', { help: 'Public chat', aliases: ['chat'], category: 'Social',
  fn: (p, args, raw) => {
    const msg = raw.replace(/^(say|chat)\s+/i, '');
    broadcast({ t: 'chat', from: p.name, msg });
    return `You say: ${msg}`;
  }
});

commands.register('pm', { help: 'Private message: pm [player] [message]', aliases: ['whisper', 'w', 'tell'], category: 'Social',
  fn: (p, args) => {
    if (args.length < 2) return 'Usage: pm [player] [message]';
    const target = findPlayer(args[0]);
    if (!target) return `Player "${args[0]}" not found.`;
    const msg = args.slice(1).join(' ');
    // Find target's ws
    for (const [ws, pl] of players) {
      if (pl === target) { sendText(ws, `[PM from ${p.name}]: ${msg}`); break; }
    }
    return `[PM to ${target.name}]: ${msg}`;
  }
});

// Admin / World Building
commands.register('paint', { help: 'Paint tile: paint [x] [y] [type]', category: 'Build', admin: true,
  fn: (p, args) => {
    const x = parseInt(args[0]), y = parseInt(args[1]);
    const typeName = (args[2] || '').toUpperCase();
    if (isNaN(x) || isNaN(y)) return 'Usage: paint [x] [y] [type]';
    const tile = tiles.T[typeName];
    if (tile === undefined) return `Unknown tile type: ${typeName}. Types: ${Object.keys(tiles.T).join(', ')}`;
    tiles.setTile(x, y, tile, p.layer);
    return `Painted (${x}, ${y}) → ${typeName}`;
  }
});

commands.register('fill', { help: 'Fill area: fill [x1] [y1] [x2] [y2] [type]', category: 'Build', admin: true,
  fn: (p, args) => {
    const [x1, y1, x2, y2] = args.slice(0, 4).map(Number);
    const typeName = (args[4] || '').toUpperCase();
    if ([x1,y1,x2,y2].some(isNaN)) return 'Usage: fill [x1] [y1] [x2] [y2] [type]';
    const tile = tiles.T[typeName];
    if (tile === undefined) return `Unknown tile: ${typeName}`;
    let count = 0;
    for (let x = Math.min(x1,x2); x <= Math.max(x1,x2); x++) {
      for (let y = Math.min(y1,y2); y <= Math.max(y1,y2); y++) {
        tiles.setTile(x, y, tile, p.layer);
        count++;
      }
    }
    return `Filled ${count} tiles with ${typeName}.`;
  }
});

commands.register('wall', { help: 'Place wall: wall [x] [y] [n/e/s/w]', category: 'Build', admin: true,
  fn: (p, args) => {
    const x = parseInt(args[0]) || p.x, y = parseInt(args[1]) || p.y;
    const dir = (args[2] || args[0] || '').toLowerCase();
    const edge = { n: 1, e: 2, s: 4, w: 8 }[dir];
    if (!edge) return 'Usage: wall [x] [y] [n/e/s/w] or wall [n/e/s/w]';
    const current = walls.getWallEdge(x, y, p.layer);
    walls.setWallEdge(x, y, current | edge, p.layer);
    return `Wall placed at (${x}, ${y}) ${dir}.`;
  }
});

commands.register('door', { help: 'Place door: door [x] [y] [n/e/s/w]', category: 'Build', admin: true,
  fn: (p, args) => {
    const x = parseInt(args[0]) || p.x, y = parseInt(args[1]) || p.y;
    const dir = (args[2] || args[0] || '').toLowerCase();
    const edge = { n: 1, e: 2, s: 4, w: 8 }[dir];
    if (!edge) return 'Usage: door [x] [y] [n/e/s/w]';
    const current = walls.getDoorEdge(x, y, p.layer);
    walls.setDoorEdge(x, y, current | edge, p.layer);
    return `Door placed at (${x}, ${y}) ${dir}.`;
  }
});

commands.register('spawn_npc', { help: 'Spawn NPC: spawn_npc [defId] [x] [y]', category: 'Build', admin: true,
  fn: (p, args) => {
    const defId = args[0];
    const x = parseInt(args[1]) || p.x, y = parseInt(args[2]) || p.y;
    const npc = npcs.spawnNpc(defId, x, y, p.layer);
    if (!npc) return `Unknown NPC definition: ${defId}. Defined: ${[...npcs.npcDefs.keys()].join(', ')}`;
    return `Spawned ${npc.name} at (${x}, ${y}).`;
  }
});

commands.register('place', { help: 'Place object: place [defId] [x] [y]', category: 'Build', admin: true,
  fn: (p, args) => {
    const defId = args[0];
    const x = parseInt(args[1]) || p.x, y = parseInt(args[2]) || p.y;
    const obj = objects.placeObject(defId, x, y, p.layer);
    if (!obj) return `Unknown object: ${defId}. Defined: ${[...objects.objectDefs.keys()].join(', ')}`;
    return `Placed ${obj.name} at (${x}, ${y}).`;
  }
});

commands.register('give', { help: 'Give yourself an item: give [name] [count]', category: 'Build', admin: true,
  fn: (p, args) => {
    const name = args.slice(0, -1).join(' ') || args[0];
    const count = parseInt(args[args.length - 1]) || 1;
    if (!name) return 'Usage: give [item name] [count]';
    invAdd(p, nextItemId++, name, count);
    return `Added ${name} x${count} to inventory.`;
  }
});

commands.register('setlevel', { help: 'Set skill level: setlevel [skill] [level]', category: 'Build', admin: true,
  fn: (p, args) => {
    const skill = (args[0] || '').toLowerCase();
    const level = parseInt(args[1]);
    if (!p.skills[skill]) return `Unknown skill: ${skill}`;
    if (isNaN(level) || level < 1 || level > 99) return 'Level must be 1-99.';
    p.skills[skill].xp = xpForLevel(level);
    p.skills[skill].level = level;
    if (skill === 'hitpoints') { p.maxHp = level; p.hp = level; }
    if (skill === 'prayer') p.prayerPoints = level;
    return `${skill} set to level ${level}.`;
  }
});

commands.register('admin', { help: 'Toggle admin mode', category: 'Build',
  fn: (p) => { p.admin = !p.admin; return `Admin: ${p.admin ? 'ON' : 'OFF'}`; }
});

commands.register('save', { help: 'Save world', category: 'Build', admin: true,
  fn: () => { persistence.saveAll(); return 'World saved.'; }
});

// ── Default content ───────────────────────────────────────────────────────────
function createDefaultContent() {
  // NPCs
  npcs.defineNpc('goblin', { name: 'Goblin', examine: 'An ugly green creature.', combat: 2, maxHp: 5, stats: { attack: 1, strength: 1, defence: 1 }, maxHit: 1, attackSpeed: 4, wanderRadius: 4, respawnTicks: 25,
    drops: [{ id: 100, name: 'bones', weight: 10, min: 1, max: 1 }, { id: 101, name: 'coins', weight: 8, min: 1, max: 5 }] });
  npcs.defineNpc('cow', { name: 'Cow', examine: 'Moo.', combat: 2, maxHp: 8, stats: { attack: 1, strength: 1, defence: 1 }, maxHit: 1, attackSpeed: 5, wanderRadius: 6, respawnTicks: 20,
    drops: [{ id: 102, name: 'cowhide', weight: 10, min: 1, max: 1 }, { id: 103, name: 'raw beef', weight: 8, min: 1, max: 1 }, { id: 100, name: 'bones', weight: 10, min: 1, max: 1 }] });
  npcs.defineNpc('chicken', { name: 'Chicken', examine: 'Cluck.', combat: 1, maxHp: 3, stats: { attack: 1, strength: 1, defence: 1 }, maxHit: 1, attackSpeed: 4, wanderRadius: 3, respawnTicks: 15,
    drops: [{ id: 104, name: 'feather', weight: 10, min: 5, max: 15 }, { id: 105, name: 'raw chicken', weight: 8, min: 1, max: 1 }, { id: 100, name: 'bones', weight: 10, min: 1, max: 1 }] });
  npcs.defineNpc('guard', { name: 'Guard', examine: 'A Lumbridge guard.', combat: 21, maxHp: 22, stats: { attack: 18, strength: 14, defence: 18, def_slash: 24 }, maxHit: 3, attackSpeed: 4, wanderRadius: 3, respawnTicks: 30,
    drops: [{ id: 100, name: 'bones', weight: 10, min: 1, max: 1 }, { id: 101, name: 'coins', weight: 6, min: 10, max: 30 }] });
  npcs.defineNpc('hans', { name: 'Hans', examine: 'A man walking around the castle.', combat: 0, maxHp: 1, wanderRadius: 10, dialogue: 'Hello adventurer! Welcome to OpenScape.' });

  // Objects
  objects.defineObject('tree', { name: 'Tree', examine: 'A tree.', actions: ['chop'], skill: 'woodcutting', levelReq: 1, xp: 25, ticks: 4, product: { id: 200, name: 'logs', count: 1 }, depletionChance: 0.5, respawnTicks: 15 });
  objects.defineObject('oak', { name: 'Oak tree', examine: 'An oak tree.', actions: ['chop'], skill: 'woodcutting', levelReq: 15, xp: 37, ticks: 4, product: { id: 201, name: 'oak logs', count: 1 }, depletionChance: 0.35, respawnTicks: 20 });
  objects.defineObject('willow', { name: 'Willow tree', examine: 'A willow tree.', actions: ['chop'], skill: 'woodcutting', levelReq: 30, xp: 67, ticks: 4, product: { id: 202, name: 'willow logs', count: 1 }, depletionChance: 0.25, respawnTicks: 25 });
  objects.defineObject('copper_rock', { name: 'Copper rock', examine: 'A rock containing copper ore.', actions: ['mine'], skill: 'mining', levelReq: 1, xp: 17, ticks: 4, product: { id: 210, name: 'copper ore', count: 1 }, depletionChance: 1.0, respawnTicks: 4 });
  objects.defineObject('tin_rock', { name: 'Tin rock', examine: 'A rock containing tin ore.', actions: ['mine'], skill: 'mining', levelReq: 1, xp: 17, ticks: 4, product: { id: 211, name: 'tin ore', count: 1 }, depletionChance: 1.0, respawnTicks: 4 });
  objects.defineObject('iron_rock', { name: 'Iron rock', examine: 'A rock containing iron ore.', actions: ['mine'], skill: 'mining', levelReq: 15, xp: 35, ticks: 4, product: { id: 212, name: 'iron ore', count: 1 }, depletionChance: 1.0, respawnTicks: 9 });
  objects.defineObject('fishing_spot', { name: 'Fishing spot', examine: 'A good spot to fish.', actions: ['fish'], skill: 'fishing', levelReq: 1, xp: 10, ticks: 5, product: { id: 220, name: 'raw shrimps', count: 1 } });

  // Spawn world content
  tiles.createSpawn();

  // Place some trees around spawn
  const trees = [[93, 95], [94, 93], [107, 95], [108, 97], [95, 107], [93, 106]];
  for (const [x, y] of trees) { tiles.setTile(x, y, tiles.T.TREE); objects.placeObject('tree', x, y); }

  // Some rocks
  const rocks = [[106, 106], [107, 107], [108, 106]];
  for (const [x, y] of rocks) { tiles.setTile(x, y, tiles.T.ROCK); objects.placeObject('copper_rock', x, y); }

  objects.placeObject('tin_rock', 109, 106);
  tiles.setTile(109, 106, tiles.T.ROCK);

  objects.placeObject('fishing_spot', 96, 104);
  tiles.setTile(96, 104, tiles.T.FISH_SPOT);

  // Spawn NPCs
  npcs.spawnNpc('hans', 100, 100);
  npcs.spawnNpc('chicken', 104, 103);
  npcs.spawnNpc('chicken', 105, 104);
  npcs.spawnNpc('cow', 108, 100);
  npcs.spawnNpc('cow', 109, 101);
  npcs.spawnNpc('goblin', 95, 96);
  npcs.spawnNpc('goblin', 94, 97);
}

// ── HTTP + WebSocket Server ───────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OpenScapeAPI v0.1.0 — Connect via WebSocket');
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  sendText(ws, 'Welcome to OpenScape! Type `login [name]` to start.');

  ws.on('message', (data) => {
    const input = data.toString().trim();
    if (!input) return;

    let p = players.get(ws);

    // Must login first
    if (!p) {
      const parsed = commands.parse(input);
      if (!parsed || parsed.verb !== 'login') {
        sendText(ws, 'Please login first: login [name]');
        return;
      }
      const name = parsed.args[0] || `Player${Math.floor(Math.random() * 9999)}`;
      if (playersByName.has(name.toLowerCase())) {
        sendText(ws, `Name "${name}" is taken. Try another.`);
        return;
      }
      p = createPlayer(players.size + 1, name);

      // Load saved player data
      const saved = persistence.load(`players/${name.toLowerCase()}.json`);
      if (saved) {
        Object.assign(p, saved);
        p.connected = true;
        p.path = [];
      }

      p.admin = true; // Everyone is admin for now (build mode)
      p.loginTick = tick.getTick();
      players.set(ws, p);
      playersByName.set(name.toLowerCase(), p);
      console.log(`[join] ${name} connected`);
      sendText(ws, `Logged in as ${name}. Combat level: ${combatLevel(p)}. Type \`help\` for commands.\nYou are at (${p.x}, ${p.y}).`);
      sendText(ws, commands.execute(p, 'look'));
      events.emit('player_login', { player: p, ws });
      return;
    }

    // Execute command
    const result = commands.execute(p, input);
    if (result) sendText(ws, result);
  });

  ws.on('close', () => {
    const p = players.get(ws);
    if (p) {
      // Save player
      const saveData = { ...p };
      delete saveData.path;
      delete saveData.connected;
      persistence.save(`players/${p.name.toLowerCase()}.json`, saveData);
      playersByName.delete(p.name.toLowerCase());
      players.delete(ws);
      console.log(`[leave] ${p.name} disconnected`);
      events.emit('player_logout', { player: p });
    }
  });
});

// ── Init ──────────────────────────────────────────────────────────────────────
tiles.loadChunks();
tiles.loadAreas();
walls.loadWalls();
npcs.loadNpcSpawns();
objects.loadObjects();

// If no chunks loaded, create default content
if (tiles.tileAt(SPAWN_X, SPAWN_Y) === tiles.T.EMPTY) {
  console.log('[init] Creating default world...');
  createDefaultContent();
}

// Register tick handlers
tick.onTick('movement', movementTick);
tick.onTick('combat', combatTick);
tick.onTick('world', worldTick);

// Persistence
persistence.onSave('chunks', () => tiles.saveChunks());
persistence.onSave('areas', () => tiles.saveAreas());
persistence.onSave('walls', () => walls.saveWalls());
persistence.onSave('npcs', () => npcs.saveNpcSpawns());
persistence.onSave('objects', () => objects.saveObjects());
persistence.startAutoSave();

// Start
tick.startTicking();
server.listen(PORT, () => {
  console.log(`[server] OpenScapeAPI running on ws://localhost:${PORT}`);
  console.log(`[server] Connect with: wscat -c ws://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', () => { persistence.saveAll(); tick.stopTicking(); process.exit(); });
process.on('SIGTERM', () => { persistence.saveAll(); tick.stopTicking(); process.exit(); });
