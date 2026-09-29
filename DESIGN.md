# DESIGN.md

How the ClarkCant Marketplace looks, moves and speaks. It is the source of truth for public pages; the tokens
themselves live in [`apps/web/src/styles/tokens.css`](apps/web/src/styles/tokens.css) (copied from the brand site,
`clarkcant-web/assets/css/tokens.css`) and page-builder block styles in
[`packages/page-engine/src/block-styles.ts`](packages/page-engine/src/block-styles.ts). Review checks are in
[REVIEW.md](REVIEW.md).

## Brand essence

- **Quiet chrome, one loud thing.** Warm paper surfaces, ink text, one pale-lavender accent. The only saturated
  colour is the Orb's spectrum (the header rule, the Orb mark); it is not used for buttons, badges or charts.
- **Precise, not promotional.** The marketplace discovers and curates, npm distributes, ClarkCant installs and runs.
  Copy never claims a package is reviewed, verified or safe beyond the trust wording in [AGENTS.md](AGENTS.md).
- **Recognisable when cropped.** The Orb mark sits beside the "ClarkCant" wordmark in the header and footer, as on
  clarkcant.cc, the favicon and the default social card.

## Typography

| Role | Family | Use |
|---|---|---|
| Display | Instrument Serif 400 (italic for one emphasised word at most) | Page titles, section headings, card titles |
| Text | Geist 400/500/600 | Body, UI, labels |
| Mono | Geist Mono 400/500 | Package names, versions, integrity digests, eyebrows |

- Fluid type scale `--step--1` … `--step-5`; body copy uses Tailwind `text-sm`/`text-lg` on top of it.
- Headings balance their lines (`text-wrap: balance`, set globally and in block styles); paragraphs use `pretty`,
  so a headline never ends on one orphaned word.
- Line length: 62–70ch for ledes and prose.

## Colour

Semantic tokens only (`--bg`, `--bg-raised`, `--card`, `--line`, `--text`, `--text-muted`, `--text-faint`, `--accent`,
`--accent-soft`, `--on-accent`, `--success`, `--warning`, `--focus`), mapped to Tailwind colours in
`apps/web/src/styles/global.css`. Light and dark themes switch by variables; never hard-code a hex value in a
component. Muted and faint text meet 4.5:1 on `--bg` in both themes; keep it that way when adjusting tokens.

## Layout

- One content column: `container-page` (max `--max` 76rem, gutter `--gutter`). Builder pages get the same column from
  the engine's `.pe-page`; never wrap engine HTML in a second container (it doubles the gutter and breaks the left edge
  shared with the header).
- Breakpoints (Tailwind): mobile first, `sm` 640, `md` 768 (primary nav appears), `lg` 1024 (package detail sidebar).
- Every public page reflows at 320 px without horizontal scrolling. Grids and fieldsets that hold form controls need
  `min-w-0`; wide tables scroll inside their own wrapper.

## Components

- **Buttons**: pill shape. Primary is accent-filled (`bg-accent text-on-accent`, or `.chrome-button-primary`);
  secondary is `.chrome-button` (card surface, strong line). Minimum height 36 px for chrome buttons, 44 px for page
  engine buttons.
- **Targets**: every link or button outside running text has at least a 24×24 px hit area (WCAG 2.2 target size).
  Footer links use `.footer-link`; small inline-flex links use `min-h-6`.
- **Cards**: `rounded-card border border-line bg-card shadow-card`, hover shows the accent border.
- **Forms**: pill inputs, visible labels or `sr-only` labels, `focus:border-accent` plus the global focus ring.
  Package filters apply on change (a small bundled script); the Search button stays for keyboard and no-JS use.
- **Share bar**: "Copy as Markdown" leads (primary), then "View as Markdown" (plain link), "Copy URL", native share,
  and "Ask ChatGPT / Claude / Perplexity / Gemini". Targets live in `packages/seo/src/share.ts`.
- **Cookie banner**: fixed to the bottom, compact on phones (at most ~20% of a 375×812 screen), two equal buttons.

## Motion

- Tokens: `--dur-micro` 140 ms for hover and press feedback, `--dur` 240 ms for the Orb mark, `--ease-out` and
  `--ease-spring`. `prefers-reduced-motion: reduce` sets every duration to 0 (tokens.css), so components must use the
  tokens rather than literal durations.
- Links, buttons and form controls transition colour, border, background and opacity. Buttons press to
  `scale(0.97)`. The Orb mark lifts and turns slightly on hover or focus of its link.
- Motion never carries meaning on its own and never delays content. No scroll-jacking, autoplay or parallax.

## Voice

- Plain, specific, second person where it helps ("ClarkCant asks for consent at install time").
- Calls to action are verb + object ("Browse packages", "Open in ClarkCant", "Copy as Markdown").
- Empty states say what will appear and when, not "Nothing here".
- Spaces around inline links in Astro templates are explicit (`{" "}`) because HTML compression drops a line break
  between text and a following element.

## Agent-facing surfaces

Every indexable catalogue and content page has a Markdown twin at `<path>.md` (home: `/index.md`), advertised with
`<link rel="alternate" type="text/markdown">`, linked from `/llms.txt`, and written with absolute URLs so it reads on
its own. Structured data (JSON-LD) mirrors visible content only. No FAQ or HowTo markup is added for search appearance.

## Do and don't

- Do reuse `container-page`, the semantic colour utilities and the motion tokens.
- Do check new UI at 1440, 768, 375 and 320 px, in both themes, with the keyboard.
- Don't add a React island to a public page; use an Astro component with a small `<script>`.
- Don't add inline `<script>` or `<style>` content that is not a fixed string hashed in `apps/web/astro.config.ts`.
- Don't use the spectrum gradient as a fill for buttons or text.
