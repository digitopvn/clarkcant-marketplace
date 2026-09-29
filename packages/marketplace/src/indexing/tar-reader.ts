/**
 * Minimal streaming reader for npm tarballs (gzip + POSIX ustar, with pax and GNU long-name extensions).
 *
 * It never writes to disk and never interprets content: it walks headers, keeps the bytes of the entries a caller
 * asks for (each under its own size cap) and skips everything else, while enforcing totals so a decompression
 * bomb or an archive with millions of entries fails fast instead of exhausting the Worker.
 */

const BLOCK = 512;

export interface TarLimits {
  /** Total uncompressed archive bytes read, including skipped content. */
  maxTotalBytes: number;
  /** Number of headers (files, directories, metadata) processed. */
  maxEntries: number;
  /**
   * Total bytes of selected entries kept in memory. Per-entry caps alone do not bound memory: a gzip bomb can hold
   * many small-compressed entries that each pass their own cap. Defaults to {@link DEFAULT_MAX_KEPT_BYTES}.
   */
  maxKeptBytes?: number;
}

export const DEFAULT_MAX_KEPT_BYTES = 32 * 1024 * 1024;

export const DEFAULT_TAR_LIMITS: TarLimits = {
  maxTotalBytes: 128 * 1024 * 1024,
  maxEntries: 20_000,
  maxKeptBytes: DEFAULT_MAX_KEPT_BYTES,
};

export interface TarSelection {
  /**
   * Called with each regular file's path (as stored, e.g. `package/README.md`) and its declared size. Return the
   * maximum number of bytes to keep for it, or `null` to skip it. A kept entry larger than its cap is recorded as
   * oversized, not truncated. Called once per entry in archive order, so a selector may keep state (for example to
   * skip duplicate paths or stop after a count).
   */
  select(path: string, size: number): number | null;
}

export interface TarEntry {
  path: string;
  size: number;
  /** Null when the entry exceeded the cap its selector returned. */
  bytes: Uint8Array | null;
}

export class TarFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TarFormatError";
  }
}

/**
 * Pulls exact byte counts out of a chunked stream without concatenating the whole archive. Incoming chunks are
 * queued and copied once, into the slice a caller asks for, so reading a large entry stays linear in its size.
 */
class StreamReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly chunks: Uint8Array[] = [];
  /** Offset into `chunks[0]` of the first unread byte. */
  private head = 0;
  private buffered = 0;
  private done = false;
  private readonly maxTotalBytes: number;
  consumed = 0;

  constructor(stream: ReadableStream<Uint8Array>, maxTotalBytes: number) {
    this.reader = stream.getReader();
    this.maxTotalBytes = maxTotalBytes;
  }

  private async fill(minimum: number): Promise<void> {
    while (this.buffered < minimum && !this.done) {
      const { value, done } = await this.reader.read();
      if (done) {
        this.done = true;
        break;
      }
      if (value.length === 0) continue;
      this.chunks.push(value);
      this.buffered += value.length;
    }
  }

  private account(count: number): void {
    this.consumed += count;
    if (this.consumed > this.maxTotalBytes) {
      throw new TarFormatError(`archive exceeds ${this.maxTotalBytes} uncompressed bytes`);
    }
  }

  /** Drops `count` buffered bytes, copying them into `into` when given. */
  private take(count: number, into?: Uint8Array): void {
    let remaining = count;
    let offset = 0;
    while (remaining > 0) {
      const chunk = this.chunks[0];
      if (!chunk) throw new TarFormatError("archive is truncated");
      const available = chunk.length - this.head;
      const step = Math.min(available, remaining);
      into?.set(chunk.subarray(this.head, this.head + step), offset);
      offset += step;
      remaining -= step;
      if (step === available) {
        this.chunks.shift();
        this.head = 0;
      } else {
        this.head += step;
      }
    }
    this.buffered -= count;
  }

  /** Returns exactly `count` bytes, or null at a clean end of stream. Throws on a truncated stream. */
  async read(count: number): Promise<Uint8Array | null> {
    await this.fill(count);
    if (this.buffered === 0 && this.done) return null;
    if (this.buffered < count) throw new TarFormatError("archive is truncated");
    this.account(count);
    const out = new Uint8Array(count);
    this.take(count, out);
    return out;
  }

  async skip(count: number): Promise<void> {
    let remaining = count;
    while (remaining > 0) {
      if (this.buffered === 0) {
        await this.fill(1);
        if (this.buffered === 0) throw new TarFormatError("archive is truncated");
      }
      const step = Math.min(remaining, this.buffered);
      this.account(step);
      this.take(step);
      remaining -= step;
    }
  }

  async cancel(): Promise<void> {
    await this.reader.cancel().catch(() => undefined);
  }
}

const decoder = new TextDecoder();

function field(header: Uint8Array, offset: number, length: number): string {
  const slice = header.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return decoder.decode(end === -1 ? slice : slice.subarray(0, end));
}

function octal(header: Uint8Array, offset: number, length: number): number {
  const first = header[offset] ?? 0;
  if (first & 0x80) {
    // GNU base-256 encoding for large sizes: big-endian with the high bit as a marker.
    let value = first & 0x7f;
    for (let index = 1; index < length; index += 1) value = value * 256 + (header[offset + index] ?? 0);
    return value;
  }
  const text = field(header, offset, length).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new TarFormatError(`invalid octal field "${text}"`);
  return Number.parseInt(text, 8);
}

function verifyChecksum(header: Uint8Array): void {
  const stored = octal(header, 148, 8);
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) sum += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
  if (sum !== stored) throw new TarFormatError("header checksum mismatch");
}

/** Parses pax records (`<len> key=value\n`) and returns the `path` override if present. */
function paxPath(bytes: Uint8Array): string | null {
  const text = decoder.decode(bytes);
  let offset = 0;
  let path: string | null = null;
  while (offset < text.length) {
    const space = text.indexOf(" ", offset);
    if (space === -1) break;
    const length = Number.parseInt(text.slice(offset, space), 10);
    if (!Number.isInteger(length) || length <= 0) break;
    const record = text.slice(space + 1, offset + length - 1);
    const equals = record.indexOf("=");
    if (equals !== -1 && record.slice(0, equals) === "path") path = record.slice(equals + 1);
    offset += length;
  }
  return path;
}

const padded = (size: number) => Math.ceil(size / BLOCK) * BLOCK;
const MAX_META_BYTES = 64 * 1024;

/** Reads a tar stream and returns the selected regular files. */
export async function readTar(
  stream: ReadableStream<Uint8Array>,
  selection: TarSelection,
  limits: TarLimits = DEFAULT_TAR_LIMITS,
): Promise<TarEntry[]> {
  const reader = new StreamReader(stream, limits.maxTotalBytes);
  const entries: TarEntry[] = [];
  const maxKeptBytes = limits.maxKeptBytes ?? DEFAULT_MAX_KEPT_BYTES;
  let keptBytes = 0;
  let pendingPath: string | null = null;
  let headers = 0;
  try {
    for (;;) {
      const header = await reader.read(BLOCK);
      if (header === null) break; // Some writers omit the two trailing zero blocks.
      if (header.every((byte) => byte === 0)) break;
      headers += 1;
      if (headers > limits.maxEntries) throw new TarFormatError(`archive has more than ${limits.maxEntries} entries`);
      verifyChecksum(header);

      const size = octal(header, 124, 12);
      const type = String.fromCharCode(header[156] ?? 0);
      const magic = field(header, 257, 6);
      const prefix = magic.startsWith("ustar") ? field(header, 345, 155) : "";
      const name = field(header, 0, 100);
      const storedPath = pendingPath ?? (prefix ? `${prefix}/${name}` : name);

      if (type === "x" || type === "L") {
        if (size > MAX_META_BYTES) throw new TarFormatError("extended header is too large");
        const meta = (await reader.read(padded(size)))?.subarray(0, size);
        if (!meta) throw new TarFormatError("archive is truncated");
        pendingPath = type === "L" ? field(meta, 0, meta.length) : (paxPath(meta) ?? pendingPath);
        continue;
      }
      pendingPath = null;

      const isFile = type === "0" || type === "\0" || type === "7";
      const cap = isFile ? selection.select(storedPath, size) : null;
      if (cap === null || size > cap) {
        await reader.skip(padded(size));
        if (cap !== null) entries.push({ path: storedPath, size, bytes: null });
        continue;
      }
      keptBytes += size;
      if (keptBytes > maxKeptBytes) throw new TarFormatError(`selected files exceed ${maxKeptBytes} bytes in total`);
      if (size === 0) {
        entries.push({ path: storedPath, size, bytes: new Uint8Array(0) });
        continue;
      }
      const data = await reader.read(size);
      if (!data) throw new TarFormatError("archive is truncated");
      await reader.skip(padded(size) - size);
      entries.push({ path: storedPath, size, bytes: data });
    }
  } finally {
    await reader.cancel();
  }
  return entries;
}

/** Gunzips `bytes` with the platform's DecompressionStream and reads the tar inside. */
export async function readTarGz(
  bytes: Uint8Array,
  selection: TarSelection,
  limits: TarLimits = DEFAULT_TAR_LIMITS,
): Promise<TarEntry[]> {
  const source = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  try {
    return await readTar(source as ReadableStream<Uint8Array>, selection, limits);
  } catch (error) {
    if (error instanceof TarFormatError) throw error;
    // DecompressionStream reports corrupt gzip data as a TypeError.
    throw new TarFormatError(`archive could not be decompressed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
