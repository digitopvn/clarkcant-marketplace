#!/usr/bin/env node
// Pins the marketplace's manifest mirror to ClarkCant.
//
//   node scripts/sync-clarkcant-fixtures.mjs --from ../clarkcant            refresh fixtures/upstream/clarkcant/
//   node scripts/sync-clarkcant-fixtures.mjs --from ../clarkcant --accept   ...also when ClarkCant's contract changed
//   node scripts/sync-clarkcant-fixtures.mjs --from ../clarkcant --check [--report <file>]
//                                                                           compare only; writes nothing
//
// What is recorded, from the checkout's HEAD commit (never its working tree):
// - every `clarkcant.json` ClarkCant ships (reference apps, themes, its own e2e fixtures) and the manifest its CLI
//   writes for `clark widget init --template blank`, each with ClarkCant's own verdict on it;
// - verdicts.json: a corpus of hostile variants of those manifests, each with the verdict of ClarkCant's real
//   `parseManifest`, so `pnpm contract:check` proves the mirror rejects what ClarkCant rejects, not only that it
//   accepts ClarkCant's examples;
// - the sha256 of the ClarkCant sources the mirror copies.
//
// ClarkCant's code runs from the checkout, so it needs `pnpm install` there. A refresh refuses (exit 1) when a
// contract source changed or a recorded verdict flipped, unless `--accept` is passed after the mirror was reviewed and
// updated. `--check` exits 1 when anything differs from what is recorded; the scheduled upstream-contract workflow
// runs it against ClarkCant's main branch.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixturesDir = join(root, "fixtures", "upstream", "clarkcant");
const upstreamFile = join(fixturesDir, "UPSTREAM.json");
const verdictsFile = join(fixturesDir, "verdicts.json");
/** Top-level fixture directories this script owns; everything in them is rewritten on refresh. */
const FIXTURE_DIRS = ["reference-apps", "themes", "e2e", "templates"];

/** The files ClarkCant's manifest contract lives in. Hashed, not vendored: they are what the mirror is reviewed against. */
const CONTRACT_SOURCES = [
  "packages/contracts/src/install.ts",
  "packages/contracts/src/primitives.ts",
  "packages/contracts/src/grants.ts",
  "packages/contracts/src/network-origin.ts",
  "packages/contracts/src/browser-token.ts",
  "packages/contracts/src/service-egress.ts",
  "packages/contracts/src/service-connection.ts",
  "packages/contracts/src/service-artifacts.ts",
  "packages/contracts/src/resource-profiles.ts",
  "packages/core/src/widget-package.ts",
];
/** ClarkCant's manifest reader: `parseManifest` decides whether ClarkCant reads a package's manifest. */
const READER_MODULE = "packages/core/src/widget-package.ts";
/** Working-tree paths whose code runs here (the CLI and the reader); they must match HEAD. */
const EXECUTED_PATHS = ["packages/widget-cli", "packages/contracts", "packages/core"];
const BLANK_COMMAND = ["packages/widget-cli/src/cli.ts", "widget", "init", "<tmp>/my-widget", "--template", "blank"];

/** Where each shipped manifest is vendored, by its path in ClarkCant. */
const SOURCE_LAYOUT = [
  { pattern: /^examples\/reference-apps\/([^/]+)\/clarkcant\.json$/, target: (m) => `reference-apps/${m[1]}/clarkcant.json` },
  { pattern: /^examples\/themes\/([^/]+)\/clarkcant\.json$/, target: (m) => `themes/${m[1]}/clarkcant.json` },
  {
    pattern: /^apps\/web\/e2e\/fixtures\/([^/]+)\/(?:([^/]+)\/)?clarkcant\.json$/,
    target: (m) => `e2e/${m[2] ? `${m[1]}-${m[2]}` : m[1]}/clarkcant.json`,
  },
];

/**
 * Manifests the hostile corpus is derived from: the shapes ClarkCant reads (widget, service with egress, account
 * connection, input artifacts, declarative theme) without multiplying near-identical files.
 */
const CORPUS_BASES = [
  "templates/blank/clarkcant.json",
  "reference-apps/connected-app/clarkcant.json",
  "reference-apps/image-generator/clarkcant.json",
  "reference-apps/media-render/clarkcant.json",
  "themes/neo-brutalism/clarkcant.json",
];

class SyncError extends Error {}

function parseArgs(argv) {
  const value = (flag) => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const from = value("--from");
  if (!from) {
    throw new SyncError(
      "usage: node scripts/sync-clarkcant-fixtures.mjs --from <ClarkCant checkout> [--accept | --check [--report <file>]]",
    );
  }
  const check = argv.includes("--check");
  const accept = argv.includes("--accept");
  if (check && accept) throw new SyncError("--check and --accept cannot be combined");
  return { from: resolve(from), check, accept, report: value("--report") };
}

function git(checkout, args) {
  return execFileSync("git", ["-C", checkout, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Line endings are normalised so a checkout with CRLF conversion hashes the same as the commit. */
function normalise(text) {
  return text.replace(/\r\n/g, "\n");
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function repositoryOf(checkout) {
  const url = git(checkout, ["remote", "get-url", "origin"]).trim();
  const match = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
  return match ? match[1] : url;
}

function runNode(checkout, args, input) {
  try {
    return execFileSync(process.execPath, args, {
      cwd: checkout,
      encoding: "utf8",
      input: input ?? "",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (error) {
    const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : String(error);
    throw new SyncError(`ClarkCant's code failed to run in ${checkout} (run \`pnpm install\` there first)\n${stderr}`);
  }
}

function generateBlankTemplate(checkout) {
  const tmp = mkdtempSync(join(tmpdir(), "clarkcant-blank-"));
  try {
    const target = join(tmp, "my-widget");
    runNode(checkout, BLANK_COMMAND.map((arg) => (arg === "<tmp>/my-widget" ? target : arg)));
    return normalise(readFileSync(join(target, "clarkcant.json"), "utf8"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Runs ClarkCant's own `parseManifest` over every input and returns its verdicts, in order. */
function upstreamVerdicts(checkout, inputs) {
  const tmp = mkdtempSync(join(tmpdir(), "clarkcant-verdicts-"));
  try {
    const evaluator = join(tmp, "evaluate.mjs");
    writeFileSync(
      evaluator,
      [
        'import { pathToFileURL } from "node:url";',
        "const { parseManifest } = await import(pathToFileURL(process.argv[2]).href);",
        'let text = "";',
        "for await (const chunk of process.stdin) text += chunk;",
        "const verdicts = JSON.parse(text).map((input) => {",
        "  const result = parseManifest(input);",
        '  return result.ok ? { ok: true } : { ok: false, problem: result.problems[0] ?? "" };',
        "});",
        "process.stdout.write(JSON.stringify(verdicts));",
      ].join("\n"),
    );
    const output = runNode(checkout, [evaluator, join(checkout, READER_MODULE)], JSON.stringify(inputs));
    const verdicts = JSON.parse(output);
    if (!Array.isArray(verdicts) || verdicts.length !== inputs.length) {
      throw new SyncError("ClarkCant's reader returned the wrong number of verdicts");
    }
    return verdicts;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- The hostile corpus -------------------------------------------------------------------------------------------

/**
 * Replacements for every string: emptiness, path escapes (relative, absolute, Windows), origins that are not canonical
 * or not HTTP(S), a credential-bearing header name, foreign and malformed refs, and a wrong type.
 */
const STRING_VALUES = [
  "",
  "../escape",
  "/abs",
  "C:\\x",
  "https://evil.example",
  "https://X.example/",
  "wss://a.example",
  "Cookie",
  "com.example.other.thing@1",
  "a@0",
  7,
];
const NUMBER_VALUES = [0, -1, 1.5, "1"];
const BOOLEAN_VALUES = ["true", null];
const SCHEMA_VERSIONS = [1, 2, 3, "2", null];

function* walk(value, path = []) {
  yield { path, value };
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) yield* walk(value[index], [...path, index]);
  } else if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) yield* walk(value[key], [...path, key]);
  }
}

/** Deterministic hostile variants of one manifest: deletions, wrong types, path and namespace escapes, duplicates. */
function mutationsOf(manifest) {
  const cases = [];
  for (const { path, value } of walk(manifest)) {
    const key = path.at(-1);
    if (typeof key === "string") cases.push({ path, op: "delete" });
    if (key === "schemaVersion") {
      for (const replacement of SCHEMA_VERSIONS) cases.push({ path, op: "set", value: replacement });
      continue;
    }
    if (typeof value === "string") {
      for (const replacement of STRING_VALUES) cases.push({ path, op: "set", value: replacement });
    } else if (typeof value === "number") {
      for (const replacement of NUMBER_VALUES) cases.push({ path, op: "set", value: replacement });
    } else if (typeof value === "boolean") {
      for (const replacement of BOOLEAN_VALUES) cases.push({ path, op: "set", value: replacement });
    } else if (Array.isArray(value)) {
      if (path.length > 0) cases.push({ path, op: "set", value: [] });
      if (value.length > 0) cases.push({ path, op: "duplicate" });
    } else if (value !== null && typeof value === "object") {
      if (path.length > 0) cases.push({ path, op: "set", value: null });
      cases.push({ path, op: "add", key: "unexpectedField", value: true });
    }
  }
  return cases;
}

/** The operation `packages/contracts/test/upstream-contract.test.ts` replays; keep the two in step. */
function applyMutation(manifest, mutation) {
  const copy = JSON.parse(JSON.stringify(manifest));
  if (mutation.path.length === 0) {
    if (mutation.op === "add") copy[mutation.key] = mutation.value;
    return copy;
  }
  const parent = mutation.path.slice(0, -1).reduce((node, key) => node[key], copy);
  const key = mutation.path.at(-1);
  const target = parent[key];
  if (mutation.op === "delete") delete parent[key];
  else if (mutation.op === "set") parent[key] = mutation.value;
  else if (mutation.op === "duplicate") target.push(JSON.parse(JSON.stringify(target[0])));
  else if (mutation.op === "add") target[mutation.key] = mutation.value;
  return copy;
}

function caseId(entry) {
  const detail = entry.op === "set" ? `=${JSON.stringify(entry.value)}` : entry.op === "add" ? `+${entry.key}` : "";
  return `${entry.base}#/${entry.path.join("/")}#${entry.op}${detail}`;
}

// ---- Reading ClarkCant --------------------------------------------------------------------------------------------

/** The sha256 of a committed file, or null when the commit no longer has it (renamed or removed upstream). */
function sha256OfCommitted(show, path) {
  let text;
  try {
    text = show(path);
  } catch {
    return null;
  }
  return sha256(text);
}

function readUpstream(from) {
  if (!existsSync(join(from, READER_MODULE))) {
    throw new SyncError(`${from} does not look like a ClarkCant checkout (no ${READER_MODULE})`);
  }
  const dirty = git(from, ["status", "--porcelain", "--", ...EXECUTED_PATHS]).trim();
  if (dirty) throw new SyncError(`the checkout has uncommitted changes in code this script runs:\n${dirty}`);
  const commit = git(from, ["rev-parse", "HEAD"]).trim();
  const show = (path) => normalise(git(from, ["show", `${commit}:${path}`]));

  const files = [];
  for (const source of git(from, ["ls-tree", "-r", "--name-only", commit]).split("\n").sort()) {
    for (const layout of SOURCE_LAYOUT) {
      const match = layout.pattern.exec(source);
      if (match) files.push({ path: layout.target(match), source, content: show(source) });
    }
  }
  if (!files.some((file) => file.path.startsWith("reference-apps/"))) {
    throw new SyncError(`commit ${commit} has no examples/reference-apps/*/clarkcant.json`);
  }
  files.push({
    path: "templates/blank/clarkcant.json",
    source: `generated: node ${BLANK_COMMAND.join(" ")}`,
    content: generateBlankTemplate(from),
  });
  const parsed = new Map();
  for (const file of files) {
    try {
      parsed.set(file.path, JSON.parse(file.content));
    } catch {
      throw new SyncError(`${file.source} is not valid JSON`);
    }
  }

  const corpus = [];
  for (const base of CORPUS_BASES) {
    const manifest = parsed.get(base);
    if (!manifest) throw new SyncError(`corpus base ${base} is not among the synced manifests`);
    for (const mutation of mutationsOf(manifest)) corpus.push({ base, ...mutation });
  }
  const fileVerdicts = upstreamVerdicts(
    from,
    files.map((file) => parsed.get(file.path)),
  );
  const corpusVerdicts = upstreamVerdicts(
    from,
    corpus.map((entry) => applyMutation(parsed.get(entry.base), entry)),
  );

  return {
    repository: repositoryOf(from),
    commit,
    files: files.map((file, index) => ({ ...file, accepted: fileVerdicts[index].ok, problem: fileVerdicts[index].problem })),
    contractSources: CONTRACT_SOURCES.map((source) => ({ source, sha256: sha256OfCommitted(show, source) })),
    cases: corpus.map((entry, index) => ({
      id: caseId(entry),
      ...entry,
      accepted: corpusVerdicts[index].ok,
      problem: corpusVerdicts[index].problem,
    })),
  };
}

function renderVerdicts(cases) {
  const lines = cases.map(({ base, path, op, key, value, accepted }) =>
    JSON.stringify({
      base,
      path,
      op,
      ...(op === "add" ? { key } : {}),
      ...(op === "set" || op === "add" ? { value } : {}),
      accepted,
    }),
  );
  return [
    "{",
    `"note": "Generated by scripts/sync-clarkcant-fixtures.mjs from ClarkCant's parseManifest. Do not edit by hand.",`,
    '"cases": [',
    lines.join(",\n"),
    "]",
    "}",
    "",
  ].join("\n");
}

// ---- Comparing with what is recorded ------------------------------------------------------------------------------

function readRecorded() {
  if (!existsSync(upstreamFile)) return null;
  const upstream = JSON.parse(readFileSync(upstreamFile, "utf8"));
  const verdicts = existsSync(verdictsFile) ? JSON.parse(readFileSync(verdictsFile, "utf8")) : { cases: [] };
  return { upstream, cases: verdicts.cases.map((entry) => ({ id: caseId(entry), accepted: entry.accepted })) };
}

function compare(recorded, current) {
  const differences = { contractSources: [], files: [], fileVerdicts: [], flipped: [], added: 0, removed: 0 };
  if (!recorded) return differences;
  const sources = new Map((recorded.upstream.contractSources ?? []).map((entry) => [entry.source, entry.sha256]));
  differences.contractSources = current.contractSources
    .filter((entry) => sources.get(entry.source) !== entry.sha256)
    .map((entry) => `${entry.sha256 === null ? "removed" : sources.has(entry.source) ? "changed" : "added"}: ${entry.source}`);

  const files = new Map((recorded.upstream.files ?? []).map((entry) => [entry.path, entry]));
  for (const file of current.files) {
    const before = files.get(file.path);
    if (!before || before.sha256 !== sha256(file.content)) differences.files.push(`${before ? "changed" : "added"}: ${file.source}`);
    if (before && before.accepted !== undefined && before.accepted !== file.accepted) {
      differences.fileVerdicts.push(`${file.source}: ClarkCant now ${file.accepted ? "accepts it" : `rejects it (${file.problem})`}`);
    }
    files.delete(file.path);
  }
  for (const gone of files.values()) differences.files.push(`removed: ${gone.source}`);

  const cases = new Map(recorded.cases.map((entry) => [entry.id, entry.accepted]));
  for (const entry of current.cases) {
    if (!cases.has(entry.id)) differences.added += 1;
    else if (cases.get(entry.id) !== entry.accepted) {
      differences.flipped.push(`${entry.id}: ClarkCant now ${entry.accepted ? "accepts it" : `rejects it (${entry.problem})`}`);
    }
    cases.delete(entry.id);
  }
  differences.removed = cases.size;
  return differences;
}

function describe(differences, recorded, current) {
  const lines = [`Compared ${current.repository}@${current.commit} with the pin ${recorded?.upstream.commit ?? "(none)"}.`, ""];
  const section = (title, items) => {
    if (items.length === 0) return;
    lines.push(`### ${title}`, "", ...items.slice(0, 50).map((item) => `- ${item}`));
    if (items.length > 50) lines.push(`- ... and ${items.length - 50} more`);
    lines.push("");
  };
  section("Contract sources changed", differences.contractSources);
  section("Shipped manifests changed", differences.files);
  section("Verdicts on shipped manifests flipped", differences.fileVerdicts);
  section("Verdicts on hostile variants flipped", differences.flipped);
  if (differences.added || differences.removed) {
    lines.push(`Hostile corpus: ${differences.added} new and ${differences.removed} dropped cases (their base manifests changed).`, "");
  }
  return lines.join("\n");
}

function hasDrift(differences) {
  return (
    differences.contractSources.length > 0 ||
    differences.files.length > 0 ||
    differences.fileVerdicts.length > 0 ||
    differences.flipped.length > 0 ||
    differences.added > 0 ||
    differences.removed > 0
  );
}

function write(current) {
  for (const entry of FIXTURE_DIRS) rmSync(join(fixturesDir, entry), { recursive: true, force: true });
  for (const file of current.files) {
    const target = join(fixturesDir, ...file.path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }
  const verdicts = renderVerdicts(current.cases);
  writeFileSync(verdictsFile, verdicts);
  const upstream = {
    repository: current.repository,
    commit: current.commit,
    note: "Generated by scripts/sync-clarkcant-fixtures.mjs. Do not edit by hand; `pnpm contract:check` verifies it.",
    files: current.files.map(({ path, source, content, accepted }) => ({ path, source, sha256: sha256(content), accepted })),
    verdicts: { path: "verdicts.json", sha256: sha256(verdicts), cases: current.cases.length },
    contractSources: current.contractSources,
  };
  writeFileSync(upstreamFile, `${JSON.stringify(upstream, null, 2)}\n`);
}

function main(options) {
  const current = readUpstream(options.from);
  const recorded = readRecorded();
  const differences = compare(recorded, current);
  const summary = describe(differences, recorded, current);

  if (options.check) {
    if (options.report) writeFileSync(options.report, `${summary}\n`);
    if (hasDrift(differences)) {
      console.error(`ClarkCant's manifest contract moved away from the pin.\n\n${summary}`);
      process.exitCode = 1;
    } else {
      console.info(`no drift: ${current.repository}@${current.commit} matches the pin (${current.cases.length} hostile cases)`);
    }
    return;
  }

  const contractChanged =
    differences.contractSources.length > 0 || differences.fileVerdicts.length > 0 || differences.flipped.length > 0;
  if (contractChanged && !options.accept) {
    throw new SyncError(
      `ClarkCant's manifest contract changed; nothing was written.\n\n${summary}\n` +
        "Port the change to packages/contracts/src/manifest.ts with a test, then re-run with --accept.",
    );
  }
  const removed = current.contractSources.filter((entry) => entry.sha256 === null).map((entry) => entry.source);
  if (removed.length > 0) {
    throw new SyncError(
      `ClarkCant no longer has ${removed.join(", ")}; nothing was written. Find where that contract moved, port any ` +
        "change to packages/contracts/src/manifest.ts, and update CONTRACT_SOURCES in this script.",
    );
  }
  write(current);
  console.info(`synced ${current.files.length} manifests and ${current.cases.length} hostile cases from ${current.repository}@${current.commit}`);
  if (hasDrift(differences)) console.info(summary);
  console.info("next: pnpm contract:check");
}

let options = null;
try {
  options = parseArgs(process.argv.slice(2));
  main(options);
} catch (error) {
  const message = error instanceof SyncError ? error.message : (error?.stack ?? String(error));
  console.error(`sync-clarkcant-fixtures: ${message}`);
  process.exitCode = 1;
  // A check that cannot run is drift too (a moved reader, a renamed export, a crash): the report still says why, so
  // the scheduled workflow can open its tracking issue.
  if (options?.check && options.report) {
    writeFileSync(
      options.report,
      `The check could not run against ${options.from}; ClarkCant's contract may have moved.\n\n\`\`\`\n${message}\n\`\`\`\n`,
    );
  }
}
