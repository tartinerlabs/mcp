import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { createAuth } from "@repo/core/auth";
import { genericOAuth } from "better-auth/plugins";
import { BING_PROVIDER_ID, bingAccountSubject } from "../connect.ts";
import { db } from "../db/index.ts";
import * as schema from "../db/schema/auth.ts";

// Bing's own OAuth, not Microsoft Entra. Open questions are tracked in #47.
const bing = genericOAuth({
  config: [
    {
      providerId: BING_PROVIDER_ID,
      clientId: process.env.BING_CLIENT_ID as string,
      clientSecret: process.env.BING_CLIENT_SECRET as string,
      authorizationUrl: "https://www.bing.com/webmasters/oauth/authorize",
      tokenUrl: "https://www.bing.com/webmasters/oauth/token",
      scopes: ["webmaster.read"],
      // Client authentication and PKCE: change here if the spike (#47) shows
      // Bing rejects either. Credentials go in the form body ("post").
      authentication: "post",
      pkce: true,
      // Used when the token response has no expires_in (Bing's docs show 3599).
      accessTokenExpiresIn: 3599,
      // No userinfo endpoint: the only profile is the subject.
      getUserInfo: async (tokens) => ({
        id: bingAccountSubject(tokens.accessToken),
        emailVerified: false,
      }),
    },
  ],
});

// Sign-in only identifies the user: Bing is linked afterwards at /connect with
// the user's own Bing Webmaster account. Bing returns no email, so linking
// needs both settings below.
export const auth = createAuth({
  db,
  schema,
  scopes: [],
  fetchClientMetadataResource,
  plugins: [bing],
  accountLinking: {
    allowDifferentEmails: true,
    trustedProviders: [BING_PROVIDER_ID],
  },
});
