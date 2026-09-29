import { z } from "zod";

/**
 * Mirrors of ClarkCant's package manifest contracts. They are copied rather than imported so the marketplace never
 * takes a build dependency on the runtime repo; the unit tests pin them against ClarkCant's own fixtures.
 *
 * Two shapes exist upstream and both can appear in a published `clarkcant.json`:
 * - `packageManifestSchema` mirrors `clarkcant/packages/contracts/src/install.ts` (the install-plan contract);
 * - `widgetPackageManifestSchema` mirrors `clarkcant/packages/core/src/widget-package.ts` (`schemaVersion: 1`, the
 *   file `clark widget init|pack` writes today).
 *
 * A manifest is untrusted input describing *requests*. Nothing parsed here grants any permission.
 */

export const semverSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, { error: "must be a semantic version" });

export const platformSchema = z.enum([
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-arm64",
  "win32-x64",
  "win32-arm64",
  "web",
]);
export type Platform = z.infer<typeof platformSchema>;

export const capabilityRefSchema = z
  .string()
  .min(3)
  .max(160)
  .regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+@\d+$/, { error: "must look like namespace.name@1" });

export const facetKindSchema = z.enum(["tools", "ui", "skills", "prompts", "themes", "setup", "driver", "voice"]);
export type FacetKind = z.infer<typeof facetKindSchema>;

/** Execution lane. Shown to users as the risk lane; each value is labelled distinctly in the UI. */
export const isolationClassSchema = z.enum(["declarative", "service", "isolated-ui", "trusted-native"]);
export type IsolationClass = z.infer<typeof isolationClassSchema>;

export const facetRendererSchema = z.enum(["catalog", "isolated-app", "mcp-app"]);
export type FacetRenderer = z.infer<typeof facetRendererSchema>;

export const facetDeclarationSchema = z.strictObject({
  kind: facetKindSchema,
  entry: z.string().min(1).max(300),
  isolation: isolationClassSchema,
  widgetId: z.string().min(1).max(160).optional(),
  renderer: facetRendererSchema.optional(),
});

export const packageManifestSchema = z.strictObject({
  id: z.string().min(1).max(160),
  version: semverSchema,
  hostApi: z
    .strictObject({ min: z.int().nonnegative(), max: z.int().nonnegative() })
    .refine((range) => range.min <= range.max, { error: "hostApi.min must not exceed hostApi.max" }),
  facets: z.array(facetDeclarationSchema).min(1).max(64),
  requestedCapabilities: z.array(capabilityRefSchema).max(128),
  permissions: z.strictObject({
    networkOrigins: z.array(z.string().min(1).max(300)).max(64),
    filesystem: z
      .array(z.strictObject({ path: z.string().min(1).max(300), access: z.enum(["read", "write"]) }))
      .max(64),
    microphone: z.boolean(),
    camera: z.boolean(),
    lifecycleScripts: z.array(z.string().min(1).max(300)).max(32),
  }),
  platforms: z.array(platformSchema).min(1),
  publisher: z
    .strictObject({
      id: z.string().min(1).max(200),
      sourceUrl: z.string().min(1).max(500),
      license: z.string().min(1).max(120),
      signature: z.string().min(1).max(400).optional(),
    })
    .optional(),
  dependencies: z
    .array(z.strictObject({ id: z.string().min(1).max(160), version: semverSchema }))
    .max(256),
});
export type PackageManifest = z.infer<typeof packageManifestSchema>;

export const widgetPackageManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string().min(1).max(160),
  version: z.string().min(1).max(80),
  displayName: z.string().min(1).max(200),
  description: z.string().min(1).max(600),
  hostApi: z.strictObject({ min: z.int().nonnegative(), max: z.int().nonnegative() }),
  facets: z
    .array(
      z.strictObject({
        kind: z.literal("widget"),
        id: z.string().min(1).max(160),
        entry: z.string().min(1).max(300),
        definition: z.string().min(1).max(300),
        isolation: z.literal("isolated-ui"),
      }),
    )
    .min(1),
  requestedCapabilities: z.array(z.string().min(1).max(160)).max(64),
  permissions: z.strictObject({
    networkOrigins: z.array(z.string().min(1).max(300)).max(64),
    filesystem: z.array(z.string().min(1).max(300)).max(64),
    microphone: z.boolean(),
    camera: z.boolean(),
    lifecycleScripts: z.array(z.string().min(1).max(300)).max(64),
  }),
  platforms: z.array(z.string().min(1).max(120)).min(1),
  publisher: z.strictObject({
    id: z.string().min(1).max(160),
    sourceUrl: z.string().min(1).max(400),
    license: z.string().min(1).max(80),
  }),
});
export type WidgetPackageManifest = z.infer<typeof widgetPackageManifestSchema>;

/**
 * Any `clarkcant.json` the marketplace accepts. Both members are strict objects and only the widget shape has
 * `schemaVersion`, so a document matches at most one of them.
 */
export const clarkcantManifestSchema = z.union([widgetPackageManifestSchema, packageManifestSchema]);
export type ClarkcantManifest = z.infer<typeof clarkcantManifestSchema>;

/** The one shape listing code reads, whichever manifest dialect a package shipped. */
export interface NormalizedManifest {
  dialect: "widget-package" | "install";
  id: string;
  version: string;
  displayName: string | null;
  description: string | null;
  hostApi: { min: number; max: number };
  facets: {
    kind: FacetKind | "widget";
    entry: string;
    isolation: IsolationClass;
    renderer: FacetRenderer | null;
    widgetId: string | null;
  }[];
  requestedCapabilities: string[];
  permissions: {
    networkOrigins: string[];
    /** `access` is null when the dialect does not declare one (widget-package manifests list bare paths). */
    filesystem: { path: string; access: "read" | "write" | null }[];
    microphone: boolean;
    camera: boolean;
    lifecycleScripts: string[];
  };
  platforms: string[];
  publisher: { id: string; sourceUrl: string; license: string } | null;
}

export function normalizeManifest(manifest: ClarkcantManifest): NormalizedManifest {
  if ("schemaVersion" in manifest) {
    return {
      dialect: "widget-package",
      id: manifest.id,
      version: manifest.version,
      displayName: manifest.displayName,
      description: manifest.description,
      hostApi: manifest.hostApi,
      facets: manifest.facets.map((facet) => ({
        kind: facet.kind,
        entry: facet.entry,
        isolation: facet.isolation,
        renderer: null,
        widgetId: facet.id,
      })),
      requestedCapabilities: manifest.requestedCapabilities,
      permissions: {
        ...manifest.permissions,
        filesystem: manifest.permissions.filesystem.map((path) => ({ path, access: null })),
      },
      platforms: manifest.platforms,
      publisher: manifest.publisher,
    };
  }
  return {
    dialect: "install",
    id: manifest.id,
    version: manifest.version,
    displayName: null,
    description: null,
    hostApi: manifest.hostApi,
    facets: manifest.facets.map((facet) => ({
      kind: facet.kind,
      entry: facet.entry,
      isolation: facet.isolation,
      renderer: facet.renderer ?? null,
      widgetId: facet.widgetId ?? null,
    })),
    requestedCapabilities: manifest.requestedCapabilities,
    permissions: manifest.permissions,
    platforms: manifest.platforms,
    publisher: manifest.publisher
      ? { id: manifest.publisher.id, sourceUrl: manifest.publisher.sourceUrl, license: manifest.publisher.license }
      : null,
  };
}
