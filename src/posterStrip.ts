/**
 * Полоса постеров фильмов для хронологии: постеры по порядку, номер как в списке,
 * под каждым — название и год. Основная история — золотая рамка.
 * Только API Canvas 2D: тот же код рисует в боте (@napi-rs/canvas) и в браузере (для превью).
 */

type Ctx = any;
type Img = any;

export interface StripItem {
  n: number;
  /** Подпись под постером (уже без общего начала серии) */
  title: string;
  year: string;
  main: boolean;
  img: Img | null;
}

const PAD = 18;
const PW = 150; // постер
const PH = 225;
const GAP = 16;
const TEXT_H = 92;
/** Discord ужимает картинку в embed до ~500 px по ширине — больше 4 постеров в ряд будет не разобрать */
export const COLS_MAX = 4;

export function stripSize(count: number) {
  const cols = Math.min(COLS_MAX, Math.max(1, count));
  const rows = Math.ceil(count / cols);
  return { w: PAD * 2 + cols * PW + (cols - 1) * GAP, h: PAD * 2 + rows * (PH + TEXT_H) + (rows - 1) * GAP, cols };
}

function rr(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Не больше трёх строк, последняя — с «…» */
function lines2(ctx: Ctx, text: string, maxW: number, max = 3): string[] {
  const words = text.split(/\s+/);
  const out: string[] = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(t).width <= maxW) cur = t;
    else {
      out.push(cur || w);
      cur = cur ? w : '';
      if (out.length === max) break;
    }
  }
  if (cur && out.length < max) out.push(cur);
  const all = out.join(' ').length >= text.length;
  if (out.length === max && !all) {
    let l = out[max - 1];
    while (l && ctx.measureText(`${l}…`).width > maxW) l = l.slice(0, -1);
    out[max - 1] = `${l.trimEnd().replace(/[.,:;—-]+$/, "")}…`;
  }
  return out.map((l) => {
    let x = l;
    while (x.length > 1 && ctx.measureText(x).width > maxW) x = x.slice(0, -1);
    return x === l ? l : `${x}…`;
  });
}

export function drawPosterStrip(ctx: Ctx, items: StripItem[], font: string) {
  const { w, h, cols } = stripSize(items.length);
  ctx.clearRect(0, 0, w, h);
  rr(ctx, 0, 0, w, h, 18);
  ctx.fillStyle = '#1e1f24';
  ctx.fill();

  items.forEach((it, k) => {
    const col = k % cols;
    const row = Math.floor(k / cols);
    const x = PAD + col * (PW + GAP);
    const y = PAD + row * (PH + TEXT_H + GAP);

    // Постер
    ctx.save();
    rr(ctx, x, y, PW, PH, 10);
    ctx.clip();
    if (it.img) {
      // заполняем 2:3 с обрезкой лишнего
      const k2 = Math.max(PW / it.img.width, PH / it.img.height);
      const iw = it.img.width * k2;
      const ih = it.img.height * k2;
      ctx.drawImage(it.img, x + (PW - iw) / 2, y + (PH - ih) / 2, iw, ih);
    } else {
      const g = ctx.createLinearGradient(x, y, x + PW, y + PH);
      g.addColorStop(0, '#3a3c45');
      g.addColorStop(1, '#25262c');
      ctx.fillStyle = g;
      ctx.fillRect(x, y, PW, PH);
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.font = `15px ${font}`;
      ctx.textAlign = 'center';
      lines2(ctx, it.title, PW - 20).forEach((l, j) => ctx.fillText(l, x + PW / 2, y + PH / 2 - 10 + j * 20));
      ctx.textAlign = 'left';
    }
    // затемнение сверху под номер
    const top = ctx.createLinearGradient(0, y, 0, y + 60);
    top.addColorStop(0, 'rgba(0,0,0,0.55)');
    top.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = top;
    ctx.fillRect(x, y, PW, 60);
    ctx.restore();

    // Рамка: основная история — золотая
    rr(ctx, x + 1, y + 1, PW - 2, PH - 2, 10);
    ctx.lineWidth = it.main ? 3 : 1.5;
    ctx.strokeStyle = it.main ? '#f2c35a' : 'rgba(255,255,255,0.18)';
    ctx.stroke();

    // Номер
    ctx.beginPath();
    ctx.arc(x + 22, y + 22, 16, 0, Math.PI * 2);
    ctx.fillStyle = it.main ? '#f2c35a' : '#7f77dd';
    ctx.fill();
    ctx.fillStyle = it.main ? '#2a1d05' : '#ffffff';
    ctx.font = `${it.n >= 10 ? 15 : 17}px ${font}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(it.n), x + 22, y + 23);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    // Название и год
    ctx.font = `17px ${font}`;
    ctx.fillStyle = '#f2f3f5';
    const ls = lines2(ctx, it.title, PW);
    ls.forEach((l, j) => ctx.fillText(l, x, y + PH + 22 + j * 21));
    ctx.fillStyle = '#9a9ca5';
    ctx.font = `15px ${font}`;
    ctx.fillText(it.year, x, y + PH + 24 + ls.length * 21);
  });
}
