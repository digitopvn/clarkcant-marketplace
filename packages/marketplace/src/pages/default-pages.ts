import { MarketplaceError, requireScope, type Actor, type PageDocumentInput, type PageKind } from "@marketplace/contracts";
import { pages } from "@marketplace/db";
import { inArray } from "drizzle-orm";

import type { MarketplaceDeps } from "../deps";
import { LEGAL_PAGES } from "./legal-pages";
import { HOME_PAGE_SLUG } from "./page-schemas";
import { createPage, publishPage } from "./page-service";

/*
 * The pages a fresh marketplace starts with. They are ordinary block documents created and published through the
 * page commands (revisions, audit events, validation), so editors change them in the builder like any other page.
 * Every statement mirrors the product copy the site already makes; package sections render live data.
 */

interface DefaultPage {
  slug: string;
  kind: PageKind;
  document: PageDocumentInput;
}

const LANDING: DefaultPage = {
  slug: HOME_PAGE_SLUG,
  kind: "landing",
  document: {
    schemaVersion: 1,
    layout: { id: "marketplace-landing", version: 1 },
    meta: {
      title: "ClarkCant Marketplace",
      description: "Discover widgets, tools, and themes for ClarkCant, curated from npm. Install them from inside ClarkCant.",
      locale: "en",
      noindex: false,
    },
    blocks: [
      {
        id: "home-hero",
        type: "hero",
        version: 1,
        props: {
          eyebrow: "ClarkCant Marketplace",
          title: "Widgets, tools, and themes for ClarkCant, curated from npm.",
          subtitle:
            "Browse packages that declare a ClarkCant manifest. Install them from inside ClarkCant, which reviews every permission a package asks for before it runs.",
          align: "start",
          tone: "spectrum",
        },
        children: [
          {
            id: "home-hero-cta",
            type: "cta",
            version: 1,
            props: { title: "", body: "", primary: { label: "Browse packages", href: "/packages" }, secondary: { label: "About the marketplace", href: "/about" } },
          },
        ],
      },
      { id: "home-featured", type: "featured-packages", version: 1, props: { title: "Featured", limit: 6 } },
      { id: "home-latest", type: "package-grid", version: 1, props: { title: "Latest packages", category: "", sort: "latest", limit: 6 } },
      {
        id: "home-faq",
        type: "faq",
        version: 1,
        props: {
          title: "How the marketplace works",
          items: [
            {
              question: "Where do packages come from?",
              answer: "Packages are published to npm by their authors. The marketplace lists the ones that declare a ClarkCant manifest.",
            },
            {
              question: "How do I install a package?",
              answer: "From inside ClarkCant. It reviews every permission a package asks for before the package runs.",
            },
            {
              question: "Does a listing grant a package any permissions?",
              answer: "No. The marketplace only lists and describes packages; npm distributes them, and ClarkCant decides what they may do.",
            },
          ],
        },
      },
    ],
  },
};

const ABOUT: DefaultPage = {
  slug: "about",
  kind: "custom",
  document: {
    schemaVersion: 1,
    layout: { id: "editorial", version: 1 },
    meta: {
      title: "About the ClarkCant Marketplace",
      description: "How the ClarkCant Marketplace lists, describes and curates packages distributed through npm.",
      locale: "en",
      noindex: false,
    },
    blocks: [
      {
        id: "about-hero",
        type: "hero",
        version: 1,
        props: { eyebrow: "About", title: "Discovery and curation for ClarkCant packages", subtitle: "", align: "start", tone: "plain" },
      },
      {
        id: "about-body",
        type: "rich-text",
        version: 1,
        props: {
          width: "prose",
          markdown: [
            "The marketplace lists and describes packages. **npm distributes them** and **ClarkCant installs and runs them**.",
            "",
            "## What is listed",
            "",
            "Packages published to npm that declare a ClarkCant manifest: widgets, tools, and themes.",
            "",
            "## Permissions stay with ClarkCant",
            "",
            "Nothing the marketplace shows grants runtime permissions. When you install a package, ClarkCant reviews every permission it asks for before it runs.",
            "",
            "## For agents and tools",
            "",
            "Every page is also available as Markdown, and the catalogue is described by an [OpenAPI document](/openapi.json).",
          ].join("\n"),
        },
      },
      {
        id: "about-cta",
        type: "cta",
        version: 1,
        props: { title: "Find something for your ClarkCant", body: "", primary: { label: "Browse packages", href: "/packages" } },
      },
    ],
  },
};

/** Landing, about and the policy pages (terms, privacy, cookies, refunds, GDPR, security, subprocessors). */
export const DEFAULT_PAGES: readonly DefaultPage[] = [
  LANDING,
  ABOUT,
  ...LEGAL_PAGES.map((page) => ({ slug: page.slug, kind: "legal" as const, document: page.document })),
];

export interface DefaultPagesResult {
  /** Slugs created and published by this call. */
  created: string[];
  /** Slugs that already existed and were left untouched. */
  existing: string[];
}

/**
 * Creates and publishes the default landing, about and policy pages when they do not exist yet. Existing pages are never
 * overwritten, so running it again (or concurrently) is safe. Requires `pages:publish`.
 */
export async function ensureDefaultPages(deps: MarketplaceDeps, actor: Actor): Promise<DefaultPagesResult> {
  requireScope(actor, "pages:publish");
  const slugs = DEFAULT_PAGES.map((page) => page.slug);
  const present = new Set(
    (await deps.db.select({ slug: pages.slug }).from(pages).where(inArray(pages.slug, slugs))).map((row) => row.slug),
  );
  const result: DefaultPagesResult = { created: [], existing: [] };
  for (const page of DEFAULT_PAGES) {
    if (present.has(page.slug)) {
      result.existing.push(page.slug);
      continue;
    }
    let state;
    try {
      state = await createPage(deps, actor, { slug: page.slug, kind: page.kind, document: page.document });
    } catch (error) {
      // Another request created it in the meantime; that page wins and is left alone.
      if (error instanceof MarketplaceError && error.code === "conflict") {
        result.existing.push(page.slug);
        continue;
      }
      throw error;
    }
    await publishPage(deps, actor, { pageId: state.page.id, revisionId: state.draft.revision.id });
    result.created.push(page.slug);
  }
  return result;
}
