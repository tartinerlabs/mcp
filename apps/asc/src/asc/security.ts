import { spawn } from "node:child_process";
import { LocalCommandError } from "../utils/errors.ts";

const SECURITY = "/usr/bin/security";

/** Quotes one argument for `security -i`, which reads backslash escapes inside double quotes. */
function quote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * Runs one macOS `security` subcommand through `security -i`, so passwords
 * travel on stdin instead of the command line where `ps` would show them.
 * Each call is its own process, because `security -i` carries on after a
 * failed command. `secrets` are blanked out of any error message.
 */
export function runSecurity(
  args: string[],
  secrets: string[] = [],
): Promise<string> {
  if (args.some((arg) => /[\r\n\0]/.test(arg))) {
    return Promise.reject(
      new LocalCommandError(
        `security ${args[0]} was not run: an argument contains a line break.`,
      ),
    );
  }
  return new Promise((resolveOutput, reject) => {
    const child = spawn(SECURITY, ["-i"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", () =>
      reject(new LocalCommandError(`Could not run ${SECURITY}.`)),
    );
    child.on("close", (code) => {
      if (code === 0) return resolveOutput(stdout);
      let detail = stderr.trim();
      for (const secret of secrets) {
        if (secret) detail = detail.replaceAll(secret, "***");
      }
      reject(
        new LocalCommandError(
          `security ${args[0]} failed${detail ? `: ${detail.slice(0, 300)}` : "."}`,
        ),
      );
    });
    child.stdin.end(`${args.map(quote).join(" ")}\n`);
  });
}
