import type {
  PackageClaim,
  Publisher,
  PublisherDomain,
  PublisherInvitation,
  PublisherMember,
  PublisherRepository,
} from "@marketplace/contracts";
import { useCallback, useEffect, useState, type SubmitEvent, type ReactNode } from "react";

import { describeError, requestJson } from "./request";
import { Button, Card, Notice, formatDate, inputClass } from "./ui";

type Items<T> = { items: T[] };

/** Runs a form action, resets the form on success and reports failures inline. */
function useAction(onDone: () => Promise<void>) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const run = useCallback(
    async (action: () => Promise<unknown>, form?: HTMLFormElement) => {
      setPending(true);
      setError(null);
      try {
        await action();
        form?.reset();
        await onDone();
      } catch (caught) {
        setError(describeError(caught));
      } finally {
        setPending(false);
      }
    },
    [onDone],
  );
  return { error, pending, run };
}

function field(event: SubmitEvent<HTMLFormElement>, name: string): string {
  return String(new FormData(event.currentTarget).get(name) ?? "").trim();
}

function Subsection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-t border-line pt-4">
      <h4 className="text-sm font-medium">{title}</h4>
      <div className="mt-2 space-y-2 text-sm">{children}</div>
    </div>
  );
}

function PublisherDetail({ publisher }: { publisher: Publisher }) {
  const base = `/api/v1/me/publishers/${encodeURIComponent(publisher.id)}`;
  const canManage = publisher.role === "owner" || publisher.role === "admin";
  const [members, setMembers] = useState<PublisherMember[]>([]);
  const [invitations, setInvitations] = useState<PublisherInvitation[]>([]);
  const [domains, setDomains] = useState<PublisherDomain[]>([]);
  const [repositories, setRepositories] = useState<PublisherRepository[]>([]);
  const [claims, setClaims] = useState<PackageClaim[]>([]);

  const load = useCallback(async () => {
    const [memberList, domainList, repositoryList, claimList] = await Promise.all([
      requestJson<Items<PublisherMember>>(`${base}/members`),
      requestJson<Items<PublisherDomain>>(`${base}/domains`),
      requestJson<Items<PublisherRepository>>(`${base}/repositories`),
      requestJson<Items<PackageClaim>>(`${base}/claims`),
    ]);
    setMembers(memberList.items);
    setDomains(domainList.items);
    setRepositories(repositoryList.items);
    setClaims(claimList.items);
    if (canManage) setInvitations((await requestJson<Items<PublisherInvitation>>(`${base}/invitations`)).items);
  }, [base, canManage]);

  const { error, pending, run } = useAction(load);

  useEffect(() => {
    void run(async () => undefined);
  }, [run]);

  return (
    <div className="mt-3 space-y-4">
      <Subsection title="Members">
        <ul className="space-y-1">
          {members.map((member) => (
            <li key={member.userId}>
              {member.name} <span className="text-muted">({member.email})</span> — <span className="font-mono text-xs">{member.role}</span>
            </li>
          ))}
        </ul>
        {canManage && (
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const body = { email: field(event, "email"), role: field(event, "role") };
              void run(() => requestJson(`${base}/invitations`, { method: "POST", body }), event.currentTarget);
            }}
          >
            <input name="email" type="email" required placeholder="teammate@example.com" className={`${inputClass} max-w-xs`} />
            <select name="role" className={`${inputClass} w-auto`} defaultValue="member">
              <option value="member">member</option>
              {publisher.role === "owner" && <option value="admin">admin</option>}
            </select>
            <Button type="submit" disabled={pending}>
              Invite
            </Button>
          </form>
        )}
        {invitations.some((invitation) => invitation.status === "pending") && (
          <div className="text-xs text-muted">
            <p>
              Pending invitations. No email is sent: share the invitation id; the invitee accepts it on their account page while signed in
              with the invited email.
            </p>
            <ul className="mt-1 space-y-0.5">
              {invitations
                .filter((invitation) => invitation.status === "pending")
                .map((invitation) => (
                  <li key={invitation.id}>
                    {invitation.email} ({invitation.role}) — <code className="font-mono">{invitation.id}</code>, expires{" "}
                    {formatDate(invitation.expiresAt)}
                  </li>
                ))}
            </ul>
          </div>
        )}
      </Subsection>

      <Subsection title="Verified domains">
        {domains.map((domain) => (
          <div key={domain.id} className="rounded-xl border border-line p-3">
            <p className="font-medium">
              {domain.domain} {domain.verifiedAt ? <span className="text-success">verified</span> : <span className="text-warning">unverified</span>}
            </p>
            {!domain.verifiedAt && (
              <>
                <p className="text-xs text-muted">Publish this DNS TXT record, then check it:</p>
                <code className="block break-all font-mono text-xs">
                  {domain.txtRecordName} TXT "{domain.txtRecordValue}"
                </code>
                {canManage && (
                  <Button
                    tone="secondary"
                    className="mt-2"
                    disabled={pending}
                    onClick={() => void run(() => requestJson(`${base}/domains/${encodeURIComponent(domain.id)}/verify`, { method: "POST" }))}
                  >
                    Check DNS
                  </Button>
                )}
              </>
            )}
          </div>
        ))}
        {canManage && (
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void run(() => requestJson(`${base}/domains`, { method: "POST", body: { domain: field(event, "domain") } }), event.currentTarget);
            }}
          >
            <input name="domain" required placeholder="example.com" className={`${inputClass} max-w-xs`} />
            <Button type="submit" disabled={pending}>
              Add domain
            </Button>
          </form>
        )}
      </Subsection>

      <Subsection title="Repositories">
        {repositories.map((repository) => (
          <div key={repository.id} className="rounded-xl border border-line p-3">
            <p className="font-medium">
              github.com/{repository.repository}{" "}
              {repository.verifiedAt ? <span className="text-success">verified</span> : <span className="text-warning">unverified</span>}
            </p>
            {!repository.verifiedAt && (
              <>
                <p className="text-xs text-muted">
                  Commit <code className="font-mono">{repository.verificationFilePath}</code> containing:
                </p>
                <code className="block break-all font-mono text-xs">{repository.verificationFileContent}</code>
                {canManage && (
                  <Button
                    tone="secondary"
                    className="mt-2"
                    disabled={pending}
                    onClick={() =>
                      void run(() => requestJson(`${base}/repositories/${encodeURIComponent(repository.id)}/verify`, { method: "POST" }))
                    }
                  >
                    Check repository
                  </Button>
                )}
              </>
            )}
          </div>
        ))}
        {canManage && (
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const body = { provider: "github", repository: field(event, "repository") };
              void run(() => requestJson(`${base}/repositories`, { method: "POST", body }), event.currentTarget);
            }}
          >
            <input name="repository" required placeholder="owner/repo" className={`${inputClass} max-w-xs`} />
            <Button type="submit" disabled={pending}>
              Link repository
            </Button>
          </form>
        )}
      </Subsection>

      <Subsection title="Package claims">
        {claims.map((claim) => (
          <p key={claim.id}>
            <span className="font-mono">{claim.packageName}</span> — {claim.status} via {claim.method.replace("_", " ")} ({formatDate(claim.createdAt)})
          </p>
        ))}
        {canManage && (
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const body = { packageName: field(event, "packageName"), method: field(event, "method") };
              void run(() => requestJson(`${base}/claims`, { method: "POST", body }), event.currentTarget);
            }}
          >
            <input name="packageName" required placeholder="npm package name" className={`${inputClass} max-w-xs`} />
            <select name="method" className={`${inputClass} w-auto`} defaultValue="repository">
              <option value="repository">verified repository matches</option>
              <option value="npm_maintainer">my verified email is an npm maintainer</option>
            </select>
            <Button type="submit" disabled={pending}>
              Claim
            </Button>
          </form>
        )}
      </Subsection>
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}

/** Publishers own packages. Each is an organization with owner/admin/member roles. */
export default function PublishersSection() {
  const [publishers, setPublishers] = useState<Publisher[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    setPublishers((await requestJson<Items<Publisher>>("/api/v1/me/publishers")).items);
  }, []);
  const { error, pending, run } = useAction(load);

  useEffect(() => {
    void run(async () => undefined);
  }, [run]);

  return (
    <Card title="Publishers" description="Package ownership belongs to a publisher, not to an email address.">
      {publishers === null ? (
        <Notice tone="info">Loading publishers…</Notice>
      ) : publishers.length === 0 ? (
        <Notice tone="info">You are not a member of any publisher yet.</Notice>
      ) : (
        <ul className="divide-y divide-line">
          {publishers.map((publisher) => (
            <li key={publisher.id} className="py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p>
                  <span className="font-medium">{publisher.name}</span> <span className="font-mono text-xs text-muted">@{publisher.slug}</span>{" "}
                  <span className="text-xs text-faint">{publisher.role}</span>
                  {publisher.verifiedAt && <span className="ml-2 text-xs text-success">verified</span>}
                </p>
                <Button tone="secondary" aria-expanded={open === publisher.id} onClick={() => setOpen(open === publisher.id ? null : publisher.id)}>
                  {open === publisher.id ? "Close" : "Manage"}
                </Button>
              </div>
              {open === publisher.id && <PublisherDetail publisher={publisher} />}
            </li>
          ))}
        </ul>
      )}

      <form
        className="mt-4 grid gap-2 sm:grid-cols-[1fr_1fr_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          const body = { name: field(event, "name"), slug: field(event, "slug") };
          void run(() => requestJson("/api/v1/me/publishers", { method: "POST", body }), event.currentTarget);
        }}
      >
        <input name="name" required maxLength={120} placeholder="Publisher name" className={inputClass} />
        <input name="slug" required pattern="[a-z0-9](?:[a-z0-9-]*[a-z0-9])?" placeholder="slug (a-z, 0-9, -)" className={inputClass} />
        <Button type="submit" disabled={pending}>
          Create publisher
        </Button>
      </form>

      <form
        className="mt-3 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const id = field(event, "invitationId");
          void run(() => requestJson(`/api/v1/me/invitations/${encodeURIComponent(id)}/accept`, { method: "POST" }), event.currentTarget);
        }}
      >
        <input name="invitationId" required placeholder="Invitation id" className={`${inputClass} max-w-xs`} />
        <Button type="submit" tone="secondary" disabled={pending}>
          Accept invitation
        </Button>
      </form>
      {error && <Notice tone="error">{error}</Notice>}
    </Card>
  );
}
