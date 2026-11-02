import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import { truncate } from './util';

/**
 * Кнопки и меню «▶️ Трейлер» для карточек и календарей.
 * Источник трейлера: tmdbm (фильм TMDB), tmdbt (сериал TMDB), igdb (игра), shiki (аниме).
 * Нажатие обрабатывает модуль modules/trailers.ts — присылает трейлер лично нажавшему.
 */
export type TrailerSource = 'tmdbm' | 'tmdbt' | 'igdb' | 'shiki';

export interface TrailerItem {
  source: TrailerSource;
  id: number | string;
  title: string;
  /** Подпись под пунктом меню, например дата */
  hint?: string;
}

/** Кнопка под карточкой */
export function trailerButtonRow(source: TrailerSource, id: number | string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`trailer:${source}:${id}`).setLabel('Трейлер').setEmoji('▶️').setStyle(ButtonStyle.Secondary),
  );
}

/**
 * Меню под календарём: по 25 пунктов в меню (лимит Discord), до maxMenus меню.
 * placeholder — подпись, например «▶️ Трейлер к фильму…».
 */
export function trailerMenus(items: TrailerItem[], placeholder: string, menuId: string, maxMenus = 2) {
  const rows: ActionRowBuilder<StringSelectMenuBuilder>[] = [];
  const unique = items.filter((x, k, arr) => arr.findIndex((y) => y.source === x.source && y.id === x.id) === k);
  for (let m = 0; m < maxMenus && m * 25 < unique.length; m++) {
    const chunk = unique.slice(m * 25, m * 25 + 25);
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`trailer:menu:${menuId}:${m}`)
      .setPlaceholder(unique.length > 25 ? `${placeholder} (${m * 25 + 1}–${m * 25 + chunk.length})` : placeholder)
      .addOptions(
        chunk.map((x) => {
          const opt = new StringSelectMenuOptionBuilder().setLabel(truncate(x.title, 100)).setValue(`${x.source}:${x.id}`);
          if (x.hint) opt.setDescription(truncate(x.hint, 100));
          return opt;
        }),
      );
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
  }
  return rows;
}

/**
 * Кнопки под карточкой анонса: ▶️ Трейлер (если есть) · 👀 Буду смотреть · N · 🔔 Напомнить · 📅 Календарь.
 * Счётчик «Буду смотреть» общий для сервера, «Напомнить» — личное (никому не видно).
 */
export function cardButtons(source: TrailerSource, id: number | string, hasTrailer: boolean, calendarUrl: string | null, watchCount = 0) {
  const verb = source === 'igdb' ? 'Буду играть' : 'Буду смотреть';
  const row = new ActionRowBuilder<ButtonBuilder>();
  if (hasTrailer) row.addComponents(new ButtonBuilder().setCustomId(`trailer:${source}:${id}`).setLabel('Трейлер').setEmoji('▶️').setStyle(ButtonStyle.Secondary));
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`watch:w:${source}:${id}`)
      .setLabel(watchCount ? `${verb} · ${watchCount}` : verb)
      .setEmoji('👀')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`watch:r:${source}:${id}`).setLabel('Напомнить').setEmoji('🔔').setStyle(ButtonStyle.Secondary),
  );
  if (calendarUrl) row.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(calendarUrl).setEmoji('📅').setLabel('Календарь'));
  return [row];
}

/**
 * Меню «Выбрать тайтл» под календарём: выбор открывает личную мини-карточку
 * с трейлером, «Буду смотреть» и «Напомнить» (обрабатывает modules/watchlist.ts).
 */
export function pickMenus(items: TrailerItem[], placeholder: string, menuId: string, maxMenus = 2) {
  return trailerMenus(items, placeholder, menuId, maxMenus).map((row) => {
    const menu = row.components[0];
    menu.setCustomId(menu.data.custom_id!.replace(/^trailer:menu:/, 'watch:pick:'));
    return row;
  });
}
