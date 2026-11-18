// Minimal HTML templating: interpolated values are escaped unless they are
// already Html (from another html`` call) or arrays of it.

export class Html {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
}

type Part = Html | string | number | boolean | null | undefined | Part[];

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function render(p: Part): string {
  if (p === null || p === undefined || p === false || p === true) return '';
  if (p instanceof Html) return p.value;
  if (Array.isArray(p)) return p.map(render).join('');
  return esc(String(p));
}

export function html(strings: TemplateStringsArray, ...parts: Part[]): Html {
  let out = strings[0];
  for (let i = 0; i < parts.length; i++) out += render(parts[i]) + strings[i + 1];
  return new Html(out);
}

export const raw = (s: string) => new Html(s);

// --- time ------------------------------------------------------------------

const DAY = 86_400_000;
const tz = process.env.KEYCHAIN_TIMEZONE || undefined;

const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, ...opts });
const clockFmt = fmt({ hour: '2-digit', minute: '2-digit', hour12: false });
const clockSecFmt = fmt({ hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const dateFmt = fmt({ day: 'numeric', month: 'short' });
const dateYearFmt = fmt({ day: 'numeric', month: 'short', year: 'numeric' });
const dayKeyFmt = fmt({ year: 'numeric', month: '2-digit', day: '2-digit' });

export const clock = (ms: number) => clockFmt.format(ms);
export const clockSec = (ms: number) => clockSecFmt.format(ms);
export const dayKey = (ms: number) => dayKeyFmt.format(ms);

export function dateText(ms: number, now = Date.now()): string {
  return new Date(ms).getFullYear() === new Date(now).getFullYear() ? dateFmt.format(ms) : dateYearFmt.format(ms);
}

export function dayLabel(ms: number, now = Date.now()): string {
  if (dayKey(ms) === dayKey(now)) return 'Today';
  if (dayKey(ms) === dayKey(now - DAY)) return 'Yesterday';
  return dateText(ms, now);
}

export function usedText(ms: number | null, now = Date.now()): string {
  if (ms === null) return 'Never used';
  const ago = now - ms;
  if (ago < 60_000) return 'Used just now';
  if (ago < 3600_000) return `Used ${Math.floor(ago / 60_000)} min ago`;
  const day = dayLabel(ms, now);
  if (day === 'Today') return `Used today ${clock(ms)}`;
  if (day === 'Yesterday') return 'Used yesterday';
  return `Used ${day}`;
}

export function expiryText(ms: number | null, now = Date.now()): string {
  if (ms === null) return 'never expires';
  const left = ms - now;
  if (left <= 0) return `expired ${dateText(ms, now)}`;
  if (left < 3600_000) return `expires in ${Math.max(1, Math.round(left / 60_000))} min`;
  if (left < DAY) return `expires in ${Math.round(left / 3600_000)} h`;
  const days = Math.round(left / DAY);
  return `expires in ${days} day${days === 1 ? '' : 's'}`;
}

export function inText(ms: number, now = Date.now()): string {
  const left = Math.max(0, ms - now);
  if (left < 60_000) return 'under a minute';
  return `${Math.ceil(left / 60_000)} min`;
}
