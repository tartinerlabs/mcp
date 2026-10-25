// The parts of the Workers runtime module this Worker uses; the runtime
// provides it, so nothing here is bundled.
declare module "cloudflare:workers" {
  /** Opaque here: without @cloudflare/workers-types, drizzle-orm/d1 accepts any client. */
  interface D1Database {
    prepare(query: string): unknown;
  }

  /** Text vars and secrets (core's `Env`), plus the D1 binding. */
  export const env: Record<string, string | undefined> & {
    readonly DB: D1Database;
  };

  export function waitUntil(promise: Promise<unknown>): void;
}
