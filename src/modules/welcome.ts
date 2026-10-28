import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, GlobalFonts, loadImage, type SKRSContext2D } from '@napi-rs/canvas';
import {
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

interface WelcomeConfig {
  title: string;
  phrases: string[];
}

const W = 1100;
const H = 420;
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
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
];

export function setup(client: Client) {
  client.on(Events.GuildMemberAdd, async (member) => {
    if (member.user.bot) return;
    await giveBaseRole(member);
    await sendWelcome(member).catch((e) => console.error('[welcome] Ошибка:', e));
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
  const payload = await buildWelcome(i.member);
  return i.editReply(payload);
}

async function sendWelcome(member: GuildMember) {
  const channelId = getSetting('channel.welcome');
  if (!channelId) return;
  const channel = await member.guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased() || !('send' in channel)) return;
  await channel.send(await buildWelcome(member));
}

async function buildWelcome(member: GuildMember) {
  const cfg = readConfigJson<WelcomeConfig>('welcome.json', {
    title: 'Добро пожаловать в Тортугу!',
    phrases: ['{user} заходит в бар. Утка за стойкой уже наливает 🍺'],
  });
  const phrase = (pickRandom(cfg.phrases) ?? '').replaceAll('{user}', `<@${member.id}>`).replaceAll('{name}', member.displayName);
  const card = await renderCard(member, cfg.title);
  const file = new AttachmentBuilder(card, { name: 'welcome.png' });
  const accent = (await member.user.fetch(true).catch(() => member.user)).accentColor;
  const embed = baseEmbed()
    .setDescription(phrase)
    .setImage('attachment://welcome.png')
    .setFooter({ text: `Посетитель №${member.guild.memberCount}` });
  if (accent) embed.setColor(accent);
  return { content: `<@${member.id}>`, embeds: [embed], files: [file] };
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

function roundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function fitText(ctx: SKRSContext2D, text: string, maxWidth: number, startSize: number, minSize = 20) {
  let size = startSize;
  do {
    ctx.font = `${size}px ${FONT}`;
    if (ctx.measureText(text).width <= maxWidth) break;
    size -= 2;
  } while (size > minSize);
  return size;
}

/** Значки профиля Discord (публичные флаги) → подпись и цвет плашки */
const BADGES: Record<string, [string, string]> = {
  Staff: ['Сотрудник Discord', '#5865F2'],
  Partner: ['Партнёр Discord', '#5865F2'],
  Hypesquad: ['HypeSquad Events', '#F47B67'],
  BugHunterLevel1: ['Охотник за багами', '#3BA55C'],
  BugHunterLevel2: ['Охотник за багами II', '#F1C40F'],
  HypeSquadOnlineHouse1: ['HypeSquad Bravery', '#9C84EF'],
  HypeSquadOnlineHouse2: ['HypeSquad Brilliance', '#F47B67'],
  HypeSquadOnlineHouse3: ['HypeSquad Balance', '#45DDC0'],
  PremiumEarlySupporter: ['Ранний сторонник', '#EB459E'],
  VerifiedDeveloper: ['Разработчик ботов', '#5865F2'],
  CertifiedModerator: ['Модератор Discord', '#5865F2'],
  ActiveDeveloper: ['Активный разработчик', '#23A55A'],
};

function hexToRgb(hex: string) {
  const n = parseInt(hex.replace('#', ''), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** Рисует «пилюли» (плашки с текстом) в строку, переносит на следующую строку при нехватке места */
function drawPills(ctx: SKRSContext2D, pills: { text: string; color?: string }[], x: number, y: number, maxW: number) {
  ctx.font = `22px ${FONT}`;
  const h = 36;
  let cx = x;
  let cy = y;
  for (const p of pills) {
    const dot = p.color ? 18 : 0;
    const w = ctx.measureText(p.text).width + 28 + dot;
    if (cx + w > x + maxW && cx > x) {
      cx = x;
      cy += h + 10;
    }
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    roundRect(ctx, cx, cy, w, h, h / 2);
    ctx.fill();
    if (p.color) {
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(cx + 18, cy + h / 2, 6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillText(p.text, cx + 14 + dot, cy + 25);
    cx += w + 10;
  }
}

async function renderCard(member: GuildMember, title: string): Promise<Buffer> {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Полный профиль: баннер, цвет профиля, значки
  const user: any = await member.user.fetch(true).catch(() => member.user);
  const accent: string = user.hexAccentColor ?? '#e8a33d';

  // Фон: баннер профиля → картинка из assets/welcome/ → градиент цвета профиля
  let drewBg = false;
  const bannerUrl: string | null = user.bannerURL?.({ extension: 'png', size: 1024 }) ?? null;
  const bgPath = pickRandom(listImages(path.join(config.assetsDir, 'welcome')));
  for (const src of [bannerUrl, bgPath]) {
    if (!src || drewBg) continue;
    try {
      const bg = await loadImage(src.startsWith('http') ? src : fs.readFileSync(src));
      const scale = Math.max(W / bg.width, H / bg.height);
      ctx.drawImage(bg, (W - bg.width * scale) / 2, (H - bg.height * scale) / 2, bg.width * scale, bg.height * scale);
      drewBg = true;
    } catch {
      /* попробуем следующий вариант */
    }
  }
  if (!drewBg) {
    const { r, g: gg, b } = hexToRgb(accent);
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#1a1208');
    g.addColorStop(0.5, `rgba(${r},${gg},${b},0.55)`);
    g.addColorStop(1, accent);
    ctx.fillStyle = '#1a1208';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  // Затемнённая плашка
  ctx.fillStyle = 'rgba(12, 8, 4, 0.62)';
  roundRect(ctx, 24, 24, W - 48, H - 48, 28);
  ctx.fill();

  // Аватар в кружке + рамка цвета профиля
  const avatarSize = 200;
  const ax = 75;
  const ay = (H - avatarSize) / 2;
  const cx = ax + avatarSize / 2;
  const cy = ay + avatarSize / 2;
  try {
    const avatar = await loadImage(member.displayAvatarURL({ extension: 'png', size: 256 }));
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, avatarSize / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(avatar, ax, ay, avatarSize, avatarSize);
    ctx.restore();
  } catch {
    /* без аватара — не страшно */
  }

  // Украшение аватарки из магазина Discord, если есть — рисуем поверх вместо обычной рамки
  let decorated = false;
  const decoUrl: string | null =
    typeof user.avatarDecorationURL === 'function' ? user.avatarDecorationURL({ size: 256 }) : null;
  if (decoUrl) {
    try {
      const deco = await loadImage(decoUrl);
      const ds = avatarSize * 1.2;
      ctx.drawImage(deco, cx - ds / 2, cy - ds / 2, ds, ds);
      decorated = true;
    } catch {
      /* без украшения */
    }
  }
  if (!decorated) {
    ctx.strokeStyle = accent;
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.arc(cx, cy, avatarSize / 2 + 4, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Утка справа (случайная из assets/ducks/)
  const duckPath = pickRandom(listImages(path.join(config.assetsDir, 'ducks')));
  let textRight = W - 60;
  if (duckPath) {
    try {
      const duck = await loadImage(fs.readFileSync(duckPath));
      const dh = 300;
      const dw = (duck.width / duck.height) * dh;
      const dx = W - 50 - dw;
      ctx.drawImage(duck, dx, (H - dh) / 2, dw, dh);
      textRight = dx - 20;
    } catch (e) {
      console.warn('[welcome] Не удалось загрузить утку', duckPath, (e as Error).message);
    }
  }

  // Текст
  const tx = ax + avatarSize + 55;
  const maxW = textRight - tx;
  ctx.fillStyle = '#f7d9a8';
  fitText(ctx, title, maxW, 36);
  ctx.fillText(title, tx, 120);

  ctx.fillStyle = '#ffffff';
  const name = member.displayName;
  fitText(ctx, name, maxW, 60, 28);
  ctx.fillText(name, tx, 188);

  // Плашки: номер, возраст аккаунта, значки профиля
  const pills: { text: string; color?: string }[] = [
    { text: `Посетитель №${member.guild.memberCount}` },
    { text: `В Discord с ${member.user.createdAt.getFullYear()}` },
  ];
  const flags: string[] = user.flags?.toArray?.() ?? [];
  for (const f of flags) {
    const b = BADGES[f];
    if (b) pills.push({ text: b[0], color: b[1] });
  }
  drawPills(ctx, pills, tx, 222, maxW);

  return canvas.encode('png');
}
