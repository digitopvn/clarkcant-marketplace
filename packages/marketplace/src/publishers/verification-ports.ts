import { MarketplaceError } from "@marketplace/contracts";
import { z } from "zod";

/**
 * Network lookups that publisher verification needs. Services take them as a parameter so tests (and other
 * runtimes) can supply their own; `createHttpVerificationPorts` is the production implementation.
 */
export interface VerificationPorts {
  /** TXT record strings for `name`; empty when the name has none. */
  resolveTxt(name: string): Promise<string[]>;
  /** Text of `path` on the repository's default branch, or null when it does not exist. */
  fetchRepositoryFile(provider: "github", repository: string, path: string): Promise<string | null>;
  /** npm maintainers of a package, or null when the package does not exist on the registry. */
  fetchNpmMaintainers(packageName: string): Promise<{ name: string; email: string | null }[] | null>;
}

const REQUEST_TIMEOUT_MS = 8_000;

const dnsJsonSchema = z.object({
  Status: z.number(),
  Answer: z.array(z.object({ type: z.number(), data: z.string() })).optional(),
});

const npmPackumentSchema = z.object({
  maintainers: z
    .array(z.object({ name: z.string(), email: z.string().optional() }))
    .optional()
    .default([]),
});

const TXT_RECORD_TYPE = 16;

async function fetchWithTimeout(fetcher: typeof fetch, url: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetcher(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (cause) {
    throw new MarketplaceError("internal_error", `Verification lookup failed: ${new URL(url).host} is unreachable`, {
      cause,
    });
  }
}

/** DNS over HTTPS (Cloudflare's JSON API), GitHub raw content and the npm registry. */
export function createHttpVerificationPorts(fetcher: typeof fetch = fetch): VerificationPorts {
  return {
    async resolveTxt(name) {
      const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`;
      const response = await fetchWithTimeout(fetcher, url, { headers: { accept: "application/dns-json" } });
      if (!response.ok) throw new MarketplaceError("internal_error", `DNS lookup failed with HTTP ${response.status}`);
      const body = dnsJsonSchema.parse(await response.json());
      return (body.Answer ?? [])
        .filter((answer) => answer.type === TXT_RECORD_TYPE)
        .map((answer) => joinTxtStrings(answer.data));
    },

    async fetchRepositoryFile(_provider, repository, path) {
      const url = `https://raw.githubusercontent.com/${repository}/HEAD/${path}`;
      const response = await fetchWithTimeout(fetcher, url);
      if (response.status === 404) return null;
      if (!response.ok) throw new MarketplaceError("internal_error", `GitHub returned HTTP ${response.status}`);
      return (await response.text()).slice(0, 4096);
    },

    async fetchNpmMaintainers(packageName) {
      const url = `https://registry.npmjs.org/${packageName.replace("/", "%2F")}`;
      const response = await fetchWithTimeout(fetcher, url, { headers: { accept: "application/json" } });
      if (response.status === 404) return null;
      if (!response.ok) throw new MarketplaceError("internal_error", `npm registry returned HTTP ${response.status}`);
      const body = npmPackumentSchema.parse(await response.json());
      return body.maintainers.map((maintainer) => ({ name: maintainer.name, email: maintainer.email ?? null }));
    },
  };
}

/** DoH returns TXT data as one or more quoted character-strings: `"part one" "part two"`. */
export function joinTxtStrings(data: string): string {
  const parts = [...data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => (match[1] ?? "").replace(/\\(.)/g, "$1"));
  return parts.length > 0 ? parts.join("") : data;
}
