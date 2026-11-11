import type { Auth } from "@repo/core/auth";
import type { Logger } from "@repo/core/logger";
import { escapeHtml, page, scriptHash } from "@repo/core/pages";

/** Better Auth provider id of the linked Bing Webmaster account. */
export const BING_PROVIDER_ID = "bing";

function decodeJsonToken(token: string): unknown {
  const base64 = token.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

/**
 * The account subject Better Auth stores for a linked Bing account. Bing has
 * no userinfo endpoint, so this reads `webmasteruid` from the access token,
 * which Bing's docs suggest is base64 JSON (unconfirmed, see issue #47). If
 * the token is not that, a random UUID is used and every link adds a new
 * account row, which `pruneBingAccounts` below keeps down to one.
 */
export function bingAccountSubject(accessToken?: string): string {
  try {
    const claims = decodeJsonToken(accessToken ?? "");
    const uid =
      typeof claims === "object" && claims !== null && "webmasteruid" in claims
        ? claims.webmasteruid
        : undefined;
    if (typeof uid === "string" && uid !== "") return uid;
  } catch {
    // Not base64 JSON: fall through to the random subject.
  }
  return crypto.randomUUID();
}

export interface ConnectPagesOptions {
  auth: Auth;
  logger: Logger;
}

const CONNECT_PATH = "/connect";

// One script for both states: sign in with Google, link Bing, disconnect.
const CONNECT_SCRIPT = `
const error = document.getElementById("error");
async function call(url, init) {
  const buttons = document.querySelectorAll("button");
  for (const b of buttons) b.disabled = true;
  error.hidden = true;
  try {
    const response = await fetch(url, { credentials: "same-origin", ...init });
    const data = await response.json().catch(() => ({}));
    if (response.ok) return data;
    error.textContent = data.error ?? data.message ?? "Something went wrong. Try again.";
  } catch {
    error.textContent = "Something went wrong. Try again.";
  }
  error.hidden = false;
  for (const b of buttons) b.disabled = false;
}
const json = { "content-type": "application/json" };
async function start(provider) {
  const data = await call("/api/auth/" + (provider === "google" ? "sign-in/social" : "link-social"), {
    method: "POST",
    headers: json,
    body: JSON.stringify({ provider, callbackURL: "${CONNECT_PATH}", errorCallbackURL: "${CONNECT_PATH}", disableRedirect: true }),
  });
  if (typeof data?.url === "string") location.href = data.url;
}
document.querySelector("button[data-signin]")?.addEventListener("click", () => start("google"));
document.querySelector("button[data-connect]")?.addEventListener("click", () => start("${BING_PROVIDER_ID}"));
document.querySelector("button[data-disconnect]")?.addEventListener("click", async () => {
  const data = await call("${CONNECT_PATH}", { method: "DELETE" });
  if (data) location.reload();
});
`;

function json(status: number, body: unknown): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

/**
 * The Bing connection page, bound to one app's Better Auth instance:
 *
 * - `connectPage`: `GET /connect`. Signed in, shows whether a Bing account is
 *   linked with Connect and Disconnect buttons; otherwise a "Sign in with
 *   Google" button that returns to `/connect`.
 * - `disconnect`: `DELETE /connect`, which needs a session and an `Origin`
 *   equal to the origin of Better Auth's base URL.
 *
 * Linking goes through Better Auth's `POST /api/auth/link-social`.
 */
export function createConnectPages({ auth, logger }: ConnectPagesOptions) {
  // Not the error message: a database error can quote the row.
  function failed(action: string, error: unknown): void {
    logger.error(
      { errorName: error instanceof Error ? error.name : typeof error },
      `${action} failed`,
    );
  }

  /** The user's Bing accounts, newest first. */
  async function bingAccounts(userId: string) {
    const { internalAdapter } = await auth.$context;
    const accounts = (await internalAdapter.findAccounts(userId)).filter(
      (account) => account.providerId === BING_PROVIDER_ID,
    );
    return {
      internalAdapter,
      accounts: accounts.sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
      ),
    };
  }

  async function connectPage(request: Request): Promise<Response> {
    const session = await auth.api.getSession({ headers: request.headers });
    const hash = await scriptHash(CONNECT_SCRIPT);
    if (!session) {
      return page(
        401,
        "Sign in",
        `<p>Sign in with Google to connect your Bing Webmaster account.</p>
<div class="actions"><button type="button" class="primary" data-signin>Sign in with Google</button></div>
<p id="error" hidden></p>
<script>${CONNECT_SCRIPT}</script>`,
        hash,
      );
    }

    let linked: boolean;
    try {
      const { internalAdapter, accounts } = await bingAccounts(session.user.id);
      // Each link adds a row when the subject is random: keep the newest only.
      for (const stale of accounts.slice(1)) {
        await internalAdapter.deleteAccount(stale.id);
      }
      linked = accounts.length > 0;
    } catch (error) {
      failed("Loading the Bing connection", error);
      return page(
        500,
        "Bing Webmaster",
        "<p>Your Bing connection could not be loaded. Try again later.</p>",
      );
    }

    const failedLink = new URL(request.url).searchParams.has("error");
    const notice = failedLink
      ? `<p>Bing could not be connected. Try again.</p>`
      : "";
    const actions = linked
      ? `<div class="actions"><button type="button" data-connect>Reconnect</button><button type="button" data-disconnect>Disconnect</button></div>`
      : `<div class="actions"><button type="button" class="primary" data-connect>Connect Bing</button></div>`;
    return page(
      200,
      "Bing Webmaster",
      `${notice}<p>Signed in as ${escapeHtml(session.user.email)}.</p>
<dl><div><dt>Bing Webmaster account</dt><dd>${linked ? "Connected" : "Not connected"}</dd></div></dl>
${actions}
<p id="error" hidden></p>
<script>${CONNECT_SCRIPT}</script>`,
      hash,
    );
  }

  async function disconnect(request: Request): Promise<Response> {
    const { baseURL } = await auth.$context;
    if (request.headers.get("origin") !== new URL(baseURL).origin) {
      return json(403, { error: "Forbidden." });
    }
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return json(401, { error: "Sign in to disconnect Bing." });

    try {
      const { internalAdapter, accounts } = await bingAccounts(session.user.id);
      for (const account of accounts) {
        await internalAdapter.deleteAccount(account.id);
      }
    } catch (error) {
      failed("Disconnecting Bing", error);
      return json(500, { error: "Bing could not be disconnected." });
    }
    return json(200, { ok: true });
  }

  return { connectPage, disconnect };
}
