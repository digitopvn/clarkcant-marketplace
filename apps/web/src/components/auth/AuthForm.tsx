import { createMarketplaceAuthClient } from "@marketplace/auth/client";
import { useMemo, useState, type SubmitEvent } from "react";

import { describeError, safeNextPath } from "./request";
import { Button, Notice, inputClass } from "./ui";

interface Props {
  mode: "login" | "signup";
  githubEnabled: boolean;
  next: string | null;
}

interface RedirectData {
  url?: unknown;
  redirect?: unknown;
}

/**
 * During an OAuth authorization the sign-in response carries the next authorization step as `{ redirect, url }`
 * (the OAuth client plugin forwarded the signed query). Otherwise the visitor continues to `next`.
 */
function continueAfterSignIn(data: unknown, next: string | null): void {
  const redirect = data as RedirectData | null;
  if (redirect && typeof redirect.url === "string" && redirect.url !== "") {
    window.location.assign(redirect.url);
    return;
  }
  window.location.assign(safeNextPath(next));
}

export default function AuthForm({ mode, githubEnabled, next }: Props) {
  const client = useMemo(() => createMarketplaceAuthClient(), []);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isSignup = mode === "signup";

  async function run(action: () => Promise<{ data: unknown; error: { message?: string | undefined } | null }>) {
    setPending(true);
    setError(null);
    try {
      const result = await action();
      if (result.error) {
        setError(result.error.message ?? "The request was rejected.");
        return;
      }
      continueAfterSignIn(result.data, next);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setPending(false);
    }
  }

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    if (isSignup) {
      const name = String(form.get("name") ?? "").trim();
      void run(() => client.signUp.email({ name, email, password }));
    } else {
      void run(() => client.signIn.email({ email, password }));
    }
  }

  const callbackURL = safeNextPath(next);

  return (
    <div className="space-y-5">
      <form onSubmit={onSubmit} className="space-y-4" noValidate={false}>
        {isSignup && (
          <label className="block text-sm">
            <span className="mb-1 block text-muted">Name</span>
            <input name="name" required maxLength={120} autoComplete="name" className={inputClass} />
          </label>
        )}
        <label className="block text-sm">
          <span className="mb-1 block text-muted">Email</span>
          <input name="email" type="email" required autoComplete={isSignup ? "email" : "username webauthn"} className={inputClass} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-muted">Password</span>
          <input
            name="password"
            type="password"
            required
            minLength={8}
            maxLength={128}
            autoComplete={isSignup ? "new-password" : "current-password"}
            className={inputClass}
          />
        </label>
        <Button type="submit" disabled={pending} className="w-full">
          {pending ? "Please wait…" : isSignup ? "Create account" : "Sign in"}
        </Button>
      </form>

      <div className="flex items-center gap-3 text-xs text-faint" aria-hidden="true">
        <span className="h-px flex-1 bg-line" />
        or
        <span className="h-px flex-1 bg-line" />
      </div>

      <div className="space-y-2">
        {!isSignup && (
          <Button tone="secondary" disabled={pending} className="w-full" onClick={() => void run(() => client.signIn.passkey())}>
            Sign in with a passkey
          </Button>
        )}
        <Button
          tone="secondary"
          className="w-full"
          disabled={pending || !githubEnabled}
          aria-describedby={githubEnabled ? undefined : "github-unavailable"}
          onClick={() => void run(() => client.signIn.social({ provider: "github", callbackURL }))}
        >
          Continue with GitHub
        </Button>
        {!githubEnabled && (
          <p id="github-unavailable" className="text-xs text-faint">
            GitHub sign-in is not configured on this deployment yet.
          </p>
        )}
      </div>

      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}
