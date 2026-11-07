import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import {
  ActivityType,
  AttachmentBuilder,
  Events,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Client,
  type GuildMember,
} from 'discord.js';
import { config } from '../config';
import { getSetting } from '../db';
import { baseEmbed, pickRandom, readConfigJson, respond } from '../util';
import { CARD_H, CARD_W, drawClubCard, normalizeCardColor } from '../welcomeCard';

interface WelcomeConfig {
  title: string;
  phrases: string[];
}

const IMG_EXT = /\.(png|jpe?g|webp|gif)$/i;

// Шрифт с кириллицей (в Docker ставится пакет fonts-dejavu-core)
const FONT = (() => {
  const candidates = [
    path.join(config.assetsDir, 'fonts', 'title.ttf'),
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  ];
  for (const f of candidates) {
    if (fs.existsSync(f)) {
      GlobalFonts.registerFromPath(f, 'TortugaFont');
      return 'TortugaFont';
    }
  }
  return 'sans-serif';
})();

export const commands = [
  new SlashCommandBuilder()
    .setName('welcome-test')
    .setDescription('Показать, как выглядит приветствие (для админов)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addBooleanOption((o) =>
      o.setName('send').setDescription('Отправить по-настоящему в канал приветствий (проверка всего пути)'),
    ),
];

export function setup(client: Client) {
  client.on(Events.GuildMemberAdd, async (member) => {
    if (member.user.bot) return;
    console.log(`[welcome] Новый участник: ${member.user.tag}`);
    await giveBaseRole(member);
    const result = await sendWelcome(member).catch((e) => `ошибка: ${e?.message ?? e}`);
    console.log(`[welcome] Приветствие для ${member.user.tag}: ${result}`);
  });
}

async function giveBaseRole(member: GuildMember) {
  const roleId = getSetting('role.base');
  if (!roleId) return;
  await member.roles.add(roleId, 'Базовая роль').catch((e) => console.warn('[welcome] Не удалось выдать базовую роль:', e?.message));
}

export async function onCommand(i: ChatInputCommandInteraction) {
  if (!i.inCachedGuild()) return;
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  // send:true — пройти весь путь как при настоящем входе: отправить в канал приветствий
  if (i.options.getBoolean('send')) {
    const result = await sendWelcome(i.member).catch((e) => `ошибка: ${e?.message ?? e}`);
    return i.editReply(result === 'отправлено' ? '✅ Приветствие отправлено в канал приветствий.' : `❌ Не отправилось: ${result}`);
  }
  return i.editReply(await buildWelcome(i.member));
}

/** Отправляет приветствие в канал. Возвращает «отправлено» или причину, почему нет. */
async function sendWelcome(member: GuildMember): Promise<string> {
  const channelId = getSetting('channel.welcome');
  if (!channelId) return 'канал приветствий не назначен (/setup channel → Приветствия новичков)';
  const channel = await member.guild.channels.fetch(channelId).catch((e) => {
    console.warn('[welcome] Не открыть канал:', e?.message);
    return null;
  });
  if (!channel) return `бот не видит канал ${channelId} — нет доступа или канал удалён`;
  if (!channel.isTextBased() || !('send' in channel)) return 'это не текстовый канал';

  const me = member.guild.members.me;
  const perms = me ? channel.permissionsFor(me) : null;
  const missing = (['ViewChannel', 'SendMessages', 'EmbedLinks', 'AttachFiles'] as const).filter((p) => !perms?.has(p));
  if (missing.length) return `в канале не хватает прав у бота: ${missing.join(', ')}`;

  await channel.send(await buildWelcome(member));
  return 'отправлено';
}

async function buildWelcome(member: GuildMember) {
  const cfg = readConfigJson<WelcomeConfig>('welcome.json', {
    title: 'Добро пожаловать в Тортугу!',
    phrases: ['{user} заходит в бар. Утка за стойкой уже наливает 🍺'],
  });
  const phrase = (pickRandom(cfg.phrases) ?? '').replaceAll('{user}', `<@${member.id}>`).replaceAll('{name}', member.displayName);
  // Полный профиль (баннер, цвет, значки) запрашиваем один раз — и для текста, и для карточки
  const user: any = await member.user.fetch(true).catch(() => member.user);
  const accent = user.accentColor;
  const embed = baseEmbed().setDescription(phrase);
  if (accent) embed.setColor(accent);

  // Если карточка не нарисовалась — всё равно приветствуем, просто без картинки
  try {
    const card = await renderCard(member, user);
    embed.setImage('attachment://welcome.png');
    return { content: `<@${member.id}>`, embeds: [embed], files: [new AttachmentBuilder(card, { name: 'welcome.png' })] };
  } catch (e) {
    console.warn('[welcome] Карточка не нарисовалась, отправляю без неё:', (e as Error).message);
    embed.setThumbnail(member.displayAvatarURL({ size: 256 }));
    return { content: `<@${member.id}>`, embeds: [embed], files: [] };
  }
}

function listImages(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => IMG_EXT.test(f))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/** Картинка по ссылке с таймаутом — чтобы медленный CDN не подвесил приветствие */
async function remoteImage(url: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return loadImage(Buffer.from(await res.arrayBuffer()));
}

/** Средний цвет аватарки — если у человека не задан цвет профиля */
function averageColor(img: any): string | null {
  try {
    const c = createCanvas(8, 8);
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0, 8, 8);
    const data = x.getImageData(0, 0, 8, 8).data;
    let r = 0;
    let g = 0;
    let b = 0;
    for (let k = 0; k < data.length; k += 4) {
      r += data[k];
      g += data[k + 1];
      b += data[k + 2];
    }
    const n = data.length / 4;
    const hex = (v: number) => Math.round(v / n).toString(16).padStart(2, '0');
    return `#${hex(r)}${hex(g)}${hex(b)}`;
  } catch {
    return null;
  }
}

/** Эмодзи и прочие символы, которых нет в шрифте карточки (иначе будут квадратики) */
const stripEmoji = (t: string) =>
  t
    .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\u{1F3FB}-\u{1F3FF}️‍⃣]/gu, '')
    .replace(/<a?:\w+:\d+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Картинка эмодзи статуса: своё эмодзи сервера — с CDN Discord, обычное — Twemoji */
async function statusEmoji(emoji: any): Promise<any | null> {
  if (!emoji) return null;
  try {
    if (emoji.id) return await remoteImage(`https://cdn.discordapp.com/emojis/${emoji.id}.png?size=96`);
    const ch: string = emoji.name ?? '';
    if (!ch) return null;
    let cps = [...ch].map((c) => c.codePointAt(0)!.toString(16));
    if (!cps.includes('200d')) cps = cps.filter((c) => c !== 'fe0f');
    return await remoteImage(`https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72/${cps.join('-')}.png`);
  } catch {
    return null;
  }
}

/**
 * Статус «как в профиле» на момент входа. Нужен Presence Intent (PRESENCE_INTENT=true в .env
 * и переключатель в Developer Portal). Сразу после входа Discord присылает статус не мгновенно — ждём до 4 секунд.
 */
async function presenceOf(member: GuildMember) {
  if (process.env.PRESENCE_INTENT !== 'true') return null;
  for (let k = 0; k < 8; k++) {
    const p = member.guild.presences.cache.get(member.id) ?? member.presence;
    if (p) return p;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

async function renderCard(member: GuildMember, user: any): Promise<Buffer> {
  const canvas = createCanvas(CARD_W, CARD_H);
  const ctx = canvas.getContext('2d');

  const avatar = await remoteImage(member.displayAvatarURL({ extension: 'png', size: 256 })).catch(() => null);

  const presence = await presenceOf(member);
  const custom = presence?.activities?.find((a: any) => a.type === ActivityType.Custom);
  const statusText = stripEmoji(custom?.state ?? '');
  const emojiImg = await statusEmoji(custom?.emoji);

  const color = normalizeCardColor(user.hexAccentColor ?? (avatar && averageColor(avatar)) ?? '#c98a2b');
  drawClubCard(ctx, {
    name: stripEmoji(member.displayName) || member.user.username,
    avatar,
    color,
    presence: (presence?.status as any) ?? null,
    status: statusText || emojiImg ? { text: statusText, emoji: emojiImg } : null,
    font: FONT,
  });
  return canvas.encode('png');
}
