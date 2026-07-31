// SPDX-License-Identifier: GPL-3.0-or-later
// REV-208 — `readPemMaterial` treats any value without PEM armor as a filesystem
// path and hands it straight to readFileSync. Node embeds the path argument in the
// error message verbatim, so a JWT signing key supplied in a form that carries no
// armor (base64 of a PEM — the usual way to fit a key into a single environment
// variable or CI secret) is reproduced in full inside the thrown message, and from
// there into every log line, audit event and error response built from it.
//
// The tests assert the negative property that matters: no substantial slice of the
// key may appear anywhere on the thrown error. They also pin the positive half —
// the error must stay diagnosable (fs code + how the value was interpreted), and
// an armored key must still never touch the filesystem.
import { generateKeyPairSync } from "node:crypto";
import { buildClientAuth, type SNCredentials } from "../snClient.js";

const baseCredentials: SNCredentials = {
  user: "admin",
  password: "secret",
  instance: "dev00000.service-now.com",
  clientId: "cid",
  clientSecret: "csecret",
  authMethod: "oauth-jwt-bearer",
};

function makePrivateKeyPem(): string {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return privateKey as string;
}

// `instanceof Error` is unreliable here: an fs SystemError originates in Node's
// realm while the test runs in Jest's, so identity is checked structurally.
function isError(value: unknown): boolean {
  return typeof (value as Error | undefined)?.message === "string";
}

// Everything a downstream sink can plausibly stringify off a thrown error: the
// message, the stack (which embeds the message), the `path`/`dest` properties
// Node attaches to an fs error, and one level of `cause`. A fix that only cleans
// up the message while re-attaching the original error as `cause` has not fixed
// anything, so the assertion covers all of it.
function errorSurface(error: unknown): string {
  const e = error as Error & { path?: unknown; dest?: unknown; cause?: unknown };
  const cause = e.cause as (Error & { path?: unknown }) | undefined;
  return [
    e.message,
    e.stack,
    String(e.path ?? ""),
    String(e.dest ?? ""),
    cause?.message,
    String(cause?.path ?? ""),
  ]
    .filter((part): part is string => typeof part === "string")
    .join("\n");
}

describe("REV-208: a non-armored JWT signing key never reaches an error message", () => {
  it("does not reproduce a base64-encoded private key in the thrown error", () => {
    const base64Key = Buffer.from(makePrivateKeyPem()).toString("base64");
    // Precondition: this is exactly the value class the armor short-circuit misses.
    expect(base64Key.includes("-----BEGIN")).toBe(false);

    let caught: unknown;
    try {
      buildClientAuth({ ...baseCredentials, jwtKey: base64Key });
    } catch (e) {
      caught = e;
    }

    expect(isError(caught)).toBe(true);
    const surface = errorSurface(caught);
    // A 64-character slice is far past coincidence and is enough to reconstruct
    // nothing on its own, so the assertion can be made without echoing the key.
    expect(surface).not.toContain(base64Key.slice(0, 64));
    expect(surface).not.toContain(base64Key.slice(-64));
  });

  it("does not reproduce a raw DER/base64 key body short enough to look like a path", () => {
    // A P-256 key is ~250 base64 characters — under every filename limit, so the
    // fs error is ENOENT rather than ENAMETOOLONG. Length must not be what saves us.
    const { privateKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "der" },
    });
    const base64Key = (privateKey as Buffer).toString("base64");

    let caught: unknown;
    try {
      buildClientAuth({ ...baseCredentials, jwtKey: base64Key });
    } catch (e) {
      caught = e;
    }

    expect(isError(caught)).toBe(true);
    expect(errorSurface(caught)).not.toContain(base64Key.slice(0, 32));
  });

  it("stays diagnosable: names the setting, the fs code and the value's size", () => {
    let message = "";
    try {
      buildClientAuth({ ...baseCredentials, jwtKey: "/nonexistent/jwt-signing-key.pem" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/JWT/i);
    expect(message).toMatch(/ENOENT/);
    expect(message).toMatch(/32 bytes/);
  });

  it("still accepts an inline armored key without touching the filesystem", () => {
    const auth = buildClientAuth({ ...baseCredentials, jwtKey: makePrivateKeyPem() });
    expect(auth.oauth?.grantType).toBe("jwt-bearer");
  });
});
