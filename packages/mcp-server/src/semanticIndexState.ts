import { buildSemanticIndexFromWorkspace, type SemanticSymbol } from "./analysis";
import { writeAuditEvent } from "./audit";
import { AUDIT_DIR, AUDIT_FILE, PROJECT_DIR } from "./runtimeConfig";

let LAST_SEMANTIC_INDEX: SemanticSymbol[] | null = null;
let LAST_SEMANTIC_INDEX_DIRTY = true;
let LAST_SEMANTIC_INDEX_BUILT_AT = 0;

export function setSemanticIndex(rows: SemanticSymbol[]): void {
  LAST_SEMANTIC_INDEX = rows;
  LAST_SEMANTIC_INDEX_DIRTY = false;
  LAST_SEMANTIC_INDEX_BUILT_AT = Date.now();
}

export function invalidateSemanticIndex(reason: string = "unknown"): void {
  LAST_SEMANTIC_INDEX_DIRTY = true;

  writeAuditEvent(AUDIT_DIR, AUDIT_FILE, {
    timestamp: new Date().toISOString(),
    event: "semantic_index.invalidated",
    reason,
  });
}

export function getSemanticIndex(projectDir: string = PROJECT_DIR): SemanticSymbol[] {
  if (!LAST_SEMANTIC_INDEX || LAST_SEMANTIC_INDEX_DIRTY) {
    const nextIndex = buildSemanticIndexFromWorkspace(projectDir);
    setSemanticIndex(nextIndex);
  }

  return LAST_SEMANTIC_INDEX || [];
}

export function getSemanticIndexState(): {
  built: boolean;
  dirty: boolean;
  symbolCount: number;
  builtAt: number;
} {
  return {
    built: Array.isArray(LAST_SEMANTIC_INDEX),
    dirty: LAST_SEMANTIC_INDEX_DIRTY,
    symbolCount: LAST_SEMANTIC_INDEX ? LAST_SEMANTIC_INDEX.length : 0,
    builtAt: LAST_SEMANTIC_INDEX_BUILT_AT,
  };
}
