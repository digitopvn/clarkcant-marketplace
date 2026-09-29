import { d1TestProject } from "../../vitest.d1.ts";

/** HTTP-level tests: real Hono app, real application services, real local D1. */
export default d1TestProject("api");
