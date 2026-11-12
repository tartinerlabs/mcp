import { readFile } from "node:fs/promises";
import { type AscKey, keySchema } from "../schemas/common.ts";
import { CredentialsError } from "../utils/errors.ts";

/** The global options that choose a key; each falls back to an environment variable. */
export interface CredentialOptions {
  keyId?: string;
  issuerId?: string;
  /** Path to the `.p8` file. */
  privateKey?: string;
}

/**
 * Reads the key from the options, else from ASC_KEY_ID, ASC_ISSUER_ID and
 * ASC_PRIVATE_KEY_PATH. Nothing is stored: the `.p8` file is read on each run.
 */
export async function readCredentials(
  options: CredentialOptions,
  env: Record<string, string | undefined> = process.env,
): Promise<AscKey> {
  const keyId = options.keyId ?? env.ASC_KEY_ID;
  const path = options.privateKey ?? env.ASC_PRIVATE_KEY_PATH;
  if (!keyId) {
    throw new CredentialsError(
      "No App Store Connect key ID. Pass --key-id or set ASC_KEY_ID.",
    );
  }
  if (!path) {
    throw new CredentialsError(
      "No App Store Connect private key. Pass --private-key with the path to the .p8 file, or set ASC_PRIVATE_KEY_PATH.",
    );
  }
  const privateKey = await readFile(path, "utf8").catch(() => {
    throw new CredentialsError(
      `The private key file could not be read: ${path}`,
    );
  });
  const parsed = keySchema.safeParse({
    keyId,
    issuerId: options.issuerId ?? env.ASC_ISSUER_ID,
    privateKey,
  });
  if (!parsed.success) {
    throw new CredentialsError(
      parsed.error.issues.map((issue) => issue.message).join(" "),
    );
  }
  return parsed.data;
}
