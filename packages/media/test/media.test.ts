import { media } from "@marketplace/db";
import { createDb } from "@marketplace/db";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import {
  MediaRejectedError,
  deleteMediaIfUnreferenced,
  mediaKeyFor,
  serveMediaObject,
  sniffImage,
  storeGeneratedMedia,
  storeUntrustedImage,
  type MediaDeps,
} from "../src/index.ts";

const base64 = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
const PNG_1X1 = base64("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==");
const GIF_1X1 = base64("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7");
// JFIF APP0 segment followed by a baseline SOF0 frame header for a 3x2 image.
const JPEG_3X2 = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
  0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x03, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11,
  0x01, 0xff, 0xd9,
]);
// RIFF/WEBP with a VP8X chunk declaring a 640x360 canvas.
const WEBP_640X360 = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x16, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58, 0x0a, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x7f, 0x02, 0x00, 0x67, 0x01, 0x00,
]);

function deps(): MediaDeps {
  let counter = 0;
  return {
    db: createDb(env.DB),
    bucket: env.MEDIA,
    ids: (prefix) => `${prefix}_test${Date.now()}${(counter += 1)}`,
    now: () => new Date("2026-09-29T00:00:00.000Z"),
  };
}

beforeEach(async () => {
  await createDb(env.DB).delete(media);
});

describe("sniffImage", () => {
  it("identifies raster formats and their dimensions from bytes", () => {
    expect(sniffImage(PNG_1X1)).toEqual({ contentType: "image/png", extension: "png", width: 1, height: 1 });
    expect(sniffImage(GIF_1X1)).toEqual({ contentType: "image/gif", extension: "gif", width: 1, height: 1 });
    expect(sniffImage(JPEG_3X2)).toEqual({ contentType: "image/jpeg", extension: "jpg", width: 3, height: 2 });
    expect(sniffImage(WEBP_640X360)).toEqual({ contentType: "image/webp", extension: "webp", width: 640, height: 360 });
  });

  it("rejects SVG, HTML and truncated signatures", () => {
    const encode = (text: string) => new TextEncoder().encode(text);
    expect(sniffImage(encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeNull();
    expect(sniffImage(encode("<!doctype html><script>alert(1)</script>"))).toBeNull();
    expect(sniffImage(PNG_1X1.subarray(0, 4))).toBeNull();
  });
});

describe("media store", () => {
  it("stores content-addressed objects once and records metadata", async () => {
    const first = await storeUntrustedImage(deps(), PNG_1X1);
    expect(first.r2Key).toMatch(/^sha256\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}\.png$/);
    expect(first.r2Key).toBe(mediaKeyFor(first.sha256, "image/png"));
    expect(first).toMatchObject({ contentType: "image/png", bytes: PNG_1X1.byteLength, width: 1, height: 1 });

    const again = await storeUntrustedImage(deps(), PNG_1X1);
    expect(again.id).toBe(first.id);

    const object = await env.MEDIA.get(first.r2Key);
    expect(object?.httpMetadata?.contentType).toBe("image/png");
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(PNG_1X1);
  });

  it("rejects non-images, SVG from untrusted input, empty and oversized bytes", async () => {
    const svg = new TextEncoder().encode("<svg/>");
    await expect(storeUntrustedImage(deps(), svg)).rejects.toBeInstanceOf(MediaRejectedError);
    await expect(storeUntrustedImage(deps(), new Uint8Array())).rejects.toBeInstanceOf(MediaRejectedError);
    await expect(storeUntrustedImage(deps(), PNG_1X1, { maxBytes: 10 })).rejects.toThrow(/limit/);
  });

  it("deletes unreferenced media together with the object", async () => {
    const stored = await storeGeneratedMedia(deps(), new TextEncoder().encode("<svg/>"), {
      contentType: "image/svg+xml",
      width: 10,
      height: 10,
    });
    expect(await deleteMediaIfUnreferenced(deps(), stored.id)).toBe(true);
    expect(await env.MEDIA.head(stored.r2Key)).toBeNull();
    expect(await deleteMediaIfUnreferenced(deps(), stored.id)).toBe(false);
  });
});

describe("serveMediaObject", () => {
  it("serves stored objects with immutable caching and a locked-down CSP", async () => {
    const stored = await storeUntrustedImage(deps(), GIF_1X1);
    const response = await serveMediaObject(env.MEDIA, stored.r2Key, new Request("https://site.test/media/x"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/gif");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(GIF_1X1);

    const etag = response.headers.get("ETag") ?? "";
    const cached = await serveMediaObject(
      env.MEDIA,
      stored.r2Key,
      new Request("https://site.test/media/x", { headers: { "If-None-Match": etag } }),
    );
    expect(cached.status).toBe(304);
  });

  it("refuses keys outside the content-addressed layout and unknown objects", async () => {
    const get = (key: string) => serveMediaObject(env.MEDIA, key, new Request("https://site.test/"));
    expect((await get("../secrets.txt")).status).toBe(404);
    expect((await get("sha256/aa/bb/not-a-digest.png")).status).toBe(404);
    expect((await get(`sha256/aa/bb/${"a".repeat(64)}.png`)).status).toBe(404);
    const post = await serveMediaObject(env.MEDIA, `sha256/aa/bb/${"a".repeat(64)}.png`, new Request("https://s.test/", { method: "POST" }));
    expect(post.status).toBe(405);
  });
});
