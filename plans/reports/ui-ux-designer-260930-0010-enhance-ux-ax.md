# UX/AX review: ClarkCant Marketplace — 2026-09-30

## Verdict

**DONE.** All 16 proposals are implemented, and the DONE contract is met.
- `/packages` fits a 320 px screen.
- Every target is at least 24 px, and the package page has one `h1`.
- `/packages` and `/collections` have Markdown twins and JSON-LD.
- The Orb mark is in the header and footer, and the layout shares one column.
- Filters apply as soon as they change, and the share bar leads with Markdown.
- All gates are green: verify with 335 tests, build, and migrations:check. Playwright passes on the dev server (26 passed, 4 skipped) and on a production preview (24 of 24, including the CSP and JavaScript-budget tests).

The only scan findings left are the robots errors, which are by design on non-production hosts, and the accepted twin-noindex warnings. The rubric rises in five areas, and Storytelling stays at 1, pending content (see the questions).

## Scope and environment

- **Mode:** `ak:enhance-ux-ax --auto` (one round that must reach the project DONE contract). No focus argument, so every public route was reviewed.
- **Repository:** `D:/www/digitop/clarkcant-marketplace`, branch `dev`, HEAD `a9eadcf`. Timezone Asia/Saigon.
- **Stack:** Astro 7 SSR on Cloudflare Workers (`apps/web`), Tailwind 4, brand tokens in `apps/web/src/styles/tokens.css`, page engine blocks in `packages/page-engine`, discovery surfaces in `packages/seo`.
- **Baseline environments:**
  - Staging (production build): `https://clarkcant-marketplace-web-staging.digitop-vn.workers.dev`. It has default pages (home, about, legal) but no indexed packages.
  - Local dev server on port 4327 (`astro dev --port 4327`) with seeded pages and one indexed fixture package, used for the package detail page and for verification.
- **Pages reviewed:** `/`, `/packages`, `/collections`, `/about`, `/docs/api`, `/login` (utility page), `/terms` and a package detail page (local).
- **Standards applied:** the skill's UX rubric, SEO/GEO/AX checklist and best-practice list, plus `ak:frontend-design` UX polish standards ("don't make me think").
- **Tools:** Playwright (repo copy, Chromium) through `scratchpad/uxax/shoot.mjs`, which saves fold and full-page screenshots at 1440×900, 768×1024 and 375×812, runs a 320 px reflow check, and records overflow, sub-24 px targets, console errors and script bytes. The discovery scan is the skill's `check-discovery-surfaces.mjs`.
- **Could not run:** field Core Web Vitals (no RUM data); Safari clipboard behaviour (no WebKit run); a third-party structured-data validator (offline). These are not reported as passes.
- **Evidence folder:** `C:/Users/admin/AppData/Local/Temp/claude/D--www-digitop-clarkcant-marketplace/a1c7bb41-ee8a-4df4-81cd-3ca8fabc1ba6/scratchpad/uxax/` (`baseline-staging/`, `baseline-local/`, `after-local/`, scan outputs). Paths below are relative to it.

## Baseline evidence

### Screenshots (staging)

| Page | Desktop 1440×900 | Tablet 768×1024 | Mobile 375×812 | 320 px reflow |
|---|---|---|---|---|
| Home `/` | `baseline-staging/desktop-home-{fold,full}.png` | `baseline-staging/tablet-home-*.png` | `baseline-staging/mobile-home-*.png` | no overflow |
| Packages `/packages` | `baseline-staging/desktop-packages-*.png` | `baseline-staging/tablet-packages-*.png` | `baseline-staging/mobile-packages-*.png` | **overflow: 363 px wide** (filter fieldset) |
| Collections | `baseline-staging/desktop-collections-*.png` | `…/tablet-collections-*.png` | `…/mobile-collections-*.png` | no overflow |
| About | `baseline-staging/desktop-about-*.png` | `…/tablet-about-*.png` | `…/mobile-about-*.png` | no overflow |
| API reference | `baseline-staging/desktop-docs-api-*.png` | `…/tablet-docs-api-*.png` | `…/mobile-docs-api-*.png` | no overflow (tables scroll inside their wrapper) |
| Sign in | `baseline-staging/desktop-login-*.png` | `…/tablet-login-*.png` | `…/mobile-login-*.png` | no overflow |

Measured on every page and viewport (`baseline-staging/metrics.json`): HTTP 200, no console errors, script bytes 0.6–2.4 KB on public pages (the sign-in page loads 278 KB, a React island on a utility page outside the 120 KB public budget), and **13 interactive targets under 24 px on every page** (all footer links at 18 px tall and the "Cookie settings" button at 20 px).

Vision review of the baseline captures:

- **Home, all viewports:** the search form sits above the H1, centred in a narrow column, while the hero starts 40 px further in than the header wordmark (`desktop-home-fold.png`: header text at x=152, hero at x=192). The builder page is wrapped twice in the page gutter (`RenderedPage.astro` adds `container-page py-10` around `.pe-page`, which has its own max width, gutter and padding), which also leaves about 120 px of empty space between the search and the eyebrow. The headline breaks as "…curated from / npm." with a one-word last line.
- **Cookie banner:** the copy reads "advertising tracking.Cookie policy" with no space (all viewports). On mobile the banner is 184 px tall (23% of the screen) and covers the hero's primary button (`mobile-home-fold.png`).
- **API reference:** "The machine-readable document is/openapi.json" (missing space, `desktop-docs-api-fold.png`).
- **Packages:** five native selects need an extra press of "Search" to apply; at 320 px the filter grid is wider than the screen.
- **Brand:** the header shows the serif word "ClarkCant" and the spectrum rule, but not the Orb mark that clarkcant.cc, the favicon and the social card (`apps/web/public/og-default.png`) all use.
- **Navigation:** "API" in the header and footer opens raw JSON (`/openapi.json`) although a human reference page exists at `/docs/api`.

### Screenshots (local, seeded)

Captured before any change (`baseline-local/`, `baseline-local/metrics.json`) on the same three viewports plus the 320 px pass, for home, packages, collections, about, terms and the fixture package page `/packages/@clarkcant/example-frame-widget`.

- Every page answered 200 with no console errors and no overflow at 1440, 768 or 375 px. The local `/packages` has no seeded categories, so the filter grid did not overflow at 320 px as it does on staging; the cause (fieldset `min-inline-size`) is the same code.
- 13 targets under 24 px on every page; 18 on the package page (breadcrumb, npm and Source links, the share-card link).
- The package page had **two `h1` elements**: the page title and the README's own `# Title`, which repeats the package name directly under it.
- The local scan (`scan-local-baseline.txt`) matched staging (2 errors, 12 warnings) and also listed three leftover e2e pages (`/e2e-mumqu590`, `/e2e-mumquygm`, `/e2e-mumqzvgj`) from earlier Playwright runs in the local database.

### Discovery scan (staging)

`node check-discovery-surfaces.mjs <staging>`: 11 sitemap URLs, 10 pages checked, **exit 1: 2 errors, 12 warnings, 14 info** (`scan-staging.txt`, `scan-staging.json`).

- Errors (both expected for a non-production host): robots.txt disallows the whole site, which also blocks the AI search crawlers. `packages/seo/src/robots.ts` only allows indexing when `ENVIRONMENT=production`, and `e2e/seo-a11y.spec.ts` asserts both variants.
- Warnings: `/packages` and `/collections` have **no Markdown twin (404)** and **no JSON-LD**; nine twins (`/index.md`, `/about.md`, legal pages) do not send `X-Robots-Tag: noindex`.
- Info: `/llms.txt` has no `X-Robots-Tag: noindex`; `Accept: text/markdown` negotiation is not offered (optional); `/packages` and `/collections` have no `rel="alternate"` Markdown link.
- Source check: `llms.txt` says "Every public HTML page has a Markdown twin at the same path plus `.md`" (`apps/web/src/server/site-index.ts:51`), which the two missing twins make false. The home twin links its calls to action and package cards with relative URLs (`[Browse packages](/packages)` in `/index.md`), which an assistant reading the file on its own cannot resolve.

## Scores (baseline)

| Area | Score 0–3 | Evidence |
|---|---|---|
| First impression | 2 | Headline says what and for whom within five seconds (`desktop-home-fold.png`), but search precedes the H1 and 120 px of dead space plus the gutter misalignment weaken the fold. |
| Brand recall | 1 | Serif wordmark and spectrum rule only; the Orb mark used on clarkcant.cc, the favicon and `og-default.png` is missing from the UI, so a cropped screenshot does not read as ClarkCant. |
| Content punch | 2 | Plain, honest copy ("Widgets, tools, and themes for ClarkCant, curated from npm."); CTAs are verb + object. |
| Clarity and hierarchy | 2 | One primary action per view; search above H1 on home; filters apply only after an extra "Search" press. |
| Storytelling | 1 | Home reads hero → two empty lists → FAQ; no "how it works" chapter or proof beyond the FAQ. Published page content is editorial data. |
| Knowledge and trust | 2 | Trust wording is precise (listed/featured/verified), boundary statement in the footer, policies exist (drafts). |
| Motion | 1 | Almost no motion; chrome buttons, nav links and filters change colour instantly; reduced-motion tokens exist (`tokens.css:132`) but are barely used. |
| Responsive | 1 | `/packages` overflows at 320 px; footer targets 18 px; cookie banner covers 23% of a phone screen. |
| Accessibility | 1 | Skip link, landmarks, focus ring and labels are good, but WCAG 2.2 AA fails on 2.5.8 target size (13 targets per page) and 1.4.10 reflow (`/packages` at 320 px). |
| Performance feel | 2 | Server-rendered, 0.6–2.4 KB of script on public pages, no hero image; Google Fonts CSS is a cross-origin render-blocking request. No field data. |

## Proposals

Ranked Must → Should → Could. IDs stay stable.

### P1 — Reflow: `/packages` filters fit a 320 px screen (Must)
- Evidence: `baseline-staging/metrics.json` reflow320 `/packages`: scrollWidth 363 > 320; overflowing `fieldset.grid`, `select`, search button. A `<fieldset>` defaults to `min-inline-size: min-content`.
- Change: let the fieldset shrink (`min-w-0`) and let the search row wrap its button under the input at the smallest widths.
- Files: `apps/web/src/components/package/PackageFilters.astro`, `apps/web/src/components/PackageSearchForm.astro`, `e2e/seo-a11y.spec.ts`.
- Acceptance: `shoot.mjs` reports `overflow=false` for `/packages` at 320 px; a new e2e test checks `/packages` has no horizontal overflow at 320 px.

### P2 — Every interactive target is at least 24×24 px (Must)
- Evidence: 13 targets under 24 px on every page (`metrics.json`): footer links 18 px tall, "Cookie settings" 20 px.
- Change: give footer links and the cookie-settings button a 24 px minimum hit area (inline-flex, `min-h-6`, padding) with spacing that keeps rows apart.
- Files: `apps/web/src/components/SiteFooter.astro`, `e2e/seo-a11y.spec.ts`.
- Acceptance: `shoot.mjs` reports `small=0` on every public page at every viewport; an e2e test asserts no visible footer link or button is under 24 px.

### P3 — No missing spaces before inline links (Must)
- Evidence: "tracking.Cookie policy" (`desktop-home-fold.png`), "document is/openapi.json" (`desktop-docs-api-fold.png`). Astro's HTML compression drops the line-break whitespace between text and an element on the next line (`ConsentBanner.astro:21-22`, `docs/api.astro:72-73`).
- Change: explicit `{" "}` before those links (and the 404 page's link that starts a line after a link).
- Files: `apps/web/src/components/consent/ConsentBanner.astro`, `apps/web/src/pages/docs/api.astro`, `apps/web/src/pages/[...slug].astro`.
- Acceptance: rendered text contains "tracking. Cookie policy" and "document is /openapi.json"; covered by an e2e assertion on the banner text.

### P4 — Markdown twins for `/packages` and `/collections` (Must)
- Evidence: scan warnings `markdown-variant … /packages.md 404`, `/collections.md 404`; `llms.txt` claims every public page has a twin (`site-index.ts:51`).
- Change: add `/packages.md` (first page of listed packages plus categories, from `listPackages`/`listCategories`) and `/collections.md` (published collections) rendered by new builders in `packages/seo/src/markdown-twins.ts`; advertise them with `rel="alternate"` (drop `markdown: false` on the unfiltered listing) and list both under "Start here" in `llms.txt`.
- Files: `packages/seo/src/markdown-twins.ts`, `apps/web/src/pages/packages.md.ts` (new), `apps/web/src/pages/collections.md.ts` (new), `apps/web/src/pages/packages/index.astro`, `apps/web/src/pages/collections/index.astro`, `apps/web/src/server/site-index.ts`, `packages/seo` tests, `e2e/seo-a11y.spec.ts`.
- Acceptance: both URLs answer 200 `text/markdown` with a `Link: rel="canonical"` to the HTML page and a `# ` heading; the HTML pages carry `<link rel="alternate" type="text/markdown">`; the scan reports no `markdown-variant … missing` or `markdown-alternate` finding for them; filtered or paginated `/packages` views stay `noindex` without an alternate.

### P5 — Structured data for `/packages` and `/collections` (Must)
- Evidence: scan warnings `json-ld … /packages: no JSON-LD`, `/collections: no JSON-LD`.
- Change: `CollectionPage` with an `ItemList` of the visible packages or collections, plus `BreadcrumbList`, from the same records the page renders (values match visible content).
- Files: `packages/seo/src/json-ld.ts`, `apps/web/src/server/seo.ts`, both index pages, tests.
- Acceptance: the scan reports no `json-ld` warning; `validateJsonLd` accepts the nodes in a unit test.

### P6 — One content column on builder pages; search aligned with it (Should)
- Evidence: `desktop-home-fold.png` (header text x=152, hero x=192; ~120 px empty band), `mobile-home-fold.png` (content inset 34 px instead of 17 px).
- Change: `RenderedPage.astro` no longer wraps `.pe-page` in a second `container-page py-10`; the home search sits in the same column as the hero (left-aligned, compact top spacing) so the header, search and hero share one edge.
- Files: `apps/web/src/components/page-engine/RenderedPage.astro`, `apps/web/src/pages/index.astro`.
- Acceptance: at 1440, 768 and 375 px the H1's left edge equals the header wordmark's left edge (±1 px, measured in the browser); the gap between the search and the eyebrow is under 64 px on desktop.

### P7 — The Orb mark in the header and footer (Should)
- Evidence: brand site header (`clarkcant-web/index.html:38-40`) and `og-default.png` pair the Orb with the wordmark; the marketplace header does not.
- Change: an inline SVG Orb (the favicon artwork, `aria-hidden`) before the wordmark in the header and in the footer sign-off, with the brand site's hover lift (transform only, token duration, off under reduced motion).
- Files: `apps/web/src/components/OrbMark.astro` (new), `SiteHeader.astro`, `SiteFooter.astro`, `apps/web/src/styles/global.css`.
- Acceptance: header and footer each contain one `svg.orb-mark`; the home link's accessible name stays "ClarkCant Marketplace"; screenshots show the mark at all three viewports with no wrap in the mobile header.

### P8 — "API" goes to the readable reference (Should)
- Evidence: `SiteHeader.astro:13` and `SiteFooter.astro:16` link `/openapi.json` (raw JSON) while `/docs/api` exists and links the JSON itself.
- Change: header and footer "API" link to `/docs/api`; the footer keeps a direct `OpenAPI` link for tools.
- Files: `SiteHeader.astro`, `SiteFooter.astro`.
- Acceptance: the primary nav "API" link has `href="/docs/api"` and is marked current on that page.

### P9 — Balanced headline wrapping (Should)
- Evidence: "…curated from / npm." orphan at 1440 and 768 px (`desktop-home-fold.png`, `tablet-home-fold.png`).
- Change: `text-wrap: balance` on display and section headings (`.pe-display`, `.pe-heading`, `.pe-prose h1/h2`) and on the built-in H1s; `pretty` on ledes. The block-style hash in `astro.config.ts` is computed from `BLOCK_STYLES`, so it updates automatically.
- Files: `packages/page-engine/src/block-styles.ts`, `apps/web/src/styles/global.css`.
- Acceptance: the home H1 has no one-word last line at 1440 and 768 px in the after screenshots; the production-build CSP e2e test passes (no style violation).

### P10 — Filters apply as soon as they change (Should)
- Evidence: `/packages` selects do nothing until "Search" is pressed (`PackageFilters.astro`), a "stop and think" moment.
- Change: a small bundled script submits the form when a select changes (progressive enhancement; the Search button stays for keyboard and no-JS use); a "Clear filters" link appears when any filter is active; the active-filter count is announced.
- Files: `apps/web/src/components/package/PackageFilters.astro`, `apps/web/src/pages/packages/index.astro`, `e2e/seo-a11y.spec.ts`.
- Acceptance: selecting a category in the browser navigates to `/packages?category=<slug>` without pressing Search; "Clear filters" links to `/packages` when filtered; public-page JS stays well under 120 KB.

### P11 — Share bar leads with the Markdown copy and offers a plain Markdown link (Should)
- Evidence: the bar's first action is "Copy URL"; the checklist makes "Copy page" (Markdown) primary with "View as Markdown" beside it; there is no no-JS way to open the twin; Perplexity is missing.
- Change: order "Copy page as Markdown" (primary style) → "View as Markdown" (a plain link, works without JavaScript) → "Copy URL" → Share → Ask ChatGPT / Claude / Perplexity / Gemini. Perplexity uses `https://www.perplexity.ai/search?q=` with the same short prompt carrying the absolute `.md` URL.
- Files: `apps/web/src/components/share/ShareBar.astro`, `packages/seo/src/share.ts` and its test, `e2e/seo-a11y.spec.ts`.
- Acceptance: the bar contains a link named "View as Markdown" to the `.md` URL; the first enabled button copies Markdown and shows "Page copied as Markdown."; an "Ask Perplexity" link carries the encoded prompt with the absolute `.md` URL; existing share e2e passes with the renamed button.

### P12 — Absolute links inside builder-page twins (Should)
- Evidence: `/index.md` contains `[Browse packages](/packages)` and package links like `(/packages/…)`.
- Change: page-engine Markdown for CTA, package lists and the collection "see more" link uses absolute URLs from `siteUrl`; package links point to the package's `.md` twin, matching `packages/seo` twins.
- Files: `packages/page-engine/src/blocks/shared.ts`, `content-blocks.ts`, `package-blocks.ts`, `packages/page-engine/test/blocks.test.ts`.
- Acceptance: `/index.md` on the local server contains no `](/`; page-engine tests assert the absolute forms; the twin still equals `/api/v1/pages/{slug}?format=md` (e2e).

### P13 — Compact cookie banner on phones (Should)
- Evidence: 184 px (23%) of a 375×812 screen, covering the primary CTA (`mobile-home-fold.png`).
- Change: tighter padding, smaller type below `sm`, buttons in one row; same wording and choices.
- Files: `apps/web/src/components/consent/ConsentBanner.astro`, `apps/web/src/styles/global.css`.
- Acceptance: banner height ≤ 160 px at 375×812 (measured); consent e2e still passes.

### P14 — Consistent, token-timed interaction feedback (Should)
- Evidence: `.chrome-button`, nav links, filters and cards switch colour instantly; no pressed state.
- Change: colour/border transitions at `--dur-micro` with `--ease-out`, a small pressed scale on buttons (transform only); `tokens.css` already sets durations to 0 under `prefers-reduced-motion`.
- Files: `apps/web/src/styles/global.css`, `SiteHeader.astro`, `ThemeToggle.astro`, `PackageCard.astro`.
- Acceptance: computed `transition-duration` of `.chrome-button` is `0.14s`, and `0s` with `prefers-reduced-motion: reduce` (Playwright `emulateMedia`).

### P15 — Project guidance: DESIGN.md, REVIEW.md, AGENTS.md (Must)
- Evidence: neither `DESIGN.md` nor `REVIEW.md` exists; `AGENTS.md` has no UI/AX guidance.
- Change: create `DESIGN.md` (brand essence, art direction, tokens, motion, breakpoints, components, voice, do/don't) and `REVIEW.md` (UX/AX checklist, three viewports, discovery surfaces, screenshots with UI changes); add a short additive "UI and discovery surfaces" section to `AGENTS.md`.
- Files: `DESIGN.md`, `REVIEW.md`, `AGENTS.md`.
- Acceptance: files exist with those sections; existing `AGENTS.md` content unchanged.

### P16 — `llms.txt` and `llms-full.txt` send `X-Robots-Tag: noindex` (Could)
- Evidence: scan info `llms.txt lacks X-Robots-Tag: noindex`.
- Change: add the header on both routes; they stay crawlable.
- Files: `apps/web/src/pages/llms.txt.ts`, `llms-full.txt.ts`.
- Acceptance: the scan has no `llms-txt … noindex` finding.

### Considered and not proposed

- **`X-Robots-Tag: noindex` on every Markdown twin** (9 scan warnings). The project deliberately sends `Link: <html>; rel="canonical"` on twins so search engines fold them into the HTML page (`apps/web/src/server/responses.ts:15-18`); adding `noindex` to a document that also declares a canonical sends mixed signals. This is an accepted, documented design decision; the warnings are accepted with this reason and raised as a question for the owner.
- **robots.txt errors** on staging and local: by design (`ENVIRONMENT=production` only). Production output is covered by `packages/seo` tests and the e2e robots test.
- **FAQPage markup** from the FAQ block: harmless, and nothing claims rich results; no change.
- **Share bar next to the title** (checklist position): moving it per page type is a larger layout change; left for the owner (question below).

## DONE contract

Written before implementation; implementation may not weaken it.

1. P1–P15 meet their acceptance checks (P16 is Could; if done it meets its check). Any skipped item has a stated reason here.
2. The discovery scan against the local server (`--site-origin` = local `PUBLIC_SITE_URL`) samples more than the home page and reports no findings other than: the two robots errors that are by design on non-production hosts, and the twin `noindex` warnings accepted above. Because the robots errors make the scan exit 1 on any non-production host, the exit-0 line is replaced by this stricter-in-scope check: zero findings outside that accepted list, plus the production robots unit tests passing.
3. Screenshots at 1440×900, 768×1024 and 375×812 of every changed page (home, packages, collections, about, terms, a package page, API reference) show no horizontal overflow, clipped text, overlapping elements or broken images; `shoot.mjs` reports `overflow=false` and `small=0` everywhere including the 320 px pass; vision review finds no High issue.
4. No rubric area scores below its baseline; Brand recall, Motion, Responsive and Accessibility reach at least 2; Storytelling's gap is recorded as an unresolved question if not raised.
5. Keyboard: every new or changed control (filters, share bar actions, footer links, Orb home link) is reachable by Tab with a visible focus ring; reduced motion removes the new transitions (checked with `emulateMedia`).
6. `pnpm verify`, `pnpm build` and `pnpm migrations:check` pass through the gate wrapper; the Playwright suite passes against the dev server, and the CSP and JavaScript-budget tests pass against a production preview (`E2E_BUILT=1`).
7. `DESIGN.md`, `REVIEW.md` and `AGENTS.md` reflect the delivered direction and checks; prior `AGENTS.md` content is preserved.
8. The local server started for this review is stopped (PID recorded).

## Implementation log

All changes are uncommitted on `dev`. Nothing was committed, pushed or deployed, and nothing touches auth, API contracts, the DB schema, CI or wrangler config.

| Item | What changed | Files |
|---|---|---|
| P1 | The filter fieldset can shrink (`min-w-0`); the search row wraps (`flex-wrap`, input `min-w-[12rem]`). | `components/package/PackageFilters.astro`, `components/PackageSearchForm.astro` |
| P2 | A `.footer-link` class gives every footer link and the "Cookie settings" button at least a 24×24 px hit area. The package page's breadcrumb, npm, Source and share-card links get `inline-flex min-h-6`. | `styles/global.css`, `SiteFooter.astro`, `pages/packages/[...name].astro` |
| P3 | Explicit `{" "}` before the cookie-policy link, the `/openapi.json` link and the 404 page's second link. | `consent/ConsentBanner.astro`, `pages/docs/api.astro`, `pages/[...slug].astro` |
| P4 | New `renderPackagesIndexMarkdown` and `renderCollectionsIndexMarkdown` in `packages/seo`, served at `/packages.md` and `/collections.md` with a canonical `Link` header. The unfiltered first page of `/packages` advertises its twin; filtered or paginated views stay `noindex` with no alternate. `llms.txt` lists both under "Start here", and its twin claim now reads "every indexable catalogue and content page". | `packages/seo/src/markdown-twins.ts`, `pages/packages.md.ts`, `pages/collections.md.ts`, `server/seo.ts`, `pages/packages/index.astro`, `pages/collections/index.astro`, `server/site-index.ts` |
| P5 | `ItemList` plus `BreadcrumbList` on both index pages, built from the records the page renders. The proposal said `CollectionPage`, but the project validator (`validateJsonLd`) does not accept that type, so the plain `ItemList` it already supports is used instead. | `server/seo.ts` |
| P6 | `RenderedPage.astro` no longer wraps the builder page in a second gutter. The home search sits in the page column, and an unlayered `.home-landing .pe-page` rule trims the hero's top padding. It has to be unlayered because the block styles are an unlayered inline sheet. | `components/page-engine/RenderedPage.astro`, `pages/index.astro`, `styles/global.css` |
| P7 | New `OrbMark.astro`: the favicon artwork inline, `aria-hidden`, with ids unique per use. It appears in the header home link and the footer sign-off, and lifts slightly on hover and focus (transform only, token duration). "Marketplace" is screen-reader-only below 400 px so the header does not wrap. | `components/OrbMark.astro`, `SiteHeader.astro`, `SiteFooter.astro`, `styles/global.css` |
| P8 | The header and footer "API" links go to `/docs/api`; the footer adds direct OpenAPI, llms.txt and Sitemap links. | `SiteHeader.astro`, `SiteFooter.astro` |
| P9 | `text-wrap: balance` on h1–h3, `.pe-display` and `.pe-heading`; `pretty` on paragraphs and `.pe-lede`. The block-style CSP hash is derived from `BLOCK_STYLES` automatically. | `styles/global.css`, `packages/page-engine/src/block-styles.ts` |
| P10 | A bundled script (CSP-safe, a few hundred bytes) submits the filter form when a select changes; the Search button still works without JavaScript. A "Clear filters" link appears when any filter is active, and the legend says filters apply on change. | `components/package/PackageFilters.astro` |
| P11 | Share bar order: Copy as Markdown (primary style), then a plain "View as Markdown" link, Copy URL, Share…, and Ask ChatGPT, Claude, Perplexity and Gemini. Perplexity is a new share target. | `components/share/ShareBar.astro`, `packages/seo/src/share.ts` |
| P12 | Builder-page twins use absolute URLs: CTA and logo-cloud links (fragments resolve against the page URL), package lists (to each package's `.md` twin) and the collection "see more" link. | `packages/page-engine/src/blocks/{shared,package-blocks,content-blocks,brand-blocks}.ts` |
| P13 | Below 640 px the banner has tighter padding, 13 px copy and two equal buttons on one row. The wording and choices are unchanged. | `consent/ConsentBanner.astro`, `styles/global.css` |
| P14 | Links, buttons, summaries and form fields share one colour transition timed by `--dur-micro` and `--ease-out`; chrome, consent and action buttons get a 0.97 pressed scale. `tokens.css` already sets durations to 0 under reduced motion. | `styles/global.css`, `block-styles.ts` |
| P15 | New `DESIGN.md` and `REVIEW.md`; `AGENTS.md` gains a "UI and discovery surfaces" section (added only, nothing removed). | repo root |
| P16 | `llms.txt` and `llms-full.txt` send `X-Robots-Tag: noindex` through an optional flag on `textResponse`. | `server/responses.ts`, `pages/llms.txt.ts`, `pages/llms-full.txt.ts` |
| Found during verification | The package page had two `h1` elements because README headings were injected as is. `nestReadmeHeadings` shifts README headings down two levels (capped at h6), marks their visual level, and drops a leading README title that repeats the package name. | `components/package/readme-headings.ts`, `PackageReadme.astro`, `pages/packages/[...name].astro` |

Tests added or updated:
- `apps/web/test/readme-headings.test.ts` (new, 3 tests).
- `packages/page-engine/test/blocks.test.ts`: absolute Markdown links, fragment and `mailto` handling.
- `packages/seo/test/surfaces.test.ts`: the Perplexity target and both index renderers.
- `e2e/seo-a11y.spec.ts`:
  - twins, JSON-LD and noindex rules for `/packages` and `/collections`;
  - the `llms.txt` header and links;
  - share bar order and the Markdown link;
  - 320 px reflow and filter auto-apply;
  - footer target sizes;
  - banner spacing and height;
  - reduced-motion transitions.

Problems found and fixed while implementing:
- `astro check` rejected `querySelectorAll<HTMLSelectElement>`, so the filter script uses one `change` listener per form.
- The footer "API" link measured 22 px wide, so `.footer-link` now has a 24 px minimum width.
- `/docs/api` and `/openapi.json` returned 404 on the long-running dev server after new route files were added. Restarting the dev server fixed it; the cause was a stale dev route table, not the code.

## After evidence

Verified on the local dev server (port 4327, restarted once to clear a stale route table) and then on a production preview of the gate output. Evidence is in `after-local-2/`, `measure-2.json`, `measure-2-extras.json`, `scan-local-after-2.txt`, `e2e-dev.txt`, `gates.txt` and `e2e-built.txt`.

### Screenshots and measurements

| Check | Before | After |
|---|---|---|
| Overflow (7 pages × 1440, 768, 375, 320) | `/packages` 363 px at 320 (staging) | none (28 of 28 entries clean) |
| Targets under 24 px | 13 per page; 18 on the package page | 0 on every page and viewport; smallest footer target 24×24 |
| `h1` elements on the package page | 2 | 1 |
| Cookie banner at 375×812 | 184 px (23 %) | 159.75 px |
| Header vs H1 left edge (1440 / 768 / 375) | 152 vs 192 / – / 17 vs 34 | 152 = 152 / 27.19 = 27.19 / 17.375 = 17.375 |
| Search to eyebrow gap at 1440 | about 120 px | 56 px |
| Header at 320 px | – | one row, 67 px; "Marketplace" is screen-reader-only |
| Missing spaces | "tracking.Cookie policy", "is/openapi.json" | fixed (e2e asserts the banner text) |
| Console errors / non-200 | none | none |

Vision review of `after-local-2/`:
- The home page now shares one left edge. The headline breaks evenly, and the Orb appears in the header and footer at every viewport.
- The phone banner leaves both hero buttons visible above it (`mobile-home-fold.png`).
- The package page shows one title with the README starting on its first paragraph.
- The share bar leads with Copy as Markdown.
- No High issues. One Medium, pre-existing and out of scope: the fixture README's cover image is a relative path that the indexer does not rewrite, so it shows as a broken image (`desktop-packages-40clarkcant-example-frame-widget-fold.png`; see the questions).
- The dark pill at the bottom of dev captures is the Astro dev toolbar and does not ship.

### Discovery scan (local, `--site-origin http://localhost:4324`)

| | Before | After |
|---|---|---|
| Errors | 2 (robots, by design) | 2 (robots, by design) |
| Warnings | 12: two missing twins, two missing JSON-LD, eight twin-noindex | 10, all the accepted twin-noindex warning (including the new `/packages.md` and `/collections.md`, which follow the same canonical design) |
| llms.txt noindex | missing | sent on `llms.txt` and `llms-full.txt` |

This meets DONE item 2: there are no findings outside the accepted list. `/index.md` no longer contains `](/` (asserted in e2e and page-engine tests).

### Gates and tests

- `gates.sh`: verify exit 0, build exit 0, migrations:check exit 0; **Tests 335 passed, 3 skipped (338)**. `astro check`: 0 errors, 0 warnings.
- Playwright against the dev server: **26 passed, 0 failed, 4 skipped**.
  - Two skips need a production build and pass below.
  - Two page-builder tests skip on their own preconditions, as they did before this work.
- Playwright `seo-a11y.spec.ts` against the production preview with `E2E_BUILT=1`: **24 passed, 0 failed, 0 skipped**. This includes the hashed CSP test (no script or style violations with the new block styles and the filter script) and the 120 KB JavaScript budget test.

### Scores (after)

| Area | Before | After | Why |
|---|---|---|---|
| First impression | 2 | 3 | One aligned column, balanced headline, compact search, and the banner no longer hides the primary button. |
| Brand recall | 1 | 2 | The Orb and wordmark pair as on clarkcant.cc, the favicon and the social card; a cropped header now reads as ClarkCant. |
| Content punch | 2 | 2 | Unchanged copy; missing spaces fixed. |
| Clarity and hierarchy | 2 | 3 | Filters apply on change with a Clear link; "API" opens the readable reference; one `h1` per page. |
| Storytelling | 1 | 1 | Home content is published builder data; see the questions. |
| Knowledge and trust | 2 | 2 | The `llms.txt` twin claim is now accurate; trust wording is unchanged. |
| Motion | 1 | 2 | Shared token-timed feedback, pressed state and Orb lift, all at 0 s under reduced motion (e2e). |
| Responsive | 1 | 2 | No overflow down to 320 px, compact phone banner, and the header stays on one row. |
| Accessibility | 1 | 2 | 2.5.8 and 1.4.10 now pass on every sampled page, and axe reports no serious violations (e2e). |
| Performance feel | 2 | 2 | Public script is still a few KB; the budget test passes. |

No area dropped, and Brand, Motion, Responsive and Accessibility each reach 2, so DONE item 4 is met.

### DONE contract check

1. P1–P16 are all met, with two deviations. P5 uses `ItemList` because the validator rejects `CollectionPage`. The "Clear filters" and "View as Markdown" links use same-origin paths, which work on every host.
2. The scan has no findings outside the accepted list.
3. No overflow, small targets, clipped text or High visual issues.
4. Scores: see above.
5. Keyboard: the new controls are native links, buttons and selects with the global focus ring; the reduced-motion e2e passes.
6. Gates are green, the dev e2e run is green, and the built CSP and budget tests are green.
7. `DESIGN.md`, `REVIEW.md` and the new `AGENTS.md` section describe what shipped.
8. Every server started for this review was stopped and port 4327 is free:
   - Dev server, first run: launcher 59780, listener 65404.
   - Dev server, restart: launcher 11592, listener 53068.
   - Production preview: launcher 9840, listener 48340.

## Unresolved questions

1. **Twin `noindex` vs canonical.** The scan warns on every Markdown twin, including the new `/packages.md` and `/collections.md`. The project deliberately sends `Link: rel="canonical"` instead. Should it keep that choice (accepting the warning), or switch to `X-Robots-Tag: noindex`?
2. **Staging robots.** Staging disallows everything by design, so staging scans always exit 1. Is that the intended long-term policy, or should staging allow AI search crawlers for pre-launch testing?
3. **Storytelling on the home page.** The home page is builder content in the database (hero, two lists, FAQ). A "how it works" chapter (find, review permissions, install) would lift Storytelling, but it is an editorial change to the published page, which this review did not seed or change.
4. **Share bar position.** The checklist puts the share bar next to the title; here it sits below the content. Should it move per page type?
5. **Relative README images.** The fixture README's cover image is broken because the indexer (`packages/markdown` or the indexer, out of scope) does not rewrite relative image paths against the repository or npm CDN. Should the indexer rewrite them, or drop images it cannot resolve?
6. **`docs/architecture.md`** still lists "Ask ChatGPT / Claude / Gemini" and does not mention Perplexity or the new catalogue twins; `docs/` was outside this review's write scope.
7. **Leftover e2e pages** (`/e2e-mumqu590`, `/e2e-mumquygm`, `/e2e-mumqzvgj`) remain in the local database from earlier Playwright runs and appear in the local sitemap. Should the builder e2e clean up after itself?
8. **Deviations to confirm:** P5 uses `ItemList` rather than `CollectionPage`, and "Clear filters" and "View as Markdown" use same-origin paths rather than absolute URLs.
