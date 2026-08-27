import fs from "node:fs";
import path from "node:path";
import type { EscalationEvent } from "../types/schemas.js";
import type { PlaywrightSurface } from "../surface/playwrightSurface.js";
import type { EvidenceWriter } from "../observability/evidence.js";

/**
 * Minimal real handoff seam:
 * - pause automation on same live session
 * - write an intervention request for a human/operator
 * - wait for operator signal file (mock operator UI)
 * - capture notes and resume
 */
export async function escalateAndHandoff(args: {
  surface: PlaywrightSurface;
  evidence: EvidenceWriter;
  goal: string;
  reason: string;
  currentStep?: string;
  operatorDir: string;
  waitMs?: number;
}): Promise<EscalationEvent> {
  const id = `esc-${Date.now()}`;
  args.surface.pauseForHuman();
  const shot = await args.surface.screenshot(`${args.evidence.dir}/escalate.png`);
  const obs = await args.surface.observe();

  const event: EscalationEvent = {
    id,
    createdAt: new Date().toISOString(),
    reason: args.reason,
    goal: args.goal,
    currentStep: args.currentStep,
    ownership: "human",
    screenshotPath: shot,
    stateSummary: JSON.stringify({
      url: obs.url,
      title: obs.title,
      error: obs.errorMessage,
    }),
  };

  fs.mkdirSync(args.operatorDir, { recursive: true });
  const requestPath = path.join(args.operatorDir, "intervention-request.json");
  const resumePath = path.join(args.operatorDir, "resume-signal.json");
  fs.writeFileSync(requestPath, JSON.stringify(event, null, 2));
  if (fs.existsSync(resumePath)) fs.unlinkSync(resumePath);

  args.evidence.writeJson("escalation-request.json", event);
  args.evidence.log({ kind: "escalation", event });

  // Mock operator console: create resume signal automatically after documenting the seam,
  // unless WAIT_FOR_HUMAN=1 is set.
  const waitForHuman = process.env.WAIT_FOR_HUMAN === "1";
  const deadline = Date.now() + (args.waitMs || (waitForHuman ? 120000 : 1500));

  if (!waitForHuman) {
    // Simulate human acknowledging and completing a note on the live session.
    fs.writeFileSync(
      resumePath,
      JSON.stringify(
        {
          interventionId: id,
          resumedAt: new Date().toISOString(),
          humanNotes: "Mock operator reviewed live session and signaled resume.",
          ownership: "automation",
        },
        null,
        2
      )
    );
  }

  while (Date.now() < deadline) {
    if (fs.existsSync(resumePath)) {
      const resume = JSON.parse(fs.readFileSync(resumePath, "utf8"));
      event.humanNotes = resume.humanNotes;
      event.ownership = "automation";
      args.surface.resumeAutomation();
      args.evidence.writeJson("escalation-resume.json", resume);
      args.evidence.log({ kind: "handoff_complete", resume });
      return event;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  // Timeout: still resume to avoid hanging demos, but mark notes.
  event.humanNotes = "Timed out waiting for human resume signal";
  event.ownership = "automation";
  args.surface.resumeAutomation();
  return event;
}
