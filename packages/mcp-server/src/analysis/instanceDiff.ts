export type DiffRecordInput = {
  name: string;
  value: string;
  sysId?: string;
  updatedOn?: string;
};

export type RecordDiffEntry = {
  name: string;
  status: "changed" | "added" | "removed" | "unchanged";
  sysId?: string;
  localLength: number;
  instanceLength: number;
  addedLines: number;
  removedLines: number;
  diffSummary: string;
  raceWarning?: string;
};

export type InstanceDiffReport = {
  changed: RecordDiffEntry[];
  added: RecordDiffEntry[];
  removed: RecordDiffEntry[];
  unchangedCount: number;
  summary: {
    total: number;
    changed: number;
    added: number;
    removed: number;
    unchanged: number;
  };
};

function normalizeContent(value: string): string {
  return (value || "").replace(/\r\n/g, "\n").replace(/\s+$/g, "");
}

function countLineDelta(localValue: string, instanceValue: string): { addedLines: number; removedLines: number } {
  const localLines = normalizeContent(localValue).split("\n");
  const instanceLines = normalizeContent(instanceValue).split("\n");

  const instanceCounts = new Map<string, number>();
  for (const line of instanceLines) {
    instanceCounts.set(line, (instanceCounts.get(line) ?? 0) + 1);
  }
  const localCounts = new Map<string, number>();
  for (const line of localLines) {
    localCounts.set(line, (localCounts.get(line) ?? 0) + 1);
  }

  let addedLines = 0;
  for (const [line, count] of localCounts.entries()) {
    const onInstance = instanceCounts.get(line) ?? 0;
    if (count > onInstance) {
      addedLines += count - onInstance;
    }
  }

  let removedLines = 0;
  for (const [line, count] of instanceCounts.entries()) {
    const onLocal = localCounts.get(line) ?? 0;
    if (count > onLocal) {
      removedLines += count - onLocal;
    }
  }

  return { addedLines, removedLines };
}

function parseTimestamp(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const normalized = value.includes("T") ? value : value.replace(" ", "T") + "Z";
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? null : parsed;
}

function buildRaceWarning(
  instanceUpdatedOn: string | undefined,
  localSyncedAt: string | undefined
): string | undefined {
  const instanceTs = parseTimestamp(instanceUpdatedOn);
  const localTs = parseTimestamp(localSyncedAt);
  if (instanceTs === null || localTs === null) {
    return undefined;
  }
  if (instanceTs > localTs) {
    return `Instance record was updated (${instanceUpdatedOn}) after the local sync point (${localSyncedAt}). Pushing local changes may overwrite newer remote work.`;
  }
  return undefined;
}

export function diffInstanceVsLocal(params: {
  local: DiffRecordInput[];
  instance: DiffRecordInput[];
  localSyncedAt?: string;
}): InstanceDiffReport {
  const localByKey = new Map<string, DiffRecordInput>();
  for (const record of params.local) {
    if (record && typeof record.name === "string" && record.name.length > 0) {
      localByKey.set(record.name, record);
    }
  }

  const instanceByKey = new Map<string, DiffRecordInput>();
  for (const record of params.instance) {
    if (record && typeof record.name === "string" && record.name.length > 0) {
      instanceByKey.set(record.name, record);
    }
  }

  const changed: RecordDiffEntry[] = [];
  const added: RecordDiffEntry[] = [];
  const removed: RecordDiffEntry[] = [];
  let unchangedCount = 0;

  const allNames = new Set<string>([...localByKey.keys(), ...instanceByKey.keys()]);

  for (const name of [...allNames].sort()) {
    const localRecord = localByKey.get(name);
    const instanceRecord = instanceByKey.get(name);

    if (localRecord && !instanceRecord) {
      added.push({
        name,
        status: "added",
        sysId: localRecord.sysId,
        localLength: localRecord.value.length,
        instanceLength: 0,
        addedLines: normalizeContent(localRecord.value).split("\n").length,
        removedLines: 0,
        diffSummary: "Exists locally but not on the instance (new local record).",
      });
      continue;
    }

    if (!localRecord && instanceRecord) {
      removed.push({
        name,
        status: "removed",
        sysId: instanceRecord.sysId,
        localLength: 0,
        instanceLength: instanceRecord.value.length,
        addedLines: 0,
        removedLines: normalizeContent(instanceRecord.value).split("\n").length,
        diffSummary: "Exists on the instance but not locally (missing local copy).",
      });
      continue;
    }

    if (localRecord && instanceRecord) {
      const localNorm = normalizeContent(localRecord.value);
      const instanceNorm = normalizeContent(instanceRecord.value);
      if (localNorm === instanceNorm) {
        unchangedCount += 1;
        continue;
      }

      const { addedLines, removedLines } = countLineDelta(localRecord.value, instanceRecord.value);
      changed.push({
        name,
        status: "changed",
        sysId: instanceRecord.sysId ?? localRecord.sysId,
        localLength: localRecord.value.length,
        instanceLength: instanceRecord.value.length,
        addedLines,
        removedLines,
        diffSummary: `${addedLines} line(s) only local, ${removedLines} line(s) only on instance.`,
        raceWarning: buildRaceWarning(instanceRecord.updatedOn, params.localSyncedAt),
      });
    }
  }

  return {
    changed,
    added,
    removed,
    unchangedCount,
    summary: {
      total: allNames.size,
      changed: changed.length,
      added: added.length,
      removed: removed.length,
      unchanged: unchangedCount,
    },
  };
}
