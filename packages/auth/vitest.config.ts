import { d1TestProject } from "../../vitest.d1.ts";

/**
 * Service tests run inside workerd against a real (local) D1 database with the committed migrations applied, so SQL,
 * FTS5 and constraint behaviour match production rather than a mock.
 */
export default d1TestProject("auth");
