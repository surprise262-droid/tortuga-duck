import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Events,
  MessageFlags,
  ModalBuilder,
  OverwriteType,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  type Client,
  type Guild,
  type GuildMember,
  type VoiceChannel,
  type VoiceState,
} from 'discord.js';
import { config } from '../config';
import { db, getSetting } from '../db';
import type { ComponentInteraction } from '../types';
import { baseEmbed, respond } from '../util';

export const componentPrefix = 'pvc';

interface PvcRow {
  channel_id: string;
  guild_id: string;
  owner_id: string;
  created_at: number;
  empty_since: number | null;
}

/** channelId → время последних переименований (Discord даёт 2 переименования за 10 минут) */
const renameLog = new Map<string, number[]>();

const q = {
  get: (id: string) => db.prepare('SELECT * FROM private_vc WHERE channel_id = ?').get(id) as PvcRow | undefined,
  byOwner: (guildId: string, ownerId: string) =>
    db.prepare('SELECT * FROM private_vc WHERE guild_id = ? AND owner_id = ?').get(guildId, ownerId) as PvcRow | undefined,
  all: () => db.prepare('SELECT * FROM private_vc').all() as unknown as PvcRow[],
  insert: (r: PvcRow) =>
    db
      .prepare('INSERT INTO private_vc (channel_id, guild_id, owner_id, created_at, empty_since) VALUES (?, ?, ?, ?, ?)')
      .run(r.channel_id, r.guild_id, r.owner_id, r.created_at, r.empty_since),
  setOwner: (id: string, owner: string) => db.prepare('UPDATE private_vc SET owner_id = ? WHERE channel_id = ?').run(owner, id),
  setEmpty: (id: string, ts: number | null) => db.prepare('UPDATE private_vc SET empty_since = ? WHERE channel_id = ?').run(ts, id),
  remove: (id: string) => db.prepare('DELETE FROM private_vc WHERE channel_id = ?').run(id),
};

// ───────────────────────── события ─────────────────────────

export function setup(client: Client) {
  client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
    try {
      if (newState.channelId && newState.channelId !== oldState.channelId) await onJoin(newState);
      if (oldState.channelId && oldState.channelId !== newState.channelId) await onLeave(oldState);
    } catch (e) {
      console.error('[pvc] Ошибка voiceStateUpdate:', e);
    }
  });
  client.once(Events.ClientReady, () => void sweep(client));
  setInterval(() => void sweep(client), 60_000);
}

async function onJoin(state: VoiceState) {
  const member = state.member;
  if (!member || member.user.bot) return;

  if (state.channelId === getSetting('channel.vc_lobby')) {
    await createFor(member, state);
    return;
  }
  if (q.get(state.channelId!)) q.setEmpty(state.channelId!, null);
}

async function onLeave(state: VoiceState) {
  const row = q.get(state.channelId!);
  if (!row) return;
  const channel = state.channel;
  if (!channel) return;
  const humans = channel.members.filter((m) => !m.user.bot);
  if (humans.size === 0) {
    q.setEmpty(row.channel_id, Date.now());
    return;
  }
  // Владелец ушёл, а люди остались — корона переходит следующему
  if (row.owner_id === state.member?.id) {
    const heir = humans.first()!;
    await transferOwnership(channel as VoiceChannel, row.owner_id, heir.id);
  }
}

async function createFor(member: GuildMember, state: VoiceState) {
  const guild = member.guild;
  const lobby = state.channel!;

  // Уже есть свой канал — просто переносим туда
  const existing = q.byOwner(guild.id, member.id);
  if (existing) {
    const ch = await guild.channels.fetch(existing.channel_id).catch(() => null);
    if (ch?.isVoiceBased()) {
      await member.voice.setChannel(ch).catch(() => {});
      return;
    }
    q.remove(existing.channel_id);
  }

  const channel = await guild.channels.create({
    name: `🍺 ${member.displayName}`.slice(0, 100),
    type: ChannelType.GuildVoice,
    parent: lobby.parentId ?? undefined,
    bitrate: lobby.bitrate,
    reason: `Приватный канал для ${member.user.tag}`,
  });
  // Права категории наследуются автоматически, добавляем права владельцу
  await channel.permissionOverwrites.edit(member.id, { ViewChannel: true, Connect: true, Speak: true, Stream: true });

  q.insert({ channel_id: channel.id, guild_id: guild.id, owner_id: member.id, created_at: Date.now(), empty_since: null });
  await member.voice.setChannel(channel).catch(async () => {
    // Пользователь успел выйти — канал станет пустым и удалится по таймеру
    q.setEmpty(channel.id, Date.now());
  });
}

/** Раз в минуту: удаляем каналы, пустующие дольше PRIVATE_VC_IDLE_MINUTES. */
async function sweep(client: Client) {
  const idleMs = config.privateVcIdleMinutes * 60_000;
  for (const row of q.all()) {
    const guild = client.guilds.cache.get(row.guild_id);
    if (!guild) continue;
    const ch = await guild.channels.fetch(row.channel_id).catch(() => null);
    if (!ch || !ch.isVoiceBased()) {
      q.remove(row.channel_id);
      continue;
    }
    const humans = ch.members.filter((m) => !m.user.bot).size;
    if (humans > 0) {
      if (row.empty_since) q.setEmpty(row.channel_id, null);
      continue;
    }
    if (!row.empty_since) {
      q.setEmpty(row.channel_id, Date.now());
    } else if (Date.now() - row.empty_since >= idleMs) {
      await ch.delete('Приватный канал пустовал').catch(() => {});
      q.remove(row.channel_id);
      renameLog.delete(row.channel_id);
    }
  }
}

async function transferOwnership(channel: VoiceChannel, fromId: string, toId: string) {
  q.setOwner(channel.id, toId);
  await channel.permissionOverwrites.delete(fromId).catch(() => {});
  await channel.permissionOverwrites.edit(toId, { ViewChannel: true, Connect: true, Speak: true, Stream: true });
}

// ───────────────────────── панель управления ─────────────────────────

export async function postControlPanel(guild: Guild, channelId: string) {
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased() || !('send' in channel)) return;

  const embed = baseEmbed()
    .setTitle('🍺 Твой личный столик')
    .setDescription(
      [
        `Зайди в ${getSetting('channel.vc_lobby') ? `<#${getSetting('channel.vc_lobby')}>` : 'канал «Создать канал»'} — и получишь свой голосовой канал.`,
        'Настраивай его кнопками ниже (нужно сидеть в своём канале).',
        '',
        `Пустой канал удаляется через **${config.privateVcIdleMinutes} мин**.`,
        'Если владелец ушёл — права переходят следующему, а 🏴 «Забрать» позволяет взять пустующую корону.',
      ].join('\n'),
    );

  const b = (id: string, label: string, emoji: string, style = ButtonStyle.Secondary) =>
    new ButtonBuilder().setCustomId(`pvc:${id}`).setLabel(label).setEmoji(emoji).setStyle(style);

  const rows = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      b('rename', 'Название', '✏️'),
      b('limit', 'Лимит', '👥'),
      b('lock', 'Закрыть', '🔒'),
      b('unlock', 'Открыть', '🔓'),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      b('hide', 'Скрыть', '🙈'),
      b('show', 'Показать', '👁'),
      b('permit', 'Пустить', '✅', ButtonStyle.Success),
      b('kick', 'Выгнать', '🚫', ButtonStyle.Danger),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      b('transfer', 'Передать', '👑'),
      b('claim', 'Забрать', '🏴'),
      b('info', 'Статус', 'ℹ️', ButtonStyle.Primary),
    ),
  ];
  await channel.send({ embeds: [embed], components: rows });
}

/**
 * Все роли, через которые люди могут видеть/заходить в канал: @everyone, базовая роль
 * и любые роли с правами в самом канале или в его категории. Роли бота не трогаем.
 */
function roleTargets(channel: VoiceChannel): string[] {
  const guild = channel.guild;
  const botRoles = new Set(guild.members.me?.roles.cache.keys() ?? []);
  const ids = new Set<string>([guild.roles.everyone.id]);
  const base = getSetting('role.base');
  if (base) ids.add(base);
  const collect = (cache: any) => {
    for (const ow of cache?.values?.() ?? []) if (ow.type === OverwriteType.Role) ids.add(ow.id);
  };
  collect(channel.permissionOverwrites.cache);
  collect(channel.parent?.permissionOverwrites.cache);
  return [...ids].filter((id) => !botRoles.has(id) || id === guild.roles.everyone.id);
}

/** Значение права в категории для роли: true / false / null (не задано) — чтобы «открыть» вернуло как было. */
function parentValue(channel: VoiceChannel, roleId: string, perm: 'Connect' | 'ViewChannel'): boolean | null {
  const ow = channel.parent?.permissionOverwrites.cache.get(roleId);
  if (!ow) return null;
  if (ow.allow.has(perm)) return true;
  if (ow.deny.has(perm)) return false;
  return null;
}

async function restrict(channel: VoiceChannel, perm: 'Connect' | 'ViewChannel') {
  for (const id of roleTargets(channel)) await channel.permissionOverwrites.edit(id, { [perm]: false });
}

async function restore(channel: VoiceChannel, perm: 'Connect' | 'ViewChannel') {
  for (const id of roleTargets(channel)) await channel.permissionOverwrites.edit(id, { [perm]: parentValue(channel, id, perm) });
}

function statusText(channel: VoiceChannel, row: PvcRow): string {
  const everyone = channel.permissionOverwrites.cache.get(channel.guild.roles.everyone.id);
  const locked = !!everyone?.deny.has('Connect');
  const hidden = !!everyone?.deny.has('ViewChannel');
  const members = [...channel.permissionOverwrites.cache.values()].filter((o) => o.type === OverwriteType.Member && o.id !== row.owner_id);
  const allowed = members.filter((o) => o.allow.has('Connect')).map((o) => `<@${o.id}>`);
  const banned = members.filter((o) => o.deny.has('Connect')).map((o) => `<@${o.id}>`);
  return [
    `👑 Владелец: <@${row.owner_id}>`,
    `👥 Лимит: ${channel.userLimit ? channel.userLimit : 'без лимита'}`,
    `${locked ? '🔒 Закрыт' : '🔓 Открыт'} · ${hidden ? '🙈 Скрыт' : '👁 Виден всем'}`,
    `✅ Пущены: ${allowed.join(', ') || '—'}`,
    `🚫 Выгнаны: ${banned.join(', ') || '—'}`,
    '',
    '*Администраторы сервера видят и заходят в любые каналы — запреты Discord на них не действуют.*',
  ].join('\n');
}

async function ownedChannel(i: ComponentInteraction): Promise<{ channel: VoiceChannel; row: PvcRow } | string> {
  if (!i.inCachedGuild()) return 'Только на сервере.';
  const vc = i.member.voice.channel;
  const row = vc ? q.get(vc.id) : undefined;
  if (!vc || !row) return '🔊 Сначала зайди в свой приватный канал.';
  if (row.owner_id !== i.user.id && !['pvc:claim', 'pvc:info'].includes(i.customId)) return '👑 Это не твой канал — управлять им может только владелец.';
  return { channel: vc as VoiceChannel, row };
}

export async function onComponent(i: ComponentInteraction) {
  const [, action, sub] = i.customId.split(':');
  const res = await ownedChannel(i);
  if (typeof res === 'string') return i.isRepliable() ? respond(i, res) : undefined;
  const { channel, row } = res;
  const guild = channel.guild;

  // ── модалки ──
  if (i.isModalSubmit()) {
    if (action === 'renameModal') {
      const name = i.fields.getTextInputValue('name').trim().slice(0, 100);
      if (!name) return respond(i, '❌ Пустое название.');
      const now = Date.now();
      const recent = (renameLog.get(channel.id) ?? []).filter((t) => now - t < 10 * 60_000);
      if (recent.length >= 2) {
        const wait = Math.ceil((10 * 60_000 - (now - recent[0])) / 60_000);
        return respond(i, `⏳ Discord разрешает переименовать канал только 2 раза за 10 минут. Попробуй через ~${wait} мин.`);
      }
      return safely(i, async () => {
        await channel.setName(name);
        renameLog.set(channel.id, [...recent, now]);
        return `✏️ Канал теперь называется **${name}**.`;
      });
    }
    if (action === 'limitModal') {
      const raw = i.fields.getTextInputValue('limit').trim();
      const n = Number(raw === '' ? '0' : raw);
      if (!Number.isInteger(n) || n < 0 || n > 99) return respond(i, '❌ Нужно целое число от 0 до 99 (0 — без лимита).');
      return safely(i, async () => {
        await channel.edit({ userLimit: n });
        return n === 0 ? '👥 Лимит снят.' : `👥 Лимит: **${n}**.`;
      });
    }
    return;
  }

  // ── выбор пользователя ──
  if (i.isUserSelectMenu()) {
    const targetId = i.values[0];
    if (!targetId) return respond(i, 'Никто не выбран.');
    if (targetId === i.user.id) return i.update({ content: '🦆 Это ты.', components: [] });
    if (i.users.get(targetId)?.bot) return i.update({ content: '🤖 Ботов выбирать нельзя.', components: [] });
    if (sub === 'permit') {
      await channel.permissionOverwrites.edit(targetId, { ViewChannel: true, Connect: true });
      return i.update({ content: `✅ <@${targetId}> может заходить.`, components: [] });
    }
    if (sub === 'kick') {
      await channel.permissionOverwrites.edit(targetId, { Connect: false });
      const target = channel.members.get(targetId);
      if (target) await target.voice.disconnect('Выгнан владельцем приватки').catch(() => {});
      return i.update({ content: `🚫 <@${targetId}> выгнан и не сможет зайти снова.`, components: [] });
    }
    if (sub === 'transfer') {
      if (!channel.members.has(targetId)) return i.update({ content: '❌ Передать можно только тому, кто сидит в канале.', components: [] });
      await transferOwnership(channel, row.owner_id, targetId);
      return i.update({ content: `👑 Теперь канал принадлежит <@${targetId}>.`, components: [] });
    }
    return;
  }

  if (!i.isButton()) return;

  switch (action) {
    case 'rename':
      return i.showModal(
        new ModalBuilder()
          .setCustomId('pvc:renameModal')
          .setTitle('Новое название канала')
          .addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder()
                .setCustomId('name')
                .setLabel('Название')
                .setStyle(TextInputStyle.Short)
                .setMaxLength(100)
                .setValue(channel.name)
                .setRequired(true),
            ),
          ),
      );
    case 'limit':
      return i.showModal(
        new ModalBuilder()
          .setCustomId('pvc:limitModal')
          .setTitle('Лимит участников')
          .addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder()
                .setCustomId('limit')
                .setLabel('Число от 0 до 99 (0 — без лимита)')
                .setStyle(TextInputStyle.Short)
                .setMaxLength(2)
                .setValue(String(channel.userLimit ?? 0))
                .setRequired(true),
            ),
          ),
      );
    case 'lock':
      return safely(i, async () => {
        await restrict(channel, 'Connect');
        return '🔒 Канал закрыт. Зайти смогут только те, кого ты пустишь (✅). Кто уже внутри — остаётся.';
      });
    case 'unlock':
      return safely(i, async () => {
        await restore(channel, 'Connect');
        return '🔓 Канал открыт для всех.';
      });
    case 'hide':
      return safely(i, async () => {
        // Тем, кто уже сидит в канале, оставляем доступ — иначе они «потеряют» канал
        for (const m of channel.members.values()) {
          if (!m.user.bot && m.id !== row.owner_id) await channel.permissionOverwrites.edit(m.id, { ViewChannel: true, Connect: true });
        }
        await restrict(channel, 'ViewChannel');
        return '🙈 Канал скрыт из списка. Его видят только те, кто внутри, и кого ты пустишь (✅).';
      });
    case 'show':
      return safely(i, async () => {
        await restore(channel, 'ViewChannel');
        return '👁 Канал снова виден всем.';
      });
    case 'permit':
    case 'kick':
    case 'transfer': {
      const titles: Record<string, string> = {
        permit: 'Кого пустить в канал?',
        kick: 'Кого выгнать из канала?',
        transfer: 'Кому передать владение? (должен сидеть в канале)',
      };
      const menu = new UserSelectMenuBuilder().setCustomId(`pvc:select:${action}`).setPlaceholder('Выбери участника').setMaxValues(1);
      return respond(i, { content: titles[action], components: [new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(menu)] });
    }
    case 'info':
      return respond(i, { embeds: [baseEmbed().setTitle(`ℹ️ ${channel.name}`).setDescription(statusText(channel, row))] });
    case 'claim': {
      if (row.owner_id === i.user.id) return respond(i, '👑 Канал и так твой.');
      if (channel.members.has(row.owner_id)) return respond(i, '👑 Владелец ещё здесь — попроси его передать права.');
      await transferOwnership(channel, row.owner_id, i.user.id);
      return respond(i, '🏴 Теперь это твой канал.');
    }
  }
}

/**
 * Сначала отвечаем Discord «думаю…» (у нас 3 секунды), потом меняем канал.
 * Ошибки (лимиты Discord, нехватка прав) показываем пользователю понятным текстом.
 */
async function safely(i: ComponentInteraction, action: () => Promise<string>) {
  if (!i.isRepliable()) return;
  if (!i.deferred && !i.replied) await i.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    return await i.editReply(await action());
  } catch (e: any) {
    console.warn(`[pvc] Ошибка действия ${i.customId}:`, e?.message ?? e);
    let text = `⚠️ Не получилось: ${e?.message ?? 'неизвестная ошибка'}`;
    if (e?.name === 'RateLimitError' || typeof e?.timeToReset === 'number') {
      const min = Math.max(1, Math.ceil((e.timeToReset ?? 600_000) / 60_000));
      text = `⏳ Discord временно запретил менять этот канал (слишком часто). Попробуй через ~${min} мин.`;
    } else if (e?.code === 50013) {
      text = '⚠️ У бота не хватает прав в этом канале. Попроси админа проверить права роли Tortuga Duck (Управлять каналами, Управлять правами).';
    }
    return i.editReply(text);
  }
}

/** Права, которые нужны боту для приваток — для подсказки в инструкции. */
export const REQUIRED_PERMISSIONS = [
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.MoveMembers,
];
