import type { Command } from "commander";
import { vi } from "vitest";
import type { AscClient } from "../src/asc/client.ts";
import {
  type AscClientProvider,
  createProgram,
  type ProgramOptions,
} from "../src/cli.ts";

/** A client whose methods fail unless a test gives them an implementation. */
export function mockClient(overrides: Partial<AscClient> = {}): AscClient {
  const fail = () => Promise.reject(new Error("unexpected call"));
  return {
    get: vi.fn(fail) as AscClient["get"],
    post: vi.fn(fail) as AscClient["post"],
    patch: vi.fn(fail) as AscClient["patch"],
    delete: vi.fn(fail) as AscClient["delete"],
    upload: vi.fn(fail) as AscClient["upload"],
    download: vi.fn(fail) as AscClient["download"],
    downloadSigned: vi.fn(fail) as AscClient["downloadSigned"],
    ...overrides,
  };
}

/** Runs the CLI, capturing stdout (console.log must be spied on), stderr and the exit code. */
export async function runCli(
  args: string[],
  client: AscClient,
  options: ProgramOptions = {},
) {
  let stderr = "";
  const provider: AscClientProvider = () => client;
  const program = createProgram(provider, options);
  const all = (command: Command): Command[] => [
    command,
    ...command.commands.flatMap(all),
  ];
  for (const command of all(program)) {
    command.exitOverride().configureOutput({
      writeErr: (text) => {
        stderr += text;
      },
    });
  }
  const exitCode = await program
    .parseAsync(args, { from: "user" })
    .then(() => 0)
    .catch((error: { exitCode?: number }) => error.exitCode ?? 1);
  const stdout = vi
    .mocked(console.log)
    .mock.calls.map(([text]) => text)
    .join("\n");
  return { exitCode, stdout, stderr };
}
