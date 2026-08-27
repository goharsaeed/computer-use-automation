import test from "node:test";
import assert from "node:assert/strict";
import { ActionSchema, ArtifactSchema, ReplayResultSchema } from "../types/schemas.js";
import { assertActionAllowed, defaultPolicy } from "../policy/guardrails.js";
import { redactValue } from "../policy/redaction.js";
import { actionsToArtifact } from "../artifact/recorder.js";
import { classifyObservation } from "../replay/classify.js";
import type { Observation } from "../surface/playwrightSurface.js";

const baseObs = (): Observation => ({
  url: "http://127.0.0.1:3456/lookup",
  title: "Lookup",
  textSnippet: "",
  hasMemberIdInput: true,
  hasLookupSubmit: true,
  hasSavingsBalance: false,
  hasErrorPanel: false,
  hasSessionNotice: false,
});

test("action schema accepts click", () => {
  const a = ActionSchema.parse({
    type: "click",
    locator: { strategy: "css", value: "#lookup-submit" },
    reason: "submit",
  });
  assert.equal(a.type, "click");
});

test("policy blocks external host", () => {
  const result = assertActionAllowed(
    { type: "navigate", url: "https://evil.example/login", reason: "x" },
    defaultPolicy,
    "http://127.0.0.1:3456"
  );
  assert.equal(result.ok, false);
});

test("policy allows local lookup", () => {
  const result = assertActionAllowed(
    { type: "navigate", url: "http://127.0.0.1:3456/lookup", reason: "x" },
    defaultPolicy,
    "http://127.0.0.1:3456"
  );
  assert.equal(result.ok, true);
});

test("redacts sensitive keys", () => {
  assert.equal(redactValue("password", "hunter2"), "[REDACTED]");
});

test("artifact schema validates recorder output", () => {
  const art = actionsToArtifact({ actions: [], goal: "lookup" });
  assert.equal(ArtifactSchema.parse(art).id, "lookup-member-savings");
});

test("recorder derives steps from discovery actions", () => {
  const art = actionsToArtifact({
    goal: "lookup member",
    actions: [
      { type: "click", locator: { strategy: "css", value: "#nav-lookup" }, reason: "nav" },
      {
        type: "click",
        locator: { strategy: "css", value: "#dismiss-notice" },
        reason: "dismiss",
      },
      {
        type: "type",
        locator: { strategy: "css", value: "#memberId" },
        text: "12345",
        reason: "type id",
      },
      {
        type: "click",
        locator: { strategy: "css", value: "#lookup-submit" },
        reason: "submit",
      },
      {
        type: "extract",
        name: "savingsBalance",
        locator: { strategy: "css", value: "#savings-balance" },
        reason: "extract",
      },
      { type: "done", reason: "done" },
    ],
  });
  assert.ok(art.steps.every((s) => s.locator?.value !== "#dismiss-notice"));
  assert.equal(art.steps.find((s) => s.action === "type")?.textParam, "memberId");
  assert.ok(art.steps.some((s) => s.extractAs === "savingsBalance"));
  assert.ok(art.steps.some((s) => s.extractAs === "memberName"));
});

test("classifyObservation maps MEMBER_NOT_FOUND to BUSINESS_OUTCOME", () => {
  const c = classifyObservation({
    ...baseObs(),
    hasErrorPanel: true,
    errorCode: "MEMBER_NOT_FOUND",
    errorMessage: "No member",
  });
  assert.equal(c.kind, "BUSINESS_OUTCOME");
});

test("classifyObservation maps session notice to RECOVERABLE", () => {
  const c = classifyObservation({ ...baseObs(), hasSessionNotice: true });
  assert.equal(c.kind, "RECOVERABLE");
  if (c.kind === "RECOVERABLE") {
    assert.equal(c.code, "SESSION_NOTICE");
  }
});

test("ReplayResultSchema accepts RECOVERABLE", () => {
  const r = ReplayResultSchema.parse({
    status: "RECOVERABLE",
    code: "SESSION_NOTICE",
    message: "notice",
    recoveryAction: "click #dismiss-notice",
    stepsCompleted: 1,
  });
  assert.equal(r.status, "RECOVERABLE");
});
