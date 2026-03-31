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

// Data systems
const items = require('./data/items');
const recipes = require('./data/recipes');
const shopSystem = require('./data/shops');
const questSystem = require('./data/quests');
const droptables = require('./data/droptables');
const slayerSystem = require('./data/slayer');
const ge = require('./data/ge');
const actions = require('./engine/actions');
const registerAllCommands = require('./commands/all');

// ── State ─────────────────────────────────────────────────────────────────────
const PORT = 2223;
const players = new Map(); // ws → player
const playersByName = new Map(); // name → player
const groundItems = []; // [{ id, name, x, y, layer, count, owner, despawnTick }]
let nextItemId = 1;

// ── Session Logger ────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const LOGS_DIR = path.join(__dirname, '..', 'data', 'logs');
const sessionLogs = new Map(); // ws → { file, stream }

function startSessionLog(ws, playerName) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${playerName}_${ts}.jsonl`;
  const filepath = path.join(LOGS_DIR, filename);
  const stream = fs.createWriteStream(filepath, { flags: 'a' });
  const startTick = tick.getTick();
  sessionLogs.set(ws, { file: filename, stream, startTick });
  console.log(`[log] Recording session → ${filename}`);
}

function logEntry(ws, type, text) {
  const session = sessionLogs.get(ws);
  if (!session) return;
  const t = tick.getTick();
  const tickOffset = t - session.startTick;
  session.stream.write(JSON.stringify({ tick: tickOffset, type, text }) + '\n');
}

function endSessionLog(ws) {
  const session = sessionLogs.get(ws);
  if (!session) return;
  const t = tick.getTick();
  session.stream.write(JSON.stringify({ tick: t - session.startTick, type: 'end', text: 'Session ended' }) + '\n');
  session.stream.end();
  sessionLogs.delete(ws);
}

// ── Helper ────────────────────────────────────────────────────────────────────
function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function sendText(ws, text) {
  send(ws, { t: 'msg', text });
  logEntry(ws, 'out', text);
}

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

    if (actions.isActive(p)) actions.cancel(p);
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

      // Drop loot (use drop tables if defined, fallback to NPC inline drops)
      const drops = droptables.tables.has(npc.defId) ? droptables.roll(npc.defId) : npcs.rollDrops(npc);
      for (const drop of drops) {
        groundItems.push({ id: nextItemId++, ...drop, x: npc.x, y: npc.y, layer: npc.layer, owner: p.id, despawnTick: currentTick + 200 });
        msg += `\n  Loot: ${drop.name} x${drop.count}`;
      }

      // Slayer task tracking
      if (p.slayerTask && npc.name.toLowerCase() === p.slayerTask.monster.toLowerCase()) {
        p.slayerTask.remaining--;
        if (p.slayerTask.remaining <= 0) {
          const slayResult = slayerSystem.completeTask(p);
          addXp(p, 'slayer', npc.maxHp); // slayer XP = monster HP
          msg += `\n  Slayer task complete! +${slayResult.points} points (streak: ${slayResult.streak})`;
        } else {
          addXp(p, 'slayer', npc.maxHp);
          msg += `\n  Slayer: ${p.slayerTask.remaining} remaining`;
        }
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
          actions.cancel(p);
          // Death: keep 3 most valuable items, drop the rest
          const deathX = p.x, deathY = p.y, deathLayer = p.layer;
          const allItems = [];
          for (let i = 0; i < p.inventory.length; i++) {
            if (p.inventory[i]) {
              const def = items.get(p.inventory[i].id);
              allItems.push({ ...p.inventory[i], slot: i, source: 'inv', value: def?.value || 0 });
            }
          }
          for (const [slot, item] of Object.entries(p.equipment)) {
            const def = items.get(item.id);
            allItems.push({ ...item, slot, source: 'equip', value: def?.value || 0 });
          }
          // Sort by value descending — keep top 3
          allItems.sort((a, b) => b.value - a.value);
          const kept = allItems.slice(0, 3);
          const dropped = allItems.slice(3);
          // Clear inventory and equipment
          p.inventory.fill(null);
          p.equipment = {};
          // Re-add kept items
          for (const item of kept) {
            invAdd(p, item.id, item.name, item.count || 1, items.get(item.id)?.stackable);
          }
          // Drop lost items
          for (const item of dropped) {
            groundItems.push({ id: nextItemId++, name: item.name, count: item.count || 1, x: deathX, y: deathY, layer: deathLayer, owner: p.id, despawnTick: currentTick + 1500 });
          }
          let deathMsg = 'Oh dear, you are dead!';
          if (kept.length) deathMsg += `\nYou kept: ${kept.map(i => i.name).join(', ')}`;
          if (dropped.length) deathMsg += `\nYou lost: ${dropped.map(i => i.name).join(', ')}`;
          deathMsg += '\nYour items are at your gravestone for 15 minutes.';
          sendText(ws, deathMsg);
          p.hp = p.maxHp;
          p.x = SPAWN_X; p.y = SPAWN_Y; p.layer = 0;
          p.combatTarget = null; p.busy = false; p.path = [];
          p.prayerPoints = getLevel(p, 'prayer');
          p.activePrayers.clear();
          p.runEnergy = 10000;
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

  // Process tick-based actions (gathering, processing)
  const actionMsgs = actions.processTick();
  for (const [playerId, msgs] of actionMsgs) {
    // Find player's ws
    for (const [ws, p] of players) {
      if (p.id === playerId) {
        for (const msg of msgs) sendText(ws, msg);
        // Clear busy if action completed
        if (!actions.isActive(p)) { p.busy = false; p.busyAction = null; }
        break;
      }
    }
  }

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
    // Look up item definition for equip slot and stats
    const def = items.get(item.id) || items.find(item.name);
    const equipSlot = item.equipSlot || def?.equipSlot;
    if (!equipSlot) return `${item.name} is not equippable.`;
    // Check requirements
    if (def?.equipReqs) {
      for (const [skill, level] of Object.entries(def.equipReqs)) {
        if (getLevel(p, skill) < level) return `You need ${skill} level ${level} to equip ${item.name}.`;
      }
    }
    // Merge item def stats onto the item
    const equipItem = { id: item.id, name: item.name, count: 1, equipSlot, stats: def?.stats || item.stats || {}, speed: def?.speed || item.speed };
    p.inventory[slot] = item.count > 1 ? { ...item, count: item.count - 1 } : null;
    const old = p.equipment[equipSlot];
    p.equipment[equipSlot] = equipItem;
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

// ── Gathering (tick-based) ─────────────────────────────────────────────────────
function startGathering(p, ws, skillName, verb, obj) {
  if (obj.depleted) return `The ${obj.name} is depleted.`;
  if (getLevel(p, skillName) < obj.levelReq) return `You need ${skillName} level ${obj.levelReq}.`;
  if (invFreeSlots(p) < 1) return 'Your inventory is full.';
  if (p.busy) actions.cancel(p);

  actions.start(p, {
    type: skillName,
    ticks: obj.ticks || 4,
    repeat: true,
    data: { obj, skillName, verb, ws, player: p },
    onTick: (data, ticksLeft) => {
      if (ticksLeft === data.obj.ticks - 1) return `You ${data.verb} the ${data.obj.name}...`;
      return null;
    },
    onComplete: (data) => {
      if (data.obj.depleted) { actions.cancel(data.player); return `The ${data.obj.name} is depleted.`; }
      if (invFreeSlots(data.player) < 1) { actions.cancel(data.player); return 'Your inventory is full. You stop.'; }

      // Success roll: higher level = higher chance
      const levelDiff = getLevel(data.player, data.skillName) - data.obj.levelReq;
      const successChance = Math.min(0.95, 0.4 + levelDiff * 0.03);
      if (Math.random() > successChance) return null; // Silent fail, keep trying

      if (data.obj.product) {
        const itemDef = items.get(data.obj.product.id);
        invAdd(data.player, data.obj.product.id, data.obj.product.name, data.obj.product.count || 1, itemDef?.stackable);
      }
      const lvl = addXp(data.player, data.skillName, data.obj.xp);
      if (Math.random() < data.obj.depletionChance) {
        data.obj.depleted = true;
        data.obj.respawnAt = tick.getTick() + data.obj.respawnTicks;
        actions.cancel(data.player);
      }
      let msg = `You get some ${data.obj.product?.name || 'resources'}. +${data.obj.xp} ${data.skillName} XP.`;
      if (lvl) msg += ` ${data.skillName} level: ${lvl}!`;
      if (data.obj.depleted) msg += ` The ${data.obj.name} is depleted.`;
      return msg;
    },
  });
  return `You begin to ${verb} the ${obj.name}...`;
}

commands.register('chop', { help: 'Chop a tree (repeating)', category: 'Gathering',
  fn: (p, args) => {
    const name = args.join(' ') || 'tree';
    const obj = objects.findObjectByName(name, p.x, p.y, 3, p.layer);
    if (!obj) return `No "${name}" nearby.`;
    if (obj.skill !== 'woodcutting') return `You can't chop the ${obj.name}.`;
    let ws; for (const [w, pl] of players) { if (pl === p) { ws = w; break; } }
    return startGathering(p, ws, 'woodcutting', 'chop', obj);
  }
});

commands.register('mine', { help: 'Mine a rock (repeating)', category: 'Gathering',
  fn: (p, args) => {
    const name = args.join(' ') || 'rock';
    const obj = objects.findObjectByName(name, p.x, p.y, 3, p.layer);
    if (!obj) return `No "${name}" nearby.`;
    if (obj.skill !== 'mining') return `You can't mine the ${obj.name}.`;
    let ws; for (const [w, pl] of players) { if (pl === p) { ws = w; break; } }
    return startGathering(p, ws, 'mining', 'mine', obj);
  }
});

commands.register('fish', { help: 'Fish at a spot (repeating)', category: 'Gathering',
  fn: (p, args) => {
    const name = args.join(' ') || 'fishing spot';
    const obj = objects.findObjectByName(name, p.x, p.y, 5, p.layer);
    if (!obj) return `No "${name}" nearby.`;
    if (obj.skill !== 'fishing') return `You can't fish the ${obj.name}.`;
    let ws; for (const [w, pl] of players) { if (pl === p) { ws = w; break; } }
    return startGathering(p, ws, 'fishing', 'fish at', obj);
  }
});

commands.register('stop', { help: 'Stop current action', aliases: ['cancel'], category: 'General',
  fn: (p) => {
    if (!p.busy && !actions.isActive(p)) return 'You aren\'t doing anything.';
    if (p.combatTarget) { p.combatTarget = null; }
    actions.cancel(p);
    return 'You stop what you\'re doing.';
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
    // Parse: last arg might be count
    let count = parseInt(args[args.length - 1]);
    let name;
    if (!isNaN(count) && args.length > 1) {
      name = args.slice(0, -1).join(' ');
    } else {
      name = args.join(' ');
      count = 1;
    }
    if (!name) return 'Usage: give [item name] [count]';
    // Look up in item database
    const def = items.find(name);
    if (def) {
      invAdd(p, def.id, def.name, count, def.stackable);
      return `Added ${def.name} x${count} to inventory.`;
    }
    // Fuzzy search
    const results = items.search(name);
    if (results.length) return `Item not found. Did you mean: ${results.slice(0, 5).map(i => i.name).join(', ')}`;
    return `Unknown item: "${name}". Use exact name from item database.`;
  }
});

// ── Banking ───────────────────────────────────────────────────────────────────
commands.register('bank', { help: 'Open bank (near bank booth)', category: 'Items',
  fn: (p) => {
    const booth = objects.findObjectByName('bank booth', p.x, p.y, 3, p.layer);
    if (!booth) return 'You need to be near a bank booth.';
    if (!p.bank) p.bank = [];
    let out = `── Bank (${p.bank.length}/816) ──\n`;
    if (!p.bank.length) out += '  (empty)\n';
    for (let i = 0; i < p.bank.length; i++) {
      const b = p.bank[i];
      out += `  [${i}] ${b.name}${b.count > 1 ? ` x${b.count}` : ''}\n`;
    }
    out += '\nCommands: deposit [item], deposit all, withdraw [item] [count]';
    p._bankOpen = true;
    return out;
  }
});

commands.register('deposit', { help: 'Deposit item: deposit [item] or deposit all', category: 'Items',
  fn: (p, args) => {
    if (!p._bankOpen) return 'Open the bank first with `bank`.';
    if (!p.bank) p.bank = [];
    if (args[0] === 'all') {
      let deposited = 0;
      for (let i = 0; i < p.inventory.length; i++) {
        if (p.inventory[i]) {
          const item = p.inventory[i];
          const existing = p.bank.find(b => b.id === item.id);
          if (existing) existing.count += item.count;
          else if (p.bank.length < 816) p.bank.push({ id: item.id, name: item.name, count: item.count });
          else { return `Bank full. Deposited ${deposited} items.`; }
          p.inventory[i] = null;
          deposited++;
        }
      }
      return `Deposited ${deposited} items.`;
    }
    const name = args.join(' ').toLowerCase();
    const slot = p.inventory.findIndex(s => s && s.name.toLowerCase() === name);
    if (slot < 0) return `You don't have "${name}".`;
    const item = p.inventory[slot];
    const existing = p.bank.find(b => b.id === item.id);
    if (existing) existing.count += item.count;
    else if (p.bank.length < 816) p.bank.push({ id: item.id, name: item.name, count: item.count });
    else return 'Bank is full.';
    p.inventory[slot] = null;
    return `Deposited ${item.name} x${item.count}.`;
  }
});

commands.register('withdraw', { help: 'Withdraw item: withdraw [item] [count]', category: 'Items',
  fn: (p, args) => {
    if (!p._bankOpen) return 'Open the bank first with `bank`.';
    if (!p.bank) p.bank = [];
    if (invFreeSlots(p) < 1) return 'Inventory is full.';
    const count = parseInt(args[args.length - 1]);
    const name = (!isNaN(count) && args.length > 1 ? args.slice(0, -1) : args).join(' ').toLowerCase();
    const amt = !isNaN(count) && args.length > 1 ? count : 1;
    const bankIdx = p.bank.findIndex(b => b.name.toLowerCase() === name);
    if (bankIdx < 0) return `"${name}" not in bank.`;
    const bankItem = p.bank[bankIdx];
    const withdrawAmt = Math.min(amt, bankItem.count);
    const def = items.get(bankItem.id);
    invAdd(p, bankItem.id, bankItem.name, withdrawAmt, def?.stackable);
    bankItem.count -= withdrawAmt;
    if (bankItem.count <= 0) p.bank.splice(bankIdx, 1);
    return `Withdrew ${bankItem.name} x${withdrawAmt}.`;
  }
});

// ── Grand Exchange ────────────────────────────────────────────────────────────
commands.register('ge', { help: 'Grand Exchange: ge buy/sell/offers/collect/price', category: 'Economy',
  fn: (p, args) => {
    const sub = args[0]?.toLowerCase();
    if (sub === 'buy') {
      const name = args.slice(1, -2).join(' ');
      const qty = parseInt(args[args.length - 2]);
      const price = parseInt(args[args.length - 1]);
      if (!name || isNaN(qty) || isNaN(price)) return 'Usage: ge buy [item] [quantity] [price per item]';
      const def = items.find(name);
      if (!def) return `Unknown item: "${name}"`;
      const totalCost = qty * price;
      if (invCount(p, 101) < totalCost) return `You need ${totalCost} coins. You have ${invCount(p, 101)}.`;
      invRemove(p, 101, totalCost);
      const offer = ge.createOffer('buy', p.id, p.name, def.id, def.name, qty, price);
      if (!offer) return 'You have too many GE offers (max 8).';
      let msg = `Buy offer placed: ${qty}x ${def.name} at ${price} each (${totalCost} total).`;
      if (offer.collected > 0) msg += `\n  Instantly matched: ${offer.collected} items ready to collect.`;
      return msg;
    }
    if (sub === 'sell') {
      const name = args.slice(1, -2).join(' ');
      const qty = parseInt(args[args.length - 2]);
      const price = parseInt(args[args.length - 1]);
      if (!name || isNaN(qty) || isNaN(price)) return 'Usage: ge sell [item] [quantity] [price per item]';
      const def = items.find(name);
      if (!def) return `Unknown item: "${name}"`;
      if (invCount(p, def.id) < qty) return `You only have ${invCount(p, def.id)}x ${def.name}.`;
      invRemove(p, def.id, qty);
      const offer = ge.createOffer('sell', p.id, p.name, def.id, def.name, qty, price);
      if (!offer) return 'You have too many GE offers (max 8).';
      let msg = `Sell offer placed: ${qty}x ${def.name} at ${price} each.`;
      if (offer.collectedCoins > 0) msg += `\n  Instantly sold: ${offer.collectedCoins} coins ready to collect.`;
      return msg;
    }
    if (sub === 'offers') {
      const myOffers = ge.getPlayerOffers(p.id);
      if (!myOffers.length) return 'No active GE offers.';
      let out = '── Grand Exchange ──\n';
      for (const o of myOffers) {
        const filled = o.quantity - o.remaining;
        out += `  [${o.id}] ${o.type.toUpperCase()} ${o.quantity}x ${o.itemName} @ ${o.price}ea — ${filled}/${o.quantity} filled`;
        if (o.collected > 0) out += ` | ${o.collected} items to collect`;
        if (o.collectedCoins > 0) out += ` | ${o.collectedCoins} coins to collect`;
        out += '\n';
      }
      out += '\nCommands: ge collect [id], ge cancel [id]';
      return out;
    }
    if (sub === 'collect') {
      const id = parseInt(args[1]);
      if (isNaN(id)) return 'Usage: ge collect [offer id]';
      const result = ge.collectOffer(id);
      if (!result) return 'Offer not found.';
      let msg = 'Collected:';
      if (result.items > 0) {
        const offer = ge.offers.find(o => o.id === id) || ge.getPlayerOffers(p.id).find(o => o.id === id);
        const itemName = offer?.itemName || 'items';
        const def = items.find(itemName);
        invAdd(p, def?.id || 0, itemName, result.items, def?.stackable);
        msg += ` ${result.items}x ${itemName}`;
      }
      if (result.coins > 0) {
        invAdd(p, 101, 'Coins', result.coins, true);
        msg += ` ${result.coins} coins`;
      }
      return msg;
    }
    if (sub === 'cancel') {
      const id = parseInt(args[1]);
      if (isNaN(id)) return 'Usage: ge cancel [offer id]';
      const result = ge.cancelOffer(id);
      if (!result) return 'Offer not found.';
      if (result.refund.items > 0) invAdd(p, result.offer.itemId, result.offer.itemName, result.refund.items, items.get(result.offer.itemId)?.stackable);
      if (result.refund.coins > 0) invAdd(p, 101, 'Coins', result.refund.coins, true);
      return `Cancelled. Refunded: ${result.refund.items > 0 ? result.refund.items + 'x ' + result.offer.itemName + ' ' : ''}${result.refund.coins > 0 ? result.refund.coins + ' coins' : ''}`;
    }
    if (sub === 'price') {
      const name = args.slice(1).join(' ');
      const def = items.find(name);
      if (!def) return `Unknown item: "${name}"`;
      const price = ge.getPrice(def.id);
      return `${def.name}: ${price ? price + ' coins (last trade)' : 'No trades yet'} | Base value: ${def.value} | High alch: ${def.highAlch}`;
    }
    return 'Grand Exchange commands:\n  ge buy [item] [qty] [price]\n  ge sell [item] [qty] [price]\n  ge offers\n  ge collect [id]\n  ge cancel [id]\n  ge price [item]';
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

commands.register('replays', { help: 'List session recordings', category: 'General',
  fn: () => {
    if (!fs.existsSync(LOGS_DIR)) return 'No recordings yet.';
    const files = fs.readdirSync(LOGS_DIR).filter(f => f.endsWith('.jsonl')).sort().reverse();
    if (!files.length) return 'No recordings yet.';
    return 'Session recordings:\n' + files.map((f, i) => {
      const lines = fs.readFileSync(path.join(LOGS_DIR, f), 'utf8').trim().split('\n');
      const last = JSON.parse(lines[lines.length - 1]);
      const ticks = last.tick;
      const secs = (ticks * 0.6).toFixed(0);
      return `  [${i}] ${f} (${ticks} ticks, ~${secs}s)`;
    }).join('\n') + '\n\nType `replay [number]` for real-time playback.';
  }
});

// Step-through replays: ws → { entries, idx, currentTick }
const activeReplays = new Map();

function replayNext(ws) {
  const replay = activeReplays.get(ws);
  if (!replay) return;

  const { entries } = replay;
  if (replay.idx >= entries.length) {
    sendText(ws, '\n── Replay complete ──');
    activeReplays.delete(ws);
    return;
  }

  // Show all entries for the current tick
  const currentTick = entries[replay.idx].tick;
  while (replay.idx < entries.length && entries[replay.idx].tick === currentTick) {
    const e = entries[replay.idx];
    if (e.type === 'in') {
      sendText(ws, `[tick ${e.tick}] > ${e.text}`);
    } else if (e.type === 'out') {
      sendText(ws, `[tick ${e.tick}]   ${e.text}`);
    } else if (e.type === 'end') {
      sendText(ws, '\n── Replay complete ──');
      activeReplays.delete(ws);
      return;
    }
    replay.idx++;
  }

  // Show progress
  if (replay.idx < entries.length) {
    const remaining = entries.length - replay.idx;
    sendText(ws, `    ── [${remaining} entries left — press Enter to continue, type "q" to stop] ──`);
  } else {
    sendText(ws, '\n── Replay complete ──');
    activeReplays.delete(ws);
  }
}

commands.register('replay', { help: 'Step-through replay: replay [number]', category: 'General',
  fn: (p, args) => {
    if (!fs.existsSync(LOGS_DIR)) return 'No recordings yet.';
    const files = fs.readdirSync(LOGS_DIR).filter(f => f.endsWith('.jsonl')).sort().reverse();
    const idx = parseInt(args[0]);
    if (isNaN(idx) || idx < 0 || idx >= files.length) return `Usage: replay [0-${files.length - 1}]`;

    let playerWs = null;
    for (const [ws, pl] of players) { if (pl === p) { playerWs = ws; break; } }
    if (!playerWs) return 'Error finding connection.';

    // Stop any active replay
    activeReplays.delete(playerWs);

    // Parse recording
    const lines = fs.readFileSync(path.join(LOGS_DIR, files[idx]), 'utf8').trim().split('\n');
    const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    if (!entries.length) return 'Empty recording.';

    const lastTick = entries[entries.length - 1].tick;
    sendText(playerWs, `── Replay: ${files[idx]} ── (${lastTick} ticks, ~${(lastTick * 0.6).toFixed(0)}s)`);
    sendText(playerWs, '    Press Enter to step through. Type "q" to stop.\n');

    activeReplays.set(playerWs, { entries, idx: 0 });
    replayNext(playerWs);
    return '';
  }
});

commands.register('stopreplay', { help: 'Stop active replay', category: 'General',
  fn: (p) => {
    for (const [ws, pl] of players) {
      if (pl === p && activeReplays.has(ws)) {
        activeReplays.delete(ws);
        return 'Replay stopped.';
      }
    }
    return 'No replay active.';
  }
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

  // More monsters
  npcs.defineNpc('hill_giant', { name: 'Hill Giant', examine: 'A very large humanoid.', combat: 28, maxHp: 35, stats: { attack: 18, strength: 22, defence: 26, def_slash: 18 }, maxHit: 4, attackSpeed: 4, wanderRadius: 4, respawnTicks: 30 });
  npcs.defineNpc('lesser_demon', { name: 'Lesser Demon', examine: 'A demon from the underworld.', combat: 82, maxHp: 79, stats: { attack: 68, strength: 67, defence: 71, def_slash: 42 }, maxHit: 8, attackSpeed: 4, wanderRadius: 3, respawnTicks: 30 });
  npcs.defineNpc('green_dragon', { name: 'Green Dragon', examine: 'A green dragon.', combat: 79, maxHp: 75, stats: { attack: 68, strength: 66, defence: 64, def_slash: 40 }, maxHit: 8, attackSpeed: 4, wanderRadius: 3, respawnTicks: 40 });

  // Hill giants area (east)
  tiles.defineArea('giants', { name: 'Giant Plains', x1: 120, y1: 95, x2: 130, y2: 105 });
  for (let x = 120; x <= 130; x++) for (let y = 95; y <= 105; y++) tiles.setTile(x, y, tiles.T.GRASS);
  npcs.spawnNpc('hill_giant', 124, 100);
  npcs.spawnNpc('hill_giant', 126, 98);

  // Town area (north)
  tiles.defineArea('town', { name: 'Town', x1: 95, y1: 85, x2: 110, y2: 95, safe: true });
  for (let x = 95; x <= 110; x++) for (let y = 85; y <= 95; y++) tiles.setTile(x, y, tiles.T.PATH);

  // Shop NPCs
  npcs.defineNpc('shopkeeper', { name: 'Shopkeeper', examine: 'A shopkeeper.', combat: 0, maxHp: 1, wanderRadius: 2, dialogue: 'Want to see my wares? Type `shop shopkeeper`.' });
  npcs.defineNpc('weapon_master', { name: 'Weapon Master', examine: 'A weapon dealer.', combat: 0, maxHp: 1, wanderRadius: 1, dialogue: 'Looking for a weapon? Type `shop weapon master`.' });
  npcs.defineNpc('armour_seller', { name: 'Armour Seller', examine: 'An armour dealer.', combat: 0, maxHp: 1, wanderRadius: 1, dialogue: 'Need some protection? Type `shop armour seller`.' });
  npcs.defineNpc('fishing_tutor', { name: 'Fishing Tutor', examine: 'A fishing instructor.', combat: 0, maxHp: 1, wanderRadius: 1, dialogue: 'Need supplies? Type `shop fishing tutor`.' });
  npcs.defineNpc('mining_instructor', { name: 'Mining Instructor', examine: 'A mining instructor.', combat: 0, maxHp: 1, wanderRadius: 1, dialogue: 'Need a pickaxe? Type `shop mining instructor`.' });
  npcs.defineNpc('aubury', { name: 'Aubury', examine: 'A rune shop owner.', combat: 0, maxHp: 1, wanderRadius: 1, dialogue: 'Interested in runes? Type `shop aubury`.' });
  npcs.defineNpc('slayer_master', { name: 'Turael', examine: 'A slayer master.', combat: 0, maxHp: 1, wanderRadius: 1, dialogue: 'Need a task? Type `slayer turael`.' });
  npcs.defineNpc('cook', { name: 'Cook', examine: 'The castle cook.', combat: 0, maxHp: 1, wanderRadius: 2, dialogue: 'I need help with a cake! Type `startquest cook`.' });

  npcs.spawnNpc('shopkeeper', 98, 90);
  npcs.spawnNpc('weapon_master', 100, 88);
  npcs.spawnNpc('armour_seller', 102, 88);
  npcs.spawnNpc('fishing_tutor', 96, 104);
  npcs.spawnNpc('mining_instructor', 108, 106);
  npcs.spawnNpc('aubury', 104, 90);
  npcs.spawnNpc('slayer_master', 106, 90);
  npcs.spawnNpc('cook', 100, 92);

  // More gathering objects
  objects.defineObject('maple', { name: 'Maple tree', examine: 'A maple tree.', actions: ['chop'], skill: 'woodcutting', levelReq: 45, xp: 100, ticks: 4, product: { id: 203, name: 'Maple logs', count: 1 }, depletionChance: 0.2, respawnTicks: 30 });
  objects.defineObject('yew', { name: 'Yew tree', examine: 'A yew tree.', actions: ['chop'], skill: 'woodcutting', levelReq: 60, xp: 175, ticks: 4, product: { id: 204, name: 'Yew logs', count: 1 }, depletionChance: 0.15, respawnTicks: 50 });
  objects.defineObject('coal_rock', { name: 'Coal rock', examine: 'A rock containing coal.', actions: ['mine'], skill: 'mining', levelReq: 30, xp: 50, ticks: 4, product: { id: 213, name: 'Coal', count: 1 }, depletionChance: 1.0, respawnTicks: 49 });
  objects.defineObject('mithril_rock', { name: 'Mithril rock', examine: 'A rock containing mithril.', actions: ['mine'], skill: 'mining', levelReq: 55, xp: 80, ticks: 4, product: { id: 215, name: 'Mithril ore', count: 1 }, depletionChance: 1.0, respawnTicks: 200 });
  objects.defineObject('fly_fishing_spot', { name: 'Fishing spot', examine: 'A trout/salmon spot.', actions: ['fish'], skill: 'fishing', levelReq: 20, xp: 50, ticks: 5, product: { id: 221, name: 'Raw trout', count: 1 } });
  objects.defineObject('cage_fishing_spot', { name: 'Cage/Harpoon spot', examine: 'A lobster/swordfish spot.', actions: ['fish'], skill: 'fishing', levelReq: 40, xp: 90, ticks: 5, product: { id: 223, name: 'Raw lobster', count: 1 } });
  objects.defineObject('range', { name: 'Cooking range', examine: 'A range for cooking.', actions: ['cook'] });
  objects.defineObject('furnace', { name: 'Furnace', examine: 'A furnace for smelting.', actions: ['smelt'] });
  objects.defineObject('anvil', { name: 'Anvil', examine: 'An anvil for smithing.', actions: ['smith'] });
  objects.defineObject('bank_booth', { name: 'Bank booth', examine: 'A bank booth.', actions: ['bank'] });
  objects.defineObject('spinning_wheel', { name: 'Spinning wheel', examine: 'A spinning wheel.', actions: ['spin'] });

  // Place town objects
  objects.placeObject('range', 99, 92);
  objects.placeObject('furnace', 101, 92);
  objects.placeObject('anvil', 103, 92);
  objects.placeObject('bank_booth', 98, 88);
  objects.placeObject('spinning_wheel', 105, 92);

  // More trees
  objects.placeObject('oak', 92, 98);
  objects.placeObject('oak', 91, 99);
  objects.placeObject('willow', 90, 102);
  objects.placeObject('willow', 89, 103);

  // More rocks
  objects.placeObject('iron_rock', 110, 107);
  objects.placeObject('coal_rock', 111, 107);
  objects.placeObject('coal_rock', 112, 107);

  // More fishing
  objects.placeObject('fly_fishing_spot', 94, 106);
  tiles.setTile(94, 106, tiles.T.FISH_SPOT);

  console.log(`[init] Default world created with ${npcs.npcs.size} NPCs, ${objects.objects.size} objects`);
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

    // If in replay mode, any input advances (Enter/space), "q" stops
    if (activeReplays.has(ws)) {
      if (input === 'q' || input === 'quit' || input === 'stopreplay') {
        activeReplays.delete(ws);
        sendText(ws, 'Replay stopped.');
      } else {
        replayNext(ws);
      }
      return;
    }

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
      startSessionLog(ws, name);
      logEntry(ws, 'in', `login ${name}`);
      sendText(ws, `Logged in as ${name}. Combat level: ${combatLevel(p)}. Type \`help\` for commands.\nYou are at (${p.x}, ${p.y}).`);
      sendText(ws, commands.execute(p, 'look'));
      events.emit('player_login', { player: p, ws });
      return;
    }

    // Execute command
    logEntry(ws, 'in', input);
    const result = commands.execute(p, input);
    if (result) sendText(ws, result);
  });

  ws.on('close', () => {
    const p = players.get(ws);
    if (p) {
      endSessionLog(ws);
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
tick.onTick('shops', (t) => shopSystem.restockTick(t));

// Register all Tier 6-18 commands
registerAllCommands({
  players, playersByName, groundItems, tick, events, persistence,
  tiles, walls, npcs, objects, pathfinding, combat,
  getLevel, getXp, addXp, totalLevel, combatLevel,
  invAdd, invRemove, invCount, invFreeSlots,
  send, sendText, broadcast, findPlayer, nextItemId,
});

// Persistence
persistence.onSave('chunks', () => tiles.saveChunks());
persistence.onSave('areas', () => tiles.saveAreas());
persistence.onSave('walls', () => walls.saveWalls());
persistence.onSave('npcs', () => npcs.saveNpcSpawns());
persistence.onSave('objects', () => objects.saveObjects());
persistence.onSave('ge', () => ge.saveGE());
ge.loadGE();
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
