import type { ApiScope, ApiToken, CreatedApiToken } from "@marketplace/contracts";
import { useCallback, useEffect, useState, type SubmitEvent } from "react";

import { describeError, requestJson } from "./request";
import { Button, Card, Notice, formatDate, inputClass } from "./ui";

/** Personal API tokens (`cmk_…`) for the CLI, MCP clients and scripts. The plaintext is shown exactly once. */
export default function TokensSection({ availableScopes }: { availableScopes: readonly ApiScope[] }) {
  const [tokens, setTokens] = useState<ApiToken[] | null>(null);
  const [created, setCreated] = useState<CreatedApiToken | null>(null);
  const [selected, setSelected] = useState<ApiScope[]>(["account:read"]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const load = useCallback(async () => {
    try {
      setTokens((await requestJson<{ items: ApiToken[] }>("/api/v1/me/tokens")).items);
    } catch (caught) {
      setError(describeError(caught));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onCreate(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setPending(true);
    setError(null);
    try {
      const token = await requestJson<CreatedApiToken>("/api/v1/me/tokens", {
        method: "POST",
        body: { name: String(form.get("name") ?? "").trim(), scopes: selected, expiresInDays: Number(form.get("expiresInDays") ?? 90) },
      });
      setCreated(token);
      formElement.reset();
      await load();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setPending(false);
    }
  }

  async function revoke(id: string) {
    setError(null);
    try {
      await requestJson(`/api/v1/me/tokens/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (created?.id === id) setCreated(null);
      await load();
    } catch (caught) {
      setError(describeError(caught));
    }
  }

  function toggle(scope: ApiScope) {
    setSelected((current) => (current.includes(scope) ? current.filter((value) => value !== scope) : [...current, scope]));
  }

  const active = tokens?.filter((token) => token.revokedAt === null) ?? [];

  return (
    <Card
      title="API tokens"
      description="Use a token as `Authorization: Bearer cmk_…` from the CLI, MCP clients or scripts. Tokens only carry the scopes you pick."
    >
      {created && (
        <div className="mb-4 rounded-xl border border-accent bg-accent-soft p-4 text-sm">
          <p className="font-medium">Copy “{created.name}” now — it will not be shown again.</p>
          <code className="mt-2 block break-all rounded-lg bg-card p-2 font-mono text-xs">{created.token}</code>
          <div className="mt-2 flex gap-2">
            <Button tone="secondary" onClick={() => void navigator.clipboard.writeText(created.token)}>
              Copy
            </Button>
            <Button tone="secondary" onClick={() => setCreated(null)}>
              Done
            </Button>
          </div>
        </div>
      )}

      <form onSubmit={(event) => void onCreate(event)} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
          <label className="block text-sm">
            <span className="mb-1 block text-muted">Name</span>
            <input name="name" required maxLength={80} placeholder="e.g. laptop CLI" className={inputClass} />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-muted">Expires in (days)</span>
            <input name="expiresInDays" type="number" min={1} max={365} defaultValue={90} required className={inputClass} />
          </label>
        </div>
        <fieldset className="text-sm">
          <legend className="mb-1 text-muted">Scopes</legend>
          <div className="flex flex-wrap gap-2">
            {availableScopes.map((scope) => (
              <label key={scope} className="flex items-center gap-1.5 rounded-full border border-line px-3 py-1">
                <input type="checkbox" checked={selected.includes(scope)} onChange={() => toggle(scope)} />
                <span className="font-mono text-xs">{scope}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <Button type="submit" disabled={pending || selected.length === 0}>
          {pending ? "Creating…" : "Create token"}
        </Button>
      </form>

      {tokens === null ? (
        <Notice tone="info">Loading tokens…</Notice>
      ) : active.length === 0 ? (
        <Notice tone="info">No active tokens.</Notice>
      ) : (
        <ul className="mt-4 divide-y divide-line text-sm">
          {active.map((token) => (
            <li key={token.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
              <div>
                <p className="font-medium">{token.name}</p>
                <p className="font-mono text-xs text-muted">{token.scopes.join(" ")}</p>
                <p className="text-xs text-faint">
                  Created {formatDate(token.createdAt)} · Last used {formatDate(token.lastUsedAt)} · Expires {formatDate(token.expiresAt)}
                </p>
              </div>
              <Button tone="danger" onClick={() => void revoke(token.id)}>
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </Card>
  );
}
