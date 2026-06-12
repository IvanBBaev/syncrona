export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }

  return value as Record<string, unknown>;
}

export function toStringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}
