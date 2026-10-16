// SPDX-License-Identifier: GPL-3.0-or-later

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileFluentProject, type CompileFluentResult } from "../../src/compiler/compile";
import type { RecordUpdateModel } from "../../src/compiler/record";

export const SCOPE = "x_snc_bprobe";
export const SCOPE_ID = "db22ea00d7ff49d9b5d64061202ea510";
export const IMPORT = "import { Acl, BusinessRule, ClientScript, Property, Role, ScriptInclude, UiAction } from '@servicenow/sdk/core'\n";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** A temporary project with `files` (paths relative to the project) and a now.config.json. */
export function makeProject(files: Record<string, string>, config: Record<string, unknown> | string = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fluent-compiler-"));
  dirs.push(dir);
  const configText = typeof config === "string" ? config : JSON.stringify({ scope: SCOPE, scopeId: SCOPE_ID, ...config });
  fs.writeFileSync(path.join(dir, "now.config.json"), configText);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  return dir;
}

/** A GUID generator counting up from 1, for stable sys_ids. */
export function counter(): () => string {
  let n = 0;
  return () => (++n).toString(16).padStart(32, "0");
}

export function compile(source: string, files: Record<string, string> = {}, config?: Record<string, unknown>): CompileFluentResult {
  const projectDir = makeProject({ "src/fluent/app.now.ts": IMPORT + source, ...files }, config);
  return compileFluentProject({ projectDir, generateGuid: counter() });
}

export function messages(result: CompileFluentResult, severity = "error"): string[] {
  return result.diagnostics.filter((d) => d.severity === severity).map((d) => d.message);
}

/** The fields of a record update as a name → value map (attributes under `name@attr`). */
export function fieldsOf(record: RecordUpdateModel): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const f of record.fields) {
    out[f.name] = f.value;
    for (const [k, v] of Object.entries(f.attributes ?? {})) out[`${f.name}@${k}`] = v;
  }
  return out;
}

export function only(result: CompileFluentResult, table: string): Record<string, string | undefined>[] {
  return result.records.filter((r) => r.table === table).map(fieldsOf);
}
