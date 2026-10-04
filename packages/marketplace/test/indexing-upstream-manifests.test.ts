import type { IngestMessage } from "@marketplace/contracts";
import { packagePermissions, packageVersions } from "@marketplace/db";
import { eq } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import {
  createMarketplaceDeps,
  discoverNpmPackages,
  getPackage,
  handleIngestMessage,
  indexPackage,
  listPackages,
  readPackageArchive,
  submitPackage,
  type MarketplaceDeps,
  type NpmRegistry,
} from "../src";
import { MAX_PERMISSION_ROWS, validateManifest } from "../src/indexing/manifest-validation";
import { createAccount, fixtureRegistry, indexingDeps, resetIndexingState, upstreamPackages } from "./support/indexing-fixtures";
import { instrumentD1 } from "./support/instrumented-d1";

/**
 * Every manifest vendored from ClarkCant (`fixtures/upstream/clarkcant`, pinned by `UPSTREAM.json`) is packed with
 * `npm pack` as an author would publish it and indexed through the real pipeline against a real D1, so a ClarkCant
 * contract change the mirror does not follow fails here as well as in `pnpm contract:check`.
 */

let deps: MarketplaceDeps;
const packages = upstreamPackages();

beforeEach(async () => {
  deps = indexingDeps();
  await resetIndexingState(deps);
});

function packageFor(fixture: string) {
  const found = packages.find((entry) => entry.fixture === fixture);
  if (!found) throw new Error(`no upstream fixture ${fixture}`);
  return found;
}

async function upstreamRegistry(): Promise<NpmRegistry> {
  return fixtureRegistry(packages.map((entry) => ({ bytes: entry.bytes })));
}

async function index(registry: NpmRegistry, name: string) {
  const actor = await createAccount(deps);
  const { submission } = await submitPackage(deps, actor, { name }, { enqueue: false });
  return indexPackage(deps, { submissionId: submission.id, packageName: name }, { registry });
}

async function latestOf(fixture: string) {
  const latest = (await getPackage(deps, packageFor(fixture).name)).latest;
  if (!latest) throw new Error(`${fixture} has no indexed version`);
  return latest;
}

describe("ClarkCant's current manifests index from real package archives", () => {
  it("covers the five reference apps and the CLI's blank template", () => {
    expect(packages.map((entry) => entry.fixture).sort()).toEqual([
      "reference-apps/connected-app",
      "reference-apps/image-generator",
      "reference-apps/media-render",
      "reference-apps/spreadsheet",
      "reference-apps/text-editor",
      "templates/blank",
    ]);
  });

  it("discovers every package by the clarkcant keyword and indexes it from the queue", async () => {
    const registry = await upstreamRegistry();
    const sent: IngestMessage[] = [];
    const queue = {
      send: async (message: IngestMessage) => {
        sent.push(message);
      },
      // The producer surface the marketplace uses is `send`; a structural double avoids a real queue in tests.
    } as unknown as Queue<IngestMessage>;
    expect(await discoverNpmPackages({ ...deps, queue }, { registry })).toMatchObject({ queued: packages.length });
    for (const message of sent) await handleIngestMessage({ ...deps, queue }, message, { registry });

    for (const entry of packages) {
      const detail = await getPackage(deps, entry.name);
      expect(detail, entry.fixture).toMatchObject({ latestVersion: entry.version, curationStatus: "listed" });
      expect(detail.latest?.manifestSchemaVersion).toBe(2);
    }
  });

  it("lists a widget-only package (the blank template) with its UI facet and no permissions", async () => {
    const blank = packageFor("templates/blank");
    expect(await index(await upstreamRegistry(), blank.name)).toMatchObject({ status: "indexed", version: "0.1.0" });
    const detail = await getPackage(deps, blank.name);
    expect(detail).toMatchObject({ displayName: "My Widget", description: "A blank widget.", categorySlug: "widgets" });
    expect(detail.latest?.facets).toEqual([
      {
        kind: "ui",
        isolation: "isolated-ui",
        renderer: null,
        entry: "widgets/main/index.html",
        widgetId: "com.example.my-widget.main@1",
      },
    ]);
    expect(detail.latest).toMatchObject({ permissions: [], services: [], browserTokens: [], resources: null });
  });

  it("persists and shows what a service provides, the origin it reaches and the secret it needs", async () => {
    const generator = packageFor("reference-apps/image-generator");
    await index(await upstreamRegistry(), generator.name);
    const latest = await latestOf("reference-apps/image-generator");
    expect(latest.facets.map((facet) => [facet.kind, facet.isolation])).toEqual([
      ["tools", "service"],
      ["ui", "isolated-ui"],
    ]);
    expect(latest.permissions).toEqual([
      { kind: "egress", value: "http://127.0.0.1:8881", access: "IMAGE_PROVIDER_KEY" },
      { kind: "secret", value: "IMAGE_PROVIDER_KEY", access: null },
      { kind: "service-capability", value: "com.clarkcant.reference.image-generator.image.generate@1", access: "external-write" },
    ]);
    expect(latest.services).toEqual([
      {
        facetId: "com.clarkcant.reference.image-generator.service",
        entry: "service/server.mjs",
        protocol: "mcp-stdio",
        capabilities: [
          {
            tool: "generate_image",
            ref: "com.clarkcant.reference.image-generator.image.generate@1",
            summary: "Generate an image from a prompt, as a job the widget can follow and stop",
            effectCategory: "external-write",
            job: true,
            requiredScopes: [],
            inputArtifactFields: [],
          },
        ],
        egress: {
          secrets: [{ name: "IMAGE_PROVIDER_KEY", purpose: "Signs the image requests in with the provider." }],
          origins: [
            {
              origin: "http://127.0.0.1:8881",
              purpose: "Draws the images you describe.",
              credential: { secret: "IMAGE_PROVIDER_KEY", header: "authorization", scheme: "bearer" },
            },
          ],
        },
        connection: null,
      },
    ]);
  });

  it("persists and shows an account connection with its scopes and endpoints", async () => {
    await index(await upstreamRegistry(), packageFor("reference-apps/connected-app").name);
    const latest = await latestOf("reference-apps/connected-app");
    expect(latest.permissions).toEqual(
      expect.arrayContaining([
        { kind: "connection-scope", value: "tasks.read", access: "fake.tasks" },
        { kind: "connection-scope", value: "tasks.write", access: "fake.tasks" },
        { kind: "connection-endpoint", value: "http://127.0.0.1:8880", access: "fake.tasks" },
        { kind: "service-capability", value: "com.clarkcant.reference.connected-app.update-task@1", access: "external-write" },
      ]),
    );
    const [service] = latest.services;
    expect(service?.capabilities.map((capability) => [capability.tool, capability.requiredScopes])).toEqual([
      ["list-tasks", ["tasks.read"]],
      ["update-task", ["tasks.write"]],
    ]);
    expect(service?.connection).toMatchObject({
      provider: "fake.tasks",
      displayName: "Fake Tasks (test fixture)",
      flow: "oauth-pkce",
      authorizationEndpoint: "http://127.0.0.1:8880/oauth/authorize",
      endpoints: ["http://127.0.0.1:8880"],
      probeUrl: "http://127.0.0.1:8880/api/me",
    });
    expect(latest.facets.map((facet) => facet.kind).sort()).toEqual(["skills", "tools", "ui"]);
  });

  it("persists and shows the resource profile and the files a capability reads", async () => {
    await index(await upstreamRegistry(), packageFor("reference-apps/media-render").name);
    const latest = await latestOf("reference-apps/media-render");
    expect(latest.resources).toEqual({ profile: "background-compute", gpu: false });
    expect(latest.permissions).toEqual(
      expect.arrayContaining([{ kind: "resource-profile", value: "background-compute", access: null }]),
    );
    expect(latest.services[0]?.capabilities[0]).toMatchObject({ effectCategory: "read", job: true, inputArtifactFields: ["source"] });
  });

  it("finds v2 UI facets with the widget filter and services with the tools filter", async () => {
    const registry = await upstreamRegistry();
    for (const entry of packages) await index(registry, entry.name);
    const names = async (query: Parameters<typeof listPackages>[1]) =>
      (await listPackages(deps, query)).items.map((item) => item.name).sort();
    expect(await names({ kind: "widget" })).toEqual(packages.map((entry) => entry.name).sort());
    expect(await names({ kind: "ui" })).toEqual(await names({ kind: "widget" }));
    expect(await names({ kind: "tools", isolation: "service" })).toEqual(
      ["connected-app", "image-generator", "media-render"].map((app) => `@clarkcant-fixtures/reference-apps-${app}`),
    );
    expect(await names({ kind: "skills" })).toEqual(["@clarkcant-fixtures/reference-apps-connected-app"]);
  });
});

describe("incoherent or unsupported v2 manifests are refused with the reason", () => {
  it("rejects a capability that needs a scope its connection never asks for", async () => {
    const result = await index(await fixtureRegistry([{ variant: "invalidServiceManifest" }]), "@clarkcant/example-bad-service");
    expect(result).toMatchObject({ status: "rejected", code: "manifest_invalid" });
    expect(result.status === "rejected" ? result.reason : "").toContain(
      "capability com.clarkcant.reference.connected-app.list-tasks@1 requires scope tasks.delete, which the connection does not request",
    );
  });

  it("stores a version at the permission-row limit, and refuses one past it by name", async () => {
    const registry = await fixtureRegistry([{ variant: "maxPermissionRows" }, { variant: "tooManyPermissionRows" }]);
    // Through a D1 that enforces the per-statement parameter limit local SQLite does not.
    const instrumented = instrumentD1(env.DB);
    deps = createMarketplaceDeps({ d1: instrumented.d1, media: env.MEDIA });

    const atLimit = await index(registry, "@clarkcant/example-max-permissions");
    if (atLimit.status !== "indexed") throw new Error(`the package at the limit was not indexed: ${JSON.stringify(atLimit)}`);
    const stored = await deps.db
      .select({ value: packagePermissions.value })
      .from(packagePermissions)
      .innerJoin(packageVersions, eq(packageVersions.id, packagePermissions.packageVersionId))
      .where(eq(packageVersions.packageId, atLimit.packageId));
    expect(stored).toHaveLength(MAX_PERMISSION_ROWS);
    expect(new Set(stored.map((row) => row.value)).size).toBe(MAX_PERMISSION_ROWS);
    expect((await getPackage(deps, "@clarkcant/example-max-permissions")).latest?.facets).toHaveLength(1 + MAX_PERMISSION_ROWS / 64);
    expect(instrumented.maxBoundParameters()).toBeLessThanOrEqual(100);
    expect(instrumented.executed.length).toBeLessThan(1000);

    const pastLimit = await index(registry, "@clarkcant/example-too-many-permissions");
    expect(pastLimit).toMatchObject({ status: "rejected", code: "manifest_too_large" });
    expect(pastLimit.status === "rejected" ? pastLimit.reason : "").toContain(
      `declares ${String(MAX_PERMISSION_ROWS + 1)} distinct permissions`,
    );
  });

  it("names the field for an unknown schemaVersion, an unknown field and a lane mismatch", async () => {
    const { manifestText } = await readPackageArchive(packageFor("templates/blank").bytes);
    if (manifestText === null) throw new Error("the blank template tarball has no clarkcant.json");
    const text = (edit: (manifest: Record<string, unknown>) => void) => {
      const manifest = JSON.parse(manifestText) as Record<string, unknown>;
      edit(manifest);
      return JSON.stringify(manifest);
    };
    const reason = (manifestText: string) => {
      try {
        validateManifest(manifestText, "0.1.0");
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error("expected the manifest to be refused");
    };
    expect(reason(text((manifest) => (manifest.schemaVersion = 3)))).toContain(
      "schemaVersion: must be 2 (or 1, the widget-only format ClarkCant still reads)",
    );
    expect(reason(text((manifest) => (manifest.capabilities = [])))).toContain('(root): Unrecognized key: "capabilities"');
    expect(
      reason(
        text((manifest) => {
          const [facet] = manifest.facets as Record<string, unknown>[];
          if (facet) facet.isolation = "trusted-native";
        }),
      ),
    ).toContain("facets.0.isolation");
  });
});
