import { useState } from "react";

import { describeError, requestJson } from "./request";
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

  async function decide(accept: boolean) {
    setPending(true);
    setError(null);
    try {
      const response = await requestJson<ConsentResponse>("/api/auth/oauth2/consent", {
        method: "POST",
        body: { accept, oauth_query: window.location.search.replace(/^\?/, "") },
      });
      const target = response.redirect_uri ?? response.url;
      if (!target) throw new Error("The authorization server did not return a redirect.");
      window.location.assign(target);
    } catch (caught) {
      setError(describeError(caught));
      setPending(false);
    }
  }

  return (
    <div>
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
