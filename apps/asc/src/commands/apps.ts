import * as z from "zod";
import { type AscClient, type AscDocument, pageInfo } from "../asc/client.ts";
import { limitSchema } from "../schemas/common.ts";

interface AppAttributes {
  name?: string;
  bundleId?: string;
  sku?: string;
  primaryLocale?: string;
}

export const appsInput = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  bundleId: z.string().trim().min(1).max(200).optional(),
  sort: z
    .enum(["name", "-name", "bundleId", "-bundleId", "sku", "-sku"])
    .default("name"),
  limit: limitSchema,
});

export async function listApps(
  client: AscClient,
  input: z.output<typeof appsInput>,
) {
  const response = await client.get<AscDocument<AppAttributes>>("/v1/apps", {
    "filter[name]": input.name,
    "filter[bundleId]": input.bundleId,
    sort: input.sort,
    "fields[apps]": ["name", "bundleId", "sku", "primaryLocale"],
    limit: input.limit,
  });
  return {
    apps: response.data.map((app) => ({
      id: app.id,
      name: app.attributes?.name,
      bundleId: app.attributes?.bundleId,
      sku: app.attributes?.sku,
      primaryLocale: app.attributes?.primaryLocale,
    })),
    ...pageInfo(response),
  };
}
