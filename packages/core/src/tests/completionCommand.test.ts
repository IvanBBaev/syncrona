// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import { CLI_COMMANDS, type CliCommandModule } from "../cliCommands.js";
export {};

// completionCommand has no runtime module dependencies to mock (the registry
// is passed in as an argument and the script is written straight to stdout),
// so unlike sibling suites no jest.unstable_mockModule() setup is required.
// The SUT is still imported dynamically in beforeEach for consistency with the
// ESM test pattern used across this package.
let completionCommand: typeof import("../completionCommand.js").completionCommand;
let completionWords: typeof import("../completionCommand.js").completionWords;
let detectShell: typeof import("../completionCommand.js").detectShell;
let renderBashCompletionScript: typeof import("../completionCommand.js").renderBashCompletionScript;
let renderZshCompletionScript: typeof import("../completionCommand.js").renderZshCompletionScript;

// Same primary-name derivation the e2e smoke test uses: first token of the
// command string (or the first array element), positional placeholder stripped.
const primaryName = (command: string | string[]): string =>
  (Array.isArray(command) ? command[0] : command).trim().split(/\s+/)[0];

describe("completionCommand", () => {
  const prevShell = process.env.SHELL;
  let captured: string;
  let stdoutSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(async () => {
    jest.clearAllMocks();
    ({
      completionCommand,
      completionWords,
      detectShell,
      renderBashCompletionScript,
      renderZshCompletionScript,
    } = await import("../completionCommand.js"));
    captured = "";
    stdoutSpy = jest
      .spyOn(process.stdout, "write")
      .mockImplementation(((chunk: unknown) => {
        captured += String(chunk);
        return true;
      }) as never);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    if (prevShell === undefined) {
      delete process.env.SHELL;
    } else {
      process.env.SHELL = prevShell;
    }
  });

  describe("completionWords", () => {
    it("derives every primary command name and alias from the live registry", () => {
      const words = completionWords(CLI_COMMANDS);
      for (const mod of CLI_COMMANDS) {
        expect(words).toContain(primaryName(mod.command));
      }
      // Aliases are completable invocations too (["dev", "d"], ["refresh", "r"]).
      expect(words).toEqual(expect.arrayContaining(["d", "r"]));
      // Positional placeholders are stripped, never completed.
      expect(words.join(" ")).not.toContain("<");
      expect(words.join(" ")).not.toContain("[");
      // Deduplicated and sorted for stable script output.
      expect(words).toEqual([...new Set(words)].sort());
    });
  });

  describe("renderBashCompletionScript", () => {
    it("emits a bash script whose word list is the full registry surface", () => {
      const script = renderBashCompletionScript(CLI_COMMANDS);
      expect(script).toContain(completionWords(CLI_COMMANDS).join(" "));
      expect(script).toContain("compgen -W");
      expect(script).toContain(
        "complete -o bashdefault -o default -F _syncrona_completions syncrona"
      );
      // No zsh constructs leak into the bash script.
      expect(script).not.toContain("#compdef");
      expect(script).not.toContain("_describe");
    });
  });

  describe("renderZshCompletionScript", () => {
    it("emits a zsh script with a described entry per command", () => {
      const script = renderZshCompletionScript(CLI_COMMANDS);
      expect(script).toContain("#compdef syncrona");
      expect(script).toContain("_describe -t commands 'syncrona command' commands");
      expect(script).toContain("compdef _syncrona_completions syncrona");
      for (const mod of CLI_COMMANDS) {
        expect(script).toContain(`'${primaryName(mod.command)}:`);
      }
      // No bash constructs leak into the zsh script.
      expect(script).not.toContain("compgen");
      expect(script).not.toBe(renderBashCompletionScript(CLI_COMMANDS));
    });

    it("escapes single quotes and colons inside command descriptions", () => {
      const synthetic: CliCommandModule[] = [
        {
          command: "boom",
          describe: "it's tricky: very",
          handler: () => undefined,
        },
      ];
      const script = renderZshCompletionScript(synthetic);
      expect(script).toContain("'boom:it'\\''s tricky\\: very'");
    });
  });

  describe("detectShell", () => {
    it("recognizes zsh from the last path segment of $SHELL", () => {
      expect(detectShell("/bin/zsh")).toBe("zsh");
      expect(detectShell("/usr/local/bin/zsh-5.9")).toBe("zsh");
      expect(detectShell("C:\\shells\\zsh.exe")).toBe("zsh");
    });

    it("falls back to bash for anything else, including an unset $SHELL", () => {
      expect(detectShell("/bin/bash")).toBe("bash");
      expect(detectShell("/usr/bin/fish")).toBe("bash");
      expect(detectShell(undefined)).toBe("bash");
      expect(detectShell("")).toBe("bash");
    });
  });

  describe("completionCommand handler", () => {
    it("auto-detects zsh from $SHELL when no shell argument is given", () => {
      process.env.SHELL = "/bin/zsh";
      completionCommand({}, CLI_COMMANDS);
      expect(captured).toContain("#compdef syncrona");
      expect(captured.endsWith("\n")).toBe(true);
    });

    it("falls back to a bash script when $SHELL is unset", () => {
      delete process.env.SHELL;
      completionCommand({}, CLI_COMMANDS);
      expect(captured).toContain("compgen -W");
      expect(captured).not.toContain("#compdef");
    });

    it("an explicit shell argument overrides $SHELL", () => {
      process.env.SHELL = "/bin/zsh";
      completionCommand({ shell: "bash" }, CLI_COMMANDS);
      expect(captured).toContain("compgen -W");
      expect(captured).not.toContain("#compdef");
    });
  });

  describe("registry wiring", () => {
    it("the completion registry entry emits the live command set, including itself", () => {
      const entry = CLI_COMMANDS.find(
        (mod) => primaryName(mod.command) === "completion"
      );
      expect(entry).toBeDefined();
      process.env.SHELL = "/bin/bash";
      entry?.handler({ _: [], $0: "syncrona" } as never);
      expect(captured).toContain("###-begin-syncrona-completions-###");
      // The word list covers the whole registry — completion itself included.
      expect(captured).toContain(completionWords(CLI_COMMANDS).join(" "));
    });
  });
});
