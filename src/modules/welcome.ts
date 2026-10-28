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
  const embed = baseEmbed()
    .setDescription(phrase)
    .setImage('attachment://welcome.png')
    .setFooter({ text: `Посетитель №${member.guild.memberCount}` });
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

async function renderCard(member: GuildMember, title: string): Promise<Buffer> {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Фон: картинка из assets/welcome/ или янтарный градиент
  const bgPath = pickRandom(listImages(path.join(config.assetsDir, 'welcome')));
  if (bgPath) {
    const bg = await loadImage(fs.readFileSync(bgPath));
    const scale = Math.max(W / bg.width, H / bg.height);
    ctx.drawImage(bg, (W - bg.width * scale) / 2, (H - bg.height * scale) / 2, bg.width * scale, bg.height * scale);
  } else {
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#3b2410');
    g.addColorStop(0.55, '#7a4a17');
    g.addColorStop(1, '#e8a33d');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  // Затемнённая плашка
  ctx.fillStyle = 'rgba(15, 10, 5, 0.55)';
  roundRect(ctx, 24, 24, W - 48, H - 48, 28);
  ctx.fill();

  // Аватар в кружке
  const avatarSize = 210;
  const ax = 70;
  const ay = (H - avatarSize) / 2;
  try {
    const avatar = await loadImage(member.displayAvatarURL({ extension: 'png', size: 256 }));
    ctx.save();
    ctx.beginPath();
    ctx.arc(ax + avatarSize / 2, ay + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(avatar, ax, ay, avatarSize, avatarSize);
    ctx.restore();
  } catch {
    /* без аватара — не страшно */
  }
  ctx.strokeStyle = '#e8a33d';
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.arc(ax + avatarSize / 2, ay + avatarSize / 2, avatarSize / 2 + 4, 0, Math.PI * 2);
  ctx.stroke();

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
  const tx = ax + avatarSize + 50;
  const maxW = textRight - tx;
  ctx.fillStyle = '#f7d9a8';
  fitText(ctx, title, maxW, 40);
  ctx.fillText(title, tx, H / 2 - 40);

  ctx.fillStyle = '#ffffff';
  const name = member.displayName;
  fitText(ctx, name, maxW, 64, 28);
  ctx.fillText(name, tx, H / 2 + 35);

  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = `26px ${FONT}`;
  ctx.fillText(`Посетитель №${member.guild.memberCount}`, tx, H / 2 + 90);

  return canvas.encode('png');
}
