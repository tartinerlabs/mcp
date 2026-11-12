import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/cli.ts";
import type { IndexNowClient } from "../src/indexnow/client.ts";

const KEY = "test-key-not-secret";
const keyFile = (status = 200, text = KEY) =>
  vi.fn().mockResolvedValue({ status, text });

/** Runs the CLI with a mocked client, capturing stdout, stderr and the exit code. */
async function run(args: string[], client: Partial<IndexNowClient> = {}) {
  const notMocked = () => Promise.reject(new Error("not mocked"));
  let stderr = "";
  const program = createProgram({
    fetchKeyFile: keyFile(),
    submit: notMocked,
    ...client,
  });
  // Subcommands inherit both settings when they are created, so set them on each.
  for (const command of [program, ...program.commands]) {
    command.exitOverride().configureOutput({
      writeErr: (text) => {
        stderr += text;
      },
    });
  }
  const pending = program
    .parseAsync(args, { from: "user" })
    .then(() => process.exitCode ?? 0)
    .catch((error: { exitCode?: number }) => error.exitCode ?? 1);
  await vi.advanceTimersByTimeAsync(20 * 60_000);
  const exitCode = await pending;
  const stdout = vi
    .mocked(console.log)
    .mock.calls.map(([text]) => text)
    .join("\n");
  const progress = vi
    .mocked(console.error)
    .mock.calls.map(([text]) => text)
    .join("\n");
  return { exitCode, stdout, stderr: stderr + progress };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("submit", () => {
  it("should submit the deduplicated urls and print the outcome", async () => {
    const submit = vi.fn().mockResolvedValue(200);

    const result = await run(
      [
        "submit",
        "https://example.com/a",
        "https://example.com/b",
        "https://example.com/a",
        "--key",
        KEY,
      ],
      { submit },
    );

    expect(result.exitCode).toBe(0);
    expect(submit).toHaveBeenCalledWith({
      host: "example.com",
      key: KEY,
      urlList: ["https://example.com/a", "https://example.com/b"],
    });
    expect(JSON.parse(result.stdout)).toEqual({
      host: "example.com",
      submitted: 2,
      status: 200,
      note: "Accepted.",
    });
  });

  it("should pass --key-location through when the key file is not at the root", async () => {
    const keyLocation = `https://example.com/blog/${KEY}.txt`;
    const submit = vi.fn().mockResolvedValue(202);

    const result = await run(
      [
        "submit",
        "https://example.com/blog/post",
        "--key",
        KEY,
        "--key-location",
        keyLocation,
      ],
      { submit },
    );

    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ keyLocation }),
    );
    expect(JSON.parse(result.stdout).note).toContain("will validate the key");
  });

  it("should exit with 1 and the classified error when the submission fails", async () => {
    const submit = vi.fn();

    const result = await run(
      ["submit", "https://example.com/a", "--key", KEY],
      {
        fetchKeyFile: keyFile(404, ""),
        submit,
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/\[not_found\] .*was not found/);
    expect(result.stdout).toBe("");
    expect(submit).not.toHaveBeenCalled();
  });

  it("should report retries on stderr while the key file goes live", async () => {
    const result = await run(
      ["submit", "https://example.com/a", "--key", KEY],
      {
        fetchKeyFile: vi
          .fn()
          .mockResolvedValueOnce({ status: 404, text: "" })
          .mockResolvedValue({ status: 200, text: KEY }),
        submit: vi.fn().mockResolvedValue(200),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Retrying in 15s: [not_found]");
    expect(JSON.parse(result.stdout).submitted).toBe(1);
  });

  it("should reject urls on more than one host without calling IndexNow", async () => {
    const fetchKeyFile = keyFile();

    const result = await run(
      [
        "submit",
        "https://example.com/a",
        "https://example.org/b",
        "--key",
        KEY,
      ],
      { fetchKeyFile },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[invalid_input]");
    expect(result.stderr).toContain("All urls must be on one host");
    expect(fetchKeyFile).not.toHaveBeenCalled();
  });

  it("should require --key", async () => {
    const result = await run(["submit", "https://example.com/a"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--key");
  });
});

describe("verify", () => {
  it("should report a live key file as valid", async () => {
    const result = await run([
      "verify",
      "https://example.com/some/page",
      "--key",
      KEY,
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      valid: true,
      keyLocation: `https://example.com/${KEY}.txt`,
    });
  });

  it("should print why a key file fails and exit with 1", async () => {
    const result = await run(["verify", "https://example.com", "--key", KEY], {
      fetchKeyFile: keyFile(404, ""),
    });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ valid: false });
  });
});
