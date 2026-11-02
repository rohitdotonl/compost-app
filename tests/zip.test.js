// The STORE-only zip writer, read back with an independent parser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, makeZip } from '../public/zip.js';
import { noteNames, obsidianNote, obsidianZip } from '../public/export.js';

function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder();
  const eocd = bytes.length - 22;
  assert.equal(view.getUint32(eocd, true), 0x06054b50);
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const files = [];
  for (let n = 0; n < count; n++) {
    assert.equal(view.getUint32(at, true), 0x02014b50);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const offset = view.getUint32(at + 42, true);
    const name = dec.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    assert.equal(view.getUint32(offset, true), 0x04034b50);
    assert.equal(view.getUint16(offset + 8, true), 0, 'stored');
    assert.equal(view.getUint32(offset + 14, true), crc);
    const start = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
    files.push({ name, crc, data: bytes.subarray(start, start + size) });
    at += 46 + nameLen + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return files;
}

test('crc32 matches known values', () => {
  const enc = new TextEncoder();
  assert.equal(crc32(enc.encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array()), 0);
  assert.equal(crc32(enc.encode('The quick brown fox jumps over the lazy dog')), 0x414fa339);
});

test('makeZip writes files a reader can parse back, with matching CRCs', () => {
  const files = [
    { name: 'a.md', data: 'hello' },
    { name: 'folder/ünïcode note.md', data: '---\nurl: "x"\n---\nTakeaway ✓\n' },
    { name: 'empty.txt', data: '' },
    { name: 'bin', data: new Uint8Array([0, 1, 2, 255]) },
  ];
  const back = readZip(makeZip(files, new Date(2026, 9, 25, 12, 30)));
  assert.deepEqual(back.map((f) => f.name), files.map((f) => f.name));
  for (let i = 0; i < files.length; i++) {
    const want = typeof files[i].data === 'string' ? new TextEncoder().encode(files[i].data) : files[i].data;
    assert.deepEqual([...back[i].data], [...want]);
    assert.equal(back[i].crc, crc32(back[i].data));
  }
});

test('the Obsidian export is one note per Vault item with frontmatter', () => {
  const vault = [
    { id: 1, url: 'https://a.test/x', title: 'A: "quoted" / title?', site: 'a.test', saved_at: Date.UTC(2026, 9, 1), ended_at: Date.UTC(2026, 9, 3), intent: 'weekend', takeaway: 'Keep it.' },
    { id: 2, url: 'https://b.test/', title: 'A: "quoted" / title?', site: 'b.test', saved_at: Date.UTC(2026, 9, 2), ended_at: Date.UTC(2026, 9, 4), intent: null, takeaway: null },
  ];
  assert.deepEqual(noteNames(vault), ['A quoted title.md', 'A quoted title 2.md']);
  assert.equal(
    obsidianNote(vault[0]),
    '---\nurl: "https://a.test/x"\nsite: "a.test"\nsaved: 2026-10-01\nfinished: 2026-10-03\nintent: "weekend"\n---\n\nKeep it.\n'
  );
  const files = readZip(obsidianZip(vault));
  assert.equal(files.length, 2);
  assert.ok(files[1].name.endsWith('/A quoted title 2.md'));
  assert.match(new TextDecoder().decode(files[1].data), /intent: null\n---\n\n$/);
});
