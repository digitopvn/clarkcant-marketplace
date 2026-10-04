import { describe, expect, it } from "vitest";

import {
  clarkcantManifestSchema,
  legacyInstallManifestSchema,
  manifestProblems,
  normalizeManifest,
  normalizeStoredManifest,
  packageManifestSchema,
  readClarkcantManifest,
  widgetPackageManifestSchema,
  type ManifestReadResult,
} from "../src";
import connectedApp from "../../../fixtures/upstream/clarkcant/reference-apps/connected-app/clarkcant.json" with { type: "json" };
import imageGenerator from "../../../fixtures/upstream/clarkcant/reference-apps/image-generator/clarkcant.json" with { type: "json" };
import mediaRender from "../../../fixtures/upstream/clarkcant/reference-apps/media-render/clarkcant.json" with { type: "json" };
import frameWidget from "./fixtures/frame-widget.clarkcant.json" with { type: "json" };
import installManifest from "./fixtures/install-manifest.json" with { type: "json" };

type Json = Record<string, unknown>;

/** A deep copy the test may edit without touching the imported fixture. */
function copy(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

function list(value: unknown): Json[] {
  if (!Array.isArray(value)) throw new Error("expected an array");
  return value as Json[];
}

function at(value: unknown, index = 0): Json {
  const item = list(value)[index];
  if (!item) throw new Error(`no item at ${String(index)}`);
  return item;
}

function serviceOf(manifest: Json): Json {
  const service = list(manifest.facets).find((facet) => facet.kind === "tools");
  if (!service) throw new Error("fixture has no tools facet");
  return service;
}

function firstCapability(manifest: Json): Json {
  return at(serviceOf(manifest).capabilities);
}

function issuesOf(result: ManifestReadResult): string[] {
  if (result.ok) throw new Error("expected the manifest to be refused");
  return result.issues.map((issue) => `${issue.path}: ${issue.message}`);
}

describe("schemaVersion 2 manifests", () => {
  it("reads a service package and normalizes capabilities, egress and secrets", () => {
    const result = readClarkcantManifest(imageGenerator);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.manifest).toEqual(packageManifestSchema.parse(imageGenerator));
    const normalized = result.normalized;
    expect(normalized).toMatchObject({
      dialect: "package",
      schemaVersion: 2,
      id: "com.clarkcant.reference.image-generator",
      displayName: "Image generator",
      resources: null,
      browserTokens: [],
    });
    expect(normalized.facets.map((facet) => [facet.kind, facet.isolation, facet.id, facet.widgetId])).toEqual([
      ["ui", "isolated-ui", "com.clarkcant.reference.image-generator.main@1", "com.clarkcant.reference.image-generator.main@1"],
      ["tools", "service", "com.clarkcant.reference.image-generator.service", null],
    ]);
    expect(normalized.services).toHaveLength(1);
    const [service] = normalized.services;
    expect(service).toMatchObject({ facetId: "com.clarkcant.reference.image-generator.service", protocol: "mcp-stdio" });
    expect(service?.capabilities[0]).toMatchObject({
      tool: "generate_image",
      ref: "com.clarkcant.reference.image-generator.image.generate@1",
      effectCategory: "external-write",
      execution: { kind: "job", version: 1 },
    });
    expect(service?.egress?.secrets).toEqual([{ name: "IMAGE_PROVIDER_KEY", purpose: "Signs the image requests in with the provider." }]);
    expect(service?.egress?.origins[0]).toMatchObject({
      origin: "http://127.0.0.1:8881",
      credential: { secret: "IMAGE_PROVIDER_KEY", header: "authorization", scheme: "bearer" },
    });
  });

  it("keeps the connection, its scopes and the scopes each capability requires", () => {
    const result = readClarkcantManifest(connectedApp);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const [service] = result.normalized.services;
    expect(service?.connection).toMatchObject({
      provider: "fake.tasks",
      flow: "oauth-pkce",
      endpoints: ["http://127.0.0.1:8880"],
      scopes: [
        { scope: "tasks.read", purpose: "Lists your tasks." },
        { scope: "tasks.write", purpose: "Renames a task when you ask." },
      ],
    });
    expect(service?.capabilities.map((capability) => [capability.tool, capability.requiredScopes])).toEqual([
      ["list-tasks", ["tasks.read"]],
      ["update-task", ["tasks.write"]],
    ]);
    expect(result.normalized.facets.map((facet) => facet.kind)).toEqual(["ui", "tools", "skills"]);
  });

  it("keeps the resource request and input artifacts", () => {
    const result = readClarkcantManifest(mediaRender);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.normalized.resources).toEqual({ profile: "background-compute", gpu: false });
    expect(result.normalized.services[0]?.capabilities[0]?.inputArtifacts).toEqual({ version: 1, fields: ["source"] });
  });

  it("keeps browser token declarations of a UI facet", () => {
    const manifest = copy(imageGenerator);
    at(manifest.facets).browserTokens = {
      version: 1,
      providers: [{ provider: "example.maps", scopes: ["tiles:read"], purpose: "Draws the map." }],
    };
    const result = readClarkcantManifest(manifest);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.normalized.browserTokens).toEqual([
      {
        facetId: "com.clarkcant.reference.image-generator.main@1",
        provider: "example.maps",
        scopes: ["tiles:read"],
        purpose: "Draws the map.",
      },
    ]);
  });

  it("refuses unknown fields at every level instead of ignoring them", () => {
    expect(issuesOf(readClarkcantManifest({ ...copy(mediaRender), extra: true }))).toEqual([': Unrecognized key: "extra"']);
    const facetField = copy(mediaRender);
    serviceOf(facetField).sandbox = "none";
    expect(issuesOf(readClarkcantManifest(facetField)).join("\n")).toContain("facets.1");
    const resourceField = copy(mediaRender);
    resourceField.resources = { version: 1, profile: "background-compute", memory: 8192 };
    expect(issuesOf(readClarkcantManifest(resourceField)).join("\n")).toContain("resources");
  });

  it("refuses a schemaVersion it does not know and says which ones it reads", () => {
    expect(issuesOf(readClarkcantManifest({ ...copy(mediaRender), schemaVersion: 3 }))).toEqual([
      "schemaVersion: must be 2 (or 1, the widget-only format ClarkCant still reads)",
    ]);
    expect(issuesOf(readClarkcantManifest({ ...copy(mediaRender), schemaVersion: "2" }))[0]).toMatch(/^schemaVersion: must be 2/);
  });

  it("refuses a facet whose isolation lane does not match its kind", () => {
    const uiAsService = copy(mediaRender);
    at(uiAsService.facets).isolation = "service";
    expect(issuesOf(readClarkcantManifest(uiAsService)).join("\n")).toContain("facets.0.isolation");

    const skillsAsNative = copy(connectedApp);
    at(skillsAsNative.facets, 2).isolation = "trusted-native";
    expect(readClarkcantManifest(skillsAsNative).ok).toBe(false);

    const widgetKind = copy(mediaRender);
    at(widgetKind.facets).kind = "widget";
    expect(readClarkcantManifest(widgetKind).ok).toBe(false);
  });

  it("refuses bad capability refs, effect categories and tool names", () => {
    const badRef = copy(mediaRender);
    firstCapability(badRef).ref = "Render";
    expect(issuesOf(readClarkcantManifest(badRef)).join("\n")).toContain("must look like namespace.name@1");

    const badEffect = copy(mediaRender);
    firstCapability(badEffect).effectCategory = "anything";
    expect(readClarkcantManifest(badEffect).ok).toBe(false);

    const badTool = copy(mediaRender);
    firstCapability(badTool).tool = "render audio";
    expect(readClarkcantManifest(badTool).ok).toBe(false);
  });

  it("refuses capabilities named outside the package id or under a reserved namespace", () => {
    const foreign = copy(mediaRender);
    firstCapability(foreign).ref = "google.calendar.events.delete@1";
    expect(issuesOf(readClarkcantManifest(foreign))).toEqual([
      "facets: facet com.clarkcant.reference.media-render.service: capability google.calendar.events.delete@1 must be named under the package id, as com.clarkcant.reference.media-render.<name>@<n>",
    ]);

    const reserved = copy(mediaRender);
    reserved.id = "project.files";
    firstCapability(reserved).ref = "project.files.render@1";
    expect(issuesOf(readClarkcantManifest(reserved))).toEqual(["id: project.files is under project, which the node's own capabilities use"]);
  });

  it("refuses unsafe reach: wildcard origins, host-owned headers, undeclared secrets and scopes, plain http", () => {
    const wildcard = copy(imageGenerator);
    at((serviceOf(wildcard).egress as Json).origins).origin = "https://*.example.com";
    expect(issuesOf(readClarkcantManifest(wildcard)).join("\n")).toContain("no wildcard");

    const cookieHeader = copy(imageGenerator);
    (at((serviceOf(cookieHeader).egress as Json).origins).credential as Json).header = "cookie";
    expect(issuesOf(readClarkcantManifest(cookieHeader)).join("\n")).toContain("only the host's HTTP client sets");

    const undeclaredSecret = copy(imageGenerator);
    (serviceOf(undeclaredSecret).egress as Json).secrets = [];
    expect(issuesOf(readClarkcantManifest(undeclaredSecret)).join("\n")).toContain("which is not declared in secrets");

    const missingScope = copy(connectedApp);
    firstCapability(missingScope).requiredScopes = ["tasks.delete"];
    expect(issuesOf(readClarkcantManifest(missingScope)).join("\n")).toContain(
      "requires scope tasks.delete, which the connection does not request",
    );

    const plainHttp = copy(connectedApp);
    ((serviceOf(plainHttp).connection as Json).authorization as Json).tokenEndpoint = "http://auth.example.com/token";
    expect(issuesOf(readClarkcantManifest(plainHttp)).join("\n")).toContain("must use https unless it is a loopback address");
  });

  it("refuses facet files outside the package and duplicate facet ids", () => {
    const escape = copy(mediaRender);
    serviceOf(escape).entry = "../outside/server.mjs";
    expect(issuesOf(readClarkcantManifest(escape)).join("\n")).toContain("escapes the package root");

    const duplicate = copy(mediaRender);
    serviceOf(duplicate).id = at(duplicate.facets).id;
    expect(issuesOf(readClarkcantManifest(duplicate)).join("\n")).toContain("is declared twice");
  });

  it("applies the shape rules: semver versions, ordered host API ranges, known platforms", () => {
    expect(readClarkcantManifest({ ...copy(mediaRender), version: "latest" }).ok).toBe(false);
    expect(readClarkcantManifest({ ...copy(mediaRender), hostApi: { min: 3, max: 1 } }).ok).toBe(false);
    expect(readClarkcantManifest({ ...copy(mediaRender), platforms: ["amiga"] }).ok).toBe(false);
    expect(readClarkcantManifest([]).ok).toBe(false);
  });

  it("defaults omitted dependencies the way ClarkCant does", () => {
    const withoutDependencies = copy(mediaRender);
    delete withoutDependencies.dependencies;
    expect(readClarkcantManifest(withoutDependencies).ok).toBe(true);
  });
});

describe("schemaVersion 1 widget manifests", () => {
  it("are read and normalized as widget facets", () => {
    const result = readClarkcantManifest(frameWidget);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    // Stored as the package shipped it, not as the upgraded shape.
    expect(result.manifest).toEqual(widgetPackageManifestSchema.parse(frameWidget));
    expect(result.normalized).toMatchObject({
      dialect: "widget-package",
      schemaVersion: 1,
      id: "com.example.frame-widget",
      displayName: "Frame widget",
      services: [],
      facets: [
        {
          kind: "widget",
          id: "com.example.frame-widget.main@1",
          entry: "widgets/main/index.html",
          isolation: "isolated-ui",
          renderer: null,
          widgetId: "com.example.frame-widget.main@1",
        },
      ],
      publisher: { id: "example", sourceUrl: "https://example.com", license: "MIT" },
    });
  });

  it("read listed filesystem paths as read access, as ClarkCant does", () => {
    const manifest = copy(frameWidget);
    (manifest.permissions as Json).filesystem = ["notes"];
    const result = readClarkcantManifest(manifest);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.normalized.permissions.filesystem).toEqual([{ path: "notes", access: "read" }]);
  });

  it("are held to the canonical rules after the upgrade", () => {
    expect(issuesOf(readClarkcantManifest({ ...copy(frameWidget), version: "one" }))[0]).toBe(
      "version: must be a semantic version (a schemaVersion 1 value the canonical manifest does not accept)",
    );
    expect(readClarkcantManifest({ ...copy(frameWidget), platforms: ["beos"] }).ok).toBe(false);
    const escape = copy(frameWidget);
    at(escape.facets).definition = "/etc/widget.json";
    expect(issuesOf(readClarkcantManifest(escape)).join("\n")).toContain("escapes the package root");
  });

  it("refuse v2 facet kinds", () => {
    const manifest = copy(frameWidget);
    at(manifest.facets).kind = "ui";
    expect(readClarkcantManifest(manifest).ok).toBe(false);
  });
});

describe("the schemaVersion-less install draft", () => {
  it("is still read and keeps declared filesystem access", () => {
    const result = readClarkcantManifest(installManifest);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(legacyInstallManifestSchema.safeParse(installManifest).success).toBe(true);
    const normalized = result.normalized;
    expect(normalized).toMatchObject({ dialect: "install", schemaVersion: null, displayName: null, services: [] });
    expect(normalized.facets.map((facet) => [facet.kind, facet.isolation, facet.renderer])).toEqual([
      ["ui", "isolated-ui", "isolated-app"],
      ["tools", "service", null],
    ]);
    expect(normalized.permissions.filesystem).toEqual([{ path: "cache", access: "write" }]);
  });

  it("explains that schemaVersion is missing when the draft does not match either", () => {
    const withoutVersion = copy(mediaRender);
    delete withoutVersion.schemaVersion;
    const issues = issuesOf(readClarkcantManifest(withoutVersion));
    expect(issues[0]).toMatch(/^schemaVersion: is missing; ClarkCant manifests declare schemaVersion 2/);
  });

  it("still refuses its own bad values", () => {
    const base = installManifest;
    expect(readClarkcantManifest({ ...base, extra: true }).ok).toBe(false);
    expect(readClarkcantManifest({ ...base, hostApi: { min: 3, max: 1 } }).ok).toBe(false);
    expect(readClarkcantManifest({ ...base, requestedCapabilities: ["Data"] }).ok).toBe(false);
    expect(readClarkcantManifest({ ...base, facets: [{ kind: "ui", entry: "x", isolation: "root" }] }).ok).toBe(false);
  });
});

describe("dialects stay disjoint", () => {
  it("matches each manifest with exactly one dialect", () => {
    const dialects = [packageManifestSchema, widgetPackageManifestSchema, legacyInstallManifestSchema];
    for (const manifest of [mediaRender, frameWidget, installManifest]) {
      expect(dialects.filter((schema) => schema.safeParse(manifest).success)).toHaveLength(1);
    }
  });

  it("normalizes stored manifests and degrades to null for rows that no longer match", () => {
    expect(normalizeStoredManifest(connectedApp)?.services).toHaveLength(1);
    expect(normalizeStoredManifest({ id: "x", version: "1.0.0" })).toBeNull();
    expect(normalizeManifest(clarkcantManifestSchema.parse(frameWidget)).dialect).toBe("widget-package");
    expect(manifestProblems(packageManifestSchema.parse(connectedApp))).toEqual([]);
  });
});
