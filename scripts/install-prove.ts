import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAuthorized } from "../src/worker";

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function run(command: string[], env: Record<string, string>) {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe", env });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exitCode };
}

const absentKeyRequest = new Request("https://example.test/drafts");
if (isAuthorized(absentKeyRequest, {}) || isAuthorized(new Request("https://example.test/drafts", { headers: { Authorization: "Bearer wrong" } }), { RUN_KEY: "right" })) fail("Worker authorization did not fail closed.");
if (!isAuthorized(new Request("https://example.test/drafts", { headers: { Authorization: "Bearer right" } }), { RUN_KEY: "right" })) fail("Worker rejected a correct run key.");

const root = join(import.meta.dir, "..");
const wrangler = await readFile(join(root, "wrangler.jsonc"), "utf8");
if (wrangler.includes('"account_id"')) fail("Reusable Worker config pins an account.");
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { bin?: Record<string, string> };
if (packageJson.bin?.["no-fs-agent"] !== "scripts/cli.ts") fail("Package does not expose the no-fs-agent command.");

const sandbox = await mkdtemp(join(tmpdir(), "no-fs-agent-install-proof-"));
const bin = join(sandbox, "bin");
const config = join(sandbox, "config");
await mkdir(bin, { recursive: true });
await Bun.write(join(bin, "npx"), "#!/bin/sh\ncat >/dev/null\n[ \"$1 $2 $3 $4 $5 $6\" = \"wrangler secret put RUN_KEY --name proof-worker\" ]\n");
await Bun.$`chmod 700 ${join(bin, "npx")}`;

try {
  const result = await run([Bun.which("bun") ?? "bun", join(root, "scripts", "cli.ts"), "init", "--endpoint", "https://proof-worker.example.workers.dev", "--worker", "proof-worker"], { ...process.env, PATH: `${bin}:${process.env.PATH}`, NO_FS_AGENT_CONFIG_DIR: config });
  if (result.exitCode !== 0) fail(`Init failed: ${result.stderr || result.stdout}`);
  const saved = JSON.parse(await readFile(join(config, "config.json"), "utf8")) as { endpoint?: string; runKey?: string };
  if (saved.endpoint !== "https://proof-worker.example.workers.dev" || !/^[a-f0-9]{64}$/.test(saved.runKey ?? "")) fail("Init did not save a valid local configuration.");
} finally {
  await rm(sandbox, { recursive: true, force: true });
}

process.stdout.write("PASS: install configuration fails closed and init stores a keyed endpoint\n");
