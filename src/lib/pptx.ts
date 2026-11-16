/**
 * Slide text of a .pptx, in the layout the Python pipeline produced with
 * python-pptx: one `### Slide N` block per slide that has text, the text of
 * each top-level shape as a paragraph, tables as `a | b | c` lines.
 *
 * A .pptx is a zip of XML parts; only the slide parts are unpacked.
 */

import { strFromU8, unzipSync } from 'fflate';

const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function kids(el: Element, ns: string, name: string): Element[] {
  return Array.from(el.children).filter((c) => c.namespaceURI === ns && c.localName === name);
}

function first(el: Element, ns: string, name: string): Element | null {
  return el.getElementsByTagNameNS(ns, name)[0] ?? null;
}

/** Text of a text body: paragraphs joined by newlines, runs concatenated. */
function bodyText(txBody: Element): string {
  return kids(txBody, A, 'p')
    .map((p) => {
      let out = '';
      for (const c of Array.from(p.children)) {
        if (c.namespaceURI !== A) continue;
        if (c.localName === 'br') out += '\n';
        else if (c.localName === 'r' || c.localName === 'fld') out += first(c, A, 't')?.textContent ?? '';
      }
      return out;
    })
    .join('\n');
}

function slideTexts(xml: string): string[] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const tree = first(doc.documentElement, P, 'spTree');
  if (!tree) return [];
  const texts: string[] = [];
  // Top-level shapes only, like python-pptx's slide.shapes (groups are not opened).
  for (const shape of Array.from(tree.children)) {
    if (shape.namespaceURI !== P) continue;
    if (shape.localName === 'sp') {
      const body = kids(shape, P, 'txBody')[0];
      const text = body ? bodyText(body).trim() : '';
      if (text) texts.push(text);
    } else if (shape.localName === 'graphicFrame') {
      const table = first(shape, A, 'tbl');
      if (!table) continue;
      for (const row of kids(table, A, 'tr')) {
        const cells = kids(row, A, 'tc').map((tc) => {
          const body = kids(tc, A, 'txBody')[0];
          return body ? bodyText(body).trim() : '';
        });
        const line = cells.join(' | ').trim();
        if (line.replace(/^[| ]+|[| ]+$/g, '')) texts.push(line);
      }
    }
  }
  return texts;
}

/** Slide parts in presentation order (falls back to file-name order). */
function slideOrder(files: Record<string, Uint8Array>): string[] {
  const all = Object.keys(files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  const byNumber = (a: string, b: string) => Number(a.match(/(\d+)\.xml$/)![1]) - Number(b.match(/(\d+)\.xml$/)![1]);
  try {
    const pres = new DOMParser().parseFromString(strFromU8(files['ppt/presentation.xml']), 'application/xml');
    const rels = new DOMParser().parseFromString(strFromU8(files['ppt/_rels/presentation.xml.rels']), 'application/xml');
    const target = new Map<string, string>();
    for (const rel of Array.from(rels.getElementsByTagName('Relationship'))) {
      target.set(rel.getAttribute('Id') || '', (rel.getAttribute('Target') || '').replace(/^\/?(ppt\/)?/, 'ppt/'));
    }
    const ordered: string[] = [];
    for (const id of Array.from(pres.getElementsByTagNameNS(P, 'sldId'))) {
      const part = target.get(id.getAttributeNS(R, 'id') || '');
      if (part && files[part]) ordered.push(part);
    }
    if (ordered.length) return ordered;
  } catch {
    /* fall through */
  }
  return all.sort(byNumber);
}

export function pptxText(bytes: Uint8Array): string {
  const files = unzipSync(bytes, {
    filter: (f) => /^ppt\/(slides\/slide\d+\.xml|presentation\.xml|_rels\/presentation\.xml\.rels)$/.test(f.name),
  });
  const out: string[] = [];
  slideOrder(files).forEach((part, i) => {
    const texts = slideTexts(strFromU8(files[part]));
    if (texts.length) out.push(`### Slide ${i + 1}\n\n${texts.join('\n\n')}`);
  });
  return out.join('\n\n').trim();
}
