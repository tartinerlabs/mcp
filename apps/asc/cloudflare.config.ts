import { bindings, defineConfig } from "cf/config";

/** Plain vars taken from the deploying shell; unset ones are left out. */
function vars(names: string[]) {
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = process.env[name];
      return value ? [[name, bindings.text(value)]] : [];
    }),
  );
}

// A deploy replaces the Worker's plain vars, and the Worker cannot start
// without BETTER_AUTH_URL, so refuse to build a config that leaves it out.
if (!process.env.BETTER_AUTH_URL) {
  throw new Error(
    "Set BETTER_AUTH_URL (and any optional vars) in the environment before building or deploying.",
  );
}

// Nothing account-specific is hardcoded: the D1 id, Worker name and URLs come
// from the environment (cf picks the account from CLOUDFLARE_ACCOUNT_ID).
export default defineConfig({
  worker: {
    name: process.env.WORKER_NAME ?? "app-store-connect-mcp",
    compatibilityDate: "2026-10-01",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "./src/index.ts",
    observability: { enabled: true },
    env: {
      DB: bindings.d1({ id: process.env.CLOUDFLARE_D1_DATABASE_ID }),
      BETTER_AUTH_SECRET: bindings.secret(),
      GOOGLE_CLIENT_ID: bindings.secret(),
      GOOGLE_CLIENT_SECRET: bindings.secret(),
      ...vars(["BETTER_AUTH_URL", "LOG_LEVEL"]),
    },
  },
});
