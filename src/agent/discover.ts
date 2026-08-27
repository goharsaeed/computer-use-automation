import { ActionSchema, type Action } from "../types/schemas.js";
import type { Observation } from "../surface/playwrightSurface.js";
import { assertActionAllowed, defaultPolicy } from "../policy/guardrails.js";
import type { PlaywrightSurface } from "../surface/playwrightSurface.js";
import type { EvidenceWriter } from "../observability/evidence.js";
import {
  createLlmClient,
  extractJsonObject,
  isLlmEnabled,
  resolveLlmConfig,
  type LlmConfig,
} from "./llm.js";
import { escalateAndHandoff } from "../escalation/handoff.js";

export type DiscoverOptions = {
  goal: string;
  baseUrl: string;
  memberIdHint?: string;
  maxSteps?: number;
  useLlm?: boolean;
  operatorDir?: string;
};

function heuristicDecide(obs: Observation, goal: string, baseUrl: string, memberId: string): Action {
  if (obs.hasSavingsBalance) {
    return {
      type: "extract",
      name: "savingsBalance",
      locator: { strategy: "css", value: "#savings-balance", rationale: "Stable id for balance output" },
      reason: "Goal met: savings balance is visible; extract it.",
    };
  }
  if (obs.hasErrorPanel) {
    return { type: "done", reason: `Stopped on error panel: ${obs.errorMessage}` };
  }
  if (obs.hasMemberIdInput) {
    // If input empty-ish path: type then click. We alternate using URL/state.
    // Simple approach: always type then next loop clicks.
    if (!obs.textSnippet.includes(memberId) || true) {
      // Use a step marker via checking if submit was just needed — type every time before click in two phases
    }
  }
  if (obs.url.endsWith("/") || obs.url.includes("index")) {
    return {
      type: "click",
      locator: { strategy: "css", value: "#nav-lookup", rationale: "Primary nav to lookup" },
      reason: "Need member lookup page to pursue the goal.",
    };
  }
  if (obs.hasMemberIdInput && obs.hasLookupSubmit) {
    // Decide based on whether field already has value — heuristic: type first if balance not present
    return {
      type: "type",
      locator: {
        strategy: "label",
        value: "Member ID",
        rationale: "Label-based locator preferred over brittle xpath",
      },
      text: memberId,
      clear: true,
      reason: `Enter memberId parameter ${memberId} into lookup form.`,
    };
  }
  return {
    type: "navigate",
    url: `${baseUrl}/lookup`,
    reason: "Navigate directly to lookup as fallback.",
  };
}

/** Two-phase heuristic: after typing, click submit on next observation. */
export function heuristicDecideStateful(
  obs: Observation,
  baseUrl: string,
  memberId: string,
  typed: boolean
): { action: Action; typed: boolean } {
  if (obs.hasSavingsBalance) {
    return {
      typed,
      action: {
        type: "extract",
        name: "savingsBalance",
        locator: { strategy: "css", value: "#savings-balance", rationale: "Stable id" },
        reason: "Extract savings balance.",
      },
    };
  }
  if (obs.hasSessionNotice) {
    return {
      typed,
      action: {
        type: "click",
        locator: {
          strategy: "css",
          value: "#dismiss-notice",
          rationale: "Recoverable interstitial dismiss",
        },
        reason: "Dismiss session notice before continuing",
      },
    };
  }
  if (obs.hasErrorPanel) {
    return { typed, action: { type: "done", reason: obs.errorMessage || "error" } };
  }
  if (obs.url.replace(/\/$/, "").endsWith("") && !obs.hasMemberIdInput && obs.url.match(/\/$/)) {
    if (!obs.url.includes("/lookup")) {
      return {
        typed,
        action: {
          type: "click",
          locator: { strategy: "css", value: "#nav-lookup", rationale: "Nav link" },
          reason: "Go to lookup",
        },
      };
    }
  }
  if (!obs.hasMemberIdInput && !obs.url.includes("/lookup")) {
    return {
      typed,
      action: { type: "navigate", url: `${baseUrl}/lookup`, reason: "Open lookup page" },
    };
  }
  if (obs.hasMemberIdInput && !typed) {
    return {
      typed: true,
      action: {
        type: "type",
        locator: { strategy: "css", value: "#memberId", rationale: "Stable input id" },
        text: memberId,
        clear: true,
        reason: "Type member id",
      },
    };
  }
  if (obs.hasLookupSubmit && typed) {
    return {
      typed,
      action: {
        type: "click",
        locator: { strategy: "css", value: "#lookup-submit", rationale: "Submit button id" },
        reason: "Submit lookup form",
      },
    };
  }
  return {
    typed,
    action: { type: "navigate", url: `${baseUrl}/lookup`, reason: "Reset to lookup" },
  };
}

/** Reject LLM actions that contradict the current observation; fall back to heuristic. */
export function actionFitsObservation(
  obs: Observation,
  action: Action,
  opts: { typed: boolean; history: string[] }
): boolean {
  if (obs.hasSavingsBalance) {
    return action.type === "extract" || action.type === "done";
  }
  if (obs.hasSessionNotice) {
    return (
      action.type === "click" &&
      Boolean(action.locator?.value?.includes("dismiss-notice"))
    );
  }
  if (obs.hasErrorPanel) {
    return action.type === "done" || action.type === "escalate" || action.type === "navigate";
  }
  if (action.type === "click") {
    const v = action.locator.value;
    if (v.includes("memberId") && !obs.hasMemberIdInput) return false;
    if (v.includes("nav-lookup") && (obs.hasMemberIdInput || obs.url.includes("/lookup"))) return false;
    if (v.includes("lookup-submit") && !obs.hasLookupSubmit) return false;
    if (v.includes("lookup-submit") && !opts.typed) return false;
    if (v.includes("dismiss-notice") && !obs.hasSessionNotice) return false;
  }
  if (action.type === "type") {
    if (!obs.hasMemberIdInput) return false;
    if (opts.typed || opts.history.some((h) => h.startsWith("type:"))) return false;
  }
  if (action.type === "extract" && !obs.hasSavingsBalance) return false;
  if (action.type === "navigate" && obs.hasMemberIdInput && obs.url.includes("/lookup")) return false;
  return true;
}

async function llmDecide(
  obs: Observation,
  goal: string,
  history: string[],
  memberId: string,
  cfg: LlmConfig
): Promise<Action> {
  const system = `You are a computer-use agent for a back-office web app called Vital Core.
Return ONLY a single JSON object for the next action (no markdown, no explanation).
Allowed shapes:
{"type":"navigate","url":"...","reason":"..."}
{"type":"click","locator":{"strategy":"css","value":"#nav-lookup"},"reason":"..."}
{"type":"type","locator":{"strategy":"css","value":"#memberId"},"text":"${memberId}","clear":true,"reason":"..."}
{"type":"click","locator":{"strategy":"css","value":"#lookup-submit"},"reason":"..."}
{"type":"extract","name":"savingsBalance","locator":{"strategy":"css","value":"#savings-balance"},"reason":"..."}
{"type":"done","reason":"..."}
{"type":"escalate","reason":"..."}

Playbook for member savings lookup (follow observation flags strictly):
- If hasSavingsBalance=true → extract #savings-balance (ONLY valid next step).
- Else if hasSessionNotice=true → click #dismiss-notice.
- Else if hasMemberIdInput=true AND history already contains a line starting with "type:" → click #lookup-submit (do NOT type again).
- Else if hasMemberIdInput=true → type memberId into #memberId with type action (not click).
- Else if URL does not include /lookup → navigate to lookup OR click #nav-lookup.
- NEVER click #memberId. NEVER click #nav-lookup when already on /lookup.
- Prefer css ids: #nav-lookup, #memberId, #lookup-submit, #savings-balance, #dismiss-notice.
Stay on 127.0.0.1. Do not invent credentials.`;

  const alreadyTyped = history.some((h) => h.startsWith("type:"));
  const user = JSON.stringify(
    {
      goal,
      memberId,
      alreadyTyped,
      suggestedNext: obs.hasSavingsBalance
        ? "extract #savings-balance"
        : obs.hasSessionNotice
          ? "click #dismiss-notice"
          : obs.hasMemberIdInput && alreadyTyped
            ? "click #lookup-submit"
            : obs.hasMemberIdInput
              ? "type into #memberId"
              : "go to /lookup",
      observation: {
        url: obs.url,
        title: obs.title,
        hasMemberIdInput: obs.hasMemberIdInput,
        hasLookupSubmit: obs.hasLookupSubmit,
        hasSavingsBalance: obs.hasSavingsBalance,
        hasSessionNotice: obs.hasSessionNotice,
        hasErrorPanel: obs.hasErrorPanel,
        errorMessage: obs.errorMessage,
        memberName: obs.memberName,
        textSnippet: obs.textSnippet?.slice(0, 400),
      },
      history,
    },
    null,
    2
  );

  let raw = "";
  if (cfg.provider === "ollama") {
    // Native Ollama API with format:json is more reliable than OpenAI-compat for small models
    const root = (cfg.baseURL || "http://127.0.0.1:11434/v1").replace(/\/v1\/?$/, "");
    const resp = await fetch(`${root}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: cfg.model,
        stream: false,
        format: "json",
        options: { temperature: 0 },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!resp.ok) {
      throw new Error(`Ollama error ${resp.status}: ${await resp.text()}`);
    }
    const data = (await resp.json()) as { message?: { content?: string } };
    raw = data.message?.content || "{}";
  } else {
    const client = createLlmClient(cfg);
    const messages = [
      { role: "system" as const, content: system },
      { role: "user" as const, content: user },
    ];
    const resp = await client.chat.completions.create({
      model: cfg.model,
      temperature: 0,
      messages,
      response_format: { type: "json_object" },
    });
    raw = resp.choices[0]?.message?.content || "{}";
  }

  const parsed = ActionSchema.parse(extractJsonObject(raw));
  return parsed;
}

export type DiscoverResult = {
  success: boolean;
  actions: Action[];
  outputs: Record<string, string>;
  observations: Observation[];
  escalated?: boolean;
  escalateReason?: string;
};

export async function runDiscovery(
  surface: PlaywrightSurface,
  evidence: EvidenceWriter,
  opts: DiscoverOptions
): Promise<DiscoverResult> {
  const maxSteps = opts.maxSteps ?? Number(process.env.MAX_STEPS || 20);
  const memberId = opts.memberIdHint || "12345";
  const llmCfg = resolveLlmConfig();
  const useLlm = opts.useLlm !== false && isLlmEnabled(llmCfg);

  await surface.launch(true);
  const startNav = {
    type: "navigate" as const,
    url: opts.baseUrl,
    reason: "Start at target entry point",
  };
  await surface.act(startNav);

  const actions: Action[] = [startNav];
  const observations: Observation[] = [];
  const outputs: Record<string, string> = {};
  const history: string[] = [`navigate: ${startNav.reason}`];
  let typed = false;

  for (let i = 0; i < maxSteps; i++) {
    const obs = await surface.observe();
    observations.push(obs);
    evidence.log({ kind: "observe", step: i, obs });
    await surface.screenshot(`${evidence.dir}/step-${String(i).padStart(2, "0")}-observe.png`);

    if (obs.hasSavingsBalance && outputs.savingsBalance) {
      break;
    }

    let action: Action;
    let decideMode = useLlm ? `llm:${llmCfg.provider}:${llmCfg.model}` : "heuristic";
    if (useLlm) {
      try {
        action = await llmDecide(obs, opts.goal, history, memberId, llmCfg);
        if (!actionFitsObservation(obs, action, { typed, history })) {
          evidence.log({ kind: "llm_repair", step: i, rejected: action });
          const h = heuristicDecideStateful(obs, opts.baseUrl, memberId, typed);
          typed = h.typed;
          action = h.action;
          decideMode = `llm-repaired→heuristic`;
        }
      } catch (err) {
        evidence.log({
          kind: "llm_error",
          step: i,
          error: err instanceof Error ? err.message : String(err),
        });
        const h = heuristicDecideStateful(obs, opts.baseUrl, memberId, typed);
        typed = h.typed;
        action = h.action;
        decideMode = "llm-error→heuristic";
      }
    } else {
      const h = heuristicDecideStateful(obs, opts.baseUrl, memberId, typed);
      typed = h.typed;
      action = h.action;
    }

    const allowed = assertActionAllowed(action, defaultPolicy, opts.baseUrl);
    if (!allowed.ok) {
      evidence.log({ kind: "policy_block", action, reason: allowed.reason });
      history.push(`blocked: ${allowed.reason}`);
      continue;
    }

    evidence.log({ kind: "decide", step: i, action, mode: decideMode });
    const result = await surface.act(action);
    evidence.log({ kind: "act", step: i, result });
    if (!result.ok) {
      history.push(`failed ${action.type}: ${result.detail}`);
      continue;
    }
    actions.push(action);
    history.push(`${action.type}: ${action.reason}`);
    if (action.type === "type") typed = true;

    if (action.type === "extract" && result.extracted) {
      outputs[action.name] = result.extracted;
      // also capture member name if present
      if (obs.memberName) outputs.memberName = obs.memberName;
    }
    if (action.type === "escalate") {
      if (opts.operatorDir) {
        await escalateAndHandoff({
          surface,
          evidence,
          goal: opts.goal,
          reason: action.reason,
          currentStep: `discovery-step-${i}`,
          operatorDir: opts.operatorDir,
        });
      }
      return {
        success: false,
        actions,
        outputs,
        observations,
        escalated: true,
        escalateReason: action.reason,
      };
    }
    if (action.type === "done") {
      break;
    }
    // After extract of balance, mark done next
    if (action.type === "extract" && outputs.savingsBalance) {
      actions.push({ type: "done", reason: "Extracted required outputs" });
      break;
    }
  }

  const success = Boolean(outputs.savingsBalance);
  if (!success && opts.operatorDir) {
    await escalateAndHandoff({
      surface,
      evidence,
      goal: opts.goal,
      reason: "Discovery failed to reach savings-balance checkpoint within max steps",
      currentStep: `discovery-end`,
      operatorDir: opts.operatorDir,
    });
  }
  evidence.writeJson("discovery-summary.json", {
    goal: opts.goal,
    success,
    mode: useLlm ? `llm:${llmCfg.provider}` : "heuristic",
    provider: useLlm ? llmCfg.provider : "heuristic",
    model: useLlm ? llmCfg.model : null,
    outputs,
    actionCount: actions.length,
    escalatedOnFailure: !success && Boolean(opts.operatorDir),
  });
  return {
    success,
    actions,
    outputs,
    observations,
    escalated: !success && Boolean(opts.operatorDir),
    escalateReason: !success
      ? "Discovery failed to reach savings-balance checkpoint within max steps"
      : undefined,
  };
}
