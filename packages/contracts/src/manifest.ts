import { z } from "zod";

/**
 * Mirror of ClarkCant's package manifest contract. It is copied rather than imported so the marketplace never takes a
 * build dependency on the runtime repo; `fixtures/upstream/clarkcant/` pins real ClarkCant manifests at a recorded
 * commit and `pnpm contract:check` fails when this mirror stops accepting them (see `docs/extending-indexers.md`).
 *
 * Three dialects can appear in a published `clarkcant.json`:
 * - `schemaVersion: 2`, the canonical manifest (`clarkcant/packages/contracts/src/install.ts`), which
 *   `clark widget init` writes today. Mirrored field for field, with the cross-field rules of `manifestProblems`.
 * - `schemaVersion: 1`, the widget-only manifest older `clark widget init` wrote
 *   (`clarkcant/packages/core/src/widget-package.ts`). ClarkCant still reads it by upgrading it to the canonical shape
 *   and holding the result to the same checks; `readClarkcantManifest` does the same.
 * - No `schemaVersion`: the install-plan draft this marketplace mirrored before ClarkCant versioned the format. Still
 *   parsed so packages published against it keep indexing; ClarkCant's current reader no longer accepts it.
 *
 * A manifest is untrusted input describing *requests*. Nothing parsed here grants any permission.
 */

/* ------------------------------------------------------------------ *
 * Primitives (clarkcant/packages/contracts/src/primitives.ts, grants.ts)
 * ------------------------------------------------------------------ */

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

/** What calling a capability does, as the package declares it. ClarkCant's policy decides what each one needs. */
export const effectCategorySchema = z.enum([
  "read",
  "local-write",
  "external-write",
  "destructive",
  "financial",
  "communication",
  "media-capture",
]);
export type EffectCategory = z.infer<typeof effectCategorySchema>;

export const facetKindSchema = z.enum(["tools", "ui", "skills", "prompts", "themes", "setup", "driver", "voice"]);
export type FacetKind = z.infer<typeof facetKindSchema>;

/** Execution lane. Shown to users as the risk lane; each value is labelled distinctly in the UI. */
export const isolationClassSchema = z.enum(["declarative", "service", "isolated-ui", "trusted-native"]);
export type IsolationClass = z.infer<typeof isolationClassSchema>;

/** Only the schemaVersion-less draft declares a renderer. */
export const facetRendererSchema = z.enum(["catalog", "isolated-app", "mcp-app"]);
export type FacetRenderer = z.infer<typeof facetRendererSchema>;

/* ------------------------------------------------------------------ *
 * Network origins (network-origin.ts)
 * ------------------------------------------------------------------ */

/**
 * Why a declared network origin is not one a package may reach, or `undefined` when it is: exactly
 * `scheme://host[:port]` in canonical form, and `https`/`wss` unless the host is loopback.
 */
export function networkOriginProblem(value: string): string | undefined {
  const label = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
  const shape = new RegExp(`^(?:https|wss|http|ws)://(?:\\[[0-9a-f:.]+\\]|${label}(?:\\.${label})*)(?::[0-9]{1,5})?$`);
  if (!shape.test(value)) {
    return "must be exactly scheme://host[:port]: no wildcard, path, query, credentials, whitespace or separators";
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "is not a URL";
  }
  if (url.origin !== value) return `must be written in its canonical form, ${url.origin}`;
  const encrypted = url.protocol === "https:" || url.protocol === "wss:";
  if (!encrypted && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    return "must use https or wss unless it is a loopback address";
  }
  return undefined;
}

export const networkOriginSchema = z
  .string()
  .min(1)
  .max(300)
  .refine((value) => networkOriginProblem(value) === undefined, {
    error: (issue) => `network origin ${JSON.stringify(issue.input)} ${networkOriginProblem(String(issue.input)) ?? "is invalid"}`,
  });

/* ------------------------------------------------------------------ *
 * Browser tokens (browser-token.ts)
 * ------------------------------------------------------------------ */

export const browserTokenDeclarationSchema = z.strictObject({
  provider: z
    .string()
    .max(64)
    .regex(/^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/, { error: "must be a lowercase provider id such as example.maps" }),
  scopes: z
    .array(
      z
        .string()
        .max(128)
        .regex(/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/, { error: "must be a scope of letters, digits and : . _ / -" }),
    )
    .min(1)
    .max(16),
  purpose: z.string().min(1).max(300),
});

/** Short-lived, scoped provider tokens a UI facet asks the host for. */
export const browserTokensSchema = z.strictObject({
  version: z.literal(1),
  providers: z.array(browserTokenDeclarationSchema).min(1).max(8),
});
export type BrowserTokens = z.infer<typeof browserTokensSchema>;

export function browserTokensProblems(declaration: BrowserTokens): string[] {
  const problems: string[] = [];
  const providers = new Set<string>();
  for (const entry of declaration.providers) {
    if (providers.has(entry.provider)) problems.push(`provider ${entry.provider} is declared twice`);
    providers.add(entry.provider);
    const scopes = new Set<string>();
    for (const scope of entry.scopes) {
      if (scopes.has(scope)) problems.push(`provider ${entry.provider} names the scope ${scope} twice`);
      scopes.add(scope);
    }
  }
  return problems;
}

/* ------------------------------------------------------------------ *
 * Service egress (service-egress.ts)
 * ------------------------------------------------------------------ */

const egressSecretNameSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/, { error: "must be a secret name of letters, digits, _ . or -" });

const FORBIDDEN_EGRESS_HEADERS: ReadonlySet<string> = new Set([
  "accept-encoding",
  "connection",
  "content-length",
  "cookie",
  "cookie2",
  "expect",
  "forwarded",
  "host",
  "keep-alive",
  "origin",
  "referer",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
]);
const FORBIDDEN_EGRESS_HEADER_PREFIXES: readonly string[] = ["proxy-", "sec-"];

/** Why a header may not carry an egress credential, or `undefined` when it may. */
export function egressHeaderProblem(name: string): string | undefined {
  if (!/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(name)) return "must be a header name of letters, digits and -";
  const lower = name.toLowerCase();
  if (FORBIDDEN_EGRESS_HEADERS.has(lower) || FORBIDDEN_EGRESS_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    return "is a header only the host's HTTP client sets";
  }
  return undefined;
}

export const egressCredentialSchema = z.strictObject({
  secret: egressSecretNameSchema,
  header: z.string().refine((value) => egressHeaderProblem(value) === undefined, {
    error: (issue) => `header ${JSON.stringify(issue.input)} ${egressHeaderProblem(String(issue.input)) ?? "is invalid"}`,
  }),
  scheme: z.enum(["bearer", "raw"]),
});

/** Origins a service reaches through the host, and the secrets the host adds for it. The service never holds them. */
export const serviceEgressSchema = z.strictObject({
  version: z.literal(1),
  secrets: z.array(z.strictObject({ name: egressSecretNameSchema, purpose: z.string().min(1).max(300) })).max(8),
  origins: z
    .array(
      z.strictObject({
        origin: networkOriginSchema,
        purpose: z.string().min(1).max(300),
        credential: egressCredentialSchema.optional(),
      }),
    )
    .min(1)
    .max(16),
});
export type ServiceEgress = z.infer<typeof serviceEgressSchema>;

export function serviceEgressProblems(egress: ServiceEgress): string[] {
  const problems: string[] = [];
  const secrets = new Set<string>();
  for (const secret of egress.secrets) {
    if (secrets.has(secret.name)) problems.push(`secret ${secret.name} is declared twice`);
    secrets.add(secret.name);
  }
  const origins = new Set<string>();
  const used = new Set<string>();
  for (const entry of egress.origins) {
    if (origins.has(entry.origin)) problems.push(`origin ${entry.origin} is declared twice`);
    origins.add(entry.origin);
    if (!entry.origin.startsWith("https://") && !entry.origin.startsWith("http://")) {
      problems.push(`origin ${entry.origin} must be http or https; egress makes requests, not connections`);
    }
    if (entry.credential !== undefined) {
      used.add(entry.credential.secret);
      if (!secrets.has(entry.credential.secret)) {
        problems.push(`origin ${entry.origin} uses secret ${entry.credential.secret}, which is not declared in secrets`);
      }
    }
  }
  for (const name of secrets) {
    if (!used.has(name)) problems.push(`secret ${name} is declared but no origin uses it`);
  }
  return problems;
}

/* ------------------------------------------------------------------ *
 * Service connection (service-connection.ts)
 * ------------------------------------------------------------------ */

export const connectionScopeSchema = z
  .string()
  .regex(/^[\x21\x23-\x5B\x5D-\x7E]{1,128}$/, { error: "must be a scope of printable characters without space, quote or backslash" });

/** Why a URL the host would send a credential or an authorization code to is not acceptable. */
export function connectionUrlProblem(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "is not an absolute URL";
  }
  if (url.username !== "" || url.password !== "") return "must not carry credentials";
  if (url.hash !== "") return "must not carry a fragment";
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    return "must use https unless it is a loopback address";
  }
  return undefined;
}

const endpointUrlSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => connectionUrlProblem(value) === undefined, {
    error: (issue) => `${JSON.stringify(issue.input)} ${connectionUrlProblem(String(issue.input)) ?? "is invalid"}`,
  });

/** The account a service works on. The host runs the OAuth flow and holds the tokens; the package never does. */
export const serviceConnectionSchema = z.strictObject({
  version: z.literal(1),
  provider: z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/, { error: "must be a provider id of lowercase letters, digits, . or -" }),
  displayName: z.string().min(1).max(120),
  flow: z.literal("oauth-pkce"),
  authorization: z.strictObject({
    authorizationEndpoint: endpointUrlSchema,
    tokenEndpoint: endpointUrlSchema,
    revocationEndpoint: endpointUrlSchema.optional(),
    clientId: z.string().min(1).max(200),
  }),
  scopes: z
    .array(z.strictObject({ scope: connectionScopeSchema, purpose: z.string().min(1).max(300) }))
    .min(1)
    .max(16),
  endpoints: z.array(networkOriginSchema).min(1).max(8),
  probe: z.strictObject({ url: endpointUrlSchema }),
});
export type ServiceConnection = z.infer<typeof serviceConnectionSchema>;

function safeOrigin(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

export function serviceConnectionProblems(connection: ServiceConnection): string[] {
  const problems: string[] = [];
  const scopes = new Set<string>();
  for (const entry of connection.scopes) {
    if (scopes.has(entry.scope)) problems.push(`scope ${entry.scope} is declared twice`);
    scopes.add(entry.scope);
  }
  const endpoints = new Set<string>();
  for (const origin of connection.endpoints) {
    if (endpoints.has(origin)) problems.push(`endpoint ${origin} is declared twice`);
    endpoints.add(origin);
    if (!origin.startsWith("https://") && !origin.startsWith("http://")) {
      problems.push(`endpoint ${origin} must be http or https; the host makes requests, not connections`);
    }
  }
  const probe = safeOrigin(connection.probe.url);
  if (probe !== undefined && !endpoints.has(probe)) {
    problems.push(`probe ${connection.probe.url} is not on one of the declared endpoints`);
  }
  return problems;
}

/* ------------------------------------------------------------------ *
 * Service artifacts and resource profiles (service-artifacts.ts, resource-profiles.ts)
 * ------------------------------------------------------------------ */

/** The arguments of a capability that carry ids of files a widget holds, which the host lets the service read. */
export const inputArtifactsDeclarationSchema = z.strictObject({
  version: z.literal(1),
  fields: z
    .array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, { error: "must be an argument name of letters, digits or _" }))
    .min(1)
    .max(4)
    .refine((fields) => new Set(fields).size === fields.length, { error: "names each argument once" }),
});

export const RESOURCE_PROFILE_NAMES = ["interactive-light", "interactive-heavy", "media-workstation", "background-compute"] as const;
export const resourceProfileNameSchema = z.enum(RESOURCE_PROFILE_NAMES);
export type ResourceProfileName = z.infer<typeof resourceProfileNameSchema>;
/** What ClarkCant runs a package with when it asks for nothing. */
export const DEFAULT_RESOURCE_PROFILE: ResourceProfileName = "interactive-light";

/** A resource profile asked for by name; the host decides what it grants. */
export const resourceRequestSchema = z.strictObject({
  version: z.literal(1),
  profile: resourceProfileNameSchema,
  gpu: z.boolean().optional(),
});

/* ------------------------------------------------------------------ *
 * Canonical manifest, schemaVersion 2 (install.ts)
 * ------------------------------------------------------------------ */

export const facetIdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._@-]*[A-Za-z0-9])?$/, {
    error: "must be letters, digits, '.', '_', '@' or '-', starting and ending with a letter or digit",
  });
const packagePathSchema = z.string().min(1).max(300);

export const uiFacetSchema = z.strictObject({
  kind: z.literal("ui"),
  id: facetIdSchema,
  entry: packagePathSchema,
  definition: packagePathSchema,
  isolation: z.literal("isolated-ui"),
  browserTokens: browserTokensSchema.optional(),
});

/** One capability a service facet provides, declared so consent can show it before any code runs. */
export const serviceCapabilityDeclarationSchema = z.strictObject({
  tool: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/, { error: "must be a tool name of letters, digits, _ . or -" }),
  ref: capabilityRefSchema,
  summary: z.string().min(1).max(400),
  effectCategory: effectCategorySchema,
  execution: z.strictObject({ kind: z.literal("job"), version: z.literal(1) }).optional(),
  requiredScopes: z.array(connectionScopeSchema).min(1).max(16).optional(),
  inputArtifacts: inputArtifactsDeclarationSchema.optional(),
});
export type ServiceCapabilityDeclaration = z.infer<typeof serviceCapabilityDeclarationSchema>;

export const toolsFacetSchema = z.strictObject({
  kind: z.literal("tools"),
  id: facetIdSchema,
  entry: packagePathSchema,
  isolation: z.literal("service"),
  protocol: z.literal("mcp-stdio"),
  capabilities: z.array(serviceCapabilityDeclarationSchema).min(1).max(64),
  egress: serviceEgressSchema.optional(),
  connection: serviceConnectionSchema.optional(),
});

export const declarativeFacetSchema = z.strictObject({
  kind: z.enum(["skills", "prompts", "themes", "setup"]),
  id: facetIdSchema,
  entry: packagePathSchema,
  isolation: z.literal("declarative"),
});

/** Drivers and voice engines: describable and listable, though ClarkCant runs none from a package yet. */
export const nativeFacetSchema = z.strictObject({
  kind: z.enum(["driver", "voice"]),
  id: facetIdSchema,
  entry: packagePathSchema,
  isolation: z.enum(["service", "trusted-native"]),
});

export const facetDeclarationSchema = z.discriminatedUnion("kind", [
  uiFacetSchema,
  toolsFacetSchema,
  declarativeFacetSchema,
  nativeFacetSchema,
]);
export type FacetDeclaration = z.infer<typeof facetDeclarationSchema>;

export const PACKAGE_MANIFEST_SCHEMA_VERSION = 2;
export const MAX_PACKAGE_FACETS = 64;

export const packageManifestSchema = z.strictObject({
  schemaVersion: z.literal(PACKAGE_MANIFEST_SCHEMA_VERSION),
  id: z.string().min(1).max(160),
  version: semverSchema,
  displayName: z.string().min(1).max(200),
  description: z.string().min(1).max(600),
  hostApi: z
    .strictObject({ min: z.int().nonnegative(), max: z.int().nonnegative() })
    .refine((range) => range.min <= range.max, { error: "hostApi.min must not exceed hostApi.max" }),
  facets: z.array(facetDeclarationSchema).min(1).max(MAX_PACKAGE_FACETS),
  requestedCapabilities: z.array(capabilityRefSchema).max(128),
  permissions: z.strictObject({
    networkOrigins: z.array(networkOriginSchema).max(64),
    filesystem: z
      .array(z.strictObject({ path: z.string().min(1).max(300), access: z.enum(["read", "write"]) }))
      .max(64),
    microphone: z.boolean(),
    camera: z.boolean(),
    lifecycleScripts: z.array(z.string().min(1).max(300)).max(32),
  }),
  platforms: z.array(platformSchema).min(1),
  resources: resourceRequestSchema.optional(),
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
    .max(256)
    .default([]),
});
export type PackageManifest = z.infer<typeof packageManifestSchema>;

/** The first segments of the capability refs ClarkCant registers itself; a package's capabilities never start with one. */
export const RESERVED_CAPABILITY_NAMESPACES: readonly string[] = ["canvas", "clarkcant", "dev", "mcp", "project"];
const CAPABILITY_NAMESPACE_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+$/;

/**
 * Rules that relate one field of a canonical manifest to another, which ClarkCant applies before it accepts one.
 * Empty means the manifest is coherent; it still grants nothing.
 */
export function manifestProblems(manifest: PackageManifest): string[] {
  const problems: string[] = [];

  const ids = manifest.facets.map((facet) => facet.id);
  for (const id of new Set(ids)) {
    if (ids.filter((candidate) => candidate === id).length > 1) problems.push(`facets: id "${id}" is declared twice`);
  }

  for (const facet of manifest.facets) {
    const paths = facet.kind === "ui" ? [facet.entry, facet.definition] : [facet.entry];
    for (const path of paths) {
      // A drive letter is checked before the URL shape, which `C:` also matches.
      if (/^[a-z]:/i.test(path) || path.startsWith("/") || path.startsWith("\\") || path.split(/[\\/]/).includes("..")) {
        problems.push(`facet ${facet.id}: ${path} escapes the package root`);
      } else if (/^[a-z][a-z0-9+.-]*:/i.test(path)) {
        problems.push(`facet ${facet.id}: ${path} is a URL; a facet's files must be inside the package`);
      }
    }
  }

  if (manifest.facets.some((facet) => facet.kind === "tools")) {
    if (!CAPABILITY_NAMESPACE_PATTERN.test(manifest.id)) {
      problems.push(
        `id: ${manifest.id} must be a reverse-DNS name of at least two lowercase segments, such as com.example.notes, to provide capabilities`,
      );
    } else if (RESERVED_CAPABILITY_NAMESPACES.includes(manifest.id.split(".")[0] ?? "")) {
      problems.push(`id: ${manifest.id} is under ${manifest.id.split(".")[0] ?? ""}, which the node's own capabilities use`);
    }
  }

  for (const facet of manifest.facets) {
    if (facet.kind !== "ui" || facet.browserTokens === undefined) continue;
    for (const problem of browserTokensProblems(facet.browserTokens)) problems.push(`facet ${facet.id}: browserTokens ${problem}`);
  }

  if (manifest.facets.filter((facet) => facet.kind === "tools" && facet.connection !== undefined).length > 1) {
    problems.push("facets: a package declares at most one connection");
  }

  const refs = new Set<string>();
  for (const facet of manifest.facets) {
    if (facet.kind !== "tools") continue;
    const tools = new Set<string>();
    for (const capability of facet.capabilities) {
      if (!capability.ref.startsWith(`${manifest.id}.`)) {
        problems.push(`facet ${facet.id}: capability ${capability.ref} must be named under the package id, as ${manifest.id}.<name>@<n>`);
      }
      if (refs.has(capability.ref)) problems.push(`facet ${facet.id}: capability ${capability.ref} is declared twice`);
      refs.add(capability.ref);
      if (tools.has(capability.tool)) problems.push(`facet ${facet.id}: tool ${capability.tool} is declared twice`);
      tools.add(capability.tool);
    }
    if (facet.egress !== undefined) {
      for (const problem of serviceEgressProblems(facet.egress)) problems.push(`facet ${facet.id}: egress ${problem}`);
    }
    const connection = facet.connection;
    if (connection !== undefined) {
      for (const problem of serviceConnectionProblems(connection)) problems.push(`facet ${facet.id}: connection ${problem}`);
      for (const entry of facet.egress?.origins ?? []) {
        if (connection.endpoints.includes(entry.origin)) {
          problems.push(`facet ${facet.id}: ${entry.origin} is both an egress origin and a connection endpoint`);
        }
      }
    }
    const declared = new Set(connection?.scopes.map((entry) => entry.scope) ?? []);
    for (const capability of facet.capabilities) {
      for (const scope of capability.requiredScopes ?? []) {
        if (connection === undefined) {
          problems.push(`facet ${facet.id}: capability ${capability.ref} requires scope ${scope}, but the facet declares no connection`);
        } else if (!declared.has(scope)) {
          problems.push(`facet ${facet.id}: capability ${capability.ref} requires scope ${scope}, which the connection does not request`);
        }
      }
    }
  }

  return problems;
}

/* ------------------------------------------------------------------ *
 * schemaVersion 1 widget manifest (clarkcant/packages/core/src/widget-package.ts)
 * ------------------------------------------------------------------ */

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
    networkOrigins: z.array(networkOriginSchema).max(64),
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
 * A v1 manifest in the canonical shape, as ClarkCant's `upgradeWidgetManifestV1` builds it: a `widget` facet is a `ui`
 * facet and a v1 filesystem path could only ever be read. Nothing is filled in that v1 did not say.
 */
export function upgradeWidgetManifestV1(manifest: WidgetPackageManifest): unknown {
  return {
    schemaVersion: PACKAGE_MANIFEST_SCHEMA_VERSION,
    id: manifest.id,
    version: manifest.version,
    displayName: manifest.displayName,
    description: manifest.description,
    hostApi: manifest.hostApi,
    facets: manifest.facets.map((facet) => ({
      kind: "ui",
      id: facet.id,
      entry: facet.entry,
      definition: facet.definition,
      isolation: facet.isolation,
    })),
    requestedCapabilities: manifest.requestedCapabilities,
    permissions: {
      ...manifest.permissions,
      filesystem: manifest.permissions.filesystem.map((path) => ({ path, access: "read" })),
    },
    platforms: manifest.platforms,
    publisher: manifest.publisher,
    dependencies: [],
  };
}

/* ------------------------------------------------------------------ *
 * schemaVersion-less install draft (kept for compatibility)
 * ------------------------------------------------------------------ */

export const legacyFacetDeclarationSchema = z.strictObject({
  kind: facetKindSchema,
  entry: z.string().min(1).max(300),
  isolation: isolationClassSchema,
  widgetId: z.string().min(1).max(160).optional(),
  renderer: facetRendererSchema.optional(),
});

export const legacyInstallManifestSchema = z.strictObject({
  id: z.string().min(1).max(160),
  version: semverSchema,
  hostApi: z
    .strictObject({ min: z.int().nonnegative(), max: z.int().nonnegative() })
    .refine((range) => range.min <= range.max, { error: "hostApi.min must not exceed hostApi.max" }),
  facets: z.array(legacyFacetDeclarationSchema).min(1).max(64),
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
export type LegacyInstallManifest = z.infer<typeof legacyInstallManifestSchema>;

/**
 * The shape of any `clarkcant.json` the marketplace reads. Each member is a strict object keyed by its own
 * `schemaVersion` (or its absence), so a document matches at most one. The shape alone is not acceptance:
 * `readClarkcantManifest` also applies the cross-field rules.
 */
export const clarkcantManifestSchema = z.union([packageManifestSchema, widgetPackageManifestSchema, legacyInstallManifestSchema]);
export type ClarkcantManifest = z.infer<typeof clarkcantManifestSchema>;

/* ------------------------------------------------------------------ *
 * Reading and normalising
 * ------------------------------------------------------------------ */

export type ManifestDialect = "package" | "widget-package" | "install";

export interface NormalizedFacet {
  /** `widget` only for schemaVersion 1 manifests, which ClarkCant reads as `ui`. */
  kind: FacetKind | "widget";
  /** The facet's id (schemaVersion 1 and 2); null in the schemaVersion-less draft. */
  id: string | null;
  entry: string;
  isolation: IsolationClass;
  renderer: FacetRenderer | null;
  /** The widget definition id a UI facet draws. */
  widgetId: string | null;
}

/** A `tools` facet: a separate process reached only through the host, with what it provides and reaches. */
export interface NormalizedService {
  facetId: string;
  entry: string;
  isolation: IsolationClass;
  protocol: string;
  capabilities: ServiceCapabilityDeclaration[];
  egress: ServiceEgress | null;
  connection: ServiceConnection | null;
}

export interface NormalizedBrowserToken {
  facetId: string;
  provider: string;
  scopes: string[];
  purpose: string;
}

/** The one shape listing code reads, whichever manifest dialect a package shipped. */
export interface NormalizedManifest {
  dialect: ManifestDialect;
  schemaVersion: 1 | 2 | null;
  id: string;
  version: string;
  displayName: string | null;
  description: string | null;
  hostApi: { min: number; max: number };
  facets: NormalizedFacet[];
  services: NormalizedService[];
  browserTokens: NormalizedBrowserToken[];
  requestedCapabilities: string[];
  permissions: {
    networkOrigins: string[];
    filesystem: { path: string; access: "read" | "write" }[];
    microphone: boolean;
    camera: boolean;
    lifecycleScripts: string[];
  };
  platforms: string[];
  /** The resource profile the package asks for; null means it asks for nothing (ClarkCant's default profile). */
  resources: { profile: ResourceProfileName; gpu: boolean } | null;
  publisher: { id: string; sourceUrl: string; license: string } | null;
}

function publisherOf(publisher: { id: string; sourceUrl: string; license: string } | undefined): NormalizedManifest["publisher"] {
  return publisher ? { id: publisher.id, sourceUrl: publisher.sourceUrl, license: publisher.license } : null;
}

function normalizeCanonical(manifest: PackageManifest): NormalizedManifest {
  const services: NormalizedService[] = [];
  const browserTokens: NormalizedBrowserToken[] = [];
  for (const facet of manifest.facets) {
    if (facet.kind === "tools") {
      services.push({
        facetId: facet.id,
        entry: facet.entry,
        isolation: facet.isolation,
        protocol: facet.protocol,
        capabilities: facet.capabilities,
        egress: facet.egress ?? null,
        connection: facet.connection ?? null,
      });
    } else if (facet.kind === "ui") {
      for (const provider of facet.browserTokens?.providers ?? []) {
        browserTokens.push({ facetId: facet.id, ...provider });
      }
    }
  }
  return {
    dialect: "package",
    schemaVersion: 2,
    id: manifest.id,
    version: manifest.version,
    displayName: manifest.displayName,
    description: manifest.description,
    hostApi: manifest.hostApi,
    facets: manifest.facets.map((facet) => ({
      kind: facet.kind,
      id: facet.id,
      entry: facet.entry,
      isolation: facet.isolation,
      renderer: null,
      widgetId: facet.kind === "ui" ? facet.id : null,
    })),
    services,
    browserTokens,
    requestedCapabilities: manifest.requestedCapabilities,
    permissions: manifest.permissions,
    platforms: manifest.platforms,
    resources: manifest.resources ? { profile: manifest.resources.profile, gpu: manifest.resources.gpu ?? false } : null,
    publisher: publisherOf(manifest.publisher),
  };
}

/** Normalises a manifest that already matched `clarkcantManifestSchema`. */
export function normalizeManifest(manifest: ClarkcantManifest): NormalizedManifest {
  if (!("schemaVersion" in manifest)) {
    return {
      dialect: "install",
      schemaVersion: null,
      id: manifest.id,
      version: manifest.version,
      displayName: null,
      description: null,
      hostApi: manifest.hostApi,
      facets: manifest.facets.map((facet) => ({
        kind: facet.kind,
        id: null,
        entry: facet.entry,
        isolation: facet.isolation,
        renderer: facet.renderer ?? null,
        widgetId: facet.widgetId ?? null,
      })),
      services: [],
      browserTokens: [],
      requestedCapabilities: manifest.requestedCapabilities,
      permissions: manifest.permissions,
      platforms: manifest.platforms,
      resources: null,
      publisher: publisherOf(manifest.publisher),
    };
  }
  if (manifest.schemaVersion === 1) {
    return {
      dialect: "widget-package",
      schemaVersion: 1,
      id: manifest.id,
      version: manifest.version,
      displayName: manifest.displayName,
      description: manifest.description,
      hostApi: manifest.hostApi,
      facets: manifest.facets.map((facet) => ({
        kind: facet.kind,
        id: facet.id,
        entry: facet.entry,
        isolation: facet.isolation,
        renderer: null,
        widgetId: facet.id,
      })),
      services: [],
      browserTokens: [],
      requestedCapabilities: manifest.requestedCapabilities,
      permissions: {
        ...manifest.permissions,
        filesystem: manifest.permissions.filesystem.map((path) => ({ path, access: "read" as const })),
      },
      platforms: manifest.platforms,
      resources: null,
      publisher: publisherOf(manifest.publisher),
    };
  }
  return normalizeCanonical(manifest);
}

export interface ManifestIssue {
  /** Dotted path into `clarkcant.json`; empty for the whole document. */
  path: string;
  message: string;
}

export type ManifestReadResult =
  | { ok: true; manifest: ClarkcantManifest; normalized: NormalizedManifest }
  | { ok: false; issues: ManifestIssue[] };

function zodIssues(error: z.ZodError, suffix = ""): ManifestIssue[] {
  return error.issues.map((issue) => ({ path: issue.path.map(String).join("."), message: `${issue.message}${suffix}` }));
}

/** Turns one `manifestProblems` sentence into an issue, keeping a leading field name as its path. */
function problemIssue(problem: string): ManifestIssue {
  const match = /^(id|facets): (.*)$/.exec(problem);
  return match ? { path: match[1] ?? "", message: match[2] ?? problem } : { path: "facets", message: problem };
}

/**
 * Reads a parsed `clarkcant.json` the way ClarkCant does: by its `schemaVersion`, with a schemaVersion 1 manifest
 * upgraded to the canonical shape and held to the same rules, so the marketplace lists only manifests ClarkCant reads.
 * The schemaVersion-less draft is the one marketplace-only allowance. Every issue names the field it is about.
 */
export function readClarkcantManifest(value: unknown): ManifestReadResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, issues: [{ path: "", message: "must be a JSON object" }] };
  }
  const schemaVersion = (value as { schemaVersion?: unknown }).schemaVersion;

  if (schemaVersion === undefined) {
    const legacy = legacyInstallManifestSchema.safeParse(value);
    if (!legacy.success) {
      return {
        ok: false,
        issues: [
          {
            path: "schemaVersion",
            message: `is missing; ClarkCant manifests declare schemaVersion ${String(PACKAGE_MANIFEST_SCHEMA_VERSION)} (a manifest without it is read as the older install draft, which this one does not match either)`,
          },
          ...zodIssues(legacy.error),
        ],
      };
    }
    return { ok: true, manifest: legacy.data, normalized: normalizeManifest(legacy.data) };
  }

  let canonicalInput: unknown = value;
  let v1: WidgetPackageManifest | null = null;
  if (schemaVersion === 1) {
    const parsed = widgetPackageManifestSchema.safeParse(value);
    if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error) };
    v1 = parsed.data;
    canonicalInput = upgradeWidgetManifestV1(parsed.data);
  } else if (schemaVersion !== PACKAGE_MANIFEST_SCHEMA_VERSION) {
    return {
      ok: false,
      issues: [
        {
          path: "schemaVersion",
          message: `must be ${String(PACKAGE_MANIFEST_SCHEMA_VERSION)} (or 1, the widget-only format ClarkCant still reads)`,
        },
      ],
    };
  }

  const canonical = packageManifestSchema.safeParse(canonicalInput);
  if (!canonical.success) {
    return {
      ok: false,
      issues: zodIssues(canonical.error, v1 ? " (a schemaVersion 1 value the canonical manifest does not accept)" : ""),
    };
  }
  const problems = manifestProblems(canonical.data);
  if (problems.length > 0) return { ok: false, issues: problems.map(problemIssue) };
  // A schemaVersion 1 manifest is stored as written: the upgrade is how it is checked, not what the package shipped.
  const manifest: ClarkcantManifest = v1 ?? canonical.data;
  return { ok: true, manifest, normalized: normalizeManifest(manifest) };
}

/**
 * Normalises a manifest stored on an indexed version, or returns null when it no longer matches the mirror (a row
 * indexed under an older rule). Read paths use this so a stale row degrades to "no details" instead of an error.
 */
export function normalizeStoredManifest(stored: unknown): NormalizedManifest | null {
  const parsed = clarkcantManifestSchema.safeParse(stored);
  return parsed.success ? normalizeManifest(parsed.data) : null;
}
