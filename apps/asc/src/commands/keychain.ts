import { access, copyFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import * as z from "zod";
import { runSecurity } from "../asc/security.ts";
import {
  InvalidInputError,
  LocalCommandError,
  UploadIncompleteError,
} from "../utils/errors.ts";

// Installs signing files on a Mac: a certificate and private key into a
// keychain, and provisioning profiles where Xcode reads them. This is the one
// part of asc that runs local tools, and only on macOS. Keychain passwords
// come from an environment variable and reach `security` on stdin.

const PASSWORD_ENV = "ASC_KEYCHAIN_PASSWORD";
/** Where Xcode 16 and later read provisioning profiles. */
const PROFILES_DIR = join(
  homedir(),
  "Library/Developer/Xcode/UserData/Provisioning Profiles",
);
/** Keep the keychain unlocked for a CI job: 6 hours. */
const LOCK_TIMEOUT = "21600";

const envName = z
  .string()
  .trim()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Must be an environment variable name.")
  .default(PASSWORD_ENV);

const keychainSchema = z
  .string({ error: "Give the keychain file with --keychain." })
  .trim()
  .min(1, "Give the keychain file with --keychain.");

function requireMacOS() {
  if (process.platform !== "darwin") {
    throw new InvalidInputError(
      "signing install and uninstall need macOS: they use /usr/bin/security.",
    );
  }
}

function readPassword(name: string): string {
  const password = process.env[name];
  if (!password) {
    throw new InvalidInputError(
      `Set the keychain password in the ${name} environment variable.`,
    );
  }
  return password;
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/** The user's keychain search list. */
async function searchList(): Promise<string[]> {
  const output = await runSecurity(["list-keychains", "-d", "user"]);
  return output
    .split("\n")
    .map((line) => line.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

/** The name, UUID and expiry from a profile's embedded property list. */
async function readProfile(path: string) {
  let text: string;
  try {
    text = (await readFile(path)).toString("latin1");
  } catch {
    throw new InvalidInputError(`Could not read the profile ${path}.`);
  }
  const value = (key: string, tag: string) =>
    new RegExp(`<key>${key}</key>\\s*<${tag}>([^<]*)</${tag}>`).exec(text)?.[1];
  const uuid = value("UUID", "string");
  if (!uuid || !/^[0-9A-Fa-f-]{36}$/.test(uuid)) {
    throw new InvalidInputError(
      `${path} is not a provisioning profile: it has no UUID.`,
    );
  }
  return {
    file: path,
    uuid,
    name: value("Name", "string"),
    expirationDate: value("ExpirationDate", "date"),
  };
}

export const installSigningInput = z.object({
  keychain: keychainSchema,
  createKeychain: z.boolean().default(false),
  passwordEnv: envName,
  cert: z.string().trim().min(1).optional(),
  key: z.string().trim().min(1).optional(),
  profile: z.array(z.string().trim().min(1)).optional(),
  profilesDir: z.string().trim().min(1).optional(),
  yes: z.boolean().default(false),
});

/**
 * Imports a certificate and its private key into a keychain (created when
 * asked), unlocks it, lets codesign use the key without a prompt and adds the
 * keychain to the user's search list; copies profiles to Xcode's profiles
 * directory as <UUID>.mobileprovision. Without `yes`, only checks the files.
 */
export async function installSigning(
  input: z.output<typeof installSigningInput>,
) {
  requireMacOS();
  if ((input.cert === undefined) !== (input.key === undefined)) {
    throw new InvalidInputError("Give --cert and --key together.");
  }
  if (input.cert === undefined && !input.profile?.length) {
    throw new InvalidInputError("Give --cert and --key, --profile, or both.");
  }
  const keychain = resolve(input.keychain);
  const usesKeychain = input.cert !== undefined || input.createKeychain;
  const keychainExists = await exists(keychain);
  if (input.createKeychain && keychainExists) {
    throw new InvalidInputError(
      `${input.keychain} already exists; leave out --create-keychain to use it, or remove it with signing uninstall. Nothing was changed.`,
    );
  }
  if (usesKeychain && !input.createKeychain && !keychainExists) {
    throw new InvalidInputError(
      `${input.keychain} does not exist; add --create-keychain to make it. Nothing was changed.`,
    );
  }
  const password = usesKeychain ? readPassword(input.passwordEnv) : "";
  const cert = input.cert === undefined ? undefined : resolve(input.cert);
  const key = input.key === undefined ? undefined : resolve(input.key);
  if (cert && !(await exists(cert))) {
    throw new InvalidInputError(
      `Could not read the certificate ${input.cert}.`,
    );
  }
  if (key) {
    const head = await readFile(key, "utf8").then(
      (text) => text.slice(0, 64),
      () => undefined,
    );
    if (head === undefined) {
      throw new InvalidInputError(
        `Could not read the private key ${input.key}.`,
      );
    }
    if (!/^-----BEGIN (RSA |EC )?PRIVATE KEY-----/.test(head)) {
      throw new InvalidInputError(
        `${input.key} is not a PEM private key such as certificates create writes.`,
      );
    }
  }
  const profilesDir = resolve(input.profilesDir ?? PROFILES_DIR);
  const profiles = await Promise.all(
    (input.profile ?? []).map((file) => readProfile(resolve(file))),
  );
  const plan = {
    action: "signing-install",
    keychain: usesKeychain ? keychain : undefined,
    createKeychain: input.createKeychain,
    certificate: cert,
    privateKey: key,
    profiles: profiles.map((profile) => ({
      ...profile,
      installTo: join(profilesDir, `${profile.uuid}.mobileprovision`),
    })),
  };
  if (!input.yes) return { dryRun: true, ...plan };

  const done: string[] = [];
  const step = async (name: string, args: string[]) => {
    await runSecurity(args, [password]);
    done.push(name);
  };
  /** Importing what is already there is not an error. */
  const importFile = async (name: string, path: string) => {
    try {
      await step(name, [
        "import",
        path,
        "-k",
        keychain,
        "-T",
        "/usr/bin/codesign",
        "-T",
        "/usr/bin/security",
      ]);
    } catch (error) {
      if (
        error instanceof LocalCommandError &&
        error.message.includes("already exists")
      ) {
        done.push(`${name} (already there)`);
        return;
      }
      throw error;
    }
  };
  try {
    if (input.createKeychain) {
      await step("create keychain", [
        "create-keychain",
        "-p",
        password,
        keychain,
      ]);
      await step("keychain settings", [
        "set-keychain-settings",
        "-lut",
        LOCK_TIMEOUT,
        keychain,
      ]);
    }
    if (usesKeychain) {
      await step("unlock keychain", [
        "unlock-keychain",
        "-p",
        password,
        keychain,
      ]);
      const list = await searchList();
      if (!list.includes(keychain)) {
        await step("add to search list", [
          "list-keychains",
          "-d",
          "user",
          "-s",
          ...list,
          keychain,
        ]);
      }
    }
    if (cert && key) {
      await importFile("import certificate", cert);
      await importFile("import private key", key);
      await step("allow codesign", [
        "set-key-partition-list",
        "-S",
        "apple-tool:,apple:,codesign:",
        "-s",
        "-k",
        password,
        keychain,
      ]);
    }
    if (plan.profiles.length > 0) {
      await mkdir(profilesDir, { recursive: true });
      for (const profile of plan.profiles) {
        await copyFile(profile.file, profile.installTo);
        done.push(`install profile ${profile.uuid}`);
      }
    }
  } catch (error) {
    if (done.length === 0) throw error;
    throw new UploadIncompleteError(
      `Done before stopping: ${done.join(", ")}.`,
      { cause: error },
    );
  }
  return { dryRun: false, ...plan, steps: done };
}

export const uninstallSigningInput = z.object({
  keychain: keychainSchema,
  yes: z.boolean().default(false),
});

/** Removes a keychain from the search list and deletes it. Without `yes`, only shows which. */
export async function uninstallSigning(
  input: z.output<typeof uninstallSigningInput>,
) {
  requireMacOS();
  const keychain = resolve(input.keychain);
  if (basename(keychain).startsWith("login.keychain")) {
    throw new InvalidInputError(
      "signing uninstall never deletes the login keychain.",
    );
  }
  if (!(await exists(keychain))) {
    throw new InvalidInputError(`${input.keychain} does not exist.`);
  }
  const list = await searchList();
  const inSearchList = list.includes(keychain);
  const plan = { action: "signing-uninstall", keychain, inSearchList };
  if (!input.yes) {
    return {
      dryRun: true,
      ...plan,
      warning: "Deleting the keychain removes every item in it.",
    };
  }
  if (inSearchList) {
    await runSecurity([
      "list-keychains",
      "-d",
      "user",
      "-s",
      ...list.filter((item) => item !== keychain),
    ]);
  }
  await runSecurity(["delete-keychain", keychain]);
  return { dryRun: false, ...plan };
}
