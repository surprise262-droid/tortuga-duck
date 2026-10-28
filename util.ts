import fs from 'node:fs';
import path from 'node:path';
import {
  EmbedBuilder,
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  type RepliableInteraction,
} from 'discord.js';
import { config } from './config';

export const baseEmbed = () => new EmbedBuilder().setColor(config.color);

type ReplyPayload = string | { content?: string; embeds?: any[]; components?: any[]; files?: any[] };

/** Ответ на взаимодействие, который сам разбирается: reply / editReply / followUp. */
export async function respond(i: RepliableInteraction, payload: ReplyPayload, ephemeral = true) {
  const body: any = typeof payload === 'string' ? { content: payload } : { ...payload };
  if (i.deferred) return i.editReply(body);
  if (ephemeral) body.flags = MessageFlags.Ephemeral;
  if (i.replied) return i.followUp(body);
  return i.reply(body);
}

export function isManager(member: GuildMember | null | undefined): boolean {
  return !!member?.permissions.has(PermissionFlagsBits.ManageGuild);
}

export function formatDuration(ms: number | undefined | null): string {
  if (!ms || ms < 0 || !Number.isFinite(ms)) return '0:00';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max - 1).trimEnd() + '…' : clean;
}

export function pickRandom<T>(arr: T[]): T | undefined {
  return arr.length ? arr[Math.floor(Math.random() * arr.length)] : undefined;
}

/** Читает JSON из папки config/, при ошибке — возвращает fallback и пишет в лог. */
export function readConfigJson<T>(file: string, fallback: T): T {
  const full = path.join(config.configDir, file);
  try {
    return JSON.parse(fs.readFileSync(full, 'utf8')) as T;
  } catch (e) {
    console.warn(`[config] Не удалось прочитать ${full}: ${(e as Error).message}`);
    return fallback;
  }
}

export function hexToInt(hex: string | undefined, fallback = config.color): number {
  if (!hex) return fallback;
  const n = parseInt(hex.replace('#', ''), 16);
  return Number.isFinite(n) ? n : fallback;
}
