import { getSetting, setSetting } from './db';

/**
 * Закреплённое сообщение-календарь: редактируем старое, а если не вышло —
 * удаляем его и отправляем заново (и закрепляем). Возвращает понятный статус для /…_check.
 */
export async function upsertPinned(channel: any, settingKey: string, payload: { embeds: any[]; components: any[] }, tag: string): Promise<string> {
  const msgId = getSetting(settingKey);
  let editError = '';
  if (msgId) {
    const old = await channel.messages.fetch(msgId).catch(() => null);
    if (old) {
      try {
        await old.edit(payload);
        return 'Календарь обновлён.';
      } catch (e: any) {
        editError = e?.message ?? String(e);
        console.warn(`[${tag}] Не обновился календарь, отправляю заново:`, editError);
        await old.delete().catch(() => {});
      }
    }
  }
  try {
    const msg = await channel.send(payload);
    setSetting(settingKey, msg.id);
    const pinned = await msg.pin().then(() => true).catch(() => false);
    if (!pinned) console.warn(`[${tag}] Не удалось закрепить календарь (нужно право «Управлять сообщениями»)`);
    return `Календарь ${editError ? 'отправлен заново' : 'создан'}${pinned ? ' и закреплён' : ', но не закреплён — нет права «Управлять сообщениями»'}.`;
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    console.warn(`[${tag}] Не отправился календарь:`, msg);
    return `⚠️ Календарь не обновился: ${msg}${editError ? ` (до этого при правке: ${editError})` : ''}`;
  }
}
