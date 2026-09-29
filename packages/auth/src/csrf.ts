import { MarketplaceError } from "@marketplace/contracts";

import type { CredentialKind } from "./request-auth";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF protection for cookie-authenticated mutations: the browser must prove the request came from our own pages
 * via `Origin` (or, when a browser omits it, `Sec-Fetch-Site: same-origin`). Bearer credentials are not sent
 * ambiently by browsers, so they need no check; anonymous requests carry no authority to abuse.
 */
export function assertSameOriginMutation(request: Request, credential: CredentialKind, origin: string): void {
  if (credential !== "cookie" || SAFE_METHODS.has(request.method.toUpperCase())) return;
  const requestOrigin = request.headers.get("origin");
  if (requestOrigin !== null) {
    if (requestOrigin === origin) return;
  } else if (request.headers.get("sec-fetch-site") === "same-origin") {
    return;
  }
  throw new MarketplaceError("forbidden", "Cross-site request rejected", { details: { reason: "csrf_origin_mismatch" } });
}
