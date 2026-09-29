import {
  clarkcantManifestSchema,
  normalizeManifest,
  type ClarkcantManifest,
  type NormalizedManifest,
} from "@marketplace/contracts";
import type { PERMISSION_KINDS } from "@marketplace/db";
import type { z } from "zod";

import { IndexingRejectedError } from "./indexing-errors";

const MAX_REPORTED_ISSUES = 8;

interface ManifestIssue {
  path: string;
  message: string;
}

/**
 * Flattens Zod issues into publisher-readable `path: message` pairs. The manifest schema is a union of dialects, so a
 * bad manifest fails with one root "invalid input"; report the issues of the dialect it came closest to instead.
 */
function describeIssues(issues: readonly z.core.$ZodIssue[], prefix: PropertyKey[] = []): ManifestIssue[] {
  return issues.flatMap((issue) => {
    const path = [...prefix, ...issue.path];
    if (issue.code === "invalid_union" && issue.errors.length > 0) {
      const closest = issue.errors.reduce((best, branch) => (branch.length < best.length ? branch : best));
      return describeIssues(closest, path);
    }
    return [{ path: path.map(String).join("."), message: issue.message }];
  });
}

/**
 * Parses and validates `clarkcant.json` against the mirrored ClarkCant contract. A manifest only describes what a
 * package *requests*; accepting it grants nothing. The manifest's `version` must equal the npm version, so a
 * listing can never describe a different artifact from the one whose integrity was verified.
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
  const parsed = clarkcantManifestSchema.safeParse(json);
  if (!parsed.success) {
    const issues = describeIssues(parsed.error.issues).slice(0, MAX_REPORTED_ISSUES);
    throw new IndexingRejectedError(
      "manifest_invalid",
      `clarkcant.json does not match the ClarkCant manifest contract (${issues.map((issue) => `${issue.path || "(root)"}: ${issue.message}`).join("; ")})`,
      { issues },
    );
  }
  const manifest = normalizeManifest(parsed.data);
  if (manifest.version !== npmVersion) {
    throw new IndexingRejectedError(
      "manifest_mismatch",
      `clarkcant.json declares version ${manifest.version} but npm published ${npmVersion}`,
    );
  }
  return { raw: parsed.data, normalized: manifest };
}

export type PermissionKind = (typeof PERMISSION_KINDS)[number];

export interface PermissionRow {
  kind: PermissionKind;
  value: string;
  access: string | null;
}

/**
 * Flattens the requested permissions into rows. Booleans become a row only when requested, so "no rows of kind
 * camera" plainly means "does not ask for the camera".
 */
export function permissionRows(manifest: NormalizedManifest): PermissionRow[] {
  const rows: PermissionRow[] = [
    ...manifest.requestedCapabilities.map((value) => ({ kind: "capability" as const, value, access: null })),
    ...manifest.permissions.networkOrigins.map((value) => ({ kind: "network" as const, value, access: null })),
    ...manifest.permissions.filesystem.map((entry) => ({ kind: "filesystem" as const, value: entry.path, access: entry.access })),
    ...manifest.permissions.lifecycleScripts.map((value) => ({ kind: "lifecycle" as const, value, access: null })),
  ];
  if (manifest.permissions.microphone) rows.push({ kind: "microphone", value: "microphone", access: null });
  if (manifest.permissions.camera) rows.push({ kind: "camera", value: "camera", access: null });
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.kind}\u0000${row.value}\u0000${row.access ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
