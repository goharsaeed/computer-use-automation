import type { Artifact, ReplayResult } from "../types/schemas.js";
import { PlaywrightSurface } from "../surface/playwrightSurface.js";
import type { EvidenceWriter } from "../observability/evidence.js";
import { assertActionAllowed, defaultPolicy } from "../policy/guardrails.js";
import type { Action } from "../types/schemas.js";
import { classifyObservation, toReplayResult } from "./classify.js";
import { escalateAndHandoff } from "../escalation/handoff.js";
import path from "node:path";

export type ReplayOptions = {
  headless?: boolean;
  /** If true, return RECOVERABLE instead of auto-dismissing session notices. */
  stopOnRecoverable?: boolean;
  /** Operator dir for escalation on hard failure (optional). */
  operatorDir?: string;
  goal?: string;
  escalateOnHardFailure?: boolean;
};

export async function replayArtifact(
  artifact: Artifact,
  params: Record<string, string>,
  evidence: EvidenceWriter,
  options: ReplayOptions = {}
): Promise<ReplayResult> {
  const headless = options.headless ?? true;
  const stopOnRecoverable =
    options.stopOnRecoverable ?? process.env.STOP_ON_RECOVERABLE === "1";
  const baseUrl = params.baseUrl;
  if (!baseUrl) {
    return {
      status: "HARD_FAILURE",
      expected: "baseUrl param",
      observed: "missing",
      message: "baseUrl is required",
      evidenceDir: evidence.dir,
    };
  }

  const surface = new PlaywrightSurface();
  await surface.launch(headless);

  let stepsCompleted = 0;
  const outputs: Record<string, string> = {};
  const recoveries: Array<Record<string, string>> = [];

  try {
    for (const step of artifact.steps) {
      // Handle recoverable interstitials before the next step
      let obs = await surface.observe();
      let classified = classifyObservation(obs);
      if (classified.kind === "RECOVERABLE") {
        evidence.log({ kind: "recoverable_detected", classified, stepId: step.id });
        if (stopOnRecoverable) {
          const result = toReplayResult(classified, stepsCompleted, evidence.dir)!;
          evidence.writeJson("result.json", result);
          return result;
        }
        const dismiss: Action = {
          type: "click",
          locator: {
            strategy: "css",
            value: "#dismiss-notice",
            rationale: "Known recoverable interstitial dismiss control",
          },
          reason: "Dismiss session notice",
        };
        const dismissResult = await surface.act(dismiss);
        evidence.log({ kind: "recoverable_recovery", dismissResult });
        if (!dismissResult.ok) {
          return {
            status: "HARD_FAILURE",
            stepId: step.id,
            expected: classified.recoveryAction,
            observed: dismissResult.detail,
            message: "Failed to recover from session notice",
            evidenceDir: evidence.dir,
          };
        }
        recoveries.push({
          code: classified.code,
          recoveryAction: classified.recoveryAction,
        });
        await surface.screenshot(
          `${evidence.dir}/recovered-${String(recoveries.length).padStart(2, "0")}.png`
        );
      }

      let action: Action;
      if (step.action === "navigate") {
        const url = (step.urlTemplate || "").replace("{baseUrl}", baseUrl);
        action = { type: "navigate", url, reason: step.description };
      } else if (step.action === "type") {
        const text = step.textParam ? params[step.textParam] : step.textLiteral || "";
        if (step.textParam && (text === undefined || text === "")) {
          return {
            status: "HARD_FAILURE",
            stepId: step.id,
            expected: `param ${step.textParam}`,
            observed: "missing",
            message: `Missing required input parameter ${step.textParam}`,
            evidenceDir: evidence.dir,
          };
        }
        action = {
          type: "type",
          locator: step.locator!,
          text: String(text),
          clear: true,
          reason: step.description,
        };
      } else if (step.action === "click") {
        action = { type: "click", locator: step.locator!, reason: step.description };
      } else if (step.action === "extract") {
        action = {
          type: "extract",
          name: step.extractAs || "value",
          locator: step.locator!,
          reason: step.description,
        };
      } else {
        return {
          status: "HARD_FAILURE",
          stepId: step.id,
          expected: "known action",
          observed: String(step.action),
          message: "Unsupported step action",
          evidenceDir: evidence.dir,
        };
      }

      const allowed = assertActionAllowed(action, defaultPolicy, baseUrl);
      if (!allowed.ok) {
        await surface.screenshot(`${evidence.dir}/policy-block.png`);
        return {
          status: "HARD_FAILURE",
          stepId: step.id,
          expected: "allowlisted action",
          observed: allowed.reason,
          message: allowed.reason,
          evidenceDir: evidence.dir,
        };
      }

      evidence.log({ kind: "replay_step", step, action });
      const result = await surface.act(action);
      await surface.screenshot(
        `${evidence.dir}/step-${String(stepsCompleted).padStart(2, "0")}.png`
      );

      obs = await surface.observe();
      classified = classifyObservation(obs, {
        stepFailed: !result.ok,
        detail: result.detail,
      });

      if (classified.kind === "BUSINESS_OUTCOME") {
        const out = toReplayResult(classified, stepsCompleted, evidence.dir)!;
        evidence.writeJson("result.json", out);
        return out;
      }

      if (classified.kind === "RECOVERABLE") {
        evidence.log({ kind: "recoverable_after_act", classified });
        if (stopOnRecoverable) {
          const out = toReplayResult(classified, stepsCompleted, evidence.dir)!;
          evidence.writeJson("result.json", out);
          return out;
        }
        const dismiss: Action = {
          type: "click",
          locator: { strategy: "css", value: "#dismiss-notice", rationale: "Dismiss" },
          reason: "Dismiss session notice after navigation",
        };
        const dismissResult = await surface.act(dismiss);
        if (!dismissResult.ok) {
          return {
            status: "HARD_FAILURE",
            stepId: step.id,
            expected: classified.recoveryAction,
            observed: dismissResult.detail,
            message: "Failed to recover from session notice",
            evidenceDir: evidence.dir,
          };
        }
        recoveries.push({
          code: classified.code,
          recoveryAction: classified.recoveryAction,
        });
        // Retry the same step once after recovery (e.g. type blocked by overlay)
        if (!result.ok) {
          const retry = await surface.act(action);
          if (!retry.ok) {
            return {
              status: "HARD_FAILURE",
              stepId: step.id,
              expected: "successful action after recovery",
              observed: retry.detail,
              message: retry.detail,
              evidenceDir: evidence.dir,
            };
          }
          if (action.type === "extract" && retry.extracted != null) {
            outputs[action.name] = retry.extracted;
          }
          stepsCompleted += 1;
          continue;
        }
      } else if (classified.kind === "HARD_FAILURE") {
        if (options.escalateOnHardFailure && options.operatorDir) {
          await escalateAndHandoff({
            surface,
            evidence,
            goal: options.goal || artifact.description,
            reason: classified.message,
            currentStep: step.id,
            operatorDir: options.operatorDir,
          });
        }
        const out = toReplayResult(classified, stepsCompleted, evidence.dir)!;
        if (out.status === "HARD_FAILURE") out.stepId = step.id;
        evidence.writeJson("result.json", out);
        return out;
      }

      if (!result.ok && classified.kind === "ok") {
        return {
          status: "HARD_FAILURE",
          stepId: step.id,
          expected: "successful action",
          observed: result.detail,
          message: result.detail,
          evidenceDir: evidence.dir,
        };
      }

      if (action.type === "extract" && result.extracted != null) {
        outputs[action.name] = result.extracted;
      }
      stepsCompleted += 1;
    }

    const finalObs = await surface.observe();
    if (!finalObs.hasSavingsBalance) {
      return {
        status: "HARD_FAILURE",
        expected: artifact.checkpoint.description,
        observed: "savings balance not visible",
        message: "Checkpoint failed after replaying all steps",
        evidenceDir: evidence.dir,
        stepId: artifact.checkpoint.locator.value,
      };
    }

    // Also capture member name if visible and not already extracted
    if (finalObs.memberName && !outputs.memberName) {
      outputs.memberName = finalObs.memberName;
    }

    const success = {
      status: "SUCCESS" as const,
      outputs,
      stepsCompleted,
      evidenceDir: evidence.dir,
    };
    evidence.writeJson("result.json", { ...success, recoveries });
    return success;
  } finally {
    await surface.close();
  }
}

/** Helper for demos that need an operator path next to package root. */
export function defaultOperatorDir(fromEvidenceDir: string): string {
  return path.resolve(fromEvidenceDir, "../../operator");
}
