#!/usr/bin/env node
/**
 * Indexes a real package tarball into the LOCAL development D1 database and R2 bucket, through the same pipeline
 * the jobs Worker runs (integrity check, untar, manifest validation, README sanitizing, previews, social card, FTS).
 *
 *   pnpm index:local <name>@<version> --tarball <path/to/package.tgz>
 *
 * The tarball is served by an in-process npm-compatible registry whose packument is derived from the tarball
 * itself, so nothing is fetched from or published to npm. Bindings come from apps/web/wrangler.jsonc in local mode
 * (`wrangler getPlatformProxy`), sharing state with `pnpm dev` and `pnpm db:migrate:local`. Never touches remote
 * resources. Run with tsx (see package.json) because it imports the TypeScript workspace sources.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { getPlatformProxy } from "wrangler";

import {
  createLocalRegistryFetch,
  createMarketplaceDeps,
  createNpmRegistry,
  createSystemSubmission,
  indexPackage,
} from "../packages/marketplace/src/index.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB_DIR = path.join(ROOT, "apps", "web");
const LOCAL_REGISTRY = "https://registry.local.invalid/";
const CLI_ACTOR = { type: "system", id: "cli.index-local" };
const USAGE = "usage: pnpm index:local <name>@<version> --tarball <path/to/package.tgz>";

function fail(message) {
  console.error(`index:local: ${message}`);
  process.exit(1);
}

function parseCoordinate(value) {
  const at = value.lastIndexOf("@");
  if (at <= 0) fail(`expected <name>@<version>, got "${value}"\n${USAGE}`);
  return { name: value.slice(0, at), version: value.slice(at + 1) };
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { tarball: { type: "string" }, help: { type: "boolean", short: "h" } },
});
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
if (positionals.length !== 1 || !values.tarball) fail(USAGE);

const { name, version } = parseCoordinate(positionals[0]);
const tarballPath = path.resolve(process.cwd(), values.tarball);
const bytes = new Uint8Array(await readFile(tarballPath).catch((error) => fail(`cannot read ${tarballPath}: ${error.message}`)));

const proxy = await getPlatformProxy({
  configPath: path.join(WEB_DIR, "wrangler.jsonc"),
  persist: { path: path.join(WEB_DIR, ".wrangler", "state", "v3") },
  remoteBindings: false,
});

let exitCode = 0;
try {
  const { DB, MEDIA } = proxy.env;
  if (!DB || !MEDIA) fail("apps/web/wrangler.jsonc must declare the DB and MEDIA bindings");
  const deps = createMarketplaceDeps({ d1: DB, media: MEDIA });

  const fetch = await createLocalRegistryFetch(LOCAL_REGISTRY, [{ bytes }]);
  const registry = createNpmRegistry({ baseUrl: LOCAL_REGISTRY, fetch });
  const packument = await registry.fetchPackument(name).catch(() => null);
  if (!packument?.versions?.[version]) {
    fail(`${tarballPath} does not contain ${name}@${version} (check package.json name and version)`);
  }

  const submissionId = await createSystemSubmission(deps, {
    name,
    version,
    actor: CLI_ACTOR,
    action: "package.submitted",
    source: "local-cli",
  });
  const result = await indexPackage(deps, { submissionId, packageName: name }, { registry });
  if (result.status === "indexed") {
    console.info(
      `indexed ${name}@${result.version} (${result.created ? "new version" : "already indexed, unchanged"}); ` +
        `submission ${submissionId}`,
    );
    console.info(`view it at http://localhost:4321/packages/${name} (or the port your dev server uses)`);
  } else {
    console.error(`rejected ${name}@${version}: ${result.code}: ${result.reason}`);
    exitCode = 2;
  }
} catch (error) {
  console.error("index:local failed:", error);
  if (String(error?.message ?? "").includes("no such table")) {
    console.error("Apply the local migrations first: pnpm db:migrate:local");
  }
  exitCode = 1;
} finally {
  await proxy.dispose();
}
process.exit(exitCode);
