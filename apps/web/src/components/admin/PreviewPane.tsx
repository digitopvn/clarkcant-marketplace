import { useEffect, useMemo, useRef } from "react";

import { isCanvasMessage, type PageDocument, type PreviewMode, type RenderedDocument } from "./builder-types";
import { canvasDocument } from "./canvas-document";

const WIDTHS: Partial<Record<PreviewMode, string>> = { desktop: "100%", tablet: "768px", mobile: "375px" };

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
        {rendered.socialImage ? (
          <img src={rendered.socialImage.url} alt="" className="aspect-[1200/630] w-full object-cover" />
        ) : (
          <img src="/og-default.png" alt="" className="aspect-[1200/630] w-full object-cover" />
        )}
        <div className="p-3">
          <p className="text-xs uppercase text-faint">{host}</p>
          <p className="mt-1 font-medium">{title}</p>
          <p className="mt-1 text-sm text-muted">{description || "No description set."}</p>
        </div>
      </div>
      <p className="max-w-md text-xs text-muted">
        Cards use the page title, description and share image. {rendered.socialImage ? "This page uses its own share image." : "No share image is set (Page & SEO tab), so the site default card is used."}
      </p>
    </div>
  );
}
