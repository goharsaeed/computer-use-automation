import fs from "node:fs";
import path from "node:path";
import { redactObject, redactText } from "../policy/redaction.js";

export type EvidenceWriter = {
  dir: string;
  log: (event: Record<string, unknown>) => void;
  writeJson: (name: string, data: unknown) => string;
  writeText: (name: string, text: string) => string;
};

export function createEvidenceWriter(baseDir: string, runId: string): EvidenceWriter {
  const dir = path.join(baseDir, runId);
  fs.mkdirSync(dir, { recursive: true });
  const logPath = path.join(dir, "events.jsonl");

  return {
    dir,
    log(event) {
      const safe = redactObject(event);
      fs.appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), ...safe }) + "\n");
    },
    writeJson(name, data) {
      const p = path.join(dir, name);
      fs.writeFileSync(p, JSON.stringify(redactObject(data as Record<string, unknown>), null, 2));
      return p;
    },
    writeText(name, text) {
      const p = path.join(dir, name);
      fs.writeFileSync(p, redactText(text));
      return p;
    },
  };
}
