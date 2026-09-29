/*
 * The builder canvas: a sandboxed `srcdoc` iframe (scripts allowed, no same-origin access) showing the engine's
 * HTML. A srcdoc document inherits the builder page's Content Security Policy, so the builder page allows exactly
 * this script (at runtime, `admin/pages/[id].astro`) and this style (at build time, astro.config.ts) by hash. Both
 * hashes are computed from these same constants, so any change is picked up automatically. This module must stay
 * free of imports because astro.config.ts loads it.
 */

export const CANVAS_FONTS =
  "https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&family=Instrument+Serif:ital@0;1&display=swap";

const CANVAS_CSS = `
html { background: var(--bg); color: var(--text); font-family: var(--font-sans); -webkit-font-smoothing: antialiased; }
body { margin: 0; padding: 1.5rem clamp(1rem, 4vw, 2.5rem); }
.pe-node { position: relative; cursor: pointer; border-radius: 6px; outline: 1px dashed transparent; outline-offset: 3px; }
.pe-node:hover { outline-color: var(--line-strong); }
.pe-node.pe-selected { outline: 2px solid var(--accent); }
`;

/*
 * Runs inside the sandboxed canvas. It only reports which block was clicked and highlights the block the builder
 * selects; links and buttons in the canvas never navigate.
 */
export const CANVAS_SCRIPT = `
(function () {
  function mark(id) {
    document.querySelectorAll(".pe-selected").forEach(function (node) { node.classList.remove("pe-selected"); });
    if (!id) return;
    var node = document.querySelector('[data-block-id="' + CSS.escape(id) + '"]');
    if (node) { node.classList.add("pe-selected"); node.scrollIntoView({ block: "nearest" }); }
  }
  document.addEventListener("click", function (event) {
    var target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest("a, button, form")) event.preventDefault();
    var node = target.closest("[data-block-id]");
    if (node) parent.postMessage({ source: "pe-canvas", type: "select", id: node.getAttribute("data-block-id") }, "*");
  });
  document.addEventListener("submit", function (event) { event.preventDefault(); });
  window.addEventListener("message", function (event) {
    if (event.source !== parent) return;
    var data = event.data;
    if (data && data.source === "pe-builder" && data.type === "highlight") mark(data.id);
  });
  parent.postMessage({ source: "pe-canvas", type: "ready" }, "*");
})();
`;

/** The canvas `<style>` text for the site stylesheet `css`. */
export function canvasStyle(css: string): string {
  return `${css}${CANVAS_CSS}`;
}

export function canvasDocument(html: string, css: string, locale: string): string {
  // `html` and `css` are produced by the engine and the site's own stylesheet; the iframe sandbox isolates it anyway.
  return (
    `<!doctype html><html lang="${locale.replace(/[^A-Za-z0-9-]/g, "")}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${CANVAS_FONTS}">` +
    `<style>${canvasStyle(css)}</style></head><body>${html}<script>${CANVAS_SCRIPT}</script></body></html>`
  );
}
