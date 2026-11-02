import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  Events,
  MessageFlags,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  ThreadAutoArchiveDuration,
  type ChatInputCommandInteraction,
  type Client,
} from 'discord.js';
import { config } from '../config';
import { db, getSetting, setSetting } from '../db';
import {
  ANNOUNCE_CHANNEL,
  VERB,
  clearMark,
  markOf,
  marksOf,
  premiereInfo,
  refreshCalendarSoon,
  rememberItem,
  storedItem,
  toggleMark,
  watchers,
  type PremiereInfo,
  type Source,
} from '../premiere';
import type { ComponentInteraction } from '../types';
import { truncate } from '../util';

/**
 * «👀 Буду смотреть» и «🔔 Напомнить» для аниме, игр, фильмов и сериалов.
 *  • кнопки на карточках анонсов и меню «Выбрать…» под календарями (личная мини-карточка);
 *  • в день премьеры (10:00 по Киеву) — напоминание каждому отметившемуся:
 *    в личную приватную ветку на сервере (по умолчанию) или в ЛС; если не вышло — общим сообщением в канале анонсов;
 *  • перенос даты — отдельное уведомление, отметка сохраняется;
 *  • /premieres — мои отметки и куда присылать напоминания.
 */

export const componentPrefix = 'watch';

export const commands = [new SlashCommandBuilder().setName('premieres').setDescription('Мои премьеры: что я жду и куда присылать напоминания')];

const SOURCES: Source[] = ['shiki', 'igdb', 'tmdbm', 'tmdbt'];
const isSource = (s: string): s is Source => (SOURCES as string[]).includes(s);
const TZ = process.env.TZ_REMIND ?? 'Europe/Kiev';
const REMIND_HOUR = 10;
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_NOM = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

// ───────────────────────── время ─────────────────────────

function kyivNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function dateText(date: string | null, approx?: boolean, withRelative = true): string {
  if (!date) return 'дата пока не объявлена';
  const d = new Date(`${date}T00:00:00Z`);
  if (approx) return d.getUTCMonth() === 11 && d.getUTCDate() === 31 ? `${d.getUTCFullYear()} год` : `${MONTHS_NOM[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  // Полдень по UTC — чтобы у всех часовых поясов показалась та же дата
  const unix = Math.floor(d.getTime() / 1000) + 12 * 3600;
  return withRelative ? `<t:${unix}:D> (<t:${unix}:R>)` : `${d.getUTCDate()} ${MONTHS_GEN[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// ───────────────────────── куда присылать ─────────────────────────

type Mode = 'thread' | 'dm';
const modeOf = (userId: string): Mode => (getSetting(`remind.mode.${userId}`) === 'dm' ? 'dm' : 'thread');
const remindersChannel = () => getSetting('channel.reminders');

function destinationText(userId: string): string {
  if (modeOf(userId) === 'thread' && remindersChannel()) return `в твою личную ветку в <#${remindersChannel()}>`;
  return 'в личные сообщения';
}

// ───────────────────────── мини-карточка ─────────────────────────

function whoText(ids: string[], max = 10): string {
  if (!ids.length) return '';
  const shown = ids.slice(0, max).map((id) => `<@${id}>`).join(', ');
  return ids.length > max ? `${shown} и ещё ${ids.length - max}` : shown;
}

function infoEmbed(info: PremiereInfo) {
  const e = new EmbedBuilder()
    .setColor(info.color)
    .setAuthor({ name: info.kindLabel })
    .setTitle(truncate(info.title, 250))
    .setURL(info.link.url);
  const desc = [info.original ? `*${truncate(info.original, 150)}*` : '', info.description ?? ''].filter(Boolean).join('\n\n');
  if (desc) e.setDescription(desc);
  return e;
}

function miniCard(info: PremiereInfo, userId: string) {
  const mark = markOf(info.source, info.id, userId);
  const who = watchers(info.source, info.id);
  const e = infoEmbed(info).addFields({ name: info.source === 'igdb' ? 'Релиз' : 'Премьера', value: dateText(info.date, info.approx), inline: true }, ...info.fields);
  if (who.length) e.addFields({ name: `👀 Ждут: ${who.length}`, value: whoText(who) });
  if (info.thumb) e.setThumbnail(info.thumb);
  const status = [mark?.watch ? '👀 ты в списке ждущих' : '', mark?.watch || mark?.remind ? `🔔 напомню ${destinationText(userId)}` : ''].filter(Boolean).join(' · ');
  e.setFooter({ text: status ? status.replace(/<#\d+>/, '#напоминания') : 'Видно только тебе' });

  const v = VERB[info.source];
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`trailer:${info.source}:${info.id}`).setLabel('Трейлер').setEmoji('▶️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`watch:w:${info.source}:${info.id}`)
      .setLabel(mark?.watch ? `${v.done} · отменить` : `${v.watch}${who.length ? ` · ${who.length}` : ''}`)
      .setEmoji(mark?.watch ? '✅' : '👀')
      .setStyle(mark?.watch ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`watch:r:${info.source}:${info.id}`)
      .setLabel(mark?.remind || mark?.watch ? (mark?.remind ? 'Напомню · отменить' : 'Напомню (ты ждёшь)') : 'Напомнить')
      .setEmoji('🔔')
      .setStyle(mark?.remind ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(!!mark?.watch && !mark?.remind),
    new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(info.link.url).setLabel(info.link.label),
  );
  return { embeds: [e], components: [row] };
}

// ───────────────────────── обработка кнопок и меню ─────────────────────────

export async function onComponent(i: ComponentInteraction) {
  if (!i.inCachedGuild() && !i.isButton()) return;
  const parts = i.customId.split(':');
  const action = parts[1];

  // Меню под календарём / в «Моих премьерах» → личная мини-карточка
  if ((action === 'pick' || action === 'mine') && i.isStringSelectMenu()) {
    const [source, id] = (i.values[0] ?? '').split(':');
    if (!isSource(source) || !id) return;
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const info = await premiereInfo(source, id).catch((e) => {
      console.warn(`[watch] ${source}:${id}:`, (e as Error).message);
      return null;
    });
    if (!info) return i.editReply('⚠️ Не удалось загрузить данные о премьере, попробуй через минуту.');
    return i.editReply(miniCard(info, i.user.id));
  }

  if (action === 'mode' && i.isButton()) {
    const mode = parts[2] === 'dm' ? 'dm' : 'thread';
    setSetting(`remind.mode.${i.user.id}`, mode);
    return i.update(myPremieres(i.user.id));
  }

  if (action === 'off' && i.isButton()) {
    const [source, id] = [parts[2], parts[3]];
    if (!isSource(source)) return;
    clearMark(source, id, i.user.id);
    refreshCalendarSoon(source);
    return i.reply({ content: '🔕 Больше не напомню об этом. Снова отметиться можно в меню под календарём.', flags: MessageFlags.Ephemeral });
  }

  if ((action === 'w' || action === 'r') && i.isButton()) {
    const [source, id] = [parts[2], parts[3]];
    if (!isSource(source) || !id) return;
    const ephemeral = i.message.flags.has(MessageFlags.Ephemeral);
    const before = markOf(source, id, i.user.id);
    const mark = toggleMark(source, id, i.user.id, action === 'w' ? 'watch' : 'remind');
    if (action === 'w') refreshCalendarSoon(source);

    // Дату запоминаем в фоне — ежедневная проверка будет сверять с ней
    const remember = () =>
      premiereInfo(source, id)
        .then((info) => info && rememberItem(info, false))
        .catch(() => {});

    if (ephemeral) {
      await i.deferUpdate();
      const info = await premiereInfo(source, id).catch(() => null);
      if (info) {
        rememberItem(info, false);
        await i.editReply(miniCard(info, i.user.id));
      }
      return;
    }

    // Публичная карточка анонса
    void remember();
    if (action === 'r') {
      const text = mark.remind
        ? `🔔 Напомню в день премьеры ${destinationText(i.user.id)}. Никто, кроме тебя, этого не видит. Отменить — нажми «Напомнить» ещё раз.`
        : mark.watch
          ? '🔔 Ты отмечен как «ждущий» — напоминание всё равно придёт. Убрать — нажми «Буду смотреть» ещё раз.'
          : '🔕 Напоминание отменено.';
      return i.reply({ content: text, flags: MessageFlags.Ephemeral });
    }
    await updateCard(i, source, id);
    const v = VERB[source];
    const text = mark.watch
      ? `👀 Отметил: ${v.watch.toLowerCase()}. В день премьеры напомню ${destinationText(i.user.id)}.`
      : before?.watch
        ? `Убрал тебя из ждущих.${mark.remind ? ' Личное напоминание осталось.' : ''}`
        : '';
    if (text) await i.followUp({ content: text, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
}

/** Обновить счётчик и список «Ждут» на публичной карточке */
async function updateCard(i: any, source: Source, id: string) {
  const who = watchers(source, id);
  const v = VERB[source];
  const embed = EmbedBuilder.from(i.message.embeds[0]);
  const fields = (embed.data.fields ?? []).filter((f) => !f.name.startsWith('👀'));
  if (who.length) fields.push({ name: `👀 Ждут с сервера: ${who.length}`, value: whoText(who) });
  embed.setFields(fields);
  const rows = i.message.components.map((row: any) => {
    const r = ActionRowBuilder.from<ButtonBuilder>(row);
    for (const c of r.components) {
      const cid = (c.data as any).custom_id;
      if (cid === `watch:w:${source}:${id}`) c.setLabel(who.length ? `${v.watch} · ${who.length}` : v.watch);
    }
    return r;
  });
  await i.update({ embeds: [embed, ...i.message.embeds.slice(1)], components: rows });
}

// ───────────────────────── /premieres ─────────────────────────

function myPremieres(userId: string) {
  const rows = db
    .prepare(
      `SELECT m.source, m.id, m.watch, m.remind, w.title, w.date, w.approx FROM watch_marks m
       LEFT JOIN watch_items w ON w.source = m.source AND w.id = m.id
       WHERE m.user_id = ? ORDER BY COALESCE(w.date, '9999') LIMIT 25`,
    )
    .all(userId) as { source: Source; id: string; watch: number; remind: number; title: string | null; date: string | null; approx: number }[];
  const icon: Record<Source, string> = { shiki: '🍥', igdb: '🎮', tmdbm: '🎬', tmdbt: '📺' };
  const mode = modeOf(userId);
  const e = new EmbedBuilder()
    .setColor(config.color)
    .setTitle('🔔 Мои премьеры')
    .setDescription(
      rows.length
        ? rows
            .map((r) => `${icon[r.source]} ${truncate(r.title ?? 'Загружается…', 60)} — ${dateText(r.date, !!r.approx, false)}${r.watch ? ' · 👀' : ' · 🔔'}`)
            .join('\n')
        : 'Пока пусто. Отмечайся кнопками «👀 Буду смотреть» и «🔔 Напомнить» на карточках анонсов или в меню под календарями.',
    )
    .addFields({
      name: 'Куда присылать напоминания',
      value:
        mode === 'thread'
          ? remindersChannel()
            ? `В личную ветку на сервере (<#${remindersChannel()}>). Ветку видишь только ты и админы.`
            : 'В личную ветку на сервере — но канал для веток ещё не назначен, поэтому пока в ЛС.'
          : 'В личные сообщения от бота.',
    })
    .setFooter({ text: '👀 — ты в списке ждущих (видно всем) • 🔔 — личное напоминание • в день премьеры в 10:00 по Киеву' });

  const components: any[] = [];
  if (rows.length) {
    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('watch:mine')
          .setPlaceholder('Открыть премьеру…')
          .addOptions(rows.map((r) => ({ label: truncate(r.title ?? `${r.source} ${r.id}`, 100), description: truncate(dateText(r.date, !!r.approx, false), 100), value: `${r.source}:${r.id}`, emoji: icon[r.source] }))),
      ),
    );
  }
  components.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('watch:mode:thread')
        .setLabel('В ветку на сервере')
        .setEmoji('🧵')
        .setStyle(mode === 'thread' ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('watch:mode:dm')
        .setLabel('В личные сообщения')
        .setEmoji('📬')
        .setStyle(mode === 'dm' ? ButtonStyle.Success : ButtonStyle.Secondary),
    ),
  );
  return { embeds: [e], components };
}

export async function onCommand(i: ChatInputCommandInteraction) {
  return i.reply({ ...myPremieres(i.user.id), flags: MessageFlags.Ephemeral });
}

// ───────────────────────── отправка напоминаний ─────────────────────────

type NoticeKind = 'today' | 'released' | 'moved' | 'dated';

function reminderPayload(info: PremiereInfo, kind: NoticeKind, forUser: string | null, oldDate?: { date: string | null; approx: boolean }) {
  const game = info.source === 'igdb';
  const head: Record<NoticeKind, string> = {
    today: game ? '🔔 Релиз сегодня' : '🔔 Премьера сегодня',
    released: game ? '🔔 Игра уже вышла' : '🔔 Уже вышло',
    moved: game ? '📅 Релиз перенесли' : '📅 Премьеру перенесли',
    dated: game ? '📅 Объявили дату релиза' : '📅 Объявили дату премьеры',
  };
  const e = infoEmbed(info).setAuthor({ name: `${head[kind]} · ${info.kindLabel}` });
  if (kind === 'moved' || kind === 'dated') {
    e.setDescription(
      [
        kind === 'moved' ? `Было: ${dateText(oldDate?.date ?? null, oldDate?.approx, false)}\nСтало: **${dateText(info.date, info.approx)}**` : `**${dateText(info.date, info.approx)}**`,
        '',
        'Отметка сохраняется — напомню в новый день.',
      ].join('\n'),
    );
    if (info.thumb) e.setThumbnail(info.thumb);
  } else {
    const when =
      kind === 'today' && info.airAt && new Date(info.airAt * 1000).toISOString().slice(0, 10) <= addDays(kyivNow().date, 1)
        ? `сегодня, <t:${info.airAt}:t> (<t:${info.airAt}:R>)`
        : kind === 'today'
          ? 'сегодня'
          : `уже вышло${info.date ? ` — ${dateText(info.date, info.approx, false)}` : ''}`;
    e.addFields({ name: game ? 'Релиз' : 'Выход', value: when, inline: true }, ...info.fields);
    if (info.image) e.setImage(info.image);
    else if (info.thumb) e.setThumbnail(info.thumb);
  }
  const others = watchers(info.source, info.id).filter((id) => id !== forUser);
  if (others.length && kind !== 'moved' && kind !== 'dated') e.addFields({ name: forUser ? 'С тобой ждали' : 'Ждали', value: whoText(others) });
  e.setFooter({ text: 'Tortuga Duck • отметка «Буду смотреть» или «Напомнить»' });

  const row = new ActionRowBuilder<ButtonBuilder>();
  if (kind === 'today' || kind === 'released') {
    row.addComponents(new ButtonBuilder().setCustomId(`trailer:${info.source}:${info.id}`).setLabel('Трейлер').setEmoji('▶️').setStyle(ButtonStyle.Secondary));
  }
  row.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(info.link.url).setLabel(info.link.label));
  const announce = getSetting(ANNOUNCE_CHANNEL[info.source]);
  if (announce) {
    row.addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(`https://discord.com/channels/${config.guildId}/${announce}`).setLabel('Обсудить на сервере').setEmoji('💬'),
    );
  }
  row.addComponents(new ButtonBuilder().setCustomId(`watch:off:${info.source}:${info.id}`).setLabel('Не напоминать').setEmoji('🔕').setStyle(ButtonStyle.Secondary));
  return { embeds: [e], components: [row] };
}

/** Личная приватная ветка для напоминаний (создаётся один раз) */
async function userThread(client: Client, userId: string): Promise<any | null> {
  const parentId = remindersChannel();
  if (!parentId) return null;
  const savedId = getSetting(`remind.thread.${userId}`);
  if (savedId) {
    const t: any = await client.channels.fetch(savedId).catch(() => null);
    if (t?.isThread?.() && t.parentId === parentId) {
      if (t.archived) await t.setArchived(false).catch(() => {});
      return t;
    }
  }
  const parent: any = await client.channels.fetch(parentId).catch(() => null);
  if (!parent || parent.type !== ChannelType.GuildText) return null;
  const guild = await client.guilds.fetch(config.guildId);
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return null;
  const thread = await parent.threads.create({
    name: truncate(`🔔 Напоминания — ${member.displayName}`, 100),
    type: ChannelType.PrivateThread,
    invitable: false,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
    reason: 'Личные напоминания о премьерах',
  });
  await thread.members.add(userId);
  await thread
    .send(`Привет, <@${userId}>! Сюда буду присылать напоминания о премьерах, которые ты ждёшь. Эту ветку видишь только ты (и админы сервера). Настройки — \`/premieres\`.`)
    .catch(() => {});
  setSetting(`remind.thread.${userId}`, thread.id);
  return thread;
}

/** Доставляет напоминание одному человеку. Возвращает false, если не удалось ни в ветку, ни в ЛС. */
async function deliver(client: Client, userId: string, payload: any): Promise<boolean> {
  if (modeOf(userId) === 'thread') {
    try {
      const t = await userThread(client, userId);
      if (t) {
        await t.send({ content: `<@${userId}>`, ...payload, allowedMentions: { users: [userId] } });
        return true;
      }
    } catch (e) {
      console.warn(`[watch] Ветка для ${userId}:`, (e as Error).message);
    }
  }
  try {
    const user = await client.users.fetch(userId);
    await user.send(payload);
    return true;
  } catch {
    return false;
  }
}

async function notifyAll(client: Client, info: PremiereInfo, kind: NoticeKind, oldDate?: { date: string | null; approx: boolean }) {
  const users = marksOf(info.source, info.id).map((m) => m.user_id);
  const failed: string[] = [];
  for (const uid of users) {
    const ok = await deliver(client, uid, reminderPayload(info, kind, uid, oldDate));
    if (!ok) failed.push(uid);
    await new Promise((r) => setTimeout(r, 300));
  }
  // Запасной вариант: одно общее сообщение в канале анонсов (его удалит чистка через сутки)
  if (failed.length) {
    const channelId = getSetting(ANNOUNCE_CHANNEL[info.source]);
    const channel: any = channelId ? await client.channels.fetch(channelId).catch(() => null) : null;
    if (channel?.send) {
      await channel
        .send({
          content: `${failed.map((id) => `<@${id}>`).join(' ')}, ${kind === 'today' || kind === 'released' ? 'премьера, которую вы ждали:' : 'новости о премьере, которую вы ждёте:'}`,
          ...reminderPayload(info, kind, null, oldDate),
          allowedMentions: { users: failed },
        })
        .catch((e: Error) => console.warn('[watch] Запасное напоминание:', e.message));
    }
  }
  console.log(`[watch] ${kind}: «${info.title}» — ${users.length - failed.length} лично, ${failed.length} в канале`);
}

let dailyBusy = false;

/** Ежедневная проверка: сверяем даты, шлём напоминания и уведомления о переносе */
async function runDaily(client: Client) {
  if (dailyBusy) return;
  dailyBusy = true;
  try {
    const today = kyivNow().date;
    const items = db.prepare('SELECT DISTINCT source, id FROM watch_marks').all() as { source: Source; id: string }[];
    for (const { source, id } of items) {
      try {
        const info = await premiereInfo(source, id, true);
        await new Promise((r) => setTimeout(r, 600)); // бережно к лимитам API
        if (!info) continue;
        let stored = storedItem(source, id);
        if (!stored) {
          rememberItem(info, true);
          stored = storedItem(source, id)!;
        }
        const set = (field: 'reminded', value: string | null) =>
          db.prepare(`UPDATE watch_items SET ${field} = ? WHERE source = ? AND id = ?`).run(value, source, id);

        // Давно прошедшие премьеры — снимаем отметки через 30 дней после напоминания
        if (stored.reminded && stored.reminded < addDays(today, -30)) {
          db.prepare('DELETE FROM watch_marks WHERE source = ? AND id = ?').run(source, id);
          db.prepare('DELETE FROM watch_items WHERE source = ? AND id = ?').run(source, id);
          refreshCalendarSoon(source);
          continue;
        }
        if (stored.reminded) continue;

        // Дата изменилась (до напоминания)
        const exactNow = !!info.date && !info.approx;
        if (exactNow && info.date !== stored.date && info.date !== today && !(info.released && info.date! < today)) {
          const old = { date: stored.date, approx: !!stored.approx };
          if (stored.date && !stored.approx) await notifyAll(client, info, 'moved', old);
          else await notifyAll(client, info, 'dated', old);
        }
        rememberItem(info, true);

        // Напоминание
        if (exactNow && info.date === today) {
          await notifyAll(client, info, 'today');
          set('reminded', today);
        } else if (info.released) {
          // Вышло без точной даты, или бот был выключен в день премьеры (до 3 дней) — напоминаем «уже вышло»
          if (!exactNow || info.date! >= addDays(today, -3)) await notifyAll(client, info, 'released');
          set('reminded', today);
        }
      } catch (e) {
        console.warn(`[watch] Проверка ${source}:${id}:`, (e as Error).message);
      }
    }
  } finally {
    dailyBusy = false;
  }
}

export function setup(client: Client) {
  const tick = () => {
    const { date, hour } = kyivNow();
    if (hour < REMIND_HOUR || getSetting('watch.daily_run') === date) return;
    setSetting('watch.daily_run', date);
    void runDaily(client).catch((e) => console.warn('[watch] Ежедневная проверка:', (e as Error).message));
  };
  client.once(Events.ClientReady, () => setTimeout(tick, 60_000));
  setInterval(tick, 10 * 60_000);
}
