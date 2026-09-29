import type { BlockNode, CollectionDetail, PackageSummary, PageDocument } from "@marketplace/contracts";
import type { z } from "zod";

/**
 * Read-only data the render pipeline may ask for. The host (packages/marketplace) implements it over the same
 * application queries the public API uses, so a block never reaches the database or the network on its own and only
 * ever sees publicly visible data. Every method returns `null`/empty for missing data instead of throwing.
 */
export interface PageDataPort {
  listPackages(query: { category?: string | undefined; sort: "latest" | "name"; limit: number }): Promise<PackageSummary[]>;
  listFeaturedPackages(limit: number): Promise<PackageSummary[]>;
  getPackage(name: string): Promise<PackageSummary | null>;
  getCollection(slug: string): Promise<CollectionDetail | null>;
  getPublisher(slug: string, packageLimit: number): Promise<PublisherProfile | null>;
  getMedia(id: string): Promise<MediaAsset | null>;
  getMarketplaceStats(): Promise<MarketplaceStats>;
}

export interface PublisherProfile {
  slug: string;
  name: string;
  kind: "org" | "person";
  verified: boolean;
  packages: PackageSummary[];
}

export interface MediaAsset {
  id: string;
  /** Site-relative or absolute URL the browser can load. */
  url: string;
  contentType: string;
  width: number | null;
  height: number | null;
}

export interface MarketplaceStats {
  packages: number;
  publishers: number;
  categories: number;
}

/**
 * `public` is the live site, `preview` a signed draft preview, `canvas` the builder iframe. Only `preview`/`canvas`
 * show diagnostics (e.g. a missing media id); the public page never renders editor notes.
 */
export type RenderMode = "public" | "preview" | "canvas";

export interface RenderOptions {
  mode: RenderMode;
  port: PageDataPort;
  /** Absolute site origin without a trailing slash, used for canonical/JSON-LD URLs. */
  siteUrl: string;
  /** Site-relative path of the page, e.g. `/about` or `/`. */
  path: string;
}

export interface BlockRenderContext<P, D> {
  node: BlockNode;
  props: P;
  /** Whatever the block's `load` returned (undefined when it has none). */
  data: D;
  mode: RenderMode;
  siteUrl: string;
  path: string;
  /** Children already rendered, in order. Blocks without `allowedChildren` always get empty values. */
  children: { html: string; markdown: string; summaries: string[] };
  /**
   * Records an editor-facing problem (missing media, unknown collection…) and returns the note's HTML for preview
   * and canvas modes, or `""` on the public page. Any diagnostic blocks publishing.
   */
  diagnose(message: string): string;
}

export type EditorField =
  | { kind: "text" | "textarea" | "url"; name: string; label: string; help?: string; required?: boolean; maxLength?: number }
  | { kind: "markdown"; name: string; label: string; help?: string; required?: boolean; maxLength?: number }
  | { kind: "number"; name: string; label: string; help?: string; required?: boolean; min?: number; max?: number }
  | { kind: "boolean"; name: string; label: string; help?: string }
  | { kind: "select"; name: string; label: string; help?: string; required?: boolean; options: { value: string; label: string }[] }
  | {
      kind: "reference";
      name: string;
      label: string;
      help?: string;
      required?: boolean;
      /** What the id refers to, so editors can offer a picker and agents know which lookup to use. */
      target: "media" | "package" | "collection" | "publisher" | "category";
    }
  | { kind: "group"; name: string; label: string; help?: string; optional?: boolean; fields: EditorField[] }
  | {
      kind: "list";
      name: string;
      label: string;
      help?: string;
      itemLabel: string;
      minItems?: number;
      maxItems?: number;
      /** Fields of one item. A single field named `""` means the list holds plain values rather than objects. */
      fields: EditorField[];
    };

export interface BlockEditorSpec {
  label: string;
  /** Short hint shown in the palette; a single emoji-free glyph or icon name. */
  icon?: string;
  description: string;
  fields: EditorField[];
}

/**
 * The typed contract a block author writes. `defineBlock` erases the generics so the registry can hold any block
 * while each block keeps full typing inside its own file.
 */
export interface BlockDefinition<P, D = undefined> {
  type: string;
  version: number;
  propsSchema: z.ZodType<P>;
  /** Props for a freshly inserted block; must pass `propsSchema`. */
  defaultProps: P;
  allowedChildren?: readonly string[];
  maxChildren?: number;
  /** Resolves bound data (packages, media, sanitized Markdown) before rendering. Must not throw for missing data. */
  load?: (props: P, port: PageDataPort) => Promise<D> | D;
  renderWeb(ctx: BlockRenderContext<P, D>): string;
  renderMarkdown(ctx: BlockRenderContext<P, D>): string;
  getStructuredData?(ctx: BlockRenderContext<P, D>): Record<string, unknown>[];
  getSemanticSummary(ctx: BlockRenderContext<P, D>): string;
  editor: BlockEditorSpec;
}

/** A registered block with its generics erased; props are re-validated at every entry point. */
export interface RegisteredBlock {
  type: string;
  version: number;
  propsSchema: z.ZodType;
  defaultProps: Record<string, unknown>;
  allowedChildren: readonly string[];
  maxChildren: number;
  editor: BlockEditorSpec;
  parseProps(props: unknown): { success: true; props: Record<string, unknown> } | { success: false; issues: z.core.$ZodIssue[] };
  render(node: BlockNode, props: Record<string, unknown>, options: RenderOptions, children: RenderedChildren): Promise<RenderedBlock>;
}

export interface RenderedChildren {
  html: string;
  markdown: string;
  summaries: string[];
  structuredData: Record<string, unknown>[];
  diagnostics: string[];
}

export interface RenderedBlock {
  html: string;
  markdown: string;
  summary: string;
  structuredData: Record<string, unknown>[];
  diagnostics: string[];
}

export interface LayoutRegion {
  id: string;
  label: string;
  /** Block types allowed at the top level of this region. */
  allowedBlocks: readonly string[];
  maxBlocks?: number;
}

export interface LayoutDefinition {
  id: string;
  version: number;
  label: string;
  description: string;
  /** Ordered regions; top-level blocks fill them in order (see `assignRegions`). */
  regions: readonly LayoutRegion[];
}

export interface RenderedPage {
  /** Inner HTML (regions + blocks), escaped, with no document shell. */
  html: string;
  markdown: string;
  structuredData: Record<string, unknown>[];
  summary: string;
  /** Problems found while rendering (e.g. missing media). Never shown on public pages. */
  diagnostics: string[];
  /** The page's own share image (`meta.image`) when it resolves to a raster media object; null otherwise. */
  socialImage: MediaAsset | null;
}

export type { PageDocument };
