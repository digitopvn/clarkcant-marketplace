import type { PageKind } from "@marketplace/contracts";

import type { LayoutDefinition, LayoutRegion } from "./types";

const HEADER: LayoutRegion = { id: "header", label: "Header", allowedBlocks: ["hero"], maxBlocks: 1 };

const PACKAGE_BLOCKS = ["package-grid", "featured-packages", "collection", "publisher-profile"] as const;
const CONTENT_BLOCKS = ["rich-text", "media", "stats", "cta", "faq", "comparison", "logo-cloud", "code-install-snippet"] as const;

/**
 * Layouts fix which blocks a page may use and where. A page's top-level blocks fill the regions in order: each block
 * goes into the current region if allowed there (and it has room), otherwise into the next region that accepts it.
 * A block that fits no remaining region is a validation error, so e.g. a hero can only open a page.
 */
const LAYOUTS: readonly LayoutDefinition[] = [
  {
    id: "marketplace-landing",
    version: 1,
    label: "Marketplace landing",
    description: "Home and campaign pages: a hero followed by package showcases and supporting content.",
    regions: [HEADER, { id: "main", label: "Main", allowedBlocks: [...PACKAGE_BLOCKS, ...CONTENT_BLOCKS] }],
  },
  {
    id: "package-detail",
    version: 1,
    label: "Package detail",
    description: "Long-form content about one package, then related packages.",
    regions: [
      HEADER,
      { id: "main", label: "Main", allowedBlocks: ["rich-text", "media", "code-install-snippet", "faq", "comparison", "cta", "stats"] },
      { id: "related", label: "Related", allowedBlocks: [...PACKAGE_BLOCKS] },
    ],
  },
  {
    id: "category",
    version: 1,
    label: "Category",
    description: "A category landing page: intro, package grid and answers.",
    regions: [HEADER, { id: "main", label: "Main", allowedBlocks: ["package-grid", "featured-packages", "rich-text", "media", "faq", "cta", "stats"] }],
  },
  {
    id: "collection",
    version: 1,
    label: "Collection",
    description: "A curated collection with editorial context.",
    regions: [HEADER, { id: "main", label: "Main", allowedBlocks: ["collection", "package-grid", "rich-text", "media", "faq", "cta"] }],
  },
  {
    id: "editorial",
    version: 1,
    label: "Editorial",
    description: "Articles and custom pages such as About.",
    regions: [HEADER, { id: "main", label: "Main", allowedBlocks: [...CONTENT_BLOCKS, ...PACKAGE_BLOCKS] }],
  },
  {
    id: "docs-legal",
    version: 1,
    label: "Docs and legal",
    description: "Documentation and policy pages: prose-first, no promotional package blocks.",
    regions: [HEADER, { id: "main", label: "Main", allowedBlocks: ["rich-text", "faq", "cta", "media", "comparison", "code-install-snippet"] }],
  },
];

const byKey = new Map(LAYOUTS.map((layout) => [`${layout.id}@${layout.version}`, layout]));

export function getLayout(id: string, version: number): LayoutDefinition | undefined {
  return byKey.get(`${id}@${version}`);
}

export function listLayouts(): readonly LayoutDefinition[] {
  return LAYOUTS;
}

/** The layout a new page of `kind` starts with. */
export function defaultLayoutForKind(kind: PageKind): { id: string; version: number } {
  switch (kind) {
    case "landing":
      return { id: "marketplace-landing", version: 1 };
    case "legal":
    case "docs":
      return { id: "docs-legal", version: 1 };
    case "category":
      return { id: "category", version: 1 };
    case "collection":
      return { id: "collection", version: 1 };
    case "custom":
      return { id: "editorial", version: 1 };
  }
}

export interface RegionAssignment<T> {
  region: LayoutRegion;
  blocks: T[];
}

/**
 * Places top-level blocks into the layout's regions (see the module note). Returns the failing block index when a
 * block fits nowhere, so validation can point at it.
 */
export function assignRegions<T extends { type: string }>(
  layout: LayoutDefinition,
  blocks: readonly T[],
): { ok: true; regions: RegionAssignment<T>[] } | { ok: false; index: number; allowed: string[] } {
  const regions: RegionAssignment<T>[] = layout.regions.map((region) => ({ region, blocks: [] }));
  let current = 0;
  for (const [index, block] of blocks.entries()) {
    let placed = false;
    for (let candidate = current; candidate < regions.length; candidate += 1) {
      const slot = regions[candidate];
      if (!slot) break;
      const { region } = slot;
      const hasRoom = region.maxBlocks === undefined || slot.blocks.length < region.maxBlocks;
      if (region.allowedBlocks.includes(block.type) && hasRoom) {
        slot.blocks.push(block);
        current = candidate;
        placed = true;
        break;
      }
    }
    if (!placed) {
      const allowed = new Set(regions.slice(current).flatMap((slot) => slot.region.allowedBlocks));
      return { ok: false, index, allowed: [...allowed] };
    }
  }
  return { ok: true, regions };
}
