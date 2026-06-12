import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "fs";
import path from "path";
import { logger } from "./logger";

const DEFAULT_AUDIT_MAX_BYTES = 10 * 1024 * 1024;

type AuditIntegrityResult = {
  ok: boolean;
  status: "missing" | "valid" | "quarantined" | "error";
  totalLines: number;
  malformedLines: number;
  quarantinedFile: string;
};

function isSensitiveAuditKey(key: string): boolean {
  const normalized = key.toLowerCase();
  const patterns = [
    /password/,
    /token/,
    /authorization/,
    /(^|[^a-z])auth([^a-z]|$)/,
    /secret/,
    /api[_-]?key/,
    /(^|[_-])key($|[_-])/,
  ];
  return patterns.some((pattern) => pattern.test(normalized));
}

export function sanitizeForAudit(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeForAudit);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (isSensitiveAuditKey(k)) {
      out[k] = "<redacted>";
    } else if (k.toLowerCase() === "script" && typeof v === "string") {
      out[k] = `<script:${v.length} chars>`;
    } else {
      out[k] = sanitizeForAudit(v);
    }
  }
  return out;
}

export function writeAuditEvent(
  auditDir: string,
  auditFile: string,
  entry: Record<string, unknown>,
  maxBytes = DEFAULT_AUDIT_MAX_BYTES
): void {
  try {
    if (!existsSync(auditDir)) {
      mkdirSync(auditDir, { recursive: true });
    }

    if (existsSync(auditFile)) {
      const size = statSync(auditFile).size;
      if (size >= maxBytes) {
        const dir = path.dirname(auditFile);
        const ext = path.extname(auditFile);
        const base = path.basename(auditFile, ext);
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        let rotatedPath = path.join(dir, `${base}.${stamp}${ext}`);
        let suffix = 0;
        while (existsSync(rotatedPath)) {
          suffix += 1;
          rotatedPath = path.join(dir, `${base}.${stamp}.${suffix}${ext}`);
        }
        renameSync(auditFile, rotatedPath);
      }
    }

    appendFileSync(auditFile, `${JSON.stringify(entry)}\n`, "utf-8");
  } catch (error) {
    // Intentionally ignore audit write failures to avoid breaking core flows.
    logger.debug("audit.write_failed", {
      auditFile,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function toCorruptAuditPath(auditFile: string): string {
  const dir = path.dirname(auditFile);
  const ext = path.extname(auditFile);
  const base = path.basename(auditFile, ext);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let candidate = path.join(dir, `${base}.corrupt.${stamp}${ext}`);
  let suffix = 0;
  while (existsSync(candidate)) {
    suffix += 1;
    candidate = path.join(dir, `${base}.corrupt.${stamp}.${suffix}${ext}`);
  }
  return candidate;
}

export function checkAuditLogIntegrity(
  auditDir: string,
  auditFile: string
): AuditIntegrityResult {
  try {
    if (!existsSync(auditDir)) {
      mkdirSync(auditDir, { recursive: true });
    }

    if (!existsSync(auditFile)) {
      return {
        ok: true,
        status: "missing",
        totalLines: 0,
        malformedLines: 0,
        quarantinedFile: "",
      };
    }

    const raw = readFileSync(auditFile, "utf-8");
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    let malformedLines = 0;
    for (const line of lines) {
      try {
        JSON.parse(line);
      } catch (_) {
        malformedLines += 1;
      }
    }

    if (malformedLines === 0) {
      return {
        ok: true,
        status: "valid",
        totalLines: lines.length,
        malformedLines: 0,
        quarantinedFile: "",
      };
    }

    const quarantinedFile = toCorruptAuditPath(auditFile);
    renameSync(auditFile, quarantinedFile);
    writeAuditEvent(auditDir, auditFile, {
      timestamp: new Date().toISOString(),
      event: "audit.integrity.recovered",
      malformedLines,
      totalLines: lines.length,
      quarantinedFile,
    });

    return {
      ok: false,
      status: "quarantined",
      totalLines: lines.length,
      malformedLines,
      quarantinedFile,
    };
  } catch (error) {
    logger.debug("audit.integrity_check_failed", {
      auditFile,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      status: "error",
      totalLines: 0,
      malformedLines: 0,
      quarantinedFile: "",
    };
  }
}
