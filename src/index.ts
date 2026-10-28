import { Client, Events, GatewayIntentBits, REST, Routes } from 'discord.js';
import { config } from './config';
import type { BotModule } from './types';
import { respond } from './util';

import * as general from './modules/general';
import * as setupModule from './modules/setup';
import * as music from './modules/music';
import * as privateVoice from './modules/privateVoice';
import * as welcome from './modules/welcome';
import * as roles from './modules/roles';
import * as news from './modules/news';
import * as anime from './modules/anime';

const modules: BotModule[] = [general, setupModule, music, privateVoice, welcome, roles, news, anime];

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // нужен включённый Server Members Intent в Developer Portal
    GatewayIntentBits.GuildVoiceStates,
  ],
  rest: {
    // Discord разрешает менять канал (название и т.п.) редко. По умолчанию discord.js в таком случае
    // молча ждёт до 10 минут, и кнопка «зависает». Вместо этого получаем ошибку и объясняем пользователю.
    rejectOnRateLimit: (data) => data.method === 'PATCH' && data.route.startsWith('/channels'),
  },
});

// Карта «имя команды → модуль»
const commandOwners = new Map<string, BotModule>();
for (const m of modules) for (const c of m.commands ?? []) commandOwners.set(c.name, m);

for (const m of modules) m.setup?.(client);

client.once(Events.ClientReady, async (c) => {
  console.log(`[bot] Вошёл как ${c.user.tag}`);
  const body = modules.flatMap((m) => (m.commands ?? []).map((cmd) => cmd.toJSON()));
  try {
    const rest = new REST().setToken(config.token);
    await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body });
    console.log(`[bot] Зарегистрировано команд: ${body.length}`);
  } catch (e) {
    console.error('[bot] Не удалось зарегистрировать команды:', e);
  }
});

client.on(Events.InteractionCreate, async (i) => {
  try {
    if (i.isChatInputCommand()) {
      await commandOwners.get(i.commandName)?.onCommand?.(i);
      return;
    }
    if (i.isAutocomplete()) {
      await commandOwners.get(i.commandName)?.onAutocomplete?.(i);
      return;
    }
    if (i.isMessageComponent() || i.isModalSubmit()) {
      const prefix = i.customId.split(':')[0];
      const owner = modules.find((m) => m.componentPrefix === prefix);
      await owner?.onComponent?.(i);
    }
  } catch (e) {
    console.error('[bot] Ошибка при обработке взаимодействия:', e);
    if (i.isRepliable()) {
      await respond(i, '🦆 Кря… что-то пошло не так. Попробуй ещё раз.').catch(() => {});
    }
  }
});

process.on('unhandledRejection', (e) => console.error('[bot] Необработанная ошибка:', e));

client.login(config.token);
