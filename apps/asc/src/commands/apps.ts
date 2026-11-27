import * as z from "zod";
import {
  type AscClient,
  type AscDocument,
  type AscResource,
  pageInfo,
} from "../asc/client.ts";
import { appIdSchema, cursorSchema, limitSchema } from "../schemas/common.ts";

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
  cursor: cursorSchema,
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
    cursor: input.cursor,
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

export const CONTENT_RIGHTS = [
  "DOES_NOT_USE_THIRD_PARTY_CONTENT",
  "USES_THIRD_PARTY_CONTENT",
] as const;

export const contentRightsInput = z.object({
  appId: appIdSchema,
  declaration: z.enum(CONTENT_RIGHTS, {
    error: "Give --uses-third-party-content or --no-third-party-content.",
  }),
  yes: z.boolean().default(false),
});

/**
 * Sets whether the app shows, accesses or includes third-party content.
 * Without `yes`, shows the current and new declaration.
 */
export async function setContentRights(
  client: AscClient,
  input: z.output<typeof contentRightsInput>,
) {
  const { data } = await client.get<{
    data: AscResource<
      AppAttributes & { contentRightsDeclaration?: string | null }
    >;
  }>(`/v1/apps/${input.appId}`, {
    "fields[apps]": ["name", "contentRightsDeclaration"],
  });
  const current = data.attributes?.contentRightsDeclaration ?? null;
  const changes = current !== input.declaration;
  if (!input.yes) {
    return {
      dryRun: true,
      action: "content-rights",
      app: { id: input.appId, name: data.attributes?.name },
      current,
      update: input.declaration,
      changes,
    };
  }
  if (changes) {
    await client.patch(`/v1/apps/${input.appId}`, {
      data: {
        type: "apps",
        id: input.appId,
        attributes: { contentRightsDeclaration: input.declaration },
      },
    });
  }
  return {
    dryRun: false,
    action: "content-rights",
    appId: input.appId,
    contentRightsDeclaration: input.declaration,
    changed: changes,
  };
}
