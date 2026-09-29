// Lets Node import the API package, whose admin router reads `env` from `cloudflare:workers` at request time.
// Only the OpenAPI document is generated here, so an empty `env` is the whole Workers surface that is needed.
import { register } from "node:module";

const stubUrl = new URL("./cloudflare-workers-stub.mjs", import.meta.url).href;
const hooks = `
export async function resolve(specifier, context, next) {
  if (specifier === "cloudflare:workers") return { url: ${JSON.stringify(stubUrl)}, shortCircuit: true };
  return next(specifier, context);
}`;
register(`data:text/javascript,${encodeURIComponent(hooks)}`);
