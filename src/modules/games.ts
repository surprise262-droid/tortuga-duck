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
 * Календарь релизов игр (все платформы) из IGDB — базы игр Twitch.
 *  • закреплённое сообщение «Календарь релизов» — ближайшие релизы по датам, бот сам обновляет;
 *  • карточка, когда в календаре появляется новая заметная игра.
 * «Заметность» — hypes в IGDB: сколько людей добавили игру в ожидаемые.
 * Нужны TWITCH_CLIENT_ID и TWITCH_CLIENT_SECRET в .env (бесплатно, dev.twitch.tv).
 */

interface GamesConfig {
  /** Минимум «ждущих» (hypes), чтобы игра попала в календарь */
  minHype: number;
  /** Минимум «ждущих» для отдельной карточки-анонса (обычно выше, чтобы не спамить) */
  announceMinHype: number;
  /** На сколько дней вперёд календарь */
  calendarDays: number;
  /** Максимум игр в календаре (если больше — берём самые ожидаемые) */
  calendarMax: number;
  /** Как часто проверять (минуты) */
  intervalMinutes: number;
}

interface IgdbGame {
  id: number;
  name: string;
  url?: string;
  first_release_date?: number;
  hypes?: number;
  cover?: { image_id?: string };
  genres?: { name: string }[];
  platforms?: { abbreviation?: string; name?: string }[];
  external_games?: { url?: string }[];
  summary?: string;
}

const DEFAULTS: GamesConfig = {
  minHype: 10,
  announceMinHype: 25,
  calendarDays: 60,
  calendarMax: 50,
  intervalMinutes: 120,
};

const FEED_KEY = 'igdb:upcoming';
const COLOR = 0x5865f2;
const DAY = 24 * 60 * 60_000;
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

const loadCfg = (): GamesConfig => ({ ...DEFAULTS, ...readConfigJson<Partial<GamesConfig>>('games.json', {}) });

export const commands = [
  new SlashCommandBuilder().setName('games_calendar').setDescription('Календарь ближайших релизов игр'),
  new SlashCommandBuilder()
    .setName('games_check')
    .setDescription('Проверить релизы игр прямо сейчас (для админов)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
];

let running = false;

export function setup(client: Client) {
  client.once(Events.ClientReady, () => void run(client));
  setInterval(() => void run(client), Math.max(30, loadCfg().intervalMinutes) * 60_000);
}

export async function onCommand(i: ChatInputCommandInteraction) {
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  if (i.commandName === 'games_calendar') {
    const cfg = loadCfg();
    const list = await fetchUpcoming(cfg).catch((e) => {
      console.warn('[games] Календарь:', e.message);
      return null;
    });
    if (!list) return i.editReply(credentialsMissing() ?? '⚠️ IGDB сейчас недоступен, попробуй позже.');
    return i.editReply({ embeds: calendarEmbeds(list, cfg) });
  }
  return i.editReply(await run(i.client));
}

// ───────────────────────── IGDB ─────────────────────────

function credentialsMissing(): string | null {
  if (process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET) return null;
  return '⚪ Не заданы TWITCH_CLIENT_ID и TWITCH_CLIENT_SECRET в .env — календарь игр выключен.';
}

let token: { value: string; expiresAt: number } | null = null;

async function getToken(): Promise<string> {
  if (token && Date.now() < token.expiresAt - 60_000) return token.value;
  const q = new URLSearchParams({
    client_id: process.env.TWITCH_CLIENT_ID ?? '',
    client_secret: process.env.TWITCH_CLIENT_SECRET ?? '',
    grant_type: 'client_credentials',
  });
  const res = await fetch(`https://id.twitch.tv/oauth2/token?${q}`, { method: 'POST', signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Twitch авторизация: HTTP ${res.status} — проверь TWITCH_CLIENT_ID и TWITCH_CLIENT_SECRET`);
  const json: any = await res.json();
  token = { value: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
  return token.value;
}

async function igdb(endpoint: string, body: string): Promise<any[]> {
  const send = async () =>
    fetch(`https://api.igdb.com/v4/${endpoint}`, {
      method: 'POST',
      headers: {
        'Client-ID': process.env.TWITCH_CLIENT_ID ?? '',
        Authorization: `Bearer ${await getToken()}`,
        Accept: 'application/json',
      },
      body,
      signal: AbortSignal.timeout(20_000),
    });
  let res = await send();
  if (res.status === 401) {
    token = null; // токен протух — берём новый и повторяем
    res = await send();
  }
  if (!res.ok) throw new Error(`IGDB HTTP ${res.status}: ${truncate(await res.text().catch(() => ''), 200)}`);
  return (await res.json()) as any[];
}

/** Ближайшие релизы: только основные игры (без DLC и переизданий), с минимальной «ожидаемостью» */
async function fetchUpcoming(cfg: GamesConfig): Promise<IgdbGame[]> {
  if (credentialsMissing()) throw new Error('нет ключей Twitch');
  const now = Math.floor((Date.now() - DAY) / 1000);
  const until = Math.floor((Date.now() + cfg.calendarDays * DAY) / 1000);
  const fields = [
    'name',
    'url',
    'first_release_date',
    'hypes',
    'summary',
    'cover.image_id',
    'genres.name',
    'platforms.abbreviation',
    'platforms.name',
    'external_games.url',
  ].join(',');
  return igdb(
    'games',
    `fields ${fields};
     where first_release_date >= ${now} & first_release_date <= ${until}
       & hypes >= ${cfg.minHype} & parent_game = null & version_parent = null;
     sort first_release_date asc;
     limit 500;`,
  );
}

// ───────────────────────── основной цикл ─────────────────────────

const seen = {
  count: () => (db.prepare('SELECT COUNT(*) AS n FROM news_seen WHERE feed = ?').get(FEED_KEY) as { n: number }).n,
  has: (id: number) => !!db.prepare('SELECT 1 FROM news_seen WHERE feed = ? AND guid = ?').get(FEED_KEY, String(id)),
  add: (id: number) => db.prepare('INSERT OR IGNORE INTO news_seen (feed, guid, ts) VALUES (?, ?, ?)').run(FEED_KEY, String(id), Date.now()),
};

/** Сбросить «уже видел» и календарь — при смене канала */
export function resetGamesAnnounce() {
  db.prepare('DELETE FROM news_seen WHERE feed = ?').run(FEED_KEY);
  setSetting('games.calendar_msg', null);
}

export function runGamesNow(client: Client) {
  return run(client);
}

async function run(client: Client): Promise<string> {
  if (running) return '⏳ Проверка уже идёт.';
  const channelId = getSetting('channel.games_announce');
  if (!channelId) return '⚪ Канал релизов игр не назначен: `/setup channel` → «Игры: релизы и календарь».';
  const missing = credentialsMissing();
  if (missing) return missing;
  running = true;
  try {
    const cfg = loadCfg();
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased() || !('send' in channel)) return `❌ Бот не видит канал <#${channelId}>.`;

    let list: IgdbGame[];
    try {
      list = await fetchUpcoming(cfg);
    } catch (e) {
      console.warn('[games] IGDB:', (e as Error).message);
      return `❌ IGDB: ${truncate((e as Error).message, 200)}`;
    }

    // Новые заметные игры. При первом запуске только запоминаем, чтобы не завалить канал.
    let posted = 0;
    const notable = list.filter((g) => (g.hypes ?? 0) >= cfg.announceMinHype);
    if (seen.count() === 0) {
      notable.forEach((g) => seen.add(g.id));
    } else {
      for (const g of notable.filter((x) => !seen.has(x.id)).slice(0, 5)) {
        try {
          await channel.send({ embeds: [announceEmbed(g)] });
          posted++;
        } catch (e) {
          console.warn('[games] Не отправилась карточка:', (e as Error).message);
        }
        seen.add(g.id);
      }
      notable.forEach((g) => seen.add(g.id));
    }

    await updateCalendar(channel, list, cfg);
    if (posted) console.log(`[games] Новых релизов в календаре: ${posted}`);
    return `✅ IGDB: ${list.length} релизов на ${cfg.calendarDays} дней. Новых карточек: ${posted}. Календарь обновлён.`;
  } finally {
    running = false;
  }
}

// ───────────────────────── оформление ─────────────────────────

const steamUrl = (g: IgdbGame) => g.external_games?.find((e) => e.url?.includes('store.steampowered.com'))?.url;
const linkOf = (g: IgdbGame) => steamUrl(g) ?? g.url ?? `https://www.igdb.com/games/${g.id}`;
const coverOf = (g: IgdbGame) =>
  g.cover?.image_id ? `https://images.igdb.com/igdb/image/upload/t_cover_big/${g.cover.image_id}.jpg` : undefined;
const dateOf = (g: IgdbGame) => new Date((g.first_release_date ?? 0) * 1000);

/** Короткий список платформ: «ПК, PS5, Xbox, Switch 2» */
function platformsOf(g: IgdbGame): string {
  const map: Record<string, string> = {
    PC: 'ПК',
    'PC (Microsoft Windows)': 'ПК',
    Mac: 'Mac',
    Linux: 'Linux',
    PS5: 'PS5',
    PS4: 'PS4',
    'Series X|S': 'Xbox',
    XONE: 'Xbox',
    Switch: 'Switch',
    'Switch 2': 'Switch 2',
    NSW2: 'Switch 2',
    iOS: 'iOS',
    Android: 'Android',
  };
  const out = new Set<string>();
  for (const p of g.platforms ?? []) {
    const key = p.abbreviation ?? p.name ?? '';
    const label = map[key] ?? (key.length <= 10 ? key : '');
    if (label) out.add(label);
  }
  return [...out].slice(0, 5).join(', ');
}

const hypeText = (n?: number) => (n ? `🔥 ${n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n}` : '');

function announceEmbed(g: IgdbGame) {
  const d = dateOf(g);
  const e = new EmbedBuilder()
    .setColor(COLOR)
    .setAuthor({ name: '🎮 Скоро выходит' })
    .setTitle(truncate(g.name, 250))
    .setURL(linkOf(g))
    .addFields(
      { name: 'Релиз', value: `<t:${Math.floor(d.getTime() / 1000)}:D> (<t:${Math.floor(d.getTime() / 1000)}:R>)`, inline: true },
      { name: 'Платформы', value: platformsOf(g) || '—', inline: true },
      { name: 'Ждут', value: hypeText(g.hypes) || '—', inline: true },
    )
    .setFooter({ text: steamUrl(g) ? 'IGDB • ссылка ведёт в Steam' : 'IGDB' });
  if (g.genres?.length) e.addFields({ name: 'Жанры', value: g.genres.map((x) => x.name).slice(0, 4).join(', ') });
  if (g.summary) e.setDescription(truncate(g.summary, 300));
  const cover = coverOf(g);
  if (cover) e.setThumbnail(cover);
  return e;
}

/** Календарь по дням: самые ожидаемые, отсортированные по дате. Режем на несколько embed'ов под лимиты Discord. */
function calendarEmbeds(list: IgdbGame[], cfg: GamesConfig) {
  const picked = [...list]
    .sort((a, b) => (b.hypes ?? 0) - (a.hypes ?? 0))
    .slice(0, cfg.calendarMax)
    .sort((a, b) => (a.first_release_date ?? 0) - (b.first_release_date ?? 0));

  const header = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('🗓 Календарь релизов игр')
    .setDescription(
      picked.length
        ? `Самые ожидаемые релизы на ${cfg.calendarDays} дней, все платформы. Название — ссылка на Steam (или IGDB). 🔥 — сколько людей ждут игру.`
        : 'В ближайшее время заметных релизов нет.',
    )
    .setTimestamp(new Date())
    .setFooter({ text: 'Данные IGDB • обновляется автоматически' });

  const embeds = [header];
  let current: EmbedBuilder | null = null;
  let text = '';
  let total = 0;
  let lastDay = '';
  const flush = () => {
    if (current && text) current.setDescription(text.trimEnd());
  };

  for (const g of picked) {
    const d = dateOf(g);
    const dayKey = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
    const dayLine = dayKey !== lastDay ? `\n**${WEEKDAYS[d.getUTCDay()]}, ${dayKey}**\n` : '';
    const plats = platformsOf(g);
    const line = `[${truncate(g.name, 55).replace(/[[\]]/g, '')}](${linkOf(g)})${plats ? ` · ${plats}` : ''}${g.hypes ? ` · ${hypeText(g.hypes)}` : ''}\n`;
    const chunk = dayLine + line;
    if (total + chunk.length > 5300) break; // лимит Discord ~6000 символов на сообщение
    if (!current || text.length + chunk.length > 3900) {
      flush();
      if (embeds.length >= 10) break;
      current = new EmbedBuilder().setColor(COLOR);
      embeds.push(current);
      text = '';
    }
    text += chunk;
    total += chunk.length;
    lastDay = dayKey;
  }
  flush();
  return embeds;
}

async function updateCalendar(channel: any, list: IgdbGame[], cfg: GamesConfig) {
  const embeds = calendarEmbeds(list, cfg);
  const msgId = getSetting('games.calendar_msg');
  if (msgId) {
    const msg = await channel.messages.fetch(msgId).catch(() => null);
    if (msg) {
      await msg.edit({ embeds }).catch((e: Error) => console.warn('[games] Не обновился календарь:', e.message));
      return;
    }
  }
  const msg = await channel.send({ embeds }).catch((e: Error) => {
    console.warn('[games] Не отправился календарь:', e.message);
    return null;
  });
  if (!msg) return;
  setSetting('games.calendar_msg', msg.id);
  await msg.pin().catch(() => console.warn('[games] Не удалось закрепить календарь (нужно право «Управлять сообщениями»)'));
}
