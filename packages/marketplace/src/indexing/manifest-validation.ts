import {
  readClarkcantManifest,
  type ClarkcantManifest,
  type NormalizedManifest,
  type PackagePermissionKind,
} from "@marketplace/contracts";
import type { PERMISSION_KINDS } from "@marketplace/db";

import { IndexingRejectedError } from "./indexing-errors";

const MAX_REPORTED_ISSUES = 8;

/**
 * Parses and validates `clarkcant.json` against the mirrored ClarkCant contract, including the cross-field rules
 * ClarkCant applies before it reads a manifest. A manifest only describes what a package *requests*; accepting it grants
 * nothing. The manifest's `version` must equal the npm version, so a listing can never describe a different artifact
 * from the one whose integrity was verified.
 */
export function validateManifest(
  manifestText: string | null,
  npmVersion: string,
): { raw: ClarkcantManifest; normalized: NormalizedManifest } {
  if (manifestText === null) {
    throw new IndexingRejectedError("manifest_missing", "the package has no clarkcant.json at its root");
  }
  let json: unknown;
  try {
    json = JSON.parse(manifestText);
  } catch (error) {
    throw new IndexingRejectedError("manifest_invalid", "clarkcant.json is not valid JSON", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  const result = readClarkcantManifest(json);
  if (!result.ok) {
    const issues = result.issues.slice(0, MAX_REPORTED_ISSUES);
    throw new IndexingRejectedError(
      "manifest_invalid",
      `clarkcant.json does not match the ClarkCant manifest contract (${issues.map((issue) => `${issue.path || "(root)"}: ${issue.message}`).join("; ")})`,
      { issues },
    );
  }
  if (result.normalized.version !== npmVersion) {
    throw new IndexingRejectedError(
      "manifest_mismatch",
      `clarkcant.json declares version ${result.normalized.version} but npm published ${npmVersion}`,
    );
  }
  return { raw: result.manifest, normalized: result.normalized };
}

export type PermissionKind = (typeof PERMISSION_KINDS)[number];
type SameUnion<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
// The stored kinds and the published kinds are one list kept in two packages; this fails to compile if they drift.
const _permissionKindsInStep: SameUnion<PermissionKind, PackagePermissionKind> = true;

export interface PermissionRow {
  kind: PermissionKind;
  value: string;
  access: string | null;
}

/**
 * Flattens every authority-related request into rows, so listings, search and agents see each one without parsing the
 * manifest: host permissions, what each service provides and reaches, the secrets and account it needs, scoped browser
 * tokens and the resource profile. Booleans become a row only when requested, so "no rows of kind camera" plainly means
 * "does not ask for the camera".
 */
export function permissionRows(manifest: NormalizedManifest): PermissionRow[] {
  const row = (kind: PermissionKind, value: string, access: string | null = null): PermissionRow => ({ kind, value, access });
  const rows: PermissionRow[] = [
    ...manifest.requestedCapabilities.map((value) => row("capability", value)),
    ...manifest.permissions.networkOrigins.map((value) => row("network", value)),
    ...manifest.permissions.filesystem.map((entry) => row("filesystem", entry.path, entry.access)),
    ...manifest.permissions.lifecycleScripts.map((value) => row("lifecycle", value)),
  ];
  if (manifest.permissions.microphone) rows.push(row("microphone", "microphone"));
  if (manifest.permissions.camera) rows.push(row("camera", "camera"));
  for (const service of manifest.services) {
    for (const capability of service.capabilities) rows.push(row("service-capability", capability.ref, capability.effectCategory));
    for (const secret of service.egress?.secrets ?? []) rows.push(row("secret", secret.name));
    for (const origin of service.egress?.origins ?? []) rows.push(row("egress", origin.origin, origin.credential?.secret ?? null));
    const connection = service.connection;
    if (connection) {
      for (const scope of connection.scopes) rows.push(row("connection-scope", scope.scope, connection.provider));
      for (const endpoint of connection.endpoints) rows.push(row("connection-endpoint", endpoint, connection.provider));
    }
  }
  for (const token of manifest.browserTokens) rows.push(row("browser-token", token.provider, token.scopes.join(" ")));
  if (manifest.resources) rows.push(row("resource-profile", manifest.resources.profile, manifest.resources.gpu ? "gpu" : null));
  const seen = new Set<string>();
  return rows.filter((entry) => {
    const key = `${entry.kind}\u0000${entry.value}\u0000${entry.access ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
