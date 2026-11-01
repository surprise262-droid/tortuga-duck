import {
  EmbedBuilder,
  Events,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Client,
} from 'discord.js';
import { db, getSetting, setSetting } from '../db';
import { readConfigJson, truncate } from '../util';

/**
 * Календарь кино и сериалов из TMDB (The Movie Database).
 *  • закреплённое сообщение: «🎬 Кино на ближайшее время» и ниже «📺 Сериалы на ближайшее время»;
 *  • карточка с трейлером, когда в календаре появляется новый заметный фильм или сезон.
 * Фильмы — мировые даты релиза (самые ранние). Сериалы — премьеры новых сериалов и новых сезонов.
 * Нужен TMDB_API_KEY в .env (бесплатно, themoviedb.org → Настройки → API).
 */

interface MoviesConfig {
  /** Язык названий и описаний */
  language: string;
  /** На сколько дней вперёд календарь */
  days: number;
  /** Сколько фильмов и сериалов показывать (самые популярные) */
  moviesMax: number;
  seriesMax: number;
  /** Минимальная популярность TMDB, чтобы попасть в календарь */
  movieMinPopularity: number;
  seriesMinPopularity: number;
  /** Минимальная популярность для отдельной карточки-анонса */
  announceMinPopularity: number;
  /** Как часто проверять (минуты) */
  intervalMinutes: number;
}

const DEFAULTS: MoviesConfig = {
  language: 'ru-RU',
  days: 60,
  moviesMax: 20,
  seriesMax: 20,
  movieMinPopularity: 15,
  seriesMinPopularity: 20,
  announceMinPopularity: 60,
  intervalMinutes: 180,
};

interface Entry {
  key: string; // m:123 или t:456:s2 — для «уже анонсировали»
  kind: 'movie' | 'tv';
  id: number;
  title: string;
  original?: string;
  date: Date;
  popularity: number;
  overview?: string;
  poster?: string;
  link: string;
  note?: string; // «новый сериал», «2 сезон · Netflix»
  genres?: string;
}

const FEED_KEY = 'tmdb:upcoming';
const COLOR_MOVIE = 0xed4245;
const COLOR_TV = 0x9b59b6;
const DAY = 24 * 60 * 60_000;
const ATTRIBUTION = 'Данные TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB.';

const loadCfg = (): MoviesConfig => ({ ...DEFAULTS, ...readConfigJson<Partial<MoviesConfig>>('movies.json', {}) });

export const commands = [
  new SlashCommandBuilder().setName('movies_calendar').setDescription('Ближайшие премьеры кино и сериалов'),
  new SlashCommandBuilder()
    .setName('movies_check')
    .setDescription('Проверить премьеры кино и сериалов прямо сейчас (для админов)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
];

let running = false;

export function setup(client: Client) {
  client.once(Events.ClientReady, () => void run(client));
  setInterval(() => void run(client), Math.max(60, loadCfg().intervalMinutes) * 60_000);
}

export async function onCommand(i: ChatInputCommandInteraction) {
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  if (i.commandName === 'movies_calendar') {
    const missing = keyMissing();
    if (missing) return i.editReply(missing);
    const cfg = loadCfg();
    try {
      const { movies, series } = await fetchAll(cfg);
      return i.editReply({ embeds: calendarEmbeds(movies, series, cfg) });
    } catch (e) {
      return i.editReply(`⚠️ TMDB: ${truncate((e as Error).message, 200)}`);
    }
  }
  return i.editReply(await run(i.client));
}

// ───────────────────────── TMDB ─────────────────────────

const tmdbKey = () => (process.env.TMDB_API_KEY ?? '').trim().replace(/^["']|["']$/g, '');

function keyMissing(): string | null {
  return tmdbKey() ? null : '⚪ Не задан TMDB_API_KEY в .env — календарь кино и сериалов выключен.';
}

/** Запрос к TMDB. Подходит и короткий «API Key», и длинный «API Read Access Token» (eyJ…). */
async function tmdb(path: string, params: Record<string, string | number> = {}): Promise<any> {
  const key = tmdbKey();
  const q = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
  else q.set('api_key', key);
  const res = await fetch(`https://api.themoviedb.org/3${path}?${q}`, { headers, signal: AbortSignal.timeout(15_000) });
  if (res.status === 401) throw new Error('TMDB отклонил ключ (HTTP 401) — проверь TMDB_API_KEY');
  if (!res.ok) throw new Error(`TMDB HTTP ${res.status}`);
  return res.json();
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const posterUrl = (p?: string | null) => (p ? `https://image.tmdb.org/t/p/w500${p}` : undefined);

let genreCache: { movie: Map<number, string>; tv: Map<number, string>; at: number } | null = null;
async function genres(language: string) {
  if (genreCache && Date.now() - genreCache.at < 7 * DAY) return genreCache;
  const [m, t] = await Promise.all([tmdb('/genre/movie/list', { language }), tmdb('/genre/tv/list', { language })]);
  const toMap = (j: any) => new Map<number, string>((j?.genres ?? []).map((g: any) => [g.id, g.name]));
  genreCache = { movie: toMap(m), tv: toMap(t), at: Date.now() };
  return genreCache;
}

/** Фильмы: мировая дата премьеры в ближайшие N дней, самые популярные */
async function fetchMovies(cfg: MoviesConfig): Promise<Entry[]> {
  const g = await genres(cfg.language);
  const from = ymd(new Date(Date.now() - DAY));
  const to = ymd(new Date(Date.now() + cfg.days * DAY));
  const out: Entry[] = [];
  for (let page = 1; page <= 3; page++) {
    const j = await tmdb('/discover/movie', {
      language: cfg.language,
      sort_by: 'popularity.desc',
      include_adult: 'false',
      include_video: 'false',
      'primary_release_date.gte': from,
      'primary_release_date.lte': to,
      page,
    });
    for (const m of j?.results ?? []) {
      if ((m.popularity ?? 0) < cfg.movieMinPopularity || !m.release_date) continue;
      out.push({
        key: `m:${m.id}`,
        kind: 'movie',
        id: m.id,
        title: m.title || m.original_title,
        original: m.original_title !== m.title ? m.original_title : undefined,
        date: new Date(`${m.release_date}T00:00:00Z`),
        popularity: m.popularity,
        overview: m.overview,
        poster: posterUrl(m.poster_path),
        link: `https://www.themoviedb.org/movie/${m.id}?language=ru`,
        genres: (m.genre_ids ?? []).map((id: number) => g.movie.get(id)).filter(Boolean).slice(0, 3).join(', '),
      });
    }
    if (page >= (j?.total_pages ?? 1)) break;
  }
  return out.sort((a, b) => b.popularity - a.popularity).slice(0, cfg.moviesMax);
}

/**
 * Сериалы: берём популярные сериалы, у которых в ближайшие N дней выходят эпизоды,
 * и оставляем только премьеры — первый эпизод нового сериала или нового сезона.
 */
async function fetchSeries(cfg: MoviesConfig): Promise<Entry[]> {
  const g = await genres(cfg.language);
  const now = Date.now();
  const from = ymd(new Date(now - DAY));
  const to = ymd(new Date(now + cfg.days * DAY));
  const candidates: any[] = [];
  for (let page = 1; page <= 3; page++) {
    const j = await tmdb('/discover/tv', {
      language: cfg.language,
      sort_by: 'popularity.desc',
      include_adult: 'false',
      'air_date.gte': from,
      'air_date.lte': to,
      page,
    });
    candidates.push(...(j?.results ?? []).filter((t: any) => (t.popularity ?? 0) >= cfg.seriesMinPopularity));
    if (page >= (j?.total_pages ?? 1)) break;
  }

  const out: Entry[] = [];
  // Проверяем самые популярные: у кого следующий эпизод — первый в сезоне
  for (const t of candidates.slice(0, 45)) {
    try {
      const d = await tmdb(`/tv/${t.id}`, { language: cfg.language });
      const next = d?.next_episode_to_air;
      if (!next?.air_date || next.episode_number !== 1) continue;
      const date = new Date(`${next.air_date}T00:00:00Z`);
      if (date.getTime() < now - DAY || date.getTime() > now + cfg.days * DAY) continue;
      const network = d.networks?.[0]?.name;
      const isNew = next.season_number === 1;
      out.push({
        key: `t:${t.id}:s${next.season_number}`,
        kind: 'tv',
        id: t.id,
        title: d.name || t.name || t.original_name,
        original: t.original_name !== (d.name || t.name) ? t.original_name : undefined,
        date,
        popularity: t.popularity,
        overview: next.overview || d.overview,
        poster: posterUrl(d.seasons?.find((s: any) => s.season_number === next.season_number)?.poster_path ?? d.poster_path),
        link: `https://www.themoviedb.org/tv/${t.id}?language=ru`,
        note: `${isNew ? 'новый сериал' : `${next.season_number} сезон`}${network ? ` · ${network}` : ''}`,
        genres: (t.genre_ids ?? []).map((id: number) => g.tv.get(id)).filter(Boolean).slice(0, 3).join(', '),
      });
    } catch (e) {
      console.warn(`[movies] Сериал ${t.id}:`, (e as Error).message);
    }
    await sleep(120); // бережно к лимитам TMDB
  }
  return out.sort((a, b) => b.popularity - a.popularity).slice(0, cfg.seriesMax);
}

async function fetchAll(cfg: MoviesConfig) {
  const movies = await fetchMovies(cfg);
  const series = await fetchSeries(cfg);
  return { movies, series };
}

/** Трейлер на YouTube: сначала на русском, потом любой */
async function trailerUrl(e: Entry): Promise<string | undefined> {
  for (const language of ['ru-RU', 'en-US']) {
    try {
      const j = await tmdb(`/${e.kind}/${e.id}/videos`, { language });
      const v = (j?.results ?? [])
        .filter((x: any) => x.site === 'YouTube' && ['Trailer', 'Teaser'].includes(x.type))
        .sort((a: any, b: any) => Number(b.type === 'Trailer') - Number(a.type === 'Trailer') || Number(b.official) - Number(a.official))[0];
      if (v?.key) return `https://www.youtube.com/watch?v=${v.key}`;
    } catch {
      /* без трейлера */
    }
  }
  return undefined;
}

// ───────────────────────── основной цикл ─────────────────────────

const seen = {
  count: () => (db.prepare('SELECT COUNT(*) AS n FROM news_seen WHERE feed = ?').get(FEED_KEY) as { n: number }).n,
  has: (k: string) => !!db.prepare('SELECT 1 FROM news_seen WHERE feed = ? AND guid = ?').get(FEED_KEY, k),
  add: (k: string) => db.prepare('INSERT OR IGNORE INTO news_seen (feed, guid, ts) VALUES (?, ?, ?)').run(FEED_KEY, k, Date.now()),
};

export function resetMoviesAnnounce() {
  db.prepare('DELETE FROM news_seen WHERE feed = ?').run(FEED_KEY);
  setSetting('movies.calendar_msg', null);
}

export function runMoviesNow(client: Client) {
  return run(client);
}

async function run(client: Client): Promise<string> {
  if (running) return '⏳ Проверка уже идёт.';
  const channelId = getSetting('channel.movies_announce');
  if (!channelId) return '⚪ Канал не назначен: `/setup channel` → «Кино и сериалы: премьеры и календарь».';
  const missing = keyMissing();
  if (missing) return missing;
  running = true;
  try {
    const cfg = loadCfg();
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased() || !('send' in channel)) return `❌ Бот не видит канал <#${channelId}>.`;

    let movies: Entry[];
    let series: Entry[];
    try {
      ({ movies, series } = await fetchAll(cfg));
    } catch (e) {
      console.warn('[movies] TMDB:', (e as Error).message);
      return `❌ ${truncate((e as Error).message, 200)}`;
    }

    // Карточки для новых заметных премьер. Первый запуск — только запоминаем.
    const notable = [...movies, ...series].filter((x) => x.popularity >= cfg.announceMinPopularity);
    let posted = 0;
    if (seen.count() === 0) {
      notable.forEach((x) => seen.add(x.key));
    } else {
      for (const x of notable.filter((n) => !seen.has(n.key)).slice(0, 4)) {
        try {
          const trailer = await trailerUrl(x);
          // Ссылку на трейлер отправляем текстом — Discord покажет под ней плеер
          await channel.send({ content: trailer ? `▶️ Трейлер: ${trailer}` : undefined, embeds: [announceEmbed(x)] });
          posted++;
        } catch (e) {
          console.warn('[movies] Не отправилась карточка:', (e as Error).message);
        }
        seen.add(x.key);
      }
      notable.forEach((x) => seen.add(x.key));
    }

    await updateCalendar(channel, movies, series, cfg);
    if (posted) console.log(`[movies] Новых премьер: ${posted}`);
    return `✅ TMDB: фильмов ${movies.length}, сериалов ${series.length}. Новых карточек: ${posted}. Календарь обновлён.`;
  } finally {
    running = false;
  }
}

// ───────────────────────── оформление ─────────────────────────

const dd = (d: Date) => `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
const unix = (d: Date) => Math.floor(d.getTime() / 1000);

function announceEmbed(x: Entry) {
  const e = new EmbedBuilder()
    .setColor(x.kind === 'movie' ? COLOR_MOVIE : COLOR_TV)
    .setAuthor({ name: x.kind === 'movie' ? '🎬 Скоро в кино' : x.note?.startsWith('новый') ? '📺 Новый сериал' : '📺 Новый сезон' })
    .setTitle(truncate(x.title, 250))
    .setURL(x.link)
    .addFields({ name: 'Премьера', value: `<t:${unix(x.date)}:D> (<t:${unix(x.date)}:R>)`, inline: true })
    .setFooter({ text: ATTRIBUTION });
  if (x.note) e.addFields({ name: 'Сезон', value: x.note, inline: true });
  if (x.genres) e.addFields({ name: 'Жанры', value: x.genres, inline: true });
  const desc = [x.original ? `*${truncate(x.original, 150)}*` : '', x.overview ? truncate(x.overview, 350) : ''].filter(Boolean).join('\n\n');
  if (desc) e.setDescription(desc);
  if (x.poster) e.setThumbnail(x.poster);
  return e;
}

function listText(items: Entry[], empty: string): string {
  if (!items.length) return empty;
  const lines = [...items]
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .map((x) => `\`${dd(x.date)}\` [${truncate(x.title, 55).replace(/[[\]]/g, '')}](${x.link})${x.note ? ` · ${x.note}` : ''}`);
  let text = '';
  for (const l of lines) {
    if (text.length + l.length + 1 > 3900) break;
    text += `${l}\n`;
  }
  return text.trimEnd();
}

function calendarEmbeds(movies: Entry[], series: Entry[], cfg: MoviesConfig) {
  return [
    new EmbedBuilder()
      .setColor(COLOR_MOVIE)
      .setTitle('🎬 Кино на ближайшее время')
      .setDescription(listText(movies, 'Громких премьер в ближайшие недели нет.')),
    new EmbedBuilder()
      .setColor(COLOR_TV)
      .setTitle('📺 Сериалы на ближайшее время')
      .setDescription(listText(series, 'Громких премьер сериалов и новых сезонов в ближайшие недели нет.'))
      .setTimestamp(new Date())
      .setFooter({ text: `Мировые даты премьер на ${cfg.days} дней • обновляется автоматически • ${ATTRIBUTION}` }),
  ];
}

async function updateCalendar(channel: any, movies: Entry[], series: Entry[], cfg: MoviesConfig) {
  const embeds = calendarEmbeds(movies, series, cfg);
  const msgId = getSetting('movies.calendar_msg');
  if (msgId) {
    const msg = await channel.messages.fetch(msgId).catch(() => null);
    if (msg) {
      await msg.edit({ embeds }).catch((e: Error) => console.warn('[movies] Не обновился календарь:', e.message));
      return;
    }
  }
  const msg = await channel.send({ embeds }).catch((e: Error) => {
    console.warn('[movies] Не отправился календарь:', e.message);
    return null;
  });
  if (!msg) return;
  setSetting('movies.calendar_msg', msg.id);
  await msg.pin().catch(() => console.warn('[movies] Не удалось закрепить календарь (нужно право «Управлять сообщениями»)'));
}
