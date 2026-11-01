import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import type { ComponentInteraction } from '../types';
import type { TrailerSource } from '../trailerUi';
import { truncate } from '../util';
import { animeTrailer } from './anime';
import { gameTrailer } from './games';
import { tmdbTrailer } from './movies';

/**
 * Обработка кнопок и меню «▶️ Трейлер»: находим трейлер и присылаем ЛИЧНО нажавшему.
 * Ссылку на YouTube Discord сам превращает в плеер — видео играет прямо в Discord.
 */
export const componentPrefix = 'trailer';

interface Found {
  title: string;
  url?: string;
}

const cache = new Map<string, { at: number; found: Found }>();
const CACHE_MS = 24 * 60 * 60_000;

async function resolve(source: TrailerSource, id: string): Promise<Found> {
  const key = `${source}:${id}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.found;
  let found: Found;
  switch (source) {
    case 'tmdbm':
      found = await tmdbTrailer('movie', Number(id));
      break;
    case 'tmdbt':
      found = await tmdbTrailer('tv', Number(id));
      break;
    case 'igdb':
      found = await gameTrailer(Number(id));
      break;
    case 'shiki':
      found = await animeTrailer(Number(id));
      break;
    default:
      found = { title: 'Неизвестно' };
  }
  cache.set(key, { at: Date.now(), found });
  if (cache.size > 1000) cache.delete(cache.keys().next().value as string);
  return found;
}

const SUFFIX: Record<TrailerSource, string> = {
  tmdbm: 'трейлер',
  tmdbt: 'трейлер сериал',
  igdb: 'trailer',
  shiki: 'PV трейлер аниме',
};

export async function onComponent(i: ComponentInteraction) {
  if (!i.isRepliable()) return;
  let source: TrailerSource;
  let id: string;
  if (i.isStringSelectMenu()) {
    [source, id] = (i.values[0] ?? '').split(':') as [TrailerSource, string];
  } else if (i.isButton()) {
    const [, s, rest] = i.customId.split(':');
    source = s as TrailerSource;
    id = rest;
  } else return;
  if (!source || !id) return;

  await i.deferReply({ flags: MessageFlags.Ephemeral });
  let found: Found;
  try {
    found = await resolve(source, id);
  } catch (e) {
    console.warn(`[trailer] ${source}:${id}:`, (e as Error).message);
    found = { title: '' };
  }

  if (found.url) {
    // Только ссылка в тексте — так Discord покажет под ней встроенный плеер
    return i.editReply({ content: `🎬 **${truncate(found.title || 'Трейлер', 150)}**\n${found.url}` });
  }

  const query = `${found.title || ''} ${SUFFIX[source]}`.trim();
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel('Найти на YouTube')
      .setEmoji('🔎')
      .setURL(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`),
  );
  return i.editReply({
    content: `😔 У **${truncate(found.title || 'этого релиза', 150)}** пока нет официального трейлера в базе.`,
    components: found.title ? [row] : [],
  });
}
