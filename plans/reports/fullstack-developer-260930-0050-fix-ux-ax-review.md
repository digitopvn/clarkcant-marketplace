# Fix UX/AX review findings (2026-09-30)

Source: `plans/reports/code-reviewer-260930-0040-ux-ax-review.md`. All four findings are fixed. Nothing committed.

## 1. Blocking: README heading rewrite (stored HTML injection)

- Removed `apps/web/src/components/package/readme-headings.ts` and its test. Nothing rewrites README HTML as a string now.
- `packages/markdown/src/shift-headings.ts` (new): a rehype pass that runs after `rehype-sanitize` and URL rewriting,
  before stringify. It renames `hN` to `h(min(6, N+offset))`, adds `data-heading-level="<source level>"` (this is
  needed for the visual scale in CSS; the sanitizer runs first, so the schema is unchanged), and can drop a leading h1
  whose text equals a given title.
- `renderMarkdownToSafeHtml` gets two options: `headingOffset` (an integer from 0 to 5, validated; other values throw
  `TypeError`) and `omitLeadingTitle`.
- Indexer `renderReadme` renders with `headingOffset: 2` and `omitLeadingTitle: <version displayName ?? name>`, so the
  stored HTML is already nested.
- `PackageReadme.astro` renders the stored HTML as is. The `title` prop is removed and the CSS keys on `data-heading-level`.
- Legacy rows: READMEs stored before this change render as stored, with unshifted headings, until they are re-indexed.
  Only local dev data is affected. This is the simpler of the two options and adds no render-time parse. It is
  documented in `docs/architecture.md`.
- Tests (`packages/markdown/test/render-markdown.test.ts`):
  - Heading shift and the h6 clamp.
  - No offset leaves headings unchanged.
  - Offset validation.
  - Leading-title rules.
  - A regression case: a link title `"<h1 x><a href=… class=…>"` and an image alt with `<h2 y><img onerror>`. Its tag
    tokenizer shows the same elements and attribute sets with and without the offset. The only difference is the
    renamed heading and its one added attribute.
- Indexer pipeline test: it now expects no h1/h2, the repeated title dropped, and `<h4 data-heading-level="2">`.

## 2. Major: filters navigate on keyboard input

- `PackageFilters.astro`:
  - `change` submits only when the last `pointerdown` was on that select. A `keydown` on the select or a `focusout`
    clears that.
  - Enter on a select submits.
  - The Search button stays.
  - The hint is visible: "Choose filters, then press Enter or Search to apply them. A filter picked with a mouse or
    touch applies at once." The selects reference it with `aria-describedby`.
- `e2e/seo-a11y.spec.ts`:
  - The existing filter test now clicks the select before `selectOption`.
  - A new test focuses Category, presses ArrowDown, and expects no main-frame navigation, the URL still `/packages`,
    focus kept on the select, and the hint visible.

## 3. Minor: single-item BreadcrumbList

- `apps/web/src/server/seo.ts`: `/packages` and `/collections` now start their breadcrumbs with Home (`/`).
- `packages/seo/src/json-ld-validate.ts`: `BreadcrumbList` now needs at least 2 items. Tests cover a valid two-item
  trail, broken positions, and rejection of a single-item trail.

## 4. Minor: docs

- `docs/architecture.md`:
  - Perplexity was already in the prose. The `ShareTarget["id"]` union is now spelled out.
  - The builder-page twin row notes that package lines link `.md` twins, which is also true of `?format=md`.
  - A paragraph describes the README heading offset and legacy rows.
  - The `packages/markdown` row mentions the heading offset.

## Verification

- Focused tests (vitest):
  - markdown: 16/16
  - seo meta-and-json-ld: 13/13
  - marketplace indexing-pipeline: 14/14
- Typecheck:
  - markdown and marketplace: `tsc` clean.
  - web: `astro check` shows 0 errors (1 old hint in `admin/pages/[id].astro`).
- gates.sh: verify 0, bundle step 0, migrations:check 0. Tests: 337 passed, 3 skipped.
- e2e (`-g "filter"`, one `astro dev --port 4327` server, root PID 74196, then stopped with `taskkill /T` and port
  4327 confirmed free): 3 passed, 0 skipped. This covers the new keyboard no-navigation test.

Status: DONE
Summary: README headings are now shifted on the sanitized tree at index time with no string rewriting, filters no
longer navigate on keyboard input, breadcrumbs have at least 2 items, and the docs are updated. Gates are green.
Concerns: pre-change stored READMEs keep h1/h2 until re-indexed (local dev only).
