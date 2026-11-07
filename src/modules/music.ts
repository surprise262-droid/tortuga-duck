import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  GuildMember,
  MessageFlags,
  SlashCommandBuilder,
  StringSelectMenuOptionBuilder,
  StringSelectMenuBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
  type Message,
  type TextBasedChannel,
} from 'discord.js';
import { LavalinkManager, type Player, type Track } from 'lavalink-client';
import { config } from '../config';
import { db, getSetting, setSetting } from '../db';
import type { ComponentInteraction } from '../types';
import { baseEmbed, formatDuration, isManager, plain, respond, safeUrl, truncate } from '../util';
import { checkPublicUrl } from '../net';

export const componentPrefix = 'music';

let manager: LavalinkManager;
let botClient: Client | null = null;
/** guildId → сообщение-плеер */
const panels = new Map<string, Message>();
/** guildId → таймер обновления прогресс-бара */
const progressTimers = new Map<string, NodeJS.Timeout>();
/** guildId → таймер выхода из пустого канала */
const aloneTimers = new Map<string, NodeJS.Timeout>();

const ALONE_LEAVE_MS = 2 * 60_000;
const PREVIEW_MAX_MS = 31_000; // превью Go+ на SoundCloud длятся ~30 сек

// ───────────────────────── команды ─────────────────────────

export const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Включить трек или плейлист: название, ссылка SoundCloud/Spotify/Bandcamp или радио')
    .addStringOption((o) =>
      o.setName('query').setDescription('Начни вводить название — появятся варианты').setRequired(true).setAutocomplete(true),
    ),
  new SlashCommandBuilder()
    .setName('play_file')
    .setDescription('Включить свой аудиофайл (MP3, OGG, WAV, M4A, FLAC)')
    .addAttachmentOption((o) => o.setName('file').setDescription('Аудиофайл').setRequired(true)),
  new SlashCommandBuilder().setName('skip').setDescription('Пропустить текущий трек'),
  new SlashCommandBuilder().setName('pause').setDescription('Пауза'),
  new SlashCommandBuilder().setName('resume').setDescription('Продолжить'),
  new SlashCommandBuilder().setName('stop').setDescription('Остановить музыку и очистить очередь'),
  new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Громкость')
    .addIntegerOption((o) =>
      o.setName('level').setDescription('0–150 (по умолчанию 50)').setRequired(true).setMinValue(0).setMaxValue(150),
    ),
  new SlashCommandBuilder().setName('shuffle').setDescription('Режим перемешивания: вкл/выкл'),
  new SlashCommandBuilder()
    .setName('loop')
    .setDescription('Повтор')
    .addStringOption((o) =>
      o
        .setName('mode')
        .setDescription('Что повторять')
        .setRequired(true)
        .addChoices(
          { name: 'Выключить', value: 'off' },
          { name: 'Текущий трек', value: 'track' },
          { name: 'Всю очередь', value: 'queue' },
        ),
    ),
  new SlashCommandBuilder().setName('queue').setDescription('Показать очередь'),
  new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Убрать трек из очереди')
    .addIntegerOption((o) => o.setName('position').setDescription('Номер в /queue').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('nowplaying').setDescription('Показать плеер заново'),
  new SlashCommandBuilder().setName('radio').setDescription('Радио по текущему треку: вкл/выкл — бот сам добавляет похожие треки'),
];

// ───────────────────────── инициализация ─────────────────────────

export function setup(client: Client) {
  botClient = client;
  manager = new LavalinkManager({
    nodes: [
      {
        id: 'main',
        host: config.lavalink.host,
        port: config.lavalink.port,
        authorization: config.lavalink.password,
        retryAmount: 1000,
        retryDelay: 10_000,
      },
    ],
    sendToShard: (guildId, payload) => client.guilds.cache.get(guildId)?.shard?.send(payload),
    client: { id: config.clientId, username: 'Tortuga Duck' },
    autoSkip: true,
    playerOptions: {
      defaultSearchPlatform: 'scsearch',
      onDisconnect: { autoReconnect: true, destroyPlayer: false },
      onEmptyQueue: { destroyAfterMs: 5 * 60_000 },
      maxErrorsPerTime: { threshold: 10_000, maxAmount: 25 },
      requesterTransformer: (r: any) => ({ id: r?.id, username: r?.username }),
    },
    queueOptions: { maxPreviousTracks: 10 },
  } as any);

  client.on('raw', (d) => manager.sendRawData(d));
  client.once(Events.ClientReady, async (c) => {
    await manager.init({ id: c.user.id, username: c.user.username });
  });

  manager.nodeManager.on('connect', (node: any) => {
    console.log(`[music] Lavalink подключён (${node.id})`);
    // Прогрев: первый запрос к Spotify получает токен (это медленно) — делаем его заранее, а не на радио
    setTimeout(() => {
      void loadTracks('spsearch:imagine dragons believer', null).then((r) =>
        console.log(`[music] Spotify прогрет: ${r.tracks.length ? 'ок' : r.kind === 'error' ? `ошибка — ${r.error}` : 'пусто'}`),
      );
    }, 5000);
  });
  manager.nodeManager.on('error', (node: any, err: any) => console.error(`[music] Ошибка Lavalink (${node.id}):`, err?.message ?? err));
  manager.nodeManager.on('disconnect', (node: any) => console.warn(`[music] Lavalink отключился (${node.id})`));

  manager.on('trackStart', (player: Player, track: any) => {
    void showPanel(client, player, true);
    if (player.get('station')) return; // эфир не попадает в статистику и не запускает радио по треку
    try {
      if (track) recordPlay(track);
    } catch (e) {
      console.warn('[music] Статистика:', (e as Error).message);
    }
    if (player.get('radio')) player.set('radioSeed', track);
    void topUp(player).then(() => {
      if (player.get('radio') && player.queue.tracks.length < 3 && !lazyOf(player).length) void radioFill(player);
    });
  });
  manager.on('queueEnd', (player: Player) => {
    // Эфир оборвался — пусть модуль радио переподключит или переключит станцию
    if (player.get('station')) {
      stationEndHook?.(player, 'end');
      return;
    }
    // Сначала дозагружаем отложенные треки (плейлисты Spotify), потом радио
    if (lazyOf(player).length) {
      void topUp(player).then((n) => {
        if (!n) void showPanel(client, player, false);
      });
      return;
    }
    if (player.get('radio')) {
      void radioFill(player).then((n) => {
        if (!n) void showPanel(client, player, false);
      });
      return;
    }
    void showPanel(client, player, false);
  });
  manager.on('trackError', (player: Player, track: any, payload: any) => {
    console.warn('[music] Ошибка трека:', track?.info?.title, payload?.exception?.message);
    if (player.get('station')) {
      stationEndHook?.(player, 'error');
      return;
    }
    void onTrackFailed(client, player, track)
      .catch((e) => console.warn('[music] Замена трека:', (e as Error).message))
      .finally(() => setTimeout(() => void keepGoing(player), 500));
  });
  manager.on('trackStuck', (player: Player, track: any) => {
    console.warn('[music] Трек завис:', track?.info?.title);
    setTimeout(() => void keepGoing(player), 1500);
  });
  manager.on('playerDestroy', (player: Player) => void closePanel(player.guildId));

  // Уходим, если в канале никого не осталось
  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    const guildId = (newState.guild ?? oldState.guild).id;
    const player = manager?.getPlayer(guildId);
    if (!player?.voiceChannelId) return;
    const channel = newState.guild.channels.cache.get(player.voiceChannelId);
    if (!channel || !channel.isVoiceBased()) return;
    const humans = channel.members.filter((m) => !m.user.bot).size;
    if (humans === 0 && !aloneTimers.has(guildId)) {
      aloneTimers.set(
        guildId,
        setTimeout(() => {
          aloneTimers.delete(guildId);
          manager.getPlayer(guildId)?.destroy('alone');
        }, ALONE_LEAVE_MS),
      );
    } else if (humans > 0 && aloneTimers.has(guildId)) {
      clearTimeout(aloneTimers.get(guildId));
      aloneTimers.delete(guildId);
    }
  });
}

// ───────────────────────── права ─────────────────────────

function djModeOn() {
  return getSetting('dj_mode') === '1';
}

function isDj(member: GuildMember) {
  const djRole = getSetting('role.dj');
  return isManager(member) || (!!djRole && member.roles.cache.has(djRole));
}

/** Возвращает текст ошибки или null, если действие разрешено. */
function checkControl(member: GuildMember, player: Player | undefined, action: string): string | null {
  if (!player || !player.queue.current) return '🎵 Сейчас ничего не играет.';
  if (member.voice.channelId !== player.voiceChannelId) {
    return '🔇 Управлять музыкой можно только из голосового канала, где сидит бот.';
  }
  if (djModeOn() && !isDj(member)) {
    const requesterId = (player.queue.current.requester as any)?.id;
    if (action === 'skip' && requesterId === member.id) return null;
    return '🎧 Включён DJ-режим: это может только DJ. Свой трек можно пропустить самому.';
  }
  return null;
}

// ───────────────────────── команды: обработка ─────────────────────────

export async function onCommand(i: ChatInputCommandInteraction) {
  if (!i.inCachedGuild()) return;
  const member = i.member;
  const player = manager.getPlayer(i.guildId);

  switch (i.commandName) {
    case 'play':
      return play(i);
    case 'play_file':
      return playFile(i);

    case 'queue':
      return respond(i, { embeds: [queueEmbed(player)] });

    case 'nowplaying':
      if (!player?.queue.current) return respond(i, '🎵 Сейчас ничего не играет.');
      await respond(i, '👌 Плеер обновлён.');
      return showPanel(i.client, player, true, i.channelId, true);
  }

  const err = checkControl(member, player, i.commandName);
  if (err) return respond(i, err);
  const p = player!;
  if (p.get('station') && ['skip', 'shuffle', 'loop', 'remove', 'radio'].includes(i.commandName)) {
    return respond(i, '📻 Сейчас идёт радиостанция. Переключить — кнопка 🔀 «Другая станция» в плеере или `/station`; вернуться к трекам — `/play`.');
  }

  switch (i.commandName) {
    case 'skip':
      await skip(p);
      return respond(i, '⏭ Пропущено.');
    case 'pause':
      if (!p.paused) await p.pause();
      await refreshPanel(p);
      return respond(i, '⏸ Пауза.');
    case 'resume':
      if (p.paused) await p.resume();
      await refreshPanel(p);
      return respond(i, '▶️ Играем дальше.');
    case 'stop':
      await p.destroy('stop');
      return respond(i, '⏹ Музыка остановлена, очередь очищена.');
    case 'volume': {
      const level = i.options.getInteger('level', true);
      await p.setVolume(level);
      await refreshPanel(p);
      return respond(i, `🔊 Громкость: **${level}%**`);
    }
    case 'shuffle': {
      const on = toggleShuffle(p);
      await refreshPanel(p);
      return respond(i, on ? '🔀 Перемешивание **включено**.' : '➡️ Играем **по порядку**.');
    }
    case 'loop': {
      const mode = i.options.getString('mode', true) as 'off' | 'track' | 'queue';
      await p.setRepeatMode(mode);
      await refreshPanel(p);
      return respond(i, `🔁 Повтор: **${repeatLabel(mode)}**`);
    }
    case 'radio': {
      const on = await toggleRadio(p);
      await refreshPanel(p);
      return respond(
        i,
        on ? '📻 Радио **включено** — подбираю похожие треки.' : '📻 Радио **выключено**.',
        true,
      );
    }
    case 'remove': {
      const pos = i.options.getInteger('position', true);
      if (pos > p.queue.tracks.length) return respond(i, `❌ В очереди всего ${p.queue.tracks.length} треков.`);
      const [removed] = await p.queue.splice(pos - 1, 1);
      await refreshPanel(p);
      return respond(i, `🗑 Убран: **${(removed as any)?.info?.title ?? 'трек'}**`);
    }
  }
}

// ───────────────────────── загрузка треков ─────────────────────────

interface LoadResult {
  kind: 'track' | 'playlist' | 'search' | 'empty' | 'error';
  tracks: Track[];
  playlistName?: string;
  error?: string;
}

/**
 * Запрашиваем треки у Lavalink напрямую через REST (/v4/loadtracks).
 * Так бот не зависит от того, под каким именем плагин регистрирует источник
 * (SoundCloud обслуживает плагин Soundy, а не встроенный источник Lavalink).
 */
async function loadTracks(identifier: string, requester: unknown): Promise<LoadResult> {
  const { host, port, password } = config.lavalink;
  const url = `http://${host}:${port}/v4/loadtracks?identifier=${encodeURIComponent(identifier)}`;
  let body: any;
  try {
    const res = await fetch(url, { headers: { Authorization: password }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return { kind: 'error', tracks: [], error: `Lavalink ответил HTTP ${res.status}` };
    body = await res.json();
  } catch (e) {
    return { kind: 'error', tracks: [], error: `Lavalink недоступен: ${(e as Error).message}` };
  }

  const utils = manager.utils as any;
  const build = (raw: any): Track =>
    typeof utils?.buildTrack === 'function'
      ? utils.buildTrack(raw, requester)
      : ({ encoded: raw.encoded, info: raw.info, pluginInfo: raw.pluginInfo ?? {}, userData: raw.userData ?? {}, requester } as any);
  switch (body?.loadType) {
    case 'track':
      return { kind: 'track', tracks: [build(body.data)] };
    case 'search':
      return { kind: 'search', tracks: (body.data ?? []).map(build) };
    case 'playlist':
      return {
        kind: 'playlist',
        tracks: (body.data?.tracks ?? []).map(build),
        playlistName: body.data?.info?.name,
      };
    case 'error':
      return { kind: 'error', tracks: [], error: body.data?.message ?? body.data?.cause ?? 'неизвестная ошибка' };
    default:
      return { kind: 'empty', tracks: [] };
  }
}

/** Поиск по названию: сначала SoundCloud, если пусто или ошибка — Bandcamp. */
async function searchByText(text: string, requester: unknown): Promise<LoadResult> {
  let last: LoadResult = { kind: 'empty', tracks: [] };
  for (const prefix of ['scsearch', 'bcsearch']) {
    const res = await loadTracks(`${prefix}:${text}`, requester);
    if (res.tracks.length) {
      // Только оригиналы: ремиксы, slowed, каверы и т.п. — лишь если они есть в самом запросе
      const clean = res.tracks.filter((t) => !isAltered(t, text));
      if (clean.length) return { ...res, tracks: clean };
      last = { kind: 'empty', tracks: [] };
      continue;
    }
    if (res.kind === 'error') console.warn(`[music] ${prefix} «${text}»: ${res.error}`);
    last = res;
  }
  return last;
}

// ───────────────────────── подсказки при вводе /play ─────────────────────────

/** Кэш подсказок: запрос → варианты (Discord шлёт запрос почти на каждую букву) */
const suggestCache = new Map<string, { at: number; choices: { name: string; value: string }[] }>();
const SUGGEST_TTL_MS = 5 * 60_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

// ───────────────────────── популярное ─────────────────────────

/** Запоминаем, что включали на сервере — для подсказок «🔥 Популярное» */
function recordPlay(track: Track) {
  const info: any = track.info;
  if (!info?.title || info.isStream) return;
  const key = `${info.author ?? ''} ${info.title}`.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (!key) return;
  db.prepare(
    `INSERT INTO plays (key, title, author, uri, count, last_at) VALUES (?, ?, ?, ?, 1, ?)
     ON CONFLICT(key) DO UPDATE SET count = count + 1, last_at = excluded.last_at, uri = COALESCE(excluded.uri, uri)`,
  ).run(key, info.title, info.author ?? null, info.uri ?? null, Date.now());
}

function serverTop(limit: number) {
  return db
    .prepare('SELECT title, author, uri, count FROM plays ORDER BY count DESC, last_at DESC LIMIT ?')
    .all(limit) as { title: string; author: string | null; uri: string | null; count: number }[];
}

let chartCache: { at: number; items: { artist: string; title: string }[] } | null = null;

/** Мировой чарт Deezer (кэш на 6 часов) */
async function deezerChart(): Promise<{ artist: string; title: string }[]> {
  if (chartCache && Date.now() - chartCache.at < 6 * 60 * 60_000) return chartCache.items;
  try {
    const res = await fetch('https://api.deezer.com/chart/0/tracks?limit=25', { signal: AbortSignal.timeout(2000) });
    const json: any = await res.json();
    const items = (json?.data ?? []).map((t: any) => ({ artist: t.artist?.name ?? '', title: t.title_short ?? t.title ?? '' }));
    if (items.length) chartCache = { at: Date.now(), items };
    return items;
  } catch {
    return chartCache?.items ?? [];
  }
}

async function popularChoices(): Promise<{ name: string; value: string }[]> {
  const out: { name: string; value: string }[] = [];
  const seenKeys = new Set<string>();
  for (const p of serverTop(10)) {
    const label = `🔥 ${p.author ? `${p.author} — ` : ''}${p.title} · ${p.count}×`;
    const value = p.uri && p.uri.length <= 100 ? p.uri : `${p.author ?? ''} ${p.title}`.trim();
    out.push({ name: truncate(label, 100), value: value.slice(0, 100) });
    seenKeys.add(`${p.author ?? ''} ${p.title}`.toLowerCase());
  }
  for (const c of await withTimeout(deezerChart(), 2000) ?? []) {
    if (out.length >= 25) break;
    if (seenKeys.has(`${c.artist} ${c.title}`.toLowerCase())) continue;
    out.push({ name: truncate(`🌍 ${c.artist} — ${c.title}`, 100), value: `${c.artist} ${c.title}`.slice(0, 100) });
  }
  return out;
}

export async function onAutocomplete(i: AutocompleteInteraction) {
  if (i.commandName !== 'play') return;
  const typed = i.options.getFocused().trim();
  const asTyped = typed ? [{ name: `🔍 Искать: ${truncate(typed, 85)}`, value: typed.slice(0, 100) }] : [];

  // Пока ничего не введено — показываем популярное
  if (!typed) return i.respond(await popularChoices().catch(() => [])).catch(() => {});

  // Ссылки и слишком короткие запросы не ищем — просто подставляем как есть
  if (typed.length < 3 || /^https?:\/\//i.test(typed)) return i.respond(asTyped).catch(() => {});

  const key = typed.toLowerCase();
  const cached = suggestCache.get(key);
  if (cached && Date.now() - cached.at < SUGGEST_TTL_MS) return i.respond(cached.choices).catch(() => {});

  // Сначала — оригиналы из каталога (без каверов и чужих загрузок)
  const catalog = await catalogSearch(typed, 12, 1800).catch(() => null);
  if (catalog?.length) {
    const choices = [
      ...asTyped,
      ...catalog.map((c) => ({
        name: truncate(`${c.artist} — ${c.title} (${formatDuration(c.durationMs)})`, 100),
        value: `dz:${c.id}`,
      })),
    ].slice(0, 25);
    suggestCache.set(key, { at: Date.now(), choices });
    if (suggestCache.size > 500) suggestCache.delete(suggestCache.keys().next().value as string);
    return i.respond(choices).catch(() => {});
  }

  // Каталог не ответил — запасной вариант: поиск SoundCloud. У Discord на ответ 3 секунды
  const res = await withTimeout(loadTracks(`scsearch:${typed}`, null), 1000);
  const found = (res?.tracks ?? [])
    .filter((t) => t.info.isStream || (t.info.duration ?? 0) > PREVIEW_MAX_MS)
    .slice(0, 15)
    .map((t) => {
      const name = `${t.info.author ? `${t.info.author} — ` : ''}${t.info.title} (${t.info.isStream ? 'эфир' : formatDuration(t.info.duration)})`;
      // Ссылка на трек — чтобы включился именно выбранный вариант (лимит Discord — 100 символов)
      const value = t.info.uri && t.info.uri.length <= 100 ? t.info.uri : `${t.info.author ?? ''} ${t.info.title}`.trim();
      return { name: truncate(name, 100), value: value.slice(0, 100) };
    });

  const choices = [...asTyped, ...found].slice(0, 25);
  if (res) {
    suggestCache.set(key, { at: Date.now(), choices });
    if (suggestCache.size > 500) suggestCache.delete(suggestCache.keys().next().value as string);
  }
  return i.respond(choices).catch(() => {});
}

// ───────────────────────── поиск на SoundCloud и отложенная очередь ─────────────────────────
//
// Треки Spotify (ссылки, плейлисты, радио) не играем «как есть»: бот сам находит каждый на SoundCloud.
// Плейлисты кладутся в отложенную очередь и находятся по ходу, по несколько треков вперёд.

interface LazyItem {
  artist: string;
  title: string;
  durationMs?: number;
  requester: unknown;
}

const lazyBusy = new Set<string>();
const lazyOf = (player: Player): LazyItem[] => player.get('lazy') ?? [];
const isSpotifyTrack = (t: Track) => (t.info as any)?.sourceName === 'spotify';
const toLazy = (t: Track, requester: unknown): LazyItem => ({
  artist: t.info.author ?? '',
  title: t.info.title ?? '',
  durationMs: t.info.duration ?? undefined,
  requester,
});

/** Ищет трек на SoundCloud; при нескольких вариантах берёт ближайший по длительности. */
// Загрузки SoundCloud, которые не воспроизводятся (обычно официальные треки лейблов только для Go+).
// Запоминаем на 30 дней и больше не выбираем.
const BAD_TTL_MS = 30 * 24 * 60 * 60_000;
function isBad(uri?: string | null) {
  if (!uri) return false;
  const row = db.prepare('SELECT ts FROM sc_bad WHERE uri = ?').get(uri) as { ts: number } | undefined;
  return !!row && Date.now() - row.ts < BAD_TTL_MS;
}
function markBad(uri?: string | null) {
  if (!uri) return;
  db.prepare('INSERT INTO sc_bad (uri, ts) VALUES (?, ?) ON CONFLICT(uri) DO UPDATE SET ts = excluded.ts').run(uri, Date.now());
}

/** Прикрепляет к треку запасные варианты — если он не заиграет, бот попробует следующий */
function withAlternatives(main: Track, others: Track[]): Track {
  const alts = others.map((t) => t.info.uri).filter((u): u is string => !!u && u !== main.info.uri && !isBad(u)).slice(0, 4);
  (main as any).userData = { ...((main as any).userData ?? {}), alts };
  return main;
}

// Слова, по которым узнаются каверы, ремиксы и прочие «не оригиналы»
const JUNK_WORDS = /(cover|remix|flip|mash ?-?up|slowed|reverb|sped ?up|speed ?up|nightcore|karaoke|instrumental|\blive\b|\bedit\b|\b8d\b|bass ?boost|lo-?fi|acoustic|piano|tribute|8-?bit|кавер|ремикс|караоке|минус|медлен|ускор)/gi;
/**
 * Приводим «модные» буквы к обычным: 𝙨𝙡𝙤𝙬𝙚𝙙, ｓｌｏｗｅｄ, 𝓈𝓁𝑜𝓌𝑒𝒹 → slowed (NFKC).
 * Иначе загрузки с такими названиями обходят все фильтры.
 */
const plainLetters = (x: string) => x.normalize('NFKC');
const norm = (x: string) => plainLetters(x).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Слова «не оригинала»: ремиксы, slowed/sped up, каверы, лайвы и т.п. (после приведения букв к обычным) */
const NOT_ORIGINAL =
  /(?<=^| )(remix|rmx|cover|flip|mash ?up|bootleg|slowed|sped ?up|speed ?up|nightcore|daycore|reverb|karaoke|instrumental|live|edit|8d|bass ?boost(?:ed)?|lo ?fi|acoustic|piano|tribute|8 ?bit|version|vip|кавер|ремикс|караоке|минус|медлен\S*|ускор\S*|замедл\S*)(?= |$)/gu;

/**
 * true — загрузка НЕ подходит: в её названии есть «ремикс/slowed/кавер…», которого нет в запросе,
 * или это ремикс другого автора (в запросе «JENNIE Remix», а загрузка — «Emeril Remix»).
 */
function isAltered(t: Track, wanted: string): boolean {
  const cand = norm(t.info.title ?? '');
  const want = norm(wanted);
  const wantWords = want.split(' ');
  const candWords = cand.split(' ');
  for (const m of cand.matchAll(NOT_ORIGINAL)) {
    const w = norm(m[0]);
    if (!w) continue;
    const first = w.split(' ')[0];
    const wi = wantWords.indexOf(first);
    if (wi < 0) return true; // в запросе такого не было
    // Слово было в запросе — проверим, что это тот же автор ремикса/версии (слово перед ним)
    const ci = candWords.indexOf(first);
    const prevWant = wantWords[wi - 1];
    const prevCand = candWords[ci - 1];
    if (prevWant && prevCand && prevWant !== prevCand && !NOT_ORIGINAL_SOFT.has(prevCand)) return true;
  }
  return false;
}
/** Слова, которые могут стоять перед «remix» и не являются именем автора */
const NOT_ORIGINAL_SOFT = new Set(['official', 'original', 'the', 'feat', 'ft', 'x', 'и', 'and']);

/**
 * Насколько загрузка похожа на оригинал: штраф за «cover/remix/slowed…» (если их не искали),
 * бонус за совпадение автора загрузки с исполнителем, за название и за длительность.
 */
function originalScore(t: Track, artist: string, title: string, durationMs?: number): number {
  const wanted = norm(`${artist} ${title}`);
  const tTitle = plainLetters(t.info.title ?? '');
  const nt = norm(tTitle);
  const na = norm(artist);
  const nTitle = norm(title);
  const author = norm(t.info.author ?? '');
  let s = 0;
  const junk = (tTitle.match(JUNK_WORDS) ?? []).filter((w) => !wanted.includes(norm(w)));
  s -= 40 * junk.length;
  if (na && author && (author === na || author.includes(na) || na.includes(author))) s += 30; // аккаунт исполнителя
  if (nTitle && nt.includes(nTitle)) s += 15;
  if (na && nt.includes(na)) s += 5;
  if (durationMs) {
    const diff = Math.abs((t.info.duration ?? 0) - durationMs);
    s += diff < 3_000 ? 25 : diff < 10_000 ? 15 : diff < 25_000 ? 5 : -20;
  }
  return s;
}

/** Ищет трек на SoundCloud и выбирает версию, больше всего похожую на оригинал. Неиграбельные пропускает. */
async function findOnSoundCloud(artist: string, title: string, requester: unknown, durationMs?: number) {
  const q = `${artist} ${title}`.trim();
  if (!q) return undefined;
  const res = await loadTracks(`scsearch:${q}`, requester);
  const ok = res.tracks.filter(
    (t) => !t.info.isStream && (t.info.duration ?? 0) > PREVIEW_MAX_MS && !isBad(t.info.uri) && !isAltered(t, q),
  );
  if (!ok.length) return undefined;
  const ranked = ok
    .map((t, k) => ({ t, k, s: originalScore(t, artist, title, durationMs) }))
    .sort((x, y) => y.s - x.s || x.k - y.k)
    .map((x) => x.t);
  return withAlternatives(ranked[0], ranked.slice(1));
}

// ───────────────────────── каталог Deezer: «настоящие» треки ─────────────────────────

interface CatalogTrack {
  id: number;
  artist: string;
  title: string;
  durationMs: number;
}

const toCatalog = (t: any): CatalogTrack => ({
  id: t.id,
  artist: t.artist?.name ?? '',
  title: t.title_short ?? t.title ?? '',
  durationMs: (t.duration ?? 0) * 1000,
});

async function catalogSearch(q: string, limit = 10, timeoutMs = 2000): Promise<CatalogTrack[]> {
  const res = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=${limit}`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json: any = await res.json();
  return (json?.data ?? []).map(toCatalog);
}

async function catalogTrack(id: number): Promise<CatalogTrack | undefined> {
  const json: any = await deezer(`/track/${Math.floor(id)}`);
  return json?.id ? toCatalog(json) : undefined;
}

/** Похоже ли, что найденный в каталоге трек — то, что человек и искал (а не случайное совпадение) */
function catalogMatches(query: string, c: CatalogTrack): boolean {
  const q = norm(query);
  const t = norm(c.title);
  return !!t && (q.includes(t) || t.includes(q));
}

/** Оригинал из каталога → лучшая версия на SoundCloud */
async function playCatalog(c: CatalogTrack, requester: unknown): Promise<LoadResult> {
  const t = await findOnSoundCloud(c.artist, c.title, requester, c.durationMs);
  if (!t) return { kind: 'empty', tracks: [] };
  return { kind: 'track', tracks: [t] };
}

/**
 * Трек не заиграл: запоминаем загрузку как неиграбельную и сразу ставим следующим запасной вариант.
 * Предупреждение в канал — только если трек заказывал человек и замены не нашлось.
 */
async function onTrackFailed(client: Client, player: Player, track: any) {
  markBad(track?.info?.uri);
  const alts: string[] = (track?.userData?.alts ?? []).filter((u: string) => !isBad(u));
  for (let k = 0; k < alts.length; k++) {
    const res = await loadTracks(alts[k], track.requester).catch(() => null);
    const alt = res?.tracks[0];
    if (!alt) {
      markBad(alts[k]);
      continue;
    }
    (alt as any).userData = { ...((alt as any).userData ?? {}), alts: alts.slice(k + 1) };
    await player.queue.add(alt, 0);
    console.log(`[music] «${track?.info?.title}» не играет — пробую другую загрузку: ${alt.info.title}`);
    await refreshPanel(player);
    return;
  }
  const requester = track?.requester?.id;
  if (requester && requester !== RADIO_REQUESTER.id) {
    void notify(client, player, `⚠️ **${plain(truncate(track?.info?.title ?? 'Трек', 80))}** не воспроизводится на SoundCloud — пропускаю.`);
  }
}

/** Переносит треки из отложенной очереди в настоящую, пока впереди не будет min треков. */
async function topUp(player: Player, min = 3): Promise<number> {
  const gid = player.guildId;
  if (lazyBusy.has(gid)) return 0;
  lazyBusy.add(gid);
  let added = 0;
  try {
    const lazy = lazyOf(player);
    let misses = 0;
    while (lazy.length && player.queue.tracks.length < min && manager.getPlayer(gid) && misses < 10) {
      const item = lazy.shift()!;
      player.set('lazy', lazy);
      const tr = await findOnSoundCloud(item.artist, item.title, item.requester, item.durationMs).catch(() => undefined);
      if (!tr) {
        misses++;
        console.warn(`[music] Не нашёл на SoundCloud: ${item.artist} — ${item.title}`);
        continue;
      }
      await player.queue.add(tr);
      added++;
      if (!player.playing && !player.paused) await player.play().catch(() => {});
    }
    player.set('lazy', lazy);
    if (added) await refreshPanel(player);
  } finally {
    lazyBusy.delete(gid);
  }
  return added;
}

/** После ошибки трека: если плеер встал — продолжаем со следующего. */
async function keepGoing(player: Player) {
  if (!manager.getPlayer(player.guildId) || player.paused) return;
  if (player.playing && player.queue.current) return;
  try {
    if (player.queue.tracks.length) {
      await player.skip(0, false);
      return;
    }
    if (lazyOf(player).length && (await topUp(player))) return;
    if (player.get('radio') && (await radioFill(player))) return;
  } catch (e) {
    console.warn('[music] Не удалось продолжить очередь:', (e as Error).message);
  }
}

/** Общая часть /play и /play_file: проверка голосового, плеер, очередь. */
async function enqueue(
  i: ChatInputCommandInteraction<'cached'>,
  resolve: () => Promise<LoadResult>,
  fileName?: string,
) {
  const voice = i.member.voice.channel;
  if (!voice) return respond(i, '🔇 Сначала зайди в голосовой канал.');

  let player = manager.getPlayer(i.guildId);
  if (player && player.voiceChannelId !== voice.id) {
    if (player.queue.current) return respond(i, `🎶 Я уже играю в <#${player.voiceChannelId}>. Заходи туда!`);
    await player.destroy('move');
    player = undefined;
  }

  await i.deferReply();

  const res = await resolve();
  if (!res.tracks.length) {
    if (res.kind === 'error') {
      console.warn(`[music] Ошибка загрузки: ${res.error}`);
      return i.editReply(`⚠️ Не получилось загрузить трек: ${truncate(res.error ?? '', 200)}`);
    }
    return i.editReply('🔍 Оригинал не нашёл. Ремиксы, slowed, каверы и лайвы бот не включает, если их нет в запросе: хочешь ремикс — так и напиши, например «Dracula JENNIE remix». Или попробуй «исполнитель — название».');
  }

  // Ссылки Spotify: сам Spotify не играем — находим треки на SoundCloud
  const spotify = res.tracks.length > 0 && res.tracks.every(isSpotifyTrack);
  let lazyItems: LazyItem[] = [];

  let added: Track[];
  let label: string;
  if (spotify && res.kind === 'playlist') {
    lazyItems = res.tracks.map((t) => toLazy(t, i.user));
    added = [];
    label = `📃 Плейлист Spotify **${plain(truncate(res.playlistName ?? 'плейлист', 80))}** — ${lazyItems.length} треков. Ищу их на SoundCloud по ходу воспроизведения.`;
  } else if (spotify) {
    const sp = res.tracks[0];
    const found = await findOnSoundCloud(sp.info.author ?? '', sp.info.title ?? '', i.user, sp.info.duration ?? undefined);
    if (!found) return i.editReply(`🔍 Трек **${plain(truncate(`${sp.info.author} — ${sp.info.title}`, 90))}** есть в Spotify, но на SoundCloud его не нашлось.`);
    added = [found];
    label = `➕ В очереди: **${plain(truncate(found.info.title, 80))}** (${formatDuration(found.info.duration)}) — найдено по ссылке Spotify`;
  } else if (res.kind === 'playlist') {
    added = res.tracks;
    label = `📃 Добавлен плейлист **${plain(truncate(res.playlistName ?? 'плейлист', 80))}** — ${added.length} треков`;
  } else {
    // В поиске пропускаем 30-секундные превью, если есть полноценная версия
    const full =
      res.kind === 'search'
        ? res.tracks.find((t) => (t.info.isStream || (t.info.duration ?? 0) > PREVIEW_MAX_MS) && !isBad(t.info.uri)) ?? res.tracks[0]
        : res.tracks[0];
    if (res.kind === 'search') {
      withAlternatives(full, res.tracks.filter((t) => t !== full && !t.info.isStream && (t.info.duration ?? 0) > PREVIEW_MAX_MS));
    }
    if (fileName) (full.info as any).title = fileName;
    added = [full];
    label = `➕ В очереди: **${plain(truncate(full.info.title, 80))}** (${full.info.isStream ? 'эфир' : formatDuration(full.info.duration)})`;
  }

  if (!player) {
    player = manager.createPlayer({
      guildId: i.guildId,
      voiceChannelId: voice.id,
      textChannelId: getSetting('channel.music') ?? i.channelId,
      selfDeaf: true,
      selfMute: false,
      volume: config.defaultVolume,
    });
  }
  if (!player.connected) await player.connect();

  // Если играла радиостанция — выключаем эфир, дальше обычная очередь
  const wasStation = !!player.get('station');
  if (wasStation) {
    player.set('station', null);
    player.set('stationNow', null);
  }
  if (added.length) await player.queue.add(added);
  if (lazyItems.length) {
    if (player.get('shuffle')) lazyItems.sort(() => Math.random() - 0.5);
    player.set('lazy', [...lazyOf(player), ...lazyItems]);
  }
  if (player.get('shuffle')) await player.queue.shuffle();
  if (lazyItems.length) await topUp(player);
  if (wasStation && player.queue.tracks.length) await player.skip(0, false);
  else if (!player.playing && !player.paused && player.queue.tracks.length) await player.play();
  else await refreshPanel(player);

  return i.editReply(label);
}

async function play(i: ChatInputCommandInteraction<'cached'>) {
  const text = i.options.getString('query', true).trim();
  if (/^https?:\/\//i.test(text)) {
    // Lavalink откроет ссылку сам — не пускаем его во внутреннюю сеть сервера
    const bad = await checkPublicUrl(text);
    if (bad) return respond(i, `❌ Эту ссылку открыть нельзя: ${bad}.`);
    return enqueue(i, () => loadTracks(text, i.user));
  }

  // Выбран вариант из подсказок — играем именно его оригинал
  const dz = text.match(/^dz:(\d+)$/)?.[1];
  if (dz) {
    return enqueue(i, async () => {
      const c = await catalogTrack(Number(dz)).catch(() => undefined);
      return c ? playCatalog(c, i.user) : { kind: 'empty', tracks: [] };
    });
  }

  // Просто текст: сначала ищем оригинал в каталоге; если он не похож на запрос — обычный поиск SoundCloud
  return enqueue(i, async () => {
    const top = (await catalogSearch(text, 1, 4000).catch(() => []))[0];
    if (top && catalogMatches(text, top)) {
      const r = await playCatalog(top, i.user);
      if (r.tracks.length) return r;
    }
    return searchByText(text, i.user);
  });
}

async function playFile(i: ChatInputCommandInteraction<'cached'>) {
  const file = i.options.getAttachment('file', true);
  const looksLikeAudio =
    (file.contentType && /^(audio|video)\//.test(file.contentType)) || /\.(mp3|ogg|oga|opus|wav|m4a|aac|flac|webm|mp4)$/i.test(file.name);
  if (!looksLikeAudio) return respond(i, '❌ Это не похоже на аудиофайл. Подойдут MP3, OGG, WAV, M4A, FLAC.');
  const title = file.name.replace(/\.[^.]+$/, '');
  return enqueue(i, () => loadTracks(file.url, i.user), title);
}

async function skip(player: Player) {
  if (player.queue.tracks.length === 0 && player.repeatMode !== 'queue') {
    await player.stopPlaying(true, false);
  } else {
    await player.skip(0, false);
  }
}

function toggleShuffle(player: Player): boolean {
  const on = !player.get('shuffle');
  player.set('shuffle', on);
  if (on) void player.queue.shuffle();
  return on;
}

function repeatLabel(mode: string) {
  return mode === 'track' ? 'трек' : mode === 'queue' ? 'очередь' : 'выкл';
}

// ───────────────────────── эффекты звука ─────────────────────────

/** Пресеты эффектов: ключ → [подпись, эмодзи, описание] */
const FX: Record<string, [string, string, string]> = {
  off: ['Без эффектов', '🎵', 'Обычный звук'],
  bass: ['Bass Boost', '🔊', 'Усиленные басы'],
  '8d': ['8D', '🎧', 'Звук кружит вокруг головы — слушать в наушниках'],
  nightcore: ['Nightcore', '⚡', 'Быстрее и выше'],
  slowed: ['Slowed', '🌙', 'Медленнее и ниже (slowed)'],
  karaoke: ['Караоке', '🎤', 'Приглушает голос'],
  lofi: ['Lo-Fi', '📻', 'Мягкий приглушённый звук'],
  soft: ['Мягкий', '☁️', 'Тише верхи, без резкости'],
};

const BASS_BOOST = [
  { band: 0, gain: 0.3 },
  { band: 1, gain: 0.25 },
  { band: 2, gain: 0.2 },
  { band: 3, gain: 0.1 },
  { band: 4, gain: 0.05 },
];
const SOFT_EQ = [
  { band: 10, gain: -0.15 },
  { band: 11, gain: -0.2 },
  { band: 12, gain: -0.25 },
  { band: 13, gain: -0.25 },
  { band: 14, gain: -0.25 },
];

/** Эффекты, меняющие скорость: в прямом эфире они вызывают заикания */
const SPEED_FX = new Set(['nightcore', 'slowed']);

async function applyFx(player: Player, key: string) {
  if (player.get('station') && SPEED_FX.has(key)) throw new Error('в прямом эфире нельзя менять скорость — Nightcore и Slowed недоступны');
  const fm: any = (player as any).filterManager;
  if (!fm) throw new Error('эффекты недоступны в этой версии плеера');
  await fm.resetFilters();
  switch (key) {
    case 'bass':
      await fm.setEQ(BASS_BOOST);
      break;
    case '8d':
      await fm.toggleRotation(0.2);
      break;
    case 'nightcore':
      await fm.toggleNightcore();
      break;
    case 'slowed':
      await fm.toggleVaporwave();
      break;
    case 'karaoke':
      await fm.toggleKaraoke();
      break;
    case 'lofi':
      await fm.toggleLowPass(20);
      break;
    case 'soft':
      await fm.setEQ(SOFT_EQ);
      break;
  }
  player.set('fx', key);
}

function fxMenu(player: Player) {
  const current = player.get('fx') ?? 'off';
  const live = !!player.get('station');
  const menu = new StringSelectMenuBuilder()
    .setCustomId('music:fx')
    .setPlaceholder(`🎛 Эффект: ${FX[current]?.[0] ?? 'Без эффектов'}`)
    .addOptions(
      Object.entries(FX).filter(([key]) => !(live && SPEED_FX.has(key))).map(([key, [label, emoji, desc]]) =>
        new StringSelectMenuOptionBuilder().setValue(key).setLabel(label).setEmoji(emoji).setDescription(desc).setDefault(key === current),
      ),
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

// ───────────────────────── кнопки плеера ─────────────────────────

export async function onComponent(i: ComponentInteraction) {
  if (!i.inCachedGuild()) return;
  const action = i.customId.split(':')[1];
  const player = manager.getPlayer(i.guildId);

  // Выпадающее меню эффектов
  if (i.isStringSelectMenu() && action === 'fx') {
    const err = checkControl(i.member, player, 'fx');
    if (err) return respond(i, err);
    const key = i.values[0] ?? 'off';
    try {
      await applyFx(player!, key);
    } catch (e) {
      console.warn('[music] Эффект:', (e as Error).message);
      return respond(i, `⚠️ Не получилось включить эффект: ${(e as Error).message}`);
    }
    await i.update(panelPayload(player!));
    return i.followUp({
      content: key === 'off' ? '🎵 Эффекты выключены.' : `${FX[key][1]} Эффект **${FX[key][0]}** включён.`,
      flags: MessageFlags.Ephemeral,
    });
  }
  if (!i.isButton()) return;

  if (action === 'queue') return respond(i, { embeds: [queueEmbed(player)] });

  const err = checkControl(i.member, player, action);
  if (err) return respond(i, err);
  const p = player!;

  switch (action) {
    case 'toggle':
      if (p.paused) await p.resume();
      else await p.pause();
      break;
    case 'skip':
      await skip(p);
      return i.deferUpdate();
    case 'stop':
      await p.destroy('stop');
      return i.deferUpdate().catch(() => {});
    case 'shuffle':
      toggleShuffle(p);
      break;
    case 'loop': {
      const next = p.repeatMode === 'off' ? 'track' : p.repeatMode === 'track' ? 'queue' : 'off';
      await p.setRepeatMode(next);
      break;
    }
    case 'voldown':
      await p.setVolume(Math.max(0, p.volume - 10));
      break;
    case 'volup':
      await p.setVolume(Math.min(150, p.volume + 10));
      break;
    case 'radio_deezer': {
      p.set('radioDeezerOnce', true);
      if (!p.get('radio')) p.set('radio', true);
      await i.update({ content: '📻 Подбираю похожие через Deezer…', components: [] });
      const n = await radioFill(p);
      return i.editReply({ content: n ? `📻 Deezer подобрал и добавил ${n} треков.` : '📻 Deezer тоже ничего не нашёл.' }).catch(() => {});
    }
    case 'radio': {
      const on = await toggleRadio(p);
      await i.update(panelPayload(p));
      return i.followUp({
        content: on
          ? '📻 Радио **включено**: подбираю похожие треки — они встанут в очередь и будут добавляться дальше сами.'
          : '📻 Радио **выключено**. Уже добавленные треки останутся в очереди.',
        flags: MessageFlags.Ephemeral,
      });
    }
  }
  await i.update(panelPayload(p));
}

// ───────────────────────── радио ─────────────────────────
//
// Радио по треку: подбор — Spotify Mix через LavaSrc (как «радио» в приложении Spotify),
// запасной вариант — радио исполнителя на Deezer. Играются треки с SoundCloud.

const RADIO_REQUESTER = { id: 'radio', username: '📻 Радио' };
const radioBusy = new Set<string>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function splitArtistTitle(info: { author?: string; title?: string }) {
  let artist = info.author ?? '';
  let title = info.title ?? '';
  // На SoundCloud часто «Исполнитель - Название» в заголовке, а в author — ник загрузившего
  const m = title.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (m) {
    artist = m[1];
    title = m[2];
  }
  title = title.replace(/\s*[([][^)\]]*(official|video|audio|lyric|clip|visuali[sz]er|prod|free download)[^)\]]*[)\]]/gi, '').trim();
  return { artist: artist.trim(), title };
}

const trackKey = (artist: string, title: string) =>
  `${artist} ${title}`.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

async function deezer(path: string): Promise<any> {
  const res = await fetch(`https://api.deezer.com${path}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Deezer HTTP ${res.status}`);
  const json: any = await res.json();
  if (json?.error) throw new Error(`Deezer: ${json.error.message ?? 'ошибка'}`);
  return json;
}

/** Похожие треки по треку-«семени»: ищем исполнителя на Deezer и берём его радио. */
async function similarTracks(seed: Track): Promise<{ artist: string; title: string }[]> {
  const { artist, title } = splitArtistTitle(seed.info as any);
  const found = await deezer(`/search?q=${encodeURIComponent(`${artist} ${title}`.trim())}&limit=1`);
  let artistId = found?.data?.[0]?.artist?.id;
  if (!artistId && artist) {
    const a = await deezer(`/search/artist?q=${encodeURIComponent(artist)}&limit=1`);
    artistId = a?.data?.[0]?.id;
  }
  if (!artistId) return [];
  const radio = await deezer(`/artist/${artistId}/radio?limit=50`);
  return (radio?.data ?? []).map((t: any) => ({ artist: t.artist?.name ?? '', title: t.title_short ?? t.title ?? '' }));
}

/**
 * Spotify Mix по треку — тот же подбор, что у «радио» в приложении Spotify.
 * Работает через плагин LavaSrc (sprec:mix:…), треки из микса LavaSrc сам находит и играет через SoundCloud.
 * Чтобы найти трек в Spotify без API-ключей, берём его ISRC (код записи) из Deezer.
 */
/**
 * Spotify-подборка для трека. Пробует по очереди:
 *  1) микс по треку (трек ищем в самом Spotify: по ссылке, по ISRC, поиском по названию);
 *  2) микс по исполнителю этого трека;
 *  3) микс по ISRC из Deezer (Deezer тут только «справочник» кода записи, подбор всё равно от Spotify).
 * Каждый шаг пишет в лог, почему не получилось.
 */
async function spotifyMix(seed: Track): Promise<Track[]> {
  const first = await spotifyMixOnce(seed);
  if (first.length) return first;
  // Частая временная ошибка: токен Spotify ещё не готов (первый запрос после запуска/простоя). Повторяем.
  await sleep(3000);
  console.log('[music] Spotify-подборка: повторная попытка');
  return spotifyMixOnce(seed);
}

async function spotifyMixOnce(seed: Track): Promise<Track[]> {
  const info: any = seed.info;
  const { artist, title } = splitArtistTitle(info);
  const label = `${artist} — ${title}`;
  const tried: string[] = [];

  const tryMix = async (query: string, why: string) => {
    const res = await loadTracks(query, RADIO_REQUESTER);
    if (res.tracks.length) {
      console.log(`[music] Spotify-подборка «${label}»: ${why} → ${res.tracks.length} треков`);
      return res.tracks;
    }
    tried.push(`${why}: ${res.kind === 'error' ? res.error : 'пусто'}`);
    return [];
  };

  let tracks: Track[] = [];
  // Трек и так из Spotify / есть код записи
  if (info.sourceName === 'spotify' && info.identifier) tracks = await tryMix(`sprec:mix:track:${info.identifier}`, 'по треку (ссылка)');
  if (!tracks.length && info.isrc) tracks = await tryMix(`sprec:mix:isrc:${info.isrc}`, 'по ISRC трека');

  // Поиск в Spotify: «исполнитель название», потом только название
  let artistUrl: string | undefined;
  if (!tracks.length) {
    for (const q of [`${artist} ${title}`.trim(), title].filter((x, k, arr) => x && arr.indexOf(x) === k)) {
      const sp = await loadTracks(`spsearch:${q}`, RADIO_REQUESTER);
      const hit = sp.tracks.find((t: any) => t.info?.sourceName === 'spotify') as any;
      if (!hit) {
        tried.push(`поиск «${q}»: ${sp.kind === 'error' ? sp.error : 'не найдено'}`);
        continue;
      }
      artistUrl = hit.pluginInfo?.artistUrl;
      tracks = await tryMix(`sprec:mix:track:${hit.info.identifier}`, `по треку «${hit.info.author} — ${hit.info.title}»`);
      break;
    }
  }

  // Микс по исполнителю
  const artistId = artistUrl?.match(/artist\/([A-Za-z0-9]+)/)?.[1];
  if (!tracks.length && artistId) tracks = await tryMix(`sprec:mix:artist:${artistId}`, 'по исполнителю');

  // ISRC из Deezer → микс Spotify
  if (!tracks.length) {
    try {
      const found = await deezer(`/search?q=${encodeURIComponent(`${artist} ${title}`.trim())}&limit=1`);
      const id = found?.data?.[0]?.id;
      const t = id ? await deezer(`/track/${id}`) : null;
      if (t?.isrc) tracks = await tryMix(`sprec:mix:isrc:${t.isrc}`, `по ISRC ${t.isrc}`);
      else tried.push('ISRC: трека нет в Deezer');
    } catch (e) {
      tried.push(`ISRC: ${(e as Error).message}`);
    }
  }

  if (!tracks.length) console.warn(`[music] Spotify-подборка «${label}» не получилась:\n  - ${tried.join('\n  - ')}`);
  return tracks;
}

type RadioItem = { track?: Track; artist: string; title: string; durationMs?: number };

/** Добавляет в очередь до count похожих треков. Возвращает, сколько добавлено. */
async function radioFill(player: Player, deezerCount = 10): Promise<number> {
  const gid = player.guildId;
  if (radioBusy.has(gid)) return 0;
  radioBusy.add(gid);
  try {
    const seed: Track | undefined =
      player.queue.current ?? (player.queue.previous?.[0] as Track | undefined) ?? player.get('radioSeed');
    if (!seed) return 0;

    const seen = new Set<string>(player.get('radioPlayed') ?? []);
    for (const t of [seed, ...player.queue.tracks] as Track[]) {
      const s = splitArtistTitle(t.info as any);
      seen.add(trackKey(s.artist, s.title));
    }
    const fresh = (items: RadioItem[]) => items.filter((c) => c.title && !seen.has(trackKey(c.artist, c.title)));

    // Запас подобранных треков с прошлого раза — чтобы не дёргать Spotify на каждый трек
    let pending: RadioItem[] = fresh(player.get('radioPending') ?? []);
    let source: string = player.get('radioSource') ?? '';

    if (pending.length < deezerCount) {
      // 1) Spotify Mix
      let mix: Track[] = [];
      try {
        mix = await spotifyMix(seed);
      } catch (e) {
        console.warn('[music] Spotify Mix:', (e as Error).message);
      }
      const fromSpotify = fresh(mix.map((t) => ({ artist: t.info.author ?? '', title: t.info.title ?? '', durationMs: t.info.duration ?? undefined })));
      if (fromSpotify.length) {
        pending = [...pending, ...fromSpotify];
        source = 'Spotify';
        player.set('radioSpotifyFailed', false);
      } else if (getSetting('radio_deezer') === '1' || player.get('radioDeezerOnce')) {
        // Запасной подбор через Deezer — только если включён в /setup или нажали кнопку
        player.set('radioDeezerOnce', false);
        const fromDeezer = fresh((await similarTracks(seed).catch(() => [])).sort(() => Math.random() - 0.5));
        if (fromDeezer.length) {
          pending = [...pending, ...fromDeezer];
          source = 'Deezer';
        }
      } else if (!pending.length) {
        // Spotify не смог — не подменяем молча. Предлагаем Deezer кнопкой, а на следующем треке снова пробуем Spotify
        source = 'Spotify ✗';
        if (player.get('radioOfferedFor') !== seed.info.uri) {
          player.set('radioOfferedFor', seed.info.uri);
          void offerDeezer(player, `${seed.info.author ?? ''} — ${seed.info.title}`);
        }
      }
    }

    let added = 0;
    // Каждый трек ищем на SoundCloud — поэтому порциями; остальные ждут в запасе и добавятся по ходу
    const limit = deezerCount;
    while (pending.length && added < limit && player.get('radio') && manager.getPlayer(gid)) {
      const c = pending.shift()!;
      const key = trackKey(c.artist, c.title);
      if (seen.has(key)) continue;
      seen.add(key);
      let tr = c.track;
      if (!tr) {
        // Ищем трек из подборки на SoundCloud
        tr = await findOnSoundCloud(c.artist, c.title, RADIO_REQUESTER, c.durationMs).catch(() => undefined);
        await sleep(200);
      }
      if (!tr) continue;
      await player.queue.add(tr);
      added++;
      if (!player.playing && !player.paused) await player.play().catch(() => {});
    }

    player.set('radioPending', pending.slice(0, 100));
    player.set('radioPlayed', [...seen].slice(-300));
    player.set('radioSource', source);
    if (added) {
      console.log(`[music] Радио (${source || '—'}): добавлено ${added}`);
      await refreshPanel(player);
    }
    return added;
  } catch (e) {
    console.warn('[music] Радио:', (e as Error).message);
    return 0;
  } finally {
    radioBusy.delete(gid);
  }
}

async function toggleRadio(player: Player): Promise<boolean> {
  const on = !player.get('radio');
  player.set('radio', on);
  if (on) {
    if (player.queue.current) player.set('radioSeed', player.queue.current);
    player.set('radioPending', []);
    void radioFill(player);
  }
  return on;
}

// ───────────────────────── UI ─────────────────────────

function progressBar(position: number, duration: number, size = 16) {
  if (!duration) return '🔴 Прямой эфир';
  const ratio = Math.min(1, Math.max(0, position / duration));
  const filled = Math.round(ratio * size);
  return `${'▰'.repeat(filled)}${'▱'.repeat(size - filled)}  \`${formatDuration(position)} / ${formatDuration(duration)}\``;
}

/** Плеер в режиме радиостанции */
function stationPanel(player: Player) {
  const st: StationMeta = player.get('station');
  const now: string | null = player.get('stationNow');
  const fav = !!db.prepare('SELECT 1 FROM radio_favorites WHERE uuid = ?').get(st.uuid);
  const mins = Math.max(0, Math.floor((Date.now() - (st.startedAt ?? Date.now())) / 60_000));
  const onAir = mins >= 60 ? `${Math.floor(mins / 60)} ч ${mins % 60} мин` : `${mins} мин`;
  const fx = player.get('fx');
  const requester = (player.queue.current?.requester as any)?.id;

  const embed = baseEmbed()
    .setColor(0xe02b2b)
    .setAuthor({ name: player.paused ? '⏸ ЭФИР НА ПАУЗЕ' : '🔴 ПРЯМОЙ ЭФИР' })
    .setTitle(truncate(st.name, 250))
    .setDescription(
      [
        [`${st.flag} ${st.country}`.trim(), st.genreLabel, st.bitrate ? `${st.bitrate} kbps` : '', st.codec].filter(Boolean).join(' · '),
        '',
        now ? `🎵 Сейчас в эфире: **${plain(truncate(now, 200))}**` : '🎵 Станция не передаёт название трека',
        `⏱ В эфире: ${onAir}`,
      ].join('\n'),
    )
    .addFields({ name: 'Громкость', value: `${player.volume}%`, inline: true })
    .setFooter({ text: `${fav ? '⭐ В избранном сервера • ' : ''}Каталог радиостанций Radio Browser` });
  if (fx && fx !== 'off' && FX[fx]) embed.addFields({ name: 'Эффект', value: `${FX[fx][1]} ${FX[fx][0]}`, inline: true });
  if (requester) embed.addFields({ name: 'Включил', value: `<@${requester}>`, inline: true });
  const home = safeUrl(st.homepage);
  if (home) embed.setURL(home);
  const icon = safeUrl(st.favicon);
  if (icon?.startsWith('https://')) embed.setThumbnail(icon);

  const sbtn = (id: string, emoji: string, label: string, style = ButtonStyle.Secondary) =>
    new ButtonBuilder().setCustomId(`station:${id}`).setEmoji(emoji).setLabel(label).setStyle(style);
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    btn('toggle', player.paused ? '▶️' : '⏸', ButtonStyle.Primary),
    btn('stop', '⏹', ButtonStyle.Danger),
    btn('voldown', '🔉'),
    btn('volup', '🔊'),
  );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    sbtn('fav', '⭐', fav ? 'В избранном' : 'В избранное', fav ? ButtonStyle.Success : ButtonStyle.Secondary),
    sbtn('next', '🔀', 'Другая станция'),
    sbtn('list', '📻', 'Список'),
  );
  return { embeds: [embed], components: [row1, row2, fxMenu(player)] };
}

function panelPayload(player: Player) {
  if (player.get('station') && player.queue.current) return stationPanel(player);
  const track = player.queue.current;
  if (!track) {
    return {
      embeds: [baseEmbed().setTitle('🦆 Очередь закончилась').setDescription('Закажи ещё что-нибудь через `/play`.')],
      components: [],
    };
  }
  const info = track.info;
  const requester = (track.requester as any)?.id;
  const next = player.queue.tracks
    .slice(0, 3)
    .map((t: any, idx: number) => `\`${idx + 1}.\` ${plain(truncate(t.info.title, 50))}`)
    .join('\n');

  const embed = baseEmbed()
    .setAuthor({ name: player.paused ? '⏸ На паузе' : '🎶 Сейчас играет' })
    .setTitle(truncate(info.title, 250))
    .setDescription(`${info.author ? `**${plain(truncate(info.author, 100))}**\n` : ''}${progressBar(player.position, info.isStream ? 0 : info.duration)}`)
    .addFields(
      { name: 'Громкость', value: `${player.volume}%`, inline: true },
      { name: 'Порядок', value: player.get('shuffle') ? '🔀 Перемешано' : '➡️ По порядку', inline: true },
      { name: 'Повтор', value: repeatLabel(player.repeatMode), inline: true },
    )
    .setFooter({ text: `В очереди: ${player.queue.tracks.length} • DJ-режим: ${djModeOn() ? 'вкл' : 'выкл'}` });
  const uri = safeUrl(info.uri);
  if (uri) embed.setURL(uri);
  const art = safeUrl(info.artworkUrl);
  if (art) embed.setThumbnail(art);
  if (requester) {
    embed.addFields({ name: 'Заказал', value: requester === RADIO_REQUESTER.id ? '📻 Радио' : `<@${requester}>`, inline: true });
  }
  const fx = player.get('fx');
  if (fx && fx !== 'off' && FX[fx]) embed.addFields({ name: 'Эффект', value: `${FX[fx][1]} ${FX[fx][0]}`, inline: true });
  if (player.get('radio')) {
    const src = player.get('radioSource');
    const srcText = src === 'Spotify ✗' ? ' · Spotify не нашёл, жду следующий трек' : src ? ` · подбор ${src}` : '';
    embed.addFields({ name: 'Радио', value: `📻 вкл${srcText}`, inline: true });
  }
  if (next) embed.addFields({ name: 'Дальше', value: next });

  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    btn('toggle', player.paused ? '▶️' : '⏸', ButtonStyle.Primary),
    btn('skip', '⏭'),
    btn('stop', '⏹', ButtonStyle.Danger),
    btn('shuffle', '🔀', player.get('shuffle') ? ButtonStyle.Success : ButtonStyle.Secondary),
    btn('loop', player.repeatMode === 'track' ? '🔂' : '🔁', player.repeatMode === 'off' ? ButtonStyle.Secondary : ButtonStyle.Success),
  );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    btn('voldown', '🔉'),
    btn('volup', '🔊'),
    btn('queue', '📜'),
    btn('radio', '📻', player.get('radio') ? ButtonStyle.Success : ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row1, row2, fxMenu(player)] };
}

function btn(action: string, emoji: string, style = ButtonStyle.Secondary) {
  return new ButtonBuilder().setCustomId(`music:${action}`).setEmoji(emoji).setStyle(style);
}

function queueEmbed(player: Player | undefined) {
  if (!player?.queue.current) return baseEmbed().setDescription('🎵 Очередь пуста.');
  const lines = player.queue.tracks
    .slice(0, 15)
    .map((t: any, idx: number) => `\`${idx + 1}.\` ${plain(truncate(t.info.title, 60))} — ${t.info.isStream ? 'эфир' : formatDuration(t.info.duration)}`);
  const more = player.queue.tracks.length > 15 ? `\n…и ещё ${player.queue.tracks.length - 15}` : '';
  const lazy = lazyOf(player);
  const pending: RadioItem[] = player.get('radio') ? player.get('radioPending') ?? [] : [];
  const extra = [
    lazy.length ? `⏳ Из плейлиста Spotify ждут поиска на SoundCloud: **${lazy.length}** (следующий: ${truncate(`${lazy[0].artist} — ${lazy[0].title}`, 60)})` : '',
    pending.length ? `📻 В запасе у радио: **${pending.length}** — добавятся по ходу` : '',
  ].filter(Boolean).join('\n');
  return baseEmbed()
    .setTitle('📜 Очередь')
    .setDescription(
      `**Сейчас:** ${plain(truncate(player.queue.current.info.title, 80))}\n\n${lines.join('\n') || 'Дальше пусто.'}${more}${extra ? `\n\n${extra}` : ''}`,
    );
}

async function getTextChannel(client: Client, player: Player, override?: string): Promise<TextBasedChannel | null> {
  const id = override ?? getSetting('channel.music') ?? player.textChannelId;
  if (!id) return null;
  const ch = await client.channels.fetch(id).catch(() => null);
  return ch?.isTextBased() ? (ch as TextBasedChannel) : null;
}

/** Очередь операций с плеером по серверу — чтобы два события подряд не создали два сообщения */
const panelLocks = new Map<string, Promise<unknown>>();
function withPanelLock<T>(guildId: string, fn: () => Promise<T>): Promise<T> {
  const prev = panelLocks.get(guildId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  panelLocks.set(guildId, next);
  return next;
}

const panelKey = (guildId: string) => `music.panel.${guildId}`;

/** Достаём сообщение-плеер: из памяти или по id, сохранённому в базе (переживает перезапуск бота) */
async function findPanel(client: Client, guildId: string): Promise<Message | null> {
  const cached = panels.get(guildId);
  if (cached) return cached;
  const saved = getSetting(panelKey(guildId));
  if (!saved) return null;
  const [channelId, messageId] = saved.split(':');
  const ch: any = await client.channels.fetch(channelId).catch(() => null);
  const msg: Message | null = ch?.messages ? await ch.messages.fetch(messageId).catch(() => null) : null;
  if (msg) panels.set(guildId, msg);
  else setSetting(panelKey(guildId), null);
  return msg;
}

/**
 * Показывает плеер. Обычно ОБНОВЛЯЕТ одно и то же сообщение (без флуда).
 * Новое сообщение внизу канала — только если старого нет или вызвали /nowplaying (moveToBottom).
 */
function showPanel(client: Client, player: Player, playing: boolean, channelOverride?: string, moveToBottom = false) {
  return withPanelLock(player.guildId, async () => {
    const guildId = player.guildId;
    const channel = await getTextChannel(client, player, channelOverride);
    if (!channel || !('send' in channel)) return;

    let msg = await findPanel(client, guildId);
    if (msg && (moveToBottom || msg.channelId !== channel.id)) {
      await msg.delete().catch(() => {});
      msg = null;
      panels.delete(guildId);
    }

    if (msg) {
      const err = await msg.edit(panelPayload(player)).then(() => null).catch((e) => e);
      if (err) {
        // Новое сообщение — только если старого плеера больше нет (удалили или нет доступа).
        // При лимите Discord или сбое сети просто пропускаем это обновление, иначе получается флуд.
        if ([10008, 10003, 50001].includes(err?.code)) msg = null;
        else {
          console.warn('[music] Не удалось обновить плеер:', err?.message ?? err);
          return;
        }
      }
    }
    if (!msg) {
      msg = await channel.send(panelPayload(player)).catch((e) => {
        console.warn('[music] Не удалось отправить плеер:', e?.message);
        return null;
      });
      if (!msg) return;
      panels.set(guildId, msg);
      setSetting(panelKey(guildId), `${msg.channelId}:${msg.id}`);
    }

    stopProgress(guildId);
    // В эфире полосы прогресса нет — панель раз в минуту обновляет модуль радиостанций
    if (playing && !player.get('station')) progressTimers.set(guildId, setInterval(() => void refreshPanel(player), 15_000));
  });
}

function refreshPanel(player: Player) {
  return withPanelLock(player.guildId, async () => {
    const msg = panels.get(player.guildId);
    if (!msg) return;
    await msg.edit(panelPayload(player)).catch((e) => {
      // Забываем плеер, только если сообщения больше нет. При лимите Discord просто пропускаем обновление —
      // иначе следующий трек отправит новое окно плеера, и в канале будет флуд.
      if ([10008, 10003, 50001].includes(e?.code)) {
        panels.delete(player.guildId);
        setSetting(panelKey(player.guildId), null);
        stopProgress(player.guildId);
      } else console.warn('[music] Не удалось обновить плеер:', e?.message ?? e);
    });
  });
}

function stopProgress(guildId: string) {
  const t = progressTimers.get(guildId);
  if (t) clearInterval(t);
  progressTimers.delete(guildId);
}

/** Музыка остановлена: то же сообщение превращается в «бар закрыт» и будет переиспользовано при следующем /play */
function closePanel(guildId: string) {
  stopProgress(guildId);
  return withPanelLock(guildId, async () => {
    const msg = panels.get(guildId);
    if (!msg) return;
    await msg
      .edit({ embeds: [baseEmbed().setTitle('🦆 Музыка остановлена').setDescription('Бар закрыт до следующего `/play`.')], components: [] })
      .catch(() => {});
  });
}

/** Spotify не подобрал — предлагаем Deezer кнопкой (сообщение само исчезнет через минуту) */
async function offerDeezer(player: Player, label: string) {
  if (!botClient) return;
  const channel = await getTextChannel(botClient, player);
  if (!channel || !('send' in channel)) return;
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('music:radio_deezer').setLabel('Подобрать через Deezer').setEmoji('📻').setStyle(ButtonStyle.Secondary),
  );
  const m = await channel
    .send({
      content: `📻 Spotify не смог подобрать похожие для **${plain(truncate(label, 80))}**. Радио попробует снова на следующем треке.`,
      components: [row],
    })
    .catch(() => null);
  if (m) setTimeout(() => m.delete().catch(() => {}), 60_000);
}

async function notify(client: Client, player: Player, text: string) {
  const channel = await getTextChannel(client, player);
  if (channel && 'send' in channel) {
    const m = await channel.send(text).catch(() => null);
    if (m) setTimeout(() => m.delete().catch(() => {}), 20_000);
  }
}

/** Для других модулей (например, /help) — есть ли активный плеер. */
export function hasPlayer(guild: Guild) {
  return !!manager?.getPlayer(guild.id);
}


// ───────────────────────── API для модуля радиостанций ─────────────────────────

export interface StationMeta {
  uuid: string;
  name: string;
  url: string;
  homepage?: string;
  favicon?: string;
  flag: string;
  country: string;
  genreKey?: string;
  genreLabel: string;
  bitrate?: number;
  codec?: string;
  startedAt?: number;
}

let stationEndHook: ((player: Player, reason: 'end' | 'error') => void) | null = null;

/**
 * Включает радиостанцию: очередь очищается, радио по треку и отложенные треки выключаются.
 * Поток сначала открывает Lavalink — это и есть проверка, что станция живая и отдаёт звук.
 * Возвращает текст ошибки или null.
 */
async function startStation(
  guildId: string,
  voiceChannelId: string,
  textChannelId: string,
  requester: { id: string; username: string },
  meta: StationMeta,
): Promise<string | null> {
  let player = manager.getPlayer(guildId);
  if (player && player.voiceChannelId !== voiceChannelId) {
    if (player.queue.current) return `🎶 Я уже играю в <#${player.voiceChannelId}>. Заходи туда!`;
    await player.destroy('move');
    player = undefined;
  }

  const res = await withTimeout(loadTracks(meta.url, requester), 12_000);
  const tr = res?.tracks[0];
  if (!tr) return res?.kind === 'error' ? `станция не отдаёт звук (${truncate(res.error ?? '', 120)})` : 'станция не отвечает';
  (tr.info as any).title = meta.name;
  (tr.info as any).author = meta.genreLabel;
  if (meta.favicon?.startsWith('https://')) (tr.info as any).artworkUrl = meta.favicon;

  if (!player) {
    player = manager.createPlayer({
      guildId,
      voiceChannelId,
      textChannelId: getSetting('channel.music') ?? textChannelId,
      selfDeaf: true,
      selfMute: false,
      volume: config.defaultVolume,
    });
  }
  if (!player.connected) await player.connect();

  // Сброс обычных режимов
  if (player.repeatMode !== 'off') await player.setRepeatMode('off');
  player.set('radio', false);
  player.set('lazy', []);
  player.set('radioPending', []);
  if (SPEED_FX.has(player.get('fx'))) await applyFx(player, 'off').catch(() => {});
  player.set('station', { ...meta, startedAt: Date.now() });
  player.set('stationNow', null);

  if (player.queue.tracks.length) await player.queue.splice(0, player.queue.tracks.length);
  if (player.queue.current && (player.playing || player.paused)) {
    await player.queue.add(tr, 0);
    await player.skip(0, false);
    if (player.paused) await player.resume();
  } else {
    await player.queue.add(tr);
    await player.play();
  }
  return null;
}

export const musicApi = {
  getPlayer: (guildId: string) => manager?.getPlayer(guildId),
  players: (): Player[] => [...((manager as any)?.players?.values?.() ?? [])],
  checkControl,
  panelPayload,
  refreshPanel,
  startStation,
  notify: (player: Player, text: string) => (botClient ? notify(botClient, player, text) : Promise.resolve()),
  setStationEndHook: (fn: (player: Player, reason: 'end' | 'error') => void) => {
    stationEndHook = fn;
  },
};
