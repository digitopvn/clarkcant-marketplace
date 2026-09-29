import type { Actor } from "@marketplace/contracts";
import { auditEvents } from "@marketplace/db";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import {
  createMarketplaceDeps,
  featurePackage,
  getCollection,
  getCollectionState,
  getPackage,
  getSubmission,
  listCollections,
  listFeaturedPackages,
  manageCollection,
  searchPackages,
  setCurationStatus,
  submitPackage,
  type MarketplaceDeps,
} from "../src";
import { ANONYMOUS_ACTOR, createAccount, indexingDeps, resetIndexingState } from "./support/indexing-fixtures";
import { instrumentD1 } from "./support/instrumented-d1";
import { seedPackage } from "./support/seed";

let deps: MarketplaceDeps;
let curator: Actor;
let member: Actor;

beforeEach(async () => {
  deps = indexingDeps();
  await resetIndexingState(deps);
  curator = await createAccount(deps, { admin: true });
  member = await createAccount(deps);
});

async function auditActions(): Promise<string[]> {
  const rows = await deps.db.select({ action: auditEvents.action }).from(auditEvents).orderBy(auditEvents.createdAt);
  return rows.map((row) => row.action);
}

describe("package submissions", () => {
  it("records a submission, audits it and queues it without a queue binding only when asked", async () => {
    const { submission, created } = await submitPackage(deps, member, { name: "@acme/clock", version: "1.2.3" }, { enqueue: false });
    expect(created).toBe(true);
    expect(submission).toMatchObject({ packageName: "@acme/clock", version: "1.2.3", status: "queued", error: null });
    expect(await auditActions()).toEqual(["package.submitted"]);
    await expect(getSubmission(deps, member, submission.id)).resolves.toEqual(submission);
  });

  it("returns the open submission instead of duplicating it", async () => {
    const first = await submitPackage(deps, member, { name: "clock-widget" }, { enqueue: false });
    const second = await submitPackage(deps, member, { name: "clock-widget" }, { enqueue: false });
    expect(second).toEqual({ submission: first.submission, created: false });
  });

  it("replays an Idempotency-Key and refuses to reuse it for another package", async () => {
    const options = { enqueue: false, idempotencyKey: "submit-0001" };
    const first = await submitPackage(deps, member, { name: "clock-widget" }, options);
    expect(await submitPackage(deps, member, { name: "clock-widget" }, options)).toEqual(first);
    await expect(submitPackage(deps, member, { name: "other-widget" }, options)).rejects.toMatchObject({
      code: "idempotency_key_reused",
    });
  });

  it("marks a submission failed when it cannot be queued", async () => {
    await expect(submitPackage(deps, member, { name: "clock-widget" })).rejects.toMatchObject({ code: "configuration_error" });
    const { submission } = await submitPackage(deps, member, { name: "clock-widget" }, { enqueue: false });
    expect(submission.status).toBe("queued");
  });

  it("requires a signed-in account with packages:submit and a valid npm name", async () => {
    await expect(submitPackage(deps, ANONYMOUS_ACTOR, { name: "clock-widget" })).rejects.toMatchObject({ code: "unauthorized" });
    const readOnly: Actor = { ...member, scopes: ["account:read"] };
    await expect(submitPackage(deps, readOnly, { name: "clock-widget" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(submitPackage(deps, member, { name: "Not A Name" }, { enqueue: false })).rejects.toMatchObject({
      code: "validation_failed",
    });
  });

  it("shows a submission only to its submitter and to curators", async () => {
    const { submission } = await submitPackage(deps, member, { name: "clock-widget" }, { enqueue: false });
    const stranger = await createAccount(deps);
    await expect(getSubmission(deps, curator, submission.id)).resolves.toMatchObject({ id: submission.id });
    await expect(getSubmission(deps, stranger, submission.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(getSubmission(deps, member, "sub_nope")).rejects.toMatchObject({ code: "validation_failed" });
  });
});

describe("curation commands", () => {
  beforeEach(async () => {
    await seedPackage(deps, { name: "clock-widget", description: "A tidy clock" });
    await seedPackage(deps, { name: "notes-widget", description: "Sticky notes" });
  });

  it("features and un-features a package, auditing each change once", async () => {
    await expect(featurePackage(deps, curator, "clock-widget", { featured: true })).resolves.toEqual({
      name: "clock-widget",
      curationStatus: "featured",
    });
    expect((await listFeaturedPackages(deps)).map((item) => item.name)).toEqual(["clock-widget"]);
    await featurePackage(deps, curator, "clock-widget", { featured: true });
    await featurePackage(deps, curator, "clock-widget", { featured: false });
    await featurePackage(deps, curator, "notes-widget", { featured: false });
    expect((await getPackage(deps, "clock-widget")).curationStatus).toBe("listed");
    expect(await auditActions()).toEqual(["package.curation_changed", "package.curation_changed"]);
  });

  it("hides a package from every public surface, then restores it", async () => {
    await setCurationStatus(deps, curator, "clock-widget", { status: "hidden", reason: "broken entry" });
    await expect(getPackage(deps, "clock-widget")).rejects.toMatchObject({ code: "not_found" });
    expect((await searchPackages(deps, { q: "clock" })).items).toEqual([]);
    await expect(featurePackage(deps, curator, "clock-widget", { featured: true })).rejects.toMatchObject({ code: "conflict" });

    await setCurationStatus(deps, curator, "clock-widget", { status: "listed" });
    expect((await searchPackages(deps, { q: "clock" })).items.map((item) => item.name)).toEqual(["clock-widget"]);
  });

  it("replays by idempotency key without a second audit event", async () => {
    const options = { idempotencyKey: "curate-0001" };
    await setCurationStatus(deps, curator, "clock-widget", { status: "hidden" }, options);
    await setCurationStatus(deps, curator, "clock-widget", { status: "hidden" }, options);
    await expect(setCurationStatus(deps, curator, "clock-widget", { status: "rejected" }, options)).rejects.toMatchObject({
      code: "idempotency_key_reused",
    });
    expect(await auditActions()).toEqual(["package.curation_changed"]);
  });

  it("requires packages:curate", async () => {
    await expect(setCurationStatus(deps, member, "clock-widget", { status: "hidden" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(featurePackage(deps, ANONYMOUS_ACTOR, "clock-widget", { featured: true })).rejects.toMatchObject({
      code: "unauthorized",
    });
    await expect(setCurationStatus(deps, curator, "missing-widget", { status: "hidden" })).rejects.toMatchObject({
      code: "not_found",
    });
    expect(await auditActions()).toEqual([]);
  });
});

describe("collection commands", () => {
  beforeEach(async () => {
    await seedPackage(deps, { name: "clock-widget" });
    await seedPackage(deps, { name: "notes-widget" });
    await seedPackage(deps, { name: "hidden-widget", curationStatus: "hidden" });
  });

  it("answers a create that loses a race for the slug with conflict, not an internal error", async () => {
    let raced = false;
    // Another curator creates the same slug after this command checked for it but before it inserts.
    const instrumented = instrumentD1(env.DB, {
      beforeExecute: async (sql) => {
        if (raced || !/^insert into "collections"/i.test(sql)) return;
        raced = true;
        await manageCollection(deps, curator, "race-slug", { action: "create", title: "Winner" });
      },
    });
    const slow = { ...createMarketplaceDeps({ d1: instrumented.d1 }), ids: deps.ids };
    await expect(manageCollection(slow, curator, "race-slug", { action: "create", title: "Loser" })).rejects.toMatchObject({
      code: "conflict",
    });
    expect(raced).toBe(true);
    expect((await getCollectionState(deps, curator, "race-slug")).title).toBe("Winner");
  });

  it("builds, publishes and orders a collection", async () => {
    await manageCollection(deps, curator, "desk-essentials", { action: "create", title: "Desk essentials" });
    expect(await listCollections(deps)).toEqual([]);
    await expect(getCollection(deps, "desk-essentials")).rejects.toMatchObject({ code: "not_found" });

    for (const packageName of ["clock-widget", "notes-widget", "hidden-widget"]) {
      await manageCollection(deps, curator, "desk-essentials", { action: "add_item", packageName });
    }
    await manageCollection(deps, curator, "desk-essentials", { action: "add_item", packageName: "clock-widget", note: "Start here" });
    await manageCollection(deps, curator, "desk-essentials", {
      action: "reorder",
      packageNames: ["notes-widget", "hidden-widget", "clock-widget"],
    });
    const state = await manageCollection(deps, curator, "desk-essentials", { action: "update", published: true });
    expect(state).toMatchObject({ slug: "desk-essentials", title: "Desk essentials", published: true });
    expect(state.items).toEqual([
      { packageName: "notes-widget", position: 0, note: null },
      { packageName: "hidden-widget", position: 1, note: null },
      { packageName: "clock-widget", position: 2, note: "Start here" },
    ]);

    // The public view never shows a hidden package, even inside a published collection.
    const detail = await getCollection(deps, "desk-essentials");
    expect(detail.packages.map((item) => item.name)).toEqual(["notes-widget", "clock-widget"]);
    expect((await listCollections(deps)).map((item) => item.slug)).toEqual(["desk-essentials"]);

    await manageCollection(deps, curator, "desk-essentials", { action: "remove_item", packageName: "notes-widget" });
    expect((await getCollectionState(deps, curator, "desk-essentials")).items.map((item) => item.packageName)).toEqual([
      "hidden-widget",
      "clock-widget",
    ]);
    expect((await auditActions()).filter((action) => action.startsWith("collection."))).toHaveLength(8);
  });

  it("rejects duplicates, partial reorders, unknown packages and non-curators", async () => {
    await manageCollection(deps, curator, "picks", { action: "create", title: "Picks" });
    await manageCollection(deps, curator, "picks", { action: "add_item", packageName: "clock-widget" });
    await manageCollection(deps, curator, "picks", { action: "add_item", packageName: "notes-widget" });
    await expect(manageCollection(deps, curator, "picks", { action: "create", title: "Again" })).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(
      manageCollection(deps, curator, "picks", { action: "reorder", packageNames: ["clock-widget"] }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    await expect(
      manageCollection(deps, curator, "picks", { action: "add_item", packageName: "missing-widget" }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(manageCollection(deps, curator, "nope", { action: "update", title: "x" })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(manageCollection(deps, member, "picks", { action: "update", title: "Mine" })).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(getCollectionState(deps, member, "picks")).rejects.toMatchObject({ code: "forbidden" });
  });

  it("replays a create by idempotency key", async () => {
    const options = { idempotencyKey: "collection-0001" };
    const first = await manageCollection(deps, curator, "picks", { action: "create", title: "Picks" }, options);
    await expect(manageCollection(deps, curator, "picks", { action: "create", title: "Picks" }, options)).resolves.toEqual(first);
  });
});
