/** Small pure helpers: filenames, labels, hashes. Ported from bsvault/utils.py. */

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

/** Decode the HTML entities that show up in Brightspace titles. */
export function unescapeHtml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Python `s.strip(chars)`. */
export function stripChars(s: string, chars: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && chars.includes(s[a])) a++;
  while (b > a && chars.includes(s[b - 1])) b--;
  return s.slice(a, b);
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Make a string safe as a filename and wikilink target.
 * Same rules as the Python pipeline so existing vault names stay stable;
 * the only addition is a guard for Windows reserved device names.
 */
export function sanitize(name: string | null | undefined, maxlen = 110): string {
  let s = unescapeHtml(name || 'untitled').trim();
  s = s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-');
  s = s.replace(/[\[\]^#|]/g, '-');
  s = stripChars(s.replace(/\s+/g, ' '), ' .');
  s = stripChars(Array.from(s).slice(0, maxlen).join(''), ' .') || 'untitled';
  return RESERVED.test(s) ? `_${s}` : s;
}

/** Make a string safe inside a markdown table cell or link label. */
export function label(text: string | null | undefined): string {
  const s = (text || '').replace(/\|/g, '-').replace(/\s+/g, ' ').trim();
  return s.replace(/\[/g, '(').replace(/\]/g, ')');
}

/** Trim an ISO timestamp to YYYY-MM-DD. */
export function shortDate(iso: unknown): string {
  return iso ? String(iso).slice(0, 10) : '';
}

/** Lowercased extension including the dot ('' when none), like os.path.splitext. */
export function extOf(name: string): string {
  const base = name.slice(name.lastIndexOf('/') + 1);
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i).toLowerCase() : '';
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function utcStamp(d = new Date()): string {
  return d.toISOString().slice(0, 19).replace(/:/g, '-');
}

export function humanSize(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** Python-style codepoint ordering (default JS sort is UTF-16, close enough but explicit). */
export function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
