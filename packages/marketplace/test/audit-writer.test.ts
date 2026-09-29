import { collections } from "@marketplace/db";
import { beforeEach, describe, expect, it } from "vitest";

import { listAuditEventsForSubject, prepareAuditEvent, recordAuditEvent } from "../src";
import { resetDatabase, testDeps } from "./support/seed";

const deps = testDeps(() => new Date("2026-09-29T12:00:00.000Z"));

beforeEach(async () => {
  await resetDatabase(deps);
});

describe("audit writer", () => {
  it("records a validated event and reads it back by subject", async () => {
    const event = await recordAuditEvent(deps, {
      actor: { type: "user", id: "usr_1" },
      action: "package.submitted",
      subject: { type: "package", id: "pkg_1" },
      idempotencyKey: "key-12345678",
      data: { packageName: "chart" },
    });

    expect(event.id).toMatch(/^aud_[0-9a-z]{26}$/);
    expect(event.createdAt).toBe("2026-09-29T12:00:00.000Z");
    const stored = await listAuditEventsForSubject(deps, { type: "package", id: "pkg_1" });
    expect(stored).toEqual([event]);
  });

  it("rejects malformed events before touching the database", async () => {
    await expect(
      recordAuditEvent(deps, { actor: { type: "user", id: "usr_1" }, action: "Submitted", subject: { type: "package", id: null } }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    await expect(
      // @ts-expect-error actor type is outside the contract on purpose
      recordAuditEvent(deps, { actor: { type: "robot", id: null }, action: "package.submitted", subject: { type: "package", id: null } }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("commits a command's write and its audit event atomically in one batch", async () => {
    const { statement } = prepareAuditEvent(deps, {
      actor: { type: "system", id: "test" },
      action: "collection.created",
      subject: { type: "collection", id: "col_x" },
    });
    // The second insert violates the slug unique index, so the whole batch, audit row included, must roll back.
    await expect(
      deps.db.batch([
        deps.db.insert(collections).values({ id: "col_x", slug: "dup", title: "X" }),
        statement,
        deps.db.insert(collections).values({ id: "col_y", slug: "dup", title: "Y" }),
      ]),
    ).rejects.toThrow();
    expect(await listAuditEventsForSubject(deps, { type: "collection", id: "col_x" })).toEqual([]);
    expect(await deps.db.select().from(collections)).toEqual([]);
  });
});
