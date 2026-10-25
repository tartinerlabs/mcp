import {
  createMcpHandler,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import { createAppStoreClient } from "./appstore/client.ts";
import { createServer } from "./server.ts";
import { logger } from "./utils/logger.ts";

// Serves 2025-era clients too (the default `legacy: "stateless"`): without
// sign-in, nothing ties this server to the 2026-07-28 protocol.
const handler = createMcpHandler(
  () => createServer(() => createAppStoreClient()),
  {
    onerror: (error) =>
      logger.error(
        { errorName: error.name, errorMessage: error.message },
        "MCP HTTP error",
      ),
  },
);

/**
 * The MCP endpoint, open without sign-in: every tool reads public App Store
 * search results. Requests from web pages (with an Origin) are refused.
 */
export async function handleMcp(request: Request): Promise<Response> {
  const badOrigin = originValidationResponse(request, []);
  if (badOrigin) return badOrigin;
  return handler.fetch(request);
}
