import "dotenv/config";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { PlaywrightSurface } from "../surface/playwrightSurface.js";
import { createEvidenceWriter } from "../observability/evidence.js";
import { runDiscovery } from "../agent/discover.js";
import { actionsToArtifact, saveArtifact } from "../artifact/recorder.js";
import { isLlmEnabled, resolveLlmConfig } from "../agent/llm.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");

async function main() {
  const baseUrl = process.env.TARGET_BASE_URL || "http://127.0.0.1:3456";
  const memberId = process.argv.find((a) => a.startsWith("--memberId="))?.split("=")[1] || "12345";
  const goal =
    process.argv.find((a) => a.startsWith("--goal="))?.split("=").slice(1).join("=") ||
    `Look up member ${memberId} and read their current savings balance`;

  const runId = `discovery-${Date.now()}`;
  const evidence = createEvidenceWriter(path.join(root, "evidence", "discovery"), runId);
  const surface = new PlaywrightSurface();

  const llmCfg = resolveLlmConfig();
  const llmOn = isLlmEnabled(llmCfg);
  console.log(`Discovery goal: ${goal}`);
  console.log(
    llmOn
      ? `Mode: LLM (${llmCfg.provider} / ${llmCfg.model})`
      : "Mode: heuristic-fallback"
  );

  try {
    const result = await runDiscovery(surface, evidence, {
      goal,
      baseUrl,
      memberIdHint: memberId,
      useLlm: llmOn,
      operatorDir: path.join(root, "operator"),
    });

    const artifact = actionsToArtifact({ actions: result.actions, goal });
    const artifactPath = saveArtifact(artifact, path.join(root, "artifacts"));
    fs.copyFileSync(artifactPath, path.join(root, "evidence", "example-artifact.json"));
    evidence.writeJson("artifact.json", artifact);

    console.log(JSON.stringify({ success: result.success, outputs: result.outputs, artifactPath, evidence: evidence.dir }, null, 2));
    if (!result.success) process.exitCode = 1;
  } finally {
    await surface.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
