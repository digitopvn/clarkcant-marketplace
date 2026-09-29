/**
 * Writes ustar archives for tests that need shapes `npm pack` never produces (pax and GNU long names, hostile sizes,
 * corrupt checksums). The indexer's happy path is always tested against real `npm pack` output instead.
 */

export interface TarInput {
  path: string;
  content?: string | Uint8Array;
  type?: "0" | "5" | "x" | "L";
  /** Overrides the size written in the header (to fake a huge entry). */
  declaredSize?: number;
}

const encoder = new TextEncoder();

function writeString(block: Uint8Array, offset: number, length: number, value: string): void {
  block.set(encoder.encode(value).subarray(0, length), offset);
}

function writeOctal(block: Uint8Array, offset: number, length: number, value: number): void {
  writeString(block, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}

function header(input: TarInput, size: number): Uint8Array {
  const block = new Uint8Array(512);
  writeString(block, 0, 100, input.path.slice(0, 100));
  writeOctal(block, 100, 8, 0o644);
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  writeOctal(block, 124, 12, input.declaredSize ?? size);
  writeOctal(block, 136, 12, 0);
  block.fill(0x20, 148, 156);
  writeString(block, 156, 1, input.type ?? "0");
  writeString(block, 257, 6, "ustar\0");
  writeString(block, 263, 2, "00");
  let sum = 0;
  for (const byte of block) sum += byte;
  writeString(block, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return block;
}

export function buildTar(entries: TarInput[], options: { trailer?: boolean } = {}): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    const content = typeof entry.content === "string" ? encoder.encode(entry.content) : (entry.content ?? new Uint8Array());
    parts.push(header(entry, content.length));
    const padded = new Uint8Array(Math.ceil(content.length / 512) * 512);
    padded.set(content);
    parts.push(padded);
  }
  if (options.trailer !== false) parts.push(new Uint8Array(1024));
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** A pax extended-header record: `<length> key=value\n`, where length counts itself. */
export function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = body.length + 1;
  while (`${length}${body}`.length !== length) length += 1;
  return `${length}${body}`;
}

export function streamOf(bytes: Uint8Array, chunkSize = 700): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
