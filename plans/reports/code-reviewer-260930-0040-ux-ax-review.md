# Code review: commit 9df746f (UX/AX improvements), 2026-09-30

Scope: the files listed in `plans/reports/ui-ux-designer-260930-0010-enhance-ux-ax.md`, read from the working tree.
Limit: the Bash tool returned no output in this session, so `git show 9df746f` could not run. The review reads the
current files and assumes they match the commit. No tests were run; the author's gate claims (335 unit, 24/24 built
e2e) were not re-run.

## Blocking

1. **The README heading rewrite breaks the sanitizer's output: stored HTML injection on package pages.**
   `apps/web/src/components/package/readme-headings.ts:10-14` rewrites sanitized README HTML with a regex. The result
   goes straight to `set:html` (`PackageReadme.astro:12,19`). The regex also matches `<h1 …>` text inside attribute
   values. hast-util-to-html, which rehype-stringify uses, does not escape `<` in double-quoted attribute values; its
   `double` subset is only `"` and `&`, checked against upstream `lib/handle/element.js`. GitHub's sanitize schema
   keeps `title` and `alt`. So an author-controlled README such as
   `[x](https://a "<h1 x><a href=https://evil class='fixed inset-0 z-50'>Install</a>")`
   is stored as `title="<h1 x><a …>"`, which is safe. At render time it becomes `title="<h3 data-readme-level="1" x>…`.
   The inserted `"` closes the attribute, the anchor tag ends there, and the rest of the title is parsed as live
   markup. That gets past the strict schema: arbitrary elements, `class`, and `style` attributes (the CSP allows
   `'unsafe-inline'` for style attributes). The result can be a full-page phishing overlay or off-site links on a
   first-party page. CSP only blocks inline JavaScript and third-party scripts. It affects every stored README at
   once, because the rewrite runs on each request.
   Fix: do not regex-edit HTML. Shift headings on the hast tree, either as a `headingOffset` option or a rehype
   step in `@marketplace/markdown` before `rehypeStringify`, or by parsing, visiting and re-serializing the HTML.
   Add regression tests with `title="<h1 x>"` and image `alt` containing `<h2 y>`, and assert the attribute count
   does not change.

## Major

2. **Filters apply on `change`, which traps keyboard users (WCAG 3.2.2 On Input).**
   `PackageFilters.astro:90-97` calls `requestSubmit()` on every select `change`. On Windows (Chrome and Edge)
   and in Firefox, pressing Arrow Up or Down on a closed, focused `<select>` changes the value and fires `change`
   straight away. A keyboard user cannot step past the first option, because the page navigates and focus is lost.
   The only warning is the sr-only legend (`:61`), so sighted keyboard users get none.
   Fix: submit on `change` only after a pointer interaction, or submit on `blur`/Enter if the value changed. Another
   option is to keep the explicit Search button and show the "applies on change" hint visibly. Add an e2e test
   that presses ArrowDown on a focused filter and expects no navigation.

## Minor

3. `apps/web/src/server/seo.ts:76,91`: `BreadcrumbList` with a single `ListItem`. The JSON is valid, but Google's
   breadcrumb rich result needs at least 2 items, so this node adds nothing. Either prefix a Home crumb (`/`) or
   drop the node.
4. Public-contract drift (additive, not breaking), with no docs update:
   - `ShareTarget["id"]` gains `"perplexity"` (`packages/seo/src/share.ts:17`).
   - Page-engine Markdown now links package lines to `.md` twins instead of the HTML pages
     (`packages/page-engine/src/blocks/shared.ts:88`). This output is also served as
     `/api/v1/pages/{slug}?format=md`.
   - `docs/architecture.md` still lists only ChatGPT, Claude and Gemini (the author's Q6). Update it.

## Verified, no issue found

- **Markdown twins.** `packages.md.ts` and `collections.md.ts` use the same queries as the HTML pages:
  `listCollections` filters `published = true` (`collection-queries.ts:14`), and `listPackages` is the public
  listing. All links go through `canonicalUrl`/`mdLink`, so they are absolute and escaped. Third-party text goes
  through `escapeMarkdown`. The response is `text/markdown; charset=utf-8` with `Link: rel="canonical"`. Filtered
  and paginated `/packages` views stay `noindex`, with no alternate and no share bar (`seo.ts:67-79`).
- **JSON-LD.** `ItemList` reuses the existing `itemListJsonLd` (position, name, absolute url, numberOfItems). The
  output passes through `jsonForScript`, which escapes `<`.
- **Share bar.** The Perplexity URL uses `encodeURIComponent(sharePrompt(...))`, the same as ChatGPT and Claude.
  "View as Markdown" is a plain same-origin link that works without JavaScript. The copy buttons stay `hidden`
  until the script runs.
- **CSP.** No new `is:inline`, `set:html` on untrusted data, or `on*` handlers. The new scripts in
  PackageFilters and ShareBar are Astro-processed, so Astro hashes them. The `BLOCK_STYLES` hash is recomputed in
  `astro.config.ts:25`. `OrbMark` uses SVG presentation attributes only.
- **Client JS.** Only two small bundled scripts were added, and no React on public pages.
- **Filters without JS.** A GET form with a Search button, and the hidden `publisher` is kept.
- **Consent.** Only markup and spacing changed in `ConsentBanner.astro`. The gating logic is unchanged.
- **Header.** The home link's accessible name ("ClarkCant Marketplace") still contains the visible text.

## Unresolved questions

- Could not confirm the working tree equals 9df746f (no git output). Re-run `git diff 9df746f --stat` to make sure.
- Does Chrome honour an injected `<meta http-equiv=refresh>` in `<body>`? If it does, item 1 also becomes an open
  redirect.

Status: DONE_WITH_CONCERNS
Summary: 1 blocking (README heading regex re-opens sanitized HTML to markup injection), 1 major (filters auto-submit
on keyboard arrow input), 2 minor. Twins, JSON-LD, share encoding, CSP, JS budget and consent checked with no issues.
