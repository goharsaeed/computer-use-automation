import "dotenv/config";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");

function run(cmd: string, args: string[], env?: NodeJS.ProcessEnv) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: root,
      stdio: "inherit",
      shell: process.platform === "win32",
      env: { ...process.env, ...env },
    });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} => ${code}`))));
  });
}

async function main() {
  console.log("Starting target server...");
  const target = spawn("npx", ["tsx", "target/server.ts"], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  await new Promise((r) => setTimeout(r, 2000));

  try {
    console.log("\n=== DISCOVERY (happy path) ===");
    await run("npx", ["tsx", "src/cli/discover.ts", "--memberId=12345"]);

    console.log("\n=== REPLAY SUCCESS (auto-recover session notice) ===");
    await run("npx", ["tsx", "src/cli/replay.ts", "--memberId=12345"]);

    console.log("\n=== REPLAY BUSINESS OUTCOME (not found) ===");
    await run("npx", ["tsx", "src/cli/replay.ts", "--memberId=99999"]);

    console.log("\n=== REPLAY RECOVERABLE (stop on interstitial) ===");
    await run("npx", ["tsx", "src/cli/replay.ts", "--memberId=12345", "--stop-on-recoverable"]);

    console.log("\n=== ESCALATION HANDOFF DEMO ===");
    await run("npx", ["tsx", "src/cli/escalate-demo.ts"]);

    console.log("\nDemo complete.");
  } finally {
    target.kill("SIGTERM");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
