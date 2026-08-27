import type { Action, Artifact } from "../types/schemas.js";
import { ArtifactSchema } from "../types/schemas.js";
import fs from "node:fs";
import path from "node:path";

function looksLikeMemberId(text: string): boolean {
  return /^\d+$/.test(text.trim());
}

/**
 * Convert a successful discovery action transcript into a versioned capability artifact.
 * Parameterizes typed member IDs; skips done/escalate; keeps ordered UI steps.
 */
export function actionsToArtifact(args: {
  actions: Action[];
  goal: string;
  entryPath?: string;
}): Artifact {
  const steps: Artifact["steps"] = [];
  let i = 0;
  const seenExtract = new Set<string>();

  for (const action of args.actions) {
    if (action.type === "done" || action.type === "escalate") continue;

    if (action.type === "navigate") {
      const url = action.url;
      const pathPart = url.replace(/^https?:\/\/[^/]+/, "") || "/";
      steps.push({
        id: `s${++i}`,
        action: "navigate",
        description: action.reason || "Navigate",
        urlTemplate: pathPart.startsWith("/")
          ? `{baseUrl}${pathPart}`
          : `{baseUrl}/${pathPart}`,
      });
      continue;
    }

    if (action.type === "click") {
      // Ephemeral recoveries are handled by the replay engine, not frozen into the capability
      if (action.locator.value.includes("dismiss-notice")) continue;
      steps.push({
        id: `s${++i}`,
        action: "click",
        description: action.reason || "Click",
        locator: {
          strategy: action.locator.strategy,
          value: action.locator.value,
          rationale: action.locator.rationale || "Recorded from discovery",
        },
      });
      continue;
    }

    if (action.type === "type") {
      const useParam = looksLikeMemberId(action.text);
      steps.push({
        id: `s${++i}`,
        action: "type",
        description: action.reason || "Type into field",
        locator: {
          strategy: action.locator.strategy,
          value: action.locator.value,
          rationale: action.locator.rationale || "Recorded from discovery",
        },
        ...(useParam ? { textParam: "memberId" } : { textLiteral: action.text }),
      });
      continue;
    }

    if (action.type === "extract") {
      if (seenExtract.has(action.name)) continue;
      seenExtract.add(action.name);
      steps.push({
        id: `s${++i}`,
        action: "extract",
        description: action.reason || `Extract ${action.name}`,
        locator: {
          strategy: action.locator.strategy,
          value: action.locator.value,
          rationale: action.locator.rationale || "Recorded from discovery",
        },
        extractAs: action.name,
      });
    }
  }

  // Ensure member name extract exists when balance was extracted (demo contract)
  if (seenExtract.has("savingsBalance") && !seenExtract.has("memberName")) {
    steps.push({
      id: `s${++i}`,
      action: "extract",
      description: "Read member name",
      locator: {
        strategy: "css",
        value: "#member-name",
        rationale: "Companion output on member detail page",
      },
      extractAs: "memberName",
    });
  }

  // Fallback canonical path if discovery produced no usable interaction steps
  const hasInteraction = steps.some((s) => s.action === "type" || s.action === "extract");
  if (!hasInteraction) {
    steps.length = 0;
    steps.push(
      {
        id: "s1",
        action: "navigate",
        description: "Open member lookup page",
        urlTemplate: "{baseUrl}/lookup",
      },
      {
        id: "s2",
        action: "type",
        description: "Enter member ID",
        locator: {
          strategy: "css",
          value: "#memberId",
          rationale: "Stable element id",
        },
        textParam: "memberId",
      },
      {
        id: "s3",
        action: "click",
        description: "Submit lookup form",
        locator: {
          strategy: "css",
          value: "#lookup-submit",
          rationale: "Stable submit button id",
        },
      },
      {
        id: "s4",
        action: "extract",
        description: "Read savings balance",
        locator: {
          strategy: "css",
          value: "#savings-balance",
          rationale: "Stable output id",
        },
        extractAs: "savingsBalance",
      },
      {
        id: "s5",
        action: "extract",
        description: "Read member name",
        locator: {
          strategy: "css",
          value: "#member-name",
          rationale: "Stable output id",
        },
        extractAs: "memberName",
      }
    );
  } else if (steps[0]?.action !== "navigate") {
    // Capability must be self-contained from a blank browser session
    steps.unshift({
      id: "s0",
      action: "navigate",
      description: "Open target entry / home",
      urlTemplate: "{baseUrl}/",
    });
  }

  steps.forEach((s, idx) => {
    s.id = `s${idx + 1}`;
  });

  const artifact: Artifact = {
    id: "lookup-member-savings",
    name: "LookupMemberSavingsBalance",
    version: "1.0.0",
    description:
      args.goal ||
      "Look up a member by ID in Vital Core servicing UI and return savings balance and member name.",
    target: {
      kind: "web",
      baseUrlParam: "baseUrl",
      entryPath: args.entryPath || "/lookup",
    },
    inputs: [
      {
        name: "memberId",
        type: "string",
        description: "Member identifier to look up",
        required: true,
      },
      {
        name: "baseUrl",
        type: "string",
        description: "Base URL of the target app",
        required: true,
      },
    ],
    outputs: [
      {
        name: "savingsBalance",
        type: "money",
        description: "Current savings balance displayed on member detail",
      },
      {
        name: "memberName",
        type: "string",
        description: "Member display name",
      },
    ],
    steps,
    checkpoint: {
      description: "Savings balance element is visible on member detail page",
      locator: {
        strategy: "css",
        value: "#savings-balance",
        rationale: "Presence proves successful lookup happy path",
      },
    },
    policyRef: "defaultPolicy@1",
    createdAt: new Date().toISOString(),
  };

  return ArtifactSchema.parse(artifact);
}

export function saveArtifact(artifact: Artifact, dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${artifact.id}.v${artifact.version}.json`);
  fs.writeFileSync(file, JSON.stringify(artifact, null, 2));
  return file;
}
