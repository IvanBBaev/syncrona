// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import {
  saveJiraCredentials,
  loadJiraCredentials,
  loadJiraCredentialsSync,
  listJiraProfiles,
  removeJiraCredentials,
  removeAllJiraCredentials,
  jiraProfileToFilename,
  filenameToJiraProfile,
  type StoredJiraCredentials,
} from "../src/index";

// As in credentialStoreIO.test.ts: the store resolves its dir from os.homedir()
// (which ignores $HOME on macOS), so mock it to a temp dir and pin the key.
let tmpHome: string;
let homedirSpy: jest.SpyInstance;

beforeAll(() => {
  process.env.SYNCRONA_STORE_KEY = "b".repeat(64); // 32-byte hex key
});

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(os.tmpdir(), "sync-jira-"));
  homedirSpy = jest.spyOn(os, "homedir").mockReturnValue(tmpHome);
});

afterEach(() => {
  homedirSpy.mockRestore();
  rmSync(tmpHome, { recursive: true, force: true });
});

const CLOUD: StoredJiraCredentials = {
  profile: "default",
  baseUrl: "https://acme.atlassian.net",
  deployment: "cloud",
  email: "me@acme.com",
  token: "cloud-token",
};

const SERVER: StoredJiraCredentials = {
  profile: "work",
  baseUrl: "https://jira.acme.com",
  deployment: "server",
  token: "  pat-with-space  ",
};

describe("jira credential store", () => {
  it("round-trips Cloud credentials including the email", async () => {
    await saveJiraCredentials(CLOUD);
    expect(await loadJiraCredentials("default")).toEqual(CLOUD);
  });

  it("round-trips Server credentials and preserves token whitespace", async () => {
    await saveJiraCredentials(SERVER);
    const loaded = await loadJiraCredentials("work");
    expect(loaded).toEqual({
      profile: "work",
      baseUrl: "https://jira.acme.com",
      deployment: "server",
      token: "  pat-with-space  ",
    });
    expect(loaded?.email).toBeUndefined();
  });

  it("returns null for an unknown profile", async () => {
    expect(await loadJiraCredentials("ghost")).toBeNull();
  });

  it("defaults the profile to \"default\" when omitted", async () => {
    await saveJiraCredentials({ ...CLOUD, profile: "" });
    expect(await loadJiraCredentials()).toMatchObject({ profile: "default" });
  });

  it("lists, removes one, and removes all profiles", async () => {
    expect(await listJiraProfiles()).toEqual([]);
    await saveJiraCredentials(CLOUD);
    await saveJiraCredentials(SERVER);
    expect((await listJiraProfiles()).sort()).toEqual(["default", "work"]);

    expect(await removeJiraCredentials("work")).toBe(true);
    expect(await listJiraProfiles()).toEqual(["default"]);

    await saveJiraCredentials(SERVER);
    expect(await removeAllJiraCredentials()).toBe(2);
    expect(await listJiraProfiles()).toEqual([]);
  });

  it("removing an unknown profile reports nothing removed", async () => {
    await expect(removeJiraCredentials("nope")).resolves.toBe(false);
  });

  it("sync read mirrors the async read and is null for missing/unknown", async () => {
    await saveJiraCredentials(CLOUD);
    expect(loadJiraCredentialsSync("default")).toEqual(CLOUD);
    expect(loadJiraCredentialsSync("missing")).toBeNull();
  });

  it("encodes the profile filename reversibly and without collisions", () => {
    // Reversible: "/" → %2F, space → %20; round-trips back to the original name.
    expect(jiraProfileToFilename("weird/pro file")).toBe("weird%2Fpro%20file.enc");
    expect(filenameToJiraProfile("weird%2Fpro%20file.enc")).toBe("weird/pro file");
    expect(filenameToJiraProfile("default.enc")).toBe("default");

    // Distinct names that a naive `_`-substitution would collide now stay distinct.
    const names = ["work a", "work/a", "work_a"];
    const files = names.map(jiraProfileToFilename);
    expect(new Set(files).size).toBe(names.length);
    for (const name of names) {
      expect(filenameToJiraProfile(jiraProfileToFilename(name))).toBe(name);
    }
  });

  it("persists distinct credentials for collision-prone profile names", async () => {
    await saveJiraCredentials({ ...CLOUD, profile: "work/a" });
    await saveJiraCredentials({ ...SERVER, profile: "work_a" });
    expect((await listJiraProfiles()).sort()).toEqual(["work/a", "work_a"]);
    expect((await loadJiraCredentials("work/a"))?.deployment).toBe("cloud");
    expect((await loadJiraCredentials("work_a"))?.deployment).toBe("server");
  });
});
