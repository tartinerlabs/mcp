import { Hono } from "hono";
import { handleMcp } from "./http.ts";
import { auth } from "./lib/auth.ts";
import { connectPage, consentPage, disconnect, signInPage } from "./pages.ts";

const app = new Hono();

app.get("/", (c) =>
  c.json({ name: "bing-webmaster-mcp", status: "ok", mcp: "/mcp" }),
);

app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));
// OAuth discovery metadata (RFC 8414, RFC 9728) served by Better Auth.
app.get("/.well-known/*", (c) => auth.handler(c.req.raw));
app.post("/mcp", (c) => handleMcp(c.req.raw));
app.get("/sign-in", (c) => signInPage(c.req.raw));
app.get("/consent", (c) => consentPage(c.req.raw));
// Per-user Bing Webmaster account link.
app.get("/connect", (c) => connectPage(c.req.raw));
app.delete("/connect", (c) => disconnect(c.req.raw));

export default app;
