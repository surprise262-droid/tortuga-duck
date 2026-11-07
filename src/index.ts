import { Client, Events, GatewayIntentBits, PermissionsBitField, REST, Routes } from 'discord.js';
import { db } from './db';
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
import * as games from './modules/games';
import * as movies from './modules/movies';
import * as trailers from './modules/trailers';
import * as stations from './modules/stations';
import * as cleanup from './modules/cleanup';
import * as watchlist from './modules/watchlist';

const modules: BotModule[] = [general, setupModule, music, privateVoice, welcome, roles, news, anime, games, movies, trailers, stations, cleanup, watchlist];

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // нужен включённый Server Members Intent в Developer Portal
    GatewayIntentBits.GuildVoiceStates,
  ],
  // Бот никогда не пингует @everyone, @here и роли — даже если такой текст придёт из названия трека, станции или новости
  allowedMentions: { parse: ['users'] },
  // Сообщения в памяти держим недолго — бот не читает чат, а память на сервере не бесконечная
  sweepers: { messages: { interval: 3600, lifetime: 1800 } },
  rest: {
    // Discord разрешает менять канал (название и т.п.) редко. По умолчанию discord.js в таком случае
    // молча ждёт до 10 минут, и кнопка «зависает». Вместо этого получаем ошибку и объясняем пользователю.
    // Только сам канал (/channels/:id), а не сообщения в нём: правки плеера должны ждать очереди, а не падать
    rejectOnRateLimit: (data) => data.method === 'PATCH' && /^\/channels\/[^/]+$/.test(data.route),
  },
});

// Карта «имя команды → модуль»
const commandOwners = new Map<string, BotModule>();
for (const m of modules) for (const c of m.commands ?? []) commandOwners.set(c.name, m);

/** Команды «для админов»: права проверяем ещё и при выполнении, а не только скрываем команду в меню */
const commandPerms = new Map<string, bigint>();
for (const m of modules)
  for (const c of m.commands ?? []) {
    const perms = (c.toJSON() as any).default_member_permissions;
    if (perms != null && perms !== '0') commandPerms.set(c.name, BigInt(perms));
  }

for (const m of modules) m.setup?.(client);

client.on(Events.Error, (e) => console.error('[bot] Ошибка клиента Discord:', e));
client.on(Events.ShardError, (e) => console.error('[bot] Ошибка соединения с Discord:', e?.message ?? e));

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
      const need = commandPerms.get(i.commandName);
      if (need && !i.memberPermissions?.has(new PermissionsBitField(need))) {
        await respond(i, '🔒 Эта команда только для администраторов сервера.');
        return;
      }
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

// Docker при обновлении присылает SIGTERM: аккуратно выходим из голосовых и закрываем базу
let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    console.log(`[bot] Получен ${sig}, выключаюсь…`);
    const done = () => {
      try {
        db.close();
      } catch {
        /* уже закрыта */
      }
      process.exit(0);
    };
    (setTimeout(done, 5000) as any).unref?.();
    void client.destroy().finally(done);
  });
}

client.login(config.token);
