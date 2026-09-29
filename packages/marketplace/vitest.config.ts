import { d1TestProject } from "../../vitest.d1.ts";
import { FIXTURE_TARBALLS_SETUP } from "./fixture-tarballs.setup.ts";

/**
 * Service tests run inside workerd against a real (local) D1 database with the committed migrations applied, so SQL,
 * FTS5 and constraint behaviour match production rather than a mock. The global setup packs the example widget
 * fixture with `npm pack` so indexing tests run against real tarball bytes.
 */
export default d1TestProject("marketplace", { globalSetup: [FIXTURE_TARBALLS_SETUP] });
