#!/usr/bin/env node
// Runs the TypeScript sources directly through tsx; the CLI is a private workspace tool, not a published build.
import { register } from "tsx/esm/api";

register();
const { main } = await import("../src/main.ts");
process.exitCode = await main(process.argv.slice(2));
