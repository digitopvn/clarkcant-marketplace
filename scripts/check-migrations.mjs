#!/usr/bin/env node
// Fails when the Drizzle schema and the committed migrations disagree.
//
// 1. `drizzle-kit check` validates the migration journal and snapshots.
// 2. `drizzle-kit generate` runs against the schema; if it writes or changes anything, the schema
//    has drift that was never turned into a migration. The migrations folder is restored either way,
//    so running this check never leaves generated files behind.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(root, "migrations");

function listFiles(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

function snapshot() {
  const files = new Map();
  for (const path of listFiles(migrationsDir)) {
    files.set(relative(migrationsDir, path), readFileSync(path));
  }
  return files;
}

const hash = (buffer) => createHash("sha256").update(buffer).digest("hex");

function run(args) {
  // pnpm is a .cmd shim on Windows and needs a shell there; the arguments are fixed literals, never user input.
  const options = { cwd: root, encoding: "utf8" };
  const result =
    process.platform === "win32"
      ? spawnSync(`pnpm exec drizzle-kit ${args.join(" ")}`, { ...options, shell: true })
      : spawnSync("pnpm", ["exec", "drizzle-kit", ...args], options);
  if (result.error) throw result.error;
  return { status: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function restore(before) {
  for (const rel of snapshot().keys()) {
    if (!before.has(rel)) rmSync(join(migrationsDir, rel));
  }
  for (const [rel, content] of before) {
    const path = join(migrationsDir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

const check = run(["check"]);
if (check.status !== 0) {
  console.error(check.output);
  console.error("migrations:check failed: drizzle-kit check reported an inconsistent migration history.");
  process.exit(1);
}

const before = snapshot();
let drift = [];
try {
  const generate = run(["generate"]);
  if (generate.status !== 0) {
    console.error(generate.output);
    console.error("migrations:check failed: drizzle-kit generate exited with an error.");
    process.exitCode = 1;
  } else {
    const after = snapshot();
    drift = [...new Set([...before.keys(), ...after.keys()])].filter((rel) => {
      const a = before.get(rel);
      const b = after.get(rel);
      return !a || !b || hash(a) !== hash(b);
    });
  }
} finally {
  restore(before);
}

if (drift.length > 0) {
  console.error("migrations:check failed: the schema has changes without a migration. Run `pnpm db:generate`.");
  for (const rel of drift) console.error(`  would change: migrations/${rel.replaceAll("\\", "/")}`);
  process.exit(1);
}

if (process.env.CI) {
  const status = spawnSync("git", ["status", "--porcelain", "--", "migrations"], { cwd: root, encoding: "utf8" });
  if (status.error) throw status.error;
  if (status.stdout.trim()) {
    console.error("migrations:check failed: migrations/ has uncommitted changes in CI:");
    console.error(status.stdout);
    process.exit(1);
  }
}

if (!process.exitCode) console.log("migrations:check passed: schema and migrations are in sync.");
