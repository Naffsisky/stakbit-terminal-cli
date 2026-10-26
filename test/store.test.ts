/**
 * Tests for the credential store.
 *
 * The important assertions are about failure, not success: a store written on one machine must not
 * open on another, a truncated file must not open at all, and the file must be mode 0600. A test that
 * only checked the round-trip would pass for an implementation that stored plaintext.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialError, decryptJson, encryptJson, readSecret, removeSecret, writeSecret } from "../src/auth/store.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "stakbit-test-"));
}

test("a secret round-trips", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "secret.enc");
    writeSecret(path, { refresh: "eyJhbGciOiJIUzI1NiJ9.payload.signature" });
    const read = readSecret<{ refresh: string }>(path);
    assert.equal(read?.refresh, "eyJhbGciOiJIUzI1NiJ9.payload.signature");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the stored file is not plaintext", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "secret.enc");
    const secret = "SUPER_SECRET_TOKEN_VALUE";
    writeSecret(path, { refresh: secret });
    const raw = readFileSync(path);
    assert.equal(raw.includes(Buffer.from(secret)), false, "the token appears verbatim in the file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the stored file is mode 0600", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "secret.enc");
    writeSecret(path, { refresh: "x" });
    const mode = statSync(path).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an existing file is chmodded on rewrite, not left with its old bits", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "secret.enc");
    writeSecret(path, { a: 1 });
    // Simulate a file that was created with loose permissions by another tool.
    chmodSync(path, 0o644);
    writeSecret(path, { a: 2 });
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a different store secret cannot open the file", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "secret.enc");
    writeSecret(path, { refresh: "abc" }, { STAKBIT_STORE_SECRET: "one" } as NodeJS.ProcessEnv);
    assert.throws(
      () => readSecret(path, { STAKBIT_STORE_SECRET: "two" } as NodeJS.ProcessEnv),
      (err: unknown) => err instanceof CredentialError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a truncated file is refused rather than misparsed", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "secret.enc");
    writeSecret(path, { refresh: "abc" });
    const full = readFileSync(path);
    const truncated = full.subarray(0, full.length - 5);
    assert.throws(() => decryptJson(truncated), (err: unknown) => err instanceof CredentialError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an edited ciphertext fails the auth tag instead of decrypting to garbage", () => {
  const dir = tempDir();
  try {
    const blob = encryptJson({ refresh: "abc" });
    // Flip one bit in the ciphertext (last byte).
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] ^= 0x01;
    assert.throws(() => decryptJson(tampered), (err: unknown) => err instanceof CredentialError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file with an unknown magic is refused with a format error", () => {
  const bogus = Buffer.concat([Buffer.from("NOPE"), Buffer.alloc(60)]);
  assert.throws(
    () => decryptJson(bogus),
    (err: unknown) => err instanceof CredentialError && /unknown format/.test(err.message),
  );
});

test("readSecret returns null for a file that is not there", () => {
  assert.equal(readSecret("/nonexistent/path/to/secret.enc"), null);
});

test("removeSecret reports whether it actually removed something", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "secret.enc");
    writeSecret(path, { a: 1 });
    assert.equal(removeSecret(path), true);
    assert.equal(removeSecret(path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("each write uses a fresh salt and IV, so identical payloads differ on disk", () => {
  const dir = tempDir();
  try {
    const a = join(dir, "a.enc");
    const b = join(dir, "b.enc");
    writeSecret(a, { refresh: "same" });
    writeSecret(b, { refresh: "same" });
    assert.notEqual(readFileSync(a).equals(readFileSync(b)), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
