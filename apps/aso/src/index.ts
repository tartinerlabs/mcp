#!/usr/bin/env node
import { createAppStoreClient } from "./appstore/client.ts";
import { createProgram } from "./cli.ts";

// Runs on the user's machine so Apple sees their IP: the iTunes Search API
// allows about 20 requests a minute per IP, which shared cloud IPs exhaust.
const client = createAppStoreClient({
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: Date.now,
  onRetry: (seconds, reason) =>
    console.error(`Retrying in ${seconds}s: ${reason}`),
});

await createProgram(client).parseAsync();
