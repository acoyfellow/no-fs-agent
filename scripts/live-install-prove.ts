import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Stage = { name: string; ok: boolean; stdout: string; stderr: string };

async function run(command: string[], cwd: string, env = process.env) {
  const child = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exitCode };
}

function output(stages: Stage[]) {
  process.stdout.write(`${JSON.stringify({ schema: "no-fs-agent.live-install-proof.v0", verdict: stages.every((stage) => stage.ok) ? "passed" : "failed", stages }, null, 2)}\n`);
}

const root = join(import.meta.dir, "..");
const accountId = process.env.NO_FS_INSTALL_PROOF_ACCOUNT_ID;
const workersSubdomain = process.env.NO_FS_INSTALL_PROOF_WORKERS_SUBDOMAIN;
const name = `no-fs-agent-install-proof-${crypto.randomUUID().slice(0, 8)}`;
const sandbox = await mkdtemp(join(tmpdir(), "no-fs-agent-live-install-"));
const repo = join(sandbox, "repo");
const config = join(sandbox, "config");
const stages: Stage[] = [];
let endpoint = "";
let didDeploy = false;

try {
  const expectedEndpoint = accountId && workersSubdomain ? `https://${name}.${workersSubdomain}.workers.dev` : "";
  stages.push({ name: "preflight", ok: Boolean(accountId && workersSubdomain), stdout: expectedEndpoint, stderr: "" });
  if (!expectedEndpoint) throw new Error("Set NO_FS_INSTALL_PROOF_ACCOUNT_ID and NO_FS_INSTALL_PROOF_WORKERS_SUBDOMAIN before running this proof.");
  const deployed = await run(["npx", "wrangler", "deploy", "--name", name], root, { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId });
  didDeploy = deployed.exitCode === 0;
  endpoint = deployed.stdout.match(/https:\/\/[^\s]+\.workers\.dev/)?.[0] ?? "";
  stages.push({ name: "deployed", ok: deployed.exitCode === 0 && endpoint === expectedEndpoint, stdout: deployed.stdout, stderr: deployed.stderr });
  if (endpoint !== expectedEndpoint) throw new Error("deployment did not return the expected personal workers.dev endpoint");

  const locked = await fetch(`${endpoint}/drafts`);
  const lockedText = await locked.text();
  stages.push({ name: "locked", ok: locked.status === 401 && lockedText.includes("run key required"), stdout: `${locked.status} ${lockedText}`, stderr: "" });
  if (locked.status !== 401) throw new Error("fresh Worker was not locked");

  const packageRef = "github:acoyfellow/no-fs-agent#ab5801e";
  const initialized = await run(["bunx", "--bun", packageRef, "init", "--endpoint", endpoint, "--worker", name], sandbox, { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId, NO_FS_AGENT_CONFIG_DIR: config });
  stages.push({ name: "initialized", ok: initialized.exitCode === 0 && initialized.stdout.includes("initialized"), stdout: initialized.stdout, stderr: initialized.stderr });
  if (initialized.exitCode !== 0) throw new Error("init failed");
  const savedConfig = JSON.parse(await readFile(join(config, "config.json"), "utf8")) as { runKey: string };
  let ready = false;
  for (let attempt = 0; attempt < 15; attempt++) {
    const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${savedConfig.runKey}` } });
    if (response.status === 200) { ready = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  stages.push({ name: "secret_ready", ok: ready, stdout: ready ? "200" : "key did not propagate", stderr: "" });
  if (!ready) throw new Error("RUN_KEY did not propagate");

  await run(["git", "init", repo], sandbox);
  await run(["git", "config", "user.email", "proof@example.test"], repo);
  await run(["git", "config", "user.name", "proof"], repo);
  await writeFile(join(repo, "app.js"), "export const value = 20;\n");
  await run(["git", "add", "app.js"], repo);
  await run(["git", "commit", "-m", "fixture"], repo);
  const tried = await run(["bunx", "--bun", packageRef, "try", "--task", "Change app.js so value is 21. Read it, write it, inspect the diff, commit, then done.", "--read", "app.js", "--write", "app.js", "--check", "bun -e \"import('./app.js').then(({value}) => process.exit(value === 21 ? 0 : 1))\""], repo, { ...process.env, NO_FS_AGENT_CONFIG_DIR: config });
  stages.push({ name: "checked_try", ok: tried.exitCode === 0, stdout: tried.stdout, stderr: tried.stderr });
  if (tried.exitCode !== 0) throw new Error("try failed");

  const receipt = JSON.parse(tried.stdout) as { receipt: string };
  await writeFile(join(repo, "app.js"), "export const value = 999;\n");
  const applied = await run(["bunx", "--bun", packageRef, "apply", receipt.receipt], repo, { ...process.env, NO_FS_AGENT_CONFIG_DIR: config });
  stages.push({ name: "stale_apply_refused", ok: applied.exitCode !== 0 && applied.stderr.includes("changed after this run"), stdout: applied.stdout, stderr: applied.stderr });
} catch (error) {
  stages.push({ name: "failure", ok: false, stdout: "", stderr: String(error) });
} finally {
  if (didDeploy) {
    const deleted = await run(["npx", "wrangler", "delete", name, "--force"], root, { ...process.env, ...(accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {}) });
    stages.push({ name: "cleanup", ok: deleted.exitCode === 0, stdout: deleted.stdout, stderr: deleted.stderr });
  } else {
    stages.push({ name: "cleanup", ok: true, stdout: "no Worker deployed", stderr: "" });
  }
  await rm(sandbox, { recursive: true, force: true });
}

output(stages);
if (!stages.every((stage) => stage.ok)) process.exit(1);
