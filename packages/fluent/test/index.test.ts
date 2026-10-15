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
        "FluentDocsUnavailableError",
        "FluentLoginError",
        "FluentSdkMissingError",
        "FluentTlsUnavailableError",
        "RecordXmlError",
        "GLOBAL_DISPATCHER",
        "SESSION_ONLY_ENDPOINTS",
        "cdataSection",
        "cookieHeader",
        "DEFAULT_PROJECT_VERSION",
        "SUPPORTED_SDK_RANGE",
        "createFluentAuthResolver",
        "createFluentEngine",
        "createTlsDispatcher",
        "defaultSdkDocsLoader",
        "defaultSdkLoader",
        "escapeXmlAttribute",
        "escapeXmlText",
        "explainDocs",
        "findPackageVersion",
        "isSupportedSdkVersion",
        "loginUiSession",
        "mergeSetCookies",
        "serializeDeleteMultiple",
        "serializeRecordUpdate",
        "splitDiagnostics",
        "FluentNativeError",
        "INVENTORY_FILE",
        "ZipError",
        "crc32",
        "createZip",
        "defaultPackagePath",
        "nativePack",
        "packEntries",
        "packageInventory",
        "readNativeProject",
        "snakeCase",
        "InstanceSession",
        "applySetCookies",
        "flowIds",
        "nativeInstall",
        "nativeInstallStatus",
        "compileFluentProject",
        "defaultTypeScriptLoader",
        "FluentCompileError",
        "FluentTypeScriptMissingError",
        "SUPPORTED_FLUENT_APIS",
      ].sort(),
    );
  });

  it("exposes the native compiler", () => {
    expect(typeof fluent.compileFluentProject).toBe("function");
    expect(typeof fluent.defaultTypeScriptLoader).toBe("function");
    expect(new fluent.FluentCompileError("x", { file: "f", line: 1, column: 1 })).toBeInstanceOf(Error);
    expect(new fluent.FluentTypeScriptMissingError().code).toBe("FLUENT_TYPESCRIPT_MISSING");
    expect(fluent.SUPPORTED_FLUENT_APIS).toEqual(["Property", "Role", "ScriptInclude"]);
  });
});
