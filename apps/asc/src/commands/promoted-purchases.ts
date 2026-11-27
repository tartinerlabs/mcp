import * as z from "zod";
import type { AscClient, AscDocument, AscResource } from "../asc/client.ts";
import { appIdSchema, idSchema } from "../schemas/common.ts";
import {
  AscApiError,
  NotFoundError,
  UploadIncompleteError,
} from "../utils/errors.ts";
import { allPages } from "./pricing.ts";

/**
 * Promoted in-app purchases: the products shown on the app's product page,
 * in order, each enabled or not and visible to everyone or only to people
 * who have the app.
 */

interface PromotedAttributes {
  enabled?: boolean;
  visibleForAllUsers?: boolean;
  state?: string;
}

interface ProductAttributes {
  name?: string;
  productId?: string;
}

type ProductKind = "inAppPurchase" | "subscription";

const RELATIONSHIPS: Record<ProductKind, { name: string; type: string }> = {
  inAppPurchase: { name: "inAppPurchaseV2", type: "inAppPurchases" },
  subscription: { name: "subscription", type: "subscriptions" },
};

function shapePromoted(
  document: AscDocument<unknown>,
  item: AscResource<PromotedAttributes>,
  position: number,
) {
  const kind: ProductKind = item.relationships?.subscription?.data
    ? "subscription"
    : "inAppPurchase";
  const ref = item.relationships?.[RELATIONSHIPS[kind].name]?.data;
  const product = document.included?.find(
    (included) => included.type === ref?.type && included.id === ref?.id,
  ) as AscResource<ProductAttributes> | undefined;
  return {
    id: item.id,
    position,
    enabled: item.attributes?.enabled ?? null,
    visibleForAllUsers: item.attributes?.visibleForAllUsers ?? null,
    state: item.attributes?.state ?? null,
    product: {
      kind,
      id: ref?.id ?? null,
      productId: product?.attributes?.productId ?? null,
      referenceName: product?.attributes?.name ?? null,
    },
  };
}

async function readPromoted(client: AscClient, appId: string) {
  const document = await allPages<PromotedAttributes>(
    client,
    `/v1/apps/${appId}/promotedPurchases`,
    { include: ["inAppPurchaseV2", "subscription"], limit: 200 },
  );
  return document.data.map((item, index) =>
    shapePromoted(document, item, index + 1),
  );
}

export const promotedInput = z.object({ appId: appIdSchema });

/** An app's promoted purchases in the order the product page shows them. */
export async function listPromoted(
  client: AscClient,
  input: z.output<typeof promotedInput>,
) {
  return {
    appId: input.appId,
    promotedPurchases: await readPromoted(client, input.appId),
  };
}

/** Whether an id is an in-app purchase's or a subscription's. */
async function productKind(
  client: AscClient,
  id: string,
): Promise<ProductKind> {
  for (const [kind, path] of [
    ["inAppPurchase", `/v2/inAppPurchases/${id}`],
    ["subscription", `/v1/subscriptions/${id}`],
  ] as const) {
    try {
      await client.get(path);
      return kind;
    } catch (error) {
      if (!(error instanceof AscApiError && error.status === 404)) throw error;
    }
  }
  throw new NotFoundError(
    `${id} is neither an in-app purchase nor a subscription; the iap and subscriptions commands list their ids.`,
  );
}

export const setPromotedInput = z.object({
  appId: appIdSchema,
  products: z
    .array(idSchema("iap or subscriptions"))
    .min(1, "Give the products in order with --product.")
    .max(200),
  enabled: z.boolean().optional(),
  visibleForAllUsers: z.boolean().optional(),
  only: z.boolean().default(false),
  yes: z.boolean().default(false),
});

/**
 * Promotes products in the order given, ahead of the ones already promoted
 * (which `only` removes instead). Products not yet promoted are added,
 * enabled and visible to everyone unless told otherwise; `enabled` and
 * `visibleForAllUsers` also change the listed ones already promoted.
 */
export async function setPromoted(
  client: AscClient,
  input: z.output<typeof setPromotedInput>,
) {
  const current = await readPromoted(client, input.appId);
  const products = [...new Set(input.products)];
  const byProduct = new Map(current.map((item) => [item.product.id, item]));
  const adding: { id: string; kind: ProductKind }[] = [];
  for (const id of products) {
    if (!byProduct.has(id)) {
      adding.push({ id, kind: await productKind(client, id) });
    }
  }
  const updating = products.flatMap((id) => {
    const item = byProduct.get(id);
    if (!item) return [];
    const attributes: PromotedAttributes = {};
    if (input.enabled !== undefined && item.enabled !== input.enabled) {
      attributes.enabled = input.enabled;
    }
    if (
      input.visibleForAllUsers !== undefined &&
      item.visibleForAllUsers !== input.visibleForAllUsers
    ) {
      attributes.visibleForAllUsers = input.visibleForAllUsers;
    }
    return Object.keys(attributes).length > 0 ? [{ item, attributes }] : [];
  });
  const listed = new Set(products);
  const others = current.filter((item) => !listed.has(item.product.id ?? ""));
  const removing = input.only ? others : [];
  const plan = {
    appId: input.appId,
    current,
    order: [
      ...products,
      ...(input.only ? [] : others.map((item) => item.product.id)),
    ],
    adding,
    updating: updating.map(({ item, attributes }) => ({
      id: item.id,
      product: item.product.id,
      ...attributes,
    })),
    removing: removing.map((item) => ({
      id: item.id,
      product: item.product.id,
    })),
  };
  if (!input.yes) return { dryRun: true, ...plan };
  const done: string[] = [];
  try {
    const created = new Map<string, string>();
    for (const product of adding) {
      const relationship = RELATIONSHIPS[product.kind];
      const { data } = await client.post<{ data: AscResource }>(
        "/v1/promotedPurchases",
        {
          data: {
            type: "promotedPurchases",
            attributes: {
              enabled: input.enabled ?? true,
              visibleForAllUsers: input.visibleForAllUsers ?? true,
            },
            relationships: {
              app: { data: { type: "apps", id: input.appId } },
              [relationship.name]: {
                data: { type: relationship.type, id: product.id },
              },
            },
          },
        },
      );
      created.set(product.id, data.id);
      done.push(`added ${product.id}`);
    }
    for (const { item, attributes } of updating) {
      await client.patch(`/v1/promotedPurchases/${item.id}`, {
        data: { type: "promotedPurchases", id: item.id, attributes },
      });
      done.push(`updated ${item.product.id}`);
    }
    const ids = [
      ...products.map((id) => byProduct.get(id)?.id ?? created.get(id) ?? id),
      ...(input.only ? [] : others.map((item) => item.id)),
    ];
    await client.patch(
      `/v1/apps/${input.appId}/relationships/promotedPurchases`,
      {
        data: ids.map((id) => ({ type: "promotedPurchases", id })),
      },
    );
    done.push("reordered");
    for (const item of removing) {
      await client.delete(`/v1/promotedPurchases/${item.id}`);
      done.push(`removed ${item.product.id}`);
    }
  } catch (error) {
    throw new UploadIncompleteError(
      `Changing promoted purchases stopped partway${done.length > 0 ? `; already done: ${done.join(", ")}` : ""}. Run the command again to finish.`,
      { cause: error },
    );
  }
  return { dryRun: false, ...plan };
}
