/**
 * HTML -> Markdown. Port of bsvault/htmlmd.py (BeautifulSoup) onto DOMParser:
 * inline() renders in-flow content, block() renders structure.
 */

const TEXT = 3;
const ELEMENT = 1;

function tag(node: Node): string {
  return (node as Element).tagName.toLowerCase();
}

function inlineNodes(nodes: Iterable<Node>): string {
  let out = '';
  for (const node of nodes) {
    if (node.nodeType === TEXT) out += (node.nodeValue || '').replace(/\s+/g, ' ');
    else if (node.nodeType === ELEMENT) out += inlineTag(node as Element);
  }
  return out;
}

function inline(el: Node): string {
  return inlineNodes(Array.from(el.childNodes));
}

function inlineTag(node: Element): string {
  const name = tag(node);
  if (name === 'a') {
    const href = (node.getAttribute('href') || '').trim();
    const text = inline(node).trim().replace(/\[/g, '(').replace(/\]/g, ')');
    return href && text ? `[${text}](${href})` : text || href;
  }
  if (name === 'b' || name === 'strong') return `**${inline(node).trim()}**`;
  if (name === 'i' || name === 'em') return `_${inline(node).trim()}_`;
  if (name === 'code') return `\`${inline(node).trim()}\``;
  if (name === 'br') return '\n';
  if (name === 'img') return `![${node.getAttribute('alt') || ''}](${node.getAttribute('src') || ''})`;
  return inline(node);
}

const INLINE = new Set([
  'a', 'b', 'strong', 'i', 'em', 'code', 'br', 'img', 'span', 'font', 'u', 'sub', 'sup',
  'small', 'mark', 's', 'del', 'ins', 'abbr', 'label', 'q', 'cite', 'kbd', 'var', 'samp',
  'time', 'tt', 'big', 'strike',
]);
const BLOCKS =
  'h1,h2,h3,h4,h5,h6,p,ul,ol,pre,table,blockquote,hr,div,section,article,header,footer,main,iframe';
const IGNORED = new Set(['button', 'input', 'select', 'textarea', 'form', 'noscript', 'template']);

function isInline(node: Node): boolean {
  if (node.nodeType === TEXT) return true;
  if (node.nodeType !== ELEMENT) return false;
  const el = node as Element;
  return INLINE.has(tag(el)) && !el.querySelector(BLOCKS);
}

/**
 * Render a child list: runs of inline nodes become one paragraph (this is
 * what lxml's implicit <p> wrapping gave the Python version), block
 * elements are rendered on their own.
 */
function blockChildren(parent: Node, out: string[]): void {
  let run: Node[] = [];
  const flush = () => {
    const text = inlineNodes(run).trim();
    if (text) out.push(text);
    run = [];
  };
  for (const child of Array.from(parent.childNodes)) {
    if (isInline(child)) run.push(child);
    else if (child.nodeType === ELEMENT) {
      flush();
      block(child, out);
    }
  }
  flush();
}

function block(el: Node, out: string[]): void {
  if (el.nodeType !== ELEMENT) return;
  const node = el as Element;
  const name = tag(node);
  if (IGNORED.has(name)) return;
  if (/^h[1-6]$/.test(name)) {
    out.push(`${'#'.repeat(Math.min(6, Number(name[1]) + 1))} ${inline(node).trim()}`);
  } else if (name === 'p') {
    const text = inline(node).trim();
    if (text) out.push(text);
  } else if (name === 'ul' || name === 'ol') {
    blockList(node, out);
  } else if (name === 'pre') {
    out.push('```\n' + (node.textContent || '') + '\n```');
  } else if (name === 'table') {
    blockTable(node, out);
  } else if (name === 'blockquote') {
    const text = inline(node).trim();
    if (text) for (const line of text.split('\n')) out.push('> ' + line);
  } else if (name === 'hr') {
    out.push('---');
  } else if (name === 'iframe') {
    // players/embeds are not content, but keep a link to them
    const src = (node.getAttribute('src') || '').trim();
    if (src) out.push(`[embedded content](${src})`);
  } else {
    // div/section/figure/... and inline tags that wrap block content
    blockChildren(node, out);
  }
}

function blockList(el: Element, out: string[]): void {
  const ordered = tag(el) === 'ol';
  let i = 0;
  for (const li of Array.from(el.children)) {
    if (tag(li) !== 'li') continue;
    i++;
    const chunks: Node[] = [];
    const nested: Element[] = [];
    for (const child of Array.from(li.childNodes)) {
      if (child.nodeType === ELEMENT && (tag(child) === 'ul' || tag(child) === 'ol')) {
        nested.push(child as Element);
      } else chunks.push(child);
    }
    out.push(`${ordered ? `${i}.` : '-'} ${inlineNodes(chunks).trim()}`);
    for (const sub of nested) {
      const lines: string[] = [];
      block(sub, lines);
      for (const line of lines) out.push('  ' + line);
    }
  }
}

function blockTable(el: Element, out: string[]): void {
  let rows: string[][] = [];
  for (const tr of Array.from(el.querySelectorAll('tr'))) {
    const cells = Array.from(tr.querySelectorAll('th,td'), (td) => inline(td).trim());
    if (cells.some(Boolean)) rows.push(cells);
  }
  if (!rows.length) return;
  const width = Math.max(...rows.map((r) => r.length));
  rows = rows.map((r) => [...r, ...Array(width - r.length).fill('')]);
  out.push('| ' + rows[0].join(' | ') + ' |');
  out.push('| ' + Array(width).fill('---').join(' | ') + ' |');
  for (const row of rows.slice(1)) out.push('| ' + row.join(' | ') + ' |');
}

/** Convert an HTML fragment to Markdown (scripts/styles dropped). */
export function htmlToMd(html: string | null | undefined): string {
  const doc = new DOMParser().parseFromString(html || '', 'text/html');
  doc.querySelectorAll('script,style').forEach((n) => n.remove());
  const out: string[] = [];
  blockChildren(doc.body || doc.documentElement, out);
  const md = out
    .map((line) => line.replace(/\s+$/, ''))
    .filter(Boolean)
    .join('\n\n');
  return md.replace(/\n{3,}/g, '\n\n').trim();
}
