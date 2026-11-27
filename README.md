# Google Search Console MCP

An unofficial [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that gives MCP clients read-only access to Google Search Console data: properties, Search Analytics performance, URL Inspection and sitemaps.

The server runs as a stateless Streamable HTTP endpoint on Vercel. MCP clients connect with nothing but its URL, `https://<your-domain>/mcp`: on first use the client opens a browser, you sign in with Google and approve the client, and every tool call then runs as **your** Google account. Nothing needs to run on your machine.

This repository is a pnpm workspace: the Search Console server lives in `apps/gsc`, a second server for PageSpeed Insights and the Chrome UX Report lives in `apps/pagespeed` (see [PageSpeed Insights server](#pagespeed-insights-server)), and a third for read-only Bing Webmaster Tools access lives in `apps/bing` (see [Bing Webmaster Tools server](#bing-webmaster-tools-server)). Three command-line tools run on your own machine: IndexNow URL submission in `apps/index-now` (see [IndexNow CLI](#indexnow-cli)), App Store Connect access in `apps/asc` (see [App Store Connect CLI](#app-store-connect-cli)) and App Store keyword and rank checks in `apps/aso` (see [ASO CLI](#aso-cli)). Shared auth and HTTP code is in `packages/core`.

> This project is not affiliated with, endorsed by or supported by Google. "Google" and "Search Console" are trademarks of Google LLC.

## Features

| Tool | What it does |
| --- | --- |
| `ping` | Checks that the server is running. |
| `list_sites` | Lists the properties the signed-in account can access, with its permission level. |
| `search_analytics` | Clicks, impressions, CTR and average position for a date range, optionally grouped by dimensions and filtered. |
| `compare_periods` | Compares a period with the previous period or the same dates a year earlier, by query, page, country, device or search appearance: total changes, biggest click gainers and losers, and new or lost rows. |
| `find_opportunities` | Queries or pages with the most upside, measured against the property's own CTR-by-position curve: striking-distance rows (positions 4–20 by default) ranked by extra clicks at a top-3 position, and first-page rows whose CTR is below the curve, ranked by missed clicks. |
| `inspect_url` | URL Inspection result for a page: index verdict, coverage, crawl, canonical, robots.txt, AMP, mobile usability and rich results. |
| `list_sitemaps` | Sitemaps submitted for a property, with dates, error/warning counts and submitted URL counts. |
| `submit_sitemap` | Only when `GSC_ENABLE_WRITE=true`: submits or resubmits a sitemap URL under the property. |

By default all tools are read-only and use the `https://www.googleapis.com/auth/webmasters.readonly` scope. Setting `GSC_ENABLE_WRITE=true` requests `https://www.googleapis.com/auth/webmasters` instead and registers `submit_sitemap`; the read tools keep working for users who signed in before the change, and `submit_sitemap` asks them to reconnect. Tool failures are returned as MCP tool results with `isError: true` and a category prefix: `[invalid_input]`, `[auth]`, `[permission]`, `[quota]`, `[not_found]`, `[unavailable]`, `[network]` or `[unexpected]`.

### `search_analytics` parameters

Values follow the [Search Analytics API reference](https://developers.google.com/webmaster-tools/v1/searchanalytics/query).

| Parameter | Values |
| --- | --- |
| `siteUrl` | Property exactly as returned by `list_sites`: `https://www.example.com/` (trailing slash) or `sc-domain:example.com` |
| `dateRange` | `last7Days`, `last28Days`, `last3Months`, `last6Months`, `last12Months`, `last16Months`. Ends on the latest day with final data (one extra small query finds it), like the Search Console UI. Use instead of `startDate`/`endDate`; the response echoes the resolved dates. |
| `startDate`, `endDate` | `YYYY-MM-DD`, Pacific Time, inclusive, `startDate` ≤ `endDate`. Use both, instead of `dateRange`. |
| `dimensions` | Any of `date`, `hour`, `query`, `page`, `country`, `device`, `searchAppearance` (each at most once) |
| `type` | `web` (default), `image`, `video`, `news`, `discover`, `googleNews` |
| `filters` | `{ dimension, operator, expression }` where `dimension` is `country`, `device`, `page`, `query` or `searchAppearance` and `operator` is `equals` (default), `notEquals`, `contains`, `notContains`, `includingRegex` or `excludingRegex` (RE2). All filters must match. |
| `aggregationType` | `auto` (default), `byPage`, `byProperty`, `byNewsShowcasePanel` |
| `dataState` | `final` (default), `all`, `hourly_all` (use with the `hour` dimension) |
| `rowLimit` | 1–25,000 (default 1,000) |
| `startRow` | 0 or more, for paging |

### `compare_periods` parameters

| Parameter | Values |
| --- | --- |
| `siteUrl`, `dateRange` or `startDate` + `endDate`, `type`, `filters` | As for `search_analytics`; the dates set the current period and the filters apply to both periods |
| `comparison` | `previousPeriod` (default, the same number of days just before) or `previousYear` (the same dates 12 months earlier) |
| `dimension` | `query` (default), `page`, `country`, `device` or `searchAppearance` |
| `limit` | Rows per list (`gainers`, `losers`, `new`, `lost`), 1–100 (default 25) |

Totals come from separate ungrouped queries, so they include anonymised queries that grouped rows leave out. Each period fetches at most 25,000 grouped rows; the response says when a list was truncated.

### `find_opportunities` parameters

| Parameter | Values |
| --- | --- |
| `siteUrl`, `dateRange` or `startDate` + `endDate`, `type`, `filters` | As for `search_analytics` |
| `dimension` | `query` (default) or `page` |
| `minPosition`, `maxPosition` | Striking-distance window, default 4–20 |
| `minImpressions` | Ignore rows with fewer impressions, default 50 |
| `limit` | Rows per list, 1–100 (default 25) |

The expected CTR at each rounded position is the impression-weighted CTR of all the property's rows at that position in the same period, so it reflects the niche and SERP features such as AI Overviews rather than a generic industry curve. The response includes this `ctrCurve` and the combined `top3Ctr` used for striking-distance potential.

## How it works

- [Better Auth](https://www.better-auth.com) 1.7 acts as the OAuth 2.1 authorisation server for MCP clients, using its [MCP plugin](https://www.better-auth.com/docs/plugins/mcp) (`@better-auth/mcp`), the JWT plugin and [Client ID Metadata Documents](https://www.better-auth.com/docs/plugins/cimd) (`@better-auth/cimd`). Dynamic client registration is **off**; clients identify themselves with a metadata document URL (CIMD).
- The only way to sign in is **Sign in with Google**. Google is asked for the `webmasters.readonly` scope with offline access, and Better Auth stores the Google tokens per user in Postgres, encrypted (`account.encryptOAuthTokens`), and refreshes them when they expire.
- `POST /mcp` without a valid access token gets `401` with an RFC 9728 `WWW-Authenticate: Bearer resource_metadata="https://<your-domain>/.well-known/oauth-protected-resource/mcp"` challenge, which is how clients discover the authorisation server. Access tokens are JWTs bound to the `https://<your-domain>/mcp` resource and verified against the server's JWKS.
- The MCP endpoint is stateless (the SDK's `createMcpHandler` with `legacy: "reject"`): it serves only MCP **2026-07-28**. Requests on the 2025-era protocol get `400` with the supported version.

All routes are served by one [Hono](https://hono.dev) app, `src/index.ts`:

| Path | Purpose |
| --- | --- |
| `POST /mcp` | MCP endpoint |
| `/api/auth/*` | Better Auth: authorise, token, consent, JWKS, Google callback |
| `/.well-known/*` | OAuth discovery metadata (RFC 8414, RFC 9728) from Better Auth |
| `/sign-in` | Starts Google sign-in straight away (no UI) |
| `/consent` | Shows the client name, the account and the redirect host, with Allow / Deny |

## Prerequisites

- Node.js and pnpm as declared in `devEngines` in `package.json` (pnpm 12 downloads the declared Node.js version automatically).
- A Google account with access to at least one Search Console property.
- A Google Cloud project you control.
- A Vercel account and, optionally, the [Vercel CLI](https://vercel.com/docs/cli).
- A Postgres database. [Neon](https://neon.com) through the Vercel Marketplace is the documented option.

## Installation

```sh
# Replace <repository-url> with this repository's clone URL.
git clone <repository-url> mcp
cd mcp
pnpm install
```

## Google Cloud Console setup

1. Create or select a project in the [Google Cloud Console](https://console.cloud.google.com/).
2. Enable the **Google Search Console API**: *APIs & Services → Library → Google Search Console API → Enable*.
3. Configure the OAuth consent screen (*Google Auth Platform → Branding / Audience / Data Access*):
   - User type **External**.
   - Under *Data Access*, add the scope `https://www.googleapis.com/auth/webmasters.readonly` (plus the default `openid`, `email` and `profile`), or `https://www.googleapis.com/auth/webmasters` if you set `GSC_ENABLE_WRITE=true`.
4. Create the OAuth client: *Google Auth Platform → Clients → Create client*:
   - Application type: **Web application**.
   - Authorised redirect URI: `https://<your-domain>/api/auth/callback/google` (Better Auth's callback path for the Google provider).
   - Copy the client ID and client secret into `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
5. Publishing status: Google expires refresh tokens after **7 days** for External apps in **Testing** status, so you would have to reconnect weekly. Set the app to **In production** (*Audience → Publish app*). Until Google has verified the app you will see an "unverified app" warning when signing in, and `webmasters.readonly` is a sensitive scope: complete Google's verification before letting anyone else use your deployment.

Expired or revoked Google access is reported to the client as an `[auth]` tool error asking you to reconnect.

## Database (Neon)

1. In the Vercel dashboard, open your project → *Storage* → add **Neon** from the Marketplace and connect it to the project. This adds the connection strings to the project's environment variables: the **pooled** one as `DATABASE_URL`, used by the app at runtime, and the **direct** (non-pooled) one as `DATABASE_URL_UNPOOLED`, used by Drizzle Kit. Neon advises against running migrations over the pooled connection.
2. Create the tables with Drizzle Kit. The Drizzle schema in `apps/gsc/src/db/schema/auth.ts` is generated by the Better Auth CLI and covers every table this configuration needs (Better Auth core plus the JWT, OAuth provider/MCP and CIMD plugins). Table and column names are plural and snake_case (for example `oauth_clients.redirect_uris`) and every `id` is a native Postgres `uuid` generated by the database. The SQL migrations generated from the schema live in `apps/gsc/drizzle/` (Drizzle Kit's default folder). Every Vercel build applies them, and you can also apply them from your machine. `drizzle.config.ts` reads only `DATABASE_URL_UNPOOLED`:

   ```sh
   DATABASE_URL_UNPOOLED="<your Neon direct connection string>" pnpm -C apps/gsc db:migrate
   ```

   Drizzle Kit records applied migrations in the `drizzle.__drizzle_migrations` table, so re-running the command only applies new ones.

3. After upgrading Better Auth or changing plugins, regenerate the schema and a new migration, then apply it as above. Both are generated: do not edit `apps/gsc/src/db/schema/auth.ts` or anything in `apps/gsc/drizzle/` by hand. The Better Auth CLI loads `src/lib/auth.ts`, which needs `BETTER_AUTH_URL` to build the MCP resource URL (`generate` does not connect to the database). Run these from `apps/gsc`:

   ```sh
   BETTER_AUTH_URL="https://<your-domain>" pnpm auth:generate
   pnpm db:generate
   ```

   Better Auth logs a "Drizzle schema mismatch" error when the Drizzle schema is missing tables or columns.

## Deploying to Vercel

Vercel runs the Hono app in `apps/gsc/src/index.ts` as a single function ([Hono on Vercel](https://vercel.com/docs/frameworks/backend/hono)); `apps/gsc/vercel.ts` sets the `hono` framework and the region. Every build runs `pnpm db:migrate` (the `vercel-build` script).

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Yes | Postgres connection string (Neon pooled URL), used at runtime. |
| `DATABASE_URL_UNPOOLED` | Yes | Direct (non-pooled) Neon connection string, used by Drizzle Kit to apply migrations during the build. |
| `BETTER_AUTH_SECRET` | Yes | Secret for signing and encryption, at least 32 random bytes: `openssl rand -base64 32`. Changing it invalidates sessions and stored Google tokens. |
| `BETTER_AUTH_URL` | Yes | Public origin of the deployment, e.g. `https://gsc.example.com`. The MCP resource is `<BETTER_AUTH_URL>/mcp` and must be exactly the URL clients use. |
| `GOOGLE_CLIENT_ID` | Yes | Web application OAuth client ID. |
| `GOOGLE_CLIENT_SECRET` | Yes | Web application OAuth client secret. |
| `GSC_ENABLE_WRITE` | No | `true` requests the `webmasters` write scope from Google and adds the `submit_sitemap` tool. Off by default. |
| `LOG_LEVEL` | No | Log level (`info` by default, `silent` to disable). Logs are JSON lines on stdout; tokens, secrets, cookies and `Authorization` headers are redacted. |

### Deploy

1. Create the Vercel project (Git integration via the dashboard, or `vercel link`) and set its *Root Directory* to `apps/gsc`.
2. Add Neon and create the tables (see [Database](#database-neon)).
3. Add the variables (each command prompts for the value, so secrets stay out of your shell history):

   ```sh
   vercel env add BETTER_AUTH_SECRET production
   vercel env add BETTER_AUTH_URL production
   vercel env add GOOGLE_CLIENT_ID production
   vercel env add GOOGLE_CLIENT_SECRET production
   ```

4. Deploy with `vercel deploy --prod`, or push to the branch connected through the Git integration.
5. Add `https://<your-domain>/api/auth/callback/google` to the Google OAuth client if you have not already.

If you use a custom domain, set `BETTER_AUTH_URL` to it.

## Connecting a client

Use only the URL; the client discovers the rest and opens your browser for Google sign-in and consent.

Claude Code (untested against a live deployment):

```sh
claude mcp add --transport http google-search-console https://<your-domain>/mcp
```

Generic client configuration (untested; key names vary between clients):

```json
{
  "mcpServers": {
    "google-search-console": {
      "type": "http",
      "url": "https://<your-domain>/mcp"
    }
  }
}
```

The client must support OAuth with Client ID Metadata Documents.

## PageSpeed Insights server

`apps/pagespeed` is a second MCP server with the same sign-in, endpoint and deployment model. Signing in with Google only identifies you: it requests no extra Google scopes. The tools call Google with the server's own API key.

| Tool | What it does |
| --- | --- |
| `ping` | Checks that the server is running. |
| `pagespeed_analyze` | Runs Lighthouse on a public URL through PageSpeed Insights: category scores, lab metrics and the costliest failing audits. Lab data from one emulated load. |
| `crux_query` | Real-user Core Web Vitals from the Chrome UX Report for a URL or origin over the last 28 days: the 75th percentile, its rating and the share of page loads in each band. |
| `crux_history` | Weekly trend of the 75th percentile from the CrUX History API, up to 40 weeks. |

Setup differs from the Search Console server in three ways:

1. In the Google Cloud project, enable the **PageSpeed Insights API** and the **Chrome UX Report API**, then create an API key restricted to those two APIs. The Google OAuth client still needs no extra scopes.
2. Create a separate Vercel project with *Root Directory* `apps/pagespeed`, with its own Neon database (migrations in `apps/pagespeed/drizzle/`).
3. Set the same environment variables as above, plus `GOOGLE_API_KEY`. The key is sent in the `x-goog-api-key` header.

The Chrome UX Report API allows 150 queries per minute per Google Cloud project. Pages without enough Chrome traffic have no CrUX data, which is reported as `[not_found]`.

## IndexNow CLI

`apps/index-now` is a command-line tool, not an MCP server. It submits changed URLs to [IndexNow](https://www.indexnow.org), which shares them with Bing, Yandex, Seznam, Naver and other participating search engines (Google does not take part). It has no sign-in and no database: ownership is proved by the site itself, which must serve a key file at `https://<host>/<key>.txt` whose contents are the key.

| Command | What it does |
| --- | --- |
| `verify <url> --key <key>` | Checks that the live site serves the key file with the key as its contents. Submits nothing. Exits with code 1 when the key file is not valid. |
| `submit <urls...> --key <key>` | Submits up to 10,000 URLs on one host. It waits for the key file to be live and retries IndexNow outages (a rate limit fails at once). |

Both take `--key-location <url>` when the key file is not at the site root. Submit only the production URLs that changed, once the deploy is live.

It runs on your own machine, from a checkout of this repository. IndexNow permanently rate-limits the shared egress IPs of cloud platforms (it answered every submission from Cloudflare Workers with HTTP 429), so submissions must leave from your own IP. `submit` retries the key-file check while a deploy goes live (about 16 minutes), and the IndexNow POST on 5xx (honouring `Retry-After`) and network errors. A 429 ends the command with a `[quota]` error at once, because retrying a throttled request keeps it throttled.

The result is printed as JSON on stdout. Retry progress and errors go to stderr, and a failure exits with code 1. Build it, then run it:

```sh
pnpm --filter @tartinerlabs/index-now-mcp build
node apps/index-now/dist/index.js verify https://example.com --key <key>
node apps/index-now/dist/index.js submit https://example.com/new-page --key <key>
```

## ASO CLI

`apps/aso` is a command-line tool, not an MCP server. It checks keyword fields, tracks where an app ranks in App Store search and watches other apps' public listings. It needs no key: searches and lookups use Apple's public iTunes Search and Lookup APIs.

| Command | What it does |
| --- | --- |
| `keywords lint --keywords <text>` | Checks a comma-separated keyword field against App Store Connect's limits (100 bytes, each keyword at least 3 characters) and Apple's keyword guidance: spaces after commas, repeated words, singular and plural pairs, words already in `--name`, `--subtitle` or `--developer`, "app", filler words and `#`/`@`. Makes no requests. Exits with code 1 when a limit is broken. Competitor, trademark and category names are not checked. |
| `ranks check <terms...> --app-id <id>` | Searches up to 50 phrases in one storefront (`--country`, default `us`) and reports the app's position in the top 200 and the top 3 apps. With `--history <file>` it compares with the last run and appends this one as JSON Lines. |
| `competitors diff <app-ids...> --snapshot <file>` | Looks up up to 200 apps in one storefront and reports what changed since the snapshot was last written (name, developer, version, release notes, description, genre, price, rating, rating count, screenshot count), then updates it. The first run only records. Use one snapshot file per country. |

It runs on your own machine, from a checkout of this repository. Apple allows about 20 search or lookup requests a minute per IP, which shared cloud IPs exhaust, so requests are spaced 3 seconds apart and a rate limit (HTTP 403 or 429), 5xx or network error is retried after 60 and then 120 seconds. Ranks come from the public search API and can differ from what a signed-in device shows. Subtitles and keyword fields of other apps are not public, so they cannot be compared.

The result is printed as JSON on stdout. Retry progress and errors go to stderr, and a failure exits with code 1. Build it, then run it:

```sh
pnpm --filter @tartinerlabs/aso build
node apps/aso/dist/index.js keywords lint --keywords "habit,tracker,routine" --name "Daily"
node apps/aso/dist/index.js ranks check "habit tracker" streaks --app-id <id> --history ranks-us.jsonl
node apps/aso/dist/index.js competitors diff <id> <id> --snapshot competitors-us.json
```

## App Store Connect CLI

`apps/asc` is a command-line tool, not an MCP server. It reads App Store Connect, and makes a few guarded changes, with your own [App Store Connect API key](https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api). There is no sign-in, database or hosted service: the key stays on your machine, access follows the key's role in its own team, and every request is signed with a fresh 2-minute ES256 token.

| Command | What it does |
| --- | --- |
| `apps` | Apps visible to the key: id, name, bundle ID, SKU and primary locale. |
| `apps content-rights <app-id> --uses-third-party-content\|--no-third-party-content` | Declares whether the app shows, accesses or includes third-party content (`contentRightsDeclaration`). |
| `versions <app-id>` | An app's App Store versions, newest first, with their state and attached build number. |
| `versions check <version-id>` | Reports, without changing anything, whether a version is ready to submit for App Review: its state, the build's processing and export compliance, an open review submission, required metadata and app info per locale, screenshots per locale, age rating, accessibility declarations, App Review details, pricing and availability. It lists what to fix under `blocking` (and softer issues, such as a locale without iPad screenshots, under `warnings`), states the requirements it assumed under `assumptions`, and exits 1 when anything blocks submission. Categories, content rights and metadata lint show as `not_available` for now. |
| `versions create <app-id> --app-version 2.5.0` | Creates the next App Store version (`--platform`, default `IOS`), with optional `--copyright`, `--release-type MANUAL\|AFTER_APPROVAL\|SCHEDULED` and `--release-date`. It refuses a version string the app already has on that platform. `--copy-from <version-id>` copies that version's localized description, keywords, promotional text and URLs into the new one, one request per locale, and reports each locale; What's New is left for `metadata set --whats-new`. |
| `versions set <version-id>` | Changes a version's `--release-type`, `--release-date` (needs `SCHEDULED`; a future ISO 8601 date and time) or `--copyright`. Only a version being prepared or rejected accepts changes. |
| `versions attach-build <version-id> <build-id>` | Attaches a build to a version being prepared or rejected. It refuses a build of another app or platform, or one that is expired or not `VALID`. Change the What's New text with `metadata set --whats-new`. |
| `versions submit <version-id>` | Submits a version for App Review on its own. It refuses a version that is not being prepared or rejected, has no `VALID` build or an unanswered export compliance question, or is already submitted; one whose age rating declaration or accessibility declarations have unanswered questions, or whose App Review details leave the contact, or a required demo account, blank; and a review submission being prepared with other items, as `custom-pages submit` does. |
| `versions cancel-review <version-id>` | Cancels the review submission of a version waiting for or in review, returning it to an editable state; it loses its place in the review queue. It refuses a submission that is rejected, already cancelling or holds other items. |
| `versions release <version-id>` | Releases a version that App Review approved and that is `PENDING_DEVELOPER_RELEASE`; with a phased release, this starts the rollout. |
| `versions phased-release <version-id> pause\|resume\|complete` | Pauses an active phased release, resumes a paused one, or completes it, which releases the version to every user at once. |
| `metadata <version-id>` | A version's App Store metadata in every locale: description, keywords, promotional text, What's New, and support and marketing URLs. Take the version id from `versions`. |
| `metadata set <version-id> --locale en-US --description <text>` | Changes a version's metadata for one locale: any of `--description`, `--keywords`, `--promotional-text`, `--whats-new`, `--support-url` and `--marketing-url`. Only a version being prepared or rejected accepts changes; a version in review or live gets an `[invalid_input]` error, except for `--promotional-text`, which can change at any time. |
| `metadata pull <app-id> --dir <folder>` | Writes the app's listing into a new or empty folder (layout below): the version being prepared or rejected, else the live one (`--version-id`, `--platform`), with the app info being prepared, else the live one. `--no-media` leaves out screenshots and app previews; Apple's download links are unverified against a real account. |
| `metadata push <app-id> <folder>` | Compares the folder with App Store Connect and applies only the differences, printing the plan per locale (each field added, changed or removed, new locales, files to add, remove and reorder) without `--yes`. Screenshots and previews already placed are matched by file name, ignoring the `<GROUP>-<NN>-` prefix `pull` adds; new ones go after them. `--sync-screenshots` also removes placements the folder does not have and reorders each group to the folder's order. The metadata lint runs first and stops the push on errors (`--ignore-lint`, `--rule`, `--no-url-check`). A version past review takes only promotional text, and a live app info nothing, as with `metadata set` and `app-info set`. |
| `metadata lint <version-id>` or `metadata lint --dir <folder>` | Checks every locale of a version's listing (with its app info and in-app purchase names), or a folder from `metadata pull` without a key, and prints each finding with its locale, field, rule and severity, exiting 1 when any is an error. Rules: `length` (Apple's limits; keywords in UTF-8 bytes), `placeholder` (lorem ipsum, `TODO`, test text), `other-platforms` (Android, Google Play and other stores), `url-reachable` (support, marketing and privacy URLs, each requested once with a 5-second timeout; a network error is only a warning), `copyright-year` (warning), `free-iap`, `future-features` (warning, such as "coming soon") and `apple-negative` (warning). Change one with `--rule placeholder=warning` or `--rule url-reachable=off`; `--no-url-check` makes no requests. |
| `review-details <version-id>` | A version's App Review details: contact name, phone and email, whether a demo account is needed and its user name, notes, attachments, and which required fields are `missing`. The demo account password is never shown, only whether one is set. |
| `review-details set <version-id>` | Sets any of `--contact-first-name`, `--contact-last-name`, `--contact-phone`, `--contact-email`, `--demo-account-required` (or `--no-demo-account-required`), `--demo-account-name`, `--demo-account-password` and `--notes`, creating the details if the version has none. Only a version being prepared or rejected accepts changes. Prefer `ASC_DEMO_ACCOUNT_PASSWORD` to the flag, which shell history keeps; the password is sent when given and never printed, not even in a dry run or an error. |
| `review-details attach <version-id> <file>` | Uploads a file, such as a demo video, as an App Review attachment, sending it only to the upload URLs Apple's response lists. |
| `review-details detach <attachment-id>` | Removes an App Review attachment from a version being prepared or rejected. |
| `screenshots <version-id>` | A version's screenshots and app previews per locale (or one, `--locale`) and device group, in display order: placement id, file name and state. |
| `screenshots upload <version-id> --dir <folder>` | Uploads a folder of screenshots (`.png`, `.jpg`) and app previews (`.mp4`, `.m4v`, `.mov`), with one subfolder per locale such as `en-US`. Each file goes to the device group its name contains, such as `IPHONE_DYNAMIC_ISLAND_LARGE_PROFILE`, or, for a screenshot, the one its pixel size fits; an app preview must name its group. Files are added after those already there, in file name order. Only a version being prepared or rejected accepts them. It stops before writing anything when a device group would go past Apple's limit (10 screenshots and 3 app previews for a version), and if it fails partway it names the files already placed, so a rerun can leave them out. |
| `screenshots reorder <version-id> --locale en-US --group <group> --placement <ids>` | Sets the display order of one locale's screenshots, or app previews, in one device group: give all of them, in the new order. |
| `screenshots delete <placement-id...>` | Removes screenshots or app previews from a version that is being prepared or was rejected, showing each one's version and locale first. The files stay in the app's asset library. |
| `custom-pages <app-id>` | An app's custom product pages: id, name, App Store URL and whether it is visible (`--visible`, `--no-visible`). |
| `custom-pages show <page-id>` | One custom product page with each of its versions: version id, state, deep link, and each locale's promotional text. |
| `custom-pages create <app-id> --name <name> --locale en-US` | Creates a custom product page with its first version and one locale, optionally with `--promotional-text` and `--deep-link`. The dry run shows how many pages the app already has; Apple's limit on pages comes back as an `[invalid_input]` error that names it, with Apple's own message. |
| `custom-pages set <page-version-id> --deep-link <url>` | Changes a page version's deep link, or one locale's promotional text (`--locale en-US --promotional-text <text>`). Only a page version being prepared or rejected accepts changes. |
| `custom-pages upload <page-version-id> --dir <folder>` | Uploads a folder of screenshots and app previews to a page version, the same way as `screenshots upload`. |
| `custom-pages submit <page-version-id>` | Submits a page version for App Review on its own (`--platform`, default `IOS`). It refuses when the app has a review submission being prepared with other items, since those would go for review too. |
| `page-tests <app-id>` | An app's product page optimization tests: id, name, platform, state (`--state`), traffic proportion, start and end dates, and each treatment's name and alternate icon. Apple's API returns no conversion results for a test, so read those in App Store Connect. |
| `page-tests show <test-id>` | One test with each treatment: treatment id, name, alternate icon, and its locales. |
| `page-tests create <app-id> --name <name> --traffic-proportion 30 --treatment Bold=AppIconBold --locale en-US` | Creates a test with up to three treatments (repeat `--treatment <name[=icon]>`; an alternate icon must already ship in the app's binary), each with a localization per `--locale` (at least one) for its screenshots, since `page-tests upload` places files only on those locales (`--platform`, default `IOS`). If it fails after creating the test, it names what was created. |
| `page-tests upload <treatment-id> --dir <folder>` | Uploads a folder of screenshots and app previews to a treatment, the same way as `screenshots upload`. Only a test being prepared or rejected accepts them. |
| `page-tests submit <test-id>` | Submits a test for App Review on its own, on the test's platform, refusing a review submission being prepared with other items, as `custom-pages submit` does. |
| `page-tests start <test-id>` and `page-tests stop <test-id>` | Starts a test App Review approved (or one that needs no review), or stops a running one. |
| `events <app-id>` | An app's in-app events: id, reference name, state (`--state`), badge, priority, purpose, primary locale, deep link, and each schedule's territories and publish, start and end dates. |
| `events show <event-id>` | One event with each locale's name, short and long description, and its event card and details page images and videos. |
| `events create <app-id> --reference-name <name> --locale en-US --badge CHALLENGE` | Creates an event in its primary locale, with that locale's `--name`, `--short-description` and `--long-description`, and one schedule from `--territories USA,GBR`, `--publish-start`, `--event-start` and `--event-end` (ISO 8601 date-times). `--purpose`, `--priority`, `--purchase-requirement` and `--deep-link` are optional. If saving the locale fails after creating the event, it names the event. |
| `events set <event-id> --locale en-US --name <text>` | Changes one locale's `--name`, `--short-description` or `--long-description`, adding the locale when the event has none. Only an event in draft or rejected accepts changes. |
| `events upload <app-id> <event-id> --dir <folder>` | Uploads event card and details page images and videos to an event through the asset library, as `screenshots upload` does: one subfolder per locale, each file naming `EVENT_CARD_ASSET` or `EVENT_DETAILS_PAGE_ASSET`, and its group when Apple lists more than one for that type. Apple allows one file per group, so a group that already has one is refused. |
| `events submit <app-id> <event-id>` | Submits an event for App Review on its own (`--platform`, default `IOS`), refusing a review submission being prepared with other items, as `custom-pages submit` does. The dry run shows how many of the app's events are past review, since Apple limits how many run at once; a refusal from Apple is reported as `[invalid_input]` with its reason. |
| `app-info <app-id>` | An app's app infos (usually the live one and one being prepared): state, age rating, category IDs, and each locale's name, subtitle and privacy policy links. |
| `app-info set <app-info-id> --locale en-US --subtitle <text>` | Changes an app info for one locale: any of `--name`, `--subtitle`, `--privacy-policy-url`, `--privacy-choices-url` and `--privacy-policy-text`. Only an app info being prepared or rejected accepts changes. |
| `app-info categories <app-info-id> --primary GAMES --primary-sub GAMES_PUZZLE --secondary EDUCATION` | Sets the primary and secondary categories and up to two subcategories each (`--primary-sub-two`, `--secondary-sub`, `--secondary-sub-two`), checked against Apple's category list, which an `[invalid_input]` error names; `none` clears one. Only an app info being prepared or rejected accepts changes. EU trader status and contact details (Digital Services Act) are not in Apple's public API, so set them in App Store Connect. |
| `pricing <app-id>` | An app's price schedule: base territory and currency, the prices set by hand (current and scheduled) and the prices Apple derives for every other territory, each with customer price, proceeds and start and end dates (`--territory USA,JPN` for only some). |
| `pricing set <app-id> --base-territory USA --price 2.99` | Replaces the app's price schedule: the base territory's price, which Apple equalizes to every other territory, and territories priced by hand with `--override GBR=1.99` (repeatable), from `--start-date` or now. Each price is matched to the nearest of Apple's price points, and the dry run shows the match. Since a schedule is replaced whole, the current manual prices are read first: a price in effect ends when the new one starts and later scheduled changes are kept unless `--drop-scheduled`; the dry run shows the old and new lists. |
| `availability <app-id>` | Where an app is sold: whether it joins new territories automatically, the territories it is missing from, and each territory's availability, release date, pre-order and content statuses, such as one that blocks sale there. |
| `availability set <app-id> --territory USA,GBR --available` | Adds an app to territories, or removes it from them with `--no-available`, and turns pre-orders on or off there with `--pre-order` or `--no-pre-order` and `--release-date 2027-03-01` (Apple sets the pre-order publish date itself), changing only the values that differ; the dry run shows each territory's content statuses, pre-order and release date. If it fails partway it names the territories already changed. Apple documents this change only for pre-orders, so for an app already on sale it is untested against the real API. |
| `iap <app-id>` | An app's in-app purchases: id, reference name, product ID, type (`--type`) and review state (`--state`). A product missing from the app is often one never submitted for review. |
| `iap show <iap-id>` | One in-app purchase with its localizations, availability, base territory, the prices in effect today in each territory (set by hand or derived by Apple), and its offer codes with their counts. Redemption codes are never shown. |
| `iap create <app-id> --type CONSUMABLE --product-id com.example.coins --reference-name Coins` | Creates an in-app purchase (`CONSUMABLE`, `NON_CONSUMABLE` or `NON_RENEWING_SUBSCRIPTION`, with `--family-sharable` and `--review-note`). `iap set <iap-id>` changes the reference name, review note or Family Sharing. |
| `iap localize <iap-id> --locale en-US --name Coins --description "100 coins"` | Sets one locale's display name and description, adding the locale if it is new. |
| `iap price <iap-id> --base-territory USA --price 4.99` | Replaces the product's price schedule like `pricing set`: the base territory's price equalized by Apple to the others, `--override`, `--start-date` and `--drop-scheduled`. |
| `iap availability <iap-id> --territory USA,GBR` | Sets the territories the product is sold in (`--all` for every territory, `--available-in-new-territories`), replacing the current list; the dry run lists the territories added and removed. |
| `iap review-screenshot upload <iap-id> --file review.png` | Replaces the screenshot App Review sees: the old one is deleted, the file reserved, its parts sent only to Apple's upload URLs and committed with its MD5. |
| `iap submit <iap-id>` | Submits a product for review; one that is not `READY_TO_SUBMIT`, `DEVELOPER_ACTION_NEEDED` or `REJECTED` is refused. Apple reviews a product's first submission with the next app version. |
| `subscriptions <app-id>` | An app's subscription groups, each with its subscriptions by level: id, reference name, product ID, period and review state. |
| `subscriptions show <subscription-id>` | One subscription with its localizations, availability, the price in effect today and scheduled changes in each territory, introductory offers and win-back offers that have not ended, promotional offers, and offer codes with their counts (never the codes). |
| `subscriptions group create <app-id> --reference-name Pro` | Creates a subscription group; `subscriptions group localize <group-id> --locale en-US --name Pro` sets a locale's name and `--custom-app-name`. |
| `subscriptions create <group-id> --product-id com.example.pro.monthly --reference-name "Pro Monthly" --period ONE_MONTH` | Creates an auto-renewable subscription in a group (`--group-level`, 1 the highest). `subscriptions set`, `localize`, `review-screenshot upload` and `submit` work as they do for `iap`. |
| `subscriptions price <subscription-id> --base-territory USA --price 9.99` | Prices the subscription in every territory: the base territory's nearest price point, Apple's equalized points elsewhere and `--override` territories, one price per territory, from `--start-date` or now. Existing subscribers keep their price unless `--no-preserve-current-price`; then Apple tells them, and asks for consent to an increase where required. If it fails partway it names the territories already priced. |
| `subscriptions availability <subscription-id> --territory USA,GBR` | Sets the territories the subscription is sold in (`--all`, `--available-in-new-territories`, `--plan-type UPFRONT` or `MONTHLY`), replacing the current list. |
| `subscriptions offers <subscription-id>` | The subscription's introductory, promotional, offer code and win-back offers, with each offer code's one-time code batches (counts and dates) and custom codes. One-time codes are never printed. |
| `subscriptions offers intro create <subscription-id> --mode FREE_TRIAL --duration ONE_WEEK` | Creates an introductory offer in every territory the subscription is priced in (or `--territory`), from `--start-date` to `--end-date`. A paid offer (`PAY_AS_YOU_GO` with `--periods`, or `PAY_UP_FRONT`) takes `--base-territory USA --price 0.99`, equalized to the other territories. `intro end <subscription-id> --end-date 2027-01-31` ends them on a date, or deletes them without one. |
| `subscriptions offers promo create <subscription-id> --name Comeback --code comeback --mode PAY_UP_FRONT --duration ONE_MONTH --base-territory USA --price 1.99` | Creates a promotional offer priced in every territory the subscription is priced in; `promo set <offer-id>` replaces its prices and `promo delete` removes it. |
| `subscriptions offers offer-codes create <subscription-id> --name Launch --eligibility NEW,EXPIRED --mode FREE_TRIAL --duration ONE_MONTH` | Creates an offer code (`--offer-eligibility`, `--auto-renew`). `offer-codes generate <offer-code-id> --count 500 --expires 2027-01-01 --out codes.csv` makes one-time codes and writes them only to that new file (mode 600; never to stdout), `offer-codes codes <batch-id> --out` fetches a batch again, `offer-codes custom <offer-code-id> --code SUMMER --count 1000` adds a custom code and `offer-codes deactivate` ends the offer code. |
| `subscriptions offers win-back create <subscription-id> --reference-name Back --offer-id back1 --mode FREE_TRIAL --duration ONE_MONTH --paid-months 6 --since-min 3 --since-max 12 --start-date 2027-01-01` | Creates a win-back offer (`--wait-months`, `--end-date`, `--priority`, `--promotion-intent`); `win-back set <offer-id>` changes its eligibility, dates, priority or promotion and `win-back delete` removes it. |
| `promoted-purchases <app-id>` | The in-app purchases and subscriptions promoted on the product page, in order, each with whether it is enabled, visible to everyone and its review state. |
| `promoted-purchases set <app-id> --product <id>,<id>` | Promotes the products in the order given, ahead of those already promoted (`--only` removes the others), adding new ones enabled and visible to everyone unless `--no-enabled` or `--no-visible-for-all-users`. |
| `age-rating <app-id>` | Each app info's state, App Store age rating and age rating declaration with every answer the API returns, since Apple changes the questions over time. |
| `age-rating set <app-info-id> --answer gambling=false --answer violenceRealistic=INFREQUENT` | Changes age rating answers, named as `age-rating` lists them; Apple checks the values, and a rejected answer is an `[invalid_input]` error naming the answers sent. Only an app info being prepared or rejected accepts changes. |
| `builds <app-id>` | An app's builds, newest upload first: build number, marketing version, processing state, expiry and the export compliance answer (`usesNonExemptEncryption`, `null` while unanswered). `--group <group-id>` lists only the builds that TestFlight group can test. |
| `builds upload <app-id> --file <path> --app-version 1.2.0 --build-number 42` | Uploads an exported `.ipa`, or a `.pkg` for a Mac app, through Apple's build upload API, with no Xcode or Transporter: it creates a build upload, sends the file in the parts Apple's response lists (read from disk part by part, never whole), commits it with its MD5 checksum and prints the build upload's id and state. The version and build number must match the binary's `CFBundleShortVersionString` and `CFBundleVersion`; `--platform` defaults to `MAC_OS` for a `.pkg` and `IOS` for an `.ipa`. It refuses a build number the version already has before sending anything. `--wait` then waits for the build as `builds wait` does (`--timeout`, `--interval`). Needs a key with the App Manager or Developer role. |
| `builds wait <app-id> --build-number <n>` | Waits until that build finishes processing and prints it: exits 0 when it is `VALID`, 1 when it is `FAILED` or `INVALID`. Checks every 30 seconds (`--interval`) for up to 30 minutes (`--timeout`), with progress on stderr. A build not visible yet counts as still processing. |
| `builds compliance <build-id> --no-encryption` | Answers a build's export compliance question, which TestFlight shows as "Missing Compliance" until it is answered: `--no-encryption` when the build uses no encryption or only exempt encryption such as HTTPS, `--encryption` when it uses non-exempt encryption (that also needs an encryption declaration in App Store Connect). |
| `builds expire <build-id>` | Expires a build so testers can no longer install it from TestFlight. This cannot be undone. |
| `builds expire <app-id> --keep 3` | Expires many of an app's unexpired builds at once: all but the `--keep <n>` most recently uploaded, or every one uploaded before `--older-than <build-id>` on that build's platform. `--platform` narrows it to one platform. The dry run lists every build it would expire. This cannot be undone. |
| `builds latest <app-id> --app-version 2.5.0 --next` | The highest build number among the app's 200 most recent uploads (optionally for one `--app-version` and `--platform`), with its id and state; `--next` adds the number to upload next. Expired and failed builds count, since Apple does not take a build number twice. |
| `builds dsyms <build-id> --out <dir>` | Downloads a build's dSYMs, one `<bundle-id>-<build>.dSYM.zip` per app, app clip or watch app bundle Apple has symbols for, into a directory, from the URLs Apple's response gives and without your token. `--app <app-id> --build-number <n>` (with `--app-version` or `--platform` if needed) picks the build instead of its id. Existing files are not replaced without `--overwrite`. |
| `testflight groups <app-id>` | An app's TestFlight groups: internal or external (`--internal`, `--no-internal`), whether the group gets every build, and its feedback and public link settings. |
| `testflight testers <app-id>` | An app's TestFlight testers, or one group's (`--group <group-id>`): name, email, how they were invited (`EMAIL` or `PUBLIC_LINK`, `--invite-type`) and their state, such as `INVITED`, `INSTALLED` or `REVOKED`. |
| `testflight feedback <app-id> --type crash` | Feedback testers sent from TestFlight, newest first: crash reports (`--type crash`) or screenshot feedback (`--type screenshot`), with the comment, build, device and OS. `--build <build-id>` narrows it to one build. Tester emails are left out. |
| `testflight groups create <app-id> --name Beta --external` | Creates a group: `--internal` (App Store Connect users; `--all-builds` gives it every new build) or `--external` (needs beta review; `--public-link` with an optional `--public-link-limit <n>`, up to 10,000). `--no-feedback` turns off tester feedback. Refuses a name the app already uses. |
| `testflight groups set <group-id> --public-link --public-link-limit 500` | Renames a group (`--name`) or changes its public link (`--public-link`, `--no-public-link`), its tester limit (`--public-link-limit <n>`, `--no-public-link-limit`) or feedback (`--feedback`, `--no-feedback`). Only external groups have a public link. |
| `testflight groups delete <group-id>` | Deletes a group; its testers lose access to the builds they got through it. This cannot be undone. |
| `testflight groups add-build <group-id> <build-id>` | Lets a group test a build. An external group only gets a build that passed beta review. |
| `testflight testers add <group-id> --email <emails>` | Adds testers to a group by email (comma-separated or repeated, up to 50). Someone already testing the app joins the group; anyone else gets an invitation email. Internal groups only take App Store Connect users. |
| `testflight testers remove <group-id> --email <emails>` | Removes testers from a group by email; they can no longer test the group's builds. |
| `testflight testers import <app-id> --file testers.csv --group <group-id>` | Adds the testers in a CSV file (a header with an `email` column and optionally `firstName` and `lastName`) to one or more of the app's groups (`--group` comma-separated or repeated). Someone already testing the app joins the groups they are not in; anyone else is invited into all of them. Each row's result names its row number, never the email; a row that fails is reported and the rest still run, and the command then exits 1. |
| `testflight testers export <app-id> --out testers.csv` | Writes the app's testers, or one group's (`--group`), to a new CSV or JSON file (`--format`, or by the `.json` extension) readable only by you: id, email, name, invite type and state. Names and emails go only to that file, never to stdout. |
| `testflight info <app-id>` | The app's TestFlight test information: beta description, feedback email, marketing and privacy policy URLs per language, and the beta app review details (contact, demo account and notes). The demo account password is never printed, only whether it is set. |
| `testflight info set <app-id> --locale en-US --description <text>` | Sets the beta app information for one language (`--description`, `--feedback-email`, `--marketing-url`, `--privacy-url`), creating the language if the app has none for it. |
| `testflight review-details set <app-id> --contact-email <email>` | Sets the beta app review details: `--contact-first-name`, `--contact-last-name`, `--contact-phone`, `--contact-email`, `--demo-account-required` (or `--no-demo-account-required`), `--demo-account-name`, `--notes`, and the demo account password from `--demo-account-password` or `ASC_DEMO_ACCOUNT_PASSWORD`, which is sent to Apple and never printed. Refuses a required demo account without a name and password. |
| `testflight notify <build-id>` | Sends the build's "new build available" notification to its testers, for an app that does not notify them automatically. |
| `testflight notes <build-id> --locale en-US --body <text>` | Sets a build's "What to Test" notes for one language (`--body-file <path>` reads them from a file), creating that language's notes if the build has none. |
| `testflight review <build-id>` | A build's beta app review: the submission's state (`WAITING_FOR_REVIEW`, `IN_REVIEW`, `REJECTED` or `APPROVED`, or `null` if never submitted) and the build's external and internal TestFlight states. |
| `testflight review submit <build-id>` | Submits a build for beta app review, which it needs before external groups can test it. The app's review details (contact name, phone and email, and the demo account if one is required) must be filled in under TestFlight > Test Information first; the error names any that are missing. |
| `reviews <app-id>` | Customer reviews filtered by star rating, territory and whether a response exists, with your response. |
| `reviews reply <review-id> --body <text>` | Posts a public developer response to a review (or `--body-file <path>`), replacing your existing one. Apple publishes it after a delay. |
| `reviews delete-reply <review-id>` | Deletes your developer response to a review. |
| `status <app-id>` | Where the app stands on each platform (or one, `--platform`): the live version, a newer version being prepared or in review with its build, any phased release as Apple reports it, and the newest build with its processing state. |
| `sales --frequency MONTHLY --date 2026-09` | A Sales and Trends summary report (`DAILY`, `WEEKLY`, `MONTHLY` or `YEARLY`; `--date` is `YYYY-MM-DD`, `YYYY-MM` or `YYYY`, and a daily report without it is the latest), summed instead of printed row by row: total units and proceeds, then by product type (labelled, so updates and re-downloads stand apart from downloads), country and product (each app and in-app purchase, with `parentSku` naming an in-app purchase's app). Proceeds are units × developer proceeds, kept per currency of proceeds. |
| `finance --month 2026-09` | A fiscal month's financial report, summed the same way, with proceeds from the extended partner share. `--region ZZ` (the default) is every region consolidated; give a region code such as `US` or `EU` for one, or `--detail` for the finance detail report. |
| `analytics <app-id>` | The app's Analytics Reports API requests: ongoing or one-time, and whether Apple stopped one for inactivity. |
| `analytics request <app-id>` | Asks Apple to start generating analytics reports (ongoing, or `--one-time` for a snapshot), reusing an active request of the same kind. Apple generates the first reports 1 to 2 days later. Needs a key with the Admin role. |
| `analytics reports <app-id> --category APP_STORE_ENGAGEMENT` | The reports Apple generates for the app's active requests: id, name and category (`APP_STORE_ENGAGEMENT`, `COMMERCE`, `APP_USAGE`, `FRAMEWORK_USAGE`, `PERFORMANCE`), or one by `--name`, such as App Store Discovery and Engagement Standard, App Downloads Standard, App Sessions Standard or App Crashes. |
| `analytics instances <report-id> --granularity WEEKLY` | A report's instances, one per processing date (`--date YYYY-MM-DD`), daily by default. |
| `analytics summary <instance-id> --group-by Territory` | Downloads one instance's files and sums its numeric columns, in total and by the `--group-by` columns (largest first, `--top` 50). The result lists the report's columns, so run it once without `--group-by` to see what to group by. |
| `metrics <app-id>` | Power and performance metrics (hangs, launch time, disk writes, memory, battery, animation, terminations, storage) summarised: Apple's regression and trend insights, then each metric's percentile and device datasets as version and value points. `--build <build-id>` reads one build's instead; `--type HANG,LAUNCH` and `--device <type>` narrow it. Needs no Xcode. |
| `diagnostics <build-id>` | A build's top diagnostic signatures, heaviest first: hangs, disk writes or launches (`--type HANGS`). |
| `diagnostics logs <signature-id>` | A signature's logs: device, OS and app version, and for each call stack the heaviest path of frames, marking the frame Apple blames (up to 3 stacks and 40 frames each). |
| `xcode-cloud products` | Xcode Cloud products with their app (`--app <app-id>` for one app's). |
| `xcode-cloud workflows <product-id>` | A product's workflows: enabled or not, repository, last change and actions. |
| `xcode-cloud runs <workflow-id>` | A workflow's build runs, newest first: progress, result, start reason, branch or tag, pull request, commit and issue counts. Apple has no branch filter, so `--branch main` filters the page that was read. |
| `xcode-cloud run <run-id>` | One build run: its status, then each action with its issues (errors, warnings, analyzer warnings, test failures) and, for a test action with failures, its failed tests with the devices they failed on. |
| `xcode-cloud artifacts <run-id>` | A run's artifacts per action (logs, archives, result bundles): type, file name, size and download link. Nothing is downloaded. |
| `xcode-cloud start <workflow-id> --branch main` | Starts a workflow on a branch, tag (`--tag`) or open pull request (`--pull-request <number>`) of its repository, optionally `--clean`, and prints the new run. It uses Xcode Cloud compute hours, so without `--yes` it only prints the workflow and the reference it would build. `--wait` then polls the run (`--interval`, `--timeout`, default 60 minutes) and exits 1 unless it succeeded. |
| `xcode-cloud rerun <run-id>` | Rebuilds an earlier run as a new run, with the same `--clean` and `--wait` options. |

Each list command returns one page (up to 200, `--limit`) and reports `hasMore`; when there is more, pass the result's `nextCursor` back as `--cursor` to read the next page. A 429 from Apple is reported as `[quota]` at once, without retrying, except in `builds wait`, which backs off (1 minute, doubling up to 10) and keeps waiting. Run a command with `--help` for its filters.

A listing folder from `metadata pull`, which `metadata push` and `metadata lint --dir` read:

```text
listing/
  version.json                 {"copyright": "2026 Example Ltd"}
  en-US/
    metadata.json              name, subtitle, privacyPolicyUrl, privacyChoicesUrl, privacyPolicyText,
                               description, keywords, promotionalText, whatsNew, supportUrl, marketingUrl
    IPHONE_67-01-home.png      <device group>-<position>-<file name>; videos are app previews
    IPHONE_67-02-search.png
  fr-FR/
    metadata.json
```

In `metadata.json`, `null` or `""` clears a field and a missing key leaves it as it is; unknown keys are refused. A locale folder App Store Connect does not have yet is created (a new app info locale needs a `name`).

Commands that change anything (`versions create` and `set`, `review-details set`, `attach` and `detach`, `metadata set`, `metadata push`, `app-info set`, `pricing set`, `app-info categories`, `apps content-rights`, `availability set`, `age-rating set`, the `iap` and `subscriptions` write commands including `subscriptions offers`, `promoted-purchases set`, `screenshots upload`, `reorder` and `delete`, `custom-pages create`, `set`, `upload` and `submit`, `page-tests create`, `upload`, `submit`, `start` and `stop`, `events create`, `set`, `upload` and `submit`, `builds upload`, `builds compliance`, `builds expire`, `testflight groups create`, `set`, `delete` and `add-build`, `testflight testers add`, `remove` and `import`, `testflight info set`, `testflight review-details set`, `testflight notify`, `testflight notes`, `testflight review submit`, `reviews reply`, `reviews delete-reply`) only print what they would do, with `"dryRun": true`, unless given `--yes`. A dry run still reads from App Store Connect, so it shows the current metadata, where each screenshot would go, the build's current answer or notes, what would happen to each tester email, or the review and any reply that would be replaced or deleted. They need a key whose role allows the change: App Manager, or Customer Support for review replies. A key without it gets a `[permission]` error.

The release commands (`versions attach-build`, `submit`, `cancel-review`, `release` and `phased-release`) reach every user, so they re-read the version before each step, refuse with an `[invalid_input]` error when its state does not allow it, and print the app id, version id and version, and the action, both in the dry run and after `--yes`. They follow the key's own role: a key without the Admin or App Manager role gets a `[permission]` error that says so. `iap submit` and `subscriptions submit` use Apple's in-app purchase and subscription submissions, not the app's review submission.

Sales and finance reports need a team key with the Admin, Finance or Sales and Reports role (finance: Admin or Finance), which an Admin creates in Users and Access → Integrations → Team Keys; an individual key gets a `[permission]` error saying so. They also need your vendor number, from Payments and Financial Reports, as `--vendor-number` or `ASC_VENDOR_NUMBER`. Apple publishes a sales report about a day after its period ends and a finance report after the fiscal month closes; asking earlier, or for a period with no sales, is a `[not_found]` error. Apple sends these reports, and analytics report files, gzipped: the CLI decompresses and parses them in memory and stores nothing. Listing and reading analytics reports needs the Admin, Finance or Sales and Reports role, and `analytics request` only changes anything with `--yes`, like the other write commands.

Setting `ITSAppUsesNonExemptEncryption` in the app's `Info.plist` answers the export compliance question for every build uploaded after it, so most apps only need `builds compliance` for builds already uploaded without it.

Signing assets (certificates, provisioning profiles, bundle IDs and devices) use Apple's Provisioning endpoints, which need a team key: an individual key gets a `[permission]` error saying so.

| Command | What it does |
| --- | --- |
| `certificates` | Signing certificates: type (`--type DISTRIBUTION,IOS_DISTRIBUTION`), platform, serial number and expiry. |
| `profiles` | Provisioning profiles (`--type`, `--state ACTIVE` or `INVALID`, `--name`): type, state, expiry, bundle ID, and up to 50 of their certificates and devices, with the device count. The profile contents are never printed. |
| `bundle-ids` | Bundle IDs (`--identifier`, `--platform`) with their capabilities. |
| `devices` | Registered devices (`--platform`, `--status ENABLED` or `DISABLED`, `--name`): name, UDID, model and status. |
| `certificates create --type DISTRIBUTION --key-out <file> --cert-out <file>` | Makes a new RSA 2048 private key and a certificate signing request for it, and asks Apple for the certificate. The key goes to `--key-out` (PKCS#8 PEM, readable only by you) and the certificate to `--cert-out` (DER, like the `.cer` Apple's website gives). Neither file may exist already, and neither is printed. If Apple refuses, the key file is removed. The dry run lists the certificates of that type you already have, since Apple limits how many there can be. |
| `certificates renew <certificate-id> --key-out <file> --cert-out <file>` | Creates a new certificate of the same type as an expiring one, as `certificates create` does. The old one keeps working until it expires or is revoked. |
| `certificates revoke <certificate-id>` | Revokes a certificate. This cannot be undone and makes every profile that includes it invalid; the dry run lists those profiles. |
| `profiles create --name <name> --type IOS_APP_STORE --bundle-id <id> --certificate <ids> --out <file>` | Creates a profile for a bundle ID (the id from `bundle-ids`) and certificates and writes it to `--out`. Development and ad hoc profiles also need `--device <ids>` from `devices`. |
| `profiles renew <profile-id> --out <file>` | Replaces an invalid or expiring profile: deletes it, then creates one with the same name, type, bundle ID, certificates and devices, or the ones given with `--certificate` and `--device` (for example after `certificates renew`). Apple has no call to regenerate a profile and is taken to refuse a second profile with the same name (unverified), so if creating the new one fails, the error says the old one is already deleted. |
| `profiles delete <profile-id>` | Deletes a profile. This cannot be undone. |
| `bundle-ids create --identifier com.example.app --name <name> --platform IOS` | Registers a bundle ID (`IOS`, `MAC_OS` or `UNIVERSAL`). The dry run checks the identifier is free. |
| `bundle-ids capabilities <bundle-id-id>` | A bundle ID's enabled capabilities and their settings. |
| `bundle-ids enable <bundle-id-id> --capability PUSH_NOTIFICATIONS` | Turns on a capability, with `--setting KEY=OPTION` where it has settings (such as `ICLOUD_VERSION=XCODE_6` or `APPLE_ID_AUTH_APP_CONSENT=PRIMARY_APP_CONSENT`). To change a capability's settings, disable and enable it again. |
| `bundle-ids disable <bundle-id-id> --capability PUSH_NOTIFICATIONS` | Turns off a capability. |
| `devices register --name <name> --udid <udid>` or `--file devices.txt` | Registers one device, or each `UDID,name[,platform]` line of a file (comma or tab separated, platform `ios` or `mac`, as in the Developer website's upload file), skipping UDIDs already registered. Each device counts against the membership year's device limit and cannot be removed until it renews. |
| `signing sync --git-url <repo> --type DISTRIBUTION --profile-type IOS_APP_STORE --bundle-id com.example.app --out-dir <dir>` | Keeps the team's certificate, private key and profiles in an encrypted store in a private git repository: creates or renews what is missing, invalid or expiring within `--renew-within-days` (30), commits and pushes it, and writes the decrypted files to `--out-dir` (readable only by you). The passphrase comes from `ASC_SIGNING_PASSPHRASE` (or the variable named by `--passphrase-env`) and is never stored. `--readonly`, for CI, never creates anything, fails if the store is not usable, and needs no `--yes`. |
| `signing nuke --git-url <repo> --type DISTRIBUTION --profile-type IOS_APP_STORE` | Revokes every certificate of the type on the team (not only the store's), deletes every profile of the given types and removes them from the store. This cannot be undone. |
| `signing install --keychain <file> --create-keychain --cert <file> --key <file> --profile <file>` | macOS only, and needs no App Store Connect key: imports the certificate and key into the keychain (made for CI with `--create-keychain`), unlocks it, lets `codesign` use the key without a prompt and adds it to the search list; copies profiles to `~/Library/Developer/Xcode/UserData/Provisioning Profiles` (Xcode 16 and later; `--profiles-dir` to change) as `<UUID>.mobileprovision`. The keychain password comes from `ASC_KEYCHAIN_PASSWORD` (or `--password-env`) and reaches `security` on stdin, never the command line. |
| `signing uninstall --keychain <file>` | macOS only: removes the keychain from the search list and deletes it. It never deletes the login keychain. |

New capabilities and devices do not reach existing profiles: renew those with `profiles renew` (with `--device` for new devices), or let `signing sync` replace them.

The signing store holds only encrypted files: `certs/<type>/<certificate-id>.cer.enc` and `.key.enc`, and `profiles/<profile-type>/<bundle-identifier>/<profile-id>.mobileprovision.enc`. Each is AES-256-GCM with a key derived by scrypt (N = 2^17, r = 8, p = 1) from the passphrase and a random per-file salt; the header (`ASCS`, format version 1, the scrypt parameters, salt and nonce) and the file's path in the store are authenticated, so a file cannot be moved or altered without failing to decrypt. The format is documented in `apps/asc/src/asc/store.ts`. Profiles the store makes are named `asc <profile-type> <bundle-identifier>`; development and ad hoc ones include every enabled device of their platform. A CI job runs:

```sh
asc signing sync --git-url "$STORE_URL" --type DISTRIBUTION --profile-type IOS_APP_STORE --bundle-id com.example.app --out-dir signing --readonly
asc signing install --keychain "$RUNNER_TEMP/ci.keychain-db" --create-keychain --cert signing/<certificate-id>.cer --key signing/<certificate-id>.key --profile signing/com.example.app.IOS_APP_STORE.mobileprovision --yes
asc signing uninstall --keychain "$RUNNER_TEMP/ci.keychain-db" --yes
```

These write commands also change nothing without `--yes`. `signing install` imports the `.cer` and key files from `certificates create` as they are.

Mac software distributed outside the Mac App Store is notarized through Apple's Notary API, which takes the same key, so it runs anywhere the key is, including Linux CI, with no Xcode. It needs a team key with the Admin or Developer role: an individual key gets a `[permission]` error saying so.

| Command | What it does |
| --- | --- |
| `notarize submit <file>` | Submits a `.zip`, `.pkg` or `.dmg` for notarization: it names the file and its SHA-256 to Apple, uploads the file to the Amazon S3 location Apple's response gives with the temporary credentials it carries (in parts, read from disk one at a time), and prints the submission's id and status. Without `--yes` it only prints the file's name, size and SHA-256. `--wait` then checks every 30 seconds (`--interval`) for up to 30 minutes (`--timeout`) and exits 1 unless the result is `Accepted`. |
| `notarize status <submission-id>` | One submission's status (`In Progress`, `Accepted`, `Invalid` or `Rejected`), name and date. |
| `notarize log <submission-id>` | Apple's log for a finished submission: the outcome and every issue with its severity, path, message and architecture. Read it even when notarization succeeds, for warnings. |
| `notarize history` | The team's 100 most recent submissions. |

Stapling the ticket to the file stays a local step on a Mac once notarization is `Accepted`, so the app opens without a network check: `xcrun stapler staple MyApp.dmg` (or the `.pkg`, or the `.app` inside a `.zip`, which you then zip again).

For an endpoint or field no command covers, `api <method> <path>` sends one request with your key and prints Apple's JSON, so there is no need to sign a token by hand for `curl`. When the same raw request is needed often, that is a sign a real command is missing.

| Command | What it does |
| --- | --- |
| `api GET /v1/apps --query 'filter[bundleId]=com.example.app'` | Sends a `GET` (repeat `--query key=value`; a key given twice becomes a comma-separated list). `--paginate` follows `links.next` and prints every page's `data` and `included` joined, with the page count. |
| `api PATCH /v1/apps/<id> --body patch.json` | Sends a `POST`, `PATCH` or `DELETE` with a JSON body from a file, or `--body -` for stdin. Like every write command it only prints the request without `--yes`, and with it prints Apple's response (`null` for a 204). |

Only paths such as `/v1/apps`, or URLs on `https://api.appstoreconnect.apple.com`, are accepted: a URL on any other host is refused before anything is sent, so the token never leaves Apple's API. Errors are classified like every other command's (`[permission]`, `[not_found]` and so on).

Team members, sandbox testers and webhooks:

| Command | What it does |
| --- | --- |
| `users` | Team members by last name (`--role`, `--app`): roles, provisioning access and visible apps. Emails are left out unless `--emails` is given. The `users` commands need a team key with the Admin role. |
| `users invite --email <email> --first-name <name> --last-name <name> --role APP_MANAGER --app <app-ids>` | Invites someone with roles and, with `--app`, only those apps (without it, all apps); `--provisioning` lets them manage signing assets. The Account Holder role cannot be given. |
| `users set <user-id> --role DEVELOPER --app <app-ids>` | Changes a user's roles, visible apps (`--app` or `--all-apps`) or provisioning access (`--provisioning`, `--no-provisioning`); `--role` and `--app` replace the current lists. The Account Holder cannot be changed. |
| `users remove <user-id>` | Removes a user from the team. This cannot be undone; they would need a new invitation. |
| `users invitations` | Pending invitations with roles, visible apps and expiry; emails only with `--emails`. |
| `users invitations cancel <invitation-id>` | Cancels a pending invitation. |
| `sandbox testers` | Sandbox Apple Accounts for testing in-app purchases: name, storefront, renewal rate and interrupted purchases. Account emails only with `--emails`. Creating sandbox testers is not in Apple's API. |
| `sandbox testers set <tester-id> --territory GBR --renewal-rate MONTHLY_RENEWAL_EVERY_FIVE_MINUTES` | Changes a tester's storefront, monthly subscription renewal rate or `--interrupt-purchases`. |
| `sandbox testers clear-history <tester-id...>` | Clears testers' purchase history. This cannot be undone. |
| `webhooks <app-id>` | An app's webhooks: name, URL, whether it is enabled and its events. |
| `webhooks create <app-id> --name <name> --url https://… --event BUILD_UPLOAD_STATE_UPDATED --secret-env <variable>` | Creates a webhook for the given events (comma-separated or repeated). Only `https` URLs are accepted. The signing secret comes from the environment variable named by `--secret-env`, or `--secret-out <file>` generates one and writes it to that new file (mode 600); it is never printed, and the file is removed if Apple refuses the webhook. |
| `webhooks set <webhook-id>` | Changes `--name`, `--url`, `--event` (replacing the list), `--enable` or `--disable`, or rotates the secret with `--secret-env` or `--secret-out`. |
| `webhooks delete <webhook-id>` and `webhooks ping <webhook-id>` | Deletes a webhook, or sends it a test event. |
| `webhooks deliveries <webhook-id>` | Its deliveries (`--state FAILED`, `--since`, `--until`): state, dates, event type, the HTTP status the URL answered with and the first 500 characters of its response. Event payloads are left out. |
| `webhooks deliveries redeliver <delivery-id>` | Sends a delivery's event again as a new delivery. |

Each of these writes, `webhooks ping` included, also changes nothing without `--yes`; the dry run shows the current user, invitation, tester or webhook and the change.

The key comes from options, or from environment variables when an option is not given. Nothing is stored: the `.p8` file is read on each run.

| Option | Variable | Value |
| --- | --- | --- |
| `--key-id` | `ASC_KEY_ID` | The key ID, such as `2X9R4HXF34`. |
| `--issuer-id` | `ASC_ISSUER_ID` | The issuer ID, for a team key. Leave it out for an individual key. |
| `--private-key` | `ASC_PRIVATE_KEY_PATH` | Path to the key's `.p8` file. |
| `--vendor-number` (`sales`, `finance`) | `ASC_VENDOR_NUMBER` | Your vendor number, for sales and finance reports. |
| `--demo-account-password` (`testflight review-details set`) | `ASC_DEMO_ACCOUNT_PASSWORD` | The beta review demo account's password; sent to Apple, never printed. |

`completion <bash|zsh|fish>` prints a shell completion script for every command, subcommand and option, and the fixed choices such as platforms and certificate types. It is generated from the installed CLI each time it runs, so after rebuilding a newer version, open a new shell to pick up new commands. Live values such as app ids are not completed. Load it from your shell's startup file (with `asc` on your `PATH`):

| Shell | Add to |
| --- | --- |
| bash | `~/.bashrc`: `source <(asc completion bash)` |
| zsh | `~/.zshrc`, after `compinit`: `source <(asc completion zsh)` |
| fish | `~/.config/fish/config.fish`: `asc completion fish \| source` |

The result is printed as JSON on stdout. Errors go to stderr, and a failure exits with code 1. Build it, then run it:

```sh
pnpm --filter @tartinerlabs/app-store-connect-mcp build
export ASC_KEY_ID=<key id> ASC_ISSUER_ID=<issuer id> ASC_PRIVATE_KEY_PATH=<path to AuthKey.p8>
node apps/asc/dist/index.js apps
node apps/asc/dist/index.js reviews <app-id> --rating 1,2
```

## Bing Webmaster Tools server

`apps/bing` gives read-only access to Bing Webmaster Tools, with the same endpoint and deployment model as the Search Console server (Vercel and Neon). Signing in with Google only identifies you and requests no extra Google scopes. After signing in, each user connects their own Bing Webmaster account at `https://<your-deployment>/connect`, which sends them through Bing's own OAuth (scope `webmaster.read`, not Microsoft Entra). Bing tokens are stored encrypted per user and sent to Bing as a Bearer header. The same page reconnects or disconnects the account.

| Tool | What it does |
| --- | --- |
| `ping` | Checks that the server is running. |
| `list_sites` | Lists the sites in the connected Bing Webmaster account and whether each is verified. |
| `url_info` | Bing's index details for one URL: discovery and last crawl dates, HTTP status seen, document size and inbound anchor count. |
| `crawl_stats` | Daily crawl statistics for a site: pages crawled, crawl errors by cause, indexed pages and inbound links. |
| `crawl_issues` | URLs on which Bing found crawl problems, with the HTTP code, inbound link count and Bing's issues flag value. |
| `list_sitemaps` | Sitemaps and feeds submitted to Bing, with status, URL count, size and dates. |
| `search_performance` | Impressions, clicks, click-through rate and average position on Bing, grouped by query or by page. |

Setup differs from the Search Console server in three ways:

1. In [Bing Webmaster Tools](https://www.bing.com/webmasters), open *Settings → API Access → OAuth Client* and register a client with the redirect URI `${BETTER_AUTH_URL}/api/auth/callback/bing` (HTTPS only). One client serves every user of the deployment; each user authorises their own account through it.
2. Create a separate Vercel project with *Root Directory* `apps/bing`, with its own Neon database (migrations in `apps/bing/drizzle/`). Set the project's *Framework Preset* to **Hono**: Vercel may auto-detect Vite, which serves the compiled files as a static site and returns `404` for every route.
3. Set the same environment variables as above, plus `BING_CLIENT_ID` and `BING_CLIENT_SECRET`. `BETTER_AUTH_URL` must be the full origin including `https://` (for example `https://bing.example.com`, no trailing slash); without the scheme every request fails with `FUNCTION_INVOCATION_FAILED`. The Google OAuth client needs `${BETTER_AUTH_URL}/api/auth/callback/google` as a redirect URI and no extra scopes.

Not yet verified against a real Bing sign-in: the account identifier read from the access token, token refresh, PKCE, and the response shapes and error codes of the Bing API. Bing's AI Performance report (Copilot citations) has no API, so the server shows whether pages are crawled and indexed by Bing, not how often AI answers cite them.

## Local development

```sh
pnpm check        # typecheck + lint + test
pnpm format       # Biome formatter
pnpm -C apps/gsc test:watch   # Vitest in watch mode
```

The tests need no database, network or Google credentials. The OAuth tests run a real Better Auth instance on its in-memory adapter: they cover the discovery metadata, the 401 challenge, the allow-list at sign-up and on every MCP request, the `/sign-in` and `/consent` pages, a full authorisation-code + PKCE flow ending in an MCP tool call, and Google token retrieval and refresh (with Google's token endpoint mocked).

## Production build

```sh
pnpm build        # tsc emits packages/core/dist/ and apps/*/dist/
```

## Testing with the MCP Inspector

Not verified yet: start the web UI with `pnpm dlx @modelcontextprotocol/inspector`, choose the *Streamable HTTP* transport and enter `https://<your-domain>/mcp`. The Inspector must support the OAuth flow described above.

## Security considerations

- Anyone who can sign in with Google can use the server, and each user only reads the Search Console properties **their own** Google account has access to. While the Google OAuth app is in *Testing*, only its listed test users can sign in.
- Each MCP client must be approved on the consent page, which shows the client's name, the signed-in account and the host it will redirect to. Only approve clients you started yourself.
- Only the read-only Search Console scope is requested from Google, unless you opt into `GSC_ENABLE_WRITE`; even then the only write tool is `submit_sitemap`. MCP access tokens are short-lived JWTs (1 hour) bound to the `/mcp` resource; refresh tokens rotate.
- Google access and refresh tokens are encrypted at rest with a key derived from `BETTER_AUTH_SECRET`. Keep that secret and `DATABASE_URL` private; rotating the secret means everyone signs in again.
- Tokens, secrets, cookies and `Authorization` headers are never logged or returned in tool results. Better Auth's own logger is set to `warn` and routed to Pino on stderr without its extra arguments.
- The `/sign-in` and `/consent` pages verify Better Auth's signature on the query before acting on it, escape every reflected value, and send a strict Content Security Policy, `X-Frame-Options: DENY` and `Cache-Control: no-store`.
- Revoke Google access at any time from <https://myaccount.google.com/permissions>; the server then reports an `[auth]` error until you reconnect.

## Known limitations

- Not yet verified end to end: a real deployment on Vercel and Neon, a real Google sign-in, real Search Console API calls, and a connection from Claude Code or another client (including fetching a real client metadata document). The rewrites rely on Vercel passing the original path in `request.url` to the function, as Vercel's documentation describes. After deploying, check discovery with `curl -i -X POST https://<your-domain>/mcp` (expect `401` and the `resource_metadata` URL), `curl https://<your-domain>/.well-known/oauth-protected-resource/mcp` and `curl https://<your-domain>/api/auth/.well-known/openid-configuration`.
- `requireMcpAuth` downloads the JWKS from the deployment's own public URL. With Vercel Deployment Protection enabled (the default for preview deployments), that request and the OAuth flow are blocked; use the production deployment or turn protection off for previews.
- The JWKS is fetched over HTTPS from the deployment itself on a cold start, which adds latency to the first request.
- URL Inspection is limited by Google to 2,000 inspections per property per day; Search Analytics has load-based quotas. Quota errors are reported as `[quota]`.
- The Search Analytics API returns top rows only and does not guarantee every row.
- Vercel's handling of pnpm 12 (`devEngines`) and of the Node.js version declared in `devEngines` is unverified; set the Node.js version in the Vercel project settings if needed.

## Roadmap

- Opening the deployment to more users after Google's sensitive-scope verification.

## Licence

[MIT](LICENSE) © 2026 Tartiner Labs
