import { execFile } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt,
} from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { InvalidInputError, LocalCommandError } from "../utils/errors.ts";

/*
 * Encrypted file format, version 1. Every file in a signing store is one of
 * these; nothing is stored in plain text.
 *
 *   offset  size  field
 *   0       4     magic "ASCS"
 *   4       1     format version, 1
 *   5       1     scrypt log2(N), 14 to 20 (written as 17)
 *   6       1     scrypt r, 1 to 16 (written as 8)
 *   7       1     scrypt p, 1 to 4 (written as 1)
 *   8       16    scrypt salt, random per file
 *   24      12    AES-GCM nonce, random per file
 *   36      n     AES-256-GCM ciphertext
 *   36+n    16    AES-GCM authentication tag
 *
 * The key is scrypt(passphrase (NFC, UTF-8), salt, 32 bytes). The additional
 * authenticated data is the 36-byte header followed by the file's path in the
 * store (UTF-8, "/" separated), so a file cannot be swapped for another one
 * or have its parameters changed without failing to decrypt. A later format
 * changes the version byte; readers refuse versions they do not know.
 */

const MAGIC = Buffer.from("ASCS", "ascii");
const VERSION = 1;
const HEADER_SIZE = 36;
const TAG_SIZE = 16;

export interface ScryptParams {
  logN: number;
  r: number;
  p: number;
}

const DEFAULT_PARAMS: ScryptParams = { logN: 17, r: 8, p: 1 };

function deriveKey(
  passphrase: string,
  salt: Buffer,
  { logN, r, p }: ScryptParams,
): Promise<Buffer> {
  return new Promise((resolveKey, reject) => {
    scrypt(
      Buffer.from(passphrase.normalize("NFC"), "utf8"),
      salt,
      32,
      { N: 2 ** logN, r, p, maxmem: 256 * 2 ** logN * r + 2 ** 20 },
      (error, key) => (error ? reject(error) : resolveKey(key)),
    );
  });
}

/** Encrypts one store file; `path` is its path in the store, bound into the tag. */
export async function encryptFile(
  passphrase: string,
  path: string,
  plaintext: Uint8Array,
  params: ScryptParams = DEFAULT_PARAMS,
): Promise<Buffer> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const header = Buffer.concat([
    MAGIC,
    Buffer.from([VERSION, params.logN, params.r, params.p]),
    salt,
    iv,
  ]);
  const key = await deriveKey(passphrase, salt, params);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.concat([header, Buffer.from(path, "utf8")]));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([header, body, cipher.getAuthTag()]);
}

/** Decrypts one store file; a wrong passphrase or a changed file fails the same way. */
export async function decryptFile(
  passphrase: string,
  path: string,
  data: Uint8Array,
): Promise<Buffer> {
  const bytes = Buffer.from(data);
  const unreadable = () =>
    new InvalidInputError(
      `Could not decrypt ${path} in the signing store: the passphrase is wrong or the file was changed.`,
    );
  if (
    bytes.length < HEADER_SIZE + TAG_SIZE ||
    !bytes.subarray(0, 4).equals(MAGIC)
  ) {
    throw unreadable();
  }
  const [version = 0, logN = 0, r = 0, p = 0] = bytes.subarray(4, 8);
  if (version !== VERSION) {
    throw new InvalidInputError(
      `${path} in the signing store uses format version ${version}, which this version of asc cannot read; update asc.`,
    );
  }
  // Bounds keep a tampered header from asking for huge amounts of memory.
  if (logN < 14 || logN > 20 || r < 1 || r > 16 || p < 1 || p > 4) {
    throw unreadable();
  }
  const header = bytes.subarray(0, HEADER_SIZE);
  const key = await deriveKey(passphrase, bytes.subarray(8, 24), {
    logN,
    r,
    p,
  });
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(24, 36));
  decipher.setAAD(Buffer.concat([header, Buffer.from(path, "utf8")]));
  decipher.setAuthTag(bytes.subarray(bytes.length - TAG_SIZE));
  try {
    return Buffer.concat([
      decipher.update(bytes.subarray(HEADER_SIZE, bytes.length - TAG_SIZE)),
      decipher.final(),
    ]);
  } catch {
    throw unreadable();
  }
}

/**
 * Where a signing store keeps its encrypted files. Paths are relative and
 * "/" separated. A new backend (S3, Cloud Storage) implements this.
 */
export interface SigningStore {
  /** Paths of the files under a directory, recursively. */
  list(directory: string): Promise<string[]>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
  /** Publishes the changes; resolves false when there were none. */
  save(message: string): Promise<boolean>;
  /** Removes anything kept locally. */
  close(): Promise<void>;
}

/** Hides credentials in a URL, such as a token in https://user:token@host. */
function redact(text: string): string {
  return text.replace(/\/\/[^/@\s]+@/g, "//***@");
}

function git(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        maxBuffer: 16 * 2 ** 20,
      },
      (error, stdout, stderr) => {
        if (!error) return resolveOutput(stdout);
        const detail = redact(String(stderr).trim()).slice(0, 300);
        reject(
          new LocalCommandError(
            `git ${args[0]} failed${detail ? `: ${detail}` : "."}`,
          ),
        );
      },
    );
  });
}

/** Checks a store path stays inside the store. */
function storePath(root: string, path: string): string {
  const absolute = resolve(root, path);
  if (
    !absolute.startsWith(root + sep) ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new InvalidInputError(`${path} is not a valid signing store path.`);
  }
  return absolute;
}

/**
 * A private git repository as a signing store: a shallow clone in a new
 * temporary directory (readable only by the user), committed and pushed on
 * save, and removed on close. `branch` must exist unless the repository is
 * empty.
 */
export async function openGitStore(options: {
  url: string;
  branch?: string;
}): Promise<SigningStore> {
  const root = await mkdtemp(join(tmpdir(), "asc-store-"));
  try {
    await git([
      "clone",
      "--quiet",
      "--depth",
      "1",
      ...(options.branch ? ["--branch", options.branch] : []),
      "--",
      options.url,
      root,
    ]);
    // A clone without a committer identity gets one of its own.
    const email = await git(["config", "user.email"], root).catch(() => "");
    if (!email.trim()) {
      await git(["config", "user.name", "asc"], root);
      await git(["config", "user.email", "asc@localhost"], root);
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }

  async function walk(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      () => [],
    );
    const found: string[] = [];
    for (const entry of entries) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) found.push(...(await walk(full)));
      else if (entry.isFile())
        found.push(relative(root, full).split(sep).join("/"));
    }
    return found;
  }

  return {
    async list(directory) {
      return (await walk(storePath(root, directory))).sort();
    },
    async read(path) {
      return readFile(storePath(root, path));
    },
    async write(path, data) {
      const absolute = storePath(root, path);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, data);
    },
    async remove(path) {
      await rm(storePath(root, path), { force: true });
    },
    async save(message) {
      await git(["add", "--all"], root);
      const changed = await git(["diff", "--cached", "--quiet"], root).then(
        () => false,
        () => true,
      );
      if (!changed) return false;
      await git(["commit", "--quiet", "--message", message], root);
      await git(["push", "--quiet", "origin", "HEAD"], root);
      return true;
    },
    async close() {
      await rm(root, { recursive: true, force: true });
    },
  };
}
