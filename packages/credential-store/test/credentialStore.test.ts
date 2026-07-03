// SPDX-License-Identifier: GPL-3.0-or-later
import { randomBytes } from "crypto";
import {
  encrypt,
  decrypt,
  instanceToFilename,
  filenameToInstance,
  getMachineKey,
} from "../src/index";

const KEY = randomBytes(32); // AES-256-GCM key

describe("encrypt / decrypt", () => {
  it("round-trips plaintext through AES-256-GCM", () => {
    const secret = "p@ssw0rd:with:colons";
    const ciphertext = encrypt(secret, KEY);
    expect(ciphertext).not.toContain(secret);
    expect(decrypt(ciphertext, KEY)).toBe(secret);
  });

  it("emits the iv:authTag:data envelope shape", () => {
    const parts = encrypt("hello", KEY).split(":");
    expect(parts).toHaveLength(3);
    parts.forEach((p) => expect(p).toMatch(/^[0-9a-f]+$/));
  });

  it("produces a different ciphertext each time (random iv)", () => {
    expect(encrypt("same", KEY)).not.toBe(encrypt("same", KEY));
  });

  it("rejects a malformed ciphertext envelope", () => {
    expect(() => decrypt("not-three-parts", KEY)).toThrow(
      /Invalid credential file format/
    );
  });

  it("fails to decrypt with the wrong key (auth tag mismatch)", () => {
    const ciphertext = encrypt("top-secret", KEY);
    expect(() => decrypt(ciphertext, randomBytes(32))).toThrow();
  });

  it("rejects a truncated GCM auth tag (forgery resistance)", () => {
    const [iv, tag, data] = encrypt("secret", KEY).split(":");
    const shortTag = tag.slice(0, 16); // 8 bytes instead of the full 16
    expect(() => decrypt(`${iv}:${shortTag}:${data}`, KEY)).toThrow(
      /Invalid credential file format/
    );
  });

  it("rejects a wrong-length IV", () => {
    const [iv, tag, data] = encrypt("secret", KEY).split(":");
    const shortIv = iv.slice(0, 30); // 15 bytes instead of 16
    expect(() => decrypt(`${shortIv}:${tag}:${data}`, KEY)).toThrow(
      /Invalid credential file format/
    );
  });

  it("rejects a non-hex IV", () => {
    const [, tag, data] = encrypt("secret", KEY).split(":");
    expect(() => decrypt(`${"z".repeat(32)}:${tag}:${data}`, KEY)).toThrow(
      /Invalid credential file format/
    );
  });

  it("rejects an odd-length ciphertext body", () => {
    const [iv, tag, data] = encrypt("secret", KEY).split(":");
    expect(() => decrypt(`${iv}:${tag}:${data}a`, KEY)).toThrow(
      /Invalid credential file format/
    );
  });
});

describe("instanceToFilename / filenameToInstance", () => {
  it("appends .enc and sanitizes unsafe characters", () => {
    expect(instanceToFilename("dev12345.service-now.com")).toBe(
      "dev12345.service-now.com.enc"
    );
    expect(instanceToFilename("weird/inst ance")).toBe("weird_inst_ance.enc");
  });

  it("strips a trailing .enc to recover the instance", () => {
    expect(filenameToInstance("dev12345.service-now.com.enc")).toBe(
      "dev12345.service-now.com"
    );
  });

  it("round-trips a safe instance name", () => {
    const inst = "dev99999.service-now.com";
    expect(filenameToInstance(instanceToFilename(inst))).toBe(inst);
  });
});

describe("getMachineKey", () => {
  it("is deterministic and 32 bytes (AES-256)", () => {
    const a = getMachineKey();
    const b = getMachineKey();
    expect(a).toHaveLength(32);
    expect(a.equals(b)).toBe(true);
  });
});
