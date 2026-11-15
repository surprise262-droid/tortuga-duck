import { createCanvas, loadImage } from '@napi-rs/canvas';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  TextInputStyle,
  type Client,
  type Guild,
} from 'discord.js';
import { createHash } from 'node:crypto';
import { getSetting, setSetting } from '../db';
import type { ComponentInteraction } from '../types';
import { plain, readConfigJson, truncate } from '../util';
import { shikiRussianNames, shikiSearch } from './anime';
import { tmdbGet, tmdbTitle } from './movies';
import { FONT } from './welcome';
import { COLS_MAX, drawPosterStrip, stripSize, type StripItem } from '../posterStrip';

/**
 * «Хронология просмотра»: панель в отдельном канале (/setup channel → «Хронология просмотра»).
 *  • «🔎 Найти» → окошко с названием → выбор из совпадений → ответ видит только тот, кто искал;
 *  • вкладки «📅 По выходу» и «🌌 По событиям», пометки основная/побочная/можно пропустить;
 *  • если часть сейчас выходит — расписание серий;
 *  • меню «Открыть часть» → мини-карточка с трейлером, «Буду смотреть» и «Напомнить» (modules/watchlist.ts).
 * Источники: AniList (связи и расписание аниме), Shikimori (русские названия), TMDB (фильмы и сериалы),
 * config/watchorders.json (ручные хронологии сложных вселенных).
 *
 * Также здесь кнопка «📅 Расписание серий» для карточек анонсов (customId wo:sched:<shiki|tmdbt>:<id>).
 */

export const componentPrefix = 'wo';

/** /watchorder (в русском Discord — /хронология) с подсказками по мере ввода, как у /play */
export const commands = [
  new SlashCommandBuilder()
    .setName('watchorder')
    .setNameLocalizations({ ru: 'хронология' })
    .setDescription('Order to watch: all parts, prequels, sequels and episode schedule')
    .setDescriptionLocalizations({ ru: 'В каком порядке смотреть: все части, приквелы, сиквелы и расписание серий' })
    .addStringOption((o) =>
      o
        .setName('query')
        .setNameLocalizations({ ru: 'название' })
        .setDescription('Anime, series, movie or universe')
        .setDescriptionLocalizations({ ru: 'Аниме, сериал, фильм или вселенная' })
        .setRequired(true)
        .setAutocomplete(true),
    ),
];

type Tag = 'main' | 'side' | 'skip' | 'alt';
const TAG_TEXT: Record<Tag, string> = { main: '', side: ' · ➕ побочная', skip: ' · ⏭ можно пропустить', alt: ' · 🔀 другая версия' };

interface Entry {
  title: string;
  kind: string;
  /** YYYY-MM-DD или YYYY, если известен только год */
  date: string | null;
  episodes?: number;
  tag: Tag;
  /** Значение для мини-карточки watchlist: shiki:<malId> | tmdbm:<id> | tmdbt:<id> */
  pick?: string;
  airing?: boolean;
  /** Оценка 0–10 (AniList/TMDB) */
  score?: number;
  /** Постер (для полосы постеров фильмов) */
  poster?: string;
}

interface Episode {
  ep: number;
  /** unix-секунды; для сериалов TMDB — полдень по UTC в день выхода */
  at: number;
  dateOnly?: boolean;
}

interface Franchise {
  title: string;
  poster?: string;
  release: Entry[];
  events: Entry[];
  /** откуда взят порядок по событиям */
  eventsNote: string;
  note?: string;
  truncated?: boolean;
  schedule?: { title: string; episodes: Episode[]; total?: number };
}

// ───────────────────────── AniList ─────────────────────────

async function anilist(query: string, variables: Record<string, unknown>): Promise<any> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 429 && attempt === 0) {
      const wait = Math.min(30, Number(res.headers.get('retry-after')) || 5);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`AniList HTTP ${res.status}`);
    const body: any = await res.json();
    if (body.errors?.length) throw new Error(`AniList: ${body.errors[0].message}`);
    return body.data;
  }
  throw new Error('AniList: слишком много запросов, попробуй через минуту');
}

const MEDIA_FIELDS = `id idMal format status episodes seasonYear averageScore coverImage { large }
  startDate { year month day }
  title { romaji english }
  nextAiringEpisode { episode airingAt }
  relations { edges { relationType(version: 2) node { id type format } } }`;

const FORMAT_RU: Record<string, string> = {
  TV: 'TV',
  TV_SHORT: 'TV (короткие серии)',
  MOVIE: 'фильм',
  SPECIAL: 'спешл',
  OVA: 'OVA',
  ONA: 'ONA',
  MUSIC: 'клип',
};

/** Связи, по которым идём по вселенной. CHARACTER/OTHER/ADAPTATION уводят в чужие тайтлы и мангу — их пропускаем. */
const FOLLOW = new Set(['PREQUEL', 'SEQUEL', 'PARENT', 'SIDE_STORY', 'SPIN_OFF', 'ALTERNATIVE', 'SUMMARY', 'COMPILATION']);
const MAX_NODES = 70;

const aniDate = (d: any): string | null =>
  d?.year ? `${d.year}-${String(d.month ?? 1).padStart(2, '0')}-${String(d.day ?? 1).padStart(2, '0')}` : null;

async function animeFranchise(rootId: number): Promise<Franchise> {
  const nodes = new Map<number, any>();
  let frontier = [rootId];
  let truncated = false;
  while (frontier.length) {
    const batch = frontier.slice(0, 50);
    frontier = frontier.slice(50);
    const data = await anilist(`query ($ids: [Int]) { Page(perPage: 50) { media(id_in: $ids, type: ANIME) { ${MEDIA_FIELDS} } } }`, {
      ids: batch,
    });
    for (const m of data?.Page?.media ?? []) nodes.set(m.id, m);
    const next: number[] = [];
    for (const id of batch) {
      for (const e of nodes.get(id)?.relations?.edges ?? []) {
        const n = e.node;
        if (n?.type !== 'ANIME' || n.format === 'MUSIC' || !FOLLOW.has(e.relationType)) continue;
        if (nodes.has(n.id) || next.includes(n.id) || frontier.includes(n.id)) continue;
        if (nodes.size + next.length + frontier.length >= MAX_NODES) {
          truncated = true;
          continue;
        }
        next.push(n.id);
      }
    }
    frontier.push(...next);
  }

  // Русские названия с Shikimori (id Shikimori = id MyAnimeList)
  const ru = await shikiRussianNames([...nodes.values()].map((m) => m.idMal).filter(Boolean));

  // Основная линия: всё, что связано с выбранным тайтлом цепочкой приквелов/сиквелов
  const main = new Set<number>([rootId]);
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    for (const e of nodes.get(id)?.relations?.edges ?? []) {
      if ((e.relationType === 'PREQUEL' || e.relationType === 'SEQUEL') && nodes.has(e.node.id) && !main.has(e.node.id)) {
        main.add(e.node.id);
        stack.push(e.node.id);
      }
    }
  }
  const tagOf = new Map<number, Tag>();
  for (const m of nodes.values()) tagOf.set(m.id, main.has(m.id) ? 'main' : 'side');
  for (const m of nodes.values()) {
    for (const e of m.relations?.edges ?? []) {
      if (!nodes.has(e.node.id) || main.has(e.node.id)) continue;
      if (e.relationType === 'SUMMARY' || e.relationType === 'COMPILATION') tagOf.set(e.node.id, 'skip');
      else if (e.relationType === 'ALTERNATIVE' && tagOf.get(e.node.id) !== 'skip') tagOf.set(e.node.id, 'alt');
    }
  }

  const entry = (m: any): Entry => ({
    title: (m.idMal && ru.get(m.idMal)) || m.title?.english || m.title?.romaji || `#${m.id}`,
    kind: FORMAT_RU[m.format] ?? m.format ?? 'аниме',
    date: aniDate(m.startDate),
    episodes: m.episodes ?? undefined,
    tag: tagOf.get(m.id) ?? 'side',
    pick: m.idMal ? `shiki:${m.idMal}` : undefined,
    airing: m.status === 'RELEASING',
    score: m.averageScore ? m.averageScore / 10 : undefined,
    poster: m.coverImage?.large,
  });

  const byDate = (a: any, b: any) => (aniDate(a.startDate) ?? '9999').localeCompare(aniDate(b.startDate) ?? '9999');
  const all = [...nodes.values()];
  const release = [...all].sort(byDate);

  // По событиям: приквел раньше сиквела, побочная история — после «родителя». Остальное — по дате.
  const before = new Map<number, Set<number>>(); // id → кто должен идти раньше
  const need = (first: number, then: number) => {
    if (!nodes.has(first) || !nodes.has(then) || first === then) return;
    if (!before.has(then)) before.set(then, new Set());
    before.get(then)!.add(first);
  };
  for (const m of all) {
    for (const e of m.relations?.edges ?? []) {
      if (e.relationType === 'SEQUEL') need(m.id, e.node.id);
      else if (e.relationType === 'PREQUEL') need(e.node.id, m.id);
      else if (e.relationType === 'SIDE_STORY') need(m.id, e.node.id);
      else if (e.relationType === 'PARENT') need(e.node.id, m.id);
    }
  }
  const events: any[] = [];
  const placed = new Set<number>();
  const pending = [...release];
  while (pending.length) {
    const k = pending.findIndex((m) => [...(before.get(m.id) ?? [])].every((p) => placed.has(p)));
    // Круговые связи (бывает в базах) — берём самый ранний по дате
    const pickIdx = k >= 0 ? k : 0;
    const [m] = pending.splice(pickIdx, 1);
    placed.add(m.id);
    events.push(m);
  }

  const root = nodes.get(rootId);
  const airingNode = all.find((m) => m.status === 'RELEASING') ?? all.find((m) => m.status === 'NOT_YET_RELEASED' && m.nextAiringEpisode);
  let schedule: Franchise['schedule'];
  if (airingNode) {
    const eps = await animeSchedule(airingNode.id).catch(() => []);
    if (eps.length) schedule = { title: entry(airingNode).title, episodes: eps, total: airingNode.episodes ?? undefined };
  }
  return {
    title: root ? entry(root).title : 'Аниме',
    poster: root?.coverImage?.large,
    release: release.map(entry),
    events: events.map(entry),
    eventsNote: 'по сюжетным связям (приквел → сиквел), примерно',
    truncated,
    schedule,
  };
}

async function animeSchedule(anilistId: number): Promise<Episode[]> {
  const data = await anilist(
    `query ($id: Int) { Media(id: $id, type: ANIME) { airingSchedule(perPage: 50) { nodes { episode airingAt } } } }`,
    { id: anilistId },
  );
  return (data?.Media?.airingSchedule?.nodes ?? []).map((n: any) => ({ ep: n.episode, at: n.airingAt }));
}

/** Расписание по id Shikimori/MAL — для кнопки в анонсах */
async function animeScheduleByMal(malId: number): Promise<{ title: string; episodes: Episode[]; total?: number } | null> {
  const data = await anilist(
    `query ($id: Int) { Media(idMal: $id, type: ANIME) { id title { romaji english } episodes airingSchedule(perPage: 50) { nodes { episode airingAt } } } }`,
    { id: malId },
  );
  const m = data?.Media;
  if (!m) return null;
  const ru = await shikiRussianNames([malId]);
  return {
    title: ru.get(malId) || m.title?.english || m.title?.romaji,
    total: m.episodes ?? undefined,
    episodes: (m.airingSchedule?.nodes ?? []).map((n: any) => ({ ep: n.episode, at: n.airingAt })),
  };
}

// ───────────────────────── TMDB ─────────────────────────

const tmdbPoster = (p?: string | null) => (p ? `https://image.tmdb.org/t/p/w342${p}` : undefined);
const noon = (ymd: string) => Math.floor(Date.parse(`${ymd}T12:00:00Z`) / 1000);

async function tvSchedule(tvId: number, d?: any): Promise<{ title: string; episodes: Episode[]; total?: number } | null> {
  const show = d ?? (await tmdbGet(`/tv/${tvId}`));
  if (!show) return null;
  const season = show.next_episode_to_air?.season_number ?? show.last_episode_to_air?.season_number;
  if (season == null) return null;
  const s = await tmdbGet(`/tv/${tvId}/season/${season}`).catch(() => null);
  const episodes: Episode[] = (s?.episodes ?? [])
    .filter((e: any) => e.air_date)
    .map((e: any) => ({ ep: e.episode_number, at: noon(e.air_date), dateOnly: true }));
  return { title: `${await tmdbTitle('tv', show)} — ${season} сезон`, episodes, total: s?.episodes?.length || undefined };
}

async function movieFranchise(movieId: number): Promise<Franchise> {
  const m = await tmdbGet(`/movie/${movieId}`);
  if (!m) throw new Error('нет ключа TMDB');
  const coll = m.belongs_to_collection?.id ? await tmdbGet(`/collection/${m.belongs_to_collection.id}`).catch(() => null) : null;
  const parts: any[] = coll?.parts?.length ? coll.parts : [m];
  const entries: Entry[] = [];
  for (const p of parts) {
    entries.push({
      title: await tmdbTitle('movie', p),
      kind: 'фильм',
      date: p.release_date || null,
      tag: 'main',
      pick: `tmdbm:${p.id}`,
      score: p.vote_average || undefined,
      poster: tmdbPoster(p.poster_path),
    });
  }
  entries.sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999'));
  return {
    title: (coll?.name ?? (await tmdbTitle('movie', m))).replace(/\s*\((Коллекция|Collection)\)\s*$/i, ''),
    poster: tmdbPoster(coll?.poster_path ?? m.poster_path),
    release: entries,
    events: entries,
    eventsNote: 'для серии фильмов TMDB знает только порядок выхода',
  };
}

async function tvFranchise(tvId: number): Promise<Franchise> {
  const d = await tmdbGet(`/tv/${tvId}`);
  if (!d) throw new Error('нет ключа TMDB');
  const title = await tmdbTitle('tv', d);
  const entries: Entry[] = (d.seasons ?? [])
    .filter((s: any) => s.episode_count > 0)
    .sort((a: any, b: any) => (a.season_number || 999) - (b.season_number || 999))
    .map((s: any) => ({
      title: s.season_number === 0 ? `${title}: спецвыпуски` : `${title} — ${s.season_number} сезон`,
      kind: 'сериал',
      date: s.air_date || null,
      episodes: s.episode_count,
      tag: s.season_number === 0 ? 'skip' : 'main',
      pick: `tmdbt:${d.id}`,
      airing: d.next_episode_to_air?.season_number === s.season_number,
      score: s.vote_average || undefined,
    }));
  let schedule: Franchise['schedule'];
  if (d.next_episode_to_air) {
    const sch = await tvSchedule(tvId, d).catch(() => null);
    if (sch?.episodes.length) schedule = sch;
  }
  return { title, poster: tmdbPoster(d.poster_path), release: entries, events: entries, eventsNote: 'сезоны по порядку', schedule };
}

// ───────────────────────── ручные хронологии ─────────────────────────

interface CuratedItem {
  type: 'anime' | 'movie' | 'tv';
  q: string;
  year?: number;
  tag?: Tag;
}
interface Universe {
  key: string;
  title: string;
  aliases?: string[];
  note?: string;
  items: CuratedItem[];
}
const universes = () => readConfigJson<{ universes?: Universe[] }>('watchorders.json', {}).universes ?? [];

/** Найденный id для записи ручного списка запоминаем в базе — поиск по названию нужен один раз */
async function resolveItem(it: CuratedItem): Promise<Entry | null> {
  const key = `wo.res2.${createHash('sha1').update(`${it.type}|${it.q}|${it.year ?? ''}`).digest('hex').slice(0, 16)}`;
  const cached = getSetting(key);
  if (cached) {
    try {
      return { ...JSON.parse(cached), tag: it.tag ?? 'main' };
    } catch {
      /* перерешаем */
    }
  }
  let e: Entry | null = null;
  if (it.type === 'anime') {
    const data = await anilist(
      `query ($q: String) { Page(perPage: 8) { media(search: $q, type: ANIME, sort: SEARCH_MATCH) { id idMal format averageScore coverImage { large } startDate { year month day } episodes title { romaji english } } } }`,
      { q: it.q },
    );
    const list: any[] = data?.Page?.media ?? [];
    const m = list.find((x) => !it.year || x.startDate?.year === it.year) ?? list[0];
    if (m) {
      const ru = m.idMal ? await shikiRussianNames([m.idMal]) : new Map();
      e = {
        title: ru.get(m.idMal) || m.title?.english || m.title?.romaji,
        kind: FORMAT_RU[m.format] ?? 'аниме',
        date: aniDate(m.startDate),
        episodes: m.episodes ?? undefined,
        tag: 'main',
        pick: m.idMal ? `shiki:${m.idMal}` : undefined,
        score: m.averageScore ? m.averageScore / 10 : undefined,
        poster: m.coverImage?.large,
      };
    }
  } else {
    const kind = it.type;
    const params: Record<string, string | number> = { query: it.q };
    if (it.year) params[kind === 'movie' ? 'year' : 'first_air_date_year'] = it.year;
    const res = await tmdbGet(`/search/${kind}`, params);
    const m = res?.results?.[0];
    if (m) {
      e = {
        title: await tmdbTitle(kind, m),
        kind: kind === 'movie' ? 'фильм' : 'сериал',
        date: (kind === 'movie' ? m.release_date : m.first_air_date) || null,
        tag: 'main',
        pick: `${kind === 'movie' ? 'tmdbm' : 'tmdbt'}:${m.id}`,
        score: m.vote_average || undefined,
        poster: tmdbPoster(m.poster_path),
      };
    }
  }
  if (!e) e = { title: it.q, kind: it.type === 'movie' ? 'фильм' : it.type === 'tv' ? 'сериал' : 'аниме', date: it.year ? String(it.year) : null, tag: 'main' };
  else setSetting(key, JSON.stringify(e));
  return { ...e, tag: it.tag ?? 'main' };
}

async function curatedFranchise(u: Universe): Promise<Franchise> {
  const events: Entry[] = [];
  for (const it of u.items.slice(0, 60)) {
    const e = await resolveItem(it).catch(() => null);
    if (e) events.push(e);
  }
  const release = [...events].sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999'));
  // Что из вселенной выходит сейчас — сериалы (TMDB) проверяем по очереди
  let schedule: Franchise['schedule'];
  for (const e of events) {
    if (!e.pick?.startsWith('tmdbt:')) continue;
    const d = await tmdbGet(`/tv/${e.pick.slice(6)}`).catch(() => null);
    if (d?.next_episode_to_air) {
      e.airing = true;
      const sch = await tvSchedule(d.id, d).catch(() => null);
      if (sch?.episodes.length) schedule = sch;
      break;
    }
  }
  return { title: u.title, release, events, eventsNote: 'ручной список вселенной', note: u.note, schedule };
}

// ───────────────────────── кэш ─────────────────────────

const cache = new Map<string, { at: number; f: Franchise }>();
const loading = new Map<string, Promise<Franchise>>();
const TTL = 6 * 3600_000;

async function franchise(key: string): Promise<Franchise> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.f;
  if (!loading.has(key)) {
    const [kind, id] = [key.slice(0, 1), key.slice(2)];
    const job = (async () => {
      if (kind === 'a') return animeFranchise(Number(id));
      if (kind === 's') {
        // Найдено через Shikimori (по-русски) — переводим id MyAnimeList в id AniList
        const d = await anilist(`query ($id: Int) { Media(idMal: $id, type: ANIME) { id } }`, { id: Number(id) });
        if (!d?.Media?.id) throw new Error('этого аниме нет в AniList — хронологию собрать не получится');
        return animeFranchise(d.Media.id);
      }
      if (kind === 'm') return movieFranchise(Number(id));
      if (kind === 't') return tvFranchise(Number(id));
      const u = universes().find((x) => x.key === id);
      if (!u) throw new Error('вселенная не найдена в config/watchorders.json');
      return curatedFranchise(u);
    })()
      .then((f) => {
        cache.set(key, { at: Date.now(), f });
        if (cache.size > 200) cache.delete(cache.keys().next().value as string);
        return f;
      })
      .finally(() => loading.delete(key));
    loading.set(key, job);
  }
  return loading.get(key)!;
}

// ───────────────────────── вид ─────────────────────────

/** Обрезка без склейки строк (truncate из util схлопывает переносы — для списков не годится) */
const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const year = (d: string | null) => (d ? d.slice(0, 4) : 'дата не объявлена');
/** Будущие премьеры — полной датой, прошедшие — годом */
function when(d: string | null): string {
  if (!d) return 'дата не объявлена';
  if (d.length < 10 || d <= new Date().toISOString().slice(0, 10)) return d.slice(0, 4);
  const [y, m, day] = d.split('-').map(Number);
  return `выйдет ${day} ${MONTHS[m - 1]} ${y}`;
}

const KIND_EMOJI = (k: string) => (k === 'фильм' ? '🎬' : k === 'сериал' || k.startsWith('TV') ? '📺' : k === 'клип' ? '🎵' : '💿');
const TAG_LINE: Record<Tag, string> = { main: '', side: '➕ побочная', skip: '⏭ можно пропустить', alt: '🔀 другая версия' };

/** Одна часть = две строки: название и мелкая строка с деталями */
function entryBlock(e: Entry, n: number): string {
  const head = `**${n}.** ${e.tag === 'main' ? `**${plain(clip(e.title, 80))}**` : plain(clip(e.title, 80))}${e.airing ? ' 🔴' : ''}`;
  const details = [
    `${KIND_EMOJI(e.kind)} ${e.kind}${e.episodes && e.kind !== 'фильм' ? `, ${e.episodes} сер.` : ''}`,
    when(e.date),
    e.score ? `⭐ ${e.score.toFixed(1)}` : '',
    TAG_LINE[e.tag],
    e.airing ? 'выходит сейчас' : '',
  ].filter(Boolean);
  return `${head}\n-# ${details.join(' · ')}`;
}

/**
 * Отдельный блок-предупреждение «ещё выходит»: прогресс, следующая серия крупно,
 * вышедшие серии свёрнуты в одну строку, оставшиеся — списком с датами.
 */
function scheduleEmbed(s: { title: string; episodes: Episode[]; total?: number }, maxLeft = 10) {
  const now = Date.now() / 1000;
  const eps = [...s.episodes].sort((a, b) => a.at - b.at);
  const e = new EmbedBuilder().setColor(0xe8a33d);
  if (!eps.length) return e.setTitle(`📅 ${clip(s.title, 230)}`).setDescription('Расписание серий пока не объявлено. Обычно оно появляется ближе к премьере.');

  const aired = eps.filter((x) => x.at <= now);
  const left = eps.filter((x) => x.at > now);
  const total = Math.max(s.total ?? 0, eps[eps.length - 1].ep, eps.length);
  const time = (x: Episode) => (x.dateOnly ? `<t:${x.at}:D>` : `<t:${x.at}:f>`);

  if (!left.length) {
    return e
      .setColor(0x3ba55d)
      .setTitle(`✅ ${clip(s.title, 230)} — все серии вышли`)
      .setDescription(`Вышло ${aired.length} из ${total} серий, последняя — ${time(aired[aired.length - 1])}.`);
  }

  const done = Math.round((aired.length / total) * 10);
  const bar = '▰'.repeat(done) + '▱'.repeat(10 - done);
  const next = left[0];
  const lines = [
    `**⚠️ Сезон ещё выходит** — вышло **${aired.length} из ${total}** серий`,
    `${bar}`,
    '',
    `➡️ **Следующая: серия ${next.ep} — ${time(next)}**`,
    `-# <t:${next.at}:R>`,
    '',
  ];
  if (aired.length) {
    const first = aired[0].ep;
    const last = aired[aired.length - 1].ep;
    lines.push(`✅ ${first === last ? `Серия ${first} уже вышла` : `Серии ${first}–${last} уже вышли`}`);
  }
  for (const x of left.slice(1, maxLeft)) lines.push(`🗓 Серия ${x.ep} — ${time(x)}${x.ep === total ? ' · финал' : ''}`);
  if (left.length > maxLeft) lines.push(`-# …и ещё ${left.length - maxLeft} сер., последняя ${time(left[left.length - 1])}`);
  if (next.ep === total) lines[3] += ' · финал';
  return e
    .setTitle(`🔴 Ещё выходит: ${clip(s.title, 220)}`)
    .setDescription(clip(lines.join('\n'), 4000))
    .setFooter({ text: 'Время — в твоём часовом поясе' });
}

const PER_PAGE = 12;

/** Готовые ряды постеров (ключ: франшиза|режим|страница) */
const stripCache = new Map<string, { at: number; pngs: Buffer[] }>();

/** Постеры фильмов страницы — рядами по 4 (каждый ряд — отдельная картинка, так Discord показывает их крупнее) */
/**
 * Подпись под постером: общее начало серии убираем, если оно повторяется хотя бы у двух фильмов
 * («Бегущий в лабиринте: Испытание огнём» → «Испытание огнём»), иначе оставляем название целиком
 * («Хан Соло: Звёздные войны. Истории» так и остаётся).
 */
function captions(all: Entry[]): (title: string) => string {
  const head = (t: string) => (t.indexOf(': ') > 0 ? t.slice(0, t.indexOf(': ')) : null);
  const freq = new Map<string, number>();
  for (const e of all) {
    const h = head(e.title);
    if (h) freq.set(h, (freq.get(h) ?? 0) + 1);
  }
  return (t) => {
    const h = head(t);
    return h && (freq.get(h) ?? 0) >= 2 && t.length > h.length + 4 ? t.slice(h.length + 2) : t;
  };
}

async function posterStrip(cacheKey: string, films: { x: Entry; n: number }[], all: Entry[]): Promise<Buffer[]> {
  const hit = stripCache.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL) return hit.pngs;
  const caption = captions(all.filter((e) => e.kind === 'фильм'));
  const items: StripItem[] = await Promise.all(
    films.map(async ({ x, n }) => {
      let img = null;
      if (x.poster) {
        try {
          const res = await fetch(x.poster, { signal: AbortSignal.timeout(8000) });
          if (res.ok) img = await loadImage(Buffer.from(await res.arrayBuffer()));
        } catch {
          /* без постера — нарисуем заглушку с названием */
        }
      }
      return { n, title: caption(x.title), year: year(x.date), main: x.tag === 'main', img };
    }),
  );
  if (!items.some((it) => it.img)) return [];
  const pngs: Buffer[] = [];
  for (let k = 0; k < items.length; k += COLS_MAX) {
    const row = items.slice(k, k + COLS_MAX);
    const { w, h } = stripSize(row.length);
    const canvas = createCanvas(w, h);
    drawPosterStrip(canvas.getContext('2d'), row, FONT);
    pngs.push(await canvas.encode('png'));
  }
  stripCache.set(cacheKey, { at: Date.now(), pngs });
  if (stripCache.size > 40) stripCache.delete(stripCache.keys().next().value as string);
  return pngs;
}

function countText(list: Entry[]): string {
  const n = (k: (e: Entry) => boolean) => list.filter(k).length;
  const parts = [
    [n((e) => e.kind === 'фильм'), ['фильм', 'фильма', 'фильмов']],
    [n((e) => e.kind === 'сериал'), ['сезон', 'сезона', 'сезонов']],
    [n((e) => e.kind !== 'фильм' && e.kind !== 'сериал'), ['часть', 'части', 'частей']],
  ] as const;
  const plural = (x: number, f: readonly string[]) => f[x % 10 === 1 && x % 100 !== 11 ? 0 : x % 10 >= 2 && x % 10 <= 4 && (x % 100 < 10 || x % 100 >= 20) ? 1 : 2];
  return parts
    .filter(([x]) => x > 0)
    .map(([x, f]) => `${x} ${plural(x, f)}`)
    .join(' · ');
}

async function view(key: string, f: Franchise, mode: 'rel' | 'ev', page = 0) {
  const list = mode === 'ev' ? f.events : f.release;
  const same = f.events.map((e) => e.title).join('|') === f.release.map((e) => e.title).join('|');
  const pages = Math.max(1, Math.ceil(list.length / PER_PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const slice = list.slice(page * PER_PAGE, (page + 1) * PER_PAGE);

  const years = list.map((e) => e.date?.slice(0, 4)).filter(Boolean).sort() as string[];
  const span = years.length ? (years[0] === years[years.length - 1] ? years[0] : `${years[0]}–${years[years.length - 1]}`) : '';
  const head =
    mode === 'ev'
      ? `🌌 **Порядок по событиям**${same ? '' : ` — ${f.eventsNote}`}`
      : '📅 **Порядок выхода** — по датам премьер';
  const lines = [
    head,
    `-# ${[countText(list), span].filter(Boolean).join(' · ')}${same ? ' · порядок выхода и событий совпадает' : ''}`,
    '',
    slice.map((e, k) => entryBlock(e, page * PER_PAGE + k + 1)).join('\n'),
  ];
  if (f.note) lines.push('', `-# ℹ️ ${f.note}`);
  if (f.truncated) lines.push(`-# Вселенная очень большая — показаны первые ${MAX_NODES} частей.`);

  const e = new EmbedBuilder().setColor(0x7f77dd).setTitle(`🧭 ${clip(f.title, 230)}`).setDescription(clip(lines.join('\n'), 4000));
  // Полоса постеров фильмов этой страницы (сезоны сериалов и TV-аниме не показываем)
  const films = slice.map((x, k) => ({ x, n: page * PER_PAGE + k + 1 })).filter(({ x }) => x.kind === 'фильм');
  const strips = films.length ? await posterStrip(`${key}|${mode}|${page}`, films, list).catch(() => [] as Buffer[]) : [];
  if (strips.length) e.setImage('attachment://posters-0.png');
  else if (f.poster) e.setThumbnail(f.poster);
  e.setFooter({
    text: `${pages > 1 ? `Страница ${page + 1} из ${pages} • ` : ''}Жирным — основная история • видишь только ты • AniList · Shikimori · TMDB`,
  });

  const rows: any[] = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`wo:t:rel:${key}`)
        .setLabel('По выходу')
        .setEmoji('📅')
        .setStyle(mode === 'rel' ? ButtonStyle.Primary : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`wo:t:ev:${key}`)
        .setLabel('По событиям')
        .setEmoji('🌌')
        .setStyle(mode === 'ev' ? ButtonStyle.Primary : ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('wo:search').setLabel('Найти другое').setEmoji('🔎').setStyle(ButtonStyle.Secondary),
    ),
  ];
  if (pages > 1) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`wo:v:${mode}:${page - 1}:${key}`)
          .setEmoji('◀️')
          .setLabel('Назад')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page === 0),
        new ButtonBuilder()
          .setCustomId(`wo:v:${mode}:${page + 1}:${key}`)
          .setEmoji('▶️')
          .setLabel('Дальше')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page >= pages - 1),
      ),
    );
  }
  // Меню частей — для текущей страницы, в том же порядке
  const seen = new Set<string>();
  const opts = slice
    .map((x, k) => ({ x, n: page * PER_PAGE + k + 1 }))
    .filter(({ x }) => x.pick && !seen.has(x.pick) && seen.add(x.pick))
    .slice(0, 25)
    .map(({ x, n }) => ({
      label: clip(`${n}. ${x.title}`, 100),
      description: clip(`${x.kind} · ${year(x.date)}`, 100),
      value: x.pick!,
    }));
  if (opts.length) {
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`watch:pick:wo:${page}`)
          .setPlaceholder('Открыть часть: описание, трейлер, «Буду смотреть»…')
          .addOptions(opts),
      ),
    );
  }
  // Если что-то из серии сейчас выходит — отдельный блок-предупреждение с графиком серий
  // Следующие ряды постеров — отдельными блоками сразу под списком
  const more = strips.slice(1).map((_, k) => new EmbedBuilder().setColor(0x7f77dd).setImage(`attachment://posters-${k + 1}.png`));
  const embeds = [e, ...more, ...(f.schedule ? [scheduleEmbed(f.schedule)] : [])];
  return {
    content: '',
    embeds,
    components: rows,
    // attachments: [] — убрать картинки прошлой страницы
    attachments: [],
    files: strips.map((png, k) => new AttachmentBuilder(png, { name: `posters-${k}.png` })),
  };
}

// ───────────────────────── поиск ─────────────────────────

interface Hit {
  label: string;
  description: string;
  value: string;
  emoji: string;
}

/** Обещание с ограничением по времени: подсказкам Discord нужен ответ за 3 секунды */
const within = <T,>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

/**
 * Поиск по всем источникам сразу: ручные вселенные, Shikimori (русские названия аниме),
 * AniList (английские/ромадзи), TMDB (фильмы и сериалы на любом языке).
 * fast — для подсказок при вводе: короткие таймауты и без запроса русских названий к AniList-результатам.
 */
async function search(q: string, fast = false): Promise<Hit[]> {
  const ql = q.toLowerCase().trim();
  const t = fast ? 2000 : 8000;
  const hits: Hit[] = [];
  for (const u of universes()) {
    const names = [u.title, ...(u.aliases ?? [])].map((x) => x.toLowerCase());
    if (names.some((a) => a.includes(ql) || (ql.length >= 4 && ql.includes(a)))) {
      hits.push({ label: truncate(`Вселенная: ${u.title}`, 100), description: `${u.items.length} частей · ручная хронология`, value: `u:${u.key}`, emoji: '🌌' });
    }
  }
  const [shiki, ani, tm] = await Promise.allSettled([
    within(shikiSearch(q, 8), t),
    within(
      anilist(
        `query ($q: String) { Page(perPage: 6) { media(search: $q, type: ANIME, sort: SEARCH_MATCH) { id idMal format startDate { year } title { romaji english } } } }`,
        { q },
      ),
      t,
    ),
    within(tmdbGet('/search/multi', { query: q }), t),
  ]);
  const malSeen = new Set<number>();
  if (shiki.status === 'fulfilled') {
    for (const a of shiki.value) {
      malSeen.add(a.id);
      hits.push({ label: truncate(a.title, 100), description: truncate(`аниме · ${a.kind} · ${a.year}`, 100), value: `s:${a.id}`, emoji: '🍥' });
    }
  }
  if (ani.status === 'fulfilled') {
    const list: any[] = (ani.value?.Page?.media ?? []).filter((m: any) => !m.idMal || !malSeen.has(m.idMal));
    const ru = fast ? new Map<number, string>() : await shikiRussianNames(list.map((m) => m.idMal).filter(Boolean));
    for (const m of list) {
      hits.push({
        label: truncate((m.idMal && ru.get(m.idMal)) || m.title?.english || m.title?.romaji || '?', 100),
        description: truncate(`аниме · ${FORMAT_RU[m.format] ?? m.format ?? ''} · ${m.startDate?.year ?? '?'}`, 100),
        value: `a:${m.id}`,
        emoji: '🍥',
      });
    }
  }
  if (tm.status === 'fulfilled') {
    for (const r of (tm.value?.results ?? []).filter((x: any) => x.media_type === 'movie' || x.media_type === 'tv').slice(0, 8)) {
      // Японские анимационные сериалы уже есть в поиске аниме
      if (r.media_type === 'tv' && r.original_language === 'ja' && (r.genre_ids ?? []).includes(16)) continue;
      const isMovie = r.media_type === 'movie';
      hits.push({
        label: truncate((isMovie ? r.title : r.name) || (isMovie ? r.original_title : r.original_name) || '?', 100),
        description: truncate(`${isMovie ? 'фильм' : 'сериал'} · ${((isMovie ? r.release_date : r.first_air_date) || '????').slice(0, 4)}`, 100),
        value: `${isMovie ? 'm' : 't'}:${r.id}`,
        emoji: isMovie ? '🎬' : '📺',
      });
    }
  }
  const uniq = new Set<string>();
  return hits.filter((h) => !uniq.has(h.value) && uniq.add(h.value)).slice(0, 25);
}

// ───────────────────────── /watchorder ─────────────────────────

/** Подсказки по мере ввода: «🍥 Атака титанов · аниме · TV · 2013» */
export async function onAutocomplete(i: AutocompleteInteraction) {
  const q = i.options.getFocused().trim();
  if (q.length < 2) {
    const u = universes().slice(0, 25).map((x) => ({ name: truncate(`🌌 Вселенная: ${x.title}`, 100), value: `u:${x.key}` }));
    return i.respond(u).catch(() => {});
  }
  const hits = await search(q, true).catch(() => [] as Hit[]);
  return i
    .respond(hits.map((h) => ({ name: truncate(`${h.emoji} ${h.label} · ${h.description}`, 100), value: h.value })))
    .catch(() => {});
}

const KEY_RE = /^[asmtu]:[\w-]+$/;

/** Показать хронологию по ключу (общая часть для меню выбора и команды) */
async function showByKey(i: any, key: string) {
  try {
    const f = await franchise(key);
    const differs = f.events.map((e) => e.title).join('|') !== f.release.map((e) => e.title).join('|');
    return await i.editReply(await view(key, f, differs ? 'ev' : 'rel'));
  } catch (e) {
    return i.editReply({ content: `⚠️ Не удалось собрать хронологию: ${(e as Error).message}`, embeds: [], components: [] });
  }
}

/** Варианты на выбор, если человек нажал Enter, не выбрав подсказку */
function hitsPayload(q: string, hits: Hit[]) {
  if (!hits.length) return { content: `🔎 По запросу «${plain(truncate(q, 80))}» ничего не нашёл. Попробуй другое название — можно по-английски.`, components: [] };
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder().setCustomId('wo:pick').setPlaceholder('Что именно?').addOptions(hits),
  );
  return { content: `🔎 Нашёл по запросу «${plain(truncate(q, 80))}». Выбери:`, components: [row] };
}

export async function onCommand(i: ChatInputCommandInteraction) {
  const q = i.options.getString('query', true).trim();
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  if (KEY_RE.test(q)) {
    await i.editReply('⏳ Собираю хронологию… (большие вселенные — до 20 секунд)');
    return showByKey(i, q);
  }
  const hits = await search(q).catch(() => [] as Hit[]);
  // Одно точное совпадение — сразу показываем
  if (hits.length === 1) {
    await i.editReply('⏳ Собираю хронологию…');
    return showByKey(i, hits[0].value);
  }
  return i.editReply(hitsPayload(q, hits));
}

// ───────────────────────── панель ─────────────────────────

function panelPayload() {
  const e = new EmbedBuilder()
    .setColor(0x7f77dd)
    .setTitle('🧭 Хронология просмотра')
    .setDescription(
      [
        'Напиши любое аниме, сериал, фильм или вселенную — покажу, в каком порядке смотреть, все приквелы, сиквелы и побочные истории.',
        '',
        '📅 **По выходу** — как выходило в прокат и эфир',
        '🌌 **По событиям** — по порядку событий внутри вселенной',
        '🔴 Если что-то сейчас выходит — покажу расписание серий',
        '',
        '⌨️ Быстрее всего — команда **/хронология**: начни печатать название, и бот сразу предложит варианты. Или нажми кнопку ниже.',
      ].join('\n'),
    )
    .setFooter({ text: 'Ответ видишь только ты • AniList · Shikimori · TMDB' });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('wo:search').setLabel('Найти хронологию').setEmoji('🔎').setStyle(ButtonStyle.Primary),
  );
  return { embeds: [e], components: [row] };
}

/** Отправить (или обновить) панель в канал «Хронология просмотра» */
export async function postWatchorderPanel(guild: Guild, channelId: string) {
  const channel: any = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return;
  const oldId = getSetting('wo.panel');
  if (oldId) {
    const old = await channel.messages.fetch(oldId).catch(() => null);
    if (old) {
      await old.edit(panelPayload()).catch(() => {});
      return;
    }
  }
  const msg = await channel.send(panelPayload());
  setSetting('wo.panel', msg.id);
  await msg.pin().catch(() => {});
}

// ───────────────────────── обработка ─────────────────────────

export async function onComponent(i: ComponentInteraction) {
  const parts = i.customId.split(':');
  const action = parts[1];

  // Кнопка «Найти» → окошко ввода
  if (action === 'search' && i.isButton()) {
    const modal = new ModalBuilder()
      .setCustomId('wo:q')
      .setTitle('Найти хронологию')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('q')
            .setLabel('Аниме, сериал, фильм или вселенная')
            .setPlaceholder('Например: Атака титанов, Звёздные войны, Во все тяжкие')
            .setStyle(TextInputStyle.Short)
            .setMinLength(2)
            .setMaxLength(100)
            .setRequired(true),
        ),
      );
    return i.showModal(modal);
  }

  // Введено название → совпадения
  if (action === 'q' && i.isModalSubmit()) {
    const q = i.fields.getTextInputValue('q').trim();
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const hits = await search(q).catch(() => [] as Hit[]);
    return i.editReply(hitsPayload(q, hits));
  }

  // Выбрали совпадение → хронология
  if (action === 'pick' && i.isStringSelectMenu()) {
    const key = i.values[0];
    await i.update({ content: '⏳ Собираю хронологию… (большие вселенные — до 20 секунд)', components: [], embeds: [] });
    return showByKey(i, key);
  }

  // Переключение вкладок
  // Вкладки (wo:t:<режим>:<ключ>) и листание страниц (wo:v:<режим>:<страница>:<ключ>)
  if ((action === 'v' || action === 't') && i.isButton()) {
    const mode = parts[2] === 'ev' ? 'ev' : 'rel';
    const page = action === 't' ? 0 : Number(parts[3]) || 0;
    const key = parts.slice(action === 't' ? 3 : 4).join(':');
    await i.deferUpdate();
    try {
      return await i.editReply(await view(key, await franchise(key), mode, page));
    } catch (e) {
      return i.followUp({ content: `⚠️ ${(e as Error).message}`, flags: MessageFlags.Ephemeral });
    }
  }

  // «📅 Расписание серий» из анонсов и мини-карточек
  if (action === 'sched' && i.isButton()) {
    const [source, id] = [parts[2], parts[3]];
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const s = source === 'shiki' ? await animeScheduleByMal(Number(id)) : source === 'tmdbt' ? await tvSchedule(Number(id)) : null;
      if (!s) return i.editReply('📅 Расписание серий пока не объявлено. Обычно оно появляется ближе к премьере.');
      return i.editReply({ embeds: [scheduleEmbed(s, 20)] });
    } catch (e) {
      return i.editReply(`⚠️ Не удалось загрузить расписание: ${(e as Error).message}`);
    }
  }
}

export function setup(client: Client) {
  // Панель могли удалить вручную — при запуске вернём её на место
  client.once(Events.ClientReady, async () => {
    const channelId = getSetting('channel.watchorder');
    if (!channelId) return;
    const guild = client.guilds.cache.first();
    if (guild) await postWatchorderPanel(guild, channelId).catch((e) => console.warn('[watchorder] Панель:', (e as Error).message));
  });
}
