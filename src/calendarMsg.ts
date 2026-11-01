import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageType } from 'discord.js';
import { getSetting, setSetting } from './db';

/**
 * Календарь из нескольких небольших сообщений подряд (Discord ограничивает размер одного сообщения).
 *  • эмбеды раскладываются по сообщениям так, чтобы в каждом было не больше ~3000 символов;
 *  • меню трейлеров — под последним сообщением;
 *  • бот запоминает все сообщения и редактирует их на месте; если число сообщений изменилось
 *    или правка не прошла — удаляет старые и отправляет заново;
 *  • закрепляется только первое, а системное «… закрепляет сообщение» бот сразу удаляет.
 * Возвращает понятный статус для /…_check.
 */
const MSG_BUDGET = 3000;

function embedLength(e: any): number {
  const d = e?.data ?? e ?? {};
  let n = (d.title?.length ?? 0) + (d.description?.length ?? 0) + (d.footer?.text?.length ?? 0) + (d.author?.name?.length ?? 0);
  for (const f of d.fields ?? []) n += (f.name?.length ?? 0) + (f.value?.length ?? 0);
  return n;
}

function splitPayload(payload: { embeds: any[]; components: any[] }) {
  const groups: any[][] = [];
  let cur: any[] = [];
  let size = 0;
  for (const e of payload.embeds) {
    const len = embedLength(e);
    if (cur.length && (size + len > MSG_BUDGET || cur.length >= 10)) {
      groups.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(e);
    size += len;
  }
  if (cur.length) groups.push(cur);
  if (!groups.length) groups.push([]);
  return groups.map((embeds, k) => ({ embeds, components: k === groups.length - 1 ? payload.components : [] }));
}

function savedIds(settingKey: string): string[] {
  const raw = getSetting(settingKey);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr.map(String);
  } catch {
    /* старый формат — один id */
  }
  return [raw];
}

/** Удаляет системные сообщения «… закрепляет сообщение» от бота в последних сообщениях канала */
export async function cleanupPinNotices(channel: any) {
  const me = channel.client?.user?.id;
  const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  if (!recent) return;
  for (const m of recent.values()) {
    if (m.type === MessageType.ChannelPinnedMessage && m.author?.id === me) await m.delete().catch(() => {});
  }
}

export async function upsertPinned(channel: any, settingKey: string, payload: { embeds: any[]; components: any[] }, tag: string): Promise<string> {
  const parts = splitPayload(payload);
  const oldIds = savedIds(settingKey);

  // 1) Пробуем отредактировать на месте, если сообщений столько же
  let editError = '';
  if (oldIds.length === parts.length) {
    const olds = await Promise.all(oldIds.map((id) => channel.messages.fetch(id).catch(() => null)));
    if (olds.every(Boolean)) {
      try {
        for (let k = 0; k < parts.length; k++) await olds[k].edit(parts[k]);
        await cleanupPinNotices(channel);
        return 'Календарь обновлён.';
      } catch (e: any) {
        editError = e?.message ?? String(e);
        console.warn(`[${tag}] Не обновился календарь, отправляю заново:`, editError);
      }
    }
  }

  // 2) Удаляем старые и отправляем заново
  for (const id of oldIds) {
    const m = await channel.messages.fetch(id).catch(() => null);
    if (m) await m.delete().catch(() => {});
  }
  const sent: any[] = [];
  try {
    for (const part of parts) sent.push(await channel.send(part));
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    console.warn(`[${tag}] Не отправился календарь:`, msg);
    for (const m of sent) await m.delete().catch(() => {});
    return `⚠️ Календарь не обновился: ${msg}`;
  }
  setSetting(settingKey, JSON.stringify(sent.map((m) => m.id)));

  const pinned = await sent[0].pin().then(() => true).catch(() => false);
  if (!pinned) console.warn(`[${tag}] Не удалось закрепить календарь (нужно право «Управлять сообщениями»)`);
  await cleanupPinNotices(channel);
  return `Календарь ${oldIds.length ? 'отправлен заново' : 'создан'} (${sent.length} сообщ.)${pinned ? ' и закреплён' : ', но не закреплён — нет права «Управлять сообщениями»'}.`;
}

/** Ссылка на первое сообщение закреплённого календаря (или null, если его ещё нет) */
export function calendarUrl(channel: any, settingKey: string): string | null {
  const id = savedIds(settingKey)[0];
  if (!id || !channel?.guildId) return null;
  return `https://discord.com/channels/${channel.guildId}/${channel.id}/${id}`;
}

/** Кнопки под карточкой анонса: «▶️ Трейлер» (если есть) и «📅 Календарь» (ссылка на закреплённый календарь) */
export function cardComponents(trailerRow: ActionRowBuilder<ButtonBuilder> | null, calUrl: string | null) {
  const row = trailerRow ?? new ActionRowBuilder<ButtonBuilder>();
  if (calUrl) row.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(calUrl).setEmoji('📅').setLabel('Календарь'));
  return row.components.length ? [row] : [];
}
