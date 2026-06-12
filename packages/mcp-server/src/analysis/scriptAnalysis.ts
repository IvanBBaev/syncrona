function toStringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return value as Record<string, unknown>;
}

type Finding = {
  id: string;
  level: "high" | "medium" | "low";
  message: string;
  remediation: string;
};

export type AnalysisPolicy = {
  weights: {
    high: number;
    medium: number;
    low: number;
  };
  suppressions: Array<{ id: string; expiresAt?: string }>;
};

export function formatWhyLines(
  findings: Array<{ id: string; message: string }>
): string[] {
  const rows = findings
    .map((f) => `${f.id}: ${f.message}`.trim())
    .filter((line) => line.length > 0);
  return [...new Set(rows)].sort((a, b) => a.localeCompare(b));
}

export function parseAnalysisPolicy(value: unknown): AnalysisPolicy {
  const root = asRecord(value);
  const weightsObj = asRecord(root.weights);
  const parseWeight = (name: "high" | "medium" | "low", fallback: number) => {
    const raw = weightsObj[name];
    return typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
  };

  const suppressionsRaw = Array.isArray(root.suppressions) ? root.suppressions : [];
  const suppressions = suppressionsRaw
    .map((item) => asRecord(item))
    .map((item) => ({
      id: toStringField(item.id),
      expiresAt: toStringField(item.expiresAt) || undefined,
    }))
    .filter((item) => item.id.length > 0);

  return {
    weights: {
      high: parseWeight("high", 5),
      medium: parseWeight("medium", 3),
      low: parseWeight("low", 1),
    },
    suppressions,
  };
}

export function resolveActiveSuppressions(
  suppressions: Array<{ id: string; expiresAt?: string }>,
  nowIso: string
): string[] {
  const now = Date.parse(nowIso);
  if (Number.isNaN(now)) {
    return suppressions.map((s) => s.id);
  }

  return suppressions
    .filter((item) => {
      if (!item.expiresAt) {
        return true;
      }
      const ts = Date.parse(item.expiresAt);
      return Number.isNaN(ts) || ts > now;
    })
    .map((item) => item.id);
}

export function applyFindingSuppressions(
  findings: Finding[],
  suppressedIds: string[]
): { active: Finding[]; suppressed: Finding[] } {
  const suppressedSet = new Set(suppressedIds);
  const active = findings.filter((f) => !suppressedSet.has(f.id));
  const suppressed = findings.filter((f) => suppressedSet.has(f.id));
  return { active, suppressed };
}

export function buildRiskSummary(findings: Finding[]): Record<string, unknown> {
  return buildRiskSummaryWithPolicy(findings, {
    high: 5,
    medium: 3,
    low: 1,
  });
}

export function buildRiskSummaryWithPolicy(
  findings: Finding[],
  weights: { high: number; medium: number; low: number }
): Record<string, unknown> {

  const distribution: Record<string, number> = {
    high: 0,
    medium: 0,
    low: 0,
  };

  let score = 0;
  for (const finding of findings) {
    distribution[finding.level] = (distribution[finding.level] || 0) + 1;
    score += weights[finding.level] || 0;
  }

  return {
    score,
    count: findings.length,
    distribution,
  };
}

function findPattern(
  script: string,
  pattern: RegExp,
  id: string,
  level: "high" | "medium" | "low",
  message: string,
  remediation: string
): Finding[] {
  return pattern.test(script)
    ? [
        {
          id,
          level,
          message,
          remediation,
        },
      ]
    : [];
}

export function analyzeArchitecture(script: string): Record<string, unknown> {
  const findings: Finding[] = [
    ...findPattern(
      script,
      /gs\.log\(/,
      "arch.logging.noise",
      "low",
      "Frequent gs.log usage can pollute logs.",
      "Use contextual structured logging and remove noisy debug logs."
    ),
    ...findPattern(
      script,
      /try\s*\{[\s\S]*\}\s*catch\s*\(\s*\)\s*\{/,
      "arch.empty.catch",
      "medium",
      "Empty catch blocks hide failures.",
      "Capture and rethrow or explicitly handle exceptions."
    ),
  ];

  return {
    category: "architecture",
    findings,
    why: formatWhyLines(findings),
  };
}

export function analyzeSecurity(script: string): Record<string, unknown> {
  const findings: Finding[] = [
    ...findPattern(
      script,
      /addEncodedQuery\(['\"][^'\"]*\+\s*input/,
      "sec.encoded.query.concat",
      "high",
      "Dynamic encoded query concatenation can allow injection.",
      "Use parameterized constraints and explicit whitelist checks."
    ),
    ...findPattern(
      script,
      /setWorkflow\(false\)/,
      "sec.workflow.bypass",
      "medium",
      "Disabling workflow can bypass business safeguards.",
      "Document necessity and scope, and apply narrowly."
    ),
    ...findPattern(
      script,
      /GlideRecord\(['\"][a-z0-9_]+['\"]\)/i,
      "sec.gliderecord.review",
      "low",
      "GlideRecord usage detected; verify ACL and query constraints.",
      "Use GlideRecordSecure when reading user-facing data paths."
    ),
  ];

  return {
    category: "security",
    findings,
    why: formatWhyLines(findings),
  };
}

export function analyzePerformance(script: string): Record<string, unknown> {
  const findings: Finding[] = [
    ...findPattern(
      script,
      /while\s*\(\s*gr\.next\(\)\s*\)\s*\{[\s\S]*new\s+GlideRecord\(/,
      "perf.nested.gr",
      "high",
      "Nested GlideRecord creation in loops may be expensive.",
      "Batch related queries and prefetch data before iteration."
    ),
    ...findPattern(
      script,
      /orderBy\(/,
      "perf.orderby.review",
      "low",
      "Ordering can become expensive on large unindexed tables.",
      "Verify proper indexing for orderBy fields."
    ),
  ];

  return {
    category: "performance",
    findings,
    why: formatWhyLines(findings),
  };
}

export function runAutonomousRemediation(
  script: string,
  opts: { apply: boolean; dryRun: boolean }
): Record<string, unknown> {
  const security = analyzeSecurity(script);
  const architecture = analyzeArchitecture(script);
  const performance = analyzePerformance(script);

  const findings = [
    ...((security.findings as Finding[]) || []),
    ...((architecture.findings as Finding[]) || []),
    ...((performance.findings as Finding[]) || []),
  ];

  const patchPlan = findings.map((f) => ({
    id: f.id,
    action: f.remediation,
  }));

  const patchedScript = opts.apply && !opts.dryRun
    ? script.replace(/gs\.log\(/g, "gs.info(")
    : script;

  return {
    steps: ["detect", "propose patch", opts.dryRun ? "dry-run" : "apply", "validate"],
    findingsCount: findings.length,
    patchPlan,
    applied: opts.apply && !opts.dryRun,
    patchedScript,
    validation: {
      ok: true,
      message: "Validation completed in mocked mode.",
    },
    why: formatWhyLines(findings),
  };
}

export function buildFullScriptAnalysisReport(
  script: string,
  opts?: { suppressedIds?: string[]; policy?: unknown; nowIso?: string }
): Record<string, unknown> {
  const architecture = analyzeArchitecture(script);
  const security = analyzeSecurity(script);
  const performance = analyzePerformance(script);

  const findings = [
    ...((architecture.findings as Finding[]) || []),
    ...((security.findings as Finding[]) || []),
    ...((performance.findings as Finding[]) || []),
  ];

  const policy = parseAnalysisPolicy(opts?.policy);
  const activePolicySuppressions = resolveActiveSuppressions(
    policy.suppressions,
    opts?.nowIso || new Date().toISOString()
  );
  const rawSuppressed = opts && Array.isArray(opts.suppressedIds)
    ? opts.suppressedIds
    : [];
  const suppressedIds: string[] = [
    ...rawSuppressed,
    ...activePolicySuppressions,
  ].filter(
    (v): v is string => typeof v === "string"
  );
  const suppression = applyFindingSuppressions(findings, suppressedIds);

  return {
    findings: {
      active: suppression.active,
      suppressed: suppression.suppressed,
    },
    risk: {
      active: buildRiskSummaryWithPolicy(suppression.active, policy.weights),
      total: buildRiskSummaryWithPolicy(findings, policy.weights),
    },
    sections: {
      architecture,
      security,
      performance,
    },
    why: formatWhyLines(suppression.active),
    policy,
  };
}

export function renderFullAnalysisMarkdown(report: Record<string, unknown>): string {
  const findings = asRecord(report.findings);
  const active = Array.isArray(findings.active) ? findings.active : [];
  const suppressed = Array.isArray(findings.suppressed) ? findings.suppressed : [];
  const risk = asRecord(report.risk);
  const activeRisk = asRecord(risk.active);
  const totalRisk = asRecord(risk.total);
  const why = Array.isArray(report.why)
    ? report.why.filter((v): v is string => typeof v === "string")
    : [];

  const lines: string[] = [];
  lines.push("# Full Script Analysis");
  lines.push("");
  lines.push(`- Active findings: ${active.length}`);
  lines.push(`- Suppressed findings: ${suppressed.length}`);
  lines.push(`- Active risk score: ${String(activeRisk.score ?? 0)}`);
  lines.push(`- Total risk score: ${String(totalRisk.score ?? 0)}`);
  lines.push("");
  lines.push("## Why");
  if (why.length === 0) {
    lines.push("- none");
  } else {
    for (const row of [...why].sort((a, b) => a.localeCompare(b))) {
      lines.push(`- ${row}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
