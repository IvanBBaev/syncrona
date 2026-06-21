import { getProgTick } from "../appUtils";

// QA regression lock for DEV-3: the DX24 progress ETA used a custom token
// (`:etaHuman`) that prefix-collided with the `progress` lib's built-in `:eta`,
// rendering "~0.0Human left" instead of the ETA. Render against a faked TTY and
// assert the token is actually substituted.
function fakeTtyStream() {
  let buf = "";
  const stream = {
    isTTY: true,
    columns: 120,
    write: (s: string) => {
      buf += s;
      return true;
    },
    clearLine: () => {},
    cursorTo: () => {},
  } as unknown as NodeJS.WritableStream;
  return { stream, read: () => buf };
}

describe("getProgTick (DX24)", () => {
  it("is a no-op (undefined) at non-info log levels", () => {
    expect(getProgTick("warn", 10)).toBeUndefined();
    expect(getProgTick("debug", 10)).toBeUndefined();
  });

  it("substitutes the ETA token without the built-in :eta collision (DEV-3)", () => {
    const { stream, read } = fakeTtyStream();
    const tick = getProgTick("info", 4, stream);
    expect(tick).toBeDefined();
    tick!();
    const out = read();
    // The literal token must not survive (it was substituted)...
    expect(out).not.toContain(":remaining");
    // ...and must not have collided with :eta, which left a literal "Human".
    expect(out).not.toContain("Human");
    // The ETA suffix and the count are rendered.
    expect(out).toContain("left");
    expect(out).toMatch(/1\/4/);
  });
});
