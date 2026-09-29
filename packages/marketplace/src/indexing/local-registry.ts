import { computeSha512Integrity } from "./integrity";
import { packumentPath, type FetchLike } from "./npm-registry";
import { readTarGz } from "./tar-reader";

/**
 * An npm-registry-compatible responder built from real tarballs (`npm pack` output). It derives each packument the
 * way the registry does, from the tarball's own `package.json` plus the sha512 of the exact bytes, so the indexer
 * runs its real fetch → verify → extract path. Used by the tests and by `pnpm index:local`; production never uses it.
 */

export interface LocalTarball {
  bytes: Uint8Array;
  /** Publication time recorded in the packument `time` map. Defaults to now. */
  publishedAt?: Date;
}

interface LocalVersion {
  name: string;
  version: string;
  manifest: Record<string, unknown>;
  bytes: Uint8Array;
  integrity: string;
  publishedAt: string;
}

async function readPackageJson(bytes: Uint8Array): Promise<Record<string, unknown>> {
  const [entry] = await readTarGz(bytes, { select: (path) => (/^[^/]+\/package\.json$/.test(path) ? 256 * 1024 : null) });
  if (!entry?.bytes) throw new Error("tarball has no package.json");
  const json: unknown = JSON.parse(new TextDecoder().decode(entry.bytes));
  if (typeof json !== "object" || json === null) throw new Error("package.json is not an object");
  const manifest = json as Record<string, unknown>;
  if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
    throw new Error("package.json has no name/version");
  }
  return manifest;
}

function tarballFileName(name: string, version: string): string {
  return `${name.startsWith("@") ? name.split("/")[1] : name}-${version}.tgz`;
}

export async function createLocalRegistryFetch(baseUrl: string, tarballs: LocalTarball[]): Promise<FetchLike> {
  const base = new URL(baseUrl);
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  const versions: LocalVersion[] = [];
  for (const tarball of tarballs) {
    const manifest = await readPackageJson(tarball.bytes);
    versions.push({
      name: manifest.name as string,
      version: manifest.version as string,
      manifest,
      bytes: tarball.bytes,
      integrity: await computeSha512Integrity(tarball.bytes),
      publishedAt: (tarball.publishedAt ?? new Date()).toISOString(),
    });
  }

  const tarballUrl = (entry: LocalVersion) =>
    new URL(`${packumentPath(entry.name)}/-/${tarballFileName(entry.name, entry.version)}`, base).href;

  function packument(name: string) {
    const entries = versions.filter((entry) => entry.name === name);
    if (entries.length === 0) return null;
    const latest = entries[entries.length - 1] as LocalVersion;
    return {
      name,
      "dist-tags": { latest: latest.version },
      versions: Object.fromEntries(
        entries.map((entry) => [
          entry.version,
          { ...entry.manifest, dist: { tarball: tarballUrl(entry), integrity: entry.integrity } },
        ]),
      ),
      time: Object.fromEntries(entries.map((entry) => [entry.version, entry.publishedAt])),
    };
  }

  return async (input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.origin !== base.origin) return new Response("unknown host", { status: 502 });
    const path = url.pathname.slice(base.pathname.length);

    if (path === "-/v1/search") {
      const keyword = (url.searchParams.get("text") ?? "").replace(/^keywords:/, "");
      const from = Number(url.searchParams.get("from") ?? "0");
      const size = Number(url.searchParams.get("size") ?? "20");
      const latestByName = new Map<string, LocalVersion>();
      for (const entry of versions) {
        const keywords = Array.isArray(entry.manifest.keywords) ? entry.manifest.keywords : [];
        if (keywords.includes(keyword)) latestByName.set(entry.name, entry);
      }
      const all = [...latestByName.values()];
      return Response.json({
        objects: all.slice(from, from + size).map((entry) => ({ package: { name: entry.name, version: entry.version } })),
        total: all.length,
      });
    }

    const tarball = versions.find((entry) => new URL(tarballUrl(entry)).pathname === url.pathname);
    if (tarball) {
      return new Response(tarball.bytes, {
        headers: { "Content-Type": "application/octet-stream", "Content-Length": String(tarball.bytes.byteLength) },
      });
    }

    const name = decodeURIComponent(path);
    const document = packument(name);
    return document ? Response.json(document) : Response.json({ error: "Not found" }, { status: 404 });
  };
}
