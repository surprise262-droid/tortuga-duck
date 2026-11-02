import { db } from './db';
import type { TrailerSource } from './trailerUi';

/**
 * Общая часть «Буду смотреть / Напомнить»: данные о премьере, отметки людей, счётчики для календарей.
 * Источники: shiki (аниме), igdb (игры), tmdbm (фильмы), tmdbt (сериалы).
 */

export type Source = TrailerSource;

export interface PremiereInfo {
  source: Source;
  id: string;
  title: string;
  original?: string;
  /** Дата премьеры YYYY-MM-DD (UTC) или null, если не объявлена */
  date: string | null;
  /** Дата приблизительная (известен только месяц или год) — по ней не напоминаем */
  approx?: boolean;
  /** Уже вышло (аниме — статус «онгоинг/вышло», игры и кино — дата прошла) */
  released?: boolean;
  /** Сезон сериала, к премьере которого относится отметка */
  season?: number;
  /** Точное время выхода (unix, секунды), если источник его знает */
  airAt?: number;
  description?: string;
  /** Большая картинка (кадр/арт), иначе постер */
  image?: string;
  thumb?: string;
  color: number;
  /** «Аниме · TV», «Игра», «Фильм», «Сериал · 2 сезон» */
  kindLabel: string;
  fields: { name: string; value: string; inline?: boolean }[];
  link: { label: string; url: string };
}

export const VERB: Record<Source, { watch: string; done: string }> = {
  shiki: { watch: 'Буду смотреть', done: 'Смотрю' },
  tmdbm: { watch: 'Буду смотреть', done: 'Смотрю' },
  tmdbt: { watch: 'Буду смотреть', done: 'Смотрю' },
  igdb: { watch: 'Буду играть', done: 'Играю' },
};

/** Канал анонсов для источника (туда ведёт «Обсудить на сервере» и туда идут запасные напоминания) */
export const ANNOUNCE_CHANNEL: Record<Source, string> = {
  shiki: 'channel.anime_announce',
  igdb: 'channel.games_announce',
  tmdbm: 'channel.movies_announce',
  tmdbt: 'channel.movies_announce',
};

db.exec(`
  CREATE TABLE IF NOT EXISTS watch_marks (
    source  TEXT NOT NULL,
    id      TEXT NOT NULL,
    user_id TEXT NOT NULL,
    watch   INTEGER NOT NULL DEFAULT 0,
    remind  INTEGER NOT NULL DEFAULT 0,
    ts      INTEGER NOT NULL,
    PRIMARY KEY (source, id, user_id)
  );
  CREATE TABLE IF NOT EXISTS watch_items (
    source   TEXT NOT NULL,
    id       TEXT NOT NULL,
    title    TEXT NOT NULL,
    date     TEXT,
    approx   INTEGER NOT NULL DEFAULT 0,
    season   INTEGER,
    reminded TEXT,
    updated  INTEGER NOT NULL,
    PRIMARY KEY (source, id)
  );
`);

export interface Mark {
  user_id: string;
  watch: number;
  remind: number;
}

export function marksOf(source: Source, id: string | number): Mark[] {
  return db.prepare('SELECT user_id, watch, remind FROM watch_marks WHERE source = ? AND id = ? ORDER BY ts').all(source, String(id)) as any[];
}

export function markOf(source: Source, id: string | number, userId: string): Mark | null {
  return (db.prepare('SELECT user_id, watch, remind FROM watch_marks WHERE source = ? AND id = ? AND user_id = ?').get(source, String(id), userId) as any) ?? null;
}

export function watchers(source: Source, id: string | number): string[] {
  return marksOf(source, id)
    .filter((m) => m.watch)
    .map((m) => m.user_id);
}

/** Переключает отметку. Возвращает новое состояние отметки пользователя. */
export function toggleMark(source: Source, id: string | number, userId: string, what: 'watch' | 'remind', info?: PremiereInfo): Mark {
  const cur = markOf(source, id, userId) ?? { user_id: userId, watch: 0, remind: 0 };
  const next = { ...cur, [what]: cur[what] ? 0 : 1 };
  if (!next.watch && !next.remind) {
    db.prepare('DELETE FROM watch_marks WHERE source = ? AND id = ? AND user_id = ?').run(source, String(id), userId);
  } else {
    db.prepare(
      `INSERT INTO watch_marks (source, id, user_id, watch, remind, ts) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(source, id, user_id) DO UPDATE SET watch = excluded.watch, remind = excluded.remind`,
    ).run(source, String(id), userId, next.watch, next.remind, Date.now());
    if (info) rememberItem(info, false);
  }
  return next;
}

export function clearMark(source: Source, id: string | number, userId: string) {
  db.prepare('DELETE FROM watch_marks WHERE source = ? AND id = ? AND user_id = ?').run(source, String(id), userId);
}

export interface StoredItem {
  source: Source;
  id: string;
  title: string;
  date: string | null;
  approx: number;
  season: number | null;
  reminded: string | null;
}

export function storedItem(source: Source, id: string | number): StoredItem | null {
  return (db.prepare('SELECT * FROM watch_items WHERE source = ? AND id = ?').get(source, String(id)) as any) ?? null;
}

/** Запоминаем премьеру, на которую есть отметки. overwrite=false — не трогаем уже сохранённую дату (её сверяет ежедневная проверка). */
export function rememberItem(info: PremiereInfo, overwrite: boolean) {
  const old = storedItem(info.source, info.id);
  if (old && !overwrite) {
    if (old.season == null && info.season != null) db.prepare('UPDATE watch_items SET season = ? WHERE source = ? AND id = ?').run(info.season, info.source, info.id);
    return;
  }
  db.prepare(
    `INSERT INTO watch_items (source, id, title, date, approx, season, reminded, updated) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
     ON CONFLICT(source, id) DO UPDATE SET title = excluded.title, date = excluded.date, approx = excluded.approx,
       season = COALESCE(watch_items.season, excluded.season), updated = excluded.updated`,
  ).run(info.source, info.id, info.title, info.date, info.approx ? 1 : 0, info.season ?? null, Date.now());
}

/** « · 👀 3» для строки календаря */
export function watchBadge(source: Source, id: string | number): string {
  const n = (db.prepare('SELECT COUNT(*) AS n FROM watch_marks WHERE source = ? AND id = ? AND watch = 1').get(source, String(id)) as { n: number }).n;
  return n ? ` · 👀 ${n}` : '';
}

// ───────────────────────── связь с модулями ─────────────────────────

type InfoFn = (id: string, season?: number | null) => Promise<PremiereInfo | null>;
const infoFns = new Map<Source, InfoFn>();
const renderers = new Map<Source, () => Promise<unknown>>();

/** Модуль (аниме/игры/кино) сообщает, как получить данные о премьере */
export function registerInfo(source: Source, fn: InfoFn) {
  infoFns.set(source, fn);
}

/** Модуль сообщает, как перерисовать свой календарь (без запросов к API — по последним данным) */
export function registerCalendar(source: Source, fn: () => Promise<unknown>) {
  renderers.set(source, fn);
}

const infoCache = new Map<string, { at: number; info: PremiereInfo | null }>();

export async function premiereInfo(source: Source, id: string, fresh = false): Promise<PremiereInfo | null> {
  const key = `${source}:${id}`;
  const hit = infoCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < 15 * 60_000) return hit.info;
  const fn = infoFns.get(source);
  if (!fn) return null;
  const info = await fn(id, storedItem(source, id)?.season ?? null);
  infoCache.set(key, { at: Date.now(), info });
  if (infoCache.size > 500) infoCache.delete(infoCache.keys().next().value as string);
  return info;
}

const pending = new Map<Source, ReturnType<typeof setTimeout>>();

/** После отметки календарь обновится через минуту (несколько нажатий подряд — одно обновление) */
export function refreshCalendarSoon(source: Source) {
  const fn = renderers.get(source);
  if (!fn || pending.has(source)) return;
  pending.set(
    source,
    setTimeout(() => {
      pending.delete(source);
      void fn().catch((e) => console.warn(`[watch] Календарь ${source}:`, (e as Error).message));
    }, 60_000),
  );
}
