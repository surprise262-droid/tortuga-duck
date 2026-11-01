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
import { trailerButtonRow, trailerMenus } from '../trailerUi';
import { upsertPinned } from '../calendarMsg';
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
  moviesMax: 25,
  seriesMax: 25,
  movieMinPopularity: 4,
  seriesMinPopularity: 8,
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
      return i.editReply({ embeds: calendarEmbeds(movies, series, cfg), components: calendarComponents(movies, series) });
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
  const from = ymd(new Date());
  const to = ymd(new Date(Date.now() + cfg.days * DAY));
  const out: Entry[] = [];
  for (let page = 1; page <= 5; page++) {
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
        link: `https://themoviedb.org/movie/${m.id}`,
        genres: (m.genre_ids ?? []).map((id: number) => g.movie.get(id)).filter(Boolean).slice(0, 3).join(', '),
      });
    }
    if (page >= (j?.total_pages ?? 1)) break;
  }
  const top = out.sort((a, b) => b.popularity - a.popularity).slice(0, cfg.moviesMax);
  await fixForeignTitles(top);
  return top;
}

/** Если у названия нет перевода и оно не кириллицей/латиницей (хинди, китайский…) — берём английское */
const readable = (t: string) => /^[\p{Script=Latin}\p{Script=Cyrillic}\p{N}\p{P}\p{S}\s]+$/u.test(t);
async function fixForeignTitles(items: Entry[]) {
  for (const x of items) {
    if (readable(x.title)) continue;
    try {
      const j = await tmdb(`/${x.kind}/${x.id}`, { language: 'en-US' });
      const en = x.kind === 'movie' ? j?.title : j?.name;
      if (en && readable(en)) {
        x.original = x.original ?? x.title;
        x.title = en;
      }
    } catch {
      /* оставим как есть */
    }
  }
}

/**
 * Сериалы: берём популярные сериалы, у которых в ближайшие N дней выходят эпизоды,
 * и оставляем только премьеры — первый эпизод нового сериала или нового сезона.
 */
async function fetchSeries(cfg: MoviesConfig): Promise<Entry[]> {
  const g = await genres(cfg.language);
  const now = Date.now();
  const from = ymd(new Date());
  const to = ymd(new Date(now + cfg.days * DAY));
  // Без ток-шоу, новостей, мыльных опер и реалити — они забивают верх популярности, а премьер сезонов у них нет
  const without = '10763,10764,10766,10767';

  const byId = new Map<number, any>();
  const collect = async (params: Record<string, string | number>, pages: number) => {
    for (let page = 1; page <= pages; page++) {
      const j = await tmdb('/discover/tv', {
        language: cfg.language,
        sort_by: 'popularity.desc',
        include_adult: 'false',
        without_genres: without,
        ...params,
        page,
      });
      for (const t of j?.results ?? []) if ((t.popularity ?? 0) >= cfg.seriesMinPopularity && !byId.has(t.id)) byId.set(t.id, t);
      if (page >= (j?.total_pages ?? 1)) break;
    }
  };
  // 1) Совсем новые сериалы: первый эпизод в окне
  await collect({ 'first_air_date.gte': from, 'first_air_date.lte': to }, 3);
  // 2) Сериалы, у которых в окне выходят эпизоды — среди них ищем премьеры новых сезонов
  await collect({ 'air_date.gte': from, 'air_date.lte': to }, 6);

  const candidates = [...byId.values()].sort((a, b) => b.popularity - a.popularity).slice(0, 90);
  const out: Entry[] = [];
  for (const t of candidates) {
    try {
      const d = await tmdb(`/tv/${t.id}`, { language: cfg.language });
      const next = d?.next_episode_to_air;
      // Премьера = первый эпизод сезона в ближайшие N дней
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
        link: `https://themoviedb.org/tv/${t.id}`,
        note: `${isNew ? 'новый сериал' : `${next.season_number} сезон`}${network ? ` · ${network}` : ''}`,
        genres: (t.genre_ids ?? []).map((id: number) => g.tv.get(id)).filter(Boolean).slice(0, 3).join(', '),
      });
    } catch (e) {
      console.warn(`[movies] Сериал ${t.id}:`, (e as Error).message);
    }
    await sleep(80); // бережно к лимитам TMDB
  }
  console.log(`[movies] Сериалов-кандидатов: ${candidates.length}, премьер найдено: ${out.length}`);
  const top = out.sort((a, b) => b.popularity - a.popularity).slice(0, cfg.seriesMax);
  await fixForeignTitles(top);
  return top;
}

async function fetchAll(cfg: MoviesConfig) {
  const movies = await fetchMovies(cfg);
  const series = await fetchSeries(cfg);
  return { movies, series };
}

/** Трейлер на YouTube: сначала на русском, потом любой */
async function trailerFor(kind: 'movie' | 'tv', id: number): Promise<string | undefined> {
  for (const language of ['ru-RU', 'en-US']) {
    try {
      const j = await tmdb(`/${kind}/${id}/videos`, { language });
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

/** Для кнопки/меню «Трейлер»: название и ссылка на трейлер */
export async function tmdbTrailer(kind: 'movie' | 'tv', id: number): Promise<{ title: string; url?: string }> {
  if (keyMissing()) return { title: '' };
  const d = await tmdb(`/${kind}/${id}`, { language: loadCfg().language }).catch(() => null);
  let title: string = (kind === 'movie' ? d?.title || d?.original_title : d?.name || d?.original_name) ?? '';
  if (title && !readable(title)) {
    const en = await tmdb(`/${kind}/${id}`, { language: 'en-US' }).catch(() => null);
    title = (kind === 'movie' ? en?.title : en?.name) || title;
  }
  return { title, url: await trailerFor(kind, id) };
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
          // Кнопка «Трейлер» — только если трейлер есть; сам трейлер придёт лично нажавшему
          const trailer = await trailerFor(x.kind, x.id);
          await channel.send({
            embeds: [announceEmbed(x)],
            components: trailer ? [trailerButtonRow(x.kind === 'movie' ? 'tmdbm' : 'tmdbt', x.id)] : [],
          });
          posted++;
        } catch (e) {
          console.warn('[movies] Не отправилась карточка:', (e as Error).message);
        }
        seen.add(x.key);
      }
      notable.forEach((x) => seen.add(x.key));
    }

    await migrateOldCards(channel).catch((e) => console.warn('[movies] Перестройка старых карточек:', (e as Error).message));
    const calStatus = await updateCalendar(channel, movies, series, cfg);
    if (posted) console.log(`[movies] Новых премьер: ${posted}`);
    return `✅ TMDB: фильмов ${movies.length}, сериалов ${series.length}. Новых карточек: ${posted}. ${calStatus}`;
  } finally {
    running = false;
  }
}

/**
 * Разово: старые карточки (до кнопок) были со ссылкой «▶️ Трейлер: …» над карточкой.
 * Убираем ссылку и ставим кнопку «Трейлер». Бот правит только свои сообщения.
 */
async function migrateOldCards(channel: any) {
  if (getSetting('movies.cards_migrated') === '1') return;
  const me = channel.client?.user?.id;
  const messages = await channel.messages.fetch({ limit: 100 });
  let fixed = 0;
  for (const m of messages.values()) {
    if (m.author?.id !== me || !m.content?.startsWith('▶️ Трейлер:') || !m.embeds?.length) continue;
    const url = m.embeds[0]?.url ?? '';
    const found = url.match(/themoviedb\.org\/(movie|tv)\/(\d+)/);
    if (!found) continue;
    await m
      .edit({ content: '', components: [trailerButtonRow(found[1] === 'movie' ? 'tmdbm' : 'tmdbt', Number(found[2]))] })
      .then(() => fixed++)
      .catch((e: Error) => console.warn('[movies] Не перестроилась карточка:', e.message));
  }
  setSetting('movies.cards_migrated', '1');
  if (fixed) console.log(`[movies] Старых карточек перестроено: ${fixed}`);
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
    // Два списка в одном сообщении, а лимит Discord — 6000 символов на всё: каждому не больше ~2300
    if (text.length + l.length + 1 > 2300) break;
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

/** Меню «▶️ Трейлер к фильму / сериалу…» под календарём */
function calendarComponents(movies: Entry[], series: Entry[]) {
  const byDate = (arr: Entry[]) => [...arr].sort((a, b) => a.date.getTime() - b.date.getTime());
  return [
    ...trailerMenus(
      byDate(movies).map((x) => ({ source: 'tmdbm' as const, id: x.id, title: x.title, hint: `🎬 ${dd(x.date)}` })),
      '▶️ Трейлер к фильму…',
      'mov',
      1,
    ),
    ...trailerMenus(
      byDate(series).map((x) => ({ source: 'tmdbt' as const, id: x.id, title: x.title, hint: `📺 ${dd(x.date)} · ${x.note ?? ''}` })),
      '▶️ Трейлер к сериалу…',
      'tv',
      1,
    ),
  ];
}

async function updateCalendar(channel: any, movies: Entry[], series: Entry[], cfg: MoviesConfig): Promise<string> {
  const embeds = calendarEmbeds(movies, series, cfg);
  const components = calendarComponents(movies, series);
  return upsertPinned(channel, 'movies.calendar_msg', { embeds, components }, 'movies');
}
