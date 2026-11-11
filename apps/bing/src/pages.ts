import { createPages } from "@repo/core/pages";
import { createConnectPages } from "./connect.ts";
import { auth } from "./lib/auth.ts";
import { logger } from "./utils/logger.ts";

export const { signInPage, consentPage } = createPages({
  auth,
  logger,
  serverName: "this Bing Webmaster MCP server",
  access: "read-only access to the Bing Webmaster Tools account you connect",
});

export const { connectPage, disconnect } = createConnectPages({ auth, logger });
