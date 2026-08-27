const SENSITIVE =
  /(password|token|secret|ssn|social.?security|accountNumber|routingNumber|api[_-]?key)/i;

export function redactValue(key: string, value: string): string {
  if (SENSITIVE.test(key)) return "[REDACTED]";
  // Mask long digit sequences that look like account numbers
  if (/^\d{9,}$/.test(value)) return value.slice(0, 2) + "****" + value.slice(-2);
  return value;
}

export function redactObject<T>(obj: T): T {
  if (Array.isArray(obj)) {
    return obj.map((item) =>
      item && typeof item === "object" ? redactObject(item) : item
    ) as T;
  }
  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = redactValue(k, v);
      else if (v && typeof v === "object") out[k] = redactObject(v);
      else out[k] = v;
    }
    return out as T;
  }
  return obj;
}

export function redactText(text: string): string {
  return text
    .replace(/(api[_-]?key|token|password)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[REDACTED-SSN]");
}
