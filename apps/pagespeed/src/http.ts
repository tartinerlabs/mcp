import { createMcpEndpoint } from "@repo/core/http";
import { createPageSpeedClient } from "./google/client.ts";
import { auth } from "./lib/auth.ts";
import { createServer } from "./server.ts";
import { logger } from "./utils/logger.ts";

export const handleMcp = createMcpEndpoint({
  auth,
  logger,
  // Vercel's system URLs, so deployment URLs pass Host validation.
  allowedHosts: [
    process.env.VERCEL_URL,
    process.env.VERCEL_BRANCH_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
  ],
  createServer: () => createServer(createPageSpeedClient),
});
