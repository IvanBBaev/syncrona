// SPDX-License-Identifier: GPL-3.0-or-later
//
// Diagnostics of the native Fluent compiler. Positions are 1-based, like an
// editor shows them. An error fails the compile; warnings and hints do not.

export type FluentDiagnosticSeverity = "error" | "warning" | "hint";

export interface SourceLocation {
  /** Absolute path of the source file. */
  file: string;
  line: number;
  column: number;
}

export interface FluentDiagnostic extends SourceLocation {
  severity: FluentDiagnosticSeverity;
  message: string;
}

/** Thrown while evaluating or compiling one statement; the compiler records it and moves on. */
export class FluentCompileError extends Error {
  constructor(
    message: string,
    readonly location: SourceLocation,
  ) {
    super(message);
    this.name = "FluentCompileError";
  }
}

/** Collects diagnostics once each, in the order they were first reported. */
export class DiagnosticSink {
  private readonly seen = new Set<string>();
  readonly diagnostics: FluentDiagnostic[] = [];

  report(severity: FluentDiagnosticSeverity, message: string, location: SourceLocation): void {
    const key = `${severity}\0${location.file}\0${location.line}\0${location.column}\0${message}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.diagnostics.push({ severity, message, ...location });
  }

  get hasErrors(): boolean {
    return this.diagnostics.some((d) => d.severity === "error");
  }
}
