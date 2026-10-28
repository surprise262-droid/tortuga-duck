import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  GuildMember,
  MessageFlags,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
  type Message,
  type TextBasedChannel,
} from 'discord.js';
import { LavalinkManager, type Player, type Track } from 'lavalink-client';
import { config } from '../config';
import { getSetting } from '../db';
import type { ComponentInteraction } from '../types';
import { baseEmbed, formatDuration, isManager, respond, truncate } from '../util';

export const componentPrefix = 'music';

let manager: LavalinkManager;
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
      requesterTransformer: (r: any) => ({ id: r?.id, username: r?.username }),
    },
    queueOptions: { maxPreviousTracks: 10 },
  } as any);

  client.on('raw', (d) => manager.sendRawData(d));
  client.once(Events.ClientReady, async (c) => {
    await manager.init({ id: c.user.id, username: c.user.username });
  });

  manager.nodeManager.on('connect', (node: any) => console.log(`[music] Lavalink подключён (${node.id})`));
  manager.nodeManager.on('error', (node: any, err: any) => console.error(`[music] Ошибка Lavalink (${node.id}):`, err?.message ?? err));
  manager.nodeManager.on('disconnect', (node: any) => console.warn(`[music] Lavalink отключился (${node.id})`));

  manager.on('trackStart', (player: Player, track: any) => {
    void showPanel(client, player, true);
    if (player.get('radio')) {
      player.set('radioSeed', track);
      if (player.queue.tracks.length < 3) void radioFill(player);
    }
  });
  manager.on('queueEnd', (player: Player) => {
    if (player.get('radio')) {
      // Радио включено — подбираем ещё, а не показываем «очередь закончилась»
      void radioFill(player).then((n) => {
        if (!n) void showPanel(client, player, false);
      });
      return;
    }
    void showPanel(client, player, false);
  });
  manager.on('trackError', (player: Player, track: any, payload: any) => {
    console.warn('[music] Ошибка трека:', track?.info?.title, payload?.exception?.message);
    void notify(client, player, `⚠️ Не получилось воспроизвести **${track?.info?.title ?? 'трек'}** — пропускаю.`);
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
      return showPanel(i.client, player, true, i.channelId);
  }

  const err = checkControl(member, player, i.commandName);
  if (err) return respond(i, err);
  const p = player!;

  switch (i.commandName) {
    case 'skip':
      await skip(p);
      return respond(i, '⏭ Пропущено.', false);
    case 'pause':
      if (!p.paused) await p.pause();
      await refreshPanel(p);
      return respond(i, '⏸ Пауза.', false);
    case 'resume':
      if (p.paused) await p.resume();
      await refreshPanel(p);
      return respond(i, '▶️ Играем дальше.', false);
    case 'stop':
      await p.destroy('stop');
      return respond(i, '⏹ Музыка остановлена, очередь очищена.', false);
    case 'volume': {
      const level = i.options.getInteger('level', true);
      await p.setVolume(level);
      await refreshPanel(p);
      return respond(i, `🔊 Громкость: **${level}%**`, false);
    }
    case 'shuffle': {
      const on = toggleShuffle(p);
      await refreshPanel(p);
      return respond(i, on ? '🔀 Перемешивание **включено**.' : '➡️ Играем **по порядку**.', false);
    }
    case 'loop': {
      const mode = i.options.getString('mode', true) as 'off' | 'track' | 'queue';
      await p.setRepeatMode(mode);
      await refreshPanel(p);
      return respond(i, `🔁 Повтор: **${repeatLabel(mode)}**`, false);
    }
    case 'radio': {
      const on = await toggleRadio(p);
      await refreshPanel(p);
      return respond(
        i,
        on ? '📻 Радио **включено** — подбираю похожие треки.' : '📻 Радио **выключено**.',
        false,
      );
    }
    case 'remove': {
      const pos = i.options.getInteger('position', true);
      if (pos > p.queue.tracks.length) return respond(i, `❌ В очереди всего ${p.queue.tracks.length} треков.`);
      const [removed] = await p.queue.splice(pos - 1, 1);
      await refreshPanel(p);
      return respond(i, `🗑 Убран: **${(removed as any)?.info?.title ?? 'трек'}**`, false);
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
    const res = await fetch(url, { headers: { Authorization: password } });
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
    if (res.tracks.length) return res;
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

export async function onAutocomplete(i: AutocompleteInteraction) {
  if (i.commandName !== 'play') return;
  const typed = i.options.getFocused().trim();
  const asTyped = typed ? [{ name: `🔍 Искать: ${truncate(typed, 85)}`, value: typed.slice(0, 100) }] : [];

  // Ссылки и слишком короткие запросы не ищем — просто подставляем как есть
  if (typed.length < 3 || /^https?:\/\//i.test(typed)) return i.respond(asTyped).catch(() => {});

  const key = typed.toLowerCase();
  const cached = suggestCache.get(key);
  if (cached && Date.now() - cached.at < SUGGEST_TTL_MS) return i.respond(cached.choices).catch(() => {});

  // У Discord на ответ 3 секунды — ждём поиск не дольше 2,3 сек
  const res = await withTimeout(loadTracks(`scsearch:${typed}`, null), 2300);
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
    return i.editReply('🔍 Ничего не нашёл. Попробуй по-другому: «исполнитель — название» или ссылку.');
  }

  let added: Track[];
  let label: string;
  if (res.kind === 'playlist') {
    added = res.tracks;
    label = `📃 Добавлен плейлист **${truncate(res.playlistName ?? 'плейлист', 80)}** — ${added.length} треков`;
  } else {
    // В поиске пропускаем 30-секундные превью, если есть полноценная версия
    const full =
      res.kind === 'search'
        ? res.tracks.find((t) => t.info.isStream || (t.info.duration ?? 0) > PREVIEW_MAX_MS) ?? res.tracks[0]
        : res.tracks[0];
    if (fileName) (full.info as any).title = fileName;
    added = [full];
    label = `➕ В очереди: **${truncate(full.info.title, 80)}** (${full.info.isStream ? 'эфир' : formatDuration(full.info.duration)})`;
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

  await player.queue.add(added);
  if (player.get('shuffle')) await player.queue.shuffle();
  if (!player.playing && !player.paused) await player.play();
  else await refreshPanel(player);

  return i.editReply(label);
}

async function play(i: ChatInputCommandInteraction<'cached'>) {
  const text = i.options.getString('query', true).trim();
  const isUrl = /^https?:\/\//i.test(text);
  return enqueue(i, () => (isUrl ? loadTracks(text, i.user) : searchByText(text, i.user)));
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

// ───────────────────────── кнопки плеера ─────────────────────────

export async function onComponent(i: ComponentInteraction) {
  if (!i.isButton() || !i.inCachedGuild()) return;
  const action = i.customId.split(':')[1];
  const player = manager.getPlayer(i.guildId);

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
async function spotifyMix(seed: Track): Promise<Track[]> {
  const info: any = seed.info;
  let query: string | undefined;
  if (info.sourceName === 'spotify' && info.identifier) query = `sprec:mix:track:${info.identifier}`;
  else if (info.isrc) query = `sprec:mix:isrc:${info.isrc}`;
  else {
    const { artist, title } = splitArtistTitle(info);
    const found = await deezer(`/search?q=${encodeURIComponent(`${artist} ${title}`.trim())}&limit=1`);
    const id = found?.data?.[0]?.id;
    if (id) {
      const t = await deezer(`/track/${id}`);
      if (t?.isrc) query = `sprec:mix:isrc:${t.isrc}`;
    }
  }
  if (!query) return [];
  const res = await loadTracks(query, RADIO_REQUESTER);
  if (res.kind === 'error') console.warn(`[music] Spotify Mix (${query}): ${res.error}`);
  return res.tracks;
}

type RadioItem = { track?: Track; artist: string; title: string };

/** Добавляет в очередь до count похожих треков. Возвращает, сколько добавлено. */
async function radioFill(player: Player, count = 8): Promise<number> {
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

    if (pending.length < count) {
      // 1) Spotify Mix
      let mix: Track[] = [];
      try {
        mix = await spotifyMix(seed);
      } catch (e) {
        console.warn('[music] Spotify Mix:', (e as Error).message);
      }
      const fromSpotify = fresh(mix.map((t) => ({ track: t, artist: t.info.author ?? '', title: t.info.title ?? '' })));
      if (fromSpotify.length) {
        pending = [...pending, ...fromSpotify];
        source = 'Spotify';
      } else {
        // 2) Запасной вариант — радио исполнителя на Deezer
        const fromDeezer = fresh((await similarTracks(seed).catch(() => [])).sort(() => Math.random() - 0.5));
        if (fromDeezer.length) {
          pending = [...pending, ...fromDeezer];
          source = 'Deezer';
        }
      }
    }

    let added = 0;
    while (pending.length && added < count && player.get('radio') && manager.getPlayer(gid)) {
      const c = pending.shift()!;
      const key = trackKey(c.artist, c.title);
      if (seen.has(key)) continue;
      seen.add(key);
      let tr = c.track;
      if (!tr) {
        // Трек из Deezer — ищем его на SoundCloud
        const res = await loadTracks(`scsearch:${c.artist} ${c.title}`, RADIO_REQUESTER);
        tr = res.tracks.find((t) => !t.info.isStream && (t.info.duration ?? 0) > PREVIEW_MAX_MS);
        await sleep(250);
      }
      if (!tr) continue;
      await player.queue.add(tr);
      added++;
      if (!player.playing && !player.paused && !player.queue.current) await player.play();
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

function panelPayload(player: Player) {
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
    .map((t: any, idx: number) => `\`${idx + 1}.\` ${truncate(t.info.title, 50)}`)
    .join('\n');

  const embed = baseEmbed()
    .setAuthor({ name: player.paused ? '⏸ На паузе' : '🎶 Сейчас играет' })
    .setTitle(truncate(info.title, 250))
    .setDescription(`${info.author ? `**${truncate(info.author, 100)}**\n` : ''}${progressBar(player.position, info.isStream ? 0 : info.duration)}`)
    .addFields(
      { name: 'Громкость', value: `${player.volume}%`, inline: true },
      { name: 'Порядок', value: player.get('shuffle') ? '🔀 Перемешано' : '➡️ По порядку', inline: true },
      { name: 'Повтор', value: repeatLabel(player.repeatMode), inline: true },
    )
    .setFooter({ text: `В очереди: ${player.queue.tracks.length} • DJ-режим: ${djModeOn() ? 'вкл' : 'выкл'}` });
  if (info.uri?.startsWith('http')) embed.setURL(info.uri);
  if (info.artworkUrl) embed.setThumbnail(info.artworkUrl);
  if (requester) {
    embed.addFields({ name: 'Заказал', value: requester === RADIO_REQUESTER.id ? '📻 Радио' : `<@${requester}>`, inline: true });
  }
  if (player.get('radio')) {
    const src = player.get('radioSource');
    embed.addFields({ name: 'Радио', value: `📻 вкл${src ? ` · подбор ${src}` : ''}`, inline: true });
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
  return { embeds: [embed], components: [row1, row2] };
}

function btn(action: string, emoji: string, style = ButtonStyle.Secondary) {
  return new ButtonBuilder().setCustomId(`music:${action}`).setEmoji(emoji).setStyle(style);
}

function queueEmbed(player: Player | undefined) {
  if (!player?.queue.current) return baseEmbed().setDescription('🎵 Очередь пуста.');
  const lines = player.queue.tracks
    .slice(0, 15)
    .map((t: any, idx: number) => `\`${idx + 1}.\` ${truncate(t.info.title, 60)} — ${t.info.isStream ? 'эфир' : formatDuration(t.info.duration)}`);
  const more = player.queue.tracks.length > 15 ? `\n…и ещё ${player.queue.tracks.length - 15}` : '';
  return baseEmbed()
    .setTitle('📜 Очередь')
    .setDescription(
      `**Сейчас:** ${truncate(player.queue.current.info.title, 80)}\n\n${lines.join('\n') || 'Дальше пусто.'}${more}`,
    );
}

async function getTextChannel(client: Client, player: Player, override?: string): Promise<TextBasedChannel | null> {
  const id = override ?? getSetting('channel.music') ?? player.textChannelId;
  if (!id) return null;
  const ch = await client.channels.fetch(id).catch(() => null);
  return ch?.isTextBased() ? (ch as TextBasedChannel) : null;
}

/** Показывает плеер внизу канала (старый удаляется), запускает обновление прогресса. */
async function showPanel(client: Client, player: Player, playing: boolean, channelOverride?: string) {
  const guildId = player.guildId;
  const old = panels.get(guildId);
  if (old) await old.delete().catch(() => {});
  panels.delete(guildId);
  stopProgress(guildId);

  const channel = await getTextChannel(client, player, channelOverride);
  if (!channel || !('send' in channel)) return;
  const msg = await channel.send(panelPayload(player)).catch((e) => {
    console.warn('[music] Не удалось отправить плеер:', e?.message);
    return null;
  });
  if (!msg) return;
  panels.set(guildId, msg);

  if (playing) {
    progressTimers.set(
      guildId,
      setInterval(() => void refreshPanel(player), 15_000),
    );
  }
}

async function refreshPanel(player: Player) {
  const msg = panels.get(player.guildId);
  if (!msg) return;
  await msg.edit(panelPayload(player)).catch(() => {
    panels.delete(player.guildId);
    stopProgress(player.guildId);
  });
}

function stopProgress(guildId: string) {
  const t = progressTimers.get(guildId);
  if (t) clearInterval(t);
  progressTimers.delete(guildId);
}

async function closePanel(guildId: string) {
  stopProgress(guildId);
  const msg = panels.get(guildId);
  panels.delete(guildId);
  if (msg) {
    await msg
      .edit({ embeds: [baseEmbed().setTitle('🦆 Музыка остановлена').setDescription('Бар закрыт до следующего `/play`.')], components: [] })
      .catch(() => {});
  }
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
