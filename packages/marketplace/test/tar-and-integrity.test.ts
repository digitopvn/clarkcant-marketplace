import { describe, expect, it } from "vitest";

import {
  IndexingRejectedError,
  TarFormatError,
  computeSha512Integrity,
  readPackageArchive,
  readTar,
  readTarGz,
  sha512Tokens,
  verifyTarballIntegrity,
} from "../src";
import { fixtureTarball } from "./support/indexing-fixtures";
import { buildTar, gzip, paxRecord, streamOf } from "./support/tar-builder";

const keepAll = { select: () => 1024 * 1024 };

describe("tar reader", () => {
  it("lists every file of a real npm pack tarball and keeps only selected bytes", async () => {
    const entries = await readTarGz(fixtureTarball("valid"), {
      select: (path) => (path === "package/clarkcant.json" ? 64 * 1024 : null),
    });
    expect(entries.map((entry) => entry.path)).toEqual(["package/clarkcant.json"]);
    const manifest = JSON.parse(new TextDecoder().decode(entries[0]?.bytes ?? new Uint8Array())) as { id: string };
    expect(manifest.id).toBe("cc.clarkcant.example-frame-widget");
  });

  it("reads the package files the indexer needs from the fixture", async () => {
    const archive = await readPackageArchive(fixtureTarball("valid"));
    expect(archive.manifestText).toContain('"schemaVersion": 1');
    expect(archive.readme?.path).toBe("README.md");
    expect(archive.previews.map((preview) => preview.path)).toEqual(["previews/cover.png"]);
    expect((archive.packageJson as { name: string }).name).toBe("@clarkcant/example-frame-widget");
  });

  it("honours pax and GNU long names across chunk boundaries", async () => {
    const longName = `package/${"deep/".repeat(30)}file.txt`;
    const tar = buildTar([
      { path: "PaxHeader", type: "x", content: paxRecord("path", "package/pax-named.txt") },
      { path: "package/short-name.txt", content: "pax" },
      { path: "././@LongLink", type: "L", content: `${longName}\0` },
      { path: longName.slice(0, 100), content: "gnu" },
      { path: "package/dir/", type: "5" },
    ]);
    const entries = await readTar(streamOf(tar, 97), keepAll);
    expect(entries.map((entry) => [entry.path, new TextDecoder().decode(entry.bytes ?? undefined)])).toEqual([
      ["package/pax-named.txt", "pax"],
      [longName, "gnu"],
    ]);
  });

  it("marks entries over their cap as oversized instead of truncating them", async () => {
    const tar = buildTar([{ path: "package/big.bin", content: new Uint8Array(3000) }]);
    const [entry] = await readTar(streamOf(tar), { select: () => 1000 });
    expect(entry).toEqual({ path: "package/big.bin", size: 3000, bytes: null });
  });

  it("enforces total size and entry count limits", async () => {
    const many = buildTar(Array.from({ length: 5 }, (_, index) => ({ path: `package/${index}.txt`, content: "x" })));
    await expect(readTar(streamOf(many), keepAll, { maxEntries: 3, maxTotalBytes: 1e6 })).rejects.toThrow(/more than 3 entries/);
    const bomb = buildTar([{ path: "package/a.bin", content: new Uint8Array(10_000) }]);
    await expect(readTar(streamOf(bomb), keepAll, { maxEntries: 10, maxTotalBytes: 4096 })).rejects.toThrow(/exceeds 4096/);
  });

  it("rejects corrupt headers, truncated archives and bad gzip", async () => {
    const tar = buildTar([{ path: "package/a.txt", content: "hello" }]);
    const corrupt = tar.slice();
    corrupt[0] = 0x51; // Changes the name without fixing the checksum.
    await expect(readTar(streamOf(corrupt), keepAll)).rejects.toBeInstanceOf(TarFormatError);

    const lying = buildTar([{ path: "package/a.txt", content: "hello", declaredSize: 5000 }], { trailer: false });
    await expect(readTar(streamOf(lying), keepAll)).rejects.toThrow(/truncated/);

    await expect(readTarGz(new TextEncoder().encode("not gzip at all"), keepAll)).rejects.toBeInstanceOf(TarFormatError);
    expect((await readTarGz(await gzip(tar), keepAll)).map((entry) => entry.path)).toEqual(["package/a.txt"]);
  });

  it("rejects a tarball that is not an archive as invalid", async () => {
    await expect(readPackageArchive(new TextEncoder().encode("<html>"))).rejects.toMatchObject({ code: "invalid_tarball" });
  });
});

describe("tarball integrity", () => {
  it("accepts bytes that match the published sha512", async () => {
    const tarball = fixtureTarball("valid");
    const integrity = await computeSha512Integrity(tarball);
    expect(integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
    await expect(verifyTarballIntegrity(tarball, `sha1-abc ${integrity}`)).resolves.toEqual({
      algorithm: "sha512",
      integrity,
    });
  });

  it("rejects a tampered tarball", async () => {
    const tarball = fixtureTarball("valid");
    const integrity = await computeSha512Integrity(tarball);
    const tampered = tarball.slice();
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
    const failure = verifyTarballIntegrity(tampered, integrity);
    await expect(failure).rejects.toBeInstanceOf(IndexingRejectedError);
    await expect(failure).rejects.toMatchObject({ code: "integrity_mismatch" });
  });

  it("never trusts sha1 alone", async () => {
    expect(sha512Tokens("sha1-2jmj7l5rSw0yVb/vlWAYkK/YBwk=")).toEqual([]);
    await expect(verifyTarballIntegrity(fixtureTarball("valid"), "sha1-2jmj7l5rSw0yVb/vlWAYkK/YBwk=")).rejects.toMatchObject({
      code: "missing_integrity",
    });
  });
});
