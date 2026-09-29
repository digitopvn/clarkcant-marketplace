import type { BlockNode } from "@marketplace/contracts";
import { z } from "zod";

import { escapeHtml } from "./html";
import type { BlockDefinition, BlockRenderContext, RegisteredBlock, RenderOptions, RenderedChildren } from "./types";

/**
 * Wraps a typed block definition into the erased shape the registry stores. Props are parsed by the block's own
 * schema on every render, so a renderer only ever sees values its schema accepted.
 */
export function defineBlock<P extends Record<string, unknown>, D = undefined>(
  definition: BlockDefinition<P, D>,
): RegisteredBlock {
  const checked = definition.propsSchema.safeParse(definition.defaultProps);
  if (!checked.success) {
    throw new Error(`block ${definition.type}@${definition.version}: defaultProps do not satisfy propsSchema`);
  }
  return {
    type: definition.type,
    version: definition.version,
    propsSchema: definition.propsSchema,
    defaultProps: definition.defaultProps,
    allowedChildren: definition.allowedChildren ?? [],
    maxChildren: definition.maxChildren ?? (definition.allowedChildren?.length ? 12 : 0),
    editor: definition.editor,
    parseProps(props) {
      // Object schemas strip unknown keys; for stored documents a misspelt prop would then vanish silently, so
      // unknown top-level props are reported instead.
      const schema = definition.propsSchema;
      const unknownKeys =
        schema instanceof z.ZodObject && props !== null && typeof props === "object" && !Array.isArray(props)
          ? Object.keys(props).filter((key) => !Object.hasOwn(schema.shape, key))
          : [];
      if (unknownKeys.length > 0) {
        return {
          success: false,
          issues: unknownKeys.map((key) => ({ code: "custom" as const, path: [key], message: `unknown property "${key}"`, input: props })),
        };
      }
      const result = definition.propsSchema.safeParse(props);
      return result.success ? { success: true, props: result.data } : { success: false, issues: result.error.issues };
    },
    async render(node: BlockNode, rawProps, options: RenderOptions, children: RenderedChildren) {
      const props = definition.propsSchema.parse(rawProps);
      // `load` is optional; a block without one declares `D = undefined`, so the cast only fills that case.
      const data = (definition.load ? await definition.load(props, options.port) : undefined) as D;
      const diagnostics: string[] = [];
      const ctx: BlockRenderContext<P, D> = {
        node,
        props,
        data,
        mode: options.mode,
        siteUrl: options.siteUrl,
        path: options.path,
        children: { html: children.html, markdown: children.markdown, summaries: children.summaries },
        diagnose(message) {
          diagnostics.push(`${node.type} "${node.id}": ${message}`);
          return options.mode === "public" ? "" : `<p class="pe-diagnostic" role="note">${escapeHtml(message)}</p>`;
        },
      };
      const html = definition.renderWeb(ctx);
      return {
        html,
        markdown: definition.renderMarkdown(ctx),
        summary: definition.getSemanticSummary(ctx),
        structuredData: [...(definition.getStructuredData?.(ctx) ?? []), ...children.structuredData],
        diagnostics: [...diagnostics, ...children.diagnostics],
      };
    },
  };
}
