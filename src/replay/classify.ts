import type { Observation } from "../surface/playwrightSurface.js";
import type { ReplayResult } from "../types/schemas.js";

/**
 * Map a live observation (or action failure) into the replay error taxonomy.
 * Used by the replay engine and unit tests.
 */
export function classifyObservation(
  obs: Observation,
  opts?: { stepFailed?: boolean; detail?: string }
):
  | { kind: "ok" }
  | { kind: "BUSINESS_OUTCOME"; code: string; message: string }
  | { kind: "RECOVERABLE"; code: string; message: string; recoveryAction: string }
  | { kind: "HARD_FAILURE"; expected: string; observed: string; message: string } {
  if (obs.hasErrorPanel) {
    const code = obs.errorCode || "ERROR";
    if (code === "MEMBER_NOT_FOUND") {
      return {
        kind: "BUSINESS_OUTCOME",
        code,
        message: obs.errorMessage || "Member not found",
      };
    }
    return {
      kind: "HARD_FAILURE",
      expected: "successful page state",
      observed: obs.errorMessage || code,
      message: `Unexpected error panel: ${obs.errorMessage || code}`,
    };
  }

  if (obs.hasSessionNotice) {
    return {
      kind: "RECOVERABLE",
      code: "SESSION_NOTICE",
      message: "Dismissible session/maintenance notice is blocking the flow",
      recoveryAction: "click #dismiss-notice",
    };
  }

  if (opts?.stepFailed) {
    return {
      kind: "HARD_FAILURE",
      expected: "successful action",
      observed: opts.detail || "action failed",
      message: opts.detail || "action failed",
    };
  }

  return { kind: "ok" };
}

export function toReplayResult(
  classified: ReturnType<typeof classifyObservation>,
  stepsCompleted: number,
  evidenceDir: string
): ReplayResult | null {
  if (classified.kind === "ok") return null;
  if (classified.kind === "BUSINESS_OUTCOME") {
    return {
      status: "BUSINESS_OUTCOME",
      code: classified.code,
      message: classified.message,
      stepsCompleted,
      evidenceDir,
    };
  }
  if (classified.kind === "RECOVERABLE") {
    return {
      status: "RECOVERABLE",
      code: classified.code,
      message: classified.message,
      recoveryAction: classified.recoveryAction,
      stepsCompleted,
      evidenceDir,
    };
  }
  return {
    status: "HARD_FAILURE",
    expected: classified.expected,
    observed: classified.observed,
    message: classified.message,
    stepsCompleted,
    evidenceDir,
  };
}
