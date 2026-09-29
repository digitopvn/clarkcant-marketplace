import { NotImplementedError } from "@marketplace/contracts";
import { describe, expect, it } from "vitest";

import { discoverNpmPackages, handleIngestMessage, indexPackage } from "../src";
import { testDeps } from "./support/seed";

const deps = testDeps();

describe("indexing seams", () => {
  it("fail loudly instead of pretending to index", async () => {
    await expect(indexPackage(deps, { submissionId: "sub_1", packageName: "chart" })).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    await expect(discoverNpmPackages(deps)).rejects.toMatchObject({ code: "not_implemented", status: 501 });
    await expect(
      handleIngestMessage(deps, { type: "index-package", submissionId: "sub_1", packageName: "chart" }),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });
});
