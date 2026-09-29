import { describe, expect, it } from "vitest";

import {
  clarkcantManifestSchema,
  normalizeManifest,
  packageManifestSchema,
  widgetPackageManifestSchema,
} from "../src";
import frameWidget from "./fixtures/frame-widget.clarkcant.json" with { type: "json" };
import installManifest from "./fixtures/install-manifest.json" with { type: "json" };

describe("ClarkCant manifest mirror", () => {
  it("accepts ClarkCant's own widget-package fixture and normalizes it", () => {
    const parsed = clarkcantManifestSchema.parse(frameWidget);
    expect(widgetPackageManifestSchema.safeParse(frameWidget).success).toBe(true);
    expect(packageManifestSchema.safeParse(frameWidget).success).toBe(false);

    expect(normalizeManifest(parsed)).toMatchObject({
      dialect: "widget-package",
      id: "com.example.frame-widget",
      displayName: "Frame widget",
      facets: [
        {
          kind: "widget",
          entry: "widgets/main/index.html",
          isolation: "isolated-ui",
          renderer: null,
          widgetId: "com.example.frame-widget.main@1",
        },
      ],
      publisher: { id: "example", sourceUrl: "https://example.com", license: "MIT" },
    });
  });

  it("accepts the install-contract dialect and keeps declared filesystem access", () => {
    const normalized = normalizeManifest(clarkcantManifestSchema.parse(installManifest));
    expect(normalized.dialect).toBe("install");
    expect(normalized.displayName).toBeNull();
    expect(normalized.facets.map((facet) => [facet.kind, facet.isolation, facet.renderer])).toEqual([
      ["ui", "isolated-ui", "isolated-app"],
      ["tools", "service", null],
    ]);
    expect(normalized.permissions.filesystem).toEqual([{ path: "cache", access: "write" }]);
  });

  it("rejects unknown fields, bad ranges, bad capability refs, bad versions and bad isolation lanes", () => {
    const base = installManifest;
    expect(packageManifestSchema.safeParse({ ...base, extra: true }).success).toBe(false);
    expect(packageManifestSchema.safeParse({ ...base, hostApi: { min: 3, max: 1 } }).success).toBe(false);
    expect(packageManifestSchema.safeParse({ ...base, requestedCapabilities: ["Data"] }).success).toBe(false);
    expect(packageManifestSchema.safeParse({ ...base, version: "latest" }).success).toBe(false);
    const badLane = { ...base, facets: [{ kind: "ui", entry: "x", isolation: "root" }] };
    expect(packageManifestSchema.safeParse(badLane).success).toBe(false);
    expect(clarkcantManifestSchema.safeParse({ ...frameWidget, schemaVersion: 2 }).success).toBe(false);
  });
});
