// SPDX-License-Identifier: GPL-3.0-or-later

import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { defaultTypeScriptLoader, FluentTypeScriptMissingError } from "../../src/compiler/typescript";

describe("defaultTypeScriptLoader", () => {
  const nowhere = path.join(os.tmpdir(), "no-such-project");

  it("loads typescript from the project", () => {
    expect(defaultTypeScriptLoader(__dirname, path.join(nowhere, "x.js"))).toBe(ts);
  });

  it("falls back to this package's typescript", () => {
    expect(defaultTypeScriptLoader(nowhere)).toBe(ts);
  });

  it("explains how to install typescript when neither has it", () => {
    expect(() => defaultTypeScriptLoader(nowhere, path.join(nowhere, "x.js"))).toThrow(FluentTypeScriptMissingError);
    expect(new FluentTypeScriptMissingError()).toMatchObject({ code: "FLUENT_TYPESCRIPT_MISSING", name: "FluentTypeScriptMissingError" });
  });
});
