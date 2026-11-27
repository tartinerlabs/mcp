import * as z from "zod";
import {
  type AscClient,
  type AscDocument,
  type AscResource,
  pageInfo,
} from "../asc/client.ts";
import {
  mergeReports,
  parseReport,
  type ReportTable,
  reportText,
  round,
  toNumber,
} from "../asc/reports.ts";
import {
  appIdSchema,
  commaList,
  cursorSchema,
  idSchema,
  limitSchema,
} from "../schemas/common.ts";
import { InvalidInputError, NotFoundError } from "../utils/errors.ts";

interface RequestAttributes {
  accessType?: "ONGOING" | "ONE_TIME_SNAPSHOT";
  stoppedDueToInactivity?: boolean;
}

interface ReportAttributes {
  name?: string;
  category?: string;
}

interface InstanceAttributes {
  granularity?: string;
  processingDate?: string;
}

interface SegmentAttributes {
  checksum?: string;
  sizeInBytes?: number;
  url?: string;
}

export const CATEGORIES = [
  "APP_STORE_ENGAGEMENT",
  "COMMERCE",
  "APP_USAGE",
  "FRAMEWORK_USAGE",
  "PERFORMANCE",
] as const;
export const GRANULARITIES = ["DAILY", "WEEKLY", "MONTHLY"] as const;

/** Apple caps a page at 200; more pages than this means something is wrong. */
const MAX_PAGES = 10;
/** At most this many segment files are read for one instance. */
const MAX_SEGMENTS = 50;

export const analyticsInput = z.object({ appId: appIdSchema });

export const requestAnalyticsInput = z.object({
  appId: appIdSchema,
  oneTime: z.boolean().default(false),
  yes: z.boolean().default(false),
});

export const analyticsReportsInput = z.object({
  appId: appIdSchema,
  category: z.enum(CATEGORIES).optional(),
  name: z.string().trim().min(1).max(200).optional(),
});

export const analyticsInstancesInput = z.object({
  reportId: idSchema("analytics reports"),
  granularity: z.enum(GRANULARITIES).default("DAILY"),
  date: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "The processing date is YYYY-MM-DD.")
    .optional(),
  limit: limitSchema,
  cursor: cursorSchema,
});

export const analyticsSummaryInput = z.object({
  instanceId: idSchema("analytics instances"),
  groupBy: commaList(z.string().trim().min(1).max(200)),
  top: z.coerce.number().int().min(1).max(1000).default(50),
});

function describeRequest(request: AscResource<RequestAttributes>) {
  return {
    id: request.id,
    accessType: request.attributes?.accessType,
    stoppedDueToInactivity: request.attributes?.stoppedDueToInactivity === true,
  };
}

/** Every page of a collection, following `nextCursor`. */
async function readAll<Attributes>(
  client: AscClient,
  path: string,
  query: Record<string, string | number | readonly string[] | undefined>,
): Promise<AscResource<Attributes>[]> {
  const resources: AscResource<Attributes>[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await client.get<AscDocument<Attributes>>(path, {
      ...query,
      limit: 200,
      cursor,
    });
    resources.push(...response.data);
    cursor = pageInfo(response).nextCursor;
    if (!cursor) break;
  }
  return resources;
}

async function readRequests(client: AscClient, appId: string) {
  const requests = await readAll<RequestAttributes>(
    client,
    `/v1/apps/${appId}/analyticsReportRequests`,
    {
      "fields[analyticsReportRequests]": [
        "accessType",
        "stoppedDueToInactivity",
      ],
    },
  );
  return requests.map(describeRequest);
}

/** The app's analytics report requests: ongoing or one-time, and whether Apple stopped one for inactivity. */
export async function listAnalyticsRequests(
  client: AscClient,
  input: z.output<typeof analyticsInput>,
) {
  return { requests: await readRequests(client, input.appId) };
}

/**
 * Asks Apple to start generating analytics reports for an app. An active
 * request of the same access type is reused rather than duplicated.
 */
export async function requestAnalytics(
  client: AscClient,
  input: z.output<typeof requestAnalyticsInput>,
) {
  const accessType = input.oneTime ? "ONE_TIME_SNAPSHOT" : "ONGOING";
  const requests = await readRequests(client, input.appId);
  const existing = requests.find(
    (request) =>
      request.accessType === accessType && !request.stoppedDueToInactivity,
  );
  if (existing) {
    return {
      dryRun: !input.yes,
      created: false,
      note: `The app already has an active ${accessType} request; nothing to create.`,
      request: existing,
    };
  }
  if (!input.yes) {
    return {
      dryRun: true,
      action: "create-analytics-request",
      appId: input.appId,
      accessType,
      existing: requests,
    };
  }
  const response = await client.post<{
    data: AscResource<RequestAttributes>;
  }>("/v1/analyticsReportRequests", {
    data: {
      type: "analyticsReportRequests",
      attributes: { accessType },
      relationships: { app: { data: { type: "apps", id: input.appId } } },
    },
  });
  return {
    dryRun: false,
    created: true,
    note: "Apple generates the first reports in 1 to 2 days.",
    request: describeRequest(response.data),
  };
}

/** The reports Apple generates for the app's active requests, optionally one category or name. */
export async function listAnalyticsReports(
  client: AscClient,
  input: z.output<typeof analyticsReportsInput>,
) {
  const requests = (await readRequests(client, input.appId)).filter(
    (request) => !request.stoppedDueToInactivity,
  );
  if (requests.length === 0) {
    throw new NotFoundError(
      "This app has no active analytics report request. Create one with `asc analytics request <app-id> --yes` (needs an Admin key); Apple generates the first reports 1 to 2 days later.",
    );
  }
  const reports = [];
  for (const request of requests) {
    const found = await readAll<ReportAttributes>(
      client,
      `/v1/analyticsReportRequests/${request.id}/reports`,
      {
        "filter[category]": input.category,
        "filter[name]": input.name,
        "fields[analyticsReports]": ["name", "category"],
      },
    );
    for (const report of found) {
      reports.push({
        id: report.id,
        name: report.attributes?.name,
        category: report.attributes?.category,
        accessType: request.accessType,
        requestId: request.id,
      });
    }
  }
  return { reports };
}

/** A report's instances: one per granularity and processing date. */
export async function listAnalyticsInstances(
  client: AscClient,
  input: z.output<typeof analyticsInstancesInput>,
) {
  const response = await client.get<AscDocument<InstanceAttributes>>(
    `/v1/analyticsReports/${input.reportId}/instances`,
    {
      "filter[granularity]": input.granularity,
      "filter[processingDate]": input.date,
      "fields[analyticsReportInstances]": ["granularity", "processingDate"],
      limit: input.limit,
      cursor: input.cursor,
    },
  );
  return {
    instances: response.data.map((instance) => ({
      id: instance.id,
      granularity: instance.attributes?.granularity,
      processingDate: instance.attributes?.processingDate,
    })),
    ...pageInfo(response),
  };
}

/** Identifiers, dates and versions are numbers that must not be summed. */
const NOT_A_METRIC = /identifier|\bid\b|date|version|build|year|month|week/i;

/** Columns whose every value is a number, other than identifiers and dates. */
function metricColumns({ columns, rows }: ReportTable): string[] {
  return columns.filter(
    (name) =>
      !NOT_A_METRIC.test(name) &&
      rows.some((row) => row[name] !== "") &&
      rows.every((row) => {
        const value = row[name] ?? "";
        return value === "" || Number.isFinite(Number(value));
      }),
  );
}

/**
 * Downloads an instance's segments, decompresses and parses them, and sums
 * the numeric columns, overall and by the --group-by columns.
 */
export async function getAnalyticsSummary(
  client: AscClient,
  input: z.output<typeof analyticsSummaryInput>,
) {
  const segments = await readAll<SegmentAttributes>(
    client,
    `/v1/analyticsReportInstances/${input.instanceId}/segments`,
    { "fields[analyticsReportSegments]": ["url", "sizeInBytes", "checksum"] },
  );
  if (segments.length > MAX_SEGMENTS) {
    throw new InvalidInputError(
      `This instance has ${segments.length} files, more than the ${MAX_SEGMENTS} read at once; choose a weekly or monthly instance instead.`,
    );
  }
  const tables: ReportTable[] = [];
  for (const segment of segments) {
    const url = segment.attributes?.url;
    if (!url) continue;
    tables.push(parseReport(reportText(await client.downloadSigned(url))));
  }
  const table = mergeReports(tables);
  const groupBy = input.groupBy ?? [];
  const unknown = groupBy.filter((name) => !table.columns.includes(name));
  if (unknown.length > 0) {
    throw new InvalidInputError(
      `This report has no column ${unknown.map((name) => `"${name}"`).join(", ")}. Its columns are: ${table.columns.join(", ")}.`,
    );
  }
  const metrics = metricColumns(table).filter(
    (name) => !groupBy.includes(name),
  );
  const totals: Record<string, number> = Object.fromEntries(
    metrics.map((name) => [name, 0]),
  );
  const groups = new Map<string, Record<string, string | number>>();
  for (const row of table.rows) {
    for (const name of metrics) {
      totals[name] = (totals[name] ?? 0) + toNumber(row[name] ?? "");
    }
    if (groupBy.length === 0) continue;
    const key = JSON.stringify(groupBy.map((name) => row[name]));
    const group: Record<string, string | number> =
      groups.get(key) ??
      Object.fromEntries([
        ...groupBy.map((name) => [name, row[name] ?? ""]),
        ...metrics.map((name) => [name, 0]),
      ]);
    groups.set(key, group);
    for (const name of metrics) {
      group[name] = (group[name] as number) + toNumber(row[name] ?? "");
    }
  }
  const first = metrics[0];
  const sorted = [...groups.values()]
    .map((group) => {
      for (const name of metrics) group[name] = round(group[name] as number);
      return group;
    })
    .sort((a, b) => (first ? (b[first] as number) - (a[first] as number) : 0));
  return {
    segments: segments.length,
    rows: table.rows.length,
    columns: table.columns,
    metrics,
    totals: Object.fromEntries(
      Object.entries(totals).map(([name, value]) => [name, round(value)]),
    ),
    ...(groupBy.length > 0
      ? {
          groupBy,
          groups: sorted.slice(0, input.top),
          groupCount: sorted.length,
        }
      : {}),
  };
}
