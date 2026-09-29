# Adding a page block

Editorial pages are JSON documents of typed blocks (`packages/contracts` page schemas) rendered by
`packages/page-engine`. One definition drives the public HTML, the Markdown twin, JSON-LD, the builder palette and
form, and the agent descriptions returned by `describeBlocks()` (API and MCP).

## Steps

1. **Write the definition** in `packages/page-engine/src/blocks/<group>.ts` with `defineBlock`
   (types in `src/types.ts`; `src/blocks/rich-text.ts` is a compact example):

   | Field | Purpose |
   | --- | --- |
   | `type`, `version` | Registry key `type@version`. Stored documents name both. |
   | `propsSchema`, `defaultProps` | Zod schema parsed on every render; defaults must pass it (checked at startup). Unknown props are rejected, not stripped. |
   | `allowedChildren`, `maxChildren` | Nesting rules, if the block contains other blocks. |
   | `load(props, port)` | Optional data binding through `PageDataPort` (packages, collections, media, sanitized Markdown). Must not throw for missing data. |
   | `renderWeb(ctx)` | HTML string. Escape every value (`escapeHtml`, `safeHref` in `src/html.ts`); Markdown goes through `@marketplace/markdown`. |
   | `renderMarkdown(ctx)` | The block's part of the Markdown twin. |
   | `getStructuredData(ctx)` | Optional JSON-LD objects (validated by `packages/seo` in tests). |
   | `getSemanticSummary(ctx)` | One line for agents and page summaries. |
   | `editor` | Label, description and fields (`text`, `markdown`, `number`, `select`, `reference`, `group`, `list`, …) for the builder form. |

   Report missing data with `ctx.diagnose(message)`: editors see the note in the builder and preview, public pages
   render nothing, and publishing is blocked while any diagnostic exists.

2. **Register it** in `packages/page-engine/src/registry.ts` (`BLOCKS`).
3. **Allow it in layouts**: add the type to the `allowedBlocks` of the regions that may hold it in
   `src/layouts.ts`.
4. **Style it** in `src/block-styles.ts` using only token variables (`--text`, `--line`, `--space-*`, …) so light and
   dark themes work in the public page, preview and builder canvas alike. The string's CSP hash is computed at build
   time in `apps/web/astro.config.ts`; nothing else to update.
5. **Test it** in `packages/page-engine/test/blocks.test.ts`: default props render, HTML is escaped, Markdown output,
   structured data validity, and diagnostics for missing data.

## Changing a block

Stored pages keep their `type@version`. A breaking prop change ships as a **new version** registered next to the old
one; the builder inserts the latest version, and old documents keep rendering. Additive optional props with defaults
can stay on the same version.

## What a block must never do

- Emit unescaped user content or raw HTML from Markdown (the sanitizer is the only path).
- Add inline `<script>`, event-handler attributes or external resources: the CSP blocks them, and page content is
  written by editors, not trusted code.
- Read globals or the database directly; use `load` and the `PageDataPort`.
