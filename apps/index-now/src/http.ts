import {
  createMcpHandler,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import {
  createIndexNowClient,
  type SubmissionWorkflow,
} from "./indexnow/client.ts";
import { createServer } from "./server.ts";
import { logger } from "./utils/logger.ts";

/**
 * The MCP endpoint, open without sign-in: the site's key file is what
 * authorises a submission. Requests from web pages (with an Origin) are refused.
 */
export async function handleMcp(
  request: Request,
  workflow: SubmissionWorkflow,
): Promise<Response> {
  const badOrigin = originValidationResponse(request, []);
  if (badOrigin) return badOrigin;
  // Built per request, as the Workflow binding arrives with each request's env.
  // Serves 2025-era clients too (the default `legacy: "stateless"`): without
  // sign-in, nothing ties this server to the 2026-07-28 protocol.
  const handler = createMcpHandler(
    () => createServer(() => createIndexNowClient(workflow)),
    {
      onerror: (error) =>
        logger.error(
          { errorName: error.name, errorMessage: error.message },
          "MCP HTTP error",
        ),
    },
  );
  return handler.fetch(request);
}
