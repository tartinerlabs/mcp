import * as z from "zod";
import { type AscClient, type AscDocument, pageInfo } from "../asc/client.ts";
import {
  appIdSchema,
  commaList,
  idSchema,
  limitSchema,
} from "../schemas/common.ts";

export const METRIC_TYPES = [
  "DISK",
  "HANG",
  "BATTERY",
  "LAUNCH",
  "MEMORY",
  "ANIMATION",
  "TERMINATION",
  "STORAGE",
] as const;

export const DIAGNOSTIC_TYPES = ["DISK_WRITES", "HANGS", "LAUNCHES"] as const;

/** What `perfPowerMetrics` answers with instead of JSON:API. */
const METRICS_TYPE = "application/vnd.apple.xcode-metrics+json";
/** What a diagnostic signature's `logs` answers with instead of JSON:API. */
const LOGS_TYPE = "application/vnd.apple.diagnostic-logs+json";

/** Frames kept from one call stack's heaviest path. */
const MAX_FRAMES = 40;
/** Call stacks kept from one log; hang logs carry one per thread. */
const MAX_CALL_STACKS = 3;

interface MetricsInsight {
  metricCategory?: string;
  latestVersion?: string;
  metric?: string;
  summaryString?: string;
  referenceVersions?: string;
  maxLatestVersionValue?: number;
  subSystemLabel?: string;
  highImpact?: boolean;
  populations?: {
    deltaPercentage?: number;
    percentile?: string;
    summaryString?: string;
    referenceAverageValue?: number;
    latestVersionValue?: number;
    device?: string;
  }[];
}

/** Apple's `xcodeMetrics` document, the body of `perfPowerMetrics`. */
export interface XcodeMetrics {
  version?: string;
  insights?: { trendingUp?: MetricsInsight[]; regressions?: MetricsInsight[] };
  productData?: {
    platform?: string;
    metricCategories?: {
      identifier?: string;
      metrics?: {
        identifier?: string;
        unit?: { identifier?: string; displayName?: string };
        datasets?: {
          filterCriteria?: {
            percentile?: string;
            device?: string;
            deviceMarketingName?: string;
          };
          points?: {
            version?: string;
            value?: number;
            errorMargin?: number;
            goal?: string;
          }[];
          recommendedMetricGoal?: { value?: number; detail?: string };
        }[];
      }[];
    }[];
  }[];
}

export const metricsInput = z
  .object({
    appId: appIdSchema.optional(),
    buildId: idSchema("builds").optional(),
    type: commaList(z.enum(METRIC_TYPES)),
    /** Passed as given: device identifiers such as iPhone15,2 contain commas. */
    device: z.string().trim().min(1).max(500).optional(),
  })
  .refine((input) => (input.appId === undefined) !== !input.buildId, {
    message: "Give either an app ID or --build <build-id>.",
  });

/**
 * Power and performance metrics for an app, or for one build, summarised:
 * Apple's regression and trend insights, then each metric's datasets (a
 * percentile on a device) as version and value points.
 */
export async function getMetrics(
  client: AscClient,
  input: z.output<typeof metricsInput>,
) {
  const path = input.buildId
    ? `/v1/builds/${input.buildId}/perfPowerMetrics`
    : `/v1/apps/${input.appId}/perfPowerMetrics`;
  const metrics = await client.get<XcodeMetrics>(
    path,
    {
      "filter[metricType]": input.type,
      "filter[deviceType]": input.device,
    },
    { accept: METRICS_TYPE },
  );
  return {
    ...(input.buildId ? { buildId: input.buildId } : { appId: input.appId }),
    insights: {
      regressions: (metrics.insights?.regressions ?? []).map(shapeInsight),
      trendingUp: (metrics.insights?.trendingUp ?? []).map(shapeInsight),
    },
    metrics: (metrics.productData ?? []).flatMap((product) =>
      (product.metricCategories ?? []).flatMap((category) =>
        (category.metrics ?? []).map((metric) => ({
          platform: product.platform,
          category: category.identifier,
          metric: metric.identifier,
          unit: metric.unit?.displayName ?? metric.unit?.identifier,
          datasets: (metric.datasets ?? []).map((dataset) => ({
            percentile: dataset.filterCriteria?.percentile,
            device:
              dataset.filterCriteria?.deviceMarketingName ??
              dataset.filterCriteria?.device,
            points: (dataset.points ?? []).map((point) => ({
              version: point.version,
              value: point.value,
              ...(point.goal ? { goal: point.goal } : {}),
            })),
            ...(dataset.recommendedMetricGoal?.value === undefined
              ? {}
              : { recommendedGoal: dataset.recommendedMetricGoal.value }),
          })),
        })),
      ),
    ),
  };
}

function shapeInsight(insight: MetricsInsight) {
  return {
    category: insight.metricCategory,
    metric: insight.metric,
    summary: insight.summaryString,
    latestVersion: insight.latestVersion,
    referenceVersions: insight.referenceVersions,
    highImpact: insight.highImpact,
    populations: (insight.populations ?? []).map((population) => ({
      percentile: population.percentile,
      device: population.device,
      latestVersionValue: population.latestVersionValue,
      referenceAverageValue: population.referenceAverageValue,
      deltaPercentage: population.deltaPercentage,
    })),
  };
}

interface SignatureAttributes {
  diagnosticType?: string;
  signature?: string;
  weight?: number;
  insight?: {
    insightType?: string;
    direction?: string;
    referenceVersions?: { version?: string; value?: number }[];
  };
}

export const diagnosticsInput = z.object({
  buildId: idSchema("builds"),
  type: z.enum(DIAGNOSTIC_TYPES).optional(),
  limit: limitSchema,
});

/** A build's top diagnostic signatures (hangs, disk writes, launches), heaviest first. */
export async function listDiagnostics(
  client: AscClient,
  input: z.output<typeof diagnosticsInput>,
) {
  const response = await client.get<AscDocument<SignatureAttributes>>(
    `/v1/builds/${input.buildId}/diagnosticSignatures`,
    {
      "filter[diagnosticType]": input.type,
      "fields[diagnosticSignatures]": [
        "diagnosticType",
        "signature",
        "weight",
        "insight",
      ],
      limit: input.limit,
    },
  );
  const { total, hasMore } = pageInfo(response);
  return {
    signatures: response.data.map((signature) => ({
      id: signature.id,
      type: signature.attributes?.diagnosticType,
      signature: signature.attributes?.signature,
      weight: signature.attributes?.weight,
      insight: signature.attributes?.insight,
    })),
    total,
    hasMore,
  };
}

interface CallStackNode {
  sampleCount?: number;
  isBlameFrame?: boolean;
  symbolName?: string;
  binaryName?: string;
  fileName?: string;
  lineNumber?: string;
  address?: string;
  offsetIntoSymbol?: string;
  rawFrame?: string;
  subFrames?: CallStackNode[];
}

/** Apple's `diagnosticLogs` document, the body of a signature's `logs`. */
export interface DiagnosticLogs {
  version?: string;
  productData?: {
    signatureId?: string;
    diagnosticInsights?: {
      insightsURL?: string;
      insightsCategory?: string;
      insightsString?: string;
    }[];
    diagnosticLogs?: {
      callStackTree?: {
        callStackPerThread?: boolean;
        callStacks?: { callStackRootFrames?: CallStackNode[] }[];
      }[];
      diagnosticMetaData?: {
        bundleId?: string;
        event?: string;
        osVersion?: string;
        appVersion?: string;
        writesCaused?: string;
        deviceType?: string;
        platformArchitecture?: string;
        eventDetail?: string;
        buildVersion?: string;
      };
    }[];
  }[];
}

export const diagnosticLogsInput = z.object({
  signatureId: idSchema("diagnostics"),
  limit: limitSchema,
});

/**
 * A diagnostic signature's logs, summarised: each log's metadata and, per
 * call stack, the heaviest path from the root (the frames with the most
 * samples), marking the frame Apple blames.
 */
export async function getDiagnosticLogs(
  client: AscClient,
  input: z.output<typeof diagnosticLogsInput>,
) {
  const logs = await client.get<DiagnosticLogs>(
    `/v1/diagnosticSignatures/${input.signatureId}/logs`,
    { limit: input.limit },
    { accept: LOGS_TYPE },
  );
  return {
    signatureId: input.signatureId,
    insights: (logs.productData ?? []).flatMap((product) =>
      (product.diagnosticInsights ?? []).map((insight) => ({
        category: insight.insightsCategory,
        summary: insight.insightsString,
        url: insight.insightsURL,
      })),
    ),
    logs: (logs.productData ?? []).flatMap((product) =>
      (product.diagnosticLogs ?? []).map((log) => {
        const stacks = (log.callStackTree ?? [])
          .flatMap((tree) => tree.callStacks ?? [])
          .map((stack) => heaviestPath(stack.callStackRootFrames ?? []))
          .filter((path) => path.frames.length > 0)
          // The stack Apple blames first, then the busiest.
          .sort(
            (a, b) =>
              Number(b.blamed) - Number(a.blamed) || b.samples - a.samples,
          );
        const meta = log.diagnosticMetaData ?? {};
        return {
          event: meta.event,
          eventDetail: meta.eventDetail,
          appVersion: meta.appVersion,
          buildVersion: meta.buildVersion,
          osVersion: meta.osVersion,
          deviceType: meta.deviceType,
          writesCaused: meta.writesCaused,
          callStacks: stacks
            .slice(0, MAX_CALL_STACKS)
            .map(({ frames, truncated }) => ({
              frames,
              ...(truncated ? { truncated } : {}),
            })),
          omittedCallStacks: Math.max(0, stacks.length - MAX_CALL_STACKS),
        };
      }),
    ),
  };
}

/** Follows the frame with the most samples from the roots down. */
function heaviestPath(roots: CallStackNode[]) {
  const frames: ReturnType<typeof shapeFrame>[] = [];
  let blamed = false;
  let level = roots;
  const samples = heaviest(roots)?.sampleCount ?? 0;
  while (level.length > 0 && frames.length < MAX_FRAMES) {
    const node = heaviest(level);
    if (!node) break;
    frames.push(shapeFrame(node));
    blamed ||= node.isBlameFrame === true;
    level = node.subFrames ?? [];
  }
  return { frames, blamed, samples, truncated: level.length > 0 };
}

function heaviest(nodes: CallStackNode[]): CallStackNode | undefined {
  return nodes.reduce<CallStackNode | undefined>(
    (best, node) =>
      !best || (node.sampleCount ?? 0) > (best.sampleCount ?? 0) ? node : best,
    undefined,
  );
}

function shapeFrame(node: CallStackNode) {
  return {
    binary: node.binaryName,
    symbol: node.symbolName ?? node.rawFrame ?? node.address,
    ...(node.fileName
      ? {
          file: node.lineNumber
            ? `${node.fileName}:${node.lineNumber}`
            : node.fileName,
        }
      : {}),
    samples: node.sampleCount,
    ...(node.isBlameFrame ? { blame: true } : {}),
  };
}
