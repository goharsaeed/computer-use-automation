import { z } from "zod";

/** Structured action the LLM (or recorder) may propose. */
export const ActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("navigate"),
    url: z.string(),
    reason: z.string(),
  }),
  z.object({
    type: z.literal("click"),
    locator: z.object({
      strategy: z.enum(["role", "label", "text", "css", "testid"]),
      value: z.string(),
      rationale: z.string().optional(),
    }),
    reason: z.string(),
  }),
  z.object({
    type: z.literal("type"),
    locator: z.object({
      strategy: z.enum(["role", "label", "text", "css", "testid"]),
      value: z.string(),
      rationale: z.string().optional(),
    }),
    text: z.string(),
    clear: z.boolean().optional(),
    reason: z.string(),
  }),
  z.object({
    type: z.literal("extract"),
    name: z.string(),
    locator: z.object({
      strategy: z.enum(["role", "label", "text", "css", "testid"]),
      value: z.string(),
      rationale: z.string().optional(),
    }),
    reason: z.string(),
  }),
  z.object({
    type: z.literal("done"),
    reason: z.string(),
  }),
  z.object({
    type: z.literal("escalate"),
    reason: z.string(),
  }),
]);

export type Action = z.infer<typeof ActionSchema>;

export const LocatorSchema = z.object({
  strategy: z.enum(["role", "label", "text", "css", "testid"]),
  value: z.string(),
  rationale: z.string(),
});

export const ArtifactStepSchema = z.object({
  id: z.string(),
  action: z.enum(["navigate", "click", "type", "extract"]),
  description: z.string(),
  urlTemplate: z.string().optional(),
  locator: LocatorSchema.optional(),
  textParam: z.string().optional(), // parameter name whose value is typed
  textLiteral: z.string().optional(),
  extractAs: z.string().optional(),
});

export const ArtifactSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string(),
  target: z.object({
    kind: z.literal("web"),
    baseUrlParam: z.string().default("baseUrl"),
    entryPath: z.string(),
  }),
  inputs: z.array(
    z.object({
      name: z.string(),
      type: z.enum(["string", "number"]),
      description: z.string(),
      required: z.boolean(),
    })
  ),
  outputs: z.array(
    z.object({
      name: z.string(),
      type: z.enum(["string", "number", "money"]),
      description: z.string(),
    })
  ),
  steps: z.array(ArtifactStepSchema),
  checkpoint: z.object({
    description: z.string(),
    locator: LocatorSchema,
  }),
  policyRef: z.string(),
  createdAt: z.string(),
});

export type Artifact = z.infer<typeof ArtifactSchema>;

export const ReplayResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("SUCCESS"),
    outputs: z.record(z.string()),
    stepsCompleted: z.number(),
    evidenceDir: z.string().optional(),
  }),
  z.object({
    status: z.literal("BUSINESS_OUTCOME"),
    code: z.string(),
    message: z.string(),
    stepsCompleted: z.number(),
    evidenceDir: z.string().optional(),
  }),
  z.object({
    status: z.literal("RECOVERABLE"),
    code: z.string(),
    message: z.string(),
    recoveryAction: z.string(),
    stepsCompleted: z.number(),
    evidenceDir: z.string().optional(),
  }),
  z.object({
    status: z.literal("HARD_FAILURE"),
    stepId: z.string().optional(),
    expected: z.string(),
    observed: z.string(),
    message: z.string(),
    stepsCompleted: z.number().optional(),
    evidenceDir: z.string().optional(),
  }),
]);

export type ReplayResult = z.infer<typeof ReplayResultSchema>;

export const PolicySchema = z.object({
  allowedHosts: z.array(z.string()),
  allowedPathPrefixes: z.array(z.string()),
  allowedActionTypes: z.array(
    z.enum(["navigate", "click", "type", "extract", "done", "escalate"])
  ),
  riskyActions: z.array(z.string()),
});

export type Policy = z.infer<typeof PolicySchema>;

export const EscalationEventSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  reason: z.string(),
  goal: z.string(),
  capabilityId: z.string().optional(),
  currentStep: z.string().optional(),
  ownership: z.enum(["automation", "human"]),
  screenshotPath: z.string().optional(),
  stateSummary: z.string().optional(),
  humanNotes: z.string().optional(),
});

export type EscalationEvent = z.infer<typeof EscalationEventSchema>;
