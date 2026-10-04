import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { TestProject } from "vitest/node";

/**
 * Vitest global setup (runs in Node, before the workerd test pool starts): packs the example widget fixture, a few
 * deliberately broken variants, and one package per vendored ClarkCant manifest (`fixtures/upstream/clarkcant`) with
 * the real `npm pack`, and hands the tarball bytes to the tests through `provide`. The indexer tests then serve these
 * exact bytes from a local registry.
 */

export const FIXTURE_TARBALLS_SETUP = fileURLToPath(import.meta.url);

const REPO_ROOT = path.resolve(path.dirname(FIXTURE_TARBALLS_SETUP), "../..");
const FIXTURE_DIR = path.join(REPO_ROOT, "fixtures/widgets/example-frame-widget");
const UPSTREAM_DIR = path.join(REPO_ROOT, "fixtures/upstream/clarkcant");

export type FixtureVariant = "valid" | "nextVersion" | "missingManifest" | "invalidManifest" | "invalidServiceManifest";

/** One npm package built around a vendored ClarkCant manifest. */
export interface UpstreamPackage {
  /** The fixture's path under `fixtures/upstream/clarkcant`, without `/clarkcant.json`, e.g. `reference-apps/text-editor`. */
  fixture: string;
  name: string;
  version: string;
  /** Base64 `npm pack` output. */
  tarball: string;
}

declare module "vitest" {
  export interface ProvidedContext {
    /** Base64 `npm pack` output per variant. */
    fixtureTarballs: Record<FixtureVariant, string>;
    /** One packed package per vendored upstream manifest. */
    upstreamPackages: UpstreamPackage[];
    /** True when `LIVE_NPM=1`: opt-in tests that talk to the real npm registry. */
    liveNpm: boolean;
  }
}

/**
 * The keyword ClarkCant's package convention adds for each facet kind. Discovery needs only `clarkcant`; the facet
 * keywords are what an author's `package.json` carries, so the fixtures carry them too.
 */
const FACET_KEYWORDS: Record<string, string> = {
  ui: "clarkcant-widget",
  tools: "clarkcant-service",
  skills: "clarkcant-skill",
  prompts: "clarkcant-prompt",
  themes: "clarkcant-theme",
  setup: "clarkcant-setup",
  driver: "clarkcant-driver",
  voice: "clarkcant-voice",
};

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

interface UpstreamFile {
  path: string;
}

/**
 * Writes an npm package around one upstream manifest, the way an author would publish it: the manifest at the root, the
 * same version in `package.json`, `clarkcant` plus one keyword per facet kind, and an explicit `files` list.
 */
function upstreamPackageDir(
  root: string,
  fixture: string,
  edit?: { dirName: string; manifest: (manifest: Record<string, unknown>) => void },
): {
  dir: string;
  name: string;
  version: string;
} {
  const manifestText = readFileSync(path.join(UPSTREAM_DIR, ...fixture.split("/"), "clarkcant.json"), "utf8");
  const manifest = JSON.parse(manifestText) as {
    version: string;
    description: string;
    facets: { kind: string }[];
    publisher?: { license?: string };
  };
  const name = `@clarkcant-fixtures/${fixture.replace("/", "-")}`;
  const dir = path.join(root, "upstream", edit?.dirName ?? fixture.replace("/", "-"));
  mkdirSync(dir, { recursive: true });
  const kinds = [...new Set(manifest.facets.map((facet) => FACET_KEYWORDS[facet.kind]).filter((keyword) => keyword !== undefined))];
  writeFileSync(
    path.join(dir, "package.json"),
    `${JSON.stringify(
      {
        name,
        version: manifest.version,
        description: manifest.description,
        keywords: ["clarkcant", ...kinds],
        license: manifest.publisher?.license ?? "MIT",
        files: ["clarkcant.json"],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(path.join(dir, "clarkcant.json"), manifestText);
  if (edit) editJson(path.join(dir, "clarkcant.json"), edit.manifest);
  return { dir, name, version: manifest.version };
}

export default function setup(project: TestProject): () => void {
  const root = mkdtempSync(path.join(tmpdir(), "clarkcant-fixtures-"));
  const out = path.join(root, "out");
  mkdirSync(out);

  const invalidService = upstreamPackageDir(root, "reference-apps/connected-app", {
    dirName: "invalid-service",
    manifest: (manifest) => {
      // A capability that needs a scope the connection never asks for: well-formed, but incoherent.
      const facets = manifest.facets as { kind: string; capabilities?: { requiredScopes?: string[] }[] }[];
      const capability = facets.find((facet) => facet.kind === "tools")?.capabilities?.[0];
      if (capability) capability.requiredScopes = ["tasks.delete"];
    },
  });
  editJson(path.join(invalidService.dir, "package.json"), (json) => (json.name = "@clarkcant/example-bad-service"));

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
    invalidServiceManifest: invalidService.dir,
  };

  const tarballs = {} as Record<FixtureVariant, string>;
  for (const [key, dir] of Object.entries(packs) as [FixtureVariant, string][]) {
    tarballs[key] = npmPack(dir, out).toString("base64");
  }

  const upstream = JSON.parse(readFileSync(path.join(UPSTREAM_DIR, "UPSTREAM.json"), "utf8")) as { files: UpstreamFile[] };
  const upstreamPackages: UpstreamPackage[] = upstream.files.map((file) => {
    const fixture = file.path.replace(/\/clarkcant\.json$/, "");
    const built = upstreamPackageDir(root, fixture);
    return { fixture, name: built.name, version: built.version, tarball: npmPack(built.dir, out).toString("base64") };
  });

  if (readdirSync(out).length !== Object.keys(packs).length + upstreamPackages.length) {
    throw new Error("npm pack did not produce one tarball per package");
  }
  project.provide("fixtureTarballs", tarballs);
  project.provide("upstreamPackages", upstreamPackages);
  project.provide("liveNpm", process.env.LIVE_NPM === "1");

  return () => rmSync(root, { recursive: true, force: true });
}
