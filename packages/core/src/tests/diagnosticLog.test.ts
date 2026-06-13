import { isDiagnosticLogEnabled } from "../Logger";

export {};

// G7: opt-in diagnostic log gate (off by default for privacy).
describe("isDiagnosticLogEnabled (G7)", () => {
  const KEY = "SYNCRONA_DIAGNOSTIC_LOG";
  const original = process.env[KEY];

  afterEach(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  });

  it("is off when unset", () => {
    delete process.env[KEY];
    expect(isDiagnosticLogEnabled()).toBe(false);
  });

  it("is on for truthy values", () => {
    for (const v of ["1", "true", "yes", "on"]) {
      process.env[KEY] = v;
      expect(isDiagnosticLogEnabled()).toBe(true);
    }
  });

  it("is off for falsy/empty values", () => {
    for (const v of ["", "0", "false", "no"]) {
      process.env[KEY] = v;
      expect(isDiagnosticLogEnabled()).toBe(false);
    }
  });
});
