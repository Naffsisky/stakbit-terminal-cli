/**
 * Encrypted credential store.
 *
 * ## What this actually protects against, stated plainly
 *
 * The key is derived from the machine's hostname and the user's name, with a per-file random salt.
 * That means: **anything running as the same user on the same machine can derive the same key and
 * read these files.** This is obfuscation with authentication, not a vault. Calling it "encrypted"
 * and stopping there would be the kind of half-truth that gets someone to put a credential on a
 * shared box.
 *
 * So: on a laptop you control, this is fine — it keeps the token out of a `.env` that gets
 * committed, out of shell history, and out of a `ps` listing. On a shared host or a VPS, treat it as
 * "the token is on disk" and protect the account accordingly. The same reasoning is why the file is
 * mode 0600 and why `logout` actually deletes rather than blanks.
 *
 * ## Why AES-256-GCM and not something simpler
 *
 * GCM is authenticated, so a truncated or edited file fails to open rather than decrypting to
 * garbage that the API then rejects with a confusing 401. The tag is checked; a wrong key is a
 * `CredentialError`, not a JSON parse error three layers up.
 *
 * ## Format
 *
 * `salt(16) || iv(12) || tag(16) || ciphertext`. Versioned by a leading magic so a future format can
 * be detected instead of misparsed.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { dirname } from "node:path";

const MAGIC = Buffer.from("SKB1", "ascii");
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

export class CredentialError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CredentialError";
  }
}

/**
 * Derive the file key.
 *
 * `STAKBIT_STORE_SECRET` is honoured when set, which is the escape hatch for anyone who wants a
 * secret this machine cannot derive on its own. Without it the key is machine-derived and the
 * paragraph at the top of this file is the honest description of what that is worth.
 */
function deriveKey(salt: Buffer, env: NodeJS.ProcessEnv = process.env): Buffer {
  const explicit = env.STAKBIT_STORE_SECRET?.trim();
  const material = explicit && explicit.length > 0 ? explicit : `${hostname()}\u0000${userInfo().username}`;
  return scryptSync(material, salt, KEY_LEN);
}

export function encryptJson(value: unknown, env: NodeJS.ProcessEnv = process.env): Buffer {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(salt, env);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, salt, iv, tag, ciphertext]);
}

export function decryptJson<T>(blob: Buffer, env: NodeJS.ProcessEnv = process.env): T {
  const header = MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN;
  if (blob.length < header) throw new CredentialError("credential file is truncated");
  if (!timingSafeEqual(blob.subarray(0, MAGIC.length), MAGIC)) {
    throw new CredentialError("credential file has an unknown format (bad magic)");
  }
  const salt = blob.subarray(MAGIC.length, MAGIC.length + SALT_LEN);
  const iv = blob.subarray(MAGIC.length + SALT_LEN, MAGIC.length + SALT_LEN + IV_LEN);
  const tag = blob.subarray(
    MAGIC.length + SALT_LEN + IV_LEN,
    MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN,
  );
  const ciphertext = blob.subarray(header);

  try {
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(salt, env), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8")) as T;
  } catch (cause) {
    // A wrong key and a tampered file are the same failure to GCM, and both mean the same thing to
    // the user: this store cannot be opened. Saying "wrong key" would be a guess.
    throw new CredentialError(
      "cannot open credential file — it was written by another machine or user, or it is corrupt. " +
        "Run `stakbit login` again.",
      { cause },
    );
  }
}

export function writeSecret(path: string, value: unknown, env: NodeJS.ProcessEnv = process.env): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const blob = encryptJson(value, env);
  writeFileSync(path, blob, { mode: 0o600 });
  // `mode` on write only applies when the file is created; an existing file keeps its old bits.
  chmodSync(path, 0o600);
}

export function readSecret<T>(path: string, env: NodeJS.ProcessEnv = process.env): T | null {
  if (!existsSync(path)) return null;
  const blob = readFileSync(path);
  return decryptJson<T>(blob, env);
}

export function removeSecret(path: string): boolean {
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}
