// Vault exports, built in the browser: Markdown, JSON with everything, and an
// Obsidian-friendly zip of one note per Vault item. The builders are pure;
// download() is the only part that touches the page. Highlights (Phase 5)
// are fetched when an export is asked for, so the item list stays light;
// builders take them as a map of item id → highlights.
import { S } from './strings.js';
import { api, el } from './api.js';
import { isoDate } from './format.js';
import { makeZip } from './zip.js';

export function vaultMarkdown(vault, now = Date.now(), highlights = {}) {
  const lines = [`# ${S.vaultFileTitle}`, '', S.vaultFileExported(isoDate(now)), ''];
  for (const item of vault) {
    const title = item.title.replace(/([\\[\]])/g, '\\$1');
    lines.push(`## [${title}](${item.url.replace(/\)/g, '%29')})`, '', `${item.site} · ${ended(item)}`, '');
    if (item.takeaway) lines.push(`> ${item.takeaway}`, '');
    lines.push(...highlightLines(highlights[item.id]));
  }
  return lines.join('\n');
}

function ended(item) {
  return item.outcome === 'kept' ? S.keptUnfinished : S.finishedOn(isoDate(item.ended_at));
}

// `- “quote” (★ for the takeaway) — note`, under a small heading.
function highlightLines(list, heading = `**${S.exportHighlights}**`) {
  if (!list || !list.length) return [];
  const line = (h) => `- “${h.quote}”${h.starred ? ' ★' : ''}${h.note ? ` — ${h.note}` : ''}`;
  return [heading, '', ...list.map(line), ''];
}

export function dataJson(data) {
  return JSON.stringify(data, null, 2);
}

// One note per item: YAML frontmatter, then the takeaway.
export function obsidianNote(item, highlights = []) {
  const q = (v) => (v == null ? 'null' : JSON.stringify(String(v))); // JSON strings are valid YAML
  const front = [
    '---',
    `url: ${q(item.url)}`,
    `site: ${q(item.site)}`,
    `saved: ${item.saved_at ? isoDate(item.saved_at) : 'null'}`,
    `finished: ${item.ended_at ? isoDate(item.ended_at) : 'null'}`,
    `intent: ${q(item.intent)}`,
    '---',
    '',
    '',
  ];
  const notes = highlightLines(highlights, `## ${S.exportHighlights}`);
  return front.join('\n') + (item.takeaway ? `${item.takeaway}\n` : '') + (notes.length ? `\n${notes.join('\n')}` : '');
}

// File names Obsidian and every OS accept, unique within the folder.
export function noteNames(vault) {
  const seen = new Map();
  return vault.map((item) => {
    let base = String(item.title || item.site || 'Untitled')
      .replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80)
      .replace(/[. ]+$/, '') || 'Untitled';
    const key = base.toLowerCase();
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    if (n > 1) base = `${base} ${n}`;
    return `${base}.md`;
  });
}

export function obsidianZip(vault, date = new Date(), highlights = {}) {
  const names = noteNames(vault);
  return makeZip(vault.map((item, i) => ({ name: `${S.exportFolder}/${names[i]}`, data: obsidianNote(item, highlights[item.id]) })), date);
}

// ---------------------------------------------------------------------------

export async function exportMarkdown(data) {
  const highlights = await vaultHighlights();
  download(vaultMarkdown(data.vault, Date.now(), highlights), 'text/markdown', `compost-vault-${isoDate(Date.now())}.md`);
}

// Everything, with each Vault item's highlights as `highlightList`.
export async function exportJson(data) {
  const highlights = await vaultHighlights();
  const vault = data.vault.map((item) => (highlights[item.id] ? { ...item, highlightList: highlights[item.id] } : item));
  download(dataJson({ ...data, vault }), 'application/json', `compost-${isoDate(Date.now())}.json`);
}

export async function exportObsidian(data) {
  const highlights = await vaultHighlights();
  download(obsidianZip(data.vault, new Date(), highlights), 'application/zip', `compost-vault-${isoDate(Date.now())}.zip`);
}

// item id → highlights. Offline, the export still goes out without them.
async function vaultHighlights() {
  const byItem = {};
  try {
    const { status, data } = await api('/api/highlights');
    if (status === 200) for (const h of data.highlights) (byItem[h.item_id] ||= []).push(h);
  } catch {}
  return byItem;
}

function download(content, type, name) {
  const a = el('a', { href: URL.createObjectURL(new Blob([content], { type })), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
