import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/cli.ts";
import { completionScript } from "../src/commands/completion.ts";

/** Whether a shell is installed, for the tests that run the script. */
function has(shell: string): boolean {
  try {
    execFileSync(shell, ["-c", "true"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const program = createProgram(() => {
  throw new Error("completion needs no client");
});

async function script(shell: "bash" | "zsh" | "fish") {
  const dir = await mkdtemp(join(tmpdir(), "asc-completion-"));
  const file = join(dir, `asc.${shell}`);
  await writeFile(file, completionScript(program, shell));
  return file;
}

/** What the bash script offers for the words typed so far; the last is the one being completed. */
function bashComplete(file: string, words: string[]): string[] {
  const output = execFileSync(
    "bash",
    [
      "-c",
      `source "$1"; shift; COMP_WORDS=("$@"); COMP_CWORD=$(($# - 1)); _asc; printf '%s\\n' "\${COMPREPLY[@]}"`,
      "bash",
      file,
      ...words,
    ],
    { encoding: "utf8" },
  );
  return output.split("\n").filter(Boolean);
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("completion", () => {
  it("should print a script for each shell through the CLI", async () => {
    for (const shell of ["bash", "zsh", "fish"]) {
      vi.mocked(console.log).mockClear();
      await createProgram(() => {
        throw new Error("completion needs no client");
      }).parseAsync(["completion", shell], { from: "user" });
      expect(vi.mocked(console.log).mock.calls[0]?.[0]).toContain(
        `asc completion for ${shell}`,
      );
    }
  });

  it("should cover every registered command, so new ones are included without changes", () => {
    const extra = new Command().name("asc");
    extra.command("brand-new").command("nested").option("--flag");
    for (const shell of ["bash", "zsh", "fish"] as const) {
      const text = completionScript(extra, shell);
      expect(text).toContain("brand-new");
      expect(text).toContain("nested");
      expect(text).toContain("flag");
    }
  });

  it("should list the fixed choices of options and arguments", () => {
    const text = completionScript(program, "fish");
    expect(text).toContain("-l 'platform' -x -a 'IOS MAC_OS TV_OS VISION_OS'");
    expect(text).toContain("'pause resume complete'");
    expect(text).toContain("'bash zsh fish'");
  });

  it.skipIf(!has("bash"))(
    "should complete commands, subcommands, options and choices in bash",
    async () => {
      const file = await script("bash");
      expect(bashComplete(file, ["asc", "not"])).toEqual(["notarize"]);
      expect(bashComplete(file, ["asc", "notarize", ""])).toEqual([
        "submit",
        "status",
        "log",
        "history",
      ]);
      expect(bashComplete(file, ["asc", "builds", "upload", "--ap"])).toEqual([
        "--app-version",
      ]);
      expect(
        bashComplete(file, ["asc", "versions", "123", "--platform", "M"]),
      ).toEqual(["MAC_OS"]);
      expect(
        bashComplete(file, ["asc", "versions", "phased-release", "V1", "pa"]),
      ).toEqual(["pause"]);
      // The program's own options work after a subcommand too.
      expect(bashComplete(file, ["asc", "apps", "--issuer"])).toEqual([
        "--issuer-id",
      ]);
    },
  );

  it.skipIf(!has("zsh"))("should be valid zsh", async () => {
    const file = await script("zsh");
    expect(() => execFileSync("zsh", ["-n", file])).not.toThrow();
  });

  it.skipIf(!has("fish"))("should be valid fish", async () => {
    const file = await script("fish");
    expect(() => execFileSync("fish", ["-n", file])).not.toThrow();
  });
});
