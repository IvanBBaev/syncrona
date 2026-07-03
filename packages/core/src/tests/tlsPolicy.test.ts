// SPDX-License-Identifier: GPL-3.0-or-later
import fs from "fs";
import os from "os";
import path from "path";
import {
  CA_BUNDLE_ENV,
  TLS_REJECT_UNAUTHORIZED_ENV,
  resolveTlsPolicy,
} from "@syncro-now-ai/sn-transport";
import { buildHttpsAgent } from "../snClient.js";

// G9: corporate proxy / TLS support. resolveTlsPolicy is the shared, pure
// decision; buildHttpsAgent is the core-side glue that reads the env + CA file
// and constructs the https.Agent. Both are covered here.

describe("resolveTlsPolicy (shared, pure)", () => {
  it("defaults to verification on and no custom agent", () => {
    expect(resolveTlsPolicy(undefined, undefined)).toEqual({
      caBundlePath: undefined,
      rejectUnauthorized: true,
      custom: false,
    });
  });

  it("treats blank/whitespace env values as unset", () => {
    expect(resolveTlsPolicy("   ", "  ")).toEqual({
      caBundlePath: undefined,
      rejectUnauthorized: true,
      custom: false,
    });
  });

  it("marks a CA bundle path as a custom policy, keeping verification on", () => {
    const policy = resolveTlsPolicy("/etc/ssl/corp-ca.pem", undefined);
    expect(policy.caBundlePath).toBe("/etc/ssl/corp-ca.pem");
    expect(policy.rejectUnauthorized).toBe(true);
    expect(policy.custom).toBe(true);
  });

  it.each(["0", "false", "no", "FALSE", " No "])(
    "disables verification on the explicit opt-out token %p",
    (token) => {
      const policy = resolveTlsPolicy(undefined, token);
      expect(policy.rejectUnauthorized).toBe(false);
      expect(policy.custom).toBe(true);
    }
  );

  it.each(["1", "true", "yes", "", "anything"])(
    "keeps verification on for non-falsey value %p",
    (token) => {
      expect(resolveTlsPolicy(undefined, token).rejectUnauthorized).toBe(true);
    }
  );
});

describe("buildHttpsAgent (core glue)", () => {
  const ENV_KEYS = [CA_BUNDLE_ENV, TLS_REJECT_UNAUTHORIZED_ENV];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("returns undefined when no TLS override is configured", () => {
    expect(buildHttpsAgent()).toBeUndefined();
  });

  it("builds an agent with rejectUnauthorized=false on opt-out", () => {
    process.env[TLS_REJECT_UNAUTHORIZED_ENV] = "0";
    const agent = buildHttpsAgent();
    expect(agent).toBeDefined();
    expect(agent?.options.rejectUnauthorized).toBe(false);
  });

  it("loads the CA bundle file into the agent", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synctls-"));
    const caPath = path.join(dir, "ca.pem");
    fs.writeFileSync(caPath, "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n");
    process.env[CA_BUNDLE_ENV] = caPath;

    const agent = buildHttpsAgent();
    expect(agent).toBeDefined();
    expect(Buffer.isBuffer(agent?.options.ca)).toBe(true);
    expect(agent?.options.rejectUnauthorized).toBe(true);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("still returns an agent when the CA bundle path is unreadable", () => {
    process.env[CA_BUNDLE_ENV] = path.join(os.tmpdir(), "does-not-exist-12345.pem");
    const agent = buildHttpsAgent();
    expect(agent).toBeDefined();
    expect(agent?.options.ca).toBeUndefined();
  });
});
