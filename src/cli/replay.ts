import "dotenv/config";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createEvidenceWriter } from "../observability/evidence.js";
import { replayArtifact } from "../replay/engine.js";
import { ArtifactSchema } from "../types/schemas.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");

function arg(name: string, fallback?: string) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : fallback;
}

async function main() {
  const artifactPath =
    arg("artifact") ||
    path.join(root, "artifacts", "lookup-member-savings.v1.0.0.json");
  const memberId = arg("memberId", "12345")!;
  const baseUrl = arg("baseUrl", process.env.TARGET_BASE_URL || "http://127.0.0.1:3456")!;

  if (!fs.existsSync(artifactPath)) {
    console.error(`Artifact not found: ${artifactPath}. Run npm run discover first.`);
    process.exit(1);
  }

  const artifact = ArtifactSchema.parse(JSON.parse(fs.readFileSync(artifactPath, "utf8")));
  const runId = `replay-${memberId}-${Date.now()}`;
  const evidence = createEvidenceWriter(path.join(root, "evidence", "replay"), runId);
  const stopOnRecoverable =
    process.argv.includes("--stop-on-recoverable") || process.env.STOP_ON_RECOVERABLE === "1";

  const result = await replayArtifact(
    artifact,
    { memberId, baseUrl },
    evidence,
    {
      stopOnRecoverable,
      operatorDir: path.join(root, "operator"),
      goal: artifact.description,
    }
  );
  console.log(JSON.stringify(result, null, 2));
  if (result.status === "HARD_FAILURE") process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
