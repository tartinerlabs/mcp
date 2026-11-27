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
import { AscApiError, PermissionError } from "../utils/errors.ts";

/** Test results read per action before giving up on finding more failures. */
const MAX_TEST_PAGES = 10;

const ROLE_HINT =
  "App Store Connect refused this Xcode Cloud request: the API key's role needs access to Xcode Cloud (Admin, App Manager or Developer), or the key may be revoked.";

/** Runs an Xcode Cloud request, naming the role it needs when Apple answers 403. */
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

interface ProductAttributes {
  name?: string;
  createdDate?: string;
  productType?: string;
}

export const productsInput = z.object({
  appId: appIdSchema.optional(),
  type: z.enum(["APP", "FRAMEWORK"]).optional(),
  limit: limitSchema,
  cursor: cursorSchema,
});

/** Xcode Cloud products: an app or framework set up for Xcode Cloud, with its app. */
export async function listProducts(
  client: AscClient,
  input: z.output<typeof productsInput>,
) {
  const response = await withRoleHint(() =>
    client.get<AscDocument<ProductAttributes>>("/v1/ciProducts", {
      "filter[app]": input.appId,
      "filter[productType]": input.type,
      include: "app",
      "fields[ciProducts]": ["name", "createdDate", "productType", "app"],
      "fields[apps]": ["name", "bundleId"],
      limit: input.limit,
      cursor: input.cursor,
    }),
  );
  return {
    products: response.data.map((product) => {
      const app = related<{ name?: string; bundleId?: string }>(
        response,
        product,
        "app",
      );
      return {
        id: product.id,
        name: product.attributes?.name,
        type: product.attributes?.productType,
        createdDate: product.attributes?.createdDate,
        app: app && {
          id: product.relationships?.app?.data?.id,
          name: app.name,
          bundleId: app.bundleId,
        },
      };
    }),
    ...pageInfo(response),
  };
}

interface WorkflowAttributes {
  name?: string;
  description?: string;
  isEnabled?: boolean;
  isLockedForEditing?: boolean;
  lastModifiedDate?: string;
  containerFilePath?: string;
  actions?: {
    name?: string;
    actionType?: string;
    platform?: string;
    scheme?: string;
  }[];
}

export const workflowsInput = z.object({
  productId: idSchema("xcode-cloud products"),
  limit: limitSchema,
  cursor: cursorSchema,
});

/** A product's workflows: whether each is enabled, its repository and its actions. */
export async function listWorkflows(
  client: AscClient,
  input: z.output<typeof workflowsInput>,
) {
  const response = await withRoleHint(() =>
    client.get<AscDocument<WorkflowAttributes>>(
      `/v1/ciProducts/${input.productId}/workflows`,
      {
        include: "repository",
        "fields[ciWorkflows]": [
          "name",
          "description",
          "isEnabled",
          "isLockedForEditing",
          "lastModifiedDate",
          "containerFilePath",
          "actions",
          "repository",
        ],
        "fields[scmRepositories]": ["ownerName", "repositoryName"],
        limit: input.limit,
        cursor: input.cursor,
      },
    ),
  );
  return {
    workflows: response.data.map((workflow) => {
      const repository = related<{
        ownerName?: string;
        repositoryName?: string;
      }>(response, workflow, "repository");
      return {
        id: workflow.id,
        name: workflow.attributes?.name,
        description: workflow.attributes?.description,
        isEnabled: workflow.attributes?.isEnabled,
        isLockedForEditing: workflow.attributes?.isLockedForEditing,
        lastModifiedDate: workflow.attributes?.lastModifiedDate,
        containerFilePath: workflow.attributes?.containerFilePath,
        repository:
          repository &&
          [repository.ownerName, repository.repositoryName]
            .filter(Boolean)
            .join("/"),
        actions: (workflow.attributes?.actions ?? []).map((action) => ({
          name: action.name,
          type: action.actionType,
          platform: action.platform,
          scheme: action.scheme,
        })),
      };
    }),
    ...pageInfo(response),
  };
}

interface IssueCounts {
  analyzerWarnings?: number;
  errors?: number;
  testFailures?: number;
  warnings?: number;
}

interface Commit {
  commitSha?: string;
  message?: string;
  webUrl?: string;
}

interface BuildRunAttributes {
  number?: number;
  createdDate?: string;
  startedDate?: string;
  finishedDate?: string;
  sourceCommit?: Commit;
  isPullRequestBuild?: boolean;
  issueCounts?: IssueCounts;
  executionProgress?: string;
  completionStatus?: string;
  startReason?: string;
  cancelReason?: string;
}

interface GitReferenceAttributes {
  name?: string;
  canonicalName?: string;
  kind?: string;
}

interface PullRequestAttributes {
  title?: string;
  number?: number;
  webUrl?: string;
  sourceBranchName?: string;
  destinationBranchName?: string;
}

const RUN_QUERY = {
  include: [
    "workflow",
    "sourceBranchOrTag",
    "destinationBranch",
    "pullRequest",
  ],
  "fields[ciBuildRuns]": [
    "number",
    "createdDate",
    "startedDate",
    "finishedDate",
    "sourceCommit",
    "isPullRequestBuild",
    "issueCounts",
    "executionProgress",
    "completionStatus",
    "startReason",
    "cancelReason",
    "workflow",
    "sourceBranchOrTag",
    "destinationBranch",
    "pullRequest",
  ],
  "fields[ciWorkflows]": ["name"],
  "fields[scmGitReferences]": ["name", "canonicalName", "kind"],
  "fields[scmPullRequests]": [
    "title",
    "number",
    "webUrl",
    "sourceBranchName",
    "destinationBranchName",
  ],
};

/** A build run with its workflow, branch or tag and pull request, as the runs commands print it. */
function shapeRun(
  document: Pick<AscDocument<unknown>, "included">,
  run: AscResource<BuildRunAttributes>,
) {
  const attributes = run.attributes ?? {};
  const source = related<GitReferenceAttributes>(
    document,
    run,
    "sourceBranchOrTag",
  );
  const destination = related<GitReferenceAttributes>(
    document,
    run,
    "destinationBranch",
  );
  const pullRequest = related<PullRequestAttributes>(
    document,
    run,
    "pullRequest",
  );
  return {
    id: run.id,
    number: attributes.number,
    workflow: related<{ name?: string }>(document, run, "workflow")?.name,
    executionProgress: attributes.executionProgress,
    completionStatus: attributes.completionStatus,
    startReason: attributes.startReason,
    cancelReason: attributes.cancelReason,
    createdDate: attributes.createdDate,
    startedDate: attributes.startedDate,
    finishedDate: attributes.finishedDate,
    sourceBranchOrTag: source?.name,
    destinationBranch: destination?.name,
    pullRequest: pullRequest && {
      number: pullRequest.number,
      title: pullRequest.title,
      webUrl: pullRequest.webUrl,
    },
    commit: attributes.sourceCommit && {
      sha: attributes.sourceCommit.commitSha,
      message: attributes.sourceCommit.message,
      webUrl: attributes.sourceCommit.webUrl,
    },
    issueCounts: attributes.issueCounts,
  };
}

export const runsInput = z.object({
  workflowId: idSchema("xcode-cloud workflows"),
  branch: z.string().trim().min(1).max(250).optional(),
  limit: limitSchema,
  cursor: cursorSchema,
});

/**
 * A workflow's build runs, newest first, with status and issue counts.
 * Apple has no branch filter, so --branch filters the page that was read.
 */
export async function listRuns(
  client: AscClient,
  input: z.output<typeof runsInput>,
) {
  const response = await withRoleHint(() =>
    client.get<AscDocument<BuildRunAttributes>>(
      `/v1/ciWorkflows/${input.workflowId}/buildRuns`,
      {
        ...RUN_QUERY,
        sort: "-number",
        limit: input.limit,
        cursor: input.cursor,
      },
    ),
  );
  const runs = response.data.map((run) => shapeRun(response, run));
  return {
    runs: input.branch
      ? runs.filter(
          (run) =>
            run.sourceBranchOrTag === input.branch ||
            run.destinationBranch === input.branch,
        )
      : runs,
    ...pageInfo(response),
  };
}

interface ActionAttributes {
  name?: string;
  actionType?: string;
  startedDate?: string;
  finishedDate?: string;
  issueCounts?: IssueCounts;
  executionProgress?: string;
  completionStatus?: string;
  isRequiredToPass?: boolean;
}

interface FileLocation {
  path?: string;
  lineNumber?: number;
}

interface IssueAttributes {
  issueType?: string;
  message?: string;
  fileSource?: FileLocation;
  category?: string;
}

interface TestResultAttributes {
  className?: string;
  name?: string;
  status?: string;
  fileSource?: FileLocation;
  message?: string;
  destinationTestResults?: {
    deviceName?: string;
    osVersion?: string;
    status?: string;
    duration?: number;
  }[];
}

export const runInput = z.object({
  runId: idSchema("xcode-cloud runs"),
});

function location(file?: FileLocation): string | undefined {
  if (!file?.path) return undefined;
  return file.lineNumber === undefined
    ? file.path
    : `${file.path}:${file.lineNumber}`;
}

function hasIssues(counts?: IssueCounts): boolean {
  return Object.values(counts ?? {}).some((count) => (count ?? 0) > 0);
}

/** The actions of a run, paged through; a run has a handful. */
async function readActions(client: AscClient, runId: string) {
  const actions: AscResource<ActionAttributes>[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.get<AscDocument<ActionAttributes>>(
      `/v1/ciBuildRuns/${runId}/actions`,
      {
        "fields[ciBuildActions]": [
          "name",
          "actionType",
          "startedDate",
          "finishedDate",
          "issueCounts",
          "executionProgress",
          "completionStatus",
          "isRequiredToPass",
        ],
        limit: 200,
        cursor,
      },
    );
    actions.push(...page.data);
    cursor = pageInfo(page).nextCursor;
  } while (cursor);
  return actions;
}

/** An action's first page of issues (up to 200): errors, warnings, analyzer warnings and test failures. */
async function readIssues(client: AscClient, actionId: string) {
  const page = await client.get<AscDocument<IssueAttributes>>(
    `/v1/ciBuildActions/${actionId}/issues`,
    {
      "fields[ciIssues]": ["issueType", "message", "fileSource", "category"],
      limit: 200,
    },
  );
  return {
    issues: page.data.map((issue) => ({
      type: issue.attributes?.issueType,
      message: issue.attributes?.message,
      file: location(issue.attributes?.fileSource),
      category: issue.attributes?.category,
    })),
    moreIssues: pageInfo(page).hasMore,
  };
}

/** A test action's failed tests; results carry no status filter, so pages are read and filtered. */
async function readFailedTests(client: AscClient, actionId: string) {
  const failed: ReturnType<typeof shapeTest>[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await client.get<AscDocument<TestResultAttributes>>(
      `/v1/ciBuildActions/${actionId}/testResults`,
      {
        "fields[ciTestResults]": [
          "className",
          "name",
          "status",
          "fileSource",
          "message",
          "destinationTestResults",
        ],
        limit: 200,
        cursor,
      },
    );
    for (const result of page.data) {
      const status = result.attributes?.status;
      if (status === "FAILURE" || status === "MIXED") {
        failed.push(shapeTest(result));
      }
    }
    cursor = pageInfo(page).nextCursor;
    pages++;
  } while (cursor && pages < MAX_TEST_PAGES);
  return { failedTests: failed, moreTestResults: cursor !== undefined };
}

function shapeTest(result: AscResource<TestResultAttributes>) {
  const attributes = result.attributes ?? {};
  return {
    className: attributes.className,
    name: attributes.name,
    status: attributes.status,
    message: attributes.message,
    file: location(attributes.fileSource),
    destinations: (attributes.destinationTestResults ?? [])
      .filter((destination) => destination.status !== "SUCCESS")
      .map((destination) => ({
        device: destination.deviceName,
        osVersion: destination.osVersion,
        status: destination.status,
      })),
  };
}

/**
 * One build run: its status, then each action with its issues (when it has
 * any) and, for a test action, its failed tests.
 */
export async function getRun(
  client: AscClient,
  input: z.output<typeof runInput>,
) {
  return withRoleHint(async () => {
    const response = await client.get<{
      data: AscResource<BuildRunAttributes>;
      included?: AscResource[];
    }>(`/v1/ciBuildRuns/${input.runId}`, RUN_QUERY);
    const actions = await readActions(client, input.runId);
    return {
      ...shapeRun(response, response.data),
      actions: await Promise.all(
        actions.map(async (action) => {
          const attributes = action.attributes ?? {};
          return {
            id: action.id,
            name: attributes.name,
            type: attributes.actionType,
            executionProgress: attributes.executionProgress,
            completionStatus: attributes.completionStatus,
            isRequiredToPass: attributes.isRequiredToPass,
            startedDate: attributes.startedDate,
            finishedDate: attributes.finishedDate,
            issueCounts: attributes.issueCounts,
            ...(hasIssues(attributes.issueCounts)
              ? await readIssues(client, action.id)
              : {}),
            ...(attributes.actionType === "TEST" &&
            (attributes.issueCounts?.testFailures ?? 0) > 0
              ? await readFailedTests(client, action.id)
              : {}),
          };
        }),
      ),
    };
  });
}

interface ArtifactAttributes {
  fileType?: string;
  fileName?: string;
  fileSize?: number;
  downloadUrl?: string;
}

export const artifactsInput = z.object({
  runId: idSchema("xcode-cloud runs"),
});

/** A run's artifacts (logs, archives, result bundles) per action: metadata and download links, nothing downloaded. */
export async function listArtifacts(
  client: AscClient,
  input: z.output<typeof artifactsInput>,
) {
  return withRoleHint(async () => {
    const actions = await readActions(client, input.runId);
    return {
      runId: input.runId,
      actions: await Promise.all(
        actions.map(async (action) => {
          const page = await client.get<AscDocument<ArtifactAttributes>>(
            `/v1/ciBuildActions/${action.id}/artifacts`,
            {
              "fields[ciArtifacts]": [
                "fileType",
                "fileName",
                "fileSize",
                "downloadUrl",
              ],
              limit: 200,
            },
          );
          return {
            id: action.id,
            name: action.attributes?.name,
            type: action.attributes?.actionType,
            artifacts: page.data.map((artifact) => ({
              id: artifact.id,
              type: artifact.attributes?.fileType,
              fileName: artifact.attributes?.fileName,
              fileSize: artifact.attributes?.fileSize,
              downloadUrl: artifact.attributes?.downloadUrl,
            })),
          };
        }),
      ),
    };
  });
}
