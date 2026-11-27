import { access, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import * as z from "zod";
import {
  type AscClient,
  type AscDocument,
  type AscResource,
  pageInfo,
  related,
} from "../asc/client.ts";
import {
  appIdSchema,
  cursorSchema,
  idSchema,
  limitSchema,
} from "../schemas/common.ts";
import {
  AscApiError,
  InvalidInputError,
  PermissionError,
} from "../utils/errors.ts";

export const WEBHOOK_EVENTS = [
  "ALTERNATIVE_DISTRIBUTION_PACKAGE_AVAILABLE_UPDATED",
  "ALTERNATIVE_DISTRIBUTION_PACKAGE_VERSION_CREATED",
  "ALTERNATIVE_DISTRIBUTION_TERRITORY_AVAILABILITY_UPDATED",
  "APP_STORE_VERSION_APP_VERSION_STATE_UPDATED",
  "BACKGROUND_ASSET_VERSION_APP_STORE_RELEASE_STATE_UPDATED",
  "BACKGROUND_ASSET_VERSION_EXTERNAL_BETA_RELEASE_STATE_UPDATED",
  "BACKGROUND_ASSET_VERSION_INTERNAL_BETA_RELEASE_CREATED",
  "BACKGROUND_ASSET_VERSION_STATE_UPDATED",
  "BETA_FEEDBACK_CRASH_SUBMISSION_CREATED",
  "BETA_FEEDBACK_SCREENSHOT_SUBMISSION_CREATED",
  "BUILD_BETA_DETAIL_EXTERNAL_BUILD_STATE_UPDATED",
  "BUILD_UPLOAD_STATE_UPDATED",
] as const;

/** Characters of a delivery's response body kept; it is whatever the receiving server answered. */
const MAX_RESPONSE_BODY = 500;

const ROLE_HINT =
  "App Store Connect refused this webhook request: the API key's role needs to be Admin or App Manager, or the key may be revoked.";

async function withRoleHint<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (error) {
    if (error instanceof AscApiError && error.status === 403) {
      throw new PermissionError(ROLE_HINT, { cause: error });
    }
    throw error;
  }
}

interface WebhookAttributes {
  enabled?: boolean;
  eventTypes?: string[];
  name?: string;
  url?: string;
}

const WEBHOOK_FIELDS = ["enabled", "eventTypes", "name", "url", "app"];

/** A webhook as the commands print it; Apple never returns its secret. */
function shapeWebhook(webhook: AscResource<WebhookAttributes>) {
  const attributes = webhook.attributes ?? {};
  return {
    id: webhook.id,
    name: attributes.name,
    url: attributes.url,
    enabled: attributes.enabled,
    eventTypes: attributes.eventTypes,
    appId: webhook.relationships?.app?.data?.id,
  };
}

const httpsUrl = z
  .url({ error: "Must be a URL such as https://example.com/hooks/asc." })
  .refine((value) => new URL(value).protocol === "https:", {
    message: "Must be an https URL.",
  });

const eventList = z.array(z.enum(WEBHOOK_EVENTS)).min(1);

/** Environment variable names: letters, digits and underscores. */
const envName = z
  .string()
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]{0,99}$/,
    "Must be an environment variable name.",
  );

/**
 * Where the signing secret comes from: an environment variable, or a new
 * secret written to a new file. Never an option value, which would end up
 * in shell history.
 */
const secretSource = {
  secretEnv: envName.optional(),
  secretOut: z.string().trim().min(1).optional(),
};

export const webhooksInput = z.object({
  appId: appIdSchema,
  limit: limitSchema,
  cursor: cursorSchema,
});

/** An app's webhooks: name, URL, whether it is enabled and its events. */
export async function listWebhooks(
  client: AscClient,
  input: z.output<typeof webhooksInput>,
) {
  const response = await withRoleHint(() =>
    client.get<AscDocument<WebhookAttributes>>(
      `/v1/apps/${input.appId}/webhooks`,
      {
        "fields[webhooks]": WEBHOOK_FIELDS,
        include: "app",
        "fields[apps]": ["bundleId"],
        limit: input.limit,
        cursor: input.cursor,
      },
    ),
  );
  return { webhooks: response.data.map(shapeWebhook), ...pageInfo(response) };
}

/** Fails, changing nothing, when the file exists: written files are never overwritten. */
async function ensureAbsent(path: string): Promise<string> {
  const absolute = resolve(path);
  const exists = await access(absolute).then(
    () => true,
    () => false,
  );
  if (exists) {
    throw new InvalidInputError(
      `--secret-out ${path} already exists; name a new file. Nothing was changed.`,
    );
  }
  return absolute;
}

/** 32 random bytes as base64url. */
function generateSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

interface SecretPlan {
  /** Where the secret comes from, for the dry run; never the secret itself. */
  source: string;
  /** Reads or generates the secret, writing a generated one to its file first. */
  resolve: () => Promise<string>;
  /** Removes a generated secret's file when App Store Connect did not take it. */
  discard: () => Promise<void>;
}

/** Sends a request carrying the secret; a generated secret's file is removed if it fails. */
async function withSecret<T>(
  secret: SecretPlan | undefined,
  send: (value: string | undefined) => Promise<T>,
): Promise<T> {
  const value = await secret?.resolve();
  try {
    return await send(value);
  } catch (error) {
    await secret?.discard();
    throw error;
  }
}

/** Checks the secret's source without reading a generated secret into the output. */
async function planSecret(
  input: { secretEnv?: string; secretOut?: string },
  env: NodeJS.ProcessEnv,
  required: boolean,
): Promise<SecretPlan | undefined> {
  if (input.secretEnv !== undefined && input.secretOut !== undefined) {
    throw new InvalidInputError("Give --secret-env or --secret-out, not both.");
  }
  if (input.secretEnv !== undefined) {
    const name = input.secretEnv;
    const value = env[name];
    if (!value || value.length < 16) {
      throw new InvalidInputError(
        `The environment variable ${name} must hold the signing secret, at least 16 characters. Nothing was changed.`,
      );
    }
    return {
      source: `environment variable ${name}`,
      resolve: async () => value,
      discard: async () => {},
    };
  }
  if (input.secretOut !== undefined) {
    const path = await ensureAbsent(input.secretOut);
    return {
      source: `new secret written to ${path}`,
      resolve: async () => {
        const secret = generateSecret();
        await writeFile(path, `${secret}\n`, { flag: "wx", mode: 0o600 });
        return secret;
      },
      discard: () => rm(path, { force: true }),
    };
  }
  if (required) {
    throw new InvalidInputError(
      "Give the signing secret with --secret-env <variable>, or --secret-out <file> to generate one and write it to a new file.",
    );
  }
  return undefined;
}

export const createWebhookInput = z.object({
  appId: appIdSchema,
  name: z
    .string({ error: "Give the webhook a --name." })
    .trim()
    .min(1)
    .max(100),
  url: httpsUrl,
  events: eventList,
  enabled: z.boolean().default(true),
  ...secretSource,
  yes: z.boolean().default(false),
});

/**
 * Creates a webhook for an app. The signing secret comes from an
 * environment variable or is generated into a new file; it is never
 * printed. Without `yes`, only shows the webhook it would create.
 */
export async function createWebhook(
  client: AscClient,
  input: z.output<typeof createWebhookInput>,
  env: NodeJS.ProcessEnv = process.env,
) {
  const secret = await planSecret(input, env, true);
  const webhook = {
    appId: input.appId,
    name: input.name,
    url: input.url,
    enabled: input.enabled,
    eventTypes: input.events,
    secret: secret?.source,
  };
  if (!input.yes || !secret) {
    return { dryRun: true, action: "create", webhook };
  }
  const created = await withSecret(secret, (value) =>
    withRoleHint(() =>
      client.post<{ data: AscResource<WebhookAttributes> }>("/v1/webhooks", {
        data: {
          type: "webhooks",
          attributes: {
            name: input.name,
            url: input.url,
            enabled: input.enabled,
            eventTypes: input.events,
            secret: value,
          },
          relationships: {
            app: { data: { type: "apps", id: input.appId } },
          },
        },
      }),
    ),
  );
  return {
    dryRun: false,
    action: "create",
    webhook: shapeWebhook(created.data),
    secret: secret.source,
  };
}

const webhookIdSchema = idSchema("webhooks");

async function readWebhook(client: AscClient, webhookId: string) {
  const document = await client.get<{ data: AscResource<WebhookAttributes> }>(
    `/v1/webhooks/${webhookId}`,
    {
      "fields[webhooks]": WEBHOOK_FIELDS,
      include: "app",
      "fields[apps]": ["bundleId"],
    },
  );
  return shapeWebhook(document.data);
}

export const setWebhookInput = z
  .object({
    webhookId: webhookIdSchema,
    name: z.string().trim().min(1).max(100).optional(),
    url: httpsUrl.optional(),
    events: eventList.optional(),
    enabled: z.boolean().optional(),
    ...secretSource,
    yes: z.boolean().default(false),
  })
  .refine(
    (input) =>
      input.name !== undefined ||
      input.url !== undefined ||
      input.events !== undefined ||
      input.enabled !== undefined ||
      input.secretEnv !== undefined ||
      input.secretOut !== undefined,
    {
      message:
        "Give what to change: --name, --url, --event, --enable/--disable, or a new secret with --secret-env or --secret-out.",
    },
  );

/**
 * Changes a webhook's name, URL, events, enabled state or signing secret;
 * --event replaces the list. Without `yes`, only shows the webhook and the change.
 */
export async function setWebhook(
  client: AscClient,
  input: z.output<typeof setWebhookInput>,
  env: NodeJS.ProcessEnv = process.env,
) {
  const secret = await planSecret(input, env, false);
  return withRoleHint(async () => {
    const webhook = await readWebhook(client, input.webhookId);
    const attributes = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.url !== undefined ? { url: input.url } : {}),
      ...(input.events !== undefined ? { eventTypes: input.events } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    };
    const change = {
      ...attributes,
      ...(secret ? { secret: secret.source } : {}),
    };
    if (!input.yes) {
      return { dryRun: true, action: "set", webhook, change };
    }
    const updated = await withSecret(secret, (value) =>
      client.patch<{ data: AscResource<WebhookAttributes> }>(
        `/v1/webhooks/${input.webhookId}`,
        {
          data: {
            type: "webhooks",
            id: input.webhookId,
            attributes: {
              ...attributes,
              ...(value !== undefined ? { secret: value } : {}),
            },
          },
        },
      ),
    );
    return {
      dryRun: false,
      action: "set",
      webhook: shapeWebhook(updated.data),
      ...(secret ? { secret: secret.source } : {}),
    };
  });
}

export const webhookActionInput = z.object({
  webhookId: webhookIdSchema,
  yes: z.boolean().default(false),
});

/** Deletes a webhook; App Store Connect stops calling its URL. Without `yes`, only shows it. */
export async function deleteWebhook(
  client: AscClient,
  input: z.output<typeof webhookActionInput>,
) {
  return withRoleHint(async () => {
    const webhook = await readWebhook(client, input.webhookId);
    if (!input.yes) {
      return { dryRun: true, action: "delete", webhook };
    }
    await client.delete(`/v1/webhooks/${input.webhookId}`);
    return { dryRun: false, action: "delete", webhookId: input.webhookId };
  });
}

/** Sends a test event to a webhook's URL. Without `yes`, only shows the webhook. */
export async function pingWebhook(
  client: AscClient,
  input: z.output<typeof webhookActionInput>,
) {
  return withRoleHint(async () => {
    const webhook = await readWebhook(client, input.webhookId);
    if (!input.yes) {
      return { dryRun: true, action: "ping", webhook };
    }
    const created = await client.post<{ data?: AscResource } | undefined>(
      "/v1/webhookPings",
      {
        data: {
          type: "webhookPings",
          relationships: {
            webhook: { data: { type: "webhooks", id: input.webhookId } },
          },
        },
      },
    );
    return {
      dryRun: false,
      action: "ping",
      webhookId: input.webhookId,
      pingId: created?.data?.id,
      note: "See the result with webhooks deliveries.",
    };
  });
}

interface DeliveryAttributes {
  createdDate?: string;
  deliveryState?: string;
  errorMessage?: string;
  redelivery?: boolean;
  sentDate?: string;
  request?: { url?: string };
  response?: { httpStatusCode?: number; body?: string };
}

const isoDate = z
  .string()
  .trim()
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: "Must be a date such as 2026-11-27 or 2026-11-27T10:00:00Z.",
  })
  .transform((value) => new Date(value).toISOString());

export const deliveriesInput = z.object({
  webhookId: webhookIdSchema,
  state: z.enum(["SUCCEEDED", "FAILED", "PENDING"]).optional(),
  since: isoDate.optional(),
  until: isoDate.optional(),
  limit: limitSchema,
  cursor: cursorSchema,
});

/**
 * A webhook's deliveries: state, when they were sent, the event type, the
 * HTTP status the URL answered with and the start of its response body.
 * Event payloads are left out.
 */
export async function listDeliveries(
  client: AscClient,
  input: z.output<typeof deliveriesInput>,
) {
  const response = await withRoleHint(() =>
    client.get<AscDocument<DeliveryAttributes>>(
      `/v1/webhooks/${input.webhookId}/deliveries`,
      {
        "filter[deliveryState]": input.state,
        "filter[createdDateGreaterThanOrEqualTo]": input.since,
        "filter[createdDateLessThan]": input.until,
        include: "event",
        "fields[webhookDeliveries]": [
          "createdDate",
          "deliveryState",
          "errorMessage",
          "redelivery",
          "sentDate",
          "request",
          "response",
          "event",
        ],
        "fields[webhookEvents]": ["eventType", "ping", "createdDate"],
        limit: input.limit,
        cursor: input.cursor,
      },
    ),
  );
  return {
    deliveries: response.data.map((delivery) => {
      const attributes = delivery.attributes ?? {};
      const event = related<{ eventType?: string; ping?: boolean }>(
        response,
        delivery,
        "event",
      );
      const body = attributes.response?.body;
      return {
        id: delivery.id,
        state: attributes.deliveryState,
        createdDate: attributes.createdDate,
        sentDate: attributes.sentDate,
        redelivery: attributes.redelivery,
        eventType: event?.eventType,
        ping: event?.ping,
        url: attributes.request?.url,
        httpStatusCode: attributes.response?.httpStatusCode,
        responseBody:
          body && body.length > MAX_RESPONSE_BODY
            ? `${body.slice(0, MAX_RESPONSE_BODY)}…`
            : body,
        errorMessage: attributes.errorMessage,
      };
    }),
    ...pageInfo(response),
  };
}

export const redeliverInput = z.object({
  deliveryId: idSchema("webhooks deliveries"),
  yes: z.boolean().default(false),
});

/**
 * Sends a delivery's event to its webhook again, as a new delivery. Apple
 * has no read of one delivery, so the dry run only names it.
 */
export async function redeliver(
  client: AscClient,
  input: z.output<typeof redeliverInput>,
) {
  if (!input.yes) {
    return { dryRun: true, action: "redeliver", deliveryId: input.deliveryId };
  }
  const created = await withRoleHint(() =>
    client.post<{ data?: AscResource } | undefined>("/v1/webhookDeliveries", {
      data: {
        type: "webhookDeliveries",
        relationships: {
          template: {
            data: { type: "webhookDeliveries", id: input.deliveryId },
          },
        },
      },
    }),
  );
  return {
    dryRun: false,
    action: "redeliver",
    deliveryId: input.deliveryId,
    newDeliveryId: created?.data?.id,
  };
}
