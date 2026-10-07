#!/usr/bin/env node
// Writes the npm archives the runtime content digest is pinned against (fixtures/upstream/clarkcant-directory/archives).
//
//   node scripts/build-content-digest-fixtures.mjs
//
// Run it only to add or change a case: the archives are committed, and `pnpm contract:sync` records ClarkCant's own
// verdict and digest for each (content-digests.json). One archive is real `npm pack` output; the others are written
// here byte by byte to reach the reader rules npm pack never exercises: files out of path order, folders, empty files,
// names whose UTF-16 order differs from code point order, pax and GNU long names, ustar prefixes, `./` segments, and
// each kind of archive ClarkCant refuses.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const archivesDir = join(root, "fixtures", "upstream", "clarkcant-directory", "archives");
const exampleWidget = join(root, "fixtures", "widgets", "example-frame-widget");

const encoder = new TextEncoder();

function put(block, offset, length, value) {
  block.set(encoder.encode(value).subarray(0, length), offset);
}

function octal(block, offset, length, value) {
  put(block, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}

/** One 512-byte ustar header. `name` and `prefix` are written as given; `magic` can be broken on purpose. */
function header({ name, prefix = "", size, type = "0", magic = "ustar\0", linkname = "" }) {
  const block = new Uint8Array(512);
  put(block, 0, 100, name);
  octal(block, 100, 8, type === "5" ? 0o755 : 0o644);
  octal(block, 108, 8, 0);
  octal(block, 116, 8, 0);
  octal(block, 124, 12, size);
  octal(block, 136, 12, 499_162_500); // 1985-10-26, as npm pack writes it
  block.fill(0x20, 148, 156);
  put(block, 156, 1, type);
  put(block, 157, 100, linkname);
  put(block, 257, 6, magic);
  put(block, 263, 2, "00");
  put(block, 345, 155, prefix);
  let sum = 0;
  for (const byte of block) sum += byte;
  put(block, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return block;
}

function bytesOf(content) {
  return typeof content === "string" ? encoder.encode(content) : (content ?? new Uint8Array());
}

/** A pax record `<len> key=value\n`, whose length counts its own digits. */
function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let length = encoder.encode(body).length + 1;
  while (String(length).length + encoder.encode(body).length !== length) length += 1;
  return `${String(length)}${body}`;
}

/**
 * Entries: `{ name, content?, type?, prefix?, magic?, pax?: {key: value}, longName?: string, sizeOverride?: number }`.
 * `pax` writes an `x` header before the entry, `longName` a GNU `L` header.
 */
function tar(entries) {
  const parts = [];
  const push = (head, content) => {
    parts.push(head);
    const padded = new Uint8Array(Math.ceil(content.length / 512) * 512);
    padded.set(content);
    parts.push(padded);
  };
  for (const entry of entries) {
    if (entry.pax) {
      const records = encoder.encode(Object.entries(entry.pax).map(([key, value]) => paxRecord(key, value)).join(""));
      push(header({ name: "PaxHeader/x", size: records.length, type: "x" }), records);
    }
    if (entry.longName !== undefined) {
      const body = encoder.encode(`${entry.longName}\0`);
      push(header({ name: "././@LongLink", size: body.length, type: "L" }), body);
    }
    const content = bytesOf(entry.content);
    push(
      header({
        name: entry.name,
        prefix: entry.prefix,
        size: entry.sizeOverride ?? content.length,
        type: entry.type,
        magic: entry.magic,
        linkname: entry.linkname,
      }),
      content,
    );
  }
  parts.push(new Uint8Array(1024));
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return gzipSync(out, { level: 9 });
}

const manifest = '{"note":"content only; the digest does not read it"}\n';
/** Bytes that are not text, larger than one block, so content spans several reads. */
const binary = Uint8Array.from({ length: 1500 }, (_, index) => (index * 31 + 7) % 256);

const CASES = {
  "unsorted-tree": [
    { name: "package/widgets/main/main.js", content: "export const main = 1;\n" },
    { name: "package/package.json", content: '{"name":"unsorted","version":"1.0.0"}\n' },
    { name: "package/widgets/", type: "5" },
    { name: "package/assets/logo.bin", content: binary },
    { name: "package/clarkcant.json", content: manifest },
    { name: "package/empty.txt", content: "" },
    { name: "package/README.md", content: "# Unsorted\n" },
    { name: "package/widgets/main/index.html", content: "<!doctype html><title>main</title>\n" },
  ],
  "utf16-order": [
    // U+1F600 is a surrogate pair (0xD83D...), which sorts before U+FF5E in UTF-16 but after it by code point.
    { name: "package/\u{1F600}.txt", content: "emoji\n" },
    { name: "package/～.txt", content: "fullwidth tilde\n" },
    { name: "package/été.txt", content: "accents\n" },
    { name: "package/Z.txt", content: "upper\n" },
    { name: "package/a.txt", content: "lower\n" },
  ],
  "long-names": [
    // `path` last: ClarkCant reads pax record lengths (bytes) as character offsets, so a multi-byte path ends the body.
    { name: "ignored-by-pax", pax: { mtime: "499162500", path: `package/${"deep/".repeat(30)}\u00e9l\u00e8ve.json` }, content: "{}\n" },
    { name: "ignored-by-longlink", longName: `package/${"long-segment-".repeat(12)}file.txt`, content: "gnu long name\n" },
    { name: "file-in-prefix.txt", prefix: "package/prefixed/folder", content: "ustar prefix\n" },
  ],
  "dot-segments": [
    { name: "package/a.txt", content: "first write\n" },
    { name: "package/./a.txt", content: "second write replaces the first\n" },
    { name: "package//double//slash.txt", content: "empty segments collapse\n" },
    { name: "package/.", type: "5" },
  ],
  "symlink-refused": [
    { name: "package/clarkcant.json", content: manifest },
    { name: "package/link", type: "2", linkname: "/etc/passwd" },
  ],
  "hardlink-refused": [
    { name: "package/clarkcant.json", content: manifest },
    { name: "package/link", type: "1", linkname: "package/clarkcant.json" },
  ],
  "traversal-refused": [{ name: "package/../escape.txt", content: "out\n" }],
  "no-magic-refused": [{ name: "package/clarkcant.json", content: manifest, magic: "\0\0\0\0\0\0" }],
  "duplicate-refused": [
    { name: "package/a.txt", content: "one\n" },
    { name: "package/a.txt", content: "two\n" },
  ],
  "file-folder-conflict-refused": [
    { name: "package/a", content: "a file\n" },
    { name: "package/a/b.txt", content: "under a file\n" },
  ],
  "contiguous-type-refused": [{ name: "package/a.txt", content: "type 7\n", type: "7" }],
  "pax-size-mismatch-refused": [{ name: "package/a.txt", content: "twelve bytes", pax: { size: "5" } }],
};

function npmPackExample(destination) {
  const output = execFileSync("npm", ["pack", "--json", "--pack-destination", destination], {
    cwd: exampleWidget,
    shell: process.platform === "win32",
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [result] = JSON.parse(output.slice(output.indexOf("[")));
  return readFileSync(join(destination, result.filename.split("/").pop()));
}

mkdirSync(archivesDir, { recursive: true });
for (const file of readdirSync(archivesDir)) rmSync(join(archivesDir, file));
for (const [name, entries] of Object.entries(CASES)) writeFileSync(join(archivesDir, `${name}.tgz`), tar(entries));
const scratch = mkdtempSync(join(tmpdir(), "content-digest-pack-"));
try {
  writeFileSync(join(archivesDir, "npm-pack-example-frame-widget.tgz"), npmPackExample(scratch));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.info(`wrote ${String(Object.keys(CASES).length + 1)} archives to ${archivesDir}`);
console.info("next: pnpm contract:sync -- --from <ClarkCant checkout> to record ClarkCant's digests");
