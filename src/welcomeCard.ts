/**
 * «Клубная карта Тортуги» — приветственная карточка в виде банковской карты.
 * Только API Canvas 2D, без зависимостей: тот же код рисует и в боте (@napi-rs/canvas), и в браузере (для превью).
 *
 *  • имя владельца выдавлено, как на настоящих картах (без цифр);
 *  • печать клуба справа (гильош-розетка и тиснёная «T»);
 *  • аватар с точкой «в сети/не активен/не беспокоить»;
 *  • облачко со статусом профиля — как в профиле Discord.
 */

export const CARD_W = 1060;
export const CARD_H = 690;

// Сама карта внутри холста (поля — для тени)
const PAD = 26;
const W = CARD_W - PAD * 2;
const H = CARD_H - PAD * 2;

type Ctx = any; // CanvasRenderingContext2D (браузер) или SKRSContext2D (@napi-rs/canvas)
type Img = any;

export interface CardData {
  name: string;
  avatar: Img | null;
  /** Основной цвет карты (#rrggbb): цвет профиля или средний цвет аватарки */
  color: string;
  presence: 'online' | 'idle' | 'dnd' | 'offline' | null;
  status: { text: string; emoji: Img | null } | null;
  font: string;
}

// ───────────────────────── цвета ─────────────────────────

function rgb(hex: string) {
  const n = parseInt(hex.replace('#', '').padEnd(6, '0').slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const;
}
function mix(hex: string, to: [number, number, number], k: number) {
  const [r, g, b] = rgb(hex);
  return `rgb(${Math.round(r + (to[0] - r) * k)},${Math.round(g + (to[1] - g) * k)},${Math.round(b + (to[2] - b) * k)})`;
}
const darker = (hex: string, k: number) => mix(hex, [8, 6, 10], k);
const lighter = (hex: string, k: number) => mix(hex, [255, 255, 255], k);

/** Слишком светлые и слишком серые цвета карте не идут — подтягиваем насыщенность и яркость */
export function normalizeCardColor(hex: string): string {
  let [r, g, b] = rgb(hex).map((x) => x / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  const l0 = (max + min) / 2;
  const d = max - min;
  let s = d === 0 ? 0 : d / (1 - Math.abs(2 * l0 - 1));
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  // Почти серый цвет → фирменный янтарь Тортуги
  if (s < 0.18) return '#c98a2b';
  s = Math.min(0.85, Math.max(0.45, s));
  const l = Math.min(0.5, Math.max(0.32, l0));
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [rr, gg, bb] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const to = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${to(rr)}${to(gg)}${to(bb)}`;
}

// ───────────────────────── примитивы ─────────────────────────

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Текст с разрядкой (letterSpacing есть не везде — рисуем по буквам) */
function spaced(ctx: Ctx, text: string, x: number, y: number, spacing: number) {
  let cx = x;
  for (const ch of [...text]) {
    ctx.fillText(ch, cx, y);
    cx += ctx.measureText(ch).width + spacing;
  }
  return cx - x - spacing;
}
function spacedWidth(ctx: Ctx, text: string, spacing: number) {
  return [...text].reduce((w, ch) => w + ctx.measureText(ch).width + spacing, -spacing);
}

/** Выдавленный текст, как имя на банковской карте */
function embossed(ctx: Ctx, text: string, x: number, y: number, spacing: number) {
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  spaced(ctx, text, x + 2, y + 3, spacing);
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  spaced(ctx, text, x - 1, y - 1, spacing);
  const g = ctx.createLinearGradient(0, y - 50, 0, y + 6);
  g.addColorStop(0, '#fbf6ea');
  g.addColorStop(1, '#d8cfbd');
  ctx.fillStyle = g;
  spaced(ctx, text, x, y, spacing);
}

/** Переносит текст по словам, не больше maxLines строк (последняя — с «…») */
function wrap(ctx: Ctx, text: string, maxW: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(next).width <= maxW) cur = next;
    else {
      if (cur) lines.push(cur);
      cur = w;
      if (lines.length === maxLines) break;
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (lines.length > maxLines) lines.length = maxLines;
  const usedAll = lines.join(' ').length >= words.join(' ').length;
  let last = lines[lines.length - 1] ?? '';
  // Слишком длинное одно слово — режем по буквам
  while (last && ctx.measureText(last + (usedAll ? '' : '…')).width > maxW) last = last.slice(0, -1);
  if (lines.length) lines[lines.length - 1] = usedAll ? last : `${last.trimEnd()}…`;
  return lines;
}

// ───────────────────────── эмблема-утка ─────────────────────────

/**
 * Печать клуба справа: гильош-розетка, кольцо с надписью по кругу и большая буква «T» с тиснением.
 * (cx, cy) — центр, r — радиус.
 */
function drawSeal(ctx: Ctx, cx: number, cy: number, r: number, font: string) {
  ctx.save();
  // Розетка: много повёрнутых эллипсов тонкой линией
  ctx.lineWidth = 1.3;
  for (let k = 0; k < 36; k++) {
    ctx.strokeStyle = `rgba(255,255,255,${k % 2 ? 0.07 : 0.11})`;
    ctx.beginPath();
    ctx.ellipse(cx, cy, r * 0.98, r * 0.42, (Math.PI / 36) * k, 0, Math.PI * 2);
    ctx.stroke();
  }
  // Кольца
  for (const [rr, a, w] of [
    [r * 0.74, 0.35, 3],
    [r * 0.56, 0.28, 2],
  ] as const) {
    ctx.strokeStyle = `rgba(255,255,255,${a})`;
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.arc(cx, cy, rr, 0, Math.PI * 2);
    ctx.stroke();
  }
  // Подложка под букву
  const inner = ctx.createRadialGradient(cx - r * 0.15, cy - r * 0.2, r * 0.05, cx, cy, r * 0.56);
  inner.addColorStop(0, 'rgba(255,255,255,0.18)');
  inner.addColorStop(1, 'rgba(0,0,0,0.22)');
  ctx.fillStyle = inner;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.55, 0, Math.PI * 2);
  ctx.fill();

  // Надпись по кругу между кольцами
  const text = 'TORTUGA CLUB  •  ДОБРО ПОЖАЛОВАТЬ  •  ';
  ctx.font = `${Math.round(r * 0.085)}px ${font}`;
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const chars = [...text];
  const rt = r * 0.65;
  chars.forEach((ch, k) => {
    const ang = -Math.PI / 2 + (k / chars.length) * Math.PI * 2;
    ctx.save();
    ctx.translate(cx + Math.cos(ang) * rt, cy + Math.sin(ang) * rt);
    ctx.rotate(ang + Math.PI / 2);
    ctx.fillText(ch, 0, 0);
    ctx.restore();
  });

  // Большая «T» с тиснением
  ctx.font = `${Math.round(r * 0.72)}px ${font}`;
  const ty = cy + r * 0.04;
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillText('T', cx + 3, ty + 4);
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.fillText('T', cx - 1.5, ty - 1.5);
  const g = ctx.createLinearGradient(0, cy - r * 0.35, 0, cy + r * 0.35);
  g.addColorStop(0, '#fff3d0');
  g.addColorStop(0.5, '#f2c35a');
  g.addColorStop(1, '#b8801f');
  ctx.fillStyle = g;
  ctx.fillText('T', cx, ty);
  ctx.restore();
}

// ───────────────────────── карта ─────────────────────────

export function drawClubCard(ctx: Ctx, d: CardData) {
  const base = d.color;
  const x0 = PAD;
  const y0 = PAD;
  ctx.clearRect(0, 0, CARD_W, CARD_H);

  // Тень и форма карты
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 28;
  ctx.shadowOffsetY = 10;
  roundRect(ctx, x0, y0, W, H, 38);
  ctx.fillStyle = darker(base, 0.55);
  ctx.fill();
  ctx.restore();

  ctx.save();
  roundRect(ctx, x0, y0, W, H, 38);
  ctx.clip();

  // Основной градиент
  const g = ctx.createLinearGradient(x0, y0, x0 + W, y0 + H);
  g.addColorStop(0, lighter(base, 0.12));
  g.addColorStop(0.45, base);
  g.addColorStop(1, darker(base, 0.72));
  ctx.fillStyle = g;
  ctx.fillRect(x0, y0, W, H);

  // Гильош — тонкие волны, как на банкнотах
  ctx.lineWidth = 1.2;
  for (let k = 0; k < 26; k++) {
    ctx.strokeStyle = `rgba(255,255,255,${0.035 + (k % 3) * 0.012})`;
    ctx.beginPath();
    for (let px = 0; px <= W; px += 8) {
      const py = y0 + H * 0.15 + k * 18 + Math.sin(px / 70 + k * 0.45) * 22 + Math.sin(px / 23 + k) * 4;
      if (px === 0) ctx.moveTo(x0 + px, py);
      else ctx.lineTo(x0 + px, py);
    }
    ctx.stroke();
  }

  // «Голограмма» — диагональная полоса света
  const sheen = ctx.createLinearGradient(x0 + W * 0.15, y0, x0 + W * 0.75, y0 + H);
  sheen.addColorStop(0, 'rgba(255,255,255,0)');
  sheen.addColorStop(0.42, 'rgba(255,255,255,0.0)');
  sheen.addColorStop(0.5, 'rgba(255,255,255,0.13)');
  sheen.addColorStop(0.58, 'rgba(255,255,255,0.0)');
  sheen.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = sheen;
  ctx.fillRect(x0, y0, W, H);

  // Печать клуба справа
  const sealR = H * 0.32;
  drawSeal(ctx, x0 + W - sealR - 44, y0 + H / 2 + 14, sealR, d.font);
  /** Левая граница печати — облачко статуса до неё не доходит */
  const sealLeft = x0 + W - sealR * 2 - 44;

  // Затемнение слева, чтобы текст читался поверх любой утки
  const fade = ctx.createLinearGradient(x0, 0, x0 + W * 0.62, 0);
  fade.addColorStop(0, 'rgba(0,0,0,0.28)');
  fade.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = fade;
  ctx.fillRect(x0, y0, W, H);

  // Логотип
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.font = `46px ${d.font}`;
  ctx.textBaseline = 'alphabetic';
  spaced(ctx, 'TORTUGA', x0 + 56, y0 + 92, 9);
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = `20px ${d.font}`;
  spaced(ctx, 'CLUB  ·  ПОСТОЯННЫЙ ГОСТЬ', x0 + 58, y0 + 126, 4);

  // Аватар
  const av = 150;
  const ax = x0 + 56;
  const ay = y0 + 170;
  const acx = ax + av / 2;
  const acy = ay + av / 2;
  ctx.save();
  ctx.beginPath();
  ctx.arc(acx, acy, av / 2 + 6, 0, Math.PI * 2);
  ctx.fillStyle = darker(base, 0.35);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(acx, acy, av / 2, 0, Math.PI * 2);
  ctx.clip();
  if (d.avatar) ctx.drawImage(d.avatar, ax, ay, av, av);
  else {
    ctx.fillStyle = lighter(base, 0.3);
    ctx.fillRect(ax, ay, av, av);
  }
  ctx.restore();

  // Точка присутствия (как в профиле)
  if (d.presence) {
    const colors = { online: '#23a55a', idle: '#f0b232', dnd: '#f23f43', offline: '#80848e' };
    const px = acx + av * 0.36;
    const py = acy + av * 0.36;
    ctx.beginPath();
    ctx.arc(px, py, 22, 0, Math.PI * 2);
    ctx.fillStyle = darker(base, 0.35);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(px, py, 15, 0, Math.PI * 2);
    ctx.fillStyle = colors[d.presence];
    ctx.fill();
    if (d.presence === 'idle') {
      ctx.beginPath();
      ctx.arc(px - 7, py - 7, 10, 0, Math.PI * 2);
      ctx.fillStyle = darker(base, 0.35);
      ctx.fill();
    } else if (d.presence === 'dnd') {
      ctx.fillStyle = darker(base, 0.35);
      roundRect(ctx, px - 9, py - 3, 18, 6, 3);
      ctx.fill();
    } else if (d.presence === 'offline') {
      ctx.beginPath();
      ctx.arc(px, py, 7, 0, Math.PI * 2);
      ctx.fillStyle = darker(base, 0.35);
      ctx.fill();
    }
  }

  // Облачко со статусом — справа от аватара, как в профиле
  if (d.status && (d.status.text || d.status.emoji)) {
    ctx.font = `25px ${d.font}`;
    const bx = ax + av + 34;
    const by = ay - 6;
    const emojiSize = 34;
    const textX = bx + 22 + (d.status.emoji ? emojiSize + 12 : 0);
    const maxTextW = Math.max(200, Math.min(420, sealLeft - textX - 44));
    const lines = d.status.text ? wrap(ctx, d.status.text, maxTextW, 4) : [];
    const textW = Math.max(0, ...lines.map((l) => ctx.measureText(l).width));
    const bw = textX - bx + textW + 24;
    const bh = Math.max(emojiSize + 26, lines.length * 32 + 26);

    // «Пузырьки» к аватару
    ctx.fillStyle = 'rgba(15,12,20,0.55)';
    for (const [cx, cy, r] of [
      [ax + av + 6, ay + 34, 8],
      [ax + av + 20, ay + 18, 12],
    ] as const) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    }
    roundRect(ctx, bx, by, bw, bh, 22);
    ctx.fill();
    if (d.status.emoji) ctx.drawImage(d.status.emoji, bx + 20, by + (bh - emojiSize) / 2, emojiSize, emojiSize);
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    lines.forEach((l, k) => ctx.fillText(l, textX, by + 13 + 25 + k * 32 + (bh - 26 - lines.length * 32) / 2));
  }

  // Чип
  const chx = x0 + 60;
  const chy = y0 + 372;
  const chip = ctx.createLinearGradient(chx, chy, chx + 92, chy + 70);
  chip.addColorStop(0, '#f9e29a');
  chip.addColorStop(0.5, '#d6a948');
  chip.addColorStop(1, '#a7781f');
  ctx.fillStyle = chip;
  roundRect(ctx, chx, chy, 92, 70, 12);
  ctx.fill();
  ctx.strokeStyle = 'rgba(90,60,10,0.55)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(chx + 30, chy);
  ctx.lineTo(chx + 30, chy + 70);
  ctx.moveTo(chx + 62, chy);
  ctx.lineTo(chx + 62, chy + 70);
  ctx.moveTo(chx, chy + 35);
  ctx.lineTo(chx + 30, chy + 35);
  ctx.moveTo(chx + 62, chy + 35);
  ctx.lineTo(chx + 92, chy + 35);
  ctx.stroke();
  roundRect(ctx, chx + 30, chy + 18, 32, 34, 6);
  ctx.stroke();

  // Значок бесконтактной оплаты
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  for (let k = 0; k < 3; k++) {
    ctx.beginPath();
    ctx.arc(chx + 118, chy + 35, 10 + k * 9, -Math.PI / 3.2, Math.PI / 3.2);
    ctx.stroke();
  }

  // Имя владельца — выдавленными буквами
  const name = d.name.toLocaleUpperCase('ru-RU');
  const maxNameW = W * 0.58;
  let size = 54;
  let spacing = 5;
  for (;;) {
    ctx.font = `${size}px ${d.font}`;
    if (spacedWidth(ctx, name, spacing) <= maxNameW || size <= 26) break;
    size -= 2;
    spacing = Math.max(1, spacing - 0.3);
  }
  let shown = name;
  while (spacedWidth(ctx, shown, spacing) > maxNameW && shown.length > 1) shown = shown.slice(0, -1);
  if (shown !== name) shown = `${shown.slice(0, -1)}…`;
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = `17px ${d.font}`;
  spaced(ctx, 'ВЛАДЕЛЕЦ КАРТЫ', x0 + 60, y0 + H - 106, 3);
  ctx.font = `${size}px ${d.font}`;
  embossed(ctx, shown, x0 + 58, y0 + H - 50, spacing);

  ctx.restore();

  // Тонкая кромка
  ctx.save();
  roundRect(ctx, x0 + 0.5, y0 + 0.5, W - 1, H - 1, 38);
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}
