// SPDX-License-Identifier: GPL-3.0-or-later
import * as ConfigManager from "../config";
import { init } from "../bootstrap";

// init() runs under jest (JEST_WORKER_ID set), so it returns right after
// loading config + dotenv, before the network/notifier/commander steps. That
// lets us cover the two reachable branches: a broken config (hard error ->
// exitCode 1) and a clean load (resolves, early return).
describe("bootstrap init", () => {
  const prevExit = process.exitCode;

  afterEach(() => {
    jest.restoreAllMocks();
    process.exitCode = prevExit;
  });

  it("logs the message and sets exitCode=1 when config loading fails", async () => {
    jest
      .spyOn(ConfigManager, "loadConfigs")
      .mockRejectedValue(new Error("broken sync.config.js"));
    const errSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    process.exitCode = 0;
    await init();

    expect(errSpy).toHaveBeenCalledWith("broken sync.config.js");
    expect(process.exitCode).toBe(1);
  });

  it("stringifies a non-Error config failure before logging it", async () => {
    jest
      .spyOn(ConfigManager, "loadConfigs")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockRejectedValue("plain string failure" as any);
    const errSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    process.exitCode = 0;
    await init();

    expect(errSpy).toHaveBeenCalledWith("plain string failure");
    expect(process.exitCode).toBe(1);
  });

  it("loads config + dotenv and returns early under jest", async () => {
    jest
      .spyOn(ConfigManager, "loadConfigs")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockResolvedValue(undefined as any);
    jest.spyOn(ConfigManager, "getEnvPath").mockReturnValue("/tmp/does-not-exist.env");

    process.exitCode = 0;
    await expect(init()).resolves.toBeUndefined();
    expect(process.exitCode).toBe(0);
  });
});
