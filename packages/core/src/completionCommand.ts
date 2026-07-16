// SPDX-License-Identifier: GPL-3.0-or-later
import type { CliCommandModule } from "./cliCommands.js";

// Hand-rolled completion instead of yargs' built-in `.completion()`: the
// built-in script shells back into the CLI on every TAB press
// (`--get-yargs-completions`), which costs a full Node boot per keystroke and
// would need extra wiring in commander.ts outside the CLI_COMMANDS registry.
// A static script generated from the live registry is instant, and deriving
// the words at runtime means the completion surface can never drift from the
// commands that actually exist.

/** Shells the `completion` command can emit a script for. */
export const COMPLETION_SHELLS = ["bash", "zsh"] as const;
export type CompletionShell = (typeof COMPLETION_SHELLS)[number];

/**
 * Every completable first word: primary command names AND aliases, with
 * positional placeholders stripped ("download <scope>" -> "download"),
 * deduplicated and sorted.
 */
export function completionWords(
  commands: ReadonlyArray<CliCommandModule>
): string[] {
  const words = commands
    .flatMap((mod) => (Array.isArray(mod.command) ? mod.command : [mod.command]))
    .map((spec) => spec.trim().split(/\s+/)[0])
    .filter((name) => name.length > 0);
  return [...new Set(words)].sort();
}

// zsh `_describe` entries are single-quoted 'name:description' pairs: a raw
// single quote would terminate the entry and a raw colon would be read as the
// name/description separator, so both are escaped.
function zshEscapeDescription(text: string): string {
  return text.replace(/'/g, "'\\''").replace(/:/g, "\\:");
}

// One 'name:description' entry per completable word (aliases reuse their
// module's description), sorted for stable output.
function zshCommandEntries(
  commands: ReadonlyArray<CliCommandModule>
): string[] {
  const entries = new Map<string, string>();
  for (const mod of commands) {
    const specs = Array.isArray(mod.command) ? mod.command : [mod.command];
    for (const spec of specs) {
      const name = spec.trim().split(/\s+/)[0];
      if (name.length > 0 && !entries.has(name)) {
        entries.set(name, mod.describe);
      }
    }
  }
  return [...entries.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, describe]) => `    '${name}:${zshEscapeDescription(describe)}'`);
}

export function renderBashCompletionScript(
  commands: ReadonlyArray<CliCommandModule>
): string {
  const words = completionWords(commands).join(" ");
  return [
    "###-begin-syncrona-completions-###",
    "#",
    "# syncrona bash completion script",
    "#",
    "# Installation: syncrona completion bash >> ~/.bashrc",
    "#",
    "_syncrona_completions() {",
    '  local cur="${COMP_WORDS[COMP_CWORD]}"',
    `  local commands="${words}"`,
    '  if [ "${COMP_CWORD}" -eq 1 ]; then',
    '    COMPREPLY=( $(compgen -W "${commands}" -- "${cur}") )',
    "  fi",
    "  return 0",
    "}",
    "complete -o bashdefault -o default -F _syncrona_completions syncrona",
    "###-end-syncrona-completions-###",
  ].join("\n");
}

export function renderZshCompletionScript(
  commands: ReadonlyArray<CliCommandModule>
): string {
  return [
    "#compdef syncrona",
    "###-begin-syncrona-completions-###",
    "#",
    "# syncrona zsh completion script",
    "#",
    "# Installation: syncrona completion zsh >> ~/.zshrc",
    "#",
    "_syncrona_completions() {",
    "  local -a commands",
    "  commands=(",
    ...zshCommandEntries(commands),
    "  )",
    "  if (( CURRENT == 2 )); then",
    "    _describe -t commands 'syncrona command' commands",
    "  fi",
    "  return 0",
    "}",
    "compdef _syncrona_completions syncrona",
    "###-end-syncrona-completions-###",
  ].join("\n");
}

// $SHELL holds the user's login shell path (e.g. /usr/bin/zsh). Only the last
// path segment decides; anything not recognizably zsh falls back to bash, the
// lowest-common-denominator script.
export function detectShell(shellPath: string | undefined): CompletionShell {
  const name = (shellPath ?? "").split(/[/\\]/).pop() ?? "";
  return name.toLowerCase().includes("zsh") ? "zsh" : "bash";
}

/**
 * Print a shell completion script for the requested (or auto-detected) shell.
 *
 * The registry is passed in by the caller (cliCommands.ts) rather than
 * imported here, which keeps the module graph acyclic and the renderers pure.
 * The script goes to stdout RAW (process.stdout.write, not the logger): the
 * output is meant to be appended to an rc file, and logger prefixes or colors
 * would corrupt it.
 */
export function completionCommand(
  args: { shell?: string },
  commands: ReadonlyArray<CliCommandModule>
): void {
  const shell: CompletionShell =
    args.shell === "bash" || args.shell === "zsh"
      ? args.shell
      : detectShell(process.env.SHELL);
  const script =
    shell === "zsh"
      ? renderZshCompletionScript(commands)
      : renderBashCompletionScript(commands);
  process.stdout.write(`${script}\n`);
}
