import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSecurity } from "../src/asc/security.ts";
import { createProgram } from "../src/cli.ts";
import { CredentialsError, LocalCommandError } from "../src/utils/errors.ts";

// Never runs /usr/bin/security: every call goes to this mock.
vi.mock("../src/asc/security.ts", () => ({ runSecurity: vi.fn() }));
const security = vi.mocked(runSecurity);

async function run(args: string[]) {
  let stderr = "";
  // Local commands must not ask for an App Store Connect key.
  const program = createProgram(() => {
    throw new CredentialsError("no key");
  });
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

// Built from parts so secret scanners do not read the fixture as a key.
const PASSWORD = ["fixture", "keychain", "password"].join("-");
const UUID = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";
const platform = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(value: string) {
  Object.defineProperty(process, "platform", { value });
}

async function files() {
  const dir = await mkdtemp(join(tmpdir(), "asc-keychain-"));
  const cert = join(dir, "CERT1.cer");
  const key = join(dir, "CERT1.key");
  const profile = join(dir, "app.mobileprovision");
  await writeFile(cert, new Uint8Array([0x30, 0x82]));
  const label = "PRIVATE KEY";
  await writeFile(
    key,
    `-----BEGIN ${label}-----\nAAAA\n-----END ${label}-----\n`,
  );
  await writeFile(
    profile,
    `binary<plist><dict><key>Name</key><string>App Store</string><key>UUID</key><string>${UUID}</string><key>ExpirationDate</key><date>2027-11-27T00:00:00Z</date></dict></plist>binary`,
  );
  return { dir, cert, key, profile, keychain: join(dir, "ci.keychain-db") };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubEnv("ASC_KEYCHAIN_PASSWORD", PASSWORD);
  setPlatform("darwin");
  security.mockReset();
  security.mockImplementation(async (args) =>
    args[0] === "list-keychains" && args.length === 3
      ? '    "/Users/me/Library/Keychains/login.keychain-db"\n'
      : "",
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (platform) Object.defineProperty(process, "platform", platform);
});

describe("signing install", () => {
  it("should refuse to run outside macOS", async () => {
    setPlatform("linux");
    const { keychain, profile } = await files();
    const result = await run([
      "signing",
      "install",
      "--keychain",
      keychain,
      "--profile",
      profile,
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[invalid_input]");
    expect(result.stderr).toContain("macOS");
  });

  it("should check the files and run nothing without --yes", async () => {
    const f = await files();
    const result = await run([
      "signing",
      "install",
      "--keychain",
      f.keychain,
      "--create-keychain",
      "--cert",
      f.cert,
      "--key",
      f.key,
      "--profile",
      f.profile,
      "--profiles-dir",
      join(f.dir, "profiles"),
    ]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      dryRun: true,
      keychain: f.keychain,
      profiles: [
        {
          uuid: UUID,
          name: "App Store",
          installTo: join(f.dir, "profiles", `${UUID}.mobileprovision`),
        },
      ],
    });
    expect(security).not.toHaveBeenCalled();
  });

  it("should create, unlock, import and install, keeping the password out of output", async () => {
    const f = await files();
    const profiles = join(f.dir, "profiles");
    const result = await run([
      "signing",
      "install",
      "--keychain",
      f.keychain,
      "--create-keychain",
      "--cert",
      f.cert,
      "--key",
      f.key,
      "--profile",
      f.profile,
      "--profiles-dir",
      profiles,
      "--yes",
    ]);
    expect(result.exitCode).toBe(0);
    expect(security.mock.calls.map(([args]) => args)).toEqual([
      ["create-keychain", "-p", PASSWORD, f.keychain],
      ["set-keychain-settings", "-lut", "21600", f.keychain],
      ["unlock-keychain", "-p", PASSWORD, f.keychain],
      ["list-keychains", "-d", "user"],
      [
        "list-keychains",
        "-d",
        "user",
        "-s",
        "/Users/me/Library/Keychains/login.keychain-db",
        f.keychain,
      ],
      [
        "import",
        f.cert,
        "-k",
        f.keychain,
        "-T",
        "/usr/bin/codesign",
        "-T",
        "/usr/bin/security",
      ],
      [
        "import",
        f.key,
        "-k",
        f.keychain,
        "-T",
        "/usr/bin/codesign",
        "-T",
        "/usr/bin/security",
      ],
      [
        "set-key-partition-list",
        "-S",
        "apple-tool:,apple:,codesign:",
        "-s",
        "-k",
        PASSWORD,
        f.keychain,
      ],
    ]);
    expect(
      await readFile(join(profiles, `${UUID}.mobileprovision`), "utf8"),
    ).toContain(UUID);
    expect(result.stdout).not.toContain(PASSWORD);
    expect(result.stdout).not.toContain("AAAA");
  });

  it("should accept items already in the keychain", async () => {
    const f = await files();
    await writeFile(f.keychain, "");
    security.mockImplementation(async (args) => {
      if (args[0] === "import") {
        throw new LocalCommandError(
          "security import failed: The specified item already exists in the keychain.",
        );
      }
      return args[0] === "list-keychains" ? `"${f.keychain}"\n` : "";
    });
    const result = await run([
      "signing",
      "install",
      "--keychain",
      f.keychain,
      "--cert",
      f.cert,
      "--key",
      f.key,
      "--yes",
    ]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).steps).toContain(
      "import certificate (already there)",
    );
  });

  it("should say what was done when a step fails", async () => {
    const f = await files();
    security.mockImplementation(async (args) => {
      if (args[0] === "unlock-keychain") {
        throw new LocalCommandError("security unlock-keychain failed: ***");
      }
      return "";
    });
    const result = await run([
      "signing",
      "install",
      "--keychain",
      f.keychain,
      "--create-keychain",
      "--cert",
      f.cert,
      "--key",
      f.key,
      "--yes",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[unavailable]");
    expect(result.stderr).toContain("create keychain, keychain settings");
    expect(result.stderr).not.toContain(PASSWORD);
  });

  it("should need the password and an existing keychain", async () => {
    const f = await files();
    const missing = await run([
      "signing",
      "install",
      "--keychain",
      f.keychain,
      "--cert",
      f.cert,
      "--key",
      f.key,
    ]);
    expect(missing.stderr).toContain("add --create-keychain");
    vi.stubEnv("ASC_KEYCHAIN_PASSWORD", "");
    const noPassword = await run([
      "signing",
      "install",
      "--keychain",
      f.keychain,
      "--create-keychain",
      "--cert",
      f.cert,
      "--key",
      f.key,
    ]);
    expect(noPassword.exitCode).toBe(1);
    expect(noPassword.stderr).toContain("ASC_KEYCHAIN_PASSWORD");
  });

  it("should refuse a file that is not a profile", async () => {
    const f = await files();
    const result = await run([
      "signing",
      "install",
      "--keychain",
      f.keychain,
      "--profile",
      f.cert,
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not a provisioning profile");
  });
});

describe("signing uninstall", () => {
  it("should remove the keychain from the search list and delete it", async () => {
    const f = await files();
    await writeFile(f.keychain, "");
    security.mockImplementation(async (args) =>
      args[0] === "list-keychains" && args.length === 3
        ? `"/Users/me/Library/Keychains/login.keychain-db"\n"${f.keychain}"\n`
        : "",
    );
    const dry = await run(["signing", "uninstall", "--keychain", f.keychain]);
    expect(JSON.parse(dry.stdout)).toMatchObject({
      dryRun: true,
      inSearchList: true,
    });
    expect(security).toHaveBeenCalledTimes(1);
    vi.mocked(console.log).mockClear();
    const result = await run([
      "signing",
      "uninstall",
      "--keychain",
      f.keychain,
      "--yes",
    ]);
    expect(result.exitCode).toBe(0);
    expect(security).toHaveBeenCalledWith([
      "list-keychains",
      "-d",
      "user",
      "-s",
      "/Users/me/Library/Keychains/login.keychain-db",
    ]);
    expect(security).toHaveBeenLastCalledWith(["delete-keychain", f.keychain]);
  });

  it("should never delete the login keychain", async () => {
    const result = await run([
      "signing",
      "uninstall",
      "--keychain",
      "/Users/me/Library/Keychains/login.keychain-db",
      "--yes",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("never deletes the login keychain");
    expect(security).not.toHaveBeenCalled();
  });
});
