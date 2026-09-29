import { IDEMPOTENCY_TTL_MS } from "@marketplace/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { IDEMPOTENCY_LEASE_MS, beginIdempotentRequest, hashRequest, withIdempotency } from "../src";
import { resetDatabase, testDeps } from "./support/seed";

let clock = new Date("2026-09-29T00:00:00.000Z").getTime();
const deps = testDeps(() => new Date(clock));
const ref = { scope: "user:usr_1:packages.submit", key: "idem-key-0001" };

beforeEach(async () => {
  clock = new Date("2026-09-29T00:00:00.000Z").getTime();
  await resetDatabase(deps);
});

describe("hashRequest", () => {
  it("is stable under key order and ignores undefined fields", async () => {
    expect(await hashRequest({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(
      await hashRequest({ b: [1, { d: 3, c: 2 }], a: 1, z: undefined }),
    );
    expect(await hashRequest({ a: 1 })).not.toBe(await hashRequest({ a: 2 }));
  });
});

describe("withIdempotency", () => {
  it("runs once and replays the stored response for the same request", async () => {
    let runs = 0;
    const execute = async () => {
      runs += 1;
      return { statusCode: 202, response: { submissionId: `sub_${runs}` } };
    };

    const first = await withIdempotency(deps, ref, { packageName: "chart" }, execute);
    const second = await withIdempotency(deps, ref, { packageName: "chart" }, execute);

    expect(runs).toBe(1);
    expect(first).toEqual({ statusCode: 202, response: { submissionId: "sub_1" }, replayed: false });
    expect(second).toEqual({ statusCode: 202, response: { submissionId: "sub_1" }, replayed: true });
  });

  it("rejects the same key reused for a different request", async () => {
    await withIdempotency(deps, ref, { packageName: "chart" }, async () => ({ statusCode: 200, response: null }));
    await expect(
      withIdempotency(deps, ref, { packageName: "other" }, async () => ({ statusCode: 200, response: null })),
    ).rejects.toMatchObject({ code: "idempotency_key_reused", status: 422 });
  });

  it("keeps scopes apart", async () => {
    await withIdempotency(deps, ref, { a: 1 }, async () => ({ statusCode: 200, response: "one" }));
    const other = await withIdempotency(deps, { ...ref, scope: "user:usr_2:packages.submit" }, { a: 2 }, async () => ({
      statusCode: 200,
      response: "two",
    }));
    expect(other).toMatchObject({ response: "two", replayed: false });
  });

  it("releases the key when the command fails so a retry runs again", async () => {
    await expect(
      withIdempotency(deps, ref, { a: 1 }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const retry = await withIdempotency(deps, ref, { a: 1 }, async () => ({ statusCode: 201, response: "ok" }));
    expect(retry).toMatchObject({ statusCode: 201, replayed: false });
  });

  it("reports in-progress, then lets a retry take over an abandoned reservation after the lease", async () => {
    const hash = await hashRequest({ a: 1 });
    expect(await beginIdempotentRequest(deps, ref, hash)).toEqual({ state: "new" });
    await expect(
      withIdempotency(deps, ref, { a: 1 }, async () => ({ statusCode: 200, response: null })),
    ).rejects.toMatchObject({ code: "idempotency_in_progress", status: 409 });

    clock += IDEMPOTENCY_LEASE_MS + 1;
    const taken = await withIdempotency(deps, ref, { a: 1 }, async () => ({ statusCode: 200, response: "late" }));
    expect(taken).toMatchObject({ response: "late", replayed: false });
  });

  it("forgets completed keys after the TTL", async () => {
    await withIdempotency(deps, ref, { a: 1 }, async () => ({ statusCode: 200, response: "v1" }));
    clock += IDEMPOTENCY_TTL_MS + 1;
    const again = await withIdempotency(deps, ref, { a: 2 }, async () => ({ statusCode: 200, response: "v2" }));
    expect(again).toMatchObject({ response: "v2", replayed: false });
  });

  it("validates the key format", async () => {
    await expect(beginIdempotentRequest(deps, { ...ref, key: "short" }, "hash")).rejects.toMatchObject({
      code: "validation_failed",
    });
  });
});
