import { readFile, writeFile } from "node:fs/promises";
import * as z from "zod";
import {
  type AppStoreClient,
  MAX_LOOKUP_IDS,
  type StoreListing,
} from "../appstore/client.ts";
import {
  appIdSchema,
  countrySchema,
  filePathSchema,
} from "../schemas/common.ts";
import { StateFileError } from "../utils/errors.ts";

export const competitorsSchema = z.object({
  appIds: z.array(appIdSchema).min(1).max(MAX_LOOKUP_IDS),
  country: countrySchema,
  snapshot: filePathSchema,
});

export type CompetitorsInput = z.infer<typeof competitorsSchema>;

interface Snapshot {
  takenAt: string;
  country: string;
  apps: StoreListing[];
}

// Long text is compared whole but reported by length, to keep output short.
const LONG_FIELDS = new Set<keyof StoreListing>([
  "description",
  "releaseNotes",
]);
const TRACKED_FIELDS: (keyof StoreListing)[] = [
  "name",
  "developer",
  "version",
  "versionReleaseDate",
  "releaseNotes",
  "description",
  "genre",
  "price",
  "rating",
  "ratingCount",
  "screenshotCount",
];

function isSnapshot(value: unknown): value is Snapshot {
  if (typeof value !== "object" || value === null) return false;
  const snapshot = value as Record<string, unknown>;
  return (
    typeof snapshot.takenAt === "string" &&
    typeof snapshot.country === "string" &&
    Array.isArray(snapshot.apps)
  );
}

async function readSnapshot(path: string): Promise<Snapshot | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return undefined;
    throw error;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  if (!isSnapshot(data)) {
    throw new StateFileError(
      `${path} is not a snapshot this command wrote. Use a new --snapshot path.`,
    );
  }
  return data;
}

function shown(field: keyof StoreListing, value: unknown) {
  return LONG_FIELDS.has(field) && typeof value === "string"
    ? { length: [...value].length }
    : value;
}

/**
 * Looks up the apps' public listings in one storefront, reports what changed
 * since the snapshot file was last written, then replaces the snapshot. The
 * first run only records. Subtitles and keyword fields are not in Apple's
 * public data, so they cannot be compared.
 */
export async function diffCompetitors(
  client: AppStoreClient,
  input: CompetitorsInput,
  now: () => number,
) {
  const ids = [...new Set(input.appIds)];
  const previous = await readSnapshot(input.snapshot);
  if (previous && previous.country !== input.country) {
    throw new StateFileError(
      `${input.snapshot} holds the ${previous.country} storefront, not ${input.country}. Use one snapshot file per country.`,
    );
  }
  const listings = await client.lookup(ids, input.country);
  const before = new Map(previous?.apps.map((app) => [app.id, app]));
  const found = new Set(listings.map((app) => app.id));

  const apps = listings.map((listing) => {
    const old = before.get(listing.id);
    if (!old) return { id: listing.id, name: listing.name, status: "new" };
    const changes = TRACKED_FIELDS.filter(
      (field) => old[field] !== listing[field],
    ).map((field) => ({
      field,
      before: shown(field, old[field]),
      after: shown(field, listing[field]),
    }));
    return {
      id: listing.id,
      name: listing.name,
      status: changes.length > 0 ? "changed" : "unchanged",
      ...(changes.length > 0 && { changes }),
    };
  });

  const takenAt = new Date(now()).toISOString();
  await writeFile(
    input.snapshot,
    `${JSON.stringify({ takenAt, country: input.country, apps: listings } satisfies Snapshot, null, 2)}\n`,
  );
  return {
    country: input.country,
    takenAt,
    comparedWith: previous?.takenAt ?? null,
    apps,
    // Not in this storefront, or removed from sale.
    notFound: ids.filter((id) => !found.has(id)),
  };
}
