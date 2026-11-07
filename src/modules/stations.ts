import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type GuildMember,
} from 'discord.js';
import type { Player } from 'lavalink-client';
import { db } from '../db';
import type { ComponentInteraction } from '../types';
import { baseEmbed, plain, respond, truncate } from '../util';
import { safeFetch } from '../net';
import { musicApi, type StationMeta } from './music';

/**
 * Интернет-радио: каталог Radio Browser (бесплатный, без ключа).
 *  • /station — «Радио-бар»: избранное сервера и станции по жанрам;
 *  • /station query: — поиск по названию с подсказками;
 *  • перед включением поток проверяется (ответ, тип звука, плейлисты .pls/.m3u);
 *  • мёртвые станции прячутся на сутки, вместо них бот предлагает другую того же жанра;
 *  • в плеере — «🔴 Прямой эфир» и название песни из метаданных потока (ICY).
 */

export const componentPrefix = 'station';

export const commands = [
  new SlashCommandBuilder()
    .setName('station')
    .setDescription('Интернет-радио: станции по жанрам и поиск по названию')
    .addStringOption((o) => o.setName('query').setDescription('Название станции (необязательно)').setAutocomplete(true)),
];

// ───────────────────────── жанры ─────────────────────────

interface Genre {
  key: string;
  label: string;
  emoji: string;
  tags: string[];
}

const GENRES: Genre[] = [
  { key: 'pop', label: 'Поп', emoji: '🎤', tags: ['pop'] },
  { key: 'rock', label: 'Рок', emoji: '🎸', tags: ['rock'] },
  { key: 'electronic', label: 'Электроника', emoji: '🎛', tags: ['electronic', 'dance', 'house', 'trance'] },
  { key: 'hiphop', label: 'Хип-хоп', emoji: '🎧', tags: ['hip-hop', 'hiphop', 'rap'] },
  { key: 'phonk', label: 'Фонк', emoji: '💀', tags: ['phonk'] },
  { key: 'chill', label: 'Lo-Fi и чилл', emoji: '☕', tags: ['lofi', 'lo-fi', 'chillout', 'chill'] },
  { key: 'jazz', label: 'Джаз', emoji: '🎷', tags: ['jazz'] },
  { key: 'classical', label: 'Классика', emoji: '🎻', tags: ['classical'] },
  { key: 'metal', label: 'Метал', emoji: '🤘', tags: ['metal'] },
  { key: 'anime', label: 'Аниме и J-Pop', emoji: '🌸', tags: ['anime', 'jpop', 'j-pop'] },
  { key: 'retro', label: 'Ретро 80-х и 90-х', emoji: '📼', tags: ['80s', '90s', 'retro'] },
  { key: 'talk', label: 'Разговорное и новости', emoji: '🗞', tags: ['news', 'talk'] },
];
const genreByKey = new Map(GENRES.map((g) => [g.key, g]));

// ───────────────────────── каталог Radio Browser ─────────────────────────

interface RbStation {
  stationuuid: string;
  name: string;
  url: string;
  url_resolved: string;
  homepage: string;
  favicon: string;
  tags: string;
  country: string;
  countrycode: string;
  language: string;
  codec: string;
  bitrate: number;
  hls: number;
  lastcheckok: number;
  clickcount: number;
}

const UA = 'TortugaDuckBot/1.0';
const FALLBACK_SERVERS = ['de1.api.radio-browser.info', 'de2.api.radio-browser.info', 'fi1.api.radio-browser.info', 'nl1.api.radio-browser.info'];
let servers: string[] = [];
let serversAt = 0;

async function getServers(): Promise<string[]> {
  if (servers.length && Date.now() - serversAt < 6 * 3600_000) return servers;
  try {
    const res = await fetch('https://all.api.radio-browser.info/json/servers', {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(4000),
    });
    const list = ((await res.json()) as { name: string }[]).map((s) => s.name).filter(Boolean);
    if (list.length) {
      servers = [...new Set(list)].sort(() => Math.random() - 0.5);
      serversAt = Date.now();
      return servers;
    }
  } catch {
    /* берём запасной список */
  }
  servers = [...FALLBACK_SERVERS].sort(() => Math.random() - 0.5);
  serversAt = Date.now() - 5 * 3600_000; // попробуем узнать список заново через час
  return servers;
}

/** Запрос к API с перебором зеркал. Сервер, который не ответил, уходит в конец списка. */
async function rb<T>(path: string, timeoutMs = 6000): Promise<T> {
  const list = await getServers();
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  for (const host of [...list]) {
    const left = deadline - Date.now();
    if (left < 300) break;
    try {
      const res = await fetch(`https://${host}${path}`, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(Math.min(left, 4000)),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    } catch (e) {
      lastErr = e;
      servers = [...servers.filter((s) => s !== host), host];
    }
  }
  throw new Error(`каталог радиостанций не отвечает (${(lastErr as Error)?.message ?? 'таймаут'})`);
}

const GOOD_CODECS = new Set(['MP3', 'AAC', 'AAC+', 'OGG', 'OPUS']);
const PRIORITY_COUNTRIES = new Set(['UA', 'RU', 'BY', 'KZ']);

/** Станции, которые не включились, прячем на сутки */
const dead = new Map<string, number>();
const DEAD_MS = 24 * 3600_000;
function isDead(uuid: string) {
  const t = dead.get(uuid);
  if (!t) return false;
  if (Date.now() - t > DEAD_MS) {
    dead.delete(uuid);
    return false;
  }
  return true;
}

/** Станции, что бот видел недавно, — чтобы не спрашивать каталог повторно (не больше 2000, старые вытесняются) */
const known = new Map<string, RbStation>();
function remember(s: RbStation) {
  known.delete(s.stationuuid);
  known.set(s.stationuuid, s);
  if (known.size > 2000) known.delete(known.keys().next().value as string);
}

function usable(s: RbStation) {
  return (
    s.lastcheckok === 1 &&
    !s.hls &&
    GOOD_CODECS.has((s.codec ?? '').toUpperCase()) &&
    (!s.bitrate || s.bitrate >= 64) &&
    !!(s.url_resolved || s.url) &&
    !!s.name?.trim()
  );
}

function isPriority(s: RbStation) {
  const lang = (s.language ?? '').toLowerCase();
  return PRIORITY_COUNTRIES.has((s.countrycode ?? '').toUpperCase()) || lang.includes('russian') || lang.includes('ukrainian');
}

/** Фильтр, дедупликация по названию, наши станции выше, дальше — по популярности */
function rank(list: RbStation[]): RbStation[] {
  const seen = new Set<string>();
  const out: RbStation[] = [];
  for (const s of list.filter(usable).sort((a, b) => b.clickcount - a.clickcount)) {
    const k = s.name.trim().toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(k) || seen.has(s.stationuuid)) continue;
    seen.add(k);
    seen.add(s.stationuuid);
    out.push(s);
    remember(s);
  }
  return out.sort((a, b) => Number(isPriority(b)) - Number(isPriority(a)));
}

const genreCache = new Map<string, { at: number; list: RbStation[] }>();
const genreLoading = new Map<string, Promise<RbStation[]>>();
const GENRE_TTL = 24 * 3600_000;

async function genreStations(key: string): Promise<RbStation[]> {
  const g = genreByKey.get(key);
  if (!g) return [];
  const cached = genreCache.get(key);
  if (cached && Date.now() - cached.at < GENRE_TTL) return cached.list.filter((s) => !isDead(s.stationuuid));
  if (!genreLoading.has(key)) {
    const job = (async () => {
      const results = await Promise.allSettled(
        g.tags.map((t) =>
          rb<RbStation[]>(`/json/stations/search?tag=${encodeURIComponent(t)}&hidebroken=true&order=clickcount&reverse=true&limit=200`, 8000),
        ),
      );
      const all = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
      if (!all.length) {
        const err = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
        if (cached) return cached.list; // каталог упал — отдаём устаревший список
        throw err?.reason ?? new Error('станции не найдены');
      }
      const list = rank(all).slice(0, 60); // запас на случай мёртвых станций
      genreCache.set(key, { at: Date.now(), list });
      return list;
    })().finally(() => genreLoading.delete(key));
    genreLoading.set(key, job);
  }
  return (await genreLoading.get(key)!).filter((s) => !isDead(s.stationuuid));
}

async function searchByName(q: string, timeoutMs: number): Promise<RbStation[]> {
  const list = await rb<RbStation[]>(
    `/json/stations/search?name=${encodeURIComponent(q)}&hidebroken=true&order=clickcount&reverse=true&limit=60`,
    timeoutMs,
  );
  return rank(list).filter((s) => !isDead(s.stationuuid));
}

async function stationByUuid(uuid: string): Promise<RbStation | null> {
  const k = known.get(uuid);
  if (k) return k;
  const fav = favorite(uuid);
  try {
    const list = await rb<RbStation[]>(`/json/stations/byuuid/${encodeURIComponent(uuid)}`, 5000);
    if (list[0]) {
      remember(list[0]);
      return list[0];
    }
  } catch {
    /* каталог недоступен — попробуем из избранного */
  }
  return fav;
}

/** Сообщаем каталогу о прослушивании — так Radio Browser считает популярность (по правилам API) */
function countClick(uuid: string) {
  void rb(`/json/url/${encodeURIComponent(uuid)}`, 4000).catch(() => {});
}

// ───────────────────────── вид ─────────────────────────

function flag(cc: string) {
  const c = (cc ?? '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return '🌐';
  return String.fromCodePoint(...[...c].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}

function genreOf(s: RbStation, hint?: string): Genre | undefined {
  if (hint && genreByKey.has(hint)) return genreByKey.get(hint);
  const tags = (s.tags ?? '').toLowerCase().split(',').map((t) => t.trim());
  return GENRES.find((g) => g.tags.some((t) => tags.includes(t)));
}

function cleanName(name: string) {
  return name.replace(/\s+/g, ' ').trim();
}

function stationLine(s: RbStation) {
  return [flag(s.countrycode), s.country || 'Мир', s.bitrate ? `${s.bitrate} kbps` : '', (s.codec ?? '').toUpperCase()].filter(Boolean).join(' · ');
}

function toMeta(s: RbStation, url: string, genreKey?: string): StationMeta {
  const g = genreOf(s, genreKey);
  return {
    uuid: s.stationuuid,
    name: cleanName(s.name),
    url,
    homepage: s.homepage || undefined,
    favicon: s.favicon || undefined,
    flag: flag(s.countrycode),
    country: s.country || 'Мир',
    genreKey: g?.key ?? genreKey,
    genreLabel: g ? `${g.emoji} ${g.label}` : '📻 Радио',
    bitrate: s.bitrate || undefined,
    codec: (s.codec ?? '').toUpperCase() || undefined,
  };
}

// ───────────────────────── избранное сервера ─────────────────────────

function favorites(): RbStation[] {
  const rows = db.prepare('SELECT data FROM radio_favorites ORDER BY ts DESC LIMIT 25').all() as { data: string }[];
  return rows.flatMap((r) => {
    try {
      return [JSON.parse(r.data) as RbStation];
    } catch {
      return [];
    }
  });
}

function favorite(uuid: string): RbStation | null {
  const row = db.prepare('SELECT data FROM radio_favorites WHERE uuid = ?').get(uuid) as { data: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.data);
  } catch {
    return null;
  }
}

/** Возвращает true, если станция теперь в избранном */
function toggleFavorite(s: RbStation, userId: string): boolean {
  if (favorite(s.stationuuid)) {
    db.prepare('DELETE FROM radio_favorites WHERE uuid = ?').run(s.stationuuid);
    return false;
  }
  db.prepare('INSERT INTO radio_favorites (uuid, data, added_by, ts) VALUES (?, ?, ?, ?)').run(
    s.stationuuid,
    JSON.stringify(s),
    userId,
    Date.now(),
  );
  return true;
}

// ───────────────────────── проверка потока ─────────────────────────

const AUDIO_TYPES = /audio\/|application\/ogg|application\/octet-stream|video\/mp2t/i;
const PLAYLIST_TYPES = /mpegurl|x-scpls|pls\+xml/i;

/**
 * Открываем поток и смотрим, что отдаёт сервер: аудио — хорошо, плейлист .pls/.m3u — берём первую ссылку из него,
 * HTML или ошибка — станция мёртвая. Возвращает рабочую ссылку на звук.
 */
async function probe(url: string, depth = 0): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    // safeFetch не пускает в локальную сеть сервера: ссылки станций приходят из открытого каталога
    const res = await safeFetch(url, { headers: { 'User-Agent': UA, 'Icy-MetaData': '1' }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`сервер станции ответил ${res.status}`);
    const type = res.headers.get('content-type') ?? '';
    const finalUrl = res.url || url;
    const looksPlaylist = PLAYLIST_TYPES.test(type) || /\.(m3u8?|pls)(\?|$)/i.test(finalUrl);
    if (looksPlaylist && depth < 2) {
      const text = (await readSome(res, 32_000)).toString('utf8');
      if (/#EXT-X-/i.test(text)) throw new Error('станция вещает в формате HLS — его бот не играет');
      const next = text.match(/https?:\/\/[^\s"'<>]+/i)?.[0];
      if (!next) throw new Error('пустой плейлист станции');
      return probe(next, depth + 1);
    }
    if (/text\/html/i.test(type)) throw new Error('вместо звука сервер отдал веб-страницу');
    if (type && !AUDIO_TYPES.test(type) && !/^text\/plain/i.test(type)) throw new Error(`неизвестный тип потока (${type})`);
    // Убедимся, что звук действительно идёт
    const head = await readSome(res, 4096);
    if (head.length < 512) throw new Error('станция не передаёт звук');
    return finalUrl;
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error('станция не ответила за 6 секунд');
    if ((e as Error).name === 'TypeError') throw new Error('не удалось подключиться к станции');
    throw e;
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}

async function readSome(res: Response, max: number): Promise<Buffer> {
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let n = 0;
  try {
    while (n < max) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      chunks.push(Buffer.from(value));
      n += value.length;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}

// ───────────────────────── «сейчас в эфире» (ICY) ─────────────────────────

function decodeTitle(buf: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('windows-1251').decode(buf);
    } catch {
      return buf.toString('latin1');
    }
  }
}

/** Читает из потока первый блок метаданных и достаёт StreamTitle. undefined — станция метаданные не передаёт. */
async function readIcyTitle(url: string): Promise<string | null | undefined> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await safeFetch(url, { headers: { 'User-Agent': UA, 'Icy-MetaData': '1' }, signal: ctrl.signal });
    const metaint = Number(res.headers.get('icy-metaint'));
    if (!res.ok || !metaint || metaint > 256_000) return undefined;
    const reader = res.body!.getReader();
    // Куски складываем в список и склеиваем один раз — поток читается каждые 30 секунд, без лишних копий
    const chunks: Buffer[] = [];
    let total = 0;
    let buf = Buffer.alloc(0);
    try {
      while (total < metaint + 1 + 4080) {
        const { value, done } = await reader.read();
        if (done || !value) break;
        chunks.push(Buffer.from(value));
        total += value.length;
        if (total > metaint) {
          if (buf.length !== total) buf = Buffer.concat(chunks, total);
          const len = buf[metaint] * 16;
          if (len === 0) return null;
          if (buf.length >= metaint + 1 + len) {
            const raw = decodeTitle(buf.subarray(metaint + 1, metaint + 1 + len)).replace(/\0+$/, '');
            const m = raw.match(/StreamTitle='(.*?)';/s);
            const title = m?.[1]?.trim();
            return title && !/^[-\s|]*$/.test(title) ? title : null;
          }
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}

// ───────────────────────── включение станции ─────────────────────────

/** Что сейчас происходит у каждого сервера: попытки переподключения, отсутствие метаданных */
const live = new Map<string, { retries: number; firstFailAt: number; noMeta: boolean; switching: boolean }>();

function liveOf(guildId: string) {
  let s = live.get(guildId);
  if (!s) {
    s = { retries: 0, firstFailAt: 0, noMeta: false, switching: false };
    live.set(guildId, s);
  }
  return s;
}

/** Проверяет поток и включает станцию. Возвращает текст ошибки или null. */
async function tune(
  guildId: string,
  voiceChannelId: string,
  textChannelId: string,
  requester: { id: string; username: string },
  s: RbStation,
  genreKey?: string,
): Promise<string | null> {
  let url: string;
  try {
    url = await probe(s.url_resolved || s.url);
  } catch (e) {
    dead.set(s.stationuuid, Date.now());
    return (e as Error).message;
  }
  const err = await musicApi.startStation(guildId, voiceChannelId, textChannelId, requester, toMeta(s, url, genreKey));
  if (err) {
    if (!err.startsWith('🎶')) dead.set(s.stationuuid, Date.now());
    return err;
  }
  const st = liveOf(guildId);
  st.retries = 0;
  st.firstFailAt = 0;
  st.noMeta = false;
  countClick(s.stationuuid);
  void pollOne(guildId);
  return null;
}

/** Следующая живая станция того же жанра (или из избранного) после текущей */
async function nextInGenre(current: StationMeta): Promise<RbStation[]> {
  const pool = current.genreKey === 'fav' || !current.genreKey ? favorites() : await genreStations(current.genreKey).catch(() => favorites());
  const idx = pool.findIndex((s) => s.stationuuid === current.uuid);
  const ordered = idx >= 0 ? [...pool.slice(idx + 1), ...pool.slice(0, idx)] : pool;
  return ordered.filter((s) => s.stationuuid !== current.uuid && !isDead(s.stationuuid));
}

/** Перебирает станции, пока одна не включится (не больше 4 попыток) */
async function tuneFirstAlive(
  guildId: string,
  voiceChannelId: string,
  textChannelId: string,
  requester: { id: string; username: string },
  candidates: RbStation[],
  genreKey?: string,
): Promise<{ station: RbStation | null; errors: string[] }> {
  const errors: string[] = [];
  for (const s of candidates.slice(0, 4)) {
    const err = await tune(guildId, voiceChannelId, textChannelId, requester, s, genreKey);
    if (!err) return { station: s, errors };
    errors.push(`**${plain(truncate(cleanName(s.name), 60))}** — ${err}`);
    if (err.startsWith('🎶')) break;
  }
  return { station: null, errors };
}

/** Эфир оборвался: пробуем переподключиться, а если станция умерла — переключаем на соседнюю */
async function onStreamEnd(player: Player, reason: 'end' | 'error') {
  const meta: StationMeta | null = player.get('station');
  if (!meta || !player.voiceChannelId || musicApi.getPlayer(player.guildId) !== player) return;
  const st = liveOf(player.guildId);
  if (st.switching) return;
  st.switching = true;
  try {
    const now = Date.now();
    if (!st.firstFailAt || now - st.firstFailAt > 5 * 60_000) {
      st.firstFailAt = now;
      st.retries = 0;
    }
    st.retries++;
    const requester = (player.queue.current?.requester as any) ?? { id: '0', username: 'radio' };
    const textId = player.textChannelId ?? '';

    // 1–2 обрыва за 5 минут — переподключаемся к той же станции
    if (st.retries <= 2) {
      console.warn(`[station] Обрыв эфира «${meta.name}» (${reason}), переподключаюсь…`);
      await new Promise((r) => setTimeout(r, 2000));
      if (!player.get('station') || musicApi.getPlayer(player.guildId) !== player) return;
      const err = await musicApi.startStation(player.guildId, player.voiceChannelId, textId, requester, { ...meta });
      if (!err) {
        // время в эфире считаем с первого включения
        player.set('station', { ...player.get('station'), startedAt: meta.startedAt });
        return;
      }
    }

    // Станция умерла — соседняя того же жанра
    dead.set(meta.uuid, Date.now());
    const candidates = await nextInGenre(meta).catch(() => [] as RbStation[]);
    const { station } = await tuneFirstAlive(player.guildId, player.voiceChannelId, textId, requester, candidates, meta.genreKey);
    if (station) {
      await musicApi.notify(player, `📻 Станция **${plain(truncate(meta.name, 80))}** пропала из эфира — переключил на **${plain(truncate(cleanName(station.name), 80))}**.`);
    } else {
      player.set('station', null);
      player.set('stationNow', null);
      await musicApi.notify(player, `📻 Станция **${plain(truncate(meta.name, 80))}** пропала из эфира, а замену найти не удалось. Выбери другую: \`/station\`.`);
      await player.stopPlaying(true, false).catch(() => {});
      await musicApi.refreshPanel(player);
    }
  } catch (e) {
    console.warn('[station] Не удалось восстановить эфир:', (e as Error).message);
  } finally {
    st.switching = false;
  }
}

// ───────────────────────── опрос метаданных ─────────────────────────

async function pollOne(guildId: string) {
  const player = musicApi.getPlayer(guildId);
  const meta: StationMeta | null = player?.get('station');
  if (!player || !meta || !player.queue.current) return;
  const st = liveOf(guildId);
  let changed = false;
  if (!st.noMeta) {
    const title = await readIcyTitle(meta.url);
    if (title === undefined) st.noMeta = true;
    const value = title || null;
    if ((player.get('stationNow') ?? null) !== value) {
      player.set('stationNow', value);
      changed = true;
    }
  }
  // Раз в минуту обновляем панель в любом случае — для счётчика «В эфире»
  const lastAt: number = player.get('stationPanelAt') ?? 0;
  if (changed || Date.now() - lastAt > 55_000) {
    player.set('stationPanelAt', Date.now());
    await musicApi.refreshPanel(player);
  }
}

let pollBusy = false;
async function pollAll() {
  if (pollBusy) return;
  pollBusy = true;
  try {
    for (const p of musicApi.players()) {
      if (p.get('station')) await pollOne(p.guildId).catch(() => {});
    }
  } finally {
    pollBusy = false;
  }
}

// ───────────────────────── «Радио-бар» ─────────────────────────

function barEmbed(note?: string) {
  const favs = favorites();
  return baseEmbed()
    .setColor(0xe02b2b)
    .setTitle('📻 Радио-бар')
    .setDescription(
      [
        note ?? 'Выбери жанр — бот покажет популярные станции. Наши (🇺🇦 🇷🇺 🇧🇾 🇰🇿) — сверху списка.',
        '',
        favs.length ? `⭐ В избранном сервера: **${favs.length}** — меню ниже.` : '⭐ Избранного пока нет — добавь станцию кнопкой ⭐ в плеере.',
        '🔎 Найти по названию: `/station query:`',
      ].join('\n'),
    )
    .setFooter({ text: 'Каталог радиостанций Radio Browser' });
}

function genreMenu(selected?: string) {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('station:genre')
      .setPlaceholder('🎚 Выбери жанр')
      .addOptions(GENRES.map((g) => ({ label: g.label, value: g.key, emoji: g.emoji, default: g.key === selected }))),
  );
}

function stationOptions(list: RbStation[]) {
  return list.slice(0, 25).map((s) => ({
    label: truncate(cleanName(s.name), 100),
    description: truncate(stationLine(s), 100),
    value: s.stationuuid,
  }));
}

function favMenu() {
  const favs = favorites();
  if (!favs.length) return null;
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder().setCustomId('station:pick:fav').setPlaceholder('⭐ Избранное сервера').addOptions(stationOptions(favs)),
  );
}

function barPayload(note?: string) {
  const rows: any[] = [];
  const fav = favMenu();
  if (fav) rows.push(fav);
  rows.push(genreMenu());
  return { embeds: [barEmbed(note)], components: rows };
}

async function genrePayload(key: string) {
  const g = genreByKey.get(key)!;
  const list = (await genreStations(key)).slice(0, 25);
  const ours = list.filter(isPriority).length;
  const embed = baseEmbed()
    .setColor(0xe02b2b)
    .setTitle(`📻 ${g.emoji} ${g.label}`)
    .setDescription(
      list.length
        ? `Станций: **${list.length}**${ours ? `, из них наших — **${ours}** (вверху)` : ''}. Выбери в меню — бот проверит эфир и включит.`
        : 'Живых станций этого жанра сейчас не нашлось. Попробуй другой жанр.',
    )
    .setFooter({ text: 'Каталог радиостанций Radio Browser' });
  const rows: any[] = [];
  if (list.length) {
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder().setCustomId(`station:pick:${key}`).setPlaceholder('📻 Выбери станцию').addOptions(stationOptions(list)),
      ),
    );
  }
  rows.push(genreMenu(key));
  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('station:bar').setEmoji('⭐').setLabel('Избранное').setStyle(ButtonStyle.Secondary),
    ),
  );
  return { embeds: [embed], components: rows };
}

// ───────────────────────── команды ─────────────────────────

/** Подсказки: пусто — избранное, текст — поиск по названию (быстро, не дольше 1,5 с) */
export async function onAutocomplete(i: AutocompleteInteraction) {
  const q = i.options.getFocused().trim();
  const fmt = (s: RbStation, star = false) => ({
    name: truncate(`${star ? '⭐ ' : ''}${cleanName(s.name)} — ${stationLine(s)}`, 100),
    value: `uuid:${s.stationuuid}`,
  });
  if (q.length < 2) {
    return i.respond(favorites().slice(0, 25).map((s) => fmt(s, true))).catch(() => {});
  }
  let found: RbStation[] = [];
  try {
    found = await searchByName(q, 1500);
  } catch {
    /* каталог не успел — покажем совпадения из избранного */
  }
  const favs = favorites().filter((s) => s.name.toLowerCase().includes(q.toLowerCase()));
  const favIds = new Set(favs.map((s) => s.stationuuid));
  const choices = [...favs.map((s) => fmt(s, true)), ...found.filter((s) => !favIds.has(s.stationuuid)).map((s) => fmt(s))].slice(0, 25);
  return i.respond(choices).catch(() => {});
}

export async function onCommand(i: ChatInputCommandInteraction) {
  if (!i.inCachedGuild()) return;
  const query = i.options.getString('query')?.trim();
  if (!query) return respond(i, barPayload());

  await i.deferReply({ ephemeral: true });
  let station: RbStation | null = null;
  if (query.startsWith('uuid:')) station = await stationByUuid(query.slice(5));
  else {
    try {
      station = (await searchByName(query, 6000))[0] ?? null;
    } catch (e) {
      return i.editReply(`⚠️ ${(e as Error).message}. Попробуй через минуту.`);
    }
  }
  if (!station) return i.editReply(`🔎 Станция «${truncate(query, 80)}» не найдена. Открой \`/station\` без названия — там станции по жанрам.`);
  return playStation(i, station);
}

/** Общая часть: проверки, подтверждение замены очереди, включение */
async function playStation(i: ChatInputCommandInteraction | ComponentInteraction, s: RbStation, genreKey?: string, confirmed = false) {
  if (!i.inCachedGuild()) return;
  const member = i.member as GuildMember;
  const voice = member.voice.channel;
  const reply = (content: string, components: any[] = []) => i.editReply({ content, embeds: [], components });
  if (!voice) return reply('🔊 Сначала зайди в голосовой канал.');

  const player = musicApi.getPlayer(i.guildId);
  if (player?.queue.current) {
    const err = musicApi.checkControl(member, player, 'station');
    if (err) return reply(err);
    // Есть очередь треков — спрашиваем, можно ли её заменить
    if (!confirmed && !player.get('station') && player.queue.tracks.length) {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`station:replace:${s.stationuuid}:${genreKey ?? ''}`)
          .setLabel('Заменить очередь')
          .setEmoji('📻')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('station:cancel').setLabel('Отмена').setStyle(ButtonStyle.Secondary),
      );
      return reply(`В очереди **${player.queue.tracks.length}** трек(ов). Включить **${plain(truncate(cleanName(s.name), 80))}** вместо них? Очередь будет очищена.`, [row]);
    }
  }

  await reply(`📡 Проверяю эфир **${plain(truncate(cleanName(s.name), 80))}**…`);
  const requester = { id: member.id, username: member.user.username };
  const first = await tune(i.guildId, voice.id, i.channelId!, requester, s, genreKey);
  if (!first) return reply(`🔴 В эфире: **${plain(truncate(cleanName(s.name), 80))}**`);
  if (first.startsWith('🎶')) return reply(first);

  // Станция мёртвая — предлагаем соседнюю того же жанра
  const g = genreOf(s, genreKey);
  const pool = g ? await genreStations(g.key).catch(() => [] as RbStation[]) : [];
  const alt = pool.filter((x) => x.stationuuid !== s.stationuuid && !isDead(x.stationuuid)).slice(0, 3);
  const row = alt.length
    ? [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`station:pick:${g!.key}`)
            .setPlaceholder(`📻 Другие станции: ${g!.label}`)
            .addOptions(stationOptions(pool.filter((x) => x.stationuuid !== s.stationuuid))),
        ),
      ]
    : [];
  return reply(
    `📴 **${plain(truncate(cleanName(s.name), 80))}** не в эфире: ${first}.\nСтанцию спрятал на сутки.${alt.length ? ' Выбери другую того же жанра 👇' : ''}`,
    row,
  );
}

// ───────────────────────── кнопки и меню ─────────────────────────

export async function onComponent(i: ComponentInteraction) {
  if (!i.inCachedGuild()) return;
  const [, action, arg, arg2] = i.customId.split(':');

  // Меню «Радио-бара»
  if (action === 'genre' && i.isStringSelectMenu()) {
    await i.deferUpdate();
    try {
      return await i.editReply(await genrePayload(i.values[0]));
    } catch (e) {
      return i.editReply({ ...barPayload(`⚠️ ${(e as Error).message}. Попробуй через минуту.`) });
    }
  }
  if (action === 'bar') return i.update(barPayload());
  if (action === 'cancel') return i.update({ content: '👌 Оставил очередь как есть.', embeds: [], components: [] });

  if (action === 'pick' && i.isStringSelectMenu()) {
    await i.update({ content: '⏳ Секунду…', embeds: [], components: [] });
    const s = await stationByUuid(i.values[0]);
    if (!s) return i.editReply('⚠️ Станция пропала из каталога.');
    return playStation(i, s, arg === 'fav' ? 'fav' : arg);
  }
  if (action === 'replace') {
    await i.update({ content: '⏳ Секунду…', components: [] });
    const s = await stationByUuid(arg);
    if (!s) return i.editReply('⚠️ Станция пропала из каталога.');
    return playStation(i, s, arg2 || undefined, true);
  }

  // Кнопки плеера
  const player = musicApi.getPlayer(i.guildId);
  const meta: StationMeta | null = player?.get('station') ?? null;

  if (action === 'list') return respond(i, barPayload());

  if (!player || !meta) return respond(i, '📻 Сейчас радиостанция не играет. Включить — `/station`.');

  if (action === 'fav') {
    if (i.member.voice.channelId !== player.voiceChannelId) {
      return respond(i, '🔇 Добавлять в избранное можно из голосового канала, где играет радио.');
    }
    const s = (await stationByUuid(meta.uuid)) ?? null;
    if (!s) return respond(i, '⚠️ Не удалось найти станцию в каталоге.');
    const on = toggleFavorite(s, i.user.id);
    await musicApi.refreshPanel(player);
    return respond(i, on ? `⭐ **${plain(truncate(meta.name, 80))}** — в избранном сервера.` : `☆ **${plain(truncate(meta.name, 80))}** убрана из избранного.`);
  }

  if (action === 'next') {
    const err = musicApi.checkControl(i.member, player, 'station');
    if (err) return respond(i, err);
    await i.deferReply({ ephemeral: true });
    const candidates = await nextInGenre(meta).catch(() => [] as RbStation[]);
    if (!candidates.length) return i.editReply('📻 Других станций в этой подборке нет. Открой список: `/station`.');
    const requester = { id: i.user.id, username: i.user.username };
    const { station, errors } = await tuneFirstAlive(i.guildId, player.voiceChannelId!, i.channelId!, requester, candidates, meta.genreKey);
    if (station) {
      return i.editReply(`🔴 В эфире: **${plain(truncate(cleanName(station.name), 80))}**${errors.length ? `\n-# Пропустил мёртвые: ${errors.length}` : ''}`);
    }
    return i.editReply(`📴 Не удалось включить соседние станции:\n${errors.slice(0, 4).join('\n')}`);
  }
}

// ───────────────────────── запуск ─────────────────────────

export function setup(_client: Client) {
  musicApi.setStationEndHook((player, reason) => void onStreamEnd(player, reason));
  setInterval(() => void pollAll(), 30_000);
  // Прогреваем список серверов каталога
  setTimeout(() => void getServers(), 10_000);
}
