import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PlaywrightSurface } from "../surface/playwrightSurface.js";
import { createEvidenceWriter } from "../observability/evidence.js";
import { escalateAndHandoff } from "../escalation/handoff.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");

async function main() {
  const baseUrl = process.env.TARGET_BASE_URL || "http://127.0.0.1:3456";
  const evidence = createEvidenceWriter(path.join(root, "evidence", "handoff"), `handoff-${Date.now()}`);
  const surface = new PlaywrightSurface();
  await surface.launch(true);
  await surface.act({ type: "navigate", url: `${baseUrl}/lookup`, reason: "Open lookup for handoff demo" });

  const event = await escalateAndHandoff({
    surface,
    evidence,
    goal: "Look up member and read savings balance",
    reason: "Simulated stuck state: unexpected dialog / needs human judgment",
    currentStep: "before-submit",
    operatorDir: path.join(root, "operator"),
  });

  console.log(JSON.stringify(event, null, 2));
  await surface.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
