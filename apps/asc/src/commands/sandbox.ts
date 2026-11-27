import * as z from "zod";
import {
  type AscClient,
  type AscDocument,
  type AscResource,
  pageInfo,
} from "../asc/client.ts";
import { cursorSchema, idSchema, limitSchema } from "../schemas/common.ts";
import {
  AscApiError,
  NotFoundError,
  PermissionError,
} from "../utils/errors.ts";

export const RENEWAL_RATES = [
  "MONTHLY_RENEWAL_EVERY_ONE_HOUR",
  "MONTHLY_RENEWAL_EVERY_THIRTY_MINUTES",
  "MONTHLY_RENEWAL_EVERY_FIFTEEN_MINUTES",
  "MONTHLY_RENEWAL_EVERY_FIVE_MINUTES",
  "MONTHLY_RENEWAL_EVERY_THREE_MINUTES",
] as const;

/** Testers read while looking for the ones a write names. */
const MAX_PAGES = 10;

const ROLE_HINT =
  "App Store Connect refused this sandbox tester request: the API key's role needs to be Admin or App Manager, or the key may be revoked.";

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

interface TesterAttributes {
  firstName?: string;
  lastName?: string;
  acAccountName?: string;
  territory?: string;
  applePayCompatible?: boolean;
  interruptPurchases?: boolean;
  subscriptionRenewalRate?: string;
}

const FIELDS = [
  "firstName",
  "lastName",
  "territory",
  "applePayCompatible",
  "interruptPurchases",
  "subscriptionRenewalRate",
];

/** A tester as the commands print it; the account email is personal data, left out unless asked for. */
function shapeTester(tester: AscResource<TesterAttributes>, emails = false) {
  const attributes = tester.attributes ?? {};
  return {
    id: tester.id,
    firstName: attributes.firstName,
    lastName: attributes.lastName,
    ...(emails ? { email: attributes.acAccountName } : {}),
    territory: attributes.territory,
    applePayCompatible: attributes.applePayCompatible,
    interruptPurchases: attributes.interruptPurchases,
    subscriptionRenewalRate: attributes.subscriptionRenewalRate,
  };
}

export const sandboxTestersInput = z.object({
  emails: z.boolean().default(false),
  limit: limitSchema,
  cursor: cursorSchema,
});

/** The team's sandbox Apple Accounts for testing in-app purchases. */
export async function listSandboxTesters(
  client: AscClient,
  input: z.output<typeof sandboxTestersInput>,
) {
  const response = await withRoleHint(() =>
    client.get<AscDocument<TesterAttributes>>("/v2/sandboxTesters", {
      "fields[sandboxTesters]": [
        ...FIELDS,
        ...(input.emails ? ["acAccountName"] : []),
      ],
      limit: input.limit,
      cursor: input.cursor,
    }),
  );
  return {
    testers: response.data.map((tester) => shapeTester(tester, input.emails)),
    ...pageInfo(response),
  };
}

/** Apple has no read of one sandbox tester, so pages are read until every id is found. */
async function findTesters(client: AscClient, ids: readonly string[]) {
  const found = new Map<string, AscResource<TesterAttributes>>();
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await client.get<AscDocument<TesterAttributes>>(
      "/v2/sandboxTesters",
      { "fields[sandboxTesters]": FIELDS, limit: 200, cursor },
    );
    for (const tester of page.data) {
      if (ids.includes(tester.id)) found.set(tester.id, tester);
    }
    cursor = pageInfo(page).nextCursor;
    pages++;
  } while (cursor && found.size < ids.length && pages < MAX_PAGES);
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new NotFoundError(
      `No sandbox tester with id ${missing.join(", ")}; list them with sandbox testers. Nothing was changed.`,
    );
  }
  return ids.map((id) => found.get(id) as AscResource<TesterAttributes>);
}

const testerIdSchema = idSchema("sandbox testers");

export const setSandboxTesterInput = z
  .object({
    testerId: testerIdSchema,
    territory: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/, "Must be a three-letter territory code such as USA.")
      .optional(),
    renewalRate: z.enum(RENEWAL_RATES).optional(),
    interruptPurchases: z.boolean().optional(),
    yes: z.boolean().default(false),
  })
  .refine(
    (input) =>
      input.territory !== undefined ||
      input.renewalRate !== undefined ||
      input.interruptPurchases !== undefined,
    {
      message:
        "Give what to change: --territory, --renewal-rate or --interrupt-purchases/--no-interrupt-purchases.",
    },
  );

/**
 * Changes a sandbox tester's storefront, subscription renewal rate or
 * interrupted purchases. Without `yes`, only shows the tester and the change.
 */
export async function setSandboxTester(
  client: AscClient,
  input: z.output<typeof setSandboxTesterInput>,
) {
  return withRoleHint(async () => {
    const [tester] = await findTesters(client, [input.testerId]);
    const attributes = {
      ...(input.territory !== undefined ? { territory: input.territory } : {}),
      ...(input.renewalRate !== undefined
        ? { subscriptionRenewalRate: input.renewalRate }
        : {}),
      ...(input.interruptPurchases !== undefined
        ? { interruptPurchases: input.interruptPurchases }
        : {}),
    };
    if (!input.yes) {
      return {
        dryRun: true,
        action: "set",
        tester: tester && shapeTester(tester),
        change: attributes,
      };
    }
    const updated = await client.patch<{
      data: AscResource<TesterAttributes>;
    }>(`/v2/sandboxTesters/${input.testerId}`, {
      data: { type: "sandboxTesters", id: input.testerId, attributes },
    });
    return { dryRun: false, action: "set", tester: shapeTester(updated.data) };
  });
}

export const clearHistoryInput = z.object({
  testerIds: z.array(testerIdSchema).min(1).max(100),
  yes: z.boolean().default(false),
});

/**
 * Clears the purchase history of sandbox testers, so they can buy
 * non-consumables and introductory offers again. This cannot be undone.
 * Without `yes`, only shows the testers.
 */
export async function clearSandboxHistory(
  client: AscClient,
  input: z.output<typeof clearHistoryInput>,
) {
  return withRoleHint(async () => {
    const ids = [...new Set(input.testerIds)];
    const testers = await findTesters(client, ids);
    if (!input.yes) {
      return {
        dryRun: true,
        action: "clear-history",
        testers: testers.map((tester) => shapeTester(tester)),
        note: "Clearing purchase history cannot be undone.",
      };
    }
    const created = await client.post<{ data?: AscResource } | undefined>(
      "/v2/sandboxTestersClearPurchaseHistoryRequest",
      {
        data: {
          type: "sandboxTestersClearPurchaseHistoryRequest",
          relationships: {
            sandboxTesters: {
              data: ids.map((id) => ({ type: "sandboxTesters", id })),
            },
          },
        },
      },
    );
    return {
      dryRun: false,
      action: "clear-history",
      requestId: created?.data?.id,
      testerIds: ids,
    };
  });
}
