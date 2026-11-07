import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Защита от SSRF: бот (и Lavalink по ссылке из /play) не должен ходить во внутреннюю сеть —
 * в контейнеры Docker (rsshub, lavalink, spotify-tokener), на localhost и в сервис метаданных Oracle (169.254.169.254).
 * Ссылки на радиостанции приходят из открытого каталога, их может добавить кто угодно, поэтому проверяем всё.
 */

function privateV4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local, метаданные облака
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function privateV6(ip: string): boolean {
  const x = ip.toLowerCase();
  if (x === '::' || x === '::1') return true;
  const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return privateV4(mapped[1]);
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(x);
}

export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return privateV4(ip);
  if (v === 6) return privateV6(ip);
  return true;
}

/** Возвращает текст ошибки или null, если адрес публичный и его можно открывать. */
export async function checkPublicUrl(raw: string): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'некорректная ссылка';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'поддерживаются только ссылки http и https';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return isPrivateIp(host) ? 'ссылка ведёт во внутреннюю сеть' : null;
  if (!host.includes('.') || /\.(local|internal|localhost)$/i.test(host) || host === 'localhost') return 'ссылка ведёт во внутреннюю сеть';
  try {
    const addrs = await lookup(host, { all: true });
    if (!addrs.length) return 'адрес не найден';
    if (addrs.some((a) => isPrivateIp(a.address))) return 'ссылка ведёт во внутреннюю сеть';
  } catch {
    return 'адрес не найден';
  }
  return null;
}

/**
 * fetch, который проверяет каждый адрес, включая переадресации (не больше 5).
 * Остальные параметры — как у обычного fetch.
 */
export async function safeFetch(raw: string, init: RequestInit = {}, maxRedirects = 5): Promise<Response> {
  let url = raw;
  for (let k = 0; k <= maxRedirects; k++) {
    const err = await checkPublicUrl(url);
    if (err) throw new Error(err);
    const res = await fetch(url, { ...init, redirect: 'manual' });
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      await res.body?.cancel().catch(() => {});
      url = new URL(loc, url).toString();
      continue;
    }
    return res;
  }
  throw new Error('слишком много переадресаций');
}
