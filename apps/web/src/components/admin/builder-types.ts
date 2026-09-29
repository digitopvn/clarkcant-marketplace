import type { BlockNode, PageDocument } from "@marketplace/contracts";
import type { PageRevisionSummary, PageState, RenderedDocument } from "@marketplace/marketplace";
import type { BlockDescription, EditorField, LayoutDefinition } from "@marketplace/page-engine";

// Type-only imports: the builder bundle carries the pure operations module and nothing server-side.
export type { BlockDescription, BlockNode, EditorField, LayoutDefinition, PageDocument, PageRevisionSummary, PageState, RenderedDocument };

export type PreviewMode = "desktop" | "tablet" | "mobile" | "markdown" | "agent" | "seo" | "social";

export const PREVIEW_MODES: { id: PreviewMode; label: string }[] = [
  { id: "desktop", label: "Desktop" },
  { id: "tablet", label: "Tablet" },
  { id: "mobile", label: "Mobile" },
  { id: "markdown", label: "Markdown" },
  { id: "agent", label: "Agent view" },
  { id: "seo", label: "SEO" },
  { id: "social", label: "Social" },
];

export interface PageBuilderProps {
  initialState: PageState;
  initialRevisions: PageRevisionSummary[];
  blocks: BlockDescription[];
  layouts: LayoutDefinition[];
  siteUrl: string;
  /** Brand tokens + block styles, inlined into the canvas iframe so it renders exactly like the public page. */
  canvasCss: string;
}

/** Messages exchanged with the sandboxed canvas iframe. */
export type CanvasMessage = { source: "pe-canvas"; type: "ready" } | { source: "pe-canvas"; type: "select"; id: string };

export function isCanvasMessage(value: unknown): value is CanvasMessage {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.source !== "pe-canvas") return false;
  return record.type === "ready" || (record.type === "select" && typeof record.id === "string");
}
