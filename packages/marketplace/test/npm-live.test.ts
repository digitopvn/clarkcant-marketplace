import { describe, expect, it } from "vitest";
import { inject } from "vitest";

import { DISCOVERY_KEYWORDS, createNpmRegistry, readTarGz, resolveVersion, verifyTarballIntegrity } from "../src";

/**
 * Talks to the real npm registry. Opt-in (`LIVE_NPM=1 pnpm test`) so the default suite stays offline and
 * deterministic; the offline suite runs the same code against real `npm pack` tarballs from a local registry.
 */
describe.skipIf(!inject("liveNpm"))("live npm registry", () => {
  const registry = createNpmRegistry();

  it("resolves an exact version, downloads it and verifies its sha512 integrity", { timeout: 30_000 }, async () => {
    const resolved = resolveVersion(await registry.fetchPackument("is-number"), "7.0.0");
    expect(resolved).toMatchObject({ name: "is-number", version: "7.0.0" });
    expect(resolved.tarballUrl).toMatch(/^https:\/\/registry\.npmjs\.org\//);

    const tarball = await registry.fetchTarball(resolved.tarballUrl);
    await expect(verifyTarballIntegrity(tarball, resolved.integrity)).resolves.toMatchObject({ algorithm: "sha512" });
    const entries = await readTarGz(tarball, { select: (path) => (path === "package/package.json" ? 64 * 1024 : null) });
    expect(JSON.parse(new TextDecoder().decode(entries[0]?.bytes ?? undefined))).toMatchObject({ version: "7.0.0" });
  });

  it("answers the discovery search", { timeout: 30_000 }, async () => {
    const page = await registry.search(`keywords:${DISCOVERY_KEYWORDS[0]}`, 0, 5);
    expect(page.total).toBeGreaterThanOrEqual(page.hits.length);
  });

  it("reports an unknown package as a rejection, not a transient failure", { timeout: 30_000 }, async () => {
    await expect(registry.fetchPackument("@clarkcant/this-package-does-not-exist-3f9c")).rejects.toMatchObject({
      code: "package_not_found",
    });
  });
});
