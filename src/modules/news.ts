import Parser from 'rss-parser';
import {
  EmbedBuilder,
  Events,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Client,
} from 'discord.js';
import { config } from '../config';
import { db, getSetting } from '../db';
import { hexToInt, readConfigJson, truncate } from '../util';

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

/**
 * Сбросить «уже опубликовано» для категории. Вызывается при смене канала:
 * иначе новости, ушедшие в старый канал, в новый уже не попадут, и он будет пустым до выхода свежих статей.
 */
export function resetCategory(key: string) {
  db.prepare('DELETE FROM news_seen WHERE feed LIKE ?').run(`${key}:%`);
}

/** Запустить проверку сразу (например, после /setup). */
export function runNewsNow(client: Client) {
  return runAll(client);
}

export function setup(client: Client) {
  client.once(Events.ClientReady, () => void runAll(client));
  setInterval(() => void runAll(client), config.newsIntervalMinutes * 60_000);
  setInterval(() => seen.cleanup(), 24 * 60 * 60_000);
}

export async function onCommand(i: ChatInputCommandInteraction) {
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const report: string[] = [];
  const posted = await runAll(i.client, report);
  if (posted < 0) return i.editReply('⏳ Проверка уже идёт, подожди минуту и повтори.');
  const embed = new EmbedBuilder()
    .setColor(config.color)
    .setTitle(`📰 Проверка новостей — опубликовано: ${posted}`)
    .setDescription((report.join('\n') || 'Ни одной категории не назначен канал. Используй `/setup channel`.').slice(0, 4000))
    .setFooter({ text: 'Новые посты появляются по мере выхода статей. «новых 0» — значит, свежего пока ничего нет.' });
  return i.editReply({ embeds: [embed] });
}

/**
 * Проверяет все категории. Возвращает число опубликованных новостей (или -1, если проверка уже идёт).
 * Если передан report — пишет туда строку о состоянии каждого источника.
 */
async function runAll(client: Client, report?: string[]): Promise<number> {
  if (running) return -1;
  running = true;
  let total = 0;
  try {
    const feeds = readConfigJson<FeedsConfig>('feeds.json', {});
    for (const [key, cat] of Object.entries(feeds)) {
      const channelId = getSetting(`channel.news_${key}`);
      if (!channelId) {
        report?.push(`**${cat.title}** — ⚪ канал не назначен`);
        continue;
      }
      total += await runCategory(client, key, cat, channelId, report);
    }
  } finally {
    running = false;
  }
  if (total > 0) console.log(`[news] Опубликовано новостей: ${total}`);
  return total;
}

async function runCategory(
  client: Client,
  key: string,
  cat: Category,
  channelId: string,
  report?: string[],
): Promise<number> {
  const channel = await client.channels.fetch(channelId).catch((e) => {
    console.warn(`[news] ${cat.title}: не открыть канал ${channelId}: ${e?.message}`);
    return null;
  });
  if (!channel?.isTextBased() || !('send' in channel)) {
    report?.push(`**${cat.title}** — ❌ бот не видит канал <#${channelId}>. Дай роли Tortuga Duck доступ к нему.`);
    return 0;
  }
  if ('permissionsFor' in channel && client.user) {
    const perms = (channel as any).permissionsFor(client.user);
    const missing = ['ViewChannel', 'SendMessages', 'EmbedLinks'].filter((p) => !perms?.has(p));
    if (missing.length) {
      report?.push(`**${cat.title}** — ❌ в <#${channelId}> боту не хватает прав: ${missing.join(', ')}`);
      console.warn(`[news] ${cat.title}: нет прав ${missing.join(', ')} в канале ${channelId}`);
      return 0;
    }
  }

  report?.push(`**${cat.title}** → <#${channelId}>`);
  const fresh: { feedKey: string; item: NewsItem }[] = [];
  for (const src of cat.feeds) {
    const feedKey = `${key}:${src.url}`;
    let items: NewsItem[];
    try {
      items = src.type === 'gamerpower' ? await fetchGamerPower(src) : await fetchRss(src);
    } catch (e) {
      const msg = (e as Error).message;
      console.warn(`[news] ${src.name}: ${msg}`);
      report?.push(`  • ${src.name}: ❌ ${truncate(msg, 120)}`);
      continue;
    }

    // Первый запуск ленты: запоминаем всё, кроме самой свежей новости, чтобы не завалить канал
    if (seen.count(feedKey) === 0) {
      const sorted = [...items].sort((a, b) => b.date - a.date);
      sorted.slice(1).forEach((it) => seen.add(feedKey, it.guid));
      if (sorted[0]) fresh.push({ feedKey, item: sorted[0] });
      report?.push(`  • ${src.name}: ✅ ${items.length} записей, первый запуск — публикую самую свежую`);
      continue;
    }

    let fresh1 = 0;
    for (const it of items) {
      if (seen.has(feedKey, it.guid)) continue;
      if (Date.now() - it.date > MAX_AGE_MS && src.type !== 'gamerpower') {
        seen.add(feedKey, it.guid);
        continue;
      }
      fresh.push({ feedKey, item: it });
      fresh1++;
    }
    report?.push(`  • ${src.name}: ✅ ${items.length} записей, новых ${fresh1}`);
  }

  // От старых к новым, не больше лимита за проход — остальные дождутся следующей проверки
  fresh.sort((a, b) => a.item.date - b.item.date);
  let posted = 0;
  for (const { feedKey, item } of fresh.slice(0, config.newsMaxPerRun)) {
    try {
      // Для Telegram-постов фото и видео надёжнее брать прямо из Telegram
      let videoUrl: string | undefined;
      if (item.link && /^https?:\/\/t\.me\//i.test(item.link)) {
        const media = await telegramMedia(item.link);
        item.image = media.image ?? item.image;
        videoUrl = media.videoUrl;
      }
      // Ссылку на видео отправляем текстом — Discord сам покажет под ней плеер
      await channel.send({ content: videoUrl ? `▶️ ${videoUrl}` : undefined, embeds: [toEmbed(item, cat)] });
      seen.add(feedKey, item.guid);
      posted++;
    } catch (e) {
      const msg = (e as Error).message;
      console.warn(`[news] Не удалось отправить «${item.title}»:`, msg);
      report?.push(`  • ❌ не отправилось «${truncate(item.title, 60)}»: ${truncate(msg, 100)}`);
    }
  }
  if (fresh.length > config.newsMaxPerRun) {
    report?.push(`  • ещё ${fresh.length - config.newsMaxPerRun} в очереди — выйдут в следующие проверки`);
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

const IMG_EXT = /\.(jpe?g|png|webp|gif)(\?|$)/i;

/** Абсолютный https-адрес или undefined */
function absUrl(u?: string): string | undefined {
  if (!u) return undefined;
  const url = u.trim().replace(/&amp;/g, '&');
  const full = url.startsWith('//') ? `https:${url}` : url;
  if (!/^https?:\/\//i.test(full)) return undefined;
  // Внутренние адреса (rsshub:1200, localhost) Discord открыть не сможет
  try {
    const host = new URL(full).hostname;
    if (!host.includes('.') || host === 'localhost') return undefined;
  } catch {
    return undefined;
  }
  return full;
}

/** Все картинки из HTML: <img src> и background-image:url(...). Без эмодзи и иконок. */
function imagesFromHtml(html?: string): string[] {
  if (!html) return [];
  const out: string[] = [];
  for (const m of html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) out.push(m[1]);
  for (const m of html.matchAll(/background-image:\s*url\(['"]?([^'")]+)['"]?\)/gi)) out.push(m[1]);
  return out
    .map(absUrl)
    .filter((u): u is string => !!u)
    .filter((u) => !/emoji|\/img\/(?:emoji|t_logo)|favicon|\.svg(\?|$)/i.test(u));
}

/** HTML без цитаты-ответа (<blockquote>) — в Telegram-постах там чужой текст и миниатюры */
const withoutQuotes = (html?: string) => html?.replace(/<blockquote[\s\S]*?<\/blockquote>/gi, ' ');

function htmlToText(html?: string): string | undefined {
  if (!html) return undefined;
  const text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
  return text.trim() || undefined;
}

function pickImage(it: any): string | undefined {
  const enc = it.enclosure;
  const encImage =
    enc?.url && (String(enc.type ?? '').startsWith('image/') || IMG_EXT.test(enc.url)) ? absUrl(enc.url) : undefined;
  const html = it['content:encoded'] ?? it.content;
  return (
    encImage ??
    absUrl(it.mediaContent?.$?.url) ??
    absUrl(it.mediaThumbnail?.$?.url) ??
    imagesFromHtml(withoutQuotes(html))[0] ??
    imagesFromHtml(html)[0]
  );
}

const VIDEO_HOSTS = /(youtube\.com|youtu\.be|fxtwitter\.com|fixupx\.com|vxtwitter\.com|twitter\.com|x\.com|tiktok\.com|rutube\.ru|vkvideo\.ru|vk\.com\/video)/i;

/**
 * Медиа из Telegram-поста: открываем встраиваемую версию (t.me/канал/123?embed=1).
 *  • image — фото поста, кадр из видео или картинка превью ссылки;
 *  • videoUrl — ссылка на видео из превью (YouTube, Twitter/FxTwitter…): Discord покажет её с плеером.
 */
async function telegramMedia(link: string): Promise<{ image?: string; videoUrl?: string }> {
  const m = link.match(/^https?:\/\/t\.me\/(?:s\/)?([\w\d_]+)\/(\d+)/i);
  if (!m) return {};
  try {
    const res = await fetch(`https://t.me/${m[1]}/${m[2]}?embed=1&mode=tme`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TortugaDuckBot/1.0)' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return {};
    const html = await res.text();
    const bg = (cls: string) =>
      absUrl(html.match(new RegExp(`${cls}[^>]*background-image:\\s*url\\(['"]?([^'")]+)`, 'i'))?.[1]);
    const image =
      bg('tgme_widget_message_photo_wrap') ??
      bg('tgme_widget_message_video_thumb') ??
      bg('link_preview_image') ??
      bg('link_preview_right_image');
    const preview = html.match(/class="tgme_widget_message_link_preview"[^>]*href="([^"]+)"/i)?.[1]
      ?? html.match(/href="([^"]+)"[^>]*class="tgme_widget_message_link_preview"/i)?.[1];
    const previewUrl = absUrl(preview);
    return { image, videoUrl: previewUrl && VIDEO_HOSTS.test(previewUrl) ? previewUrl : undefined };
  } catch {
    return {};
  }
}

/** Убираем из Telegram-текста служебный хвост вроде «📎 Подписаться на Новости» */
function cleanTelegramText(text?: string): string | undefined {
  const cleaned = text
    ?.split('\n')
    .filter((line) => !/подписаться на|подпишись на|subscribe/i.test(line))
    .join('\n')
    .replace(/[📎🗞️🔗\s]+$/u, '')
    .trim();
  return cleaned || undefined;
}

async function fetchRss(src: FeedSource): Promise<NewsItem[]> {
  const feed = await parser.parseURL(src.url);
  return (feed.items ?? []).map((it: any) => {
    const date = Date.parse(it.isoDate ?? it.pubDate ?? '') || Date.now();
    const html = it['content:encoded'] ?? it.content;
    const isTelegram = /^https?:\/\/t\.me\//i.test(it.link ?? '');
    return {
      guid: String(it.guid ?? it.link ?? it.title),
      title: it.title ?? 'Без заголовка',
      link: it.link,
      // У Telegram-постов убираем цитату, на которую отвечает пост
      text: (isTelegram ? cleanTelegramText(htmlToText(withoutQuotes(html))) : undefined) ?? it.contentSnippet ?? it.summary,
      image: pickImage(it),
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
