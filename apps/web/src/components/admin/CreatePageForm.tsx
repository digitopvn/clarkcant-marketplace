import { useState, type SubmitEvent } from "react";

import { AdminApiError, adminRequest, describeError } from "./admin-api";

const KINDS = [
  { value: "custom", label: "Custom / editorial" },
  { value: "landing", label: "Landing" },
  { value: "legal", label: "Legal" },
  { value: "docs", label: "Docs" },
  { value: "category", label: "Category" },
  { value: "collection", label: "Collection" },
] as const;

const fieldClass =
  "w-full rounded-xl border border-line bg-card px-3 py-2 text-ink placeholder:text-faint focus:border-accent focus:outline-none";

/** Creates a page (first draft revision) and opens it in the builder. */
export default function CreatePageForm() {
  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<(typeof KINDS)[number]["value"]>("custom");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const state = await adminRequest<{ page: { id: string } }>("/admin/pages", {
        method: "POST",
        body: { slug: slug.trim(), kind, ...(title.trim() ? { title: title.trim() } : {}) },
      });
      window.location.assign(`/admin/pages/${encodeURIComponent(state.page.id)}`);
    } catch (caught) {
      const detail = caught instanceof AdminApiError && caught.issues[0] ? ` (${caught.issues[0].message})` : "";
      setError(`${describeError(caught)}${detail}`);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end" aria-label="Create a page">
      <label className="grid gap-1 text-sm">
        <span className="text-muted">Slug</span>
        <input
          className={fieldClass}
          value={slug}
          onChange={(event) => setSlug(event.target.value)}
          placeholder="about or docs/install"
          pattern="[a-z0-9]+(?:-[a-z0-9]+)*(?:/[a-z0-9]+(?:-[a-z0-9]+)*)*"
          title="Lowercase letters, digits, hyphens; use / for nested pages. Use home for the landing page."
          required
          maxLength={160}
        />
      </label>
      <label className="grid gap-1 text-sm">
        <span className="text-muted">Title (optional)</span>
        <input className={fieldClass} value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} />
      </label>
      <label className="grid gap-1 text-sm">
        <span className="text-muted">Kind</span>
        <select className={fieldClass} value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
          {KINDS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <button
        type="submit"
        disabled={busy}
        className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-on-accent hover:opacity-90 disabled:opacity-50"
      >
        {busy ? "Creating…" : "Create page"}
      </button>
      {error && (
        <p role="alert" className="text-sm text-warning sm:col-span-4">
          {error}
        </p>
      )}
    </form>
  );
}
