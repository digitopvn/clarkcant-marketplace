import { packageNameSchema } from "@marketplace/contracts";
import { z } from "zod";

import { IndexingRejectedError } from "./indexing-errors";

/**
 * Read-only client for an npm registry. The base URL and `fetch` are injectable so tests (and the local dev path)
 * serve a real tarball and a packument derived from it, while production talks to registry.npmjs.org.
 *
 * Everything the registry returns is untrusted input: responses are size-capped and validated here, at the
 * boundary, before any field reaches the indexer.
 */

export const NPM_REGISTRY_URL = "https://registry.npmjs.org/";

export const MAX_PACKUMENT_BYTES = 16 * 1024 * 1024;
export const MAX_TARBALL_BYTES = 25 * 1024 * 1024;
const MAX_SEARCH_BYTES = 4 * 1024 * 1024;

export type FetchLike = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;

export interface NpmRegistryOptions {
  baseUrl?: string;
  fetch?: FetchLike;
}

const optionalText = z.string().max(2000).optional().catch(undefined);

const packumentVersionSchema = z.object({
  name: z.string(),
  version: z.string(),
  description: optionalText,
  keywords: z.array(z.string().max(100)).max(100).optional().catch(undefined),
  homepage: optionalText,
  license: z.union([z.string().max(200), z.object({ type: z.string().max(200) })]).optional().catch(undefined),
  repository: z.union([z.string().max(2000), z.object({ url: z.string().max(2000) })]).optional().catch(undefined),
  scripts: z.record(z.string(), z.string()).optional().catch(undefined),
  dist: z.object({
    tarball: z.string().max(2000),
    integrity: z.string().max(2000).optional(),
    shasum: z.string().max(200).optional(),
    attestations: z
      .object({ url: z.string().max(2000), provenance: z.object({ predicateType: z.string().max(300) }).optional() })
      .optional()
      .catch(undefined),
    signatures: z
      .array(z.object({ keyid: z.string().max(300), sig: z.string().max(4000) }))
      .max(20)
      .optional()
      .catch(undefined),
  }),
});
export type PackumentVersion = z.infer<typeof packumentVersionSchema>;

const packumentSchema = z.object({
  name: z.string(),
  "dist-tags": z.record(z.string(), z.string()).default({}),
  versions: z.record(z.string(), z.unknown()).default({}),
  time: z.record(z.string(), z.string()).default({}),
});
export type Packument = z.infer<typeof packumentSchema>;

const searchResponseSchema = z.object({
  objects: z.array(z.object({ package: z.object({ name: z.string(), version: z.string() }) })),
  total: z.number().int().nonnegative(),
});
export type NpmSearchHit = { name: string; version: string };

/** Facts about one resolved version that the rest of the pipeline needs. Plain JSON: it crosses Workflow steps. */
export interface ResolvedVersion {
  name: string;
  version: string;
  /** The `latest` dist-tag at resolution time, if any. */
  latestTag: string | null;
  tarballUrl: string;
  integrity: string;
  publishedAt: string | null;
  description: string | null;
  keywords: string[];
  homepage: string | null;
  repositoryUrl: string | null;
  license: string | null;
  /** Present when npm lists Sigstore attestations for the version. Recorded, not cryptographically verified here. */
  provenance: { attestationsUrl: string; predicateType: string | null } | null;
  /** Key ids of npm registry signatures listed for the version. */
  registrySignatureKeyIds: string[];
  /** npm lifecycle scripts that run on `npm install` (preinstall, install, postinstall, prepare). */
  installScripts: string[];
}

export interface NpmRegistry {
  readonly baseUrl: URL;
  fetchPackument(name: string): Promise<Packument>;
  fetchTarball(url: string): Promise<Uint8Array>;
  search(text: string, from: number, size: number): Promise<{ hits: NpmSearchHit[]; total: number }>;
}

/** Registry path for a package: scoped names keep `@` and encode the slash (`@scope%2fname`). */
export function packumentPath(name: string): string {
  return name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
}

async function readCapped(
  response: Response,
  maxBytes: number,
  what: string,
  code: "tarball_too_large" | "invalid_packument" = "invalid_packument",
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("Content-Length") ?? "0");
  if (declared > maxBytes) {
    await response.body?.cancel();
    throw new IndexingRejectedError(code, `${what} is ${declared} bytes; the limit is ${maxBytes}`);
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new IndexingRejectedError(code, `${what} exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Non-404 failures are thrown as plain errors so the caller's retry policy applies. */
function transientFailure(what: string, response: Response): Error {
  return new Error(`${what} failed with HTTP ${response.status}`);
}

export function createNpmRegistry(options: NpmRegistryOptions = {}): NpmRegistry {
  const baseUrl = new URL(options.baseUrl ?? NPM_REGISTRY_URL);
  if (!baseUrl.pathname.endsWith("/")) baseUrl.pathname += "/";
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));

  return {
    baseUrl,

    async fetchPackument(name) {
      const valid = packageNameSchema.parse(name);
      const response = await doFetch(new URL(packumentPath(valid), baseUrl), {
        headers: { Accept: "application/json" },
      });
      if (response.status === 404) {
        await response.body?.cancel();
        throw new IndexingRejectedError("package_not_found", `npm has no package named "${valid}"`);
      }
      if (!response.ok) throw transientFailure(`packument request for ${valid}`, response);
      const bytes = await readCapped(response, MAX_PACKUMENT_BYTES, "packument");
      let json: unknown;
      try {
        json = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        throw new IndexingRejectedError("invalid_packument", "the registry returned a packument that is not JSON");
      }
      const parsed = packumentSchema.safeParse(json);
      if (!parsed.success || parsed.data.name !== valid) {
        throw new IndexingRejectedError("invalid_packument", `the registry returned an unexpected packument for "${valid}"`);
      }
      return parsed.data;
    },

    async fetchTarball(url) {
      const target = new URL(url);
      // Tarballs are only ever fetched from the registry that described them; a packument cannot point us elsewhere.
      if (target.origin !== baseUrl.origin) {
        throw new IndexingRejectedError("untrusted_tarball_url", `tarball URL is not on ${baseUrl.origin}`, { url });
      }
      const response = await doFetch(target, { headers: { Accept: "application/octet-stream" } });
      if (response.status === 404) {
        await response.body?.cancel();
        throw new IndexingRejectedError("version_not_found", "the registry has no tarball at the published URL", { url });
      }
      if (!response.ok) throw transientFailure("tarball download", response);
      return readCapped(response, MAX_TARBALL_BYTES, "tarball", "tarball_too_large");
    },

    async search(text, from, size) {
      const url = new URL("-/v1/search", baseUrl);
      url.searchParams.set("text", text);
      url.searchParams.set("from", String(from));
      url.searchParams.set("size", String(size));
      const response = await doFetch(url, { headers: { Accept: "application/json" } });
      if (!response.ok) throw transientFailure("npm search", response);
      const bytes = await readCapped(response, MAX_SEARCH_BYTES, "search response");
      const parsed = searchResponseSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
      return {
        hits: parsed.objects.map((object) => ({ name: object.package.name, version: object.package.version })),
        total: parsed.total,
      };
    },
  };
}

function httpUrlOrNull(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

/** `git+https://github.com/a/b.git`, `github:a/b` and `a/b` shorthand become browsable https URLs. */
export function normalizeRepositoryUrl(repository: PackumentVersion["repository"]): string | null {
  const raw = typeof repository === "string" ? repository : repository?.url;
  if (!raw) return null;
  const shorthand = /^(?:github:)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(raw);
  if (shorthand) return `https://github.com/${shorthand[1]}/${shorthand[2]}`;
  const cleaned = raw
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^ssh:\/\/git@/, "https://")
    .replace(/\.git$/, "");
  return httpUrlOrNull(cleaned);
}

const INSTALL_SCRIPT_NAMES = ["preinstall", "install", "postinstall", "prepare"];

/**
 * Picks the exact version to index: the requested one, or the `latest` dist-tag. Ranges are never resolved; an
 * install coordinate is always one exact published version.
 */
export function resolveVersion(packument: Packument, requested: string | null): ResolvedVersion {
  const latestTag = packument["dist-tags"].latest ?? null;
  const version = requested ?? latestTag;
  if (!version) {
    throw new IndexingRejectedError("version_not_found", `"${packument.name}" has no latest dist-tag to index`);
  }
  const raw = packument.versions[version];
  if (raw === undefined) {
    throw new IndexingRejectedError("version_not_found", `"${packument.name}" has no published version ${version}`);
  }
  const parsed = packumentVersionSchema.safeParse(raw);
  if (!parsed.success || parsed.data.version !== version) {
    throw new IndexingRejectedError("invalid_packument", `version ${version} of "${packument.name}" is malformed`);
  }
  const entry = parsed.data;
  if (!entry.dist.integrity) {
    throw new IndexingRejectedError("missing_integrity", `version ${version} has no dist.integrity`);
  }
  const publishedAt = packument.time[version];
  const license = typeof entry.license === "string" ? entry.license : (entry.license?.type ?? null);

  return {
    name: packument.name,
    version,
    latestTag,
    tarballUrl: entry.dist.tarball,
    integrity: entry.dist.integrity,
    publishedAt: publishedAt && !Number.isNaN(Date.parse(publishedAt)) ? new Date(publishedAt).toISOString() : null,
    description: entry.description?.trim() || null,
    keywords: [...new Set((entry.keywords ?? []).map((keyword) => keyword.trim().toLowerCase()).filter(Boolean))].slice(0, 30),
    homepage: httpUrlOrNull(entry.homepage),
    repositoryUrl: normalizeRepositoryUrl(entry.repository),
    license: license?.trim() || null,
    provenance: entry.dist.attestations
      ? {
          attestationsUrl: entry.dist.attestations.url,
          predicateType: entry.dist.attestations.provenance?.predicateType ?? null,
        }
      : null,
    registrySignatureKeyIds: (entry.dist.signatures ?? []).map((signature) => signature.keyid),
    installScripts: INSTALL_SCRIPT_NAMES.filter((script) => typeof entry.scripts?.[script] === "string"),
  };
}
