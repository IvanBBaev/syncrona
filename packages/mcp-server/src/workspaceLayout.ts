// SPDX-License-Identifier: GPL-3.0-or-later
//
// DX17: the workspace's on-disk layout for a record's field files.
//
// The core CLI writes a record either as a FOLDER of field files (the default)
// or, when `flat: true` is set in sync.config.js, as one file per field with the
// record name folded into the file name:
//
//   record-folder  <sourceDirectory>/<table>/<record>/<field>.<ext>
//   flat           <sourceDirectory>/<table>/<record>~<field>.<ext>
//
// SOURCE OF TRUTH: `packages/core/src/flatLayout.ts` (the separator and the
// encoding) and `packages/core/src/config.ts` (the `flat` flag and its
// `=== true` strictness). This module deliberately does NOT import them: the
// `consumers-are-siblings` rule in `.dependency-cruiser.cjs` forbids an edge from
// `mcp-server` to the core CLI, so the two rules that matter — the separator
// character and "record is everything before the LAST separator" — are
// replicated here, minimally and read-only, and must be kept in lockstep with
// core. Anything richer (the reverse mapping, the "is this flat-encoded" probe,
// the mixed-list guards) belongs in core, not here; the server only ever needs
// to BUILD the path of a field file it already knows the coordinates of.
//
// Why this is one seam rather than a `flat` check at each call site: both
// production readers of a record's local files — `sync_diff_instance_vs_local`
// (handlers/developerToolHandlers.ts) and `createAndSyncScriptInclude`
// (toolService.ts) — fail SILENTLY when they guess the layout wrong. The first
// probes with existsSync and reports a clean file as a diff; the second hands the
// agent a path that does not exist. Neither raises, so a second copy of the rule
// that drifts would not be caught by anything but a user.

import { existsSync } from "fs";
import path from "path";

/** Mirrors `FLAT_FIELD_SEPARATOR` in packages/core/src/flatLayout.ts. */
export const FLAT_FIELD_SEPARATOR = "~";

const DEFAULT_SOURCE_DIRECTORY = "src";

export type WorkspaceLayout = {
  /** Project-relative root of the synced files; `src` unless configured. */
  sourceDirectory: string;
  /** True only for `flat: true` — core reads this flag strictly (`=== true`). */
  flat: boolean;
};

/** The layout assumed when sync.config.js is absent, unreadable, or malformed. */
export function defaultWorkspaceLayout(): WorkspaceLayout {
  return { sourceDirectory: DEFAULT_SOURCE_DIRECTORY, flat: false };
}

/**
 * Read the layout a project's `sync.config.js` declares.
 *
 * Every failure mode degrades to the default layout rather than throwing: a user
 * config that blows up must not take the MCP server down with it, and the server
 * only ever READS through this, so the worst case is the same "file not found"
 * the caller already handles.
 */
export function readWorkspaceLayout(projectDir: string): WorkspaceLayout {
  const configPath = path.join(projectDir, "sync.config.js");
  if (!existsSync(configPath)) {
    return defaultWorkspaceLayout();
  }

  try {
    // sync.config.js is user-authored CJS; require is the only loader for it here.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const loaded = require(configPath);
    const cfg = loaded?.default || loaded;
    if (!cfg || typeof cfg !== "object") {
      return defaultWorkspaceLayout();
    }
    const sourceDirectory =
      typeof cfg.sourceDirectory === "string" && cfg.sourceDirectory.trim().length > 0
        ? cfg.sourceDirectory
        : DEFAULT_SOURCE_DIRECTORY;
    return { sourceDirectory, flat: cfg.flat === true };
  } catch (_) {
    return defaultWorkspaceLayout();
  }
}

/**
 * Absolute path of one field file of one record, in the workspace's layout.
 *
 * The flat form is produced by the same join core's `folderRelToFlat` performs —
 * `<record><SEP><field><ext>` — so a record name that itself contains a `~` still
 * round-trips: core's `flatRelToFolder` splits on the LAST separator in the stem.
 */
export function recordFieldFilePath(
  projectDir: string,
  layout: WorkspaceLayout,
  table: string,
  recordName: string,
  fieldName: string,
  fieldType: string
): string {
  const fileName = `${fieldName}.${fieldType}`;
  const tableDir = path.join(projectDir, layout.sourceDirectory, table);
  return layout.flat
    ? path.join(tableDir, `${recordName}${FLAT_FIELD_SEPARATOR}${fileName}`)
    : path.join(tableDir, recordName, fileName);
}
