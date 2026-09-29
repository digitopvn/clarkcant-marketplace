import { d1TestProject } from "../../vitest.d1.ts";

/** The SEO builders are pure; they run in the same workerd pool as every other package for one test toolchain. */
export default d1TestProject("seo");
