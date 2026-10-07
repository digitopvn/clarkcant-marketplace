import type { PackageDetail, PackageInstall, PackageSummary, PackageVersionSummary } from "@marketplace/contracts";

export const SITE = "https://market.example";

export function summary(name: string, overrides: Partial<PackageSummary> = {}): PackageSummary {
  return {
    name,
    displayName: name,
    description: "A package",
    latestVersion: "1.2.3",
    publisher: { slug: "acme", name: "Acme", verified: true },
    categorySlug: "widgets",
    curationStatus: "listed",
    keywords: ["clarkcant"],
    indexedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-02T10:00:00.000Z",
    ...overrides,
  };
}

export function detail(overrides: Partial<PackageDetail> = {}): PackageDetail {
  return {
    ...summary("@acme/frame-widget", { displayName: "Frame *widget*", description: "Shows <b>frames</b> & more" }),
    homepage: null,
    repositoryUrl: "https://github.com/acme/frame-widget",
    license: "MIT",
    latest: {
      version: "1.2.3",
      publishedAt: "2026-09-01T00:00:00.000Z",
      indexedAt: "2026-09-01T01:00:00.000Z",
      npmIntegrity: "sha512-abc",
      tarballSha512Verified: true,
      hasProvenance: false,
      readmeHtml: "<p>third-party README text</p>",
      platforms: ["web", "darwin-arm64"],
      facets: [{ kind: "widget", isolation: "isolated-ui", renderer: "isolated-app", entry: "widgets/main/index.html", widgetId: "main" }],
      manifestSchemaVersion: 1,
      permissions: [{ kind: "network", value: "https://api.example.com", access: null }],
      services: [],
      browserTokens: [],
      resources: null,
      previews: [],
      securityChecks: [{ check: "integrity", result: "pass", details: null }],
      directory: null,
    },
    versions: [{ version: "1.2.3", publishedAt: "2026-09-01T00:00:00.000Z" }],
    ...overrides,
  };
}

export const INSTALL: PackageInstall = {
  package: "@acme/frame-widget",
  version: "1.2.3",
  source: "npm",
  integrity: "sha512-abc",
  openInClarkCant: "clarkcant://install?source=npm&package=%40acme%2Fframe-widget&version=1.2.3",
  cliCommand: "npm pack @acme/frame-widget@1.2.3",
  packageId: "acme.frame-widget",
  contentDigest: null,
  sizeBytes: null,
};

export const VERSIONS: PackageVersionSummary[] = [
  {
    version: "1.2.3",
    publishedAt: "2026-09-01T00:00:00.000Z",
    indexedAt: "2026-09-01T01:00:00.000Z",
    npmIntegrity: "sha512-abc",
    tarballSha512Verified: true,
    hasProvenance: false,
  },
];
