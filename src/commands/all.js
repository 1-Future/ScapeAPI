// ── All game commands (Tiers 6-18) ────────────────────────────────────────────
// Wires items, recipes, shops, quests, slayer, trading, and all remaining systems

const commands = require('../engine/commands');
const items = require('../data/items');
const recipes = require('../data/recipes');
const shops = require('../data/shops');
const quests = require('../data/quests');
const droptables = require('../data/droptables');
const slayer = require('../data/slayer');

module.exports = function registerAll(ctx) {
  const { players, playersByName, groundItems, tick, events, persistence,
    tiles, walls, npcs, objects, pathfinding, combat,
    getLevel, getXp, addXp, totalLevel, combatLevel,
    invAdd, invRemove, invCount, invFreeSlots,
    send, sendText, broadcast, findPlayer, nextItemId } = ctx;

  // ── Eating food ─────────────────────────────────────────────────────────────
  commands.register('eat', { help: 'Eat food to heal: eat [item]', category: 'Items',
    fn: (p, args) => {
      const name = args.join(' ').toLowerCase();
      const slot = p.inventory.findIndex(s => s && s.name.toLowerCase() === name);
      if (slot < 0) return `You don't have "${name}".`;
      const item = p.inventory[slot];
      const heal = items.FOOD_HEAL[item.id];
      if (!heal) return `You can't eat ${item.name}.`;
      if (p.hp >= p.maxHp) return 'You are already at full health.';
      p.inventory[slot] = item.count > 1 ? { ...item, count: item.count - 1 } : null;
      const healed = Math.min(heal, p.maxHp - p.hp);
      p.hp += healed;
      return `You eat the ${item.name}. HP: ${p.hp}/${p.maxHp} (+${healed})`;
    }
  });

  // ── Bury bones ──────────────────────────────────────────────────────────────
  commands.register('bury', { help: 'Bury bones for Prayer XP: bury [bones]', category: 'Skills',
    fn: (p, args) => {
      const name = args.join(' ').toLowerCase() || 'bones';
      const slot = p.inventory.findIndex(s => s && s.name.toLowerCase().includes(name) && s.name.toLowerCase().includes('bone'));
      if (slot < 0) return `You don't have any bones.`;
      const item = p.inventory[slot];
      const xpMap = { 100: 4.5, 106: 15, 107: 72 }; // bones, big bones, dragon bones
      const xp = xpMap[item.id] || 4.5;
      p.inventory[slot] = item.count > 1 ? { ...item, count: item.count - 1 } : null;
      const lvl = addXp(p, 'prayer', xp);
      let msg = `You bury the ${item.name}. +${xp} Prayer XP.`;
      if (lvl) msg += ` Prayer level: ${lvl}!`;
      return msg;
    }
  });

  // ── Cooking ─────────────────────────────────────────────────────────────────
  commands.register('cook', { help: 'Cook food: cook [item]', category: 'Skills',
    fn: (p, args) => {
      const name = args.join(' ').toLowerCase();
      if (!name) {
        const available = recipes.forSkill('cooking').filter(r => getLevel(p, 'cooking') >= r.level);
        return 'Cooking recipes:\n' + available.map(r => `  ${r.name} (lvl ${r.level}, ${r.xp} XP)`).join('\n');
      }
      const recipe = recipes.forSkill('cooking').find(r => r.name.toLowerCase() === name || r.outputs[0]?.id === items.find(name)?.id);
      if (!recipe) return `Unknown recipe: ${name}. Type \`cook\` to see recipes.`;
      if (getLevel(p, 'cooking') < recipe.level) return `You need Cooking level ${recipe.level}.`;
      // Check inputs
      for (const input of recipe.inputs) {
        if (invCount(p, input.id) < input.count) {
          const itemDef = items.get(input.id);
          return `You need ${input.count}x ${itemDef ? itemDef.name : 'item'}.`;
        }
      }
      // Remove inputs
      for (const input of recipe.inputs) invRemove(p, input.id, input.count);
      // Burn check: linear interpolation from level to stopBurn
      const burnChance = recipe.stopBurn ? Math.max(0, (recipe.stopBurn - getLevel(p, 'cooking')) / recipe.stopBurn) : 0;
      if (Math.random() < burnChance) {
        if (recipe.failItem) invAdd(p, recipe.failItem, items.get(recipe.failItem)?.name || 'Burnt food', 1);
        return `You accidentally burn the ${recipe.name}.`;
      }
      // Success
      for (const output of recipe.outputs) {
        invAdd(p, output.id, items.get(output.id)?.name || recipe.name, output.count, items.get(output.id)?.stackable);
      }
      const lvl = addXp(p, 'cooking', recipe.xp);
      let msg = `You cook ${recipe.name}. +${recipe.xp} Cooking XP.`;
      if (lvl) msg += ` Cooking level: ${lvl}!`;
      return msg;
    }
  });

  // ── Smithing (smelt + smith) ────────────────────────────────────────────────
  commands.register('smelt', { help: 'Smelt ore into bars: smelt [bar]', category: 'Skills',
    fn: (p, args) => {
      const name = args.join(' ').toLowerCase();
      if (!name) {
        const available = recipes.forSkill('smithing').filter(r => r.station === 'furnace' && getLevel(p, 'smithing') >= r.level);
        return 'Smelting recipes:\n' + available.map(r => `  ${r.name} (lvl ${r.level}, ${r.xp} XP)`).join('\n');
      }
      const recipe = recipes.forSkill('smithing').find(r => r.station === 'furnace' && r.name.toLowerCase().includes(name));
      if (!recipe) return `Unknown smelting recipe: ${name}. Type \`smelt\` to see recipes.`;
      if (getLevel(p, 'smithing') < recipe.level) return `You need Smithing level ${recipe.level}.`;
      for (const input of recipe.inputs) {
        if (invCount(p, input.id) < input.count) return `You need ${input.count}x ${items.get(input.id)?.name || 'item'}.`;
      }
      // Fail chance (iron bar = 50%)
      if (recipe.failChance && Math.random() < recipe.failChance) {
        for (const input of recipe.inputs) invRemove(p, input.id, input.count);
        return `The ore is too impure. You fail to smelt a bar.`;
      }
      for (const input of recipe.inputs) invRemove(p, input.id, input.count);
      for (const output of recipe.outputs) invAdd(p, output.id, items.get(output.id)?.name || recipe.name, output.count, items.get(output.id)?.stackable);
      const lvl = addXp(p, 'smithing', recipe.xp);
      let msg = `You smelt a ${recipe.name}. +${recipe.xp} Smithing XP.`;
      if (lvl) msg += ` Smithing level: ${lvl}!`;
      return msg;
    }
  });

  commands.register('smith', { help: 'Smith bars into items: smith [item]', category: 'Skills',
    fn: (p, args) => {
      const name = args.join(' ').toLowerCase();
      if (!name) {
        const available = recipes.forSkill('smithing').filter(r => r.station === 'anvil' && getLevel(p, 'smithing') >= r.level);
        return 'Smithing recipes:\n' + available.map(r => `  ${r.name} (lvl ${r.level}, ${r.xp} XP)`).join('\n');
      }
      const recipe = recipes.forSkill('smithing').find(r => r.station === 'anvil' && r.name.toLowerCase().includes(name));
      if (!recipe) return `Unknown smithing recipe: ${name}. Type \`smith\` to see recipes.`;
      if (getLevel(p, 'smithing') < recipe.level) return `You need Smithing level ${recipe.level}.`;
      if (!invCount(p, 570)) return 'You need a hammer.';
      for (const input of recipe.inputs) {
        if (invCount(p, input.id) < input.count) return `You need ${input.count}x ${items.get(input.id)?.name || 'item'}.`;
      }
      for (const input of recipe.inputs) invRemove(p, input.id, input.count);
      for (const output of recipe.outputs) invAdd(p, output.id, items.get(output.id)?.name || recipe.name, output.count);
      const lvl = addXp(p, 'smithing', recipe.xp);
      let msg = `You smith a ${recipe.name}. +${recipe.xp} Smithing XP.`;
      if (lvl) msg += ` Smithing level: ${lvl}!`;
      return msg;
    }
  });

  // ── Crafting ────────────────────────────────────────────────────────────────
  commands.register('craft', { help: 'Craft items: craft [item]', category: 'Skills',
    fn: (p, args) => {
      const name = args.join(' ').toLowerCase();
      if (!name) {
        const available = recipes.forSkill('crafting').filter(r => getLevel(p, 'crafting') >= r.level);
        return 'Crafting recipes:\n' + available.map(r => `  ${r.name} (lvl ${r.level}, ${r.xp} XP)`).join('\n');
      }
      const recipe = recipes.forSkill('crafting').find(r => r.name.toLowerCase().includes(name));
      if (!recipe) return `Unknown crafting recipe: ${name}. Type \`craft\` to see recipes.`;
      if (getLevel(p, 'crafting') < recipe.level) return `You need Crafting level ${recipe.level}.`;
      for (const input of recipe.inputs) {
        if (invCount(p, input.id) < input.count) return `You need ${input.count}x ${items.get(input.id)?.name || 'item'}.`;
      }
      for (const input of recipe.inputs) invRemove(p, input.id, input.count);
      for (const output of recipe.outputs) invAdd(p, output.id, items.get(output.id)?.name || recipe.name, output.count, items.get(output.id)?.stackable);
      const lvl = addXp(p, 'crafting', recipe.xp);
      let msg = `You craft ${recipe.name}. +${recipe.xp} Crafting XP.`;
      if (lvl) msg += ` Crafting level: ${lvl}!`;
      return msg;
    }
  });

  // ── Fletching ───────────────────────────────────────────────────────────────
  commands.register('fletch', { help: 'Fletch items: fletch [item]', category: 'Skills',
    fn: (p, args) => {
      const name = args.join(' ').toLowerCase();
      if (!name) {
        const available = recipes.forSkill('fletching').filter(r => getLevel(p, 'fletching') >= r.level);
        return 'Fletching recipes:\n' + available.map(r => `  ${r.name} (lvl ${r.level}, ${r.xp} XP)`).join('\n');
      }
      const recipe = recipes.forSkill('fletching').find(r => r.name.toLowerCase().includes(name));
      if (!recipe) return `Unknown fletching recipe: ${name}. Type \`fletch\` to see recipes.`;
      if (getLevel(p, 'fletching') < recipe.level) return `You need Fletching level ${recipe.level}.`;
      for (const input of recipe.inputs) {
        if (invCount(p, input.id) < input.count) return `You need ${input.count}x ${items.get(input.id)?.name || 'item'}.`;
      }
      for (const input of recipe.inputs) invRemove(p, input.id, input.count);
      for (const output of recipe.outputs) invAdd(p, output.id, items.get(output.id)?.name || recipe.name, output.count, items.get(output.id)?.stackable);
      const lvl = addXp(p, 'fletching', recipe.xp);
      let msg = `You fletch ${recipe.name}. +${recipe.xp} Fletching XP.`;
      if (lvl) msg += ` Fletching level: ${lvl}!`;
      return msg;
    }
  });

  // ── Herblore ────────────────────────────────────────────────────────────────
  commands.register('clean', { help: 'Clean a grimy herb: clean [herb]', category: 'Skills',
    fn: (p, args) => {
      const name = args.join(' ').toLowerCase();
      const recipe = recipes.forSkill('herblore').find(r => r.name.toLowerCase().includes(name) && r.id.startsWith('clean'));
      if (!recipe) return 'Usage: clean [herb name]. E.g., clean guam';
      if (getLevel(p, 'herblore') < recipe.level) return `You need Herblore level ${recipe.level}.`;
      if (invCount(p, recipe.inputs[0].id) < 1) return `You don't have any ${items.get(recipe.inputs[0].id)?.name || 'herbs'}.`;
      invRemove(p, recipe.inputs[0].id, 1);
      invAdd(p, recipe.outputs[0].id, items.get(recipe.outputs[0].id)?.name || recipe.name, 1);
      const lvl = addXp(p, 'herblore', recipe.xp);
      let msg = `You clean the herb. +${recipe.xp} Herblore XP.`;
      if (lvl) msg += ` Herblore level: ${lvl}!`;
      return msg;
    }
  });

  commands.register('mix', { help: 'Mix a potion: mix [potion]', category: 'Skills',
    fn: (p, args) => {
      const name = args.join(' ').toLowerCase();
      if (!name) {
        const available = recipes.forSkill('herblore').filter(r => r.id.startsWith('mix') && getLevel(p, 'herblore') >= r.level);
        return 'Potion recipes:\n' + available.map(r => `  ${r.name} (lvl ${r.level}, ${r.xp} XP)`).join('\n');
      }
      const recipe = recipes.forSkill('herblore').find(r => r.id.startsWith('mix') && r.name.toLowerCase().includes(name));
      if (!recipe) return `Unknown potion: ${name}. Type \`mix\` to see recipes.`;
      if (getLevel(p, 'herblore') < recipe.level) return `You need Herblore level ${recipe.level}.`;
      for (const input of recipe.inputs) {
        if (invCount(p, input.id) < input.count) return `You need ${items.get(input.id)?.name || 'item'}.`;
      }
      for (const input of recipe.inputs) invRemove(p, input.id, input.count);
      for (const output of recipe.outputs) invAdd(p, output.id, items.get(output.id)?.name || recipe.name, output.count);
      const lvl = addXp(p, 'herblore', recipe.xp);
      let msg = `You mix a ${recipe.name}. +${recipe.xp} Herblore XP.`;
      if (lvl) msg += ` Herblore level: ${lvl}!`;
      return msg;
    }
  });

  // ── Firemaking ──────────────────────────────────────────────────────────────
  commands.register('light', { help: 'Light logs: light [logs]', aliases: ['burn'], category: 'Skills',
    fn: (p, args) => {
      const name = args.join(' ').toLowerCase() || 'logs';
      const recipe = recipes.forSkill('firemaking').find(r => r.name.toLowerCase().includes(name));
      if (!recipe) return `Unknown: ${name}. Type \`light\` with: logs, oak, willow, maple, yew, magic`;
      if (getLevel(p, 'firemaking') < recipe.level) return `You need Firemaking level ${recipe.level}.`;
      if (!invCount(p, 573)) return 'You need a tinderbox.';
      if (invCount(p, recipe.inputs[0].id) < 1) return `You don't have any ${items.get(recipe.inputs[0].id)?.name}.`;
      invRemove(p, recipe.inputs[0].id, 1);
      const lvl = addXp(p, 'firemaking', recipe.xp);
      let msg = `You light the ${items.get(recipe.inputs[0].id)?.name}. +${recipe.xp} Firemaking XP.`;
      if (lvl) msg += ` Firemaking level: ${lvl}!`;
      return msg;
    }
  });

  // ── High Alchemy ────────────────────────────────────────────────────────────
  commands.register('alch', { help: 'High alchemy: alch [item]', aliases: ['highalch'], category: 'Skills',
    fn: (p, args) => {
      const name = args.join(' ').toLowerCase();
      const slot = p.inventory.findIndex(s => s && s.name.toLowerCase() === name);
      if (slot < 0) return `You don't have "${name}".`;
      if (getLevel(p, 'magic') < 55) return 'You need Magic level 55.';
      if (invCount(p, 278) < 1) return 'You need a nature rune.';
      if (invCount(p, 273) < 5) return 'You need 5 fire runes.';
      const item = p.inventory[slot];
      const def = items.get(item.id) || items.find(item.name);
      const value = def ? def.highAlch : Math.floor((def?.value || 1) * 0.6);
      p.inventory[slot] = item.count > 1 ? { ...item, count: item.count - 1 } : null;
      invRemove(p, 278, 1); // nature rune
      invRemove(p, 273, 5); // fire runes
      invAdd(p, 101, 'Coins', value, true);
      const lvl = addXp(p, 'magic', 65);
      let msg = `You alch the ${item.name} for ${value} coins. +65 Magic XP.`;
      if (lvl) msg += ` Magic level: ${lvl}!`;
      return msg;
    }
  });

  // ── Shops ───────────────────────────────────────────────────────────────────
  commands.register('shop', { help: 'Browse a shop: shop [name] or shop', category: 'Economy',
    fn: (p, args) => {
      const name = args.join(' ').toLowerCase();
      let shop;
      if (name) {
        shop = shops.findByNpc(name) || shops.getShop(name);
      } else {
        // Find nearby shop NPC
        const nearby = npcs.getNpcsNear(p.x, p.y, 5, p.layer);
        for (const npc of nearby) {
          shop = shops.findByNpc(npc.name);
          if (shop) break;
        }
      }
      if (!shop) return 'No shop found. Try: shop [shopkeeper name]';
      let out = `── ${shop.name} ──\n`;
      shop.stock.forEach((s, i) => {
        const price = shops.buyPrice(shop, i);
        out += `  [${i}] ${s.name} — ${price} coins (stock: ${s.current})\n`;
      });
      out += `\nType \`buy [number] [amount]\` or \`sell [item]\``;
      p._currentShop = shop.id;
      return out;
    }
  });

  commands.register('buy', { help: 'Buy from shop: buy [slot] [amount]', category: 'Economy',
    fn: (p, args) => {
      if (!p._currentShop) return 'Open a shop first with `shop`.';
      const shop = shops.getShop(p._currentShop);
      if (!shop) return 'Shop not found.';
      const slot = parseInt(args[0]);
      const count = parseInt(args[1]) || 1;
      if (isNaN(slot)) return 'Usage: buy [slot number] [amount]';
      const result = shops.buy(shop, slot, count);
      if (!result) return 'Out of stock or invalid slot.';
      if (invCount(p, 101) < result.price) return `You need ${result.price} coins. You have ${invCount(p, 101)}.`;
      invRemove(p, 101, result.price);
      const itemDef = items.get(result.itemId);
      invAdd(p, result.itemId, result.name, result.count, itemDef?.stackable);
      return `Bought ${result.count}x ${result.name} for ${result.price} coins.`;
    }
  });

  commands.register('sell', { help: 'Sell to shop: sell [item]', category: 'Economy',
    fn: (p, args) => {
      if (!p._currentShop) return 'Open a shop first with `shop`.';
      const shop = shops.getShop(p._currentShop);
      if (!shop) return 'Shop not found.';
      const name = args.join(' ').toLowerCase();
      const slot = p.inventory.findIndex(s => s && s.name.toLowerCase() === name);
      if (slot < 0) return `You don't have "${name}".`;
      const item = p.inventory[slot];
      const def = items.get(item.id) || items.find(item.name);
      const value = def ? def.value : 1;
      const price = shops.sell(shop, item.id, item.name, 1, value);
      p.inventory[slot] = item.count > 1 ? { ...item, count: item.count - 1 } : null;
      invAdd(p, 101, 'Coins', price, true);
      return `Sold ${item.name} for ${price} coins.`;
    }
  });

  // ── Item lookup ─────────────────────────────────────────────────────────────
  commands.register('item', { help: 'Lookup item: item [name]', aliases: ['iteminfo'], category: 'Items',
    fn: (p, args) => {
      const name = args.join(' ');
      const def = items.find(name);
      if (!def) {
        const results = items.search(name);
        if (results.length === 0) return `No item found: "${name}"`;
        return `Did you mean:\n` + results.slice(0, 10).map(i => `  ${i.name} (id: ${i.id})`).join('\n');
      }
      let out = `── ${def.name} ──\n  ${def.examine}\n`;
      out += `  Value: ${def.value} | High Alch: ${def.highAlch} | Weight: ${def.weight}kg\n`;
      out += `  Tradeable: ${def.tradeable ? 'Yes' : 'No'} | Stackable: ${def.stackable ? 'Yes' : 'No'}\n`;
      if (def.equipSlot) out += `  Equip: ${def.equipSlot}${def.speed ? ` | Speed: ${def.speed}` : ''}\n`;
      if (Object.keys(def.stats).length) out += `  Stats: ${Object.entries(def.stats).map(([k,v]) => `${k}:${v}`).join(', ')}\n`;
      if (Object.keys(def.equipReqs).length) out += `  Requires: ${Object.entries(def.equipReqs).map(([k,v]) => `${k} ${v}`).join(', ')}\n`;
      return out;
    }
  });

  // ── Quests ──────────────────────────────────────────────────────────────────
  commands.register('quests', { help: 'List quests', aliases: ['questlist'], category: 'Quests',
    fn: (p) => {
      const all = quests.listAll();
      let out = `Quests (${all.length}):\n`;
      for (const q of all) {
        const status = quests.getStatus(p, q.id);
        const icon = status.complete ? '[✓]' : status.started ? '[~]' : '[ ]';
        out += `  ${icon} ${q.name} (${q.difficulty}, ${q.questPoints} QP)\n`;
      }
      out += `\nQuest Points: ${quests.getQuestPoints(p)}`;
      return out;
    }
  });

  commands.register('quest', { help: 'Quest info/progress: quest [name]', category: 'Quests',
    fn: (p, args) => {
      const name = args.join(' ').toLowerCase();
      const quest = [...quests.quests.values()].find(q => q.name.toLowerCase().includes(name));
      if (!quest) return `Unknown quest: "${name}". Type \`quests\` to see all.`;
      const status = quests.getStatus(p, quest.id);
      let out = `── ${quest.name} ── (${quest.difficulty})\n${quest.description}\n`;
      out += `QP: ${quest.questPoints} | Status: ${status.complete ? 'COMPLETE' : status.started ? `Step ${status.step + 1}/${quest.steps.length}` : 'Not started'}\n`;
      if (status.started && !status.complete) {
        out += `\nCurrent step: ${quest.steps[status.step].text}\n`;
      }
      if (Object.keys(quest.requirements).length) {
        if (quest.requirements.skills) out += `Requirements: ${Object.entries(quest.requirements.skills).map(([k,v]) => `${k} ${v}`).join(', ')}\n`;
      }
      return out;
    }
  });

  commands.register('startquest', { help: 'Start a quest: startquest [name]', category: 'Quests',
    fn: (p, args) => {
      const name = args.join(' ').toLowerCase();
      const quest = [...quests.quests.values()].find(q => q.name.toLowerCase().includes(name));
      if (!quest) return `Unknown quest: "${name}".`;
      const status = quests.getStatus(p, quest.id);
      if (status.complete) return 'Already completed.';
      if (status.started) return `Already started (step ${status.step + 1}).`;
      if (!quests.meetsRequirements(p, quest, getLevel)) return 'You don\'t meet the requirements.';
      quests.startQuest(p, quest.id);
      return `Quest started: ${quest.name}\n${quest.steps[0].text}`;
    }
  });

  commands.register('questadvance', { help: 'Advance quest step (debug)', category: 'Quests', admin: true,
    fn: (p, args) => {
      const name = args.join(' ').toLowerCase();
      const quest = [...quests.quests.values()].find(q => q.name.toLowerCase().includes(name));
      if (!quest) return 'Unknown quest.';
      const result = quests.advanceStep(p, quest.id);
      if (result === 'complete') {
        let msg = `Quest complete: ${quest.name}! +${quest.questPoints} QP`;
        if (quest.rewards.xp) {
          for (const [skill, xp] of Object.entries(quest.rewards.xp)) {
            addXp(p, skill, xp);
            msg += `\n  +${xp} ${skill} XP`;
          }
        }
        return msg;
      }
      if (result !== null) return `Step ${result + 1}: ${quest.steps[result].text}`;
      return 'Cannot advance.';
    }
  });

  // ── Slayer ──────────────────────────────────────────────────────────────────
  commands.register('task', { help: 'Show current slayer task', aliases: ['slayertask'], category: 'Combat',
    fn: (p) => {
      if (!p.slayerTask) return 'No slayer task. Talk to a slayer master with `slayer [master]`.';
      return `Slayer task: Kill ${p.slayerTask.remaining}/${p.slayerTask.count} ${p.slayerTask.monster}s. Streak: ${p.slayerStreak || 0}. Points: ${p.slayerPoints || 0}.`;
    }
  });

  commands.register('slayer', { help: 'Get slayer task: slayer [master]', category: 'Combat',
    fn: (p, args) => {
      const masterName = args.join(' ').toLowerCase() || 'turael';
      const master = [...slayer.masters.values()].find(m => m.name.toLowerCase() === masterName);
      if (!master) return `Unknown master: ${masterName}. Masters: ${[...slayer.masters.values()].map(m => m.name).join(', ')}`;
      if (p.slayerTask && p.slayerTask.remaining > 0) return `You already have a task: ${p.slayerTask.remaining} ${p.slayerTask.monster}s remaining.`;
      const task = slayer.assignTask(p, master.id, getLevel);
      if (!task) return 'No suitable tasks available.';
      p.slayerTask = task;
      return `${master.name}: "Your task is to kill ${task.count} ${task.monster}s."`;
    }
  });

  // ── Friends ─────────────────────────────────────────────────────────────────
  commands.register('friends', { help: 'Show friends list', aliases: ['fl'], category: 'Social',
    fn: (p) => {
      if (!p.friends) p.friends = [];
      if (!p.friends.length) return 'Friends list is empty. Use `friend add [name]`.';
      let out = 'Friends:\n';
      for (const name of p.friends) {
        const online = playersByName.has(name.toLowerCase());
        out += `  ${online ? '●' : '○'} ${name} ${online ? '(online)' : '(offline)'}\n`;
      }
      return out;
    }
  });

  commands.register('friend', { help: 'Add/remove friend: friend add/remove [name]', category: 'Social',
    fn: (p, args) => {
      if (!p.friends) p.friends = [];
      const action = args[0]?.toLowerCase();
      const name = args.slice(1).join(' ');
      if (action === 'add' && name) {
        if (p.friends.includes(name)) return 'Already on friends list.';
        if (p.friends.length >= 400) return 'Friends list full (400).';
        p.friends.push(name);
        return `Added ${name} to friends list.`;
      }
      if (action === 'remove' && name) {
        const idx = p.friends.findIndex(f => f.toLowerCase() === name.toLowerCase());
        if (idx < 0) return 'Not on friends list.';
        p.friends.splice(idx, 1);
        return `Removed ${name} from friends list.`;
      }
      return 'Usage: friend add [name] / friend remove [name]';
    }
  });

  // ── Ignore ──────────────────────────────────────────────────────────────────
  commands.register('ignore', { help: 'Ignore a player: ignore [name]', category: 'Social',
    fn: (p, args) => {
      if (!p.ignoreList) p.ignoreList = [];
      const name = args.join(' ');
      if (!name) return `Ignore list: ${p.ignoreList.join(', ') || 'empty'}`;
      if (p.ignoreList.includes(name.toLowerCase())) return 'Already ignored.';
      p.ignoreList.push(name.toLowerCase());
      return `Ignoring ${name}.`;
    }
  });

  commands.register('unignore', { help: 'Unignore a player', category: 'Social',
    fn: (p, args) => {
      if (!p.ignoreList) p.ignoreList = [];
      const name = args.join(' ').toLowerCase();
      const idx = p.ignoreList.indexOf(name);
      if (idx < 0) return 'Not on ignore list.';
      p.ignoreList.splice(idx, 1);
      return `Unignored ${name}.`;
    }
  });

  // ── Trade ───────────────────────────────────────────────────────────────────
  commands.register('trade', { help: 'Trade with player: trade [name]', category: 'Economy',
    fn: (p, args) => {
      const name = args.join(' ');
      const target = findPlayer(name);
      if (!target) return `Player "${name}" not found.`;
      if (target === p) return "You can't trade with yourself.";
      // Simplified: just show both inventories
      let out = `── Trade with ${target.name} ──\n`;
      out += `Your inventory:\n`;
      p.inventory.filter(s => s).forEach((s, i) => { out += `  ${s.name}${s.count > 1 ? ` x${s.count}` : ''}\n`; });
      out += `\nTheir inventory:\n`;
      target.inventory.filter(s => s).forEach((s, i) => { out += `  ${s.name}${s.count > 1 ? ` x${s.count}` : ''}\n`; });
      out += `\nUse \`give [player] [item]\` to transfer items directly (trust trade).`;
      return out;
    }
  });

  commands.register('giveto', { help: 'Give item to player: giveto [player] [item]', category: 'Economy',
    fn: (p, args) => {
      if (args.length < 2) return 'Usage: giveto [player] [item name]';
      const targetName = args[0];
      const itemName = args.slice(1).join(' ').toLowerCase();
      const target = findPlayer(targetName);
      if (!target) return `Player "${targetName}" not found.`;
      const slot = p.inventory.findIndex(s => s && s.name.toLowerCase() === itemName);
      if (slot < 0) return `You don't have "${itemName}".`;
      if (invFreeSlots(target) < 1) return `${target.name}'s inventory is full.`;
      const item = p.inventory[slot];
      p.inventory[slot] = item.count > 1 ? { ...item, count: item.count - 1 } : null;
      invAdd(target, item.id, item.name, 1, items.get(item.id)?.stackable);
      // Notify target
      for (const [ws, pl] of players) {
        if (pl === target) { sendText(ws, `${p.name} gave you: ${item.name}`); break; }
      }
      return `Gave ${item.name} to ${target.name}.`;
    }
  });

  // ── Death system ────────────────────────────────────────────────────────────
  // Already handled in combatTick, but add respawn info
  commands.register('death', { help: 'Show death rules', category: 'General',
    fn: (p) => {
      return 'Death rules:\n  - You keep your 3 most valuable items.\n  - Other items appear at your gravestone for 15 minutes.\n  - Respawn at last home location.\n  - Protect Item prayer: keep 1 extra item.';
    }
  });

  // ── Hiscores ────────────────────────────────────────────────────────────────
  commands.register('hiscores', { help: 'Show skill rankings', aliases: ['hs', 'ranks'], category: 'General',
    fn: (p, args) => {
      const skill = args[0]?.toLowerCase() || 'total';
      // Collect all saved player data
      const fs = require('fs');
      const path = require('path');
      const playersDir = path.join(persistence.DATA_DIR, 'players');
      if (!fs.existsSync(playersDir)) return 'No hiscores data.';
      const allPlayers = [];
      // Include online players
      for (const pl of playersByName.values()) {
        allPlayers.push({ name: pl.name, skills: pl.skills });
      }
      if (skill === 'total') {
        allPlayers.sort((a, b) => {
          const ta = Object.values(b.skills).reduce((s, sk) => s + sk.level, 0);
          const tb = Object.values(a.skills).reduce((s, sk) => s + sk.level, 0);
          return ta - tb;
        });
        let out = '── Hiscores (Total Level) ──\n';
        allPlayers.slice(0, 20).forEach((pl, i) => {
          const total = Object.values(pl.skills).reduce((s, sk) => s + sk.level, 0);
          out += `  ${i + 1}. ${pl.name} — ${total}\n`;
        });
        return out;
      }
      if (!allPlayers[0]?.skills[skill]) return `Unknown skill: ${skill}`;
      allPlayers.sort((a, b) => (b.skills[skill]?.xp || 0) - (a.skills[skill]?.xp || 0));
      let out = `── Hiscores (${skill}) ──\n`;
      allPlayers.slice(0, 20).forEach((pl, i) => {
        out += `  ${i + 1}. ${pl.name} — Level ${pl.skills[skill]?.level || 1} (${(pl.skills[skill]?.xp || 0).toLocaleString()} XP)\n`;
      });
      return out;
    }
  });

  // ── Emotes ──────────────────────────────────────────────────────────────────
  const EMOTES = ['wave', 'bow', 'dance', 'clap', 'cry', 'laugh', 'think', 'shrug', 'yes', 'no',
    'angry', 'cheer', 'beckon', 'panic', 'sit', 'push-up', 'headbang', 'salute', 'stomp', 'flex',
    'spin', 'yawn', 'stretch', 'blow kiss', 'jig', 'goblin bow', 'goblin salute'];

  commands.register('emote', { help: 'Perform emote: emote [name]', category: 'Social',
    fn: (p, args) => {
      const name = args.join(' ').toLowerCase();
      if (!name) return 'Emotes: ' + EMOTES.join(', ');
      if (!EMOTES.includes(name)) return `Unknown emote. Available: ${EMOTES.join(', ')}`;
      broadcast({ t: 'emote', from: p.name, emote: name });
      return `You perform the ${name} emote.`;
    }
  });

  // ── World info ──────────────────────────────────────────────────────────────
  commands.register('world', { help: 'Show world info', category: 'General',
    fn: () => {
      return `World 1 — OpenScape\nPlayers: ${playersByName.size}\nTick: ${tick.getTick()}\nUptime: ${Math.floor(tick.getTick() * 0.6)}s`;
    }
  });

  // ── Recipes browser ─────────────────────────────────────────────────────────
  commands.register('recipes', { help: 'Browse recipes: recipes [skill]', category: 'Skills',
    fn: (p, args) => {
      const skill = args[0]?.toLowerCase();
      if (!skill) return 'Usage: recipes [cooking/smithing/crafting/fletching/herblore/firemaking]';
      const list = recipes.forSkill(skill);
      if (!list.length) return `No recipes for ${skill}.`;
      let out = `── ${skill} recipes ──\n`;
      for (const r of list) {
        const canMake = getLevel(p, skill) >= r.level;
        const inputs = r.inputs.map(i => `${i.count}x ${items.get(i.id)?.name || '?'}`).join(' + ');
        const outputs = r.outputs.length ? r.outputs.map(o => `${o.count}x ${items.get(o.id)?.name || '?'}`).join(', ') : '(none)';
        out += `  ${canMake ? '✓' : '✕'} ${r.name} — ${inputs} → ${outputs} (lvl ${r.level}, ${r.xp} XP)\n`;
      }
      return out;
    }
  });

  // ── Rest (run energy recovery) ──────────────────────────────────────────────
  commands.register('rest', { help: 'Rest to recover run energy faster', category: 'Navigation',
    fn: (p) => {
      p.runEnergy = Math.min(10000, p.runEnergy + 2000);
      return `You rest for a moment. Energy: ${(p.runEnergy / 100).toFixed(0)}%`;
    }
  });

  // ── Home teleport ───────────────────────────────────────────────────────────
  commands.register('home', { help: 'Teleport home (to spawn)', category: 'Navigation',
    fn: (p) => {
      p.x = 100; p.y = 100; p.layer = 0; p.path = [];
      return 'You teleport home to Spawn Island.';
    }
  });
};
