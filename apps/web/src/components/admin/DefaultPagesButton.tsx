import { useState } from "react";

import { adminRequest, describeError } from "./admin-api";

/** Creates and publishes the missing default pages (landing and about) through the page commands. */
export default function DefaultPagesButton({ missing }: { missing: string[] }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      await adminRequest<{ created: string[] }>("/admin/pages/defaults", { method: "POST" });
      window.location.reload();
    } catch (caught) {
      setError(describeError(caught));
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 rounded-card border border-dashed border-line p-4 text-sm">
      <p className="text-muted">
        Default pages not created yet: <span className="font-mono">{missing.join(", ")}</span>. They are published as
        ordinary pages you can edit here.
      </p>
      <button
        type="button"
        onClick={() => void create()}
        disabled={busy}
        className="mt-2 rounded-full border border-line-strong bg-card px-4 py-1.5 font-medium text-ink hover:bg-accent-soft disabled:opacity-50"
      >
        {busy ? "Creating…" : "Create and publish default pages"}
      </button>
      {error && (
        <p role="alert" className="mt-2 text-warning">
          {error}
        </p>
      )}
    </div>
  );
}
