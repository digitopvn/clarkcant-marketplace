import {
  MarketplaceError,
  requireScope,
  type Actor,
  type AuditActor,
  type PageDocumentInput,
  type PageKind,
} from "@marketplace/contracts";
import { auditEvents, pageRevisions, pages } from "@marketplace/db";
import { and, eq, inArray } from "drizzle-orm";

import type { MarketplaceDeps } from "../deps";
import { LEGAL_PAGES } from "./legal-pages";
import { HOME_PAGE_SLUG, type CreatePageInput, type PageState, type PublishPageInput } from "./page-schemas";
import { createPage, createPageAsSystem, publishPage, publishPageAsSystem } from "./page-service";

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
            {
              question: "How do I publish a package?",
              answer:
                "Publish it to npm with a clarkcant.json manifest and the \"clarkcant\" keyword. The marketplace indexes it automatically; the publisher guide at /publish has the details.",
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

/** The publisher guide. Every step mirrors what the indexer and the publish API enforce today. */
const PUBLISH: DefaultPage = {
  slug: "publish",
  kind: "custom",
  document: {
    schemaVersion: 1,
    layout: { id: "editorial", version: 1 },
    meta: {
      title: "Publish a package to the ClarkCant Marketplace",
      description:
        "How to list a ClarkCant widget, tool or theme: publish it to npm with a clarkcant.json manifest and a ClarkCant keyword, then let the marketplace index it.",
      locale: "en",
      noindex: false,
    },
    blocks: [
      {
        id: "publish-hero",
        type: "hero",
        version: 1,
        props: {
          eyebrow: "For package authors",
          title: "Publish a package",
          subtitle:
            "There is no upload form. You publish to npm as usual; the marketplace finds packages that declare a ClarkCant manifest, checks them and lists them.",
          align: "start",
          tone: "plain",
        },
      },
      {
        id: "publish-body",
        type: "rich-text",
        version: 1,
        props: {
          width: "prose",
          markdown: [
            "## 1. Add a `clarkcant.json` manifest",
            "",
            "Put `clarkcant.json` at the root of the package. It declares what the package contains and every permission it asks for: network origins, filesystem paths, microphone, camera and lifecycle scripts. A widget manifest looks like this:",
            "",
            "```json",
            "{",
            '  "schemaVersion": 1,',
            '  "id": "com.acme.clock",',
            '  "version": "1.0.0",',
            '  "displayName": "Clock",',
            '  "description": "A desk clock for your ClarkCant home screen.",',
            '  "hostApi": { "min": 1, "max": 1 },',
            '  "facets": [',
            '    { "kind": "widget", "id": "com.acme.clock.main@1", "entry": "widgets/main/index.html", "definition": "widgets/main/widget.json", "isolation": "isolated-ui" }',
            "  ],",
            '  "requestedCapabilities": [],',
            '  "permissions": { "networkOrigins": [], "filesystem": [], "microphone": false, "camera": false, "lifecycleScripts": [] },',
            '  "platforms": ["web"],',
            '  "publisher": { "id": "acme", "sourceUrl": "https://github.com/acme/clock-widget", "license": "MIT" }',
            "}",
            "```",
            "",
            "- `version` must equal the version in `package.json`; a mismatch is rejected.",
            "- Unknown fields are rejected, so keep the manifest to the fields ClarkCant defines.",
            "- Tools and themes use ClarkCant's install-plan manifest instead (facets such as `tools`, `ui` or `themes`). Both shapes are accepted.",
            "",
            "## 2. Describe it for people",
            "",
            "- The package `README` is shown on the package page. It is sanitised, and READMEs over 256 KiB are left out.",
            "- Images in a `previews/` folder (PNG, JPEG, GIF or WebP) become screenshots. `previews/cover.*` is shown first; up to 8 images are kept, 5 MiB each.",
            "",
            "## 3. Add a keyword and publish to npm",
            "",
            'Add `"clarkcant"` (or `"clarkcant-widget"`) to `keywords` in `package.json`, then run `npm publish`. The packed tarball must stay under 25 MiB.',
            "",
            "## 4. Get indexed",
            "",
            "The marketplace searches npm for those keywords every six hours and indexes new versions automatically. To index a version right away, sign in, create a personal API token under Account, and submit it:",
            "",
            "```sh",
            "curl -X POST https://marketplace.clarkcant.cc/api/v1/publish/submit \\",
            '  -H "Authorization: Bearer $CLARK_MARKET_TOKEN" \\',
            '  -H "Content-Type: application/json" \\',
            "  -d '{\"name\": \"@acme/clock-widget\", \"version\": \"1.0.0\"}'",
            "```",
            "",
            "The response carries a submission id; `GET /api/v1/publish/submissions/{id}` reports the outcome, including the reason when a version is rejected. The [API reference](/docs/api) documents both calls, and MCP clients can use the `submit_package` tool.",
            "",
            "## What indexing checks, and what it does not",
            "",
            "Indexing pins the exact npm version, verifies the tarball against the registry's integrity hash, and validates the manifest. A version that passes is **listed**: it passed automated checks and was not reviewed by a person. **Featured** packages are chosen by curators. npm provenance is recorded when present, not verified.",
            "",
            "A published version never changes. To fix a rejected or listed version, publish a new version to npm.",
            "",
            "## Installing stays with ClarkCant",
            "",
            "Being listed grants nothing. People install from inside ClarkCant, which shows every permission your manifest requests before the package runs.",
          ].join("\n"),
        },
      },
      {
        id: "publish-cta",
        type: "cta",
        version: 1,
        props: {
          title: "See how listed packages look",
          body: "",
          primary: { label: "Browse packages", href: "/packages" },
          secondary: { label: "API reference", href: "/docs/api" },
        },
      },
    ],
  },
};

/** Landing, about, the publisher guide and the policy pages (terms, privacy, cookies, refunds, GDPR, security, subprocessors). */
export const DEFAULT_PAGES: readonly DefaultPage[] = [
  LANDING,
  ABOUT,
  PUBLISH,
  ...LEGAL_PAGES.map((page) => ({ slug: page.slug, kind: "legal" as const, document: page.document })),
];

export interface DefaultPagesResult {
  /** Slugs published by this call: newly created, or a system-seeded page an interrupted earlier run left unpublished. */
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
  return createMissingDefaultPages(deps, {
    create: (input) => createPage(deps, actor, input),
    publish: (input) => publishPage(deps, actor, input),
  });
}

/** The audit identity of the jobs Worker when it seeds default pages. */
export const DEFAULT_PAGES_ACTOR: AuditActor = { type: "system", id: "jobs.default-pages" };

/**
 * {@link ensureDefaultPages} run by the system, with no account: the jobs Worker calls it on a schedule so a freshly
 * deployed environment gets its landing, about and policy pages without a manual step. It is a single cheap query
 * when every page exists, and like the admin command it never touches a page that exists (edited, unpublished or
 * not). Every page it creates and publishes is recorded in the audit log as {@link DEFAULT_PAGES_ACTOR}.
 */
export function ensureDefaultPagesAsSystem(deps: MarketplaceDeps): Promise<DefaultPagesResult> {
  return createMissingDefaultPages(deps, {
    create: (input) => createPageAsSystem(deps, DEFAULT_PAGES_ACTOR, input),
    publish: (input) => publishPageAsSystem(deps, DEFAULT_PAGES_ACTOR, input),
  });
}

interface PageWriters {
  create(input: CreatePageInput): Promise<PageState>;
  publish(input: PublishPageInput): Promise<PageState>;
}

const isConflict = (error: unknown) => error instanceof MarketplaceError && error.code === "conflict";

async function createMissingDefaultPages(deps: MarketplaceDeps, writers: PageWriters): Promise<DefaultPagesResult> {
  const slugs = DEFAULT_PAGES.map((page) => page.slug);
  const rows = await deps.db
    .select({
      slug: pages.slug,
      id: pages.id,
      draftId: pages.currentDraftRevisionId,
      publishedId: pages.publishedRevisionId,
      draftNumber: pageRevisions.number,
      draftAuthor: pageRevisions.authorId,
    })
    .from(pages)
    .leftJoin(pageRevisions, eq(pageRevisions.id, pages.currentDraftRevisionId))
    .where(inArray(pages.slug, slugs));
  const present = new Map(rows.map((row) => [row.slug, row]));
  const seeded = await systemSeededPageIds(
    deps,
    rows.filter((row) => row.publishedId === null && row.draftId !== null && row.draftNumber === 1).map((row) => row.id),
  );
  const result: DefaultPagesResult = { created: [], existing: [] };
  for (const page of DEFAULT_PAGES) {
    const existing = present.get(page.slug);
    let target: { pageId: string; revisionId: string };
    if (existing) {
      // A page the jobs Worker created but never published (an interrupted earlier run): still revision 1, so never
      // edited by anyone, and never published, so finishing it cannot overwrite anything. The creator is proven by the
      // `page.created` audit event, not by a null revision author: authors become null when an account is deleted, and
      // an editor's unpublished draft must never be published by the cron. Every other page is left alone.
      const unfinished =
        existing.publishedId === null &&
        existing.draftNumber === 1 &&
        existing.draftAuthor === null &&
        seeded.has(existing.id);
      if (!unfinished || existing.draftId === null) {
        result.existing.push(page.slug);
        continue;
      }
      target = { pageId: existing.id, revisionId: existing.draftId };
    } else {
      try {
        const state = await writers.create({ slug: page.slug, kind: page.kind, document: page.document });
        target = { pageId: state.page.id, revisionId: state.draft.revision.id };
      } catch (error) {
        // Another request created it in the meantime; that page wins and is left alone.
        if (isConflict(error)) {
          result.existing.push(page.slug);
          continue;
        }
        throw error;
      }
    }
    try {
      await writers.publish(target);
    } catch (error) {
      // A concurrent run published or edited it first; either way it is no longer ours to publish.
      if (isConflict(error)) {
        result.existing.push(page.slug);
        continue;
      }
      throw error;
    }
    result.created.push(page.slug);
  }
  return result;
}

/** The pages among `pageIds` whose `page.created` audit event was recorded by {@link DEFAULT_PAGES_ACTOR}. */
async function systemSeededPageIds(deps: MarketplaceDeps, pageIds: string[]): Promise<Set<string>> {
  if (pageIds.length === 0) return new Set();
  const rows = await deps.db
    .select({ pageId: auditEvents.subjectId })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.action, "page.created"),
        eq(auditEvents.subjectType, "page"),
        inArray(auditEvents.subjectId, pageIds),
        eq(auditEvents.actorType, DEFAULT_PAGES_ACTOR.type),
        eq(auditEvents.actorId, DEFAULT_PAGES_ACTOR.id ?? ""),
      ),
    );
  return new Set(rows.flatMap((row) => (row.pageId === null ? [] : [row.pageId])));
}
