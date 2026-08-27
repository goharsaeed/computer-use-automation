import type { Action, Policy } from "../types/schemas.js";

export const defaultPolicy: Policy = {
  allowedHosts: ["127.0.0.1", "localhost"],
  allowedPathPrefixes: ["/", "/lookup"],
  allowedActionTypes: ["navigate", "click", "type", "extract", "done", "escalate"],
  riskyActions: ["transfer", "delete", "wire", "close-account"],
};

export function assertActionAllowed(
  action: Action,
  policy: Policy,
  currentBaseUrl: string
): { ok: true } | { ok: false; reason: string } {
  if (!policy.allowedActionTypes.includes(action.type)) {
    return { ok: false, reason: `Action type '${action.type}' is not allowlisted.` };
  }

  if (action.type === "navigate") {
    let url: URL;
    try {
      url = new URL(action.url, currentBaseUrl);
    } catch {
      return { ok: false, reason: `Invalid URL: ${action.url}` };
    }
    if (!policy.allowedHosts.includes(url.hostname)) {
      return {
        ok: false,
        reason: `Host '${url.hostname}' is outside allowlist ${policy.allowedHosts.join(", ")}.`,
      };
    }
    const allowed = policy.allowedPathPrefixes.some(
      (p) => url.pathname === p || url.pathname.startsWith(p.endsWith("/") ? p : p + "/") || p === "/"
    );
    // Allow exact prefixes: /, /lookup
    const pathOk =
      policy.allowedPathPrefixes.includes(url.pathname) ||
      url.pathname === "/" ||
      url.pathname.startsWith("/lookup");
    if (!pathOk && !allowed) {
      return { ok: false, reason: `Path '${url.pathname}' is not allowlisted.` };
    }
  }

  const blob = JSON.stringify(action).toLowerCase();
  for (const risky of policy.riskyActions) {
    if (blob.includes(risky.toLowerCase())) {
      return {
        ok: false,
        reason: `Risky/irreversible action pattern '${risky}' blocked (requires human confirmation).`,
      };
    }
  }

  return { ok: true };
}
