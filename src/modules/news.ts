import Parser from 'rss-parser';
import {
  EmbedBuilder,
  Events,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Client,
} from 'discord.js';
import { config } from '../config';
import { db, getSetting } from '../db';
import { hexToInt, readConfigJson, respond, truncate } from '../util';

interface FeedSource {
  name: string;
  url: string;
  /** "rss" (по умолчанию) или "gamerpower" — API бесплатных раздач */
  type?: 'rss' | 'gamerpower';
}
interface Category {
  title: string;
  color?: string;
  feeds: FeedSource[];
}
type FeedsConfig = Record<string, Category>;

interface NewsItem {
  guid: string;
  title: string;
  link?: string;
  text?: string;
  image?: string;
  date: number;
  source: string;
  fields?: { name: string; value: string; inline?: boolean }[];
}

const MAX_AGE_MS = 24 * 60 * 60_000; // старше суток не публикуем
const parser = new Parser({
  timeout: 20_000,
  headers: { 'User-Agent': 'TortugaDuckBot/1.0 (+Discord news bot)' },
  customFields: {
    item: [
      ['media:content', 'mediaContent'],
      ['media:thumbnail', 'mediaThumbnail'],
    ],
  },
});

const seen = {
  has: (feed: string, guid: string) => !!db.prepare('SELECT 1 FROM news_seen WHERE feed = ? AND guid = ?').get(feed, guid),
  count: (feed: string) => (db.prepare('SELECT COUNT(*) AS n FROM news_seen WHERE feed = ?').get(feed) as { n: number }).n,
  add: (feed: string, guid: string) =>
    db.prepare('INSERT OR IGNORE INTO news_seen (feed, guid, ts) VALUES (?, ?, ?)').run(feed, guid, Date.now()),
  cleanup: () => db.prepare('DELETE FROM news_seen WHERE ts < ?').run(Date.now() - 60 * 24 * 60 * 60_000),
};

export const commands = [
  new SlashCommandBuilder()
    .setName('news-now')
    .setDescription('Проверить ленты новостей прямо сейчас (для админов)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
];

let running = false;

export function setup(client: Client) {
  client.once(Events.ClientReady, () => void runAll(client));
  setInterval(() => void runAll(client), config.newsIntervalMinutes * 60_000);
  setInterval(() => seen.cleanup(), 24 * 60 * 60_000);
}

export async function onCommand(i: ChatInputCommandInteraction) {
  await respond(i, '📰 Проверяю ленты… Новые посты появятся в каналах новостей.');
  const posted = await runAll(i.client);
  await respond(i, posted >= 0 ? `📰 Готово. Опубликовано: ${posted}.` : '⏳ Проверка уже идёт, подожди немного.');
}

/** Проверяет все категории. Возвращает число опубликованных новостей (или -1, если проверка уже идёт). */
async function runAll(client: Client): Promise<number> {
  if (running) return -1;
  running = true;
  let total = 0;
  try {
    const feeds = readConfigJson<FeedsConfig>('feeds.json', {});
    for (const [key, cat] of Object.entries(feeds)) {
      const channelId = getSetting(`channel.news_${key}`);
      if (!channelId) continue;
      total += await runCategory(client, key, cat, channelId);
    }
  } finally {
    running = false;
  }
  return total;
}

async function runCategory(client: Client, key: string, cat: Category, channelId: string): Promise<number> {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased() || !('send' in channel)) return 0;

  const fresh: { feedKey: string; item: NewsItem }[] = [];
  for (const src of cat.feeds) {
    const feedKey = `${key}:${src.url}`;
    let items: NewsItem[];
    try {
      items = src.type === 'gamerpower' ? await fetchGamerPower(src) : await fetchRss(src);
    } catch (e) {
      console.warn(`[news] ${src.name}: ${(e as Error).message}`);
      continue;
    }

    // Первый запуск ленты: запоминаем всё, кроме самой свежей новости, чтобы не завалить канал
    if (seen.count(feedKey) === 0) {
      const sorted = [...items].sort((a, b) => b.date - a.date);
      sorted.slice(1).forEach((it) => seen.add(feedKey, it.guid));
      if (sorted[0]) fresh.push({ feedKey, item: sorted[0] });
      continue;
    }

    for (const it of items) {
      if (seen.has(feedKey, it.guid)) continue;
      if (Date.now() - it.date > MAX_AGE_MS && src.type !== 'gamerpower') {
        seen.add(feedKey, it.guid);
        continue;
      }
      fresh.push({ feedKey, item: it });
    }
  }

  // От старых к новым, не больше лимита за проход — остальные дождутся следующей проверки
  fresh.sort((a, b) => a.item.date - b.item.date);
  let posted = 0;
  for (const { feedKey, item } of fresh.slice(0, config.newsMaxPerRun)) {
    try {
      await channel.send({ embeds: [toEmbed(item, cat)] });
      seen.add(feedKey, item.guid);
      posted++;
    } catch (e) {
      console.warn(`[news] Не удалось отправить «${item.title}»:`, (e as Error).message);
    }
  }
  return posted;
}

function toEmbed(item: NewsItem, cat: Category) {
  const e = new EmbedBuilder()
    .setColor(hexToInt(cat.color))
    .setAuthor({ name: `${cat.title} • ${item.source}` })
    .setTitle(truncate(item.title, 250))
    .setTimestamp(new Date(item.date));
  if (item.link) e.setURL(item.link);
  if (item.text) e.setDescription(truncate(item.text, 350));
  if (item.image?.startsWith('http')) e.setImage(item.image);
  if (item.fields?.length) e.addFields(item.fields);
  return e;
}

// ───────────────────────── источники ─────────────────────────

function firstImgFromHtml(html?: string): string | undefined {
  return html?.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1];
}

async function fetchRss(src: FeedSource): Promise<NewsItem[]> {
  const feed = await parser.parseURL(src.url);
  return (feed.items ?? []).map((it: any) => {
    const image =
      it.enclosure?.url ??
      it.mediaContent?.$?.url ??
      it.mediaThumbnail?.$?.url ??
      firstImgFromHtml(it.content) ??
      firstImgFromHtml(it['content:encoded']);
    const date = Date.parse(it.isoDate ?? it.pubDate ?? '') || Date.now();
    return {
      guid: String(it.guid ?? it.link ?? it.title),
      title: it.title ?? 'Без заголовка',
      link: it.link,
      text: it.contentSnippet ?? it.summary,
      image,
      date,
      source: src.name,
    };
  });
}

async function fetchGamerPower(src: FeedSource): Promise<NewsItem[]> {
  const res = await fetch(src.url, { headers: { 'User-Agent': 'TortugaDuckBot/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as any[];
  if (!Array.isArray(data)) return [];
  return data.map((g) => {
    const fields: { name: string; value: string; inline?: boolean }[] = [];
    if (g.platforms) fields.push({ name: 'Где', value: String(g.platforms).slice(0, 1000), inline: true });
    if (g.worth && g.worth !== 'N/A') fields.push({ name: 'Обычная цена', value: `~~${g.worth}~~ → **бесплатно**`, inline: true });
    if (g.end_date && g.end_date !== 'N/A') {
      const ts = Math.floor(Date.parse(String(g.end_date).replace(' ', 'T') + 'Z') / 1000);
      if (Number.isFinite(ts)) fields.push({ name: 'До', value: `<t:${ts}:f> (<t:${ts}:R>)`, inline: true });
    }
    return {
      guid: `gp:${g.id}`,
      title: `🎁 ${g.title}`,
      link: g.open_giveaway_url ?? g.gamerpower_url,
      text: g.description,
      image: g.image ?? g.thumbnail,
      date: Date.parse(String(g.published_date ?? '').replace(' ', 'T') + 'Z') || Date.now(),
      source: src.name,
      fields,
    };
  });
}
