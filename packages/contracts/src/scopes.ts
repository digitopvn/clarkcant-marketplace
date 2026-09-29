import { z } from "zod";

/**
 * Scopes carried by personal API tokens and OAuth access tokens. A scope only ever narrows what the owning account
 * may already do; it never grants anything the account itself lacks. Nothing here grants ClarkCant runtime
 * permissions: marketplace credentials cannot reach a user's device.
 */
export const apiScopeSchema = z.enum([
  "packages:read",
  "packages:submit",
  "publishers:read",
  "publishers:write",
  "pages:read",
  "pages:write",
  "pages:publish",
  "media:write",
  "account:read",
  "account:write",
  "admin",
]);
export type ApiScope = z.infer<typeof apiScopeSchema>;

export const API_SCOPES: readonly ApiScope[] = apiScopeSchema.options;

/** Scopes an anonymous caller implicitly holds: public reads only. */
export const PUBLIC_SCOPES: readonly ApiScope[] = ["packages:read", "publishers:read", "pages:read"];

export function hasScope(granted: readonly ApiScope[], required: ApiScope): boolean {
  return granted.includes("admin") || granted.includes(required);
}
