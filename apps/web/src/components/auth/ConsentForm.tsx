import { useEffect, useState } from "react";

import { describeError, describeRedirectTarget, requestJson } from "./request";
import { Button, Notice } from "./ui";

interface ConsentResponse {
  redirect_uri?: string;
  url?: string;
}

/**
 * Records the OAuth consent decision. The signed authorization query of this page is sent back verbatim as
 * `oauth_query`, and the provider answers with the client redirect (code on accept, `access_denied` on deny).
 */
export default function ConsentForm() {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [target, setTarget] = useState<string | null>(null);

  // Read after hydration: the island is also rendered on the server, where there is no `window`.
  useEffect(() => setTarget(describeRedirectTarget(window.location.search)), []);

  async function decide(accept: boolean) {
    setPending(true);
    setError(null);
    try {
      const response = await requestJson<ConsentResponse>("/api/auth/oauth2/consent", {
        method: "POST",
        body: { accept, oauth_query: window.location.search.replace(/^\?/, "") },
      });
      const redirect = response.redirect_uri ?? response.url;
      if (!redirect) throw new Error("The authorization server did not return a redirect.");
      window.location.assign(redirect);
    } catch (caught) {
      setError(describeError(caught));
      setPending(false);
    }
  }

  return (
    <div>
      {target && (
        <p className="mb-4 text-sm">
          Your answer is sent to <strong className="font-mono">{target}</strong>. Application names are chosen by the
          application itself; only allow access if you started this from an app you trust.
        </p>
      )}
      <div className="flex gap-2">
        <Button disabled={pending} onClick={() => void decide(true)}>
          Allow
        </Button>
        <Button tone="secondary" disabled={pending} onClick={() => void decide(false)}>
          Deny
        </Button>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}
