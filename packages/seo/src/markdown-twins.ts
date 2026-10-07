import type { Category, CollectionDetail, PackageDetail, PackageInstall, PackageSummary, PackageVersionSummary } from "@marketplace/contracts";
import { escapeMarkdown, joinMarkdown, mdCode, mdHeading, mdInlineCode, mdLink } from "@marketplace/page-engine";

import {
  checkLabel,
  checkSummary,
  describePermission,
  describeService,
  isolationLane,
  platformLabel,
  RISK_LABELS,
  standalonePermissions,
} from "./package-labels";
import { SITE_DESCRIPTION, SITE_NAME, canonicalUrl, categoryPath, collectionPath, markdownPathFor, packagePath } from "./site";

/**
 * Markdown twins of the catalogue pages, rendered from the same records as the HTML (never scraped from it). Page
 * builder pages use the page engine's `renderPage().markdown` instead. Third-party text (package descriptions)
 * is escaped; package READMEs are not inlined: they are the author's content and live on npm.
 */

const CURATION_MEANING: Record<string, string> = {
  listed: "Listed: passed automated checks (manifest, integrity) when indexed; not reviewed by a person.",
  featured: "Featured: chosen by marketplace curators.",
};

function bullet(label: string, value: string): string {
  return `- ${escapeMarkdown(label)}: ${value}`;
}

function packageLine(siteUrl: string, pkg: PackageSummary): string {
  const url = canonicalUrl(siteUrl, markdownPathFor(packagePath(pkg.name)));
  const version = pkg.latestVersion ? ` (v${escapeMarkdown(pkg.latestVersion)})` : "";
  const description = pkg.description ? `: ${escapeMarkdown(pkg.description.replace(/\s+/g, " ").trim())}` : "";
  return `- ${mdLink(pkg.displayName, url)} ${mdInlineCode(pkg.name)}${version}${description}`;
}

export function renderPackageListMarkdown(siteUrl: string, packages: readonly PackageSummary[], empty: string): string {
  return packages.length > 0 ? packages.map((pkg) => packageLine(siteUrl, pkg)).join("\n") : escapeMarkdown(empty);
}

export interface PackageMarkdownInput {
  siteUrl: string;
  pkg: PackageDetail;
  install: PackageInstall | null;
  versions: readonly PackageVersionSummary[];
}

export function renderPackageMarkdown({ siteUrl, pkg, install, versions }: PackageMarkdownInput): string {
  const latest = pkg.latest;
  const pageUrl = canonicalUrl(siteUrl, packagePath(pkg.name));
  const npmUrl = `https://www.npmjs.com/package/${pkg.name}`;

  const facts = [
    bullet("Package", mdInlineCode(pkg.name)),
    pkg.latestVersion ? bullet("Latest version", mdInlineCode(pkg.latestVersion)) : bullet("Latest version", "none indexed yet"),
    bullet(
      "Publisher",
      pkg.publisher
        ? `${escapeMarkdown(pkg.publisher.name)}${pkg.publisher.verified ? " (verified publisher: proved control of a web domain with a DNS TXT record)" : ""}`
        : "unclaimed",
    ),
    bullet("Curation", escapeMarkdown(CURATION_MEANING[pkg.curationStatus] ?? pkg.curationStatus)),
    pkg.license ? bullet("License", escapeMarkdown(pkg.license)) : "",
    pkg.categorySlug ? bullet("Category", mdLink(pkg.categorySlug, canonicalUrl(siteUrl, markdownPathFor(categoryPath(pkg.categorySlug))))) : "",
    bullet("npm", mdLink(npmUrl, npmUrl)),
    pkg.repositoryUrl ? bullet("Source", mdLink(pkg.repositoryUrl, pkg.repositoryUrl)) : "",
    bullet("Web page", mdLink(pageUrl, pageUrl)),
  ].filter(Boolean);

  const installSection = install
    ? joinMarkdown([
        mdHeading(2, "Install"),
        "ClarkCant installs packages from npm and re-verifies the integrity digest before asking for consent. The marketplace never serves the package itself.",
        mdCode(JSON.stringify({ package: install.package, version: install.version, source: install.source }, null, 2), "json"),
        [
          bullet("Integrity", mdInlineCode(install.integrity)),
          bullet("Open in ClarkCant (proposed deep link)", mdInlineCode(install.openInClarkCant)),
          bullet("Manual fetch", mdInlineCode(install.cliCommand)),
        ].join("\n"),
      ])
    : "";

  const facetSection = latest
    ? joinMarkdown([
        mdHeading(2, "How it runs"),
        latest.facets.length > 0
          ? latest.facets
              .map((facet) => {
                const lane = isolationLane(facet.isolation);
                return `- ${escapeMarkdown(facet.kind)} (${escapeMarkdown(lane.label)}, ${escapeMarkdown(RISK_LABELS[lane.risk])}): ${escapeMarkdown(lane.summary)} Entry ${mdInlineCode(facet.widgetId ?? facet.entry)}.`;
              })
              .join("\n")
          : "No facets declared.",
        latest.platforms.length > 0
          ? bullet("Platforms", latest.platforms.map((platform) => escapeMarkdown(platformLabel(platform))).join(", "))
          : "No platforms declared.",
      ])
    : "";

  const serviceSections = (latest?.services ?? []).map((service) => {
    const lines = describeService(service);
    const titled = (title: string, items: string[]) => (items.length > 0 ? `${title}\n${items.join("\n")}` : "");
    return joinMarkdown([
      mdHeading(3, `Service ${service.facetId} (${service.protocol})`),
      lines.provides
        .map((capability) => {
          const notes = capability.notes.length > 0 ? ` ${escapeMarkdown(capability.notes.join(" "))}` : "";
          return `- ${escapeMarkdown(capability.title)} (${escapeMarkdown(RISK_LABELS[capability.risk])}): ${mdInlineCode(capability.detail)}.${notes}`;
        })
        .join("\n"),
      titled(
        "Reaches, through ClarkCant:",
        lines.reaches.map(
          (reach) => `- ${mdInlineCode(reach.origin)}: ${escapeMarkdown(reach.purpose)}${reach.credential ? ` ${escapeMarkdown(reach.credential)}` : ""}`,
        ),
      ),
      titled(
        "Secrets you provide:",
        lines.secrets.map((secret) => `- ${mdInlineCode(secret.name)}: ${escapeMarkdown(secret.purpose)}`),
      ),
      lines.connection
        ? titled(
            `Account connection, ${escapeMarkdown(lines.connection.title)}. ${escapeMarkdown(lines.connection.signIn)}`,
            [
              ...lines.connection.scopes.map((scope) => `- Scope ${mdInlineCode(scope.scope)}: ${escapeMarkdown(scope.purpose)}`),
              `- Account API: ${lines.connection.endpoints.map((endpoint) => mdInlineCode(endpoint)).join(", ")}`,
            ],
          )
        : "",
    ]);
  });
  const otherPermissions = latest ? standalonePermissions(latest) : [];

  const permissionSection = latest
    ? joinMarkdown([
        mdHeading(2, "Requested permissions"),
        "Declared in the package manifest. ClarkCant asks for consent at install time; a listing grants nothing.",
        ...serviceSections,
        serviceSections.length > 0 ? mdHeading(3, "Other permissions") : "",
        otherPermissions.length > 0
          ? otherPermissions
              .map((permission) => {
                const line = describePermission(permission);
                return `- ${escapeMarkdown(line.title)} (${escapeMarkdown(RISK_LABELS[line.risk])}): ${escapeMarkdown(line.detail)}`;
              })
              .join("\n")
          : serviceSections.length > 0
            ? "Nothing beyond what its services declare above."
            : "No permissions requested.",
      ])
    : "";

  const factsSection = latest
    ? joinMarkdown([
        mdHeading(2, "Integrity and provenance"),
        `Automated facts recorded when v${escapeMarkdown(latest.version)} was indexed. They are not a review and do not mean the code is safe to run.`,
        latest.securityChecks.map((check) => `- ${escapeMarkdown(checkLabel(check))} (${check.result}): ${escapeMarkdown(checkSummary(check))}`).join("\n"),
      ])
    : "";

  const versionSection =
    versions.length > 0
      ? joinMarkdown([mdHeading(2, "Versions"), versions.map((version) => `- ${mdInlineCode(version.version)} published ${version.publishedAt.slice(0, 10)}`).join("\n")])
      : "";

  return `${joinMarkdown([
    mdHeading(1, pkg.displayName),
    pkg.description ? escapeMarkdown(pkg.description) : "",
    facts.join("\n"),
    latest ? "" : "This package has no indexed version yet.",
    installSection,
    facetSection,
    permissionSection,
    factsSection,
    versionSection,
    joinMarkdown([mdHeading(2, "README"), `The README is written by the package author and published on npm: ${mdLink(npmUrl, npmUrl)}.`]),
  ])}\n`;
}

export function renderCategoryMarkdown(siteUrl: string, category: Category, packages: readonly PackageSummary[], hasMore: boolean): string {
  const pageUrl = canonicalUrl(siteUrl, categoryPath(category.slug));
  return `${joinMarkdown([
    mdHeading(1, category.name),
    category.description ? escapeMarkdown(category.description) : "",
    bullet("Web page", mdLink(pageUrl, pageUrl)),
    mdHeading(2, "Packages"),
    renderPackageListMarkdown(siteUrl, packages, "No listed packages in this category yet."),
    hasMore ? `More packages: ${mdLink("search this category", `${canonicalUrl(siteUrl, "/api/v1/packages")}?category=${encodeURIComponent(category.slug)}`)} through the API.` : "",
  ])}\n`;
}

export function renderCollectionMarkdown(siteUrl: string, collection: CollectionDetail): string {
  const pageUrl = canonicalUrl(siteUrl, collectionPath(collection.slug));
  return `${joinMarkdown([
    mdHeading(1, collection.title),
    collection.description ? escapeMarkdown(collection.description) : "",
    bullet("Web page", mdLink(pageUrl, pageUrl)),
    "A collection is hand-picked by the marketplace curators.",
    mdHeading(2, "Packages"),
    renderPackageListMarkdown(siteUrl, collection.packages, "This collection has no listed packages right now."),
  ])}\n`;
}

export interface PackagesIndexMarkdownInput {
  siteUrl: string;
  packages: readonly PackageSummary[];
  categories: readonly Category[];
  hasMore: boolean;
}

/** Twin of the unfiltered `/packages` listing (first page). Filtered and paginated views are not indexed. */
export function renderPackagesIndexMarkdown({ siteUrl, packages, categories, hasMore }: PackagesIndexMarkdownInput): string {
  const pageUrl = canonicalUrl(siteUrl, "/packages");
  const searchUrl = canonicalUrl(siteUrl, "/api/v1/packages");
  return `${joinMarkdown([
    mdHeading(1, "All packages"),
    "Widgets, tools, and themes for ClarkCant, listed from npm. A listing never grants a package any permission; ClarkCant asks for consent at install time.",
    bullet("Web page", mdLink(pageUrl, pageUrl)),
    bullet("Search", `${mdLink("package search API", searchUrl)} (query parameters \`q\`, \`category\`, \`kind\`, \`isolation\`, \`platform\`, \`curation\`)`),
    categories.length > 0
      ? joinMarkdown([
          mdHeading(2, "Categories"),
          categories
            .map((category) => `- ${mdLink(category.name, canonicalUrl(siteUrl, markdownPathFor(categoryPath(category.slug))))} (${category.packageCount})`)
            .join("\n"),
        ])
      : "",
    mdHeading(2, "Packages"),
    renderPackageListMarkdown(siteUrl, packages, "No packages are listed yet."),
    hasMore ? `More packages: page through the ${mdLink("package search API", searchUrl)}.` : "",
  ])}\n`;
}

export interface CollectionsIndexEntry {
  slug: string;
  title: string;
  description?: string | null | undefined;
}

/** Twin of `/collections`. */
export function renderCollectionsIndexMarkdown(siteUrl: string, collections: readonly CollectionsIndexEntry[]): string {
  const pageUrl = canonicalUrl(siteUrl, "/collections");
  return `${joinMarkdown([
    mdHeading(1, "Collections"),
    "Hand-picked sets of packages, chosen by the marketplace curators.",
    bullet("Web page", mdLink(pageUrl, pageUrl)),
    collections.length > 0
      ? collections
          .map((collection) => {
            const url = canonicalUrl(siteUrl, markdownPathFor(collectionPath(collection.slug)));
            const description = collection.description ? `: ${escapeMarkdown(collection.description.replace(/\s+/g, " ").trim())}` : "";
            return `- ${mdLink(collection.title, url)}${description}`;
          })
          .join("\n")
      : "Curators have not published a collection yet.",
  ])}\n`;
}

export interface HomeMarkdownInput {
  siteUrl: string;
  featured: readonly PackageSummary[];
  latest: readonly PackageSummary[];
  categories: readonly Category[];
}

/** Twin of the built-in landing page, used while no builder "home" page is published. */
export function renderHomeMarkdown({ siteUrl, featured, latest, categories }: HomeMarkdownInput): string {
  return `${joinMarkdown([
    mdHeading(1, SITE_NAME),
    escapeMarkdown(SITE_DESCRIPTION),
    "Install packages from inside ClarkCant, which reviews every permission a package asks for before it runs. A listing here never grants a package any permission.",
    bullet("Machine-readable index", mdLink("llms.txt", canonicalUrl(siteUrl, "/llms.txt"))),
    bullet("HTTP API", mdLink("OpenAPI document", canonicalUrl(siteUrl, "/openapi.json"))),
    categories.length > 0
      ? joinMarkdown([
          mdHeading(2, "Categories"),
          categories
            .map((category) => `- ${mdLink(category.name, canonicalUrl(siteUrl, markdownPathFor(categoryPath(category.slug))))} (${category.packageCount})`)
            .join("\n"),
        ])
      : "",
    featured.length > 0 ? joinMarkdown([mdHeading(2, "Featured"), renderPackageListMarkdown(siteUrl, featured, "")]) : "",
    joinMarkdown([mdHeading(2, "Latest"), renderPackageListMarkdown(siteUrl, latest, "No packages are listed yet.")]),
  ])}\n`;
}
