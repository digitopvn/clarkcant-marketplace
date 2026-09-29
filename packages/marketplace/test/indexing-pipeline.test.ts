import type { IngestMessage } from "@marketplace/contracts";
import { auditEvents, media, packageSubmissions, packageVersions } from "@marketplace/db";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import {
  computeSha512Integrity,
  createLocalRegistryFetch,
  createNpmRegistry,
  discoverNpmPackages,
  getPackage,
  getPackageInstall,
  handleIngestMessage,
  indexPackage,
  listPackageVersions,
  listPackages,
  readPackageArchive,
  searchPackages,
  submitPackage,
  type FetchLike,
  type MarketplaceDeps,
  type NpmRegistry,
} from "../src";
import { validateManifest } from "../src/indexing/manifest-validation";
import {
  FIXTURE_NAME,
  REGISTRY_URL,
  createAccount,
  fixtureRegistry,
  fixtureTarball,
  indexingDeps,
  resetIndexingState,
} from "./support/indexing-fixtures";

let deps: MarketplaceDeps;

beforeEach(async () => {
  deps = indexingDeps();
  await resetIndexingState(deps);
});

async function queueSubmission(name: string, version?: string): Promise<string> {
  const actor = await createAccount(deps);
  const { submission } = await submitPackage(deps, actor, { name, version }, { enqueue: false });
  return submission.id;
}

async function indexFixture(registry: NpmRegistry, name = FIXTURE_NAME, version?: string) {
  const submissionId = await queueSubmission(name, version);
  return { submissionId, result: await indexPackage(deps, { submissionId, packageName: name }, { registry }) };
}

async function submissionRow(id: string) {
  const [row] = await deps.db.select().from(packageSubmissions).where(eq(packageSubmissions.id, id));
  return row;
}

async function auditActions(): Promise<string[]> {
  const rows = await deps.db.select({ action: auditEvents.action }).from(auditEvents).orderBy(auditEvents.createdAt);
  return rows.map((row) => row.action);
}

describe("indexing the example widget from a real npm pack tarball", () => {
  it("publishes a listing with facets, permissions, previews, checks and a sanitized README", async () => {
    const { submissionId, result } = await indexFixture(await fixtureRegistry([{ variant: "valid" }]));
    expect(result).toMatchObject({ status: "indexed", version: "1.0.0", created: true });

    const detail = await getPackage(deps, FIXTURE_NAME);
    expect(detail).toMatchObject({
      displayName: "Example frame widget",
      latestVersion: "1.0.0",
      categorySlug: "widgets",
      curationStatus: "listed",
      license: "MIT",
      repositoryUrl: "https://github.com/digitopvn/clarkcant-marketplace",
    });
    const latest = detail.latest;
    expect(latest?.npmIntegrity).toBe(await computeSha512Integrity(fixtureTarball("valid")));
    expect(latest?.tarballSha512Verified).toBe(true);
    expect(latest?.platforms).toEqual(["darwin-arm64", "linux-x64", "win32-x64", "web"]);
    expect(latest?.facets).toEqual([
      { kind: "widget", isolation: "isolated-ui", renderer: null, entry: "widgets/main/index.html", widgetId: expect.any(String) },
    ]);
    expect(latest?.permissions).toEqual([]);
    expect(latest?.securityChecks.map((check) => [check.check, check.result])).toEqual(
      expect.arrayContaining([
        ["integrity", "pass"],
        ["provenance", "warn"],
        ["install-scripts", "pass"],
      ]),
    );

    const previews = latest?.previews ?? [];
    expect(previews.map((preview) => [preview.kind, preview.contentType, preview.width, preview.height])).toEqual([
      ["image", "image/png", 600, 315],
      ["social_card", "image/svg+xml", 1200, 630],
    ]);
    for (const preview of previews) {
      const key = preview.url.replace(/^\/media\//, "");
      expect(await env.MEDIA.head(key)).not.toBeNull();
    }

    const readme = latest?.readmeHtml ?? "";
    expect(readme).toContain("<h1>Example frame widget</h1>");
    expect(readme).toContain(`src="https://cdn.jsdelivr.net/npm/${FIXTURE_NAME}@1.0.0/previews/cover.png"`);
    expect(readme).toContain(`href="https://cdn.jsdelivr.net/npm/${FIXTURE_NAME}@1.0.0/widgets/main/widget.json"`);
    expect(readme).toContain('rel="nofollow ugc noopener noreferrer"');
    expect(readme).not.toMatch(/<script|<iframe|\son\w+=/i);

    expect(await submissionRow(submissionId)).toMatchObject({ status: "indexed", error: null });
    expect(await auditActions()).toEqual(["package.submitted", "package.indexed"]);

    const search = await searchPackages(deps, { q: "frame" });
    expect(search.items.map((item) => item.name)).toEqual([FIXTURE_NAME]);
    const install = await getPackageInstall(deps, FIXTURE_NAME);
    expect(install).toEqual({
      package: FIXTURE_NAME,
      version: "1.0.0",
      source: "npm",
      integrity: latest?.npmIntegrity,
      openInClarkCant: "clarkcant://install?source=npm&package=%40clarkcant%2Fexample-frame-widget&version=1.0.0",
      cliCommand: `npm pack ${FIXTURE_NAME}@1.0.0`,
    });
  });

  it("supports the listing filters on indexed facts", async () => {
    await indexFixture(await fixtureRegistry([{ variant: "valid" }]));
    const names = async (query: Parameters<typeof listPackages>[1]) =>
      (await listPackages(deps, query)).items.map((item) => item.name);
    expect(await names({ platform: "web" })).toEqual([FIXTURE_NAME]);
    expect(await names({ platform: "linux-arm64" })).toEqual([]);
    expect(await names({ kind: "widget", isolation: "isolated-ui" })).toEqual([FIXTURE_NAME]);
    expect(await names({ isolation: "trusted-native" })).toEqual([]);
    expect(await names({ curation: "listed", category: "widgets" })).toEqual([FIXTURE_NAME]);
    expect(await names({ curation: "featured" })).toEqual([]);
    expect(await names({ publisher: "someone-else" })).toEqual([]);
  });
});

describe("versions are immutable", () => {
  it("re-indexing an indexed version downloads nothing and rewrites nothing", async () => {
    const registry = await fixtureRegistry([{ variant: "valid" }]);
    await indexFixture(registry);
    const [before] = await deps.db.select().from(packageVersions);

    const noDownloads: NpmRegistry = {
      ...registry,
      fetchPackument: (name) => registry.fetchPackument(name),
      search: (text, from, size) => registry.search(text, from, size),
      fetchTarball: () => Promise.reject(new Error("an indexed version must not be downloaded again")),
    };
    const { submissionId, result } = await indexFixture(noDownloads, FIXTURE_NAME, "1.0.0");
    expect(result).toMatchObject({ status: "indexed", created: false });
    expect(await submissionRow(submissionId)).toMatchObject({ status: "indexed" });
    expect(await deps.db.select().from(packageVersions)).toEqual([before]);
    expect(await deps.db.select({ id: media.id }).from(media)).toHaveLength(2);
  });

  it("the database refuses to rewrite a version's integrity", async () => {
    await indexFixture(await fixtureRegistry([{ variant: "valid" }]));
    await expect(
      deps.db.update(packageVersions).set({ npmIntegrity: "sha512-forged" }),
    ).rejects.toThrow();
  });

  it("a newer version becomes latest while the old one stays listed", async () => {
    const registry = await fixtureRegistry([
      { variant: "valid", publishedAt: new Date("2026-09-01T00:00:00Z") },
      { variant: "nextVersion", publishedAt: new Date("2026-09-20T00:00:00Z") },
    ]);
    await indexFixture(registry, FIXTURE_NAME, "1.0.0");
    const { result } = await indexFixture(registry);
    expect(result).toMatchObject({ status: "indexed", version: "1.1.0", created: true });
    expect((await getPackage(deps, FIXTURE_NAME)).latestVersion).toBe("1.1.0");
    expect((await listPackageVersions(deps, FIXTURE_NAME)).map((version) => version.version)).toEqual(["1.1.0", "1.0.0"]);
    await expect(getPackageInstall(deps, FIXTURE_NAME, "1.0.0")).resolves.toMatchObject({ version: "1.0.0" });
  });

  it("indexing an older version never moves latest backwards", async () => {
    const registry = await fixtureRegistry([{ variant: "valid" }, { variant: "nextVersion" }]);
    await indexFixture(registry);
    await indexFixture(registry, FIXTURE_NAME, "1.0.0");
    expect((await getPackage(deps, FIXTURE_NAME)).latestVersion).toBe("1.1.0");
  });
});

describe("rejections are recorded with a reason", () => {
  it("rejects a tarball whose bytes do not match the published integrity", async () => {
    const honest = await createLocalRegistryFetch(REGISTRY_URL, [{ bytes: fixtureTarball("valid") }]);
    const tampering: FetchLike = async (input, init) => {
      const response = await honest(input, init);
      if (!String(input instanceof Request ? input.url : input).endsWith(".tgz")) return response;
      const bytes = new Uint8Array(await response.arrayBuffer());
      bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
      return new Response(bytes);
    };
    const { submissionId, result } = await indexFixture(createNpmRegistry({ baseUrl: REGISTRY_URL, fetch: tampering }));
    expect(result).toMatchObject({ status: "rejected", code: "integrity_mismatch" });
    expect(await deps.db.select().from(packageVersions)).toEqual([]);
    expect((await submissionRow(submissionId))?.error).toMatch(/^integrity_mismatch: /);
    expect(await auditActions()).toEqual(["package.submitted", "package.index_rejected"]);
  });

  it("rejects a package without clarkcant.json", async () => {
    const { submissionId, result } = await indexFixture(
      await fixtureRegistry([{ variant: "missingManifest" }]),
      "@clarkcant/example-no-manifest",
    );
    expect(result).toMatchObject({ status: "rejected", code: "manifest_missing" });
    expect(await submissionRow(submissionId)).toMatchObject({ status: "failed" });
  });

  it("rejects a manifest that breaks the ClarkCant contract, naming the field", async () => {
    const { result } = await indexFixture(
      await fixtureRegistry([{ variant: "invalidManifest" }]),
      "@clarkcant/example-bad-manifest",
    );
    expect(result).toMatchObject({ status: "rejected", code: "manifest_invalid" });
    expect(result.status === "rejected" ? result.reason : "").toContain("facets.0.isolation");
  });

  it("rejects unknown packages and versions", async () => {
    const registry = await fixtureRegistry([{ variant: "valid" }]);
    expect((await indexFixture(registry, "@clarkcant/does-not-exist")).result).toMatchObject({ code: "package_not_found" });
    expect((await indexFixture(registry, FIXTURE_NAME, "9.9.9")).result).toMatchObject({ code: "version_not_found" });
  });

  it("validates manifests: invalid JSON, contract failures and version mismatch", async () => {
    expect(() => validateManifest("{ nope", "1.0.0")).toThrow(expect.objectContaining({ code: "manifest_invalid" }));
    expect(() => validateManifest(JSON.stringify({ schemaVersion: 1 }), "1.0.0")).toThrow(
      expect.objectContaining({ code: "manifest_invalid" }),
    );
    const { manifestText } = await readPackageArchive(fixtureTarball("valid"));
    expect(validateManifest(manifestText, "1.0.0").normalized.version).toBe("1.0.0");
    expect(() => validateManifest(manifestText, "2.0.0")).toThrow(expect.objectContaining({ code: "manifest_mismatch" }));
  });

  it("records a transient failure and rethrows it so the runner retries", async () => {
    const down = createNpmRegistry({ baseUrl: REGISTRY_URL, fetch: async () => new Response("bad gateway", { status: 502 }) });
    const submissionId = await queueSubmission(FIXTURE_NAME);
    await expect(indexPackage(deps, { submissionId, packageName: FIXTURE_NAME }, { registry: down })).rejects.toThrow();
    expect(await submissionRow(submissionId)).toMatchObject({ status: "failed" });
    expect(await auditActions()).toContain("package.index_failed");
  });
});

describe("discovery and the ingest queue", () => {
  function recordingQueue(): { queue: Queue<IngestMessage>; sent: IngestMessage[] } {
    const sent: IngestMessage[] = [];
    const queue = {
      send: async (message: IngestMessage) => {
        sent.push(message);
      },
      sendBatch: async (messages: Iterable<MessageSendRequest<IngestMessage>>) => {
        for (const message of messages) sent.push(message.body);
      },
      // The producer surface the marketplace uses is `send`; a structural double avoids a real queue in tests.
    } as unknown as Queue<IngestMessage>;
    return { queue, sent };
  }

  it("queues every unseen ClarkCant package once, then indexes it from the queue message", async () => {
    const registry = await fixtureRegistry([{ variant: "valid" }]);
    const { queue, sent } = recordingQueue();
    const queued = { ...deps, queue };

    expect(await discoverNpmPackages(queued, { registry })).toEqual({ seen: 1, queued: 1 });
    expect(await discoverNpmPackages(queued, { registry })).toEqual({ seen: 1, queued: 0 });
    expect(sent).toEqual([{ type: "index-package", submissionId: expect.stringMatching(/^sub_/), packageName: FIXTURE_NAME }]);

    const [message] = sent;
    if (!message) throw new Error("expected a queued message");
    await handleIngestMessage(queued, message, { registry });
    expect((await getPackage(deps, FIXTURE_NAME)).latestVersion).toBe("1.0.0");
    expect(await discoverNpmPackages(queued, { registry })).toEqual({ seen: 1, queued: 0 });
    expect(await auditActions()).toEqual(["package.discovered", "package.indexed"]);
  });

  it("hands index messages to durable indexing when a starter is given", async () => {
    const submissionId = await queueSubmission(FIXTURE_NAME);
    const started: unknown[] = [];
    await handleIngestMessage(
      deps,
      { type: "index-package", submissionId, packageName: FIXTURE_NAME },
      { startIndexing: async (params) => void started.push(params) },
    );
    expect(started).toEqual([{ submissionId, packageName: FIXTURE_NAME }]);
    expect(await submissionRow(submissionId)).toMatchObject({ status: "queued", workflowId: submissionId });
  });
});
