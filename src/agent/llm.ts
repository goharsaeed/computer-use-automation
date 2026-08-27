import OpenAI from "openai";

export type LlmProvider = "ollama" | "openai" | "none";

export type LlmConfig = {
  provider: LlmProvider;
  model: string;
  baseURL?: string;
  apiKey?: string;
};

/**
 * Resolution order:
 * 1. LLM_PROVIDER=none|heuristic → no LLM
 * 2. LLM_PROVIDER=openai (or OPENAI_API_KEY set with provider unset/openai) → OpenAI
 * 3. Otherwise → Ollama (local default)
 */
export function resolveLlmConfig(): LlmConfig {
  const provider = (process.env.LLM_PROVIDER || "").toLowerCase().trim();

  if (provider === "none" || provider === "heuristic") {
    return { provider: "none", model: "" };
  }

  if (provider === "openai" || (provider !== "ollama" && process.env.OPENAI_API_KEY)) {
    return {
      provider: "openai",
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL || undefined,
    };
  }

  return {
    provider: "ollama",
    model: process.env.OLLAMA_MODEL || "llama3.2:3b",
    baseURL: process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434/v1",
    apiKey: process.env.OLLAMA_API_KEY || "ollama",
  };
}

export function isLlmEnabled(cfg: LlmConfig = resolveLlmConfig()): boolean {
  if (cfg.provider === "ollama") return process.env.OLLAMA_ENABLED !== "0";
  if (cfg.provider === "openai") return Boolean(cfg.apiKey);
  return false;
}

export function createLlmClient(cfg: LlmConfig = resolveLlmConfig()): OpenAI {
  if (cfg.provider === "none") {
    throw new Error("LLM provider is none");
  }
  return new OpenAI({
    apiKey: cfg.apiKey || "ollama",
    baseURL: cfg.baseURL,
  });
}

/** Extract first JSON object from model text (handles markdown fences / chatter). */
export function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* continue */
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    return JSON.parse(fence[1].trim());
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1));
  }
  throw new Error(`Could not parse LLM JSON: ${trimmed.slice(0, 200)}`);
}
