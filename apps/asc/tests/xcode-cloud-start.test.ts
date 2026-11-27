import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AscClient } from "../src/asc/client.ts";
import { AscApiError } from "../src/utils/errors.ts";
import { mockClient, runCli } from "./team-harness.ts";

const workflow = {
  data: {
    type: "ciWorkflows",
    id: "WF1",
    attributes: { name: "Release", isEnabled: true },
    relationships: {
      repository: { data: { type: "scmRepositories", id: "REPO1" } },
    },
  },
  included: [
    {
      type: "scmRepositories",
      id: "REPO1",
      attributes: { ownerName: "acme", repositoryName: "app" },
    },
  ],
};

const references = {
  data: [
    {
      type: "scmGitReferences",
      id: "REF-OLD",
      attributes: { name: "main", kind: "BRANCH", isDeleted: true },
    },
    {
      type: "scmGitReferences",
      id: "REF-TAG",
      attributes: { name: "main", kind: "TAG" },
    },
    {
      type: "scmGitReferences",
      id: "REF-MAIN",
      attributes: { name: "main", kind: "BRANCH" },
    },
  ],
};

function run(id: string, executionProgress: string, completionStatus?: string) {
  return {
    data: {
      type: "ciBuildRuns",
      id,
      attributes: { number: 7, executionProgress, completionStatus },
    },
  };
}

function client(overrides: Partial<AscClient> = {}) {
  return mockClient({
    get: vi.fn(async (path: string) => {
      if (path === "/v1/ciWorkflows/WF1") return workflow;
      if (path === "/v1/scmRepositories/REPO1/gitReferences") return references;
      if (path === "/v1/scmRepositories/REPO1/pullRequests") {
        return {
          data: [
            {
              type: "scmPullRequests",
              id: "PR-12",
              attributes: { number: 12, title: "Fix", isClosed: false },
            },
            {
              type: "scmPullRequests",
              id: "PR-13",
              attributes: { number: 13, isClosed: true },
            },
          ],
        };
      }
      throw new Error(`unexpected GET ${path}`);
    }) as AscClient["get"],
    ...overrides,
  });
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("xcode-cloud start", () => {
  it("should show the workflow and branch without --yes and start nothing", async () => {
    const asc = client();
    const result = await runCli(
      ["xcode-cloud", "start", "WF1", "--branch", "main"],
      asc,
    );
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({
      dryRun: true,
      workflow: { id: "WF1", name: "Release", repository: "acme/app" },
      source: { type: "scmGitReferences", id: "REF-MAIN", kind: "BRANCH" },
      clean: false,
    });
    expect(asc.post).not.toHaveBeenCalled();
    expect(result.stderr).toContain("Dry run");
  });

  it("should start a clean build of a tag with --yes", async () => {
    const asc = client({
      post: vi.fn(async () => run("RUN9", "PENDING")) as AscClient["post"],
    });
    const result = await runCli(
      ["xcode-cloud", "start", "WF1", "--tag", "main", "--clean", "--yes"],
      asc,
    );
    expect(result.exitCode).toBe(0);
    expect(asc.post).toHaveBeenCalledWith("/v1/ciBuildRuns", {
      data: {
        type: "ciBuildRuns",
        attributes: { clean: true },
        relationships: {
          workflow: { data: { type: "ciWorkflows", id: "WF1" } },
          sourceBranchOrTag: {
            data: { type: "scmGitReferences", id: "REF-TAG" },
          },
        },
      },
    });
    expect(JSON.parse(result.stdout).run).toMatchObject({
      id: "RUN9",
      executionProgress: "PENDING",
    });
  });

  it("should start an open pull request and refuse a closed one", async () => {
    const asc = client({
      post: vi.fn(async () => run("RUN9", "PENDING")) as AscClient["post"],
    });
    await runCli(
      ["xcode-cloud", "start", "WF1", "--pull-request", "12", "--yes"],
      asc,
    );
    expect(vi.mocked(asc.post).mock.calls[0]?.[1]).toMatchObject({
      data: {
        relationships: {
          pullRequest: { data: { type: "scmPullRequests", id: "PR-12" } },
        },
      },
    });
    const closed = await runCli(
      ["xcode-cloud", "start", "WF1", "--pull-request", "13"],
      asc,
    );
    expect(closed.exitCode).toBe(1);
    expect(closed.stderr).toContain("[not_found] No open pull request #13");
  });

  it("should refuse an unknown branch and a missing or doubled reference", async () => {
    const unknown = await runCli(
      ["xcode-cloud", "start", "WF1", "--branch", "nope"],
      client(),
    );
    expect(unknown.stderr).toContain("[not_found] No branch named nope");
    const none = await runCli(["xcode-cloud", "start", "WF1"], client());
    expect(none.stderr).toContain(
      "Give one of --branch, --tag or --pull-request.",
    );
    const both = await runCli(
      ["xcode-cloud", "start", "WF1", "--branch", "a", "--tag", "b"],
      client(),
    );
    expect(both.exitCode).toBe(1);
  });

  it("should wait for the run and exit 1 when it fails", async () => {
    const states = [run("RUN9", "RUNNING"), run("RUN9", "COMPLETE", "FAILED")];
    const asc = client({
      post: vi.fn(async () => run("RUN9", "PENDING")) as AscClient["post"],
    });
    const get = asc.get;
    asc.get = vi.fn(async (path: string, query?: unknown) => {
      if (path === "/v1/ciBuildRuns/RUN9") return states.shift();
      return get(path, query as never);
    }) as AscClient["get"];
    const sleep = vi.fn(async () => {});
    const result = await runCli(
      [
        "xcode-cloud",
        "start",
        "WF1",
        "--branch",
        "main",
        "--wait",
        "--interval",
        "10",
        "--yes",
      ],
      asc,
      { sleep, now: () => 0 },
    );
    expect(sleep).toHaveBeenCalledWith(10_000);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Started run RUN9");
    expect(result.stderr).toContain("The run finished as FAILED.");
    expect(JSON.parse(result.stdout).run.completionStatus).toBe("FAILED");
  });

  it("should name the Xcode Cloud role on a 403", async () => {
    const asc = client({
      post: vi.fn(async () => {
        throw new AscApiError(403, {});
      }) as AscClient["post"],
    });
    const result = await runCli(
      ["xcode-cloud", "start", "WF1", "--branch", "main", "--yes"],
      asc,
    );
    expect(result.stderr).toContain("[permission]");
    expect(result.stderr).toContain("Xcode Cloud");
  });
});

describe("xcode-cloud rerun", () => {
  it("should show the run without --yes and rebuild it with --yes", async () => {
    const asc = mockClient({
      get: vi.fn(async () =>
        run("RUN1", "COMPLETE", "FAILED"),
      ) as AscClient["get"],
      post: vi.fn(async () => run("RUN2", "PENDING")) as AscClient["post"],
    });
    const dry = await runCli(["xcode-cloud", "rerun", "RUN1"], asc);
    expect(JSON.parse(dry.stdout)).toMatchObject({
      dryRun: true,
      run: { id: "RUN1" },
    });
    expect(asc.post).not.toHaveBeenCalled();

    vi.mocked(console.log).mockClear();
    const done = await runCli(["xcode-cloud", "rerun", "RUN1", "--yes"], asc);
    expect(done.exitCode).toBe(0);
    expect(asc.post).toHaveBeenCalledWith("/v1/ciBuildRuns", {
      data: {
        type: "ciBuildRuns",
        relationships: {
          buildRun: { data: { type: "ciBuildRuns", id: "RUN1" } },
        },
      },
    });
    expect(JSON.parse(done.stdout).run.id).toBe("RUN2");
  });

  it("should give up waiting after the timeout", async () => {
    const asc = mockClient({
      get: vi.fn(async () => run("RUN2", "RUNNING")) as AscClient["get"],
      post: vi.fn(async () => run("RUN2", "PENDING")) as AscClient["post"],
    });
    let clock = 0;
    const result = await runCli(
      ["xcode-cloud", "rerun", "RUN1", "--wait", "--timeout", "1", "--yes"],
      asc,
      {
        sleep: async (ms) => {
          clock += ms;
        },
        now: () => clock,
      },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "[unavailable] Run RUN2 was still RUNNING after 1 minute",
    );
  });
});
