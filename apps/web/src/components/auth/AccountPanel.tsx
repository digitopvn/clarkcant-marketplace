import { createMarketplaceAuthClient } from "@marketplace/auth/client";
import type { AccountProfile, DeviceLink } from "@marketplace/contracts";
import { useCallback, useEffect, useMemo, useState, type SubmitEvent, type ReactNode } from "react";

import PublishersSection from "./PublishersSection";
import { describeError, requestJson } from "./request";
import TokensSection from "./TokensSection";
import { Button, Card, Notice, formatDate, inputClass } from "./ui";

type AuthClient = ReturnType<typeof createMarketplaceAuthClient>;

interface PasskeyRow {
  id: string;
  name?: string | null | undefined;
  deviceType: string;
  createdAt?: Date | string | null | undefined;
}

interface OAuthGrant {
  clientId: string;
  clientName: string | null;
  scopes: string[];
  grantedAt: string;
}

function PasskeysSection({ client }: { client: AuthClient }) {
  const [passkeys, setPasskeys] = useState<PasskeyRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const load = useCallback(async () => {
    const result = await client.passkey.listUserPasskeys();
    if (result.error) setError(result.error.message ?? "Could not load passkeys.");
    else setPasskeys((result.data ?? []) as PasskeyRow[]);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(action: () => Promise<{ error: { message?: string | undefined } | null } | undefined>) {
    setPending(true);
    setError(null);
    try {
      const result = await action();
      if (result?.error) setError(result.error.message ?? "The passkey request was rejected.");
      await load();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setPending(false);
    }
  }

  function onAdd(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("name") ?? "").trim();
    void act(() => client.passkey.addPasskey(name === "" ? {} : { name }));
  }

  return (
    <Card title="Passkeys" description="Sign in with your device's biometrics or security key instead of a password.">
      {passkeys === null ? (
        <Notice tone="info">Loading passkeys…</Notice>
      ) : passkeys.length === 0 ? (
        <Notice tone="info">No passkeys yet.</Notice>
      ) : (
        <ul className="divide-y divide-line text-sm">
          {passkeys.map((passkey) => (
            <li key={passkey.id} className="flex items-center justify-between py-2">
              <span>
                {passkey.name || "Unnamed passkey"} <span className="text-xs text-faint">({passkey.deviceType})</span>
              </span>
              <Button tone="danger" disabled={pending} onClick={() => void act(() => client.passkey.deletePasskey({ id: passkey.id }))}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={onAdd} className="mt-3 flex gap-2">
        <input name="name" maxLength={80} placeholder="Passkey name (optional)" className={`${inputClass} max-w-xs`} />
        <Button type="submit" disabled={pending}>
          Add passkey
        </Button>
      </form>
      {error && <Notice tone="error">{error}</Notice>}
    </Card>
  );
}

/** A generic list-with-remove card for linked devices and OAuth grants. */
function RevocableList<T>({
  title,
  description,
  path,
  empty,
  keyOf,
  render,
  removePath,
  removeLabel,
}: {
  title: string;
  description: string;
  path: string;
  empty: string;
  keyOf: (item: T) => string;
  render: (item: T) => ReactNode;
  removePath: (item: T) => string;
  removeLabel: string;
}) {
  const [items, setItems] = useState<T[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems((await requestJson<{ items: T[] }>(path)).items);
    } catch (caught) {
      setError(describeError(caught));
    }
  }, [path]);

  useEffect(() => {
    void load();
  }, [load]);

  async function remove(item: T) {
    setError(null);
    try {
      await requestJson(removePath(item), { method: "DELETE" });
      await load();
    } catch (caught) {
      setError(describeError(caught));
    }
  }

  return (
    <Card title={title} description={description}>
      {items === null ? (
        <Notice tone="info">Loading…</Notice>
      ) : items.length === 0 ? (
        <Notice tone="info">{empty}</Notice>
      ) : (
        <ul className="divide-y divide-line text-sm">
          {items.map((item) => (
            <li key={keyOf(item)} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div>{render(item)}</div>
              <Button tone="danger" onClick={() => void remove(item)}>
                {removeLabel}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </Card>
  );
}

function DangerZone({ client }: { client: AuthClient }) {
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function deleteAccount() {
    setPending(true);
    setError(null);
    try {
      await requestJson("/api/v1/me", { method: "DELETE", body: { confirm } });
      window.location.assign("/");
    } catch (caught) {
      setError(describeError(caught));
      setPending(false);
    }
  }

  return (
    <Card title="Your data" description="Download everything the marketplace stores about you, or delete your account.">
      <div className="flex flex-wrap gap-2">
        <a href="/api/v1/me/export" className="rounded-full border border-line-strong bg-card px-4 py-2 text-sm font-medium text-ink no-underline hover:bg-accent-soft">
          Export my data (JSON)
        </a>
        <Button tone="secondary" onClick={() => void client.signOut().then(() => window.location.assign("/"))}>
          Sign out
        </Button>
      </div>
      <div className="mt-5 rounded-xl border border-line-strong p-4">
        <p className="text-sm">
          Deleting your account revokes all tokens, OAuth grants and device links, removes publishers where you are the only member and
          deletes media you uploaded. This cannot be undone.
        </p>
        <label className="mt-3 block text-sm">
          <span className="mb-1 block text-muted">Type DELETE to confirm</span>
          <input value={confirm} onChange={(event) => setConfirm(event.target.value)} className={`${inputClass} max-w-xs`} />
        </label>
        <Button tone="danger" className="mt-3" disabled={pending || confirm !== "DELETE"} onClick={() => void deleteAccount()}>
          {pending ? "Deleting…" : "Delete my account"}
        </Button>
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    </Card>
  );
}

export default function AccountPanel() {
  const client = useMemo(() => createMarketplaceAuthClient(), []);
  const [profile, setProfile] = useState<AccountProfile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    requestJson<AccountProfile>("/api/v1/me")
      .then(setProfile)
      .catch((caught: unknown) => setError(describeError(caught)));
  }, []);

  if (error) return <Notice tone="error">{error}</Notice>;
  if (!profile) return <Notice tone="info">Loading your account…</Notice>;

  return (
    <div className="space-y-6">
      <Card title="Profile">
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
          <dt className="text-muted">Name</dt>
          <dd>{profile.name}</dd>
          <dt className="text-muted">Email</dt>
          <dd>
            {profile.email} {profile.emailVerified ? <span className="text-success">verified</span> : <span className="text-faint">unverified</span>}
          </dd>
          <dt className="text-muted">Role</dt>
          <dd>{profile.role === "admin" ? "Marketplace admin" : "Member"}</dd>
          <dt className="text-muted">Member since</dt>
          <dd>{formatDate(profile.createdAt)}</dd>
        </dl>
      </Card>
      <PasskeysSection client={client} />
      <TokensSection availableScopes={profile.scopes} />
      <PublishersSection />
      <RevocableList<DeviceLink>
        title="Linked ClarkCant devices"
        description="ClarkCant apps you linked to this account. Unlinking never touches the local identity on the device."
        path="/api/v1/me/devices"
        empty="No linked devices."
        keyOf={(device) => device.id}
        render={(device) => (
          <>
            <p className="font-medium">{device.deviceLabel}</p>
            <p className="font-mono text-xs text-muted">
              {device.localPrincipalId} · linked {formatDate(device.createdAt)}
            </p>
          </>
        )}
        removePath={(device) => `/api/v1/me/devices/${encodeURIComponent(device.id)}`}
        removeLabel="Unlink"
      />
      <RevocableList<OAuthGrant>
        title="Authorized applications"
        description="OAuth clients (ClarkCant desktop, MCP clients) you granted access. Revoking ends their access and refresh tokens."
        path="/api/v1/me/oauth/grants"
        empty="No authorized applications."
        keyOf={(grant) => grant.clientId}
        render={(grant) => (
          <>
            <p className="font-medium">{grant.clientName ?? grant.clientId}</p>
            <p className="font-mono text-xs text-muted">
              {grant.scopes.join(" ")} · granted {formatDate(grant.grantedAt)}
            </p>
          </>
        )}
        removePath={(grant) => `/api/v1/me/oauth/grants/${encodeURIComponent(grant.clientId)}`}
        removeLabel="Revoke"
      />
      <DangerZone client={client} />
    </div>
  );
}
