// SPDX-License-Identifier: GPL-3.0-or-later
//
// Pure helpers for the platform's "Scripts - Background" page (sys.scripts.do).
// The page is a UI processor present on every instance: a GET renders the form
// with the session's CSRF token (`sysparm_ck`), a POST of that form runs the
// script and answers a small HTML document with the gs.print/gs.info output in
// a <PRE> block. Everything here only reads those documents; the transport lives
// in servicenowCore.ts.

/** Path of the background-script page, relative to the instance root. */
export const SCRIPTS_BACKGROUND_PATH = "sys.scripts.do";

/** Marker the page prints before the output of a script that was evaluated. */
const COMPLETION_MARKER = /Script completed in scope ([^:<]+):/;

/** First line of the output when the platform could not compile or run the script. */
const SCRIPT_ERROR_PREFIX = /^(Script compilation error|Script execution error):/m;

export interface ScriptsBackgroundResult {
  /** The script output as plain text, one printed line per line. */
  output: string;
  /** The scope the platform evaluated the script in (for example "global"). */
  scope: string;
  /** sys_id of the sys_script_execution_history row, when the page linked one. */
  executionHistoryId: string;
  /** The platform's compilation or execution error line, when the script failed. */
  error?: string;
}

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
};

export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower in HTML_ENTITIES) {
      return HTML_ENTITIES[lower];
    }
    if (lower.startsWith("#x")) {
      const code = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (lower.startsWith("#")) {
      const code = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return whole;
  });
}

/**
 * Reads the CSRF token from the rendered form. The form carries it as a hidden
 * `sysparm_ck` input; the attribute order differs between releases, so the input
 * element is located first and its value read separately.
 */
export function extractCsrfToken(html: string): string | null {
  const inputs = html.match(/<input\b[^>]*>/gi) || [];
  for (const input of inputs) {
    if (!/\bname\s*=\s*["']sysparm_ck["']/i.test(input)) {
      continue;
    }
    const value = input.match(/\bvalue\s*=\s*["']([^"']*)["']/i);
    if (value && value[1].length > 0) {
      return value[1];
    }
  }
  const scriptVar = html.match(/\bg_ck\s*=\s*['"]([^'"]+)['"]/);
  return scriptVar ? scriptVar[1] : null;
}

/**
 * Parses the page's answer to a script POST. Returns null when the document is
 * not a script result (a login page, a "not authorized" CSRF rejection, an
 * empty body), so the caller can report that the script did not run.
 */
export function parseScriptsBackgroundResponse(html: string): ScriptsBackgroundResult | null {
  const completed = html.match(COMPLETION_MARKER);
  if (!completed) {
    return null;
  }
  const history = html.match(/sys_script_execution_history\.do\?sys_id=([0-9a-f]{32})/i);
  const pre = html.match(/<pre>([\s\S]*?)<\/pre>/i);
  const output = pre
    ? decodeHtmlEntities(pre[1].replace(/<br\s*\/?>/gi, "\n")).replace(/\n+$/, "")
    : "";
  const result: ScriptsBackgroundResult = {
    output,
    scope: completed[1].trim(),
    executionHistoryId: history ? history[1] : "",
  };
  const failure = output.match(SCRIPT_ERROR_PREFIX);
  if (failure) {
    const lineEnd = output.indexOf("\n", failure.index);
    result.error = output.slice(failure.index, lineEnd >= 0 ? lineEnd : undefined);
  }
  return result;
}
