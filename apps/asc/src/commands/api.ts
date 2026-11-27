import * as z from "zod";
import type { AscClient, AscResource } from "../asc/client.ts";
import { InvalidInputError, UnexpectedResponseError } from "../utils/errors.ts";

/**
 * An escape hatch: sends one request to the App Store Connect API with the
 * CLI's key and prints Apple's JSON. Only paths on the API host are taken, so
 * the token is never sent elsewhere. A raw request needed often is a sign
 * that a real command is missing.
 */

const ASC_API = "https://api.appstoreconnect.apple.com";

export const API_METHODS = ["GET", "POST", "PATCH", "DELETE"] as const;

export const apiInput = z.object({
  method: z.enum(API_METHODS),
  path: z.string().trim().min(1),
  /** `key=value` pairs; a key given twice becomes a comma-separated list, as Apple's filters take. */
  query: z.array(z.string()).default([]),
  /** The request body as text, already read from the --body file or stdin. */
  body: z.string().optional(),
  paginate: z.boolean().default(false),
  yes: z.boolean().default(false),
});

/** The path (with any query it carries) on the API host; anything else is refused. */
function apiPath(path: string): string {
  let url: URL;
  try {
    url = new URL(path, ASC_API);
  } catch {
    throw new InvalidInputError(`${path} is not a URL or path.`);
  }
  if (url.origin !== ASC_API || !path.match(/^(\/[^/\\]|https:\/\/)/)) {
    throw new InvalidInputError(
      "Give a path such as /v1/apps, or a URL on https://api.appstoreconnect.apple.com; the API key is never sent to another host.",
    );
  }
  return `${url.pathname}${url.search}`;
}

function parseQuery(pairs: string[]): Record<string, string[]> {
  const query: Record<string, string[]> = {};
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    if (at <= 0) {
      throw new InvalidInputError(
        `--query ${pair} is not key=value, such as filter[platform]=IOS.`,
      );
    }
    const key = pair.slice(0, at);
    query[key] = [...(query[key] ?? []), pair.slice(at + 1)];
  }
  return query;
}

function parseBody(body: string | undefined): unknown {
  if (body === undefined) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    throw new InvalidInputError("The --body is not valid JSON.");
  }
}

interface Page {
  data?: unknown;
  included?: AscResource[];
  links?: { next?: string };
}

/** Follows `links.next` from a GET, joining every page's `data` and `included`. */
async function paginate(
  client: AscClient,
  path: string,
  query: Record<string, string[]>,
) {
  const data: unknown[] = [];
  const included = new Map<string, AscResource>();
  let pages = 0;
  let next: string | undefined = path;
  while (next) {
    // The next link already carries the query and cursor.
    const page: Page = await client.get<Page>(
      next,
      pages === 0 ? query : undefined,
    );
    pages++;
    if (!Array.isArray(page.data)) {
      throw new UnexpectedResponseError(
        "--paginate needs a collection: this response's data is not a list.",
      );
    }
    data.push(...page.data);
    for (const resource of page.included ?? []) {
      included.set(`${resource.type}/${resource.id}`, resource);
    }
    next = page.links?.next ? apiPath(page.links.next) : undefined;
  }
  return {
    data,
    ...(included.size ? { included: [...included.values()] } : {}),
    pages,
  };
}

/** Sends a GET and returns Apple's response, every page joined with `paginate`. */
export async function apiGet(
  client: AscClient,
  input: z.output<typeof apiInput>,
) {
  const path = apiPath(input.path);
  const query = parseQuery(input.query);
  if (input.body !== undefined) {
    throw new InvalidInputError("A GET request takes no --body.");
  }
  if (input.paginate) return paginate(client, path, query);
  return client.get<unknown>(path, query);
}

/**
 * Sends a POST, PATCH or DELETE. Without `yes`, checks the input and shows
 * the request that would be sent; with it, prints Apple's response (null for
 * a 204).
 */
export async function apiWrite(
  client: AscClient,
  input: z.output<typeof apiInput>,
) {
  if (input.paginate) {
    throw new InvalidInputError("--paginate only follows pages of a GET.");
  }
  const base = apiPath(input.path);
  const query = parseQuery(input.query);
  const body = parseBody(input.body);
  if (input.method !== "DELETE" && body === undefined) {
    throw new InvalidInputError(
      `A ${input.method} request needs a JSON body: give --body <file>, or --body - to read stdin.`,
    );
  }
  // Writes take no client-side query merge, so put the query in the path.
  const url = new URL(base, ASC_API);
  for (const [key, values] of Object.entries(query)) {
    url.searchParams.set(key, values.join(","));
  }
  const path = `${url.pathname}${url.search}`;
  const request = { method: input.method, path, body };
  if (!input.yes) return { dryRun: true, request };

  let response: unknown;
  if (input.method === "POST") response = await client.post(path, body);
  else if (input.method === "PATCH") response = await client.patch(path, body);
  else await client.delete(path, body);
  return { dryRun: false, request, response: response ?? null };
}
