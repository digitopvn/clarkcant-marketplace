/**
 * Identifies raster images by their magic bytes, never by file name or a declared content type, and reads their
 * pixel dimensions from the header. Only formats browsers render without executing anything are recognised; SVG is
 * deliberately absent because it can carry script.
 */

export type RasterImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export interface SniffedImage {
  contentType: RasterImageType;
  extension: "png" | "jpg" | "gif" | "webp";
  /** Null when the header is recognised but the dimensions cannot be read (e.g. a truncated JPEG). */
  width: number | null;
  height: number | null;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (bytes.length < offset + length) return "";
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function positive(value: number): number | null {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function sniffPng(bytes: Uint8Array): SniffedImage | null {
  if (!startsWith(bytes, PNG_SIGNATURE)) return null;
  // The first chunk must be IHDR: width and height are big-endian u32 at offsets 16 and 20.
  const hasHeader = bytes.length >= 24 && ascii(bytes, 12, 4) === "IHDR";
  return {
    contentType: "image/png",
    extension: "png",
    width: hasHeader ? positive(view(bytes).getUint32(16)) : null,
    height: hasHeader ? positive(view(bytes).getUint32(20)) : null,
  };
}

function sniffGif(bytes: Uint8Array): SniffedImage | null {
  const magic = ascii(bytes, 0, 6);
  if (magic !== "GIF87a" && magic !== "GIF89a") return null;
  const hasScreen = bytes.length >= 10;
  return {
    contentType: "image/gif",
    extension: "gif",
    width: hasScreen ? positive(view(bytes).getUint16(6, true)) : null,
    height: hasScreen ? positive(view(bytes).getUint16(8, true)) : null,
  };
}

function sniffWebp(bytes: Uint8Array): SniffedImage | null {
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") return null;
  const chunk = ascii(bytes, 12, 4);
  let width: number | null = null;
  let height: number | null = null;
  if (chunk === "VP8X" && bytes.length >= 30) {
    // 24-bit little-endian canvas size minus one.
    width = 1 + ((bytes[24] ?? 0) | ((bytes[25] ?? 0) << 8) | ((bytes[26] ?? 0) << 16));
    height = 1 + ((bytes[27] ?? 0) | ((bytes[28] ?? 0) << 8) | ((bytes[29] ?? 0) << 16));
  } else if (chunk === "VP8 " && bytes.length >= 30 && startsWith(bytes, [0x9d, 0x01, 0x2a], 23)) {
    width = view(bytes).getUint16(26, true) & 0x3fff;
    height = view(bytes).getUint16(28, true) & 0x3fff;
  } else if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = view(bytes).getUint32(21, true);
    width = (bits & 0x3fff) + 1;
    height = ((bits >> 14) & 0x3fff) + 1;
  }
  return { contentType: "image/webp", extension: "webp", width: width && positive(width), height: height && positive(height) };
}

/** SOF0-SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame dimensions. */
function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function sniffJpeg(bytes: Uint8Array): SniffedImage | null {
  if (!startsWith(bytes, [0xff, 0xd8, 0xff])) return null;
  const data = view(bytes);
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) break;
    const marker = bytes[offset + 1] ?? 0;
    if (marker === 0xff) {
      offset += 1; // Fill byte.
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2; // Markers without a length field.
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break; // End of image or start of scan before any frame header.
    const length = data.getUint16(offset + 2);
    if (isStartOfFrame(marker)) {
      return {
        contentType: "image/jpeg",
        extension: "jpg",
        height: positive(data.getUint16(offset + 5)),
        width: positive(data.getUint16(offset + 7)),
      };
    }
    if (length < 2) break;
    offset += 2 + length;
  }
  return { contentType: "image/jpeg", extension: "jpg", width: null, height: null };
}

/** Returns the image type and dimensions, or null when the bytes are not a supported raster image. */
export function sniffImage(bytes: Uint8Array): SniffedImage | null {
  return sniffPng(bytes) ?? sniffJpeg(bytes) ?? sniffGif(bytes) ?? sniffWebp(bytes);
}
