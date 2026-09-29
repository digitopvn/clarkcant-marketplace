import {
  MarketplaceError,
  featurePackageInputSchema,
  packageNameSchema,
  setCurationStatusInputSchema,
  toAuditActor,
  type Actor,
  type CurationState,
  type CurationStatus,
} from "@marketplace/contracts";
import { packages } from "@marketplace/db";
import { eq } from "drizzle-orm";

import { prepareAuditEvent } from "../audit/audit-writer";
import type { MarketplaceDeps } from "../deps";
import { parseInput } from "../validation";
import { runCurationCommand, type CurationCommandOptions } from "./curation-command";

/** Curators act on any package, whatever its current visibility. */
export async function findPackageForCuration(deps: MarketplaceDeps, rawName: unknown) {
  const name = parseInput(packageNameSchema, rawName);
  const [row] = await deps.db
    .select({ id: packages.id, name: packages.name, curationStatus: packages.curationStatus })
    .from(packages)
    .where(eq(packages.name, name))
    .limit(1);
  if (!row) throw new MarketplaceError("not_found", `package "${name}" was not found`);
  return row;
}

async function applyStatus(
  deps: MarketplaceDeps,
  actor: Actor,
  pkg: { id: string; name: string; curationStatus: CurationStatus },
  status: CurationStatus,
  reason: string | undefined,
  idempotencyKey: string | undefined,
): Promise<CurationState> {
  if (pkg.curationStatus === status) return { name: pkg.name, curationStatus: status };
  const now = deps.now();
  const audit = prepareAuditEvent(deps, {
    actor: toAuditActor(actor),
    action: "package.curation_changed",
    subject: { type: "package", id: pkg.id },
    ...(idempotencyKey ? { idempotencyKey } : {}),
    data: { name: pkg.name, from: pkg.curationStatus, to: status, ...(reason ? { reason } : {}) },
  });
  await deps.db.batch([
    deps.db.update(packages).set({ curationStatus: status, updatedAt: now }).where(eq(packages.id, pkg.id)),
    audit.statement,
  ]);
  return { name: pkg.name, curationStatus: status };
}

/**
 * `set_curation_status`: moves a package between unreviewed, listed, featured, hidden and rejected. Curation is an
 * editorial decision only; it never changes or implies the package's security facts.
 */
export async function setCurationStatus(
  deps: MarketplaceDeps,
  actor: Actor,
  rawName: unknown,
  rawInput: unknown,
  options: CurationCommandOptions = {},
): Promise<CurationState> {
  const input = parseInput(setCurationStatusInputSchema, rawInput);
  return runCurationCommand(deps, actor, "packages.set_curation_status", { name: rawName, ...input }, options, async () => {
    const pkg = await findPackageForCuration(deps, rawName);
    return applyStatus(deps, actor, pkg, input.status, input.reason, options.idempotencyKey);
  });
}

/**
 * `feature_package`: features a package, or returns a featured package to plain listing. Hidden or rejected
 * packages cannot be featured; un-featuring a package that is not featured changes nothing.
 */
export async function featurePackage(
  deps: MarketplaceDeps,
  actor: Actor,
  rawName: unknown,
  rawInput: unknown,
  options: CurationCommandOptions = {},
): Promise<CurationState> {
  const input = parseInput(featurePackageInputSchema, rawInput);
  return runCurationCommand(deps, actor, "packages.feature", { name: rawName, ...input }, options, async () => {
    const pkg = await findPackageForCuration(deps, rawName);
    if (input.featured) {
      if (pkg.curationStatus === "hidden" || pkg.curationStatus === "rejected") {
        throw new MarketplaceError("conflict", `package "${pkg.name}" is ${pkg.curationStatus} and cannot be featured`);
      }
      return applyStatus(deps, actor, pkg, "featured", undefined, options.idempotencyKey);
    }
    if (pkg.curationStatus !== "featured") return { name: pkg.name, curationStatus: pkg.curationStatus };
    return applyStatus(deps, actor, pkg, "listed", undefined, options.idempotencyKey);
  });
}
