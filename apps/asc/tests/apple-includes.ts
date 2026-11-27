/**
 * Makes a mocked GET answer like App Store Connect: a resource's relationships only come back when
 * the request names them in `include`, even when `fields[...]` asks for them. Wrap a test's `get`
 * with this so a command that forgets an `include` fails in tests as it does against Apple.
 */
import type { AscQuery } from "../src/asc/client.ts";

type Get = (path: string, query?: AscQuery) => Promise<unknown>;

function included(query: AscQuery = {}): Set<string> {
  const value: unknown = query.include;
  const names = Array.isArray(value)
    ? value.map(String)
    : typeof value === "string"
      ? value.split(",")
      : [];
  return new Set(names.map((name) => name.trim()).filter(Boolean));
}

function strip(resource: unknown, keep: Set<string>) {
  if (!resource || typeof resource !== "object") return resource;
  const { relationships, ...rest } = resource as {
    relationships?: Record<string, unknown>;
  };
  if (!relationships) return resource;
  const kept = Object.fromEntries(
    Object.entries(relationships).filter(([name]) => keep.has(name)),
  );
  return Object.keys(kept).length > 0 ? { ...rest, relationships: kept } : rest;
}

export function appleIncludes<G extends Get>(get: G): G {
  return (async (path: string, query?: AscQuery) => {
    const response = await get(path, query);
    if (!response || typeof response !== "object" || !("data" in response)) {
      return response;
    }
    const keep = included(query);
    const { data } = response as { data: unknown };
    return {
      ...response,
      data: Array.isArray(data)
        ? data.map((item) => strip(item, keep))
        : strip(data, keep),
    };
  }) as G;
}
