# REVIEW.md

Checklist for reviewing a change that touches public pages, page-builder blocks or the machine-readable surfaces.
Design rules are in [DESIGN.md](DESIGN.md); engineering rules are in [AGENTS.md](AGENTS.md).

## Every UI change

- [ ] Screenshots at 1440×900, 768×1024 and 375×812 (light theme; dark when colours changed) are attached to the PR.
- [ ] No horizontal scroll at 320 px (`e2e/seo-a11y.spec.ts` covers home, package, builder, policy and `/packages`).
- [ ] Every interactive element outside running text is at least 24×24 px.
- [ ] Keyboard: every new control is reachable with Tab, shows the focus ring and works with Enter/Space.
- [ ] Reduced motion: new transitions use the motion tokens, so `prefers-reduced-motion` removes them.
- [ ] Copy: verb + object calls to action; trust wording unchanged; spaces around inline links render.
- [ ] Headings: exactly one `<h1>` per page and no skipped levels in new sections.
- [ ] No new React on public pages; the JavaScript budget test passes against a production build (`E2E_BUILT=1`).
- [ ] No new inline script or style unless it is a fixed string hashed in `apps/web/astro.config.ts`; the CSP test
      passes against a production build.

## Discovery and agent surfaces

- [ ] A new indexable page has a Markdown twin (`<path>.md`), `rel="alternate"` in its head, and a line in
      `/llms.txt` when it is a starting point for agents.
- [ ] Twins are rendered from the same records as the HTML and use absolute URLs only.
- [ ] JSON-LD describes only what the page shows and passes `validateJsonLd` (`packages/seo`).
- [ ] Filtered, paginated and utility pages are `noindex` and advertise no twin.
- [ ] Run the discovery scan against a local server:
      `node <skills>/ak-enhance-ux-ax/scripts/check-discovery-surfaces.mjs http://localhost:4321 --site-origin <PUBLIC_SITE_URL>`.
      Known, accepted findings on non-production hosts: robots.txt disallows everything (by design outside
      production), and twins carry `Link: rel="canonical"` rather than `X-Robots-Tag: noindex`.

## Commands

```sh
pnpm verify                 # lint + typecheck + unit/integration tests
pnpm test:e2e               # Playwright against a running server (BASE_URL=...)
E2E_BUILT=1 pnpm test:e2e   # CSP and JavaScript budget against astro preview or a deployment
```
