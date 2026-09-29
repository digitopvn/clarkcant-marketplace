import { z } from "zod";

/**
 * Scopes carried by personal API tokens and OAuth access tokens. A scope only ever narrows what the owning account
 * may already do; it never grants anything the account itself lacks. Nothing here grants ClarkCant runtime
 * permissions: marketplace credentials cannot reach a user's device.
 */
export const apiScopeSchema = z.enum([
  "packages:read",
  "packages:submit",
  "packages:curate",
  "publishers:read",
  "publishers:write",
  "pages:read",
  "pages:write",
  "pages:publish",
  "media:write",
  "account:read",
  "account:write",
  // Link, list and unlink the caller's own ClarkCant installs, and nothing else. It exists so OAuth and device-login
  // clients (e.g. ClarkCant desktop) can link a device without `account:write`, which they are never offered.
  "devices:link",
  "admin",
]);
export type ApiScope = z.infer<typeof apiScopeSchema>;

export const API_SCOPES: readonly ApiScope[] = apiScopeSchema.options;

/** Scopes an anonymous caller implicitly holds: public reads only. */
export const PUBLIC_SCOPES: readonly ApiScope[] = ["packages:read", "publishers:read", "pages:read"];

export function hasScope(granted: readonly ApiScope[], required: ApiScope): boolean {
  return granted.includes("admin") || granted.includes(required);
}
