import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { TestProject } from "vitest/node";

/**
 * Vitest global setup (runs in Node, before the workerd test pool starts): packs the example widget fixture, plus a
 * few deliberately broken variants, with the real `npm pack`, and hands the tarball bytes to the tests through
 * `provide("fixtureTarballs")`. The indexer tests then serve these exact bytes from a local registry.
 */

export const FIXTURE_TARBALLS_SETUP = fileURLToPath(import.meta.url);

const FIXTURE_DIR = path.resolve(path.dirname(FIXTURE_TARBALLS_SETUP), "../../fixtures/widgets/example-frame-widget");

export type FixtureVariant = "valid" | "nextVersion" | "missingManifest" | "invalidManifest";

declare module "vitest" {
  export interface ProvidedContext {
    /** Base64 `npm pack` output per variant. */
    fixtureTarballs: Record<FixtureVariant, string>;
    /** True when `LIVE_NPM=1`: opt-in tests that talk to the real npm registry. */
    liveNpm: boolean;
  }
}

function npmPack(packageDir: string, destination: string): Buffer {
  // `shell` is required on Windows, where npm is a .cmd shim; the arguments are fixed strings.
  const output = execFileSync("npm", ["pack", "--json", "--pack-destination", destination], {
    cwd: packageDir,
    shell: process.platform === "win32",
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [result] = JSON.parse(output.slice(output.indexOf("["))) as { filename: string }[];
  if (!result) throw new Error(`npm pack produced no tarball for ${packageDir}`);
  return readFileSync(path.join(destination, path.basename(result.filename)));
}

function variant(root: string, name: string, edit: (dir: string) => void): string {
  const dir = path.join(root, name);
  cpSync(FIXTURE_DIR, dir, { recursive: true });
  edit(dir);
  return dir;
}

function editJson(file: string, edit: (json: Record<string, unknown>) => void): void {
  const json = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  edit(json);
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
}

export default function setup(project: TestProject): () => void {
  const root = mkdtempSync(path.join(tmpdir(), "clarkcant-fixtures-"));
  const out = path.join(root, "out");
  mkdirSync(out);

  const packs: Record<FixtureVariant, string> = {
    valid: FIXTURE_DIR,
    nextVersion: variant(root, "next-version", (dir) => {
      editJson(path.join(dir, "package.json"), (json) => (json.version = "1.1.0"));
      editJson(path.join(dir, "clarkcant.json"), (json) => (json.version = "1.1.0"));
    }),
    missingManifest: variant(root, "missing-manifest", (dir) => {
      rmSync(path.join(dir, "clarkcant.json"));
      editJson(path.join(dir, "package.json"), (json) => {
        json.name = "@clarkcant/example-no-manifest";
      });
    }),
    invalidManifest: variant(root, "invalid-manifest", (dir) => {
      editJson(path.join(dir, "package.json"), (json) => {
        json.name = "@clarkcant/example-bad-manifest";
      });
      editJson(path.join(dir, "clarkcant.json"), (json) => {
        const facets = json.facets as Record<string, unknown>[];
        if (facets[0]) facets[0].isolation = "root-access";
      });
    }),
  };

  const tarballs = {} as Record<FixtureVariant, string>;
  for (const [key, dir] of Object.entries(packs) as [FixtureVariant, string][]) {
    tarballs[key] = npmPack(dir, out).toString("base64");
  }
  if (readdirSync(out).length !== Object.keys(packs).length) throw new Error("npm pack did not produce one tarball per variant");
  project.provide("fixtureTarballs", tarballs);
  project.provide("liveNpm", process.env.LIVE_NPM === "1");

  return () => rmSync(root, { recursive: true, force: true });
}
