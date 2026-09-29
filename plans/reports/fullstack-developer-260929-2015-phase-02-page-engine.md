# Phase 02: page engine and admin builder (implementation report)

Pages are now versioned block documents: data, never HTML. One renderer produces the public page, the builder canvas, the signed preview and the Markdown/agent views. Editing goes through pure operations shared by the builder and the API, and every save is an immutable revision guarded by `If-Match`. Publishing requires `pages:publish`, and rollback is recorded in `page_publications` with `action=rollback`. The e2e flow ran green against real auth on port 4322.

## What was built

- **`@marketplace/page-engine`** (pure; client-safe `./operations` entry).
  - `PageDocument` validation: envelope, layout, block type/version, props, child rules, layout regions, 256 KB cap. Errors carry field paths and `blockId`.
  - Unknown props are rejected (`unknown property "x"`), so a typo is never silently dropped.
  - Registry of the 13 required blocks and 6 layouts. Each block ships a props schema, JSON Schema, editor fields, `renderWeb` and `renderMarkdown`, plus optional JSON-LD and data `load`.
  - `renderPage` returns HTML, Markdown, JSON-LD, a summary and diagnostics.
    - Diagnostics (missing media, unknown collection, etc.) show as editor notes in canvas and preview, render nothing publicly, and block publishing.
  - Rich text uses `renderMarkdownToSafeHtml` from `@marketplace/markdown`.
  - Pure `applyPageOperations`: add, update, remove and move blocks, set SEO, set layout; blocks are addressed by id.
- **`packages/marketplace/src/pages`**.
  - Queries: `get_page`, `list_page_revisions`, `getPageRevision`, `listPages`, public `getPublishedPage`.
  - Commands: `create_page`, `create_page_draft` (`savePageDraft`), `add/update/remove/move_block`, `set_page_seo`, `patch_page(ops[])`, `publish_page`, `rollback_page`, `preview_page`.
  - Every command checks its scope, is idempotent (`Idempotency-Key`), writes an audit event in the same D1 batch, and uses optimistic concurrency.
    - Revision numbers are guarded by a unique index.
    - The publish/rollback pointer moves via `INSERT…SELECT` with a precondition, so NOT NULL aborts the batch and the caller gets `conflict`.
  - The page data port reads live packages, collections, publishers, media and stats through existing services.
  - Preview tokens are stateless HMAC-SHA256 over `{pageId, revisionId, exp}`, keyed by `BETTER_AUTH_SECRET`. Default 30 min, max 24 h.
  - `ensureDefaultPages` creates and publishes the landing (`home`) and `about` pages through the commands. It is idempotent and never overwrites.
- **API**.
  - `GET /api/v1/pages/{slug}` returns JSON, or Markdown with `?format=md`. Published only; ETag set.
  - `/api/v1/admin/pages/*`:
    - page list, create, get (ETag = draft revision);
    - `PUT …/draft`, `PATCH` (ops);
    - `…/blocks` (POST), `…/blocks/{id}` (PATCH/DELETE), `…/blocks/{id}/move`;
    - `…/seo`, `…/preview` (signed URL), `…/publish`, `…/rollback`;
    - `…/revisions`, `…/revisions/{id}`, `render`, `defaults`;
    - `GET /admin/blocks` (registry and layouts).
  - The expected revision comes from `If-Match` or the body field; if both are sent and differ, the request gets a 400.
- **Web**.
  - `/[...slug]` serves published pages. It sets `Link` canonical and the Markdown alternate, adds JSON-LD, sends `X-Robots-Tag` when the page is noindex, and redirects `/home` to `/` with a 301.
  - `/preview/<token>` renders the revision with diagnostics visible. It sends noindex/nofollow, `no-store` and `no-referrer`.
  - `/` renders the published `home` page when present (search form kept on top); otherwise it falls back to the existing landing.
  - `/admin/pages` lists pages, creates them, and offers "Create and publish default pages" while any default page is missing.
  - `/admin/pages/:id` is the builder, in three panes:
    - Palette and outline: keyboard buttons plus Alt+Up/Down to move blocks.
    - Canvas: a sandboxed iframe (`allow-scripts` only) fed by the server `render` route, which uses the same `renderPage`. Clicking a block in the canvas selects it via postMessage.
    - Inspector: generated from `editor.fields`, with Page & SEO and Revisions tabs. Revisions support "Load into editor" and "Roll back to this".
  - Preview modes: Desktop, Tablet, Mobile, Markdown, Agent view, SEO, Social.
  - At 375px the panes collapse into tabs. Leaving with unsaved changes triggers a warning.

## File map

- `packages/page-engine/src/`:
  - `types.ts`, `define-block.ts`, `registry.ts`, `layouts.ts`, `validate-document.ts`, `render-page.ts`
  - `operations.ts`, `html.ts`, `markdown-text.ts`, `block-styles.ts`, `index.ts`
  - `blocks/{hero,rich-text,media,package-blocks,content-blocks,brand-blocks,shared}.ts`
  - tests in `test/{blocks,document}.test.ts`
- `packages/marketplace/src/pages/{page-schemas,page-service,page-data-port,preview-token,default-pages,index}.ts`, with tests in `test/pages/{page-service,default-pages}.test.ts`
- `packages/api/src/routes/{pages,admin}.ts`, with tests in `packages/api/test/pages.test.ts`
- `apps/web/src/pages/[...slug].astro`, `pages/preview/[token].astro`, `pages/admin/pages/{index,[id]}.astro`
- `apps/web/src/components/admin/`:
  - `PageBuilder.tsx`, `BlockInspector.tsx`, `PreviewPane.tsx`, `CreatePageForm.tsx`, `DefaultPagesButton.tsx`
  - `admin-api.ts`, `builder-types.ts`
- `e2e/page-builder.spec.ts`

**Shared or non-owned edits** (all additive):
- `packages/marketplace/src/index.ts`: appended `export * from "./pages"`.
- `package.json` workspace dependency on `@marketplace/page-engine` in `packages/marketplace` and `apps/web`, plus `pnpm-lock.yaml`.
- New directory `apps/web/src/components/page-engine/RenderedPage.astro`: the shared shell for the public page, the preview and `/`.
- `apps/web/src/pages/index.astro`: the landing hook (approved by the controller).
- New e2e spec file.

## How to add a block

1. Create `packages/page-engine/src/blocks/<name>.ts` with `defineBlock({...})`. It needs:
   - `type`, `version`, `propsSchema` (zod) and `defaultProps`;
   - optional `allowedChildren` / `maxChildren`;
   - `editor: { label, description, fields }`: the inspector is generated from `fields`;
   - `renderWeb` (escape all text with `escapeHtml`, links with `safeHref`/`link`) and `renderMarkdown`;
   - optional `load(props, port)` for live data and `structuredData`.

   Call `ctx.diagnose("…")` for unresolved references; that blocks publishing.
2. Add it to `BLOCKS` in `registry.ts` and to the relevant regions in `layouts.ts`.
3. Add a sample to `SAMPLES` in `test/blocks.test.ts`: valid and invalid props, plus expected HTML and Markdown.
4. Breaking prop changes need a new `version`. Stored documents keep the old one, so keep the old definition registered.

## Test evidence

- `pnpm verify`: exit 0. Lint clean; typecheck clean, including `astro check` (56 files, 0 errors); vitest 25 files passed and 1 skipped (not mine), 196 tests passed.
- Phase 02 suites: 47 tests passed.
  - page-engine: 28 tests covering every block's HTML and Markdown, safety, JSON-LD, diagnostics, validation paths, operations, escaping and unknown props.
  - marketplace pages: 12 tests. They cover:
    - scopes, the full lifecycle, conflict details;
    - one-winner concurrent edits and publishes;
    - idempotent replay and key reuse;
    - preview tamper, rotation and expiry;
    - the landing rendered with live data;
    - default pages.
  - API: 7 tests over real auth (cookie admin plus editor bearer token). They cover:
    - 401, 403 and CSRF 403;
    - If-Match 400/409;
    - a misspelt prop giving 400;
    - publish 403 for editors;
    - JSON and Markdown public reads;
    - rollback, move, remove and defaults;
    - the preview URL resolving and failing with a rotated secret;
    - preview without a secret failing as `configuration_error`.
- `pnpm build` (via the scratchpad wrapper): exit 0.
- Playwright on `astro dev --port 4322` (`BASE_URL=http://localhost:4322`, with `E2E_ADMIN_EMAIL`/`E2E_ADMIN_PASSWORD` from the process env): 6/6 passed, including smoke. The builder flow covered:
  - create;
  - add rich text and see it in the canvas iframe;
  - save revision 2;
  - signed preview with noindex;
  - publish, public page and `?format=md`;
  - revision 3 published;
  - roll back to 2 and see the public page revert;
  - the 375px tabs test.
- Local D1: default `home` and `about` were published through `POST /api/v1/admin/pages/defaults`.
- The dev server was stopped afterwards and port 4322 is free.

## Deviations

- **SEO field name.** The spec's `seo: PageSeo` is the contract's `meta {title, description, locale, noindex}`.
  - The canonical URL is derived from the slug. No OG image is stored, so the Social mode says platforms show a text-only card.
  - Contracts are phase 01's, so I did not rename anything.
- **Layouts table unused.** Layouts are code-defined (id plus version, like blocks); the DB `layouts` table is unused.
- **Stateless preview tokens.** They cannot be revoked individually before expiry; rotating `BETTER_AUTH_SECRET` revokes all of them. They reuse `BETTER_AUTH_SECRET` under a domain-separated HMAC prefix.
  - The admin router reads the secret from the Worker env and takes a `previewSecret` provider for hosts and tests.
  - In development the preview URL uses the request origin, as auth does, because `PUBLIC_SITE_URL` and the dev port can differ.
- **OpenAPI stand-in schemas.** OpenAPI generation cannot follow the recursive block schema, so routes document and pre-validate documents and operations with the one-level `pageApiSchemas`. The services still validate strictly.
- **Seeding.** It is a service command (`ensureDefaultPages`) exposed as an admin API route and button, not a SQL seed. No schema or migration changes were made.
- **Builder saves.** "Save draft" stores the whole document (`PUT …/draft`), after the builder has applied the same pure operations locally. Agents use `PATCH` with ops.
- **Blocks shared helper.** `plainText` now checks control characters with a function instead of a control-char regex, which lint rejected.
- **Markdown escaping.** It now leaves ordinary punctuation alone; line-start syntax and inline markers are still escaped.

## Gaps and follow-ups

- `apps/web/src/components/SiteHeader.astro` (not mine) overflows by about 42px at 375px when signed in, because of the nav buttons. This affects every page.
- The Social preview is a text card only; there is no share-image field yet.
- Reference fields (media, package, collection, publisher) are text inputs with hints; there are no pickers yet.
- A canvas selection and publish runs in the builder need the render route. If the API is down, the canvas shows "Preview unavailable" and publish stays disabled.
- The phase file status line still reads `pending`. It has no checkboxes for `ak plan check`, so the controller should set the status.

Status: DONE_WITH_CONCERNS
Summary: The page engine (13 blocks, 6 layouts, one renderer), versioned page commands, the public and admin API, the signed preview, the three-pane builder and the default landing/about pages are built; `pnpm verify`, `pnpm build` and Playwright (6/6 on port 4322) are green.
Concerns: The site header overflows at 375px (not my file). Preview tokens are revocable only by rotating the secret. The contract uses `meta` rather than the spec's `seo`, and there is no OG image field.
