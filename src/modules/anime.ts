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
import { cardButtons, pickMenus } from '../trailerUi';
import { registerCalendar, registerInfo, watchBadge, type PremiereInfo } from '../premiere';
import { calendarUrl, upsertPinned } from '../calendarMsg';
import { readConfigJson, truncate } from '../util';

/**
 * Аниме-анонсы с Shikimori:
 *  • новый анонс → отдельная карточка в канале анонсов;
 *  • в том же канале закреплённое сообщение «Календарь анонсов» — ближайшие премьеры по месяцам,
 *    названия кликабельные, бот сам его обновляет.
 */

interface AnimeConfig {
  /** Адреса Shikimori по порядку: если первый недоступен, пробуем следующий */
  bases: string[];
  /** Какие типы считать: tv, movie, ona, ova, special, tv_special, music, pv, cm */
  kinds: string[];
  /** Сколько дней вперёд показывать в календаре */
  calendarDays: number;
  /** Максимум строк в календаре */
  calendarMax: number;
  /** Как часто проверять (минуты) */
  intervalMinutes: number;
  /** Сколько страниц по 50 анонсов загружать (больше — полнее календарь) */
  maxPages: number;
}

interface ShikiAnime {
  id: number;
  name: string;
  russian?: string;
  url: string;
  kind?: string;
  status?: string;
  aired_on?: string | null;
  image?: { original?: string; preview?: string };
}

const DEFAULTS: AnimeConfig = {
  bases: ['https://shikimori.io', 'https://shikimori.one'],
  kinds: ['tv', 'movie', 'ona'],
  calendarDays: 120,
  calendarMax: 45,
  intervalMinutes: 60,
  maxPages: 10,
};

const FEED_KEY = 'shiki:anons';
const KIND_RU: Record<string, string> = {
  tv: 'TV-сериал',
  movie: 'Фильм',
  ona: 'ONA',
  ova: 'OVA',
  special: 'Спешл',
  tv_special: 'TV-спешл',
  music: 'Клип',
};
const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

const loadCfg = (): AnimeConfig => ({ ...DEFAULTS, ...readConfigJson<Partial<AnimeConfig>>('anime.json', {}) });

export const commands = [
  new SlashCommandBuilder().setName('anime_calendar').setDescription('Календарь ближайших аниме-премьер'),
  new SlashCommandBuilder()
    .setName('anime_check')
    .setDescription('Проверить анонсы прямо сейчас (для админов)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
];

let running = false;

/** Последний список анонсов — чтобы перерисовать календарь после отметки «Буду смотреть» без запросов к API */
let lastList: (ShikiAnime & { base: string })[] | null = null;

export function setup(client: Client) {
  registerInfo('shiki', (id) => animeInfo(Number(id)));
  registerCalendar('shiki', async () => {
    const channelId = getSetting('channel.anime_announce');
    if (!channelId || !lastList) return;
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (channel?.isTextBased()) await updateCalendar(channel as any, lastList, loadCfg());
  });
  client.once(Events.ClientReady, () => void run(client));
  const minutes = Math.max(15, loadCfg().intervalMinutes);
  setInterval(() => void run(client), minutes * 60_000);
}

export async function onCommand(i: ChatInputCommandInteraction) {
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  if (i.commandName === 'anime_calendar') {
    const list = await fetchAnons(loadCfg()).catch((e) => {
      console.warn('[anime] Календарь:', e.message);
      return null;
    });
    if (!list) return i.editReply('⚠️ Shikimori сейчас недоступен, попробуй позже.');
    return i.editReply({ embeds: calendarEmbeds(list, loadCfg()), components: calendarComponents(list, loadCfg()) });
  }
  const res = await run(i.client);
  return i.editReply(res);
}

// ───────────────────────── загрузка с Shikimori ─────────────────────────

async function shikiGet(cfg: AnimeConfig, path: string): Promise<{ base: string; data: any }> {
  let lastErr: Error | null = null;
  for (const base of cfg.bases) {
    try {
      const res = await fetch(`${base}${path}`, {
        headers: { 'User-Agent': 'TortugaDuckBot/1.0 (Discord bot)', Accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { base, data: await res.json() };
    } catch (e) {
      lastErr = new Error(`${base}: ${(e as Error).message}`);
    }
  }
  throw lastErr ?? new Error('нет адресов Shikimori');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Все анонсированные тайтлы нужных типов (несколько страниц, бережно к лимитам API). */
async function fetchAnons(cfg: AnimeConfig): Promise<(ShikiAnime & { base: string })[]> {
  const out: (ShikiAnime & { base: string })[] = [];
  for (let page = 1; page <= cfg.maxPages; page++) {
    const q = new URLSearchParams({
      status: 'anons',
      kind: cfg.kinds.join(','),
      order: 'id_desc',
      censored: 'true',
      limit: '50',
      page: String(page),
    });
    const { base, data } = await shikiGet(cfg, `/api/animes?${q}`);
    if (!Array.isArray(data) || data.length === 0) break;
    out.push(...data.map((a: ShikiAnime) => ({ ...a, base })));
    if (data.length < 50) break;
    await sleep(400);
  }
  return out;
}

// ───────────────────────── основной цикл ─────────────────────────

const seen = {
  count: () => (db.prepare('SELECT COUNT(*) AS n FROM news_seen WHERE feed = ?').get(FEED_KEY) as { n: number }).n,
  has: (id: number) => !!db.prepare('SELECT 1 FROM news_seen WHERE feed = ? AND guid = ?').get(FEED_KEY, String(id)),
  add: (id: number) => db.prepare('INSERT OR IGNORE INTO news_seen (feed, guid, ts) VALUES (?, ?, ?)').run(FEED_KEY, String(id), Date.now()),
};

/** Сбросить «уже видел» — нужно при смене канала анонсов. */
export function resetAnimeAnnounce() {
  db.prepare('DELETE FROM news_seen WHERE feed = ?').run(FEED_KEY);
  setSetting('anime.calendar_msg', null);
}

async function run(client: Client): Promise<string> {
  if (running) return '⏳ Проверка уже идёт.';
  const channelId = getSetting('channel.anime_announce');
  if (!channelId) return '⚪ Канал аниме-анонсов не назначен: `/setup channel` → «Аниме: анонсы и календарь».';
  running = true;
  try {
    const cfg = loadCfg();
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased() || !('send' in channel)) return `❌ Бот не видит канал <#${channelId}>.`;

    let list: (ShikiAnime & { base: string })[];
    try {
      list = await fetchAnons(cfg);
    } catch (e) {
      console.warn('[anime] Shikimori недоступен:', (e as Error).message);
      return `❌ Shikimori недоступен: ${truncate((e as Error).message, 150)}`;
    }

    // Новые анонсы. При первом запуске просто запоминаем всё, чтобы не завалить канал.
    let posted = 0;
    if (seen.count() === 0) {
      list.forEach((a) => seen.add(a.id));
    } else {
      const fresh = list.filter((a) => !seen.has(a.id)).sort((a, b) => a.id - b.id).slice(0, 5);
      for (const a of fresh) {
        try {
          const video = await animeVideo(a.id).catch(() => undefined);
          await channel.send({ embeds: [announceEmbed(a)], components: cardButtons('shiki', a.id, !!video, calendarUrl(channel, 'anime.calendar_msg')) });
          posted++;
        } catch (e) {
          console.warn('[anime] Не отправился анонс:', (e as Error).message);
        }
        seen.add(a.id);
      }
      list.filter((a) => !seen.has(a.id)).forEach((a) => seen.add(a.id));
    }

    lastList = list;
    const calStatus = await updateCalendar(channel as any, list, cfg);
    if (posted) console.log(`[anime] Новых анонсов: ${posted}`);
    return `✅ Shikimori: ${list.length} анонсов. Новых опубликовано: ${posted}. ${calStatus}`;
  } finally {
    running = false;
  }
}

// ───────────────────────── оформление ─────────────────────────

const titleOf = (a: ShikiAnime) => a.russian?.trim() || a.name;
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
/** «05.11», а если стоит 1-е число (Shikimori так помечает «известен только месяц») — «~ноя» */
const shortDate = (d: Date) =>
  d.getUTCDate() === 1
    ? `~${MONTHS_SHORT[d.getUTCMonth()]}`
    : `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
// Короткая ссылка: Shikimori открывает тайтл и по одному номеру — экономим место (лимит Discord 6000 символов)
const linkOf = (a: ShikiAnime & { base: string }) => `${a.base}/animes/${a.id}`;
const imageOf = (a: ShikiAnime & { base: string }) => {
  const p = a.image?.original ?? a.image?.preview;
  if (!p || p.includes('missing')) return undefined;
  return p.startsWith('http') ? p : `${a.base}${p}`;
};
const dateRu = (iso?: string | null) => {
  if (!iso) return null;
  const d = new Date(iso + 'T00:00:00Z');
  return Number.isNaN(d.getTime()) ? null : d;
};

function announceEmbed(a: ShikiAnime & { base: string }) {
  const date = dateRu(a.aired_on);
  const e = new EmbedBuilder()
    .setColor(0xeb459e)
    .setAuthor({ name: '📢 Новый аниме-анонс' })
    .setTitle(truncate(titleOf(a), 250))
    .setURL(linkOf(a))
    .addFields(
      { name: 'Тип', value: KIND_RU[a.kind ?? ''] ?? a.kind ?? '—', inline: true },
      {
        name: 'Премьера',
        value: date ? `<t:${Math.floor(date.getTime() / 1000)}:D>` : 'дата пока не объявлена',
        inline: true,
      },
    )
    .setFooter({ text: 'Shikimori' });
  if (a.russian && a.name !== a.russian) e.setDescription(`*${truncate(a.name, 200)}*`);
  const img = imageOf(a);
  if (img) e.setThumbnail(img);
  return e;
}

/** Ближайшие премьеры по месяцам, названия — ссылки. Режем на несколько embed'ов (лимиты Discord). */
/** Ближайшие премьеры с известной датой — для календаря и меню трейлеров */
function upcomingOf(list: (ShikiAnime & { base: string })[], cfg: AnimeConfig) {
  const now = Date.now();
  const until = now + cfg.calendarDays * 24 * 60 * 60_000;
  return list
    .map((a) => ({ a, d: dateRu(a.aired_on) }))
    .filter((x): x is { a: ShikiAnime & { base: string }; d: Date } => !!x.d && x.d.getTime() >= now - 24 * 60 * 60_000 && x.d.getTime() <= until)
    .sort((x, y) => x.d.getTime() - y.d.getTime())
    .slice(0, cfg.calendarMax);
}

/** Меню «▶️ Трейлер к аниме…» под календарём (наличие трейлера проверяется при выборе) */
function calendarComponents(list: (ShikiAnime & { base: string })[], cfg: AnimeConfig) {
  const items = upcomingOf(list, cfg).map(({ a, d }) => ({
    source: 'shiki' as const,
    id: a.id,
    title: titleOf(a),
    hint: `${shortDate(d)} · ${KIND_RU[a.kind ?? ''] ?? a.kind ?? ''}`,
  }));
  const recent = recentOutside(list, upcomingOf(list, cfg).map((x) => x.a.id)).map(({ a, d }) => ({
    source: 'shiki' as const,
    id: a.id,
    title: titleOf(a),
    hint: `🆕 ${d ? `${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}` : 'дата не объявлена'} · ${KIND_RU[a.kind ?? ''] ?? a.kind ?? ''}`,
  }));
  return [
    ...pickMenus(items, '🎯 Выбрать аниме: трейлер, «буду смотреть», напомнить…', 'anime', 2),
    ...pickMenus(recent, '🆕 Недавно анонсированные…', 'anime_new', 1),
  ];
}

/** Видео тайтла на Shikimori: PV/трейлер с YouTube */
async function animeVideo(id: number): Promise<string | undefined> {
  const { data } = await shikiGet(loadCfg(), `/api/animes/${Math.floor(id)}/videos`);
  const list = (Array.isArray(data) ? data : []).filter((v: any) => /youtu/i.test(String(v.url ?? v.player_url ?? '')));
  const pick =
    list.find((v: any) => v.kind === 'pv' || /trailer|трейлер|pv|тизер|teaser/i.test(v.name ?? '')) ??
    list.find((v: any) => v.kind === 'cm') ??
    list[0];
  if (!pick) return undefined;
  const raw = String(pick.url ?? pick.player_url);
  const vid = raw.match(/(?:v=|youtu\.be\/|embed\/)([\w-]{11})/)?.[1];
  return vid ? `https://www.youtube.com/watch?v=${vid}` : raw.replace(/^http:/, 'https:');
}

/** Для кнопки/меню «Трейлер» */
export async function animeTrailer(id: number): Promise<{ title: string; url?: string }> {
  const { data } = await shikiGet(loadCfg(), `/api/animes/${Math.floor(id)}`).catch(() => ({ data: null as any }));
  const title = data ? titleOf(data) : '';
  const url = await animeVideo(id).catch(() => undefined);
  return { title, url };
}

const RECENT_DAYS = 30;
const RECENT_MAX = 15;

/** Анонсы последних 30 дней, которых нет в основном календаре. Тайтлы, запомненные при первом запуске, не считаются новыми. */
function recentOutside(list: (ShikiAnime & { base: string })[], inCalendar: number[]) {
  const rows = db.prepare('SELECT guid, ts FROM news_seen WHERE feed = ?').all(FEED_KEY) as { guid: string; ts: number }[];
  if (!rows.length) return [];
  const firstSeen = new Map(rows.map((r) => [r.guid, r.ts]));
  const seedTs = Math.min(...rows.map((r) => r.ts));
  const skip = new Set(inCalendar);
  const since = Date.now() - RECENT_DAYS * 24 * 3600_000;
  return list
    .filter((a) => !skip.has(a.id))
    .map((a) => ({ a, ts: firstSeen.get(String(a.id)) ?? 0, d: dateRu(a.aired_on) }))
    .filter((x) => x.ts > seedTs + 10 * 60_000 && x.ts >= since)
    .sort((x, y) => y.ts - x.ts)
    .slice(0, RECENT_MAX);
}

function calendarEmbeds(list: (ShikiAnime & { base: string })[], cfg: AnimeConfig) {
  const upcoming = upcomingOf(list, cfg);

  const header = new EmbedBuilder()
    .setColor(0xeb459e)
    .setTitle('🗓 Календарь аниме-анонсов')
    .setDescription(
      upcoming.length
        ? `Ближайшие премьеры на ${cfg.calendarDays} дней. Нажми на название — откроется страница на Shikimori. 👀 — сколько человек с сервера ждут. Отметиться и включить напоминание — в меню под календарём.`
        : 'В ближайшие месяцы премьер с известной датой нет.',
    )
    .setTimestamp(new Date())
    .setFooter({ text: 'Обновляется автоматически' });

  const embeds = [header];
  let current: EmbedBuilder | null = null;
  let text = '';
  let month = '';
  const flush = () => {
    if (current && text) current.setDescription(text.trimEnd());
  };
  let total = 0;
  let skipped = 0;
  for (const { a, d } of upcoming) {
    const m = `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    const dd = shortDate(d);
    const line = `\`${dd}\` [${truncate(titleOf(a), 60).replace(/[[\]]/g, '')}](${linkOf(a)}) · ${KIND_RU[a.kind ?? ''] ?? a.kind}${watchBadge('shiki', a.id)}\n`;
    // Discord: до 10 embed'ов и ~6000 символов на сообщение, описание до 4096
    if (total + line.length > 4300) {
      skipped++;
      continue;
    }
    if (m !== month || text.length + line.length > 3500) {
      flush();
      if (embeds.length >= 10) {
        skipped++;
        continue;
      }
      current = new EmbedBuilder().setColor(0xeb459e).setTitle(m !== month ? m : `${m} (продолжение)`);
      embeds.push(current);
      text = '';
      month = m;
    }
    text += line;
    total += line.length;
  }
  flush();

  // 🆕 Недавно анонсированы: без даты или с премьерой позже окна календаря (30 дней с анонса, до 15 строк)
  const recent = recentOutside(list, upcoming.map((x) => x.a.id));
  if (recent.length) {
    const lines = recent.map(({ a, d }) => {
      const when = d ? `${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}` : 'дата не объявлена';
      return `• [${truncate(titleOf(a), 60).replace(/[[\]]/g, '')}](${linkOf(a)}) · ${KIND_RU[a.kind ?? ''] ?? a.kind} — ${when}${watchBadge('shiki', a.id)}`;
    });
    embeds.push(
      new EmbedBuilder()
        .setColor(0xeb459e)
        .setTitle('🆕 Недавно анонсированы')
        .setDescription(`Премьера пока без даты или позже, чем через ${cfg.calendarDays} дней. Держатся здесь ${RECENT_DAYS} дней с анонса.\n\n${lines.join('\n')}`),
    );
  }
  if (skipped) header.setFooter({ text: `Не поместились ещё ${skipped} (лимит Discord) • Обновляется автоматически` });
  return embeds;
}

/** Редактирует закреплённый календарь в канале (или создаёт и закрепляет новый). */
async function updateCalendar(channel: any, list: (ShikiAnime & { base: string })[], cfg: AnimeConfig): Promise<string> {
  const embeds = calendarEmbeds(list, cfg);
  const components = calendarComponents(list, cfg);
  return upsertPinned(channel, 'anime.calendar_msg', { embeds, components }, 'anime');
}

/** Для /setup: сразу запустить проверку после назначения канала. */
export function runAnimeNow(client: Client) {
  return run(client);
}



// ───────────────────────── «Буду смотреть» и напоминания ─────────────────────────

const cleanBb = (t?: string | null) =>
  (t ?? '')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[(\w+)(=[^\]]*)?\]([^[]*)\[\/\1\]/g, '$3')
    .replace(/\[[^\]]+\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const WEEKDAYS_ACC = ['по воскресеньям', 'по понедельникам', 'по вторникам', 'по средам', 'по четвергам', 'по пятницам', 'по субботам'];

/** Данные о премьере для мини-карточки и напоминания */
export async function animeInfo(id: number): Promise<PremiereInfo | null> {
  const cfg = loadCfg();
  const { base, data: a } = await shikiGet(cfg, `/api/animes/${Math.floor(id)}`);
  if (!a?.id) return null;
  const shots = await shikiGet(cfg, `/api/animes/${Math.floor(id)}/screenshots`).catch(() => ({ data: [] as any[] }));
  const abs = (p?: string) => (p && !p.includes('missing') ? (p.startsWith('http') ? p : `${base}${p}`) : undefined);
  const poster = abs(a.image?.original);
  const shot = abs(Array.isArray(shots.data) ? shots.data[0]?.original : undefined);
  const d = dateRu(a.aired_on);
  const airAt = a.next_episode_at ? Math.floor(new Date(a.next_episode_at).getTime() / 1000) : undefined;
  const kind = KIND_RU[a.kind ?? ''] ?? a.kind ?? 'Аниме';
  const fields: PremiereInfo['fields'] = [];
  const format = [kind, a.episodes ? `${a.episodes} сер.` : ''].filter(Boolean).join(' · ');
  fields.push({
    name: 'Формат',
    value: `${format}${airAt && a.kind === 'tv' ? `\n${WEEKDAYS_ACC[new Date(airAt * 1000).getUTCDay()]}` : ''}`,
    inline: true,
  });
  const genres = (a.genres ?? []).map((g: any) => g.russian || g.name).filter(Boolean).slice(0, 3).join(', ');
  if (genres) fields.push({ name: 'Жанры', value: genres, inline: true });
  const studio = (a.studios ?? []).map((x: any) => x.name).filter(Boolean).slice(0, 2).join(', ');
  if (studio) fields.push({ name: 'Студия', value: studio, inline: true });
  return {
    source: 'shiki',
    id: String(a.id),
    title: titleOf(a),
    original: a.russian && a.name !== a.russian ? a.name : undefined,
    date: d ? a.aired_on : null,
    approx: !!d && d.getUTCDate() === 1,
    released: a.status === 'ongoing' || a.status === 'released',
    airAt,
    description: cleanBb(a.description) ? truncate(cleanBb(a.description), 350) : undefined,
    image: shot ?? poster,
    thumb: poster,
    color: 0xeb459e,
    kindLabel: `Аниме · ${kind}`,
    fields,
    link: { label: 'Shikimori', url: `${base}/animes/${a.id}` },
  };
}
