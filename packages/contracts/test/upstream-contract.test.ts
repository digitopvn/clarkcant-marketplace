import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { readClarkcantManifest } from "../src";

/**
 * The cross-repository contract check (`pnpm contract:check`). `fixtures/upstream/clarkcant/` holds what
 * `scripts/sync-clarkcant-fixtures.mjs` recorded from ClarkCant at the commit in `UPSTREAM.json`: every manifest
 * ClarkCant ships, with ClarkCant's own verdict on it, and `verdicts.json`, hostile variants of those manifests with the
 * verdict of ClarkCant's real `parseManifest`. This test proves the files are exactly those recordings and that the
 * marketplace's mirror reaches the same verdict on every one: it accepts what ClarkCant accepts and refuses what
 * ClarkCant refuses. Drift on ClarkCant's side is caught by the scheduled upstream-contract workflow (see
 * docs/extending-indexers.md).
 */

const UPSTREAM_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../fixtures/upstream/clarkcant");
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

const upstreamSchema = z.strictObject({
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  commit: z.string().regex(/^[0-9a-f]{40}$/, { error: "must be a full commit SHA" }),
  note: z.string(),
  files: z
    .array(
      z.strictObject({
        path: z.string().regex(/^[a-z0-9-]+\/[a-z0-9.-]+\/clarkcant\.json$/),
        source: z.string().min(1),
        sha256: sha256Schema,
        accepted: z.boolean(),
      }),
    )
    .min(1),
  verdicts: z.strictObject({ path: z.literal("verdicts.json"), sha256: sha256Schema, cases: z.int().positive() }),
  contractSources: z.array(z.strictObject({ source: z.string().min(1), sha256: sha256Schema })).min(1),
});

const pathSchema = z.array(z.union([z.string(), z.int().nonnegative()]));
const caseSchema = z.discriminatedUnion("op", [
  z.strictObject({ base: z.string(), path: pathSchema, op: z.literal("delete"), accepted: z.boolean() }),
  z.strictObject({ base: z.string(), path: pathSchema, op: z.literal("duplicate"), accepted: z.boolean() }),
  z.strictObject({ base: z.string(), path: pathSchema, op: z.literal("set"), value: z.unknown(), accepted: z.boolean() }),
  z.strictObject({
    base: z.string(),
    path: pathSchema,
    op: z.literal("add"),
    key: z.string(),
    value: z.unknown(),
    accepted: z.boolean(),
  }),
]);
type VerdictCase = z.infer<typeof caseSchema>;
const verdictsSchema = z.strictObject({ note: z.string(), cases: z.array(caseSchema).min(1) });

function read(relative: string): string {
  // Hashes are recorded over LF text, so a CRLF checkout of this repository still matches.
  return readFileSync(path.join(UPSTREAM_DIR, ...relative.split("/")), "utf8").replace(/\r\n/g, "\n");
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function vendoredFiles(dir: string, prefix = ""): string[] {
  return readdirSync(dir).flatMap((entry: string) => {
    const full = path.join(dir, entry);
    const relative = prefix ? `${prefix}/${entry}` : entry;
    return statSync(full).isDirectory() ? vendoredFiles(full, relative) : [relative];
  });
}

/** A JSON object or array addressed by key: the only containers a mutation path walks through. */
type Container = Record<string | number, unknown>;

function container(node: unknown, at: VerdictCase["path"]): Container {
  if (node === null || typeof node !== "object") throw new Error(`/${at.join("/")} does not lead to an object or array`);
  return node as Container;
}

/** Rebuilds a hostile variant exactly as the sync script built it before asking ClarkCant (`applyMutation` there). */
function applyMutation(manifest: unknown, mutation: VerdictCase): unknown {
  const copy: unknown = JSON.parse(JSON.stringify(manifest));
  if (mutation.path.length === 0) {
    if (mutation.op === "add") container(copy, mutation.path)[mutation.key] = mutation.value;
    return copy;
  }
  const parentPath = mutation.path.slice(0, -1);
  const parent = container(
    parentPath.reduce<unknown>((node, key) => container(node, mutation.path)[key], copy),
    parentPath,
  );
  const key = mutation.path.at(-1) ?? "";
  if (mutation.op === "delete") delete parent[key];
  else if (mutation.op === "set") parent[key] = mutation.value;
  else if (mutation.op === "duplicate") {
    const target = parent[key];
    if (!Array.isArray(target)) throw new Error(`/${mutation.path.join("/")} is not an array`);
    target.push(JSON.parse(JSON.stringify(target[0])) as unknown);
  } else container(parent[key], mutation.path)[mutation.key] = mutation.value;
  return copy;
}

const upstream = upstreamSchema.parse(JSON.parse(read("UPSTREAM.json")));
const verdictsText = read(upstream.verdicts.path);
const verdicts = verdictsSchema.parse(JSON.parse(verdictsText));

describe(`ClarkCant's manifest contract pinned at ${upstream.repository}@${upstream.commit.slice(0, 12)}`, () => {
  it("vendors exactly the recordings UPSTREAM.json lists, byte for byte", () => {
    const recorded = [...upstream.files.map((file) => file.path), upstream.verdicts.path].sort();
    expect(vendoredFiles(UPSTREAM_DIR).filter((file) => file !== "UPSTREAM.json").sort()).toEqual(recorded);
    for (const file of upstream.files) {
      expect(sha256(read(file.path)), `${file.path} was edited after it was synced from ${file.source}`).toBe(file.sha256);
    }
    expect(sha256(verdictsText), "verdicts.json was edited after it was synced").toBe(upstream.verdicts.sha256);
    expect(verdicts.cases).toHaveLength(upstream.verdicts.cases);
  });

  it("covers every reference app, ClarkCant's themes and the CLI's blank template, in both directions", () => {
    const paths = upstream.files.map((file) => file.path);
    expect(paths).toContain("templates/blank/clarkcant.json");
    expect(paths.filter((file) => file.startsWith("reference-apps/")).length).toBeGreaterThanOrEqual(5);
    expect(paths.some((file) => file.startsWith("themes/"))).toBe(true);
    // A corpus ClarkCant accepts (or refuses) entirely would prove nothing in the other direction.
    expect(verdicts.cases.some((entry) => entry.accepted)).toBe(true);
    expect(verdicts.cases.some((entry) => !entry.accepted)).toBe(true);
  });

  it.each(upstream.files.map((file) => [file.path, file.accepted] as const))("%s: ClarkCant accepts it: %s", (file, accepted) => {
    const result = readClarkcantManifest(JSON.parse(read(file)));
    if (accepted) expect(result.ok ? [] : result.issues).toEqual([]);
    else expect(result.ok).toBe(false);
  });

  it(`reaches ClarkCant's verdict on every hostile variant (${String(verdicts.cases.length)})`, () => {
    const bases = new Map(upstream.files.map((file) => [file.path, JSON.parse(read(file.path)) as unknown]));
    const disagreements: string[] = [];
    for (const entry of verdicts.cases) {
      if (!bases.has(entry.base)) throw new Error(`verdicts.json refers to ${entry.base}, which is not vendored`);
      const result = readClarkcantManifest(applyMutation(bases.get(entry.base), entry));
      if (result.ok === entry.accepted) continue;
      const detail = entry.op === "set" || entry.op === "add" ? ` ${JSON.stringify(entry.value)}` : "";
      const mirror = result.ok ? "accepts" : `rejects (${result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")})`;
      disagreements.push(
        `${entry.base} /${entry.path.join("/")} ${entry.op}${detail}: ClarkCant ${entry.accepted ? "accepts" : "rejects"}, the mirror ${mirror}`,
      );
    }
    expect(disagreements).toEqual([]);
  });
});
