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

export function setup(client: Client) {
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
    return i.editReply({ embeds: calendarEmbeds(list, loadCfg()) });
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
          await channel.send({ embeds: [announceEmbed(a)] });
          posted++;
        } catch (e) {
          console.warn('[anime] Не отправился анонс:', (e as Error).message);
        }
        seen.add(a.id);
      }
      list.filter((a) => !seen.has(a.id)).forEach((a) => seen.add(a.id));
    }

    await updateCalendar(channel as any, list, cfg);
    if (posted) console.log(`[anime] Новых анонсов: ${posted}`);
    return `✅ Shikimori: ${list.length} анонсов. Новых опубликовано: ${posted}. Календарь обновлён.`;
  } finally {
    running = false;
  }
}

// ───────────────────────── оформление ─────────────────────────

const titleOf = (a: ShikiAnime) => a.russian?.trim() || a.name;
const linkOf = (a: ShikiAnime & { base: string }) => `${a.base}${a.url}`;
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
function calendarEmbeds(list: (ShikiAnime & { base: string })[], cfg: AnimeConfig) {
  const now = Date.now();
  const until = now + cfg.calendarDays * 24 * 60 * 60_000;
  const upcoming = list
    .map((a) => ({ a, d: dateRu(a.aired_on) }))
    .filter((x): x is { a: ShikiAnime & { base: string }; d: Date } => !!x.d && x.d.getTime() >= now - 24 * 60 * 60_000 && x.d.getTime() <= until)
    .sort((x, y) => x.d.getTime() - y.d.getTime())
    .slice(0, cfg.calendarMax);

  const header = new EmbedBuilder()
    .setColor(0xeb459e)
    .setTitle('🗓 Календарь аниме-анонсов')
    .setDescription(
      upcoming.length
        ? `Ближайшие премьеры на ${cfg.calendarDays} дней. Нажми на название — откроется страница на Shikimori.`
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
  for (const { a, d } of upcoming) {
    const m = `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    const dd = `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const line = `\`${dd}\` [${truncate(titleOf(a), 60).replace(/[[\]]/g, '')}](${linkOf(a)}) · ${KIND_RU[a.kind ?? ''] ?? a.kind}\n`;
    // Discord: до 10 embed'ов и ~6000 символов на сообщение, описание до 4096
    if (total + line.length > 5200) break;
    if (m !== month || text.length + line.length > 3900) {
      flush();
      if (embeds.length >= 10) break;
      current = new EmbedBuilder().setColor(0xeb459e).setTitle(m !== month ? m : `${m} (продолжение)`);
      embeds.push(current);
      text = '';
      month = m;
    }
    text += line;
    total += line.length;
  }
  flush();
  return embeds;
}

/** Редактирует закреплённый календарь в канале (или создаёт и закрепляет новый). */
async function updateCalendar(channel: any, list: (ShikiAnime & { base: string })[], cfg: AnimeConfig) {
  const embeds = calendarEmbeds(list, cfg);
  const msgId = getSetting('anime.calendar_msg');
  if (msgId) {
    const msg = await channel.messages.fetch(msgId).catch(() => null);
    if (msg) {
      await msg.edit({ embeds }).catch((e: Error) => console.warn('[anime] Не обновился календарь:', e.message));
      return;
    }
  }
  const msg = await channel.send({ embeds }).catch((e: Error) => {
    console.warn('[anime] Не отправился календарь:', e.message);
    return null;
  });
  if (!msg) return;
  setSetting('anime.calendar_msg', msg.id);
  await msg.pin().catch(() => console.warn('[anime] Не удалось закрепить календарь (нужно право «Управлять сообщениями»)'));
}

/** Для /setup: сразу запустить проверку после назначения канала. */
export function runAnimeNow(client: Client) {
  return run(client);
}

