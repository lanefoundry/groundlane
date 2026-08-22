// Stubs the `cloudflare:workers` built-in for plain Node test runs.
//
// @cloudflare/workers-oauth-provider imports { WorkerEntrypoint } from
// "cloudflare:workers" at module load time (used only for an internal
// instanceof check against handlers we never pass — this project's
// apiHandler/defaultHandler are always plain objects). That module only
// exists inside the real Workers runtime (workerd), not Node, so the
// unmodified import crashes `node --test` with ERR_UNSUPPORTED_ESM_URL_SCHEME
// before any test code runs. Registered via node-test-setup.mjs.
const STUB_URL = "cloudflare-workers-stub:main";

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") {
    return { url: STUB_URL, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url === STUB_URL) {
    return {
      format: "module",
      shortCircuit: true,
      source: "export class WorkerEntrypoint {}\nexport class DurableObject {}\nexport default {};",
    };
  }
  return nextLoad(url, context);
}
