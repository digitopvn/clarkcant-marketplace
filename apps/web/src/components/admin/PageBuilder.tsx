import {
  PageOperationError,
  applyPageOperations,
  findBlock,
  type OperationContext,
  type OperationResult,
  type PageOperationInput,
} from "@marketplace/page-engine/operations";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { AdminApiError, adminRequest, describeError, formatDateTime, type ApiIssue } from "./admin-api";
import { BlockInspector } from "./BlockInspector";
import {
  PREVIEW_MODES,
  type BlockNode,
  type PageBuilderProps,
  type PageDocument,
  type PageRevisionSummary,
  type PageState,
  type PreviewMode,
  type RenderedDocument,
} from "./builder-types";
import { PreviewPane } from "./PreviewPane";

type Pane = "blocks" | "canvas" | "inspector";
type InspectorTab = "block" | "page" | "revisions";
type Busy = null | "save" | "publish" | "rollback" | "preview" | "reload" | "restore";
interface Notice {
  tone: "error" | "success" | "info";
  text: string;
  conflict?: boolean;
  href?: string;
}

const button =
  "rounded-full px-3.5 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-focus";
const primary = `${button} bg-accent text-on-accent hover:opacity-90`;
const secondary = `${button} border border-line-strong bg-card text-ink hover:bg-accent-soft`;
const chip = "rounded-full border border-line px-2 py-0.5 text-xs text-muted hover:border-accent hover:text-ink disabled:opacity-40";
const inputClass =
  "w-full rounded-lg border border-line bg-card px-2.5 py-1.5 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none";

function pagePath(slug: string): string {
  return slug === "home" ? "/" : `/${slug}`;
}

function newBlockId(): string {
  return `blk_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

/**
 * The page builder: palette and outline | canvas (the public renderer in a sandboxed iframe) | inspector generated
 * from block field declarations. Edits run through the same pure operations the API applies, locally and instantly;
 * "Save draft" stores the document as a new immutable revision guarded by `If-Match`.
 */
export default function PageBuilder({ initialState, initialRevisions, blocks, layouts, siteUrl, canvasCss }: PageBuilderProps) {
  const descriptions = useMemo(() => new Map(blocks.map((block) => [block.type, block])), [blocks]);
  const [state, setState] = useState<PageState>(initialState);
  const [revisions, setRevisions] = useState<PageRevisionSummary[]>(initialRevisions);
  const [doc, setDoc] = useState<PageDocument>(initialState.draft.document);
  const [dirty, setDirty] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rendered, setRendered] = useState<RenderedDocument | null>(null);
  const [issues, setIssues] = useState<ApiIssue[]>([]);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [mode, setMode] = useState<PreviewMode>("desktop");
  const [pane, setPane] = useState<Pane>("canvas");
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("block");
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [previewLink, setPreviewLink] = useState<{ url: string; expiresAt: string } | null>(null);
  // Counts local edits so a save that completes while the user keeps typing does not discard the newer edits.
  const editSeq = useRef(0);

  const pageId = state.page.id;
  const layout = layouts.find((candidate) => candidate.id === doc.layout.id && candidate.version === doc.layout.version);
  const topLevelTypes = useMemo(() => new Set(layout?.regions.flatMap((region) => region.allowedBlocks) ?? []), [layout]);
  const liveUrl = `${siteUrl}${pagePath(state.page.slug)}`;
  const markdownUrl = `/api/v1/pages/${encodeURIComponent(state.page.slug)}?format=md`;

  const opContext: OperationContext = useMemo(
    () => ({
      newId: newBlockId,
      blockDefaults: (type, version) => {
        const description = descriptions.get(type);
        if (!description || (version !== undefined && version !== description.version)) return undefined;
        return { version: description.version, props: structuredClone(description.defaultProps) };
      },
    }),
    [descriptions],
  );

  const changeDocument = useCallback((next: PageDocument) => {
    editSeq.current += 1;
    setDoc(next);
    setDirty(true);
  }, []);

  const apply = (operations: PageOperationInput[]): OperationResult[] | null => {
    try {
      const { document, results } = applyPageOperations(doc, operations, opContext);
      changeDocument(document);
      return results;
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof PageOperationError ? error.message : describeError(error) });
      return null;
    }
  };

  // Re-render through the server's renderer (same code as the public page) shortly after each edit.
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      adminRequest<RenderedDocument>("/admin/pages/render", {
        method: "POST",
        body: { document: doc, slug: state.page.slug },
        signal: controller.signal,
      })
        .then((result) => {
          setRendered(result);
          setIssues([]);
          setRenderError(null);
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          if (error instanceof AdminApiError && error.code === "validation_failed") {
            setIssues(error.issues.length > 0 ? error.issues : [{ message: error.message }]);
            setRenderError(null);
          } else {
            setRenderError(describeError(error));
          }
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [doc, state.page.slug]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const refreshRevisions = async () => {
    const list = await adminRequest<{ items: PageRevisionSummary[] }>(`/admin/pages/${encodeURIComponent(pageId)}/revisions`);
    setRevisions(list.items);
  };

  const fail = (error: unknown) => {
    if (error instanceof AdminApiError && error.code === "validation_failed" && error.issues.length > 0) setIssues(error.issues);
    setNotice({ tone: "error", text: describeError(error), conflict: error instanceof AdminApiError && error.code === "conflict" });
  };

  const run = async (kind: Exclude<Busy, null>, task: () => Promise<void>) => {
    setBusy(kind);
    setNotice(null);
    try {
      await task();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(null);
    }
  };

  const adopt = (next: PageState, seqAtStart: number) => {
    setState(next);
    // Keep edits made while the request was in flight; they still need saving.
    if (editSeq.current === seqAtStart) {
      setDoc(next.draft.document);
      setDirty(false);
    }
  };

  const save = () =>
    run("save", async () => {
      const seq = editSeq.current;
      const next = await adminRequest<PageState>(`/admin/pages/${encodeURIComponent(pageId)}/draft`, {
        method: "PUT",
        ifMatch: state.draft.revision.id,
        body: { document: doc },
      });
      adopt(next, seq);
      setPreviewLink(null);
      setNotice({ tone: "success", text: `Saved as revision ${next.draft.revision.number}.` });
      await refreshRevisions();
    });

  const reload = () =>
    run("reload", async () => {
      const next = await adminRequest<PageState>(`/admin/pages/${encodeURIComponent(pageId)}`);
      editSeq.current += 1;
      setState(next);
      setDoc(next.draft.document);
      setDirty(false);
      setSelectedId(null);
      await refreshRevisions();
      setNotice({ tone: "info", text: `Loaded revision ${next.draft.revision.number}, the latest draft.` });
    });

  const publish = () =>
    run("publish", async () => {
      const next = await adminRequest<PageState>(`/admin/pages/${encodeURIComponent(pageId)}/publish`, {
        method: "POST",
        ifMatch: state.draft.revision.id,
        body: {},
      });
      setState(next);
      await refreshRevisions();
      setNotice({ tone: "success", text: `Published revision ${next.draft.revision.number}.`, href: pagePath(next.page.slug) });
    });

  const rollback = (revision: PageRevisionSummary) => {
    if (!window.confirm(`Make revision ${revision.number} the live version of ${pagePath(state.page.slug)}?`)) return;
    void run("rollback", async () => {
      const next = await adminRequest<PageState>(`/admin/pages/${encodeURIComponent(pageId)}/rollback`, {
        method: "POST",
        ifMatch: state.page.publishedRevisionId,
        body: { revisionId: revision.id },
      });
      setState(next);
      await refreshRevisions();
      setNotice({ tone: "success", text: `Revision ${revision.number} is live again.`, href: pagePath(next.page.slug) });
    });
  };

  const restore = (revision: PageRevisionSummary) =>
    run("restore", async () => {
      const detail = await adminRequest<{ document: PageDocument }>(
        `/admin/pages/${encodeURIComponent(pageId)}/revisions/${encodeURIComponent(revision.id)}`,
      );
      changeDocument(detail.document);
      setSelectedId(null);
      setNotice({ tone: "info", text: `Loaded revision ${revision.number} into the editor. Save the draft to keep it.` });
    });

  const createPreview = () =>
    run("preview", async () => {
      const link = await adminRequest<{ url: string; expiresAt: string }>(`/admin/pages/${encodeURIComponent(pageId)}/preview`, {
        method: "POST",
        body: {},
      });
      setPreviewLink(link);
    });

  // Selection, outline and palette.
  const selected = selectedId ? findBlock(doc.blocks, selectedId) : null;
  const selectedDescription = selected ? descriptions.get(selected.node.type) : undefined;
  const selectBlock = useCallback((id: string) => {
    setSelectedId(id);
    setInspectorTab("block");
  }, []);

  const addBlock = (type: string) => {
    const acceptsChild = selected && selectedDescription?.allowedChildren.includes(type);
    const placement = acceptsChild
      ? { parentId: selected.node.id }
      : selected && selected.parent === null
        ? { parentId: null, afterId: selected.node.id }
        : { parentId: null };
    const results = apply([{ op: "add_block", block: { type }, ...placement }]);
    const id = results?.[0]?.blockId;
    if (id) {
      selectBlock(id);
      setNotice({ tone: "info", text: `Added ${descriptions.get(type)?.label ?? type}.` });
    }
  };

  const moveBlock = (node: BlockNode, direction: -1 | 1) => {
    const located = findBlock(doc.blocks, node.id);
    if (!located) return;
    const sibling = located.list[located.index + direction];
    if (!sibling) return;
    apply([{ op: "move_block", blockId: node.id, ...(direction === -1 ? { beforeId: sibling.id } : { afterId: sibling.id }) }]);
  };

  const removeBlock = (node: BlockNode) => {
    if (apply([{ op: "remove_block", blockId: node.id }]) && selectedId === node.id) setSelectedId(null);
  };

  const onOutlineKey = (event: KeyboardEvent, node: BlockNode) => {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    moveBlock(node, event.key === "ArrowUp" ? -1 : 1);
  };

  const paletteBlocks = blocks.filter(
    (block) => topLevelTypes.has(block.type) || (selectedDescription?.allowedChildren.includes(block.type) ?? false),
  );
  const diagnostics = rendered?.diagnostics ?? [];
  const blockProblems = (id: string) => [
    ...issues.filter((issue) => issue.blockId === id).map((issue) => issue.message),
    ...diagnostics.filter((line) => line.includes(`"${id}"`)),
  ];
  const isLive = state.page.publishedRevisionId === state.draft.revision.id;
  const canPublish = !dirty && !isLive && issues.length === 0 && rendered !== null && diagnostics.length === 0 && busy === null;
  const publishHint = dirty
    ? "Save the draft before publishing."
    : isLive
      ? "This draft is already live."
      : issues.length > 0 || diagnostics.length > 0
        ? "Fix the problems listed before publishing."
        : null;

  const renderOutline = (nodes: BlockNode[], depth: number) => (
    <ul className={depth > 0 ? "ml-3 border-l border-line pl-2" : ""} role={depth === 0 ? "tree" : "group"} aria-label={depth === 0 ? "Page blocks" : undefined}>
      {nodes.map((node, index) => {
        const label = descriptions.get(node.type)?.label ?? node.type;
        const problems = blockProblems(node.id).length;
        return (
          <li key={node.id} role="treeitem" aria-selected={selectedId === node.id} aria-level={depth + 1} className="py-0.5">
            <div className={`flex items-center gap-1 rounded-lg px-1 ${selectedId === node.id ? "bg-accent-soft" : ""}`}>
              <button
                type="button"
                className="min-w-0 flex-1 truncate py-1 text-left text-sm"
                onClick={() => selectBlock(node.id)}
                onKeyDown={(event) => onOutlineKey(event, node)}
                aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                title="Alt+Up / Alt+Down to move"
              >
                {label}
                {problems > 0 && <span className="ml-1 text-xs text-warning">({problems} problem{problems === 1 ? "" : "s"})</span>}
              </button>
              <button type="button" className={chip} disabled={index === 0} onClick={() => moveBlock(node, -1)} aria-label={`Move ${label} up`}>
                ↑
              </button>
              <button type="button" className={chip} disabled={index === nodes.length - 1} onClick={() => moveBlock(node, 1)} aria-label={`Move ${label} down`}>
                ↓
              </button>
              <button type="button" className={chip} onClick={() => removeBlock(node)} aria-label={`Remove ${label}`}>
                ×
              </button>
            </div>
            {node.children && node.children.length > 0 && renderOutline(node.children, depth + 1)}
          </li>
        );
      })}
    </ul>
  );

  const paneClass = (id: Pane) => `${pane === id ? "flex" : "hidden"} min-h-0 flex-col lg:flex`;
  const tabButton = (active: boolean) =>
    `rounded-full px-3 py-1 text-sm ${active ? "bg-accent text-on-accent" : "text-muted hover:bg-accent-soft hover:text-ink"}`;

  return (
    <div className="flex min-h-[calc(100vh-8rem)] flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted">
            <a href="/admin/pages" className="underline-offset-4 hover:underline">
              Pages
            </a>{" "}
            / <span className="font-mono">{pagePath(state.page.slug)}</span>
          </p>
          <h1 className="truncate font-display text-2xl">{doc.meta.title}</h1>
          <p className="text-xs text-muted" aria-live="polite">
            Draft revision {state.draft.revision.number}
            {dirty ? " · unsaved changes" : ""} ·{" "}
            {state.published ? (
              <>
                live revision {state.published.number}{" "}
                <a className="text-accent underline" href={pagePath(state.page.slug)} target="_blank" rel="noopener">
                  view
                </a>
              </>
            ) : (
              "not published"
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={secondary} onClick={() => void createPreview()} disabled={busy !== null || dirty} title={dirty ? "Save first: previews show saved revisions" : undefined}>
            {busy === "preview" ? "Creating…" : "Preview link"}
          </button>
          <button type="button" className={secondary} onClick={() => void save()} disabled={!dirty || busy !== null}>
            {busy === "save" ? "Saving…" : "Save draft"}
          </button>
          <button type="button" className={primary} onClick={() => void publish()} disabled={!canPublish} title={publishHint ?? undefined}>
            {busy === "publish" ? "Publishing…" : "Publish"}
          </button>
        </div>
      </header>

      <div aria-live="polite" className="px-4">
        {notice && (
          <p role={notice.tone === "error" ? "alert" : "status"} className={`mt-2 text-sm ${notice.tone === "error" ? "text-warning" : notice.tone === "success" ? "text-success" : "text-muted"}`}>
            {notice.text}{" "}
            {notice.href && (
              <a className="text-accent underline" href={notice.href} target="_blank" rel="noopener">
                Open live page
              </a>
            )}
            {notice.conflict && (
              <button type="button" className={`${chip} ml-2`} onClick={() => void reload()}>
                Reload latest (discards local changes)
              </button>
            )}
          </p>
        )}
        {previewLink && (
          <p className="mt-2 text-sm">
            Preview link (expires {formatDateTime(previewLink.expiresAt)}):{" "}
            <a className="break-all font-mono text-accent underline" href={previewLink.url} target="_blank" rel="noopener noreferrer">
              {previewLink.url}
            </a>
          </p>
        )}
        {publishHint && !dirty && !isLive && <p className="mt-1 text-xs text-muted">{publishHint}</p>}
      </div>

      <div role="tablist" aria-label="Builder panes" className="flex gap-1 border-b border-line px-4 py-2 lg:hidden">
        {(["blocks", "canvas", "inspector"] as const).map((id) => (
          <button key={id} type="button" role="tab" aria-selected={pane === id} aria-controls={`pane-${id}`} className={tabButton(pane === id)} onClick={() => setPane(id)}>
            {id === "blocks" ? "Blocks" : id === "canvas" ? "Canvas" : "Inspector"}
          </button>
        ))}
      </div>

      <div className="grid min-h-0 flex-1 lg:grid-cols-[17rem_minmax(0,1fr)_21rem]">
        <aside id="pane-blocks" aria-label="Blocks" className={`${paneClass("blocks")} gap-4 overflow-auto border-line p-4 lg:border-r`}>
          <section aria-labelledby="palette-heading">
            <h2 id="palette-heading" className="text-xs font-medium uppercase tracking-widest text-faint">
              Add a block
            </h2>
            <p className="mt-1 text-xs text-muted">
              {selected ? `Adds after or inside “${selectedDescription?.label ?? selected.node.type}”.` : "Adds at the end of the page."}
            </p>
            <ul className="mt-2 grid gap-1">
              {paletteBlocks.map((block) => (
                <li key={block.type}>
                  <button
                    type="button"
                    className="w-full rounded-lg border border-line px-2.5 py-1.5 text-left text-sm hover:border-accent"
                    onClick={() => addBlock(block.type)}
                    title={block.description}
                  >
                    {block.label}
                    {selectedDescription?.allowedChildren.includes(block.type) && <span className="ml-1 text-xs text-muted">(inside)</span>}
                  </button>
                </li>
              ))}
            </ul>
          </section>
          <section aria-labelledby="outline-heading">
            <h2 id="outline-heading" className="text-xs font-medium uppercase tracking-widest text-faint">
              Outline
            </h2>
            {doc.blocks.length === 0 ? <p className="mt-1 text-sm text-muted">No blocks yet.</p> : <div className="mt-1">{renderOutline(doc.blocks, 0)}</div>}
          </section>
        </aside>

        <section id="pane-canvas" aria-label="Canvas" className={`${paneClass("canvas")} min-w-0`}>
          <div className="flex flex-wrap gap-1 border-b border-line px-3 py-2" role="group" aria-label="Preview mode">
            {PREVIEW_MODES.map((option) => (
              <button key={option.id} type="button" aria-pressed={mode === option.id} className={tabButton(mode === option.id)} onClick={() => setMode(option.id)}>
                {option.label}
              </button>
            ))}
          </div>
          {(issues.length > 0 || diagnostics.length > 0 || renderError) && (
            <div className="border-b border-line px-3 py-2 text-xs text-warning" role="status">
              {renderError && <p>Preview unavailable: {renderError}</p>}
              {issues.length > 0 && (
                <ul aria-label="Validation problems" className="list-disc pl-4">
                  {issues.map((issue, index) => (
                    <li key={index}>
                      {issue.blockId ? (
                        <button type="button" className="underline" onClick={() => issue.blockId && selectBlock(issue.blockId)}>
                          {issue.message}
                        </button>
                      ) : (
                        `${issue.path?.length ? `${issue.path.join(".")}: ` : ""}${issue.message}`
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {diagnostics.length > 0 && (
                <ul aria-label="Render problems" className="list-disc pl-4">
                  {diagnostics.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <div className="min-h-0 flex-1">
            <PreviewPane
              mode={mode}
              rendered={rendered}
              document={doc}
              url={liveUrl}
              markdownUrl={markdownUrl}
              canvasCss={canvasCss}
              selectedId={selectedId}
              onSelect={selectBlock}
            />
          </div>
        </section>

        <aside id="pane-inspector" aria-label="Inspector" className={`${paneClass("inspector")} overflow-auto border-line p-4 lg:border-l`}>
          <div className="mb-3 flex gap-1" role="tablist" aria-label="Inspector sections">
            {(["block", "page", "revisions"] as const).map((id) => (
              <button key={id} type="button" role="tab" aria-selected={inspectorTab === id} className={tabButton(inspectorTab === id)} onClick={() => setInspectorTab(id)}>
                {id === "block" ? "Block" : id === "page" ? "Page & SEO" : "Revisions"}
              </button>
            ))}
          </div>

          {inspectorTab === "block" &&
            (selected ? (
              <BlockInspector
                key={selected.node.id}
                node={selected.node}
                description={selectedDescription}
                issues={blockProblems(selected.node.id)}
                onChange={(props) => apply([{ op: "update_block", blockId: selected.node.id, props, mode: "replace" }])}
              />
            ) : (
              <p className="text-sm text-muted">Select a block in the outline or the canvas to edit it.</p>
            ))}

          {inspectorTab === "page" && (
            <div className="grid gap-3">
              <label className="grid gap-1 text-xs font-medium text-muted">
                Layout
                <select
                  className={inputClass}
                  value={`${doc.layout.id}@${doc.layout.version}`}
                  onChange={(event) => {
                    const [id = "", version = "1"] = event.target.value.split("@");
                    apply([{ op: "set_layout", layout: { id, version: Number(version) } }]);
                  }}
                >
                  {layouts.map((option) => (
                    <option key={`${option.id}@${option.version}`} value={`${option.id}@${option.version}`}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              {layout && <p className="text-xs text-faint">{layout.description}</p>}
              <label className="grid gap-1 text-xs font-medium text-muted">
                Title
                <input
                  className={inputClass}
                  value={doc.meta.title}
                  maxLength={200}
                  onChange={(event) => changeDocument({ ...doc, meta: { ...doc.meta, title: event.target.value } })}
                />
              </label>
              <label className="grid gap-1 text-xs font-medium text-muted">
                Description
                <textarea
                  className={`${inputClass} min-h-24`}
                  value={doc.meta.description}
                  maxLength={500}
                  onChange={(event) => changeDocument({ ...doc, meta: { ...doc.meta, description: event.target.value } })}
                />
                <span className="font-normal text-faint">{doc.meta.description.length}/160 recommended</span>
              </label>
              <label className="grid gap-1 text-xs font-medium text-muted">
                Language (BCP 47)
                <input
                  className={inputClass}
                  value={doc.meta.locale}
                  maxLength={35}
                  onChange={(event) => changeDocument({ ...doc, meta: { ...doc.meta, locale: event.target.value } })}
                />
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={doc.meta.noindex} onChange={(event) => changeDocument({ ...doc, meta: { ...doc.meta, noindex: event.target.checked } })} />
                Ask search engines not to index this page
              </label>
              <p className="text-xs text-faint">
                Canonical URL: <span className="font-mono">{liveUrl}</span>
              </p>
            </div>
          )}

          {inspectorTab === "revisions" && (
            <ol className="grid gap-2" aria-label="Revisions, newest first">
              {revisions.map((revision) => {
                const canRollback = revision.lastPublishedAt !== null && !revision.isPublished && state.page.publishedRevisionId !== null;
                return (
                  <li key={revision.id} className="rounded-lg border border-line p-2.5 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">Revision {revision.number}</span>
                      {revision.isDraft && <span className="rounded-full bg-accent-soft px-2 text-xs">draft</span>}
                      {revision.isPublished && <span className="rounded-full bg-accent px-2 text-xs text-on-accent">live</span>}
                    </div>
                    <p className="text-xs text-muted">
                      Saved {formatDateTime(revision.createdAt)}
                      {revision.lastPublishedAt ? ` · last live ${formatDateTime(revision.lastPublishedAt)}` : ""}
                    </p>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {!revision.isDraft && (
                        <button type="button" className={chip} disabled={busy !== null} onClick={() => void restore(revision)}>
                          Load into editor
                        </button>
                      )}
                      {canRollback && (
                        <button type="button" className={chip} disabled={busy !== null} onClick={() => rollback(revision)}>
                          Roll back to this
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </aside>
      </div>
    </div>
  );
}
