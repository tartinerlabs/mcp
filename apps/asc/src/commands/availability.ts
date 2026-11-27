import * as z from "zod";
import type { AscClient, AscResource } from "../asc/client.ts";
import { appIdSchema } from "../schemas/common.ts";
import {
  AscApiError,
  classifyError,
  InvalidInputError,
  NotFoundError,
  UploadIncompleteError,
} from "../utils/errors.ts";
import { allPages, dateSchema, territorySchema } from "./pricing.ts";

interface TerritoryAvailabilityAttributes {
  available?: boolean;
  releaseDate?: string | null;
  preOrderEnabled?: boolean;
  preOrderPublishDate?: string | null;
  contentStatuses?: string[];
}

/** The app's availability and every territory's entry in it. */
async function readAvailability(client: AscClient, appId: string) {
  const { data } = await client.get<{
    data: AscResource<{ availableInNewTerritories?: boolean }>;
  }>(`/v1/apps/${appId}/appAvailabilityV2`, {
    "fields[appAvailabilities]": ["availableInNewTerritories"],
  });
  const territories = await allPages<TerritoryAvailabilityAttributes>(
    client,
    `/v2/appAvailabilities/${data.id}/territoryAvailabilities`,
    {
      include: ["territory"],
      "fields[territoryAvailabilities]": [
        "available",
        "releaseDate",
        "preOrderEnabled",
        "preOrderPublishDate",
        "contentStatuses",
        "territory",
      ],
      limit: 200,
    },
  );
  return {
    id: data.id,
    availableInNewTerritories: data.attributes?.availableInNewTerritories,
    territories: territories.data.map(({ id, attributes, relationships }) => ({
      id,
      territory: relationships?.territory?.data?.id,
      available: attributes?.available,
      releaseDate: attributes?.releaseDate ?? null,
      preOrderEnabled: attributes?.preOrderEnabled,
      preOrderPublishDate: attributes?.preOrderPublishDate ?? null,
      contentStatuses: attributes?.contentStatuses ?? [],
    })),
  };
}

export const availabilityInput = z.object({ appId: appIdSchema });

/**
 * Where an app is sold: whether it joins new territories automatically, and
 * each territory's availability, release date, pre-order and the statuses
 * Apple reports, such as one blocking sale there.
 */
export async function getAvailability(
  client: AscClient,
  input: z.output<typeof availabilityInput>,
) {
  const availability = await readAvailability(client, input.appId);
  const available = availability.territories.filter((item) => item.available);
  return {
    appId: input.appId,
    availableInNewTerritories: availability.availableInNewTerritories,
    availableCount: available.length,
    unavailable: availability.territories
      .filter((item) => !item.available)
      .map((item) => item.territory),
    territories: availability.territories.map(({ id: _id, ...rest }) => rest),
  };
}

export const setAvailabilityInput = z.object({
  appId: appIdSchema,
  territories: z
    .array(territorySchema)
    .min(1, "Give the territories with --territory, such as USA,GBR.")
    .max(200),
  available: z.boolean().optional(),
  preOrder: z.boolean().optional(),
  releaseDate: dateSchema.optional(),
  yes: z.boolean().default(false),
});

/**
 * Adds an app to territories, or removes it from them, and turns pre-orders
 * on or off there with the release date. Without `yes`, shows each
 * territory's current availability, pre-order, release date, content
 * statuses and what would change.
 *
 * Apple sets the pre-order publish date itself; only `releaseDate` and
 * `preOrderEnabled` can be sent, and a pre-order needs a release date.
 *
 * Unverified: Apple documents `PATCH /v1/territoryAvailabilities/{id}` only as
 * updating the release territories of an app pre-order. That it also adds or
 * removes territories for an app already on sale has not been checked against
 * the real API; check it with a real key before relying on it.
 */
export async function setAvailability(
  client: AscClient,
  input: z.output<typeof setAvailabilityInput>,
) {
  if (
    input.available === undefined &&
    input.preOrder === undefined &&
    input.releaseDate === undefined
  ) {
    throw new InvalidInputError(
      "Give --available or --no-available, --pre-order or --no-pre-order, or --release-date.",
    );
  }
  const availability = await readAvailability(client, input.appId);
  const byCode = new Map(
    availability.territories.map((item) => [item.territory, item]),
  );
  const unknown = input.territories.filter((code) => !byCode.has(code));
  if (unknown.length > 0) {
    throw new NotFoundError(
      `App ${input.appId} has no availability entry for ${unknown.join(", ")}; the availability command lists its territories.`,
    );
  }
  const territories = [...new Set(input.territories)].flatMap(
    (code) => byCode.get(code) ?? [],
  );
  const diff = (item: (typeof territories)[number]) => {
    const result: Record<string, unknown> = {};
    if (input.available !== undefined && item.available !== input.available) {
      result.available = input.available;
    }
    if (
      input.preOrder !== undefined &&
      item.preOrderEnabled !== input.preOrder
    ) {
      result.preOrderEnabled = input.preOrder;
    }
    if (
      input.releaseDate !== undefined &&
      item.releaseDate?.slice(0, 10) !== input.releaseDate
    ) {
      result.releaseDate = input.releaseDate;
    }
    return result;
  };
  const action =
    input.available === undefined
      ? "set-pre-order"
      : input.available
        ? "add-territories"
        : "remove-territories";
  const changing = territories.filter(
    (item) => Object.keys(diff(item)).length > 0,
  );
  if (!input.yes) {
    return {
      dryRun: true,
      action,
      appId: input.appId,
      territories: territories.map((item) => ({
        territory: item.territory,
        available: item.available,
        preOrderEnabled: item.preOrderEnabled,
        releaseDate: item.releaseDate,
        preOrderPublishDate: item.preOrderPublishDate,
        contentStatuses: item.contentStatuses,
        changes: diff(item),
      })),
    };
  }
  const changed: string[] = [];
  let current: string | undefined;
  try {
    for (const item of changing) {
      current = item.territory ?? item.id;
      await client.patch(`/v1/territoryAvailabilities/${item.id}`, {
        data: {
          type: "territoryAvailabilities",
          id: item.id,
          attributes: diff(item),
        },
      });
      changed.push(item.territory ?? item.id);
    }
  } catch (error) {
    const done =
      changed.length > 0
        ? `Already changed: ${changed.join(", ")}.`
        : "Nothing was changed.";
    // Apple answers 409 or 422 when it will not take the change.
    if (
      error instanceof AscApiError &&
      (error.status === 409 || error.status === 422)
    ) {
      throw new InvalidInputError(
        `App Store Connect would not change availability in ${current}: its content statuses or missing agreements may block it (the availability command lists its content statuses). ${done} ${classifyError(error).message}`,
        { cause: error },
      );
    }
    throw new UploadIncompleteError(
      `Changing availability stopped partway. ${done} Run the command again to finish.`,
      { cause: error },
    );
  }
  return { dryRun: false, action, appId: input.appId, changed };
}
