/**
 * Styles for rendered page documents, shared by the public page, the signed preview and the builder canvas so all
 * three look identical. Only brand token variables are used (see apps/web/src/styles/tokens.css), so light/dark
 * themes apply automatically. Kept as a string so any host can inline it without a CSS pipeline.
 */
export const BLOCK_STYLES = `
.pe-page { width: 100%; max-width: var(--max, 76rem); margin-inline: auto; padding-inline: var(--gutter, 1rem); padding-block: var(--space-7, 3rem); color: var(--text); }
.pe-region { display: flex; flex-direction: column; gap: var(--space-7, 3rem); }
.pe-region + .pe-region { margin-top: var(--space-7, 3rem); }
.pe-page-header { margin-bottom: var(--space-7, 3rem); }
.pe-block { min-width: 0; }
.pe-eyebrow { font-family: var(--font-mono); font-size: 0.75rem; letter-spacing: 0.12em; text-transform: uppercase; color: var(--text-faint); margin: 0 0 var(--space-3, .75rem); }
.pe-display { font-family: var(--font-display); font-weight: 400; font-size: var(--step-3, 2.75rem); line-height: 1.05; margin: 0; max-width: 22ch; overflow-wrap: anywhere; }
.pe-heading { font-family: var(--font-display); font-weight: 400; font-size: var(--step-2, 1.75rem); line-height: 1.15; margin: 0 0 var(--space-5, 1.5rem); overflow-wrap: anywhere; }
h3.pe-heading { font-size: var(--step-1, 1.25rem); font-family: var(--font-sans); font-weight: 600; }
.pe-lede { color: var(--text-muted); font-size: var(--step-1, 1.125rem); line-height: 1.55; max-width: 62ch; margin: var(--space-4, 1rem) 0 0; }
.pe-faint { color: var(--text-faint); }
.pe-mono { font-family: var(--font-mono); font-size: 0.75rem; overflow-wrap: anywhere; margin: 0; }
.pe-hero { padding-block: var(--space-6, 2rem) var(--space-4, 1rem); }
.pe-align-center { text-align: center; }
.pe-align-center .pe-display, .pe-align-center .pe-lede { margin-inline: auto; }
.pe-spectrum { height: 2px; width: min(12rem, 60%); margin-top: var(--space-6, 2rem); background: var(--spectrum); filter: var(--spectrum-filter); }
.pe-align-center .pe-spectrum { margin-inline: auto; }
.pe-hero-children { display: flex; flex-direction: column; gap: var(--space-5, 1.5rem); margin-top: var(--space-6, 2rem); }
.pe-hero-children .pe-cta { padding: 0; border: 0; background: none; box-shadow: none; }
.pe-prose { line-height: 1.7; max-width: 70ch; overflow-wrap: anywhere; }
.pe-prose.pe-width-wide { max-width: none; }
.pe-prose > :first-child { margin-top: 0; }
.pe-prose h1, .pe-prose h2 { font-family: var(--font-display); font-weight: 400; line-height: 1.15; margin: 1.6em 0 .5em; }
.pe-prose h1 { font-size: var(--step-3, 2.5rem); }
.pe-prose h2 { font-size: var(--step-2, 1.75rem); }
.pe-prose h3, .pe-prose h4 { font-weight: 600; margin: 1.4em 0 .4em; }
.pe-prose p, .pe-prose ul, .pe-prose ol, .pe-prose table, .pe-prose pre, .pe-prose blockquote { margin: 0 0 1em; }
.pe-prose ul, .pe-prose ol { padding-left: 1.4em; }
.pe-prose ul { list-style: disc; }
.pe-prose ol { list-style: decimal; }
.pe-prose a, .pe-more a, .pe-snippet-note a { color: var(--accent); text-decoration: underline; text-underline-offset: 3px; }
.pe-prose code { font-family: var(--font-mono); font-size: .9em; background: var(--code-bg); border-radius: 6px; padding: .1em .35em; }
.pe-prose pre, .pe-code { font-family: var(--font-mono); font-size: .875rem; background: var(--code-bg); border: 1px solid var(--line); border-radius: var(--radius-sm, 10px); padding: var(--space-4, 1rem); overflow-x: auto; margin: 0; }
.pe-prose pre code { background: none; padding: 0; }
.pe-prose blockquote { border-left: 3px solid var(--accent-soft); padding-left: var(--space-4, 1rem); color: var(--text-muted); }
.pe-prose table, .pe-comparison table { border-collapse: collapse; width: 100%; font-size: .9375rem; }
.pe-prose th, .pe-prose td, .pe-comparison th, .pe-comparison td { border-bottom: 1px solid var(--line); padding: .6em .75em; text-align: left; vertical-align: top; }
.pe-prose img { max-width: 100%; height: auto; }
.pe-media { margin: 0; }
.pe-media img { display: block; width: 100%; height: auto; border-radius: var(--radius, 16px); border: 1px solid var(--line); }
.pe-media figcaption { color: var(--text-faint); font-size: .875rem; margin-top: var(--space-2, .5rem); }
.pe-size-content { max-width: 48rem; }
.pe-grid { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-5, 1.25rem); grid-template-columns: repeat(auto-fill, minmax(min(100%, 17rem), 1fr)); }
.pe-card { height: 100%; display: flex; flex-direction: column; gap: var(--space-2, .5rem); border: 1px solid var(--line); background: var(--card); border-radius: var(--radius, 16px); padding: var(--space-5, 1.25rem); box-shadow: var(--shadow); }
.pe-card-title { font-family: var(--font-display); font-weight: 400; font-size: 1.5rem; line-height: 1.15; margin: 0; }
.pe-card-title a { color: inherit; text-decoration: none; }
.pe-card-title a:hover { text-decoration: underline; text-underline-offset: 3px; }
.pe-card-text { color: var(--text-muted); font-size: .875rem; margin: 0; }
.pe-card-meta { margin: auto 0 0; padding-top: var(--space-2, .5rem); font-size: .75rem; color: var(--text-muted); }
.pe-verified { color: var(--success); font-size: .75rem; font-family: var(--font-sans); }
.pe-empty { border: 1px dashed var(--line-strong); border-radius: var(--radius, 16px); padding: var(--space-6, 2rem); text-align: center; color: var(--text-muted); margin: 0; }
.pe-more { margin: var(--space-4, 1rem) 0 0; }
.pe-stat-list { display: grid; gap: var(--space-5, 1.25rem); grid-template-columns: repeat(auto-fit, minmax(min(100%, 11rem), 1fr)); margin: 0; }
.pe-stat { border-top: 1px solid var(--line-strong); padding-top: var(--space-3, .75rem); display: flex; flex-direction: column-reverse; justify-content: flex-end; gap: var(--space-1, .25rem); }
.pe-stat dt { color: var(--text-muted); font-size: .875rem; }
.pe-stat dd { margin: 0; }
.pe-stat-value { font-family: var(--font-display); font-size: var(--step-3, 2.5rem); line-height: 1; order: 1; }
.pe-stat-note { color: var(--text-faint); font-size: .8125rem; order: -1; }
.pe-cta { border: 1px solid var(--line); background: var(--bg-raised); border-radius: var(--radius-lg, 24px); padding: var(--space-6, 2rem); }
.pe-actions { display: flex; flex-wrap: wrap; gap: var(--space-3, .75rem); margin-top: var(--space-5, 1.25rem); }
.pe-hero-children .pe-actions { margin-top: 0; }
.pe-align-center .pe-actions { justify-content: center; }
.pe-button { display: inline-flex; align-items: center; min-height: 44px; padding: 0 1.25rem; border-radius: var(--radius-pill, 999px); background: var(--accent); color: var(--on-accent); font-weight: 500; text-decoration: none; transition: filter var(--dur-micro, 140ms) var(--ease-out, ease-out); }
.pe-button:hover { filter: brightness(1.08); }
.pe-button-quiet { background: transparent; color: var(--text); border: 1px solid var(--line-strong); }
.pe-faq-item { border-bottom: 1px solid var(--line); }
.pe-faq-item summary { cursor: pointer; padding: var(--space-4, 1rem) 0; font-weight: 500; min-height: 44px; }
.pe-faq-answer { color: var(--text-muted); padding-bottom: var(--space-4, 1rem); max-width: 70ch; line-height: 1.6; }
.pe-faq-answer p { margin: 0 0 .75em; }
.pe-table-scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: var(--radius, 16px); }
.pe-comparison thead th { font-weight: 600; }
.pe-comparison tbody th { font-weight: 500; color: var(--text-muted); }
.pe-logo-list { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-6, 2rem); }
.pe-logo img { max-height: 40px; width: auto; display: block; }
.pe-logo a { color: var(--text-muted); text-decoration: none; }
.pe-logo-name { font-family: var(--font-display); font-size: 1.5rem; color: var(--text-muted); }
.pe-snippet-note { color: var(--text-muted); font-size: .875rem; margin: var(--space-2, .5rem) 0 0; }
.pe-publisher .pe-eyebrow { margin-bottom: var(--space-2, .5rem); }
.pe-publisher .pe-grid { margin-top: var(--space-5, 1.25rem); }
.pe-diagnostic { border: 1px dashed var(--warning); color: var(--warning); background: color-mix(in srgb, var(--warning) 8%, transparent); border-radius: var(--radius-sm, 10px); padding: var(--space-3, .75rem) var(--space-4, 1rem); font-size: .875rem; margin: 0; }
@media (max-width: 640px) {
  .pe-page { padding-block: var(--space-6, 2rem); }
  .pe-prose table { display: block; max-width: 100%; overflow-x: auto; }
  .pe-cta { padding: var(--space-5, 1.25rem); }
}
`;
