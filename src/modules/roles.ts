import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type Role,
} from 'discord.js';
import type { ComponentInteraction } from '../types';
import { baseEmbed, readConfigJson, respond } from '../util';

export const componentPrefix = 'roles';

interface RoleOption {
  label: string;
  /** Название роли на сервере. Если такой роли нет — бот создаст её сам. */
  role: string;
  emoji?: string;
  description?: string;
}
interface RoleGroup {
  id: string;
  title: string;
  description?: string;
  /** true — можно выбрать несколько, false — только один вариант */
  multi?: boolean;
  options: RoleOption[];
}
interface RolesConfig {
  panelTitle?: string;
  panelText?: string;
  groups: RoleGroup[];
}

const loadConfig = () => readConfigJson<RolesConfig>('roles.json', { groups: [] });

export const commands = [new SlashCommandBuilder().setName('roles').setDescription('Выбрать свои роли')];

export async function onCommand(i: ChatInputCommandInteraction) {
  if (!i.inCachedGuild()) return;
  return respond(i, menusFor(i.member));
}

/** Панель в канале выбора ролей: одна кнопка, по ней — личное меню с уже отмеченными ролями. */
export async function postRolesPanel(guild: Guild, channelId: string) {
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased() || !('send' in channel)) return;
  const cfg = loadConfig();
  const embed = baseEmbed()
    .setTitle(cfg.panelTitle ?? '🎭 Выбери свои роли')
    .setDescription(
      [
        cfg.panelText ?? 'Отметь, что тебе интересно — и увидишь нужные каналы.',
        '',
        ...cfg.groups.map((g) => `**${g.title}** — ${g.options.map((o) => `${o.emoji ?? ''} ${o.label}`.trim()).join(', ')}`),
      ].join('\n'),
    );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('roles:open').setLabel('Настроить мои роли').setEmoji('⚙️').setStyle(ButtonStyle.Primary),
  );
  await channel.send({ embeds: [embed], components: [row] });
}

function menusFor(member: GuildMember) {
  const cfg = loadConfig();
  if (!cfg.groups.length) return { content: '⚠️ Роли ещё не настроены (config/roles.json).' };

  const rows = cfg.groups.slice(0, 5).map((g) => {
    const opts = g.options.slice(0, 25).map((o) => {
      const role = member.guild.roles.cache.find((r) => r.name === o.role);
      const opt = new StringSelectMenuOptionBuilder()
        .setLabel(o.label)
        .setValue(o.role)
        .setDefault(!!role && member.roles.cache.has(role.id));
      if (o.emoji) opt.setEmoji(o.emoji);
      if (o.description) opt.setDescription(o.description.slice(0, 100));
      return opt;
    });
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`roles:group:${g.id}`)
      .setPlaceholder(g.title)
      .setMinValues(0)
      .setMaxValues(g.multi === false ? 1 : opts.length)
      .addOptions(opts);
    return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
  });
  return {
    content: '🎭 Отметь нужное в каждом списке — роли обновятся сразу. Чтобы снять всё, убери все галочки.',
    components: rows,
  };
}

async function ensureRole(guild: Guild, name: string): Promise<Role | null> {
  const existing = guild.roles.cache.find((r) => r.name === name);
  if (existing) return existing;
  try {
    return await guild.roles.create({ name, mentionable: false, reason: 'Роль из чеклиста Tortuga Duck' });
  } catch (e) {
    console.warn(`[roles] Не удалось создать роль «${name}»:`, (e as Error).message);
    return null;
  }
}

export async function onComponent(i: ComponentInteraction) {
  if (!i.inCachedGuild()) return;

  if (i.isButton() && i.customId === 'roles:open') {
    return respond(i, menusFor(i.member));
  }

  if (!i.isStringSelectMenu()) return;
  const groupId = i.customId.split(':')[2];
  const group = loadConfig().groups.find((g) => g.id === groupId);
  if (!group) return respond(i, '⚠️ Эта группа ролей больше не существует.');

  await i.deferUpdate();
  const selected = new Set(i.values);
  const added: string[] = [];
  const removed: string[] = [];

  for (const opt of group.options) {
    const role = await ensureRole(i.guild, opt.role);
    if (!role) continue;
    const has = i.member.roles.cache.has(role.id);
    try {
      if (selected.has(opt.role) && !has) {
        await i.member.roles.add(role, 'Выбор в чеклисте');
        added.push(opt.label);
      } else if (!selected.has(opt.role) && has) {
        await i.member.roles.remove(role, 'Выбор в чеклисте');
        removed.push(opt.label);
      }
    } catch (e) {
      console.warn(`[roles] Не удалось изменить роль «${opt.role}»:`, (e as Error).message);
    }
  }

  const parts = [];
  if (added.length) parts.push(`✅ Добавлено: ${added.join(', ')}`);
  if (removed.length) parts.push(`➖ Убрано: ${removed.join(', ')}`);
  await i.followUp({ content: parts.join('\n') || '👌 Без изменений.', flags: MessageFlags.Ephemeral });
}
