import { useEffect, useMemo, useRef } from "react";

import { isCanvasMessage, type PageDocument, type PreviewMode, type RenderedDocument } from "./builder-types";

const FONTS =
  "https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&family=Instrument+Serif:ital@0;1&display=swap";

const CANVAS_CSS = `
html { background: var(--bg); color: var(--text); font-family: var(--font-sans); -webkit-font-smoothing: antialiased; }
body { margin: 0; padding: 1.5rem clamp(1rem, 4vw, 2.5rem); }
.pe-node { position: relative; cursor: pointer; border-radius: 6px; outline: 1px dashed transparent; outline-offset: 3px; }
.pe-node:hover { outline-color: var(--line-strong); }
.pe-node.pe-selected { outline: 2px solid var(--accent); }
`;

/*
 * Runs inside the sandboxed canvas (scripts allowed, no same-origin access). It only reports which block was
 * clicked and highlights the block the builder selects; links and buttons in the canvas never navigate.
 */
const CANVAS_SCRIPT = `
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

const WIDTHS: Partial<Record<PreviewMode, string>> = { desktop: "100%", tablet: "768px", mobile: "375px" };

function canvasDocument(html: string, css: string, locale: string): string {
  // `html` and `css` are produced by the engine and the site's own stylesheet; the iframe sandbox isolates it anyway.
  return (
    `<!doctype html><html lang="${locale.replace(/[^A-Za-z0-9-]/g, "")}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${FONTS}">` +
    `<style>${css}${CANVAS_CSS}</style></head><body>${html}<script>${CANVAS_SCRIPT}</script></body></html>`
  );
}

function lengthNote(value: number, min: number, max: number): string {
  if (value === 0) return "missing";
  if (value < min) return `${value} characters, short (aim for ${min}-${max})`;
  if (value > max) return `${value} characters, long (aim for ${min}-${max}; search engines truncate)`;
  return `${value} characters, good`;
}

export function PreviewPane({
  mode,
  rendered,
  document: page,
  url,
  markdownUrl,
  canvasCss,
  selectedId,
  onSelect,
}: {
  mode: PreviewMode;
  rendered: RenderedDocument | null;
  document: PageDocument;
  url: string;
  markdownUrl: string;
  canvasCss: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const srcDoc = useMemo(
    () => (rendered ? canvasDocument(rendered.html, canvasCss, page.meta.locale) : ""),
    [rendered, canvasCss, page.meta.locale],
  );

  useEffect(() => {
    const highlight = () => frame.current?.contentWindow?.postMessage({ source: "pe-builder", type: "highlight", id: selectedId }, "*");
    highlight();
    const onMessage = (event: MessageEvent) => {
      // Only the canvas iframe may drive selection; its origin is opaque ("null"), so identity is checked instead.
      if (!frame.current || event.source !== frame.current.contentWindow || !isCanvasMessage(event.data)) return;
      if (event.data.type === "ready") highlight();
      else onSelect(event.data.id);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [selectedId, onSelect]);

  if (!rendered) {
    return <p className="p-6 text-sm text-muted">Rendering…</p>;
  }

  const width = WIDTHS[mode];
  if (width) {
    return (
      <div className="flex h-full justify-center overflow-auto bg-raised p-2">
        <iframe
          ref={frame}
          title={`Canvas preview (${mode})`}
          sandbox="allow-scripts"
          srcDoc={srcDoc}
          className="h-[70vh] min-h-[28rem] rounded-lg border border-line bg-bg lg:h-full"
          style={{ width, maxWidth: "100%" }}
        />
      </div>
    );
  }

  if (mode === "markdown") {
    return (
      <div className="h-full overflow-auto p-4">
        <p className="mb-2 text-xs text-muted">
          Markdown built from the same document. Published pages serve it at <code className="font-mono">{markdownUrl}</code>.
        </p>
        <pre className="whitespace-pre-wrap rounded-lg border border-line bg-raised p-4 font-mono text-sm">{rendered.markdown}</pre>
      </div>
    );
  }

  if (mode === "agent") {
    return (
      <div className="grid h-full content-start gap-4 overflow-auto p-4">
        <section aria-label="Summary">
          <h3 className="text-xs font-medium uppercase tracking-widest text-faint">Summary for agents</h3>
          <pre className="mt-1 whitespace-pre-wrap rounded-lg border border-line bg-raised p-3 font-mono text-sm">{rendered.summary}</pre>
        </section>
        <section aria-label="Structured data">
          <h3 className="text-xs font-medium uppercase tracking-widest text-faint">Structured data (JSON-LD)</h3>
          <pre className="mt-1 overflow-x-auto rounded-lg border border-line bg-raised p-3 font-mono text-xs">
            {JSON.stringify(rendered.structuredData, null, 2)}
          </pre>
        </section>
      </div>
    );
  }

  const title = page.meta.title;
  const description = page.meta.description;
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();

  if (mode === "seo") {
    const checks = [
      { label: "Title", value: lengthNote(title.length, 15, 60) },
      { label: "Description", value: lengthNote(description.length, 50, 160) },
      { label: "Indexing", value: page.meta.noindex ? "noindex: search engines are asked not to index this page" : "indexable" },
      { label: "Canonical URL", value: url },
      { label: "Structured data", value: `${rendered.structuredData.length} JSON-LD item(s)` },
    ];
    return (
      <div className="grid h-full content-start gap-4 overflow-auto p-4">
        <div className="max-w-xl rounded-lg border border-line bg-card p-4" aria-label="Search result preview">
          <p className="text-xs text-muted">{url}</p>
          <p className="mt-1 text-lg text-accent">{title.length > 60 ? `${title.slice(0, 59)}…` : title}</p>
          <p className="mt-1 text-sm text-muted">{description ? (description.length > 160 ? `${description.slice(0, 159)}…` : description) : "No description: search engines will pick text from the page."}</p>
        </div>
        <dl className="grid max-w-xl gap-2 text-sm">
          {checks.map((check) => (
            <div key={check.label} className="grid grid-cols-[8rem_1fr] gap-2">
              <dt className="text-muted">{check.label}</dt>
              <dd className="break-words">{check.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    );
  }

  // Social card: the shape link unfurlers build from the page title, description and URL.
  return (
    <div className="grid h-full content-start gap-3 overflow-auto p-4">
      <div className="max-w-md overflow-hidden rounded-xl border border-line bg-card" aria-label="Social card preview">
        <div className="spectrum-rule h-24" aria-hidden="true" />
        <div className="p-3">
          <p className="text-xs uppercase text-faint">{host}</p>
          <p className="mt-1 font-medium">{title}</p>
          <p className="mt-1 text-sm text-muted">{description || "No description set."}</p>
        </div>
      </div>
      <p className="max-w-md text-xs text-muted">
        Cards use the page title and description. Pages do not store a share image yet, so platforms show a text-only card.
      </p>
    </div>
  );
}
