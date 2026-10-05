// SPDX-License-Identifier: GPL-3.0-or-later
import * as fluent from "../src/index";
import type { SN } from "@syncrona/types";

describe("@syncrona/fluent public surface", () => {
  it("exposes the SN.FluentModule port core imports", () => {
    const port: SN.FluentModule = fluent;
    expect(typeof port.createFluentEngine).toBe("function");
    expect(typeof port.createFluentAuthResolver).toBe("function");
  });

  it("exposes the supporting helpers", () => {
    expect(Object.keys(fluent).sort()).toEqual(
      [
        "FluentLoginError",
        "FluentSdkMissingError",
        "SESSION_ONLY_ENDPOINTS",
        "cookieHeader",
        "createFluentAuthResolver",
        "createFluentEngine",
        "defaultSdkLoader",
        "findPackageVersion",
        "loginUiSession",
        "mergeSetCookies",
        "splitDiagnostics",
      ].sort(),
    );
  });
});
