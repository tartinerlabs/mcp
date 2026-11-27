import * as z from "zod";
import type { AscClient, AscQuery } from "../asc/client.ts";
import {
  column,
  parseReport,
  reportText,
  round,
  toNumber,
} from "../asc/reports.ts";
import {
  AscApiError,
  NotFoundError,
  PermissionError,
} from "../utils/errors.ts";

/** The vendor number belongs to the account: from --vendor-number or ASC_VENDOR_NUMBER, never stored. */
const vendorNumberSchema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z
    .string({
      error:
        "Give the vendor number with --vendor-number or ASC_VENDOR_NUMBER (App Store Connect → Payments and Financial Reports).",
    })
    .trim()
    .regex(/^\d{1,20}$/, "The vendor number is digits only, such as 85012345."),
);

const FREQUENCIES = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"] as const;

/** The report date each frequency takes; a daily report without one is the latest. */
const DATE_FORMATS: Record<(typeof FREQUENCIES)[number], RegExp> = {
  DAILY: /^\d{4}-\d{2}-\d{2}$/,
  WEEKLY: /^\d{4}-\d{2}-\d{2}$/,
  MONTHLY: /^\d{4}-\d{2}$/,
  YEARLY: /^\d{4}$/,
};
const DATE_HINTS = {
  DAILY: "YYYY-MM-DD",
  WEEKLY: "YYYY-MM-DD, the Sunday the week ends",
  MONTHLY: "YYYY-MM",
  YEARLY: "YYYY",
};

export const salesInput = z
  .object({
    vendorNumber: vendorNumberSchema,
    frequency: z.enum(FREQUENCIES).default("DAILY"),
    date: z.string().trim().optional(),
  })
  .superRefine(({ frequency, date }, context) => {
    if (date === undefined && frequency === "DAILY") return;
    if (date === undefined || !DATE_FORMATS[frequency].test(date)) {
      context.addIssue({
        code: "custom",
        path: ["date"],
        message: `A ${frequency.toLowerCase()} report needs --date as ${DATE_HINTS[frequency]}.`,
      });
    }
  });

export const financeInput = z.object({
  vendorNumber: vendorNumberSchema,
  month: z
    .string({ error: "Give the fiscal month with --month as YYYY-MM." })
    .trim()
    .regex(/^\d{4}-\d{2}$/, "The fiscal month is YYYY-MM, such as 2026-09."),
  region: z
    .string()
    .trim()
    .regex(/^[A-Z][A-Z0-9]$/, "The region is a code such as ZZ, US or EU.")
    .default("ZZ"),
  detail: z.boolean().default(false),
});

/** Apple's product type identifiers (Reporting → Product type identifiers). */
const PRODUCT_TYPES: Record<string, string> = {
  "1": "Free or paid app",
  "1-B": "App bundle",
  "F1-B": "App bundle (Mac)",
  "1E": "Paid custom app",
  "1EP": "Paid custom app",
  "1EU": "Paid custom app",
  "1F": "Free or paid app",
  "1T": "Free or paid app",
  "3": "Re-download",
  "3F": "Re-download",
  "7": "Update",
  "7F": "Update",
  "7T": "Update",
  F1: "Free or paid app (Mac)",
  F7: "Update (Mac)",
  FI1: "In-app purchase (Mac)",
  IA1: "In-app purchase",
  "IA1-M": "In-app purchase (Mac)",
  IA3: "Restored in-app purchase",
  IA9: "Non-renewing subscription",
  "IA9-M": "Subscription (Mac)",
  IAY: "Auto-renewable subscription",
  "IAY-M": "Auto-renewable subscription (Mac)",
};

/** Units and proceeds summed per currency, which Apple never converts. */
interface Sum {
  units: number;
  proceeds: Record<string, number>;
}

/** A running total per key, keeping the first row's descriptive fields. */
class Totals<Fields extends object> {
  readonly #groups = new Map<string, Fields & Sum>();

  add(
    key: string,
    fields: Fields,
    units: number,
    amount: number,
    currency: string,
  ) {
    let group = this.#groups.get(key);
    if (!group) {
      group = { ...fields, units: 0, proceeds: {} };
      this.#groups.set(key, group);
    }
    addSum(group, units, amount, currency);
  }

  /** Largest unit count first, with rounded money. */
  list(): (Fields & Sum)[] {
    return [...this.#groups.values()]
      .map((group) => ({ ...group, ...rounded(group) }))
      .sort((a, b) => b.units - a.units);
  }
}

function addSum(sum: Sum, units: number, amount: number, currency: string) {
  sum.units += units;
  if (currency || amount !== 0) {
    const name = currency || "unknown";
    sum.proceeds[name] = (sum.proceeds[name] ?? 0) + amount;
  }
}

function rounded(sum: Sum): Sum {
  return {
    units: round(sum.units),
    proceeds: Object.fromEntries(
      Object.entries(sum.proceeds).map(([currency, amount]) => [
        currency,
        round(amount),
      ]),
    ),
  };
}

/** Downloads a sales or finance report, explaining the refusals a key without Sales or Finance access meets. */
async function downloadReport(
  client: AscClient,
  path: string,
  query: AscQuery,
  what: { name: string; roles: string; availability: string },
): Promise<string> {
  try {
    return reportText(await client.download(path, query));
  } catch (error) {
    if (!(error instanceof AscApiError)) throw error;
    if (error.status === 401 || error.status === 403) {
      throw new PermissionError(
        `${what.name} reports need a team API key with the ${what.roles} role: an Admin creates one in App Store Connect → Users and Access → Integrations → Team Keys. Individual keys cannot read them. If this is such a team key, check it has not been revoked.`,
      );
    }
    if (error.status === 404) {
      throw new NotFoundError(
        `There is no ${what.name.toLowerCase()} report for that period yet. ${what.availability}`,
      );
    }
    throw error;
  }
}

/**
 * A Sales and Trends summary report, aggregated rather than printed row by
 * row: totals, then units and proceeds by product type, country and product
 * (each app and in-app purchase; `parentSku` names an in-app purchase's app).
 * Proceeds are units × developer proceeds, per currency of proceeds.
 */
export async function getSales(
  client: AscClient,
  input: z.output<typeof salesInput>,
) {
  const text = await downloadReport(
    client,
    "/v1/salesReports",
    {
      "filter[vendorNumber]": input.vendorNumber,
      "filter[reportType]": "SALES",
      "filter[reportSubType]": "SUMMARY",
      "filter[frequency]": input.frequency,
      "filter[reportDate]": input.date,
      "filter[version]": "1_0",
    },
    {
      name: "Sales",
      roles: "Admin, Finance or Sales and Reports",
      availability:
        "Apple publishes each report about a day after its period ends, and has none for a period with no sales.",
    },
  );
  const { rows } = parseReport(text);
  const totals: Sum = { units: 0, proceeds: {} };
  const byProductType = new Totals<{ productType: string; type?: string }>();
  const byCountry = new Totals<{ country: string }>();
  const byProduct = new Totals<{
    appleId: string;
    title: string;
    sku: string;
    parentSku?: string;
    productType: string;
  }>();
  for (const row of rows) {
    const units = toNumber(column(row, "Units"));
    const amount = units * toNumber(column(row, "Developer Proceeds"));
    const currency = column(row, "Currency of Proceeds");
    const productType = column(row, "Product Type Identifier");
    const appleId = column(row, "Apple Identifier");
    addSum(totals, units, amount, currency);
    byProductType.add(
      productType,
      { productType, type: PRODUCT_TYPES[productType] },
      units,
      amount,
      currency,
    );
    byCountry.add(
      column(row, "Country Code"),
      { country: column(row, "Country Code") },
      units,
      amount,
      currency,
    );
    byProduct.add(
      appleId,
      {
        appleId,
        title: column(row, "Title"),
        sku: column(row, "SKU"),
        parentSku: column(row, "Parent Identifier") || undefined,
        productType,
      },
      units,
      amount,
      currency,
    );
  }
  return {
    report: {
      type: "SALES",
      frequency: input.frequency,
      date: input.date ?? "latest",
    },
    rows: rows.length,
    totals: rounded(totals),
    byProductType: byProductType.list(),
    byCountry: byCountry.list(),
    byProduct: byProduct.list(),
  };
}

/**
 * A fiscal month's financial report (consolidated by default, or one
 * region's, or the finance detail report), aggregated like `getSales`:
 * proceeds are the extended partner share in its currency.
 */
export async function getFinance(
  client: AscClient,
  input: z.output<typeof financeInput>,
) {
  const reportType = input.detail ? "FINANCE_DETAIL" : "FINANCIAL";
  // The finance detail report exists only for region Z1.
  const region = input.detail ? "Z1" : input.region;
  const text = await downloadReport(
    client,
    "/v1/financeReports",
    {
      "filter[vendorNumber]": input.vendorNumber,
      "filter[reportType]": reportType,
      "filter[regionCode]": region,
      "filter[reportDate]": input.month,
    },
    {
      name: "Finance",
      roles: "Admin or Finance",
      availability:
        "Finance reports follow Apple's fiscal calendar and appear after the fiscal month closes; a region with no sales has none.",
    },
  );
  const { rows } = parseReport(text);
  const totals: Sum = { units: 0, proceeds: {} };
  const byProductType = new Totals<{ productType: string; type?: string }>();
  const byCountry = new Totals<{ country: string }>();
  const byProduct = new Totals<{
    appleId: string;
    title: string;
    sku: string;
    productType: string;
  }>();
  for (const row of rows) {
    const units = toNumber(column(row, "Quantity"));
    const amount = toNumber(column(row, "Extended Partner Share"));
    const currency = column(row, "Partner Share Currency");
    const productType = column(row, "Product Type Identifier");
    const appleId = column(row, "Apple Identifier");
    const country = column(row, "Country Of Sale", "Country of Sale");
    addSum(totals, units, amount, currency);
    byProductType.add(
      productType,
      { productType, type: PRODUCT_TYPES[productType] },
      units,
      amount,
      currency,
    );
    byCountry.add(country, { country }, units, amount, currency);
    byProduct.add(
      appleId,
      {
        appleId,
        title: column(row, "Title"),
        sku: column(row, "Vendor Identifier", "SKU"),
        productType,
      },
      units,
      amount,
      currency,
    );
  }
  return {
    report: { type: reportType, month: input.month, region },
    rows: rows.length,
    totals: rounded(totals),
    byProductType: byProductType.list(),
    byCountry: byCountry.list(),
    byProduct: byProduct.list(),
  };
}
