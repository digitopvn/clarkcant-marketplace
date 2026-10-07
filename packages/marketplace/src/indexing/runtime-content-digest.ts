/**
 * The runtime content digest of an npm archive, computed byte for byte as ClarkCant computes it after fetching an npm
 * version (`npm.contentDigest` from `clark widget pack`, the `digest` of an npm directory entry).
 *
 * ClarkCant (`clarkcant/packages/core/src/package-fetch.ts`) gunzips the tarball, reads it with its own ustar reader
 * (`extractUstarTarball`, first path component stripped), writes every entry to a directory and hashes that directory
 * (`digestOfDirectory`): every regular file, sorted by its `/`-separated relative path, as
 * `<path>\0<byte length>\0<bytes>` into one sha256, written `sha256:<hex>`. This module replays the same reader rules
 * and the effect the writes have on a filesystem, without touching one, so it can run in a Worker.
 *
 * Its answer is either the digest ClarkCant computes or no digest at all, never a different one:
 * - an archive ClarkCant refuses (symlink, hard link, device, path traversal, duplicate name, no ustar magic, a pax
 *   size override, a path both a file and a folder) gets no digest, with ClarkCant's reason;
 * - an archive whose extracted tree depends on the host's filesystem (names equal except for letter case or Unicode
 *   normalisation, names Windows cannot hold) gets no digest either, because ClarkCant on another platform would
 *   compute another one.
 *
 * `fixtures/upstream/clarkcant-directory/` pins this against ClarkCant's own code (`pnpm contract:check`).
 */

/** ClarkCant's caps (`MAX_TARBALL_BYTES`, `MAX_DECOMPRESSED_BYTES`, `MAX_TAR_ENTRIES` in package-fetch.ts). */
export const RUNTIME_MAX_TARBALL_BYTES = 64 * 1024 * 1024;
export const RUNTIME_MAX_DECOMPRESSED_BYTES = 512 * 1024 * 1024;
export const RUNTIME_MAX_TAR_ENTRIES = 20_000;

/**
 * A pax, GNU long-name or long-link body larger than this is not read: ClarkCant reads one of any size, so the
 * marketplace declines to compute a digest instead of buffering an unbounded header.
 */
const MAX_META_BYTES = 1024 * 1024;
/** File bytes held at once while waiting for their turn in path order; past it the archive is read again. */
const DEFAULT_REORDER_BUDGET_BYTES = 16 * 1024 * 1024;
/** Reads of the archive one digest may take before it is declined as too costly. */
const DEFAULT_MAX_PASSES = 8;
/** Linux `NAME_MAX` and `PATH_MAX`, in UTF-8 bytes: a longer name fails ClarkCant's write. */
const MAX_NAME_BYTES = 255;
const MAX_PATH_BYTES = 4095;

const BLOCK = 512;

export type RuntimeContentDigest =
  | { ok: true; digest: string; sizeBytes: number; fileCount: number }
  | { ok: false; reason: string };

export interface RuntimeContentDigestOptions {
  /** Bytes of file content buffered while reordering (tests narrow it). */
  reorderBudgetBytes?: number;
  maxPasses?: number;
}

class Declined extends Error {}

// `ignoreBOM` keeps a leading U+FEFF, as Node's `Buffer#toString("utf8")` does.
const utf8 = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
const encoder = new TextEncoder();

/** `buffer.toString("utf8").replace(/\0.*$/s, "")`, as ClarkCant reads every header text field. */
function text(bytes: Uint8Array): string {
  return utf8.decode(bytes).replace(/\0.*$/s, "");
}

/** ClarkCant's `parsePaxRecords`, including its reading of record lengths as character offsets. */
function parsePaxRecords(body: Uint8Array): { path?: string; linkpath?: string; size?: number } {
  const overrides: { path?: string; linkpath?: string; size?: number } = {};
  const content = utf8.decode(body);
  let cursor = 0;
  while (cursor < content.length) {
    const spaceIndex = content.indexOf(" ", cursor);
    if (spaceIndex === -1) break;
    const recordLength = Number.parseInt(content.slice(cursor, spaceIndex), 10);
    if (Number.isNaN(recordLength) || recordLength <= 0) break;
    const record = content.slice(cursor, cursor + recordLength);
    const equalsIndex = record.indexOf("=");
    if (equalsIndex !== -1) {
      const key = record.slice(spaceIndex - cursor + 1, equalsIndex);
      const value = record.slice(equalsIndex + 1).replace(/\n$/, "");
      if (key === "path") overrides.path = value;
      else if (key === "linkpath") overrides.linkpath = value;
      else if (key === "size") {
        const parsedSize = Number.parseInt(value, 10);
        if (!Number.isNaN(parsedSize) && parsedSize >= 0) overrides.size = parsedSize;
      }
    }
    cursor += recordLength;
  }
  return overrides;
}

/** Pulls exact byte counts out of the gunzipped stream, counting every byte against the decompression cap. */
class ByteSource {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private chunk: Uint8Array = new Uint8Array(0);
  private offset = 0;
  private ended = false;
  private total = 0;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  private async more(): Promise<boolean> {
    while (!this.ended && this.offset >= this.chunk.length) {
      let read: ReadableStreamReadResult<Uint8Array>;
      try {
        read = await this.reader.read();
      } catch (error) {
        // DecompressionStream reports corrupt gzip data as an error of the stream; ClarkCant's gunzip refuses it too.
        throw new Declined(`the tarball could not be decompressed: ${error instanceof Error ? error.message : String(error)}`);
      }
      const { value, done } = read;
      if (done) {
        this.ended = true;
        return false;
      }
      this.total += value.length;
      if (this.total > RUNTIME_MAX_DECOMPRESSED_BYTES) {
        throw new Declined(`the tarball did not decompress within the ${String(RUNTIME_MAX_DECOMPRESSED_BYTES)} byte cap`);
      }
      this.chunk = value;
      this.offset = 0;
    }
    return this.offset < this.chunk.length;
  }

  /** Up to `count` bytes, fewer only at the end of the stream. `sink` receives them in pieces, or they are dropped. */
  async pull(count: number, sink?: (piece: Uint8Array) => void): Promise<number> {
    let moved = 0;
    while (moved < count && (await this.more())) {
      const step = Math.min(count - moved, this.chunk.length - this.offset);
      sink?.(this.chunk.subarray(this.offset, this.offset + step));
      this.offset += step;
      moved += step;
    }
    return moved;
  }

  /** Exactly `count` bytes, or null when the stream ends first. */
  async read(count: number): Promise<Uint8Array | null> {
    const out = new Uint8Array(count);
    let at = 0;
    const moved = await this.pull(count, (piece) => {
      out.set(piece, at);
      at += piece.length;
    });
    return moved === count ? out : null;
  }

  /** Reads to the end, so a corrupt gzip trailer is seen exactly as a full gunzip would see it. */
  async drain(): Promise<void> {
    while (await this.more()) this.offset = this.chunk.length;
  }

  async cancel(): Promise<void> {
    await this.reader.cancel().catch(() => undefined);
  }
}

function gunzip(tarball: Uint8Array): ReadableStream<Uint8Array> {
  return new Blob([tarball]).stream().pipeThrough(new DecompressionStream("gzip")) as ReadableStream<Uint8Array>;
}

/** One regular-file or directory entry, after ClarkCant's checks and its strip of the first path component. */
interface ArchiveEntry {
  /** Position among accepted entries, identical on every read of the same bytes. */
  index: number;
  name: string;
  type: "file" | "directory";
  size: number;
}

/**
 * Walks the archive with ClarkCant's `extractUstarTarball` rules. `onEntry` may take the entry's content with
 * `readContent`; whatever it leaves is skipped. Throws `Declined` with ClarkCant's reason when ClarkCant refuses.
 */
async function walkArchive(
  tarball: Uint8Array,
  onEntry: (entry: ArchiveEntry, readContent: () => Promise<Uint8Array>) => Promise<boolean | void>,
): Promise<void> {
  const source = new ByteSource(gunzip(tarball));
  try {
    const seenNames = new Set<string>();
    let entryCount = 0;
    let accepted = 0;
    let pending: { path?: string; linkpath?: string; size?: number } = {};
    for (;;) {
      const header = await source.read(BLOCK);
      if (header === null || header.every((byte) => byte === 0)) break;
      entryCount += 1;
      if (entryCount > RUNTIME_MAX_TAR_ENTRIES) {
        throw new Declined(`tarball has more than ${String(RUNTIME_MAX_TAR_ENTRIES)} entries`);
      }
      if (utf8.decode(header.subarray(257, 262)) !== "ustar") {
        throw new Declined("a tar header is missing the ustar magic, so its fields cannot be trusted");
      }
      const rawName = text(header.subarray(0, 100));
      const prefix = text(header.subarray(345, 500));
      const headerName = prefix.length > 0 ? `${prefix}/${rawName}` : rawName;
      const sizeField = text(header.subarray(124, 136)).trim();
      const headerSize = sizeField.length === 0 ? 0 : Number.parseInt(sizeField, 8);
      const typeflag = String.fromCharCode(header[156] ?? 0);
      if (Number.isNaN(headerSize) || headerSize < 0) throw new Declined(`tar entry "${headerName}" has an unreadable size field`);
      const padding = Math.ceil(headerSize / BLOCK) * BLOCK - headerSize;

      let content: Uint8Array | null = null;
      let contentRead = false;
      const readContent = async (): Promise<Uint8Array> => {
        if (contentRead) throw new Error("tar entry content is read once");
        contentRead = true;
        content = await source.read(headerSize);
        if (content === null) throw new Declined(`tar entry "${headerName}" claims a size larger than the archive`);
        return content;
      };
      const finishEntry = async (): Promise<boolean> => {
        if (!contentRead) {
          contentRead = true;
          if ((await source.pull(headerSize)) !== headerSize) {
            throw new Declined(`tar entry "${headerName}" claims a size larger than the archive`);
          }
        }
        // Padding cut short by the end of the archive simply ends it, as in ClarkCant's offset arithmetic.
        return (await source.pull(padding)) === padding;
      };

      if (typeflag === "x" || typeflag === "g" || typeflag === "L" || typeflag === "K") {
        if (headerSize > MAX_META_BYTES) {
          throw new Declined(`tar entry "${headerName}" carries a ${String(headerSize)} byte extended header, larger than the marketplace reads`);
        }
        const body = await readContent();
        if (typeflag === "x") pending = { ...pending, ...parsePaxRecords(body) };
        else if (typeflag === "g") {
          const records = parsePaxRecords(body);
          if (records.path !== undefined || records.size !== undefined) {
            throw new Declined("a pax global extended header carries a path or size override");
          }
        } else if (typeflag === "L") pending = { ...pending, path: text(body) };
        else pending = { ...pending, linkpath: text(body) };
        if (!(await finishEntry())) break;
        continue;
      }

      if (pending.size !== undefined && pending.size !== headerSize) {
        throw new Declined(`tar entry "${headerName}" has a pax size override that differs from its ustar header size`);
      }
      // ClarkCant checks that the content is present before it looks at the entry's name or type.
      const fullName = pending.path ?? headerName;
      pending = {};
      const segments = fullName.split("/").filter((segment) => segment.length > 0);
      if (fullName.startsWith("/") || segments.includes("..")) {
        throw new Declined(`tar entry "${fullName}" is a path-traversal or absolute entry name`);
      }
      if (typeflag === "2") throw new Declined(`tar entry "${fullName}" is a symlink, which is refused`);
      if (typeflag === "1") throw new Declined(`tar entry "${fullName}" is a hard link, which is refused`);
      if (typeflag === "3" || typeflag === "4") throw new Declined(`tar entry "${fullName}" is a device file, which is refused`);
      if (typeflag === "6") throw new Declined(`tar entry "${fullName}" is a fifo, which is refused`);
      if (typeflag !== "0" && typeflag !== "\0" && typeflag !== "5") {
        throw new Declined(`tar entry "${fullName}" has an unsupported type "${typeflag}"`);
      }

      const stripped = segments.slice(1);
      let stop = false;
      if (stripped.length > 0) {
        const name = stripped.join("/");
        if (seenNames.has(name)) throw new Declined(`tar entry "${name}" conflicts with a previously extracted entry of the same name`);
        seenNames.add(name);
        const entry: ArchiveEntry = { index: accepted, name, type: typeflag === "5" ? "directory" : "file", size: headerSize };
        accepted += 1;
        stop = (await onEntry(entry, readContent)) === true;
      }
      if (stop) return;
      if (!(await finishEntry())) break;
    }
    await source.drain();
  } finally {
    await source.cancel();
  }
}

/* ------------------------------------------------------------------ *
 * The extracted tree, as ClarkCant's writes would leave it
 * ------------------------------------------------------------------ */

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/i;
// eslint-disable-next-line no-control-regex -- control characters are exactly what Windows refuses in a name.
const WINDOWS_FORBIDDEN = /[<>:"|?*\\\u0000-\u001f]/;

/** Why a path segment would be written differently, or not at all, on another of ClarkCant's platforms. */
function segmentProblem(segment: string): string | undefined {
  if (WINDOWS_FORBIDDEN.test(segment)) return "holds a character Windows does not allow in a file name";
  if (/[. ]$/.test(segment)) return "ends with a dot or a space, which Windows drops";
  if (WINDOWS_RESERVED.test(segment)) return "is a device name on Windows";
  if (encoder.encode(segment).length > MAX_NAME_BYTES) return `is longer than ${String(MAX_NAME_BYTES)} bytes`;
  return undefined;
}

interface ExtractedFile {
  path: string;
  size: number;
  /** The entry whose bytes the file holds: a later write to the same path replaces an earlier one. */
  entryIndex: number;
}

/**
 * Replays ClarkCant's writes (`mkdirSync(..., { recursive: true })` and `writeFileSync`) on a model of the extraction
 * folder and returns the regular files `digestOfDirectory` would hash.
 */
class ExtractedTree {
  private readonly kinds = new Map<string, "file" | "directory">();
  private readonly files = new Map<string, ExtractedFile>();
  private readonly folded = new Map<string, string>();

  add(entry: ArchiveEntry): void {
    // `resolve(dest, name)` drops `.` segments; `..` and empty segments never reach here.
    const segments = entry.name.split("/").filter((segment) => segment !== ".");
    for (const segment of segments) {
      const problem = segmentProblem(segment);
      if (problem) throw new Declined(`the archive path "${entry.name}" ${problem}, so its digest depends on the platform`);
    }
    const path = segments.join("/");
    if (encoder.encode(path).length > MAX_PATH_BYTES) {
      throw new Declined(`the archive path "${entry.name}" is longer than ${String(MAX_PATH_BYTES)} bytes`);
    }
    if (entry.type === "directory") {
      for (let depth = 1; depth <= segments.length; depth += 1) this.mkdir(segments.slice(0, depth).join("/"), entry.name);
      return;
    }
    if (path === "") throw new Declined(`tar entry "${entry.name}" could not be extracted: it names the extraction folder itself`);
    for (let depth = 1; depth < segments.length; depth += 1) this.mkdir(segments.slice(0, depth).join("/"), entry.name);
    if (this.kinds.get(path) === "directory") {
      throw new Declined(`tar entry "${entry.name}" could not be extracted: a folder of the same name exists`);
    }
    this.claim(path);
    this.kinds.set(path, "file");
    this.files.set(path, { path, size: entry.size, entryIndex: entry.index });
  }

  private mkdir(path: string, name: string): void {
    const kind = this.kinds.get(path);
    if (kind === "file") throw new Declined(`tar entry "${name}" could not be extracted: a file of the same name exists`);
    if (kind === "directory") return;
    this.claim(path);
    this.kinds.set(path, "directory");
  }

  /** Two different names one case-insensitive or normalising filesystem would store as one. */
  private claim(path: string): void {
    const key = path.normalize("NFC").toLowerCase();
    const other = this.folded.get(key);
    if (other !== undefined && other !== path) {
      throw new Declined(`the archive holds "${other}" and "${path}", one file on a case-insensitive filesystem, so its digest depends on the platform`);
    }
    this.folded.set(key, path);
  }

  /** The files `digestOfDirectory` hashes, in its order: by `/`-separated path, compared as JavaScript strings. */
  sortedFiles(): ExtractedFile[] {
    return [...this.files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
}

/**
 * Computes the runtime content digest of an npm tarball (the gzip bytes npm serves). Never throws for a property of
 * the archive: an archive ClarkCant would refuse, or one it would digest differently per platform, is `ok: false`
 * with the reason. Rethrows only failures of the Worker itself.
 */
export async function computeRuntimeContentDigest(
  tarball: Uint8Array,
  options: RuntimeContentDigestOptions = {},
): Promise<RuntimeContentDigest> {
  if (tarball.byteLength > RUNTIME_MAX_TARBALL_BYTES) {
    return { ok: false, reason: `the tarball is ${String(tarball.byteLength)} bytes, over ClarkCant's ${String(RUNTIME_MAX_TARBALL_BYTES)} byte cap` };
  }
  try {
    const tree = new ExtractedTree();
    await walkArchive(tarball, async (entry) => {
      tree.add(entry);
    });
    const files = tree.sortedFiles();
    const digest = await hashInPathOrder(tarball, files, options);
    return { ok: true, digest, sizeBytes: files.reduce((sum, file) => sum + file.size, 0), fileCount: files.length };
  } catch (error) {
    if (error instanceof Declined) return { ok: false, reason: error.message };
    throw error;
  }
}

/**
 * Feeds the files to one sha256 in path order. An archive usually lists its files in that order (npm sorts them), so
 * one more read suffices; files that arrive early wait in a bounded buffer, and when it fills the archive is read again
 * from the next file still owed.
 */
async function hashInPathOrder(tarball: Uint8Array, files: ExtractedFile[], options: RuntimeContentDigestOptions): Promise<string> {
  const budget = options.reorderBudgetBytes ?? DEFAULT_REORDER_BUDGET_BYTES;
  const maxPasses = options.maxPasses ?? DEFAULT_MAX_PASSES;
  const hash = await openSha256();
  const position = new Map(files.map((file, at) => [file.entryIndex, at]));
  const waiting = new Map<number, Uint8Array>();
  let waitingBytes = 0;
  let next = 0;

  const hashFile = async (at: number, bytes: Uint8Array): Promise<void> => {
    const file = files[at];
    if (!file) throw new Error("unreachable: a file position outside the sorted list");
    // Strings go in as UTF-8, as Node's `hash.update(string)` writes them in ClarkCant.
    await hash.write(encoder.encode(`${file.path}\0${String(bytes.byteLength)}\0`));
    if (bytes.byteLength > 0) await hash.write(bytes);
    next = at + 1;
  };
  /** Hashes the file owed now, then every waiting file that follows it. */
  const emit = async (at: number, bytes: Uint8Array): Promise<void> => {
    await hashFile(at, bytes);
    for (let held = waiting.get(next); held !== undefined; held = waiting.get(next)) {
      waiting.delete(next);
      waitingBytes -= held.byteLength;
      await hashFile(next, held);
    }
  };

  for (let pass = 0; next < files.length; pass += 1) {
    if (pass >= maxPasses) {
      throw new Declined(`the archive lists its files too far out of order to digest within ${String(maxPasses)} reads`);
    }
    await walkArchive(tarball, async (entry, readContent) => {
      const at = position.get(entry.index);
      if (at === undefined || at < next || waiting.has(at)) return next >= files.length;
      if (at === next) await emit(at, await readContent());
      else if (waitingBytes + entry.size <= budget) {
        waiting.set(at, await readContent());
        waitingBytes += entry.size;
      }
      return next >= files.length;
    });
  }
  return `sha256:${await hash.hex()}`;
}

interface Sha256Sink {
  write(bytes: Uint8Array): Promise<void>;
  hex(): Promise<string>;
}

/** The part of `node:crypto` this module uses, for runtimes without `crypto.DigestStream`. */
interface NodeCrypto {
  createHash(algorithm: "sha256"): { update(bytes: Uint8Array): unknown; digest(encoding: "hex"): string };
}

/**
 * An incremental sha256: workerd's native `crypto.DigestStream` in a Worker, `node:crypto` where it is absent (the
 * `pnpm index:local` script runs this pipeline in Node). Web Crypto alone cannot hash incrementally.
 */
async function openSha256(): Promise<Sha256Sink> {
  if (typeof crypto.DigestStream === "function") {
    const stream = new crypto.DigestStream("SHA-256");
    const writer = stream.getWriter();
    return {
      write: (bytes) => writer.write(bytes),
      async hex() {
        await writer.close();
        return Array.from(new Uint8Array(await stream.digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
      },
    };
  }
  // A variable specifier keeps bundlers and the Workers type set (which has no `node:` modules) out of this branch.
  const specifier = "node:crypto";
  const { createHash } = (await import(/* @vite-ignore */ specifier)) as NodeCrypto;
  const hash = createHash("sha256");
  return {
    write: (bytes) => {
      hash.update(bytes);
      return Promise.resolve();
    },
    hex: () => Promise.resolve(hash.digest("hex")),
  };
}
