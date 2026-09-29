import { MarketplaceError } from "@marketplace/contracts";
import { z } from "zod";

/**
 * Signed, short-lived preview tokens: `base64url(payload).base64url(HMAC-SHA256)`. A token names one page and one
 * immutable revision, so a preview link always shows exactly the revision it was issued for. Tokens are stateless
 * and therefore not individually revocable; they expire (30 minutes by default, 24 hours at most) and rotating the
 * signing secret invalidates all of them.
 */
const PREVIEW_DOMAIN = "clarkcant-marketplace/page-preview/v1";
const MIN_SECRET_LENGTH = 32;

const payloadSchema = z.object({
  v: z.literal(1),
  p: z.string().min(1).max(64),
  r: z.string().min(1).max(64),
  e: z.int().positive(),
});

export interface PreviewClaims {
  pageId: string;
  revisionId: string;
  expiresAt: Date;
}

export async function signPreviewToken(secret: string, claims: PreviewClaims): Promise<string> {
  const payload = base64url(
    new TextEncoder().encode(JSON.stringify({ v: 1, p: claims.pageId, r: claims.revisionId, e: Math.floor(claims.expiresAt.getTime() / 1000) })),
  );
  const signature = await sign(secret, payload);
  return `${payload}.${signature}`;
}

/** Returns the claims of a valid, unexpired token, or null for anything else (never says which check failed). */
export async function verifyPreviewToken(secret: string, token: string, now: Date): Promise<PreviewClaims | null> {
  if (token.length > 1024) return null;
  const [payload, signature, ...rest] = token.split(".");
  if (!payload || !signature || rest.length > 0) return null;
  const key = await hmacKey(secret);
  const signatureBytes = fromBase64url(signature);
  if (!signatureBytes) return null;
  // crypto.subtle.verify compares in constant time.
  const valid = await crypto.subtle.verify("HMAC", key, signatureBytes, new TextEncoder().encode(`${PREVIEW_DOMAIN}.${payload}`));
  if (!valid) return null;
  const payloadBytes = fromBase64url(payload);
  if (!payloadBytes) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }
  const parsed = payloadSchema.safeParse(decoded);
  if (!parsed.success) return null;
  const expiresAt = new Date(parsed.data.e * 1000);
  if (expiresAt.getTime() <= now.getTime()) return null;
  return { pageId: parsed.data.p, revisionId: parsed.data.r, expiresAt };
}

export function assertPreviewSecret(secret: string | undefined): string {
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new MarketplaceError("configuration_error", "Page previews need a signing secret of at least 32 characters", {
      details: { variables: ["BETTER_AUTH_SECRET"] },
    });
  }
  return secret;
}

async function sign(secret: string, payload: string): Promise<string> {
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${PREVIEW_DOMAIN}.${payload}`));
  return base64url(new Uint8Array(signature));
}

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(assertPreviewSecret(secret)), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}
