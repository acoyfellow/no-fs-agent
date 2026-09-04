const origin = process.env.NO_FS_AGENT_ORIGIN ?? "https://no-fs-agent.coy.workers.dev";
const scenario = process.env.NO_FS_AGENT_SCENARIO ?? "greetall-same-name";
const runKeyFile = process.env.NO_FS_AGENT_RUN_KEY_FILE;

function result(status: string, summary: string, items: unknown[]) {
  process.stdout.write(`${JSON.stringify({ status, summary, items })}\n`);
}

if (!runKeyFile) {
  result("blocked", "No-fs-agent run-key file is not configured.", [
    { kind: "configuration", required: "NO_FS_AGENT_RUN_KEY_FILE" },
  ]);
  process.exit(0);
}

let runKey: string;
try {
  runKey = (await Bun.file(runKeyFile).text()).trim();
} catch {
  result("blocked", "No-fs-agent run-key file is unavailable.", [
    { kind: "credential" },
  ]);
  process.exit(0);
}

if (!runKey) {
  result("blocked", "No-fs-agent run-key file is empty.", [{ kind: "credential" }]);
  process.exit(0);
}

try {
  const response = await fetch(`${origin}/run?scenario=${encodeURIComponent(scenario)}`, {
    headers: { Authorization: `Bearer ${runKey}` },
    signal: AbortSignal.timeout(270_000),
  });

  if (!response.ok) {
    result("blocked", "No-fs-agent did not return a receipt.", [
      { kind: "http", status: response.status, scenario },
    ]);
    process.exit(0);
  }

  const receipt = (await response.json()) as {
    verdict?: unknown;
    turns?: unknown;
    workerVersion?: unknown;
    commits?: unknown;
    diffs?: unknown;
  };
  const verdict = typeof receipt.verdict === "string" ? receipt.verdict : "missing-verdict";
  const passed = verdict === "invariant-satisfied";
  const status = passed ? "pass" : verdict === "unknown-shape" ? "actionable" : "blocked";
  result(status, `No-fs-agent ${scenario}: ${verdict}.`, [
    {
      kind: "no-fs-agent-receipt",
      scenario,
      verdict,
      turns: receipt.turns ?? null,
      worker_version: receipt.workerVersion ?? null,
      commits: receipt.commits ?? [],
      diffs: receipt.diffs ?? [],
    },
  ]);
} catch (error) {
  result("blocked", "No-fs-agent check could not reach the Worker.", [
    { kind: "network", scenario, error: String(error) },
  ]);
}
