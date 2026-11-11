import type { AuthInfo } from "@modelcontextprotocol/server";
import { createMcpEndpoint } from "@repo/core/http";
import { getUserBingClient } from "./bing/client.ts";
import { auth } from "./lib/auth.ts";
import { createServer } from "./server.ts";
import { CredentialsError } from "./utils/errors.ts";
import { logger } from "./utils/logger.ts";

function userIdOf(authInfo: AuthInfo | undefined): string {
  const userId = authInfo?.extra?.userId;
  if (typeof userId !== "string") {
    throw new CredentialsError(
      "The request is not linked to a signed-in user. Reconnect the server in your MCP client.",
    );
  }
  return userId;
}

const connectUrl = new URL("/connect", process.env.BETTER_AUTH_URL).href;

export const handleMcp = createMcpEndpoint({
  auth,
  logger,
  createServer: (authInfo) =>
    createServer(() => getUserBingClient(userIdOf(authInfo), auth, connectUrl)),
});
