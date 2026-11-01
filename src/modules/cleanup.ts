import { Events, type Client } from 'discord.js';
import { getSetting } from '../db';

/**
 * Чистка каналов анонсов (аниме, игры, кино): карточки бота старше 24 часов удаляются.
 * Календарь (все его сообщения) и закреплённые сообщения не трогаем.
 * Проверка — раз в час, так что карточка живёт от 24 до 25 часов.
 */

const KEEP_MS = 24 * 3600_000;
const TWO_WEEKS = 14 * 24 * 3600_000 - 60_000;
const CHANNELS: [string, string][] = [
  ['channel.anime_announce', 'anime.calendar_msg'],
  ['channel.games_announce', 'games.calendar_msg'],
  ['channel.movies_announce', 'movies.calendar_msg'],
];

function calendarIds(key: string): Set<string> {
  const raw = getSetting(key);
  if (!raw) return new Set();
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return new Set(arr.map(String));
  } catch {
    /* старый формат — один id */
  }
  return new Set([raw]);
}

async function cleanChannel(client: Client, channelKey: string, calendarKey: string): Promise<number> {
  const channelId = getSetting(channelKey);
  if (!channelId) return 0;
  const channel: any = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.() || !channel.messages) return 0;

  const keep = calendarIds(calendarKey);
  const me = client.user?.id;
  const now = Date.now();
  const old: any[] = [];
  let before: string | undefined;
  for (let page = 0; page < 5; page++) {
    const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch?.size) break;
    for (const m of batch.values()) {
      if (m.author?.id !== me || m.pinned || keep.has(m.id)) continue;
      if (now - m.createdTimestamp > KEEP_MS) old.push(m);
    }
    before = batch.last()?.id;
    if (batch.size < 100) break;
  }
  if (!old.length) return 0;

  let deleted = 0;
  const recent = old.filter((m) => now - m.createdTimestamp < TWO_WEEKS);
  const ancient = old.filter((m) => now - m.createdTimestamp >= TWO_WEEKS);
  // Сообщения младше 14 дней Discord разрешает удалять пачкой — это быстро
  for (let k = 0; k < recent.length; k += 100) {
    const chunk = recent.slice(k, k + 100);
    try {
      if (chunk.length === 1) await chunk[0].delete();
      else await channel.bulkDelete(chunk.map((m: any) => m.id), true);
      deleted += chunk.length;
    } catch (e) {
      console.warn(`[cleanup] Не удалось удалить в #${channel.name}:`, (e as Error).message);
    }
  }
  // Более старые — по одному
  for (const m of ancient) {
    if (await m.delete().then(() => true).catch(() => false)) deleted++;
  }
  return deleted;
}

async function run(client: Client) {
  for (const [channelKey, calendarKey] of CHANNELS) {
    const n = await cleanChannel(client, channelKey, calendarKey).catch((e) => {
      console.warn('[cleanup]', (e as Error).message);
      return 0;
    });
    if (n) console.log(`[cleanup] ${channelKey}: удалено старых карточек — ${n}`);
  }
}

export function setup(client: Client) {
  client.once(Events.ClientReady, () => {
    setTimeout(() => void run(client), 2 * 60_000);
    setInterval(() => void run(client), 60 * 60_000);
  });
}
