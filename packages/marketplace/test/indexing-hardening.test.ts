import type { IngestMessage } from "@marketplace/contracts";
import { packageSubmissions } from "@marketplace/db";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import {
  MAX_QUEUED_PER_RUN,
  MAX_README_BYTES,
  MAX_README_HTML_BYTES,
  compareSemver,
  createLocalRegistryFetch,
  createMarketplaceDeps,
  createNpmRegistry,
  discoverNpmPackages,
  getPackage,
  indexPackage,
  readPackageArchive,
  readTar,
  readTarGz,
  submitPackage,
  type MarketplaceDeps,
  type NpmRegistry,
  type StepRunner,
} from "../src";
import { FIXTURE_NAME, REGISTRY_URL, createAccount, fixtureRegistry, fixtureTarball, indexingDeps, resetIndexingState } from "./support/indexing-fixtures";
import { instrumentD1 } from "./support/instrumented-d1";
import { buildTar, gzip, streamOf, type TarInput } from "./support/tar-builder";

let deps: MarketplaceDeps;

beforeEach(async () => {
  deps = indexingDeps();
  await resetIndexingState(deps);
});

function recordingQueue(): { queue: Queue<IngestMessage>; sent: IngestMessage[] } {
  const sent: IngestMessage[] = [];
  // The producer surface the marketplace uses is `send`; a structural double avoids a real queue in tests.
  const queue = { send: async (message: IngestMessage) => void sent.push(message) } as unknown as Queue<IngestMessage>;
  return { queue, sent };
}

/** A registry whose search returns `hits`; nothing else is expected to be called. */
function searchOnlyRegistry(hits: { name: string; version: string }[]): NpmRegistry {
  return {
    baseUrl: new URL(REGISTRY_URL),
    fetchPackument: () => Promise.reject(new Error("discovery must not fetch packuments")),
    fetchTarball: () => Promise.reject(new Error("discovery must not download tarballs")),
    search: async (text, from, size) => {
      const keyword = text.replace(/^keywords:/, "");
      const matching = hits.filter((_, index) => (index % 2 === 0 ? "clarkcant" : "clarkcant-widget") === keyword);
      return { hits: matching.slice(from, from + size), total: matching.length };
    },
  };
}

async function submissionRows() {
  return deps.db.select().from(packageSubmissions);
}

describe("discovery", () => {
  it("does not resubmit a version whose submission failed; an explicit submission still can", async () => {
    const now = deps.now();
    await deps.db.insert(packageSubmissions).values({
      id: deps.ids("sub"),
      packageName: "@acme/broken",
      version: "1.0.0",
      status: "failed",
      error: "manifest_missing: the package has no clarkcant.json",
      createdAt: now,
      updatedAt: now,
    });
    const { queue, sent } = recordingQueue();
    const registry = searchOnlyRegistry([
      { name: "@acme/broken", version: "1.0.0" },
      { name: "@acme/broken-next", version: "2.0.0" },
    ]);

    expect(await discoverNpmPackages({ ...deps, queue }, { registry })).toEqual({ seen: 2, queued: 1, pending: 0 });
    expect(sent.map((message) => message.type === "index-package" && message.packageName)).toEqual(["@acme/broken-next"]);
    // A newer version of the failed package is a new fact and is discovered normally.
    const bumped = searchOnlyRegistry([{ name: "@acme/broken", version: "1.0.1" }]);
    expect(await discoverNpmPackages({ ...deps, queue }, { registry: bumped })).toMatchObject({ queued: 1 });

    const actor = await createAccount(deps);
    const explicit = await submitPackage(deps, actor, { name: "@acme/broken", version: "1.0.0" }, { enqueue: false });
    expect(explicit.created).toBe(true);
  });

  it("stays within D1's per-invocation query budget and continues on the next run", async () => {
    const hits = Array.from({ length: 2000 }, (_, index) => ({ name: `@bulk/pkg-${index}`, version: "1.0.0" }));
    const registry = searchOnlyRegistry(hits);
    const { queue, sent } = recordingQueue();
    const instrumented = instrumentD1(env.DB);
    const measured = { ...createMarketplaceDeps({ d1: instrumented.d1 }), queue };

    expect(await discoverNpmPackages(measured, { registry })).toEqual({ seen: 2000, queued: MAX_QUEUED_PER_RUN, pending: 1900 });
    expect(instrumented.executed.length).toBeLessThan(500);
    expect(instrumented.maxBoundParameters()).toBeLessThanOrEqual(100);

    expect(await discoverNpmPackages(measured, { registry })).toEqual({ seen: 2000, queued: MAX_QUEUED_PER_RUN, pending: 1800 });
    expect(new Set(sent.map((message) => message.type === "index-package" && message.packageName)).size).toBe(200);
    expect(await submissionRows()).toHaveLength(200);
  });
});

describe("latest version", () => {
  it("orders versions by semver precedence", () => {
    const ordered = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.10.0", "2.0.0"];
    for (let index = 1; index < ordered.length; index += 1) {
      expect(compareSemver(ordered[index - 1] ?? "", ordered[index] ?? "")).toBeLessThan(0);
      expect(compareSemver(ordered[index] ?? "", ordered[index - 1] ?? "")).toBeGreaterThan(0);
    }
    expect(compareSemver("1.0.0+build.1", "1.0.0+build.2")).toBe(0);
    expect(compareSemver("not-a-version", "0.0.1")).toBeLessThan(0);
  });

  it("a stale run that resolved an older latest never moves latestVersion backwards", async () => {
    const stale = await fixtureRegistry([{ variant: "valid" }]);
    const current = await fixtureRegistry([{ variant: "valid" }, { variant: "nextVersion" }]);
    const actor = await createAccount(deps);
    const submit = async () => (await submitPackage(deps, actor, { name: FIXTURE_NAME }, { enqueue: false })).submission.id;

    const staleSubmission = await submit();
    // While the stale run (which saw 1.0.0 as latest) waits before finalize, 1.1.0 is indexed to completion.
    const runStep: StepRunner = async (name, run) => {
      if (name === "finalize") {
        const fresh = await submit();
        await expect(indexPackage(deps, { submissionId: fresh, packageName: FIXTURE_NAME }, { registry: current })).resolves.toMatchObject({
          status: "indexed",
          version: "1.1.0",
        });
      }
      return run();
    };
    await expect(
      indexPackage(deps, { submissionId: staleSubmission, packageName: FIXTURE_NAME }, { registry: stale, runStep }),
    ).resolves.toMatchObject({ status: "indexed", version: "1.0.0" });

    expect((await getPackage(deps, FIXTURE_NAME)).latestVersion).toBe("1.1.0");
  });
});

/** A copy of the example widget tarball with extra files, so it passes every check except the one under test. */
async function exampleTarballWith(extra: TarInput[]): Promise<Uint8Array> {
  const kept = await readTarGz(fixtureTarball("valid"), {
    select: (path) => (path === "package/package.json" || path === "package/clarkcant.json" ? 256 * 1024 : null),
  });
  const base = kept.map((entry) => ({ path: entry.path, content: entry.bytes ?? new Uint8Array() }));
  return gzip(buildTar([...base, ...extra]));
}

async function indexTarball(tarball: Uint8Array) {
  const fetch = await createLocalRegistryFetch(REGISTRY_URL, [{ bytes: tarball }]);
  const registry = createNpmRegistry({ baseUrl: REGISTRY_URL, fetch });
  const actor = await createAccount(deps);
  const { submission } = await submitPackage(deps, actor, { name: FIXTURE_NAME }, { enqueue: false });
  return indexPackage(deps, { submissionId: submission.id, packageName: FIXTURE_NAME }, { registry });
}

describe("README limits", () => {
  it("omits an oversized README with a recorded reason instead of failing the version", async () => {
    const readme = `# Big\n\n${"word ".repeat(MAX_README_BYTES / 5 + 100)}`;
    const result = await indexTarball(await exampleTarballWith([{ path: "package/README.md", content: readme }]));
    expect(result).toMatchObject({ status: "indexed" });

    const latest = (await getPackage(deps, FIXTURE_NAME)).latest;
    expect(latest?.readmeHtml).toBeNull();
    const check = latest?.securityChecks.find((entry) => entry.check === "readme");
    expect(check).toMatchObject({ result: "warn" });
    expect(JSON.stringify(check?.details)).toContain(`the limit is ${MAX_README_BYTES}`);
  });

  it("omits README HTML that renders larger than the stored limit", async () => {
    // Link-dense Markdown expands more than tenfold once rendered with absolute URLs and rel attributes.
    const readme = "[a](b) ".repeat(6000);
    const result = await indexTarball(await exampleTarballWith([{ path: "package/README.md", content: readme }]));
    expect(result).toMatchObject({ status: "indexed" });

    const latest = (await getPackage(deps, FIXTURE_NAME)).latest;
    expect(latest?.readmeHtml).toBeNull();
    const check = latest?.securityChecks.find((entry) => entry.check === "readme");
    expect(JSON.stringify(check?.details)).toContain(`the limit is ${MAX_README_HTML_BYTES}`);
  });
});

describe("archive memory bounds", () => {
  const png = (label: string) => new TextEncoder().encode(`not really a png: ${label}`);

  it("keeps the cover and at most seven other previews, and only the first copy of a path", async () => {
    const previews: TarInput[] = Array.from({ length: 20 }, (_, index) => ({
      path: `package/previews/shot-${String(index).padStart(2, "0")}.png`,
      content: png(`shot ${index}`),
    }));
    const tarball = await exampleTarballWith([
      ...previews,
      { path: "package/previews/shot-00.png", content: png("duplicate") },
      { path: "package/previews/cover.png", content: png("cover") },
      { path: "package/README.md", content: "# First" },
      { path: "package/README.md", content: "# Second" },
    ]);
    const archive = await readPackageArchive(tarball);
    expect(archive.previews.map((preview) => preview.path)).toEqual([
      "previews/cover.png",
      ...previews.slice(0, 7).map((preview) => preview.path.slice("package/".length)),
    ]);
    expect(new TextDecoder().decode(archive.previews[1]?.bytes)).toBe("not really a png: shot 0");
    expect(archive.readme).toEqual({ path: "README.md", text: "# First" });
  });

  it("records an oversized README as omitted rather than dropping it silently", async () => {
    const archive = await readPackageArchive(
      await exampleTarballWith([{ path: "package/README.md", content: new Uint8Array(MAX_README_BYTES + 1) }]),
    );
    expect(archive.readme).toBeNull();
    expect(archive.readmeOmitted).toMatchObject({ path: "README.md", size: MAX_README_BYTES + 1 });
  });

  it("fails an archive whose selected entries exceed the kept-bytes budget", async () => {
    const tar = buildTar([
      { path: "package/a.bin", content: new Uint8Array(600) },
      { path: "package/b.bin", content: new Uint8Array(600) },
    ]);
    await expect(
      readTar(streamOf(tar, 64), { select: () => 1024 }, { maxEntries: 10, maxTotalBytes: 1e6, maxKeptBytes: 1000 }),
    ).rejects.toThrow(/exceed 1000 bytes/);
    const entries = await readTar(streamOf(tar, 64), { select: () => 1024 }, { maxEntries: 10, maxTotalBytes: 1e6, maxKeptBytes: 1200 });
    expect(entries.map((entry) => entry.bytes?.length)).toEqual([600, 600]);
  });
});

describe("registry input", () => {
  it("rejects a malformed tarball URL permanently instead of retrying it", async () => {
    const registry = createNpmRegistry({ baseUrl: REGISTRY_URL, fetch: () => Promise.reject(new Error("no network")) });
    await expect(registry.fetchTarball("http://[not a url")).rejects.toMatchObject({ code: "invalid_packument" });
  });
});
