#!/usr/bin/env bun
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { mkdir } from "node:fs/promises";

type Diff = { path: string; before: string; after: string };

type Proposal = {
  schema?: string;
  verdict?: string;
  diffs?: Diff[];
  verbsLog?: { turn: number; verb: string; ok: boolean }[];
  commits?: { id: string; message: string }[];
  turns?: number;
  workerVersion?: string;
  capabilities?: Record<string, boolean>;
  error?: string;
};

type SourceFile = { path: string; sha256: string };

type Draft = { id: string; state: string; proposal?: Proposal };

type CheckedPatchReceipt = {
  schema: "no-fs-agent.checked-patch.v0";
  id: string;
  createdAt: string;
  source: { repo: string; files: SourceFile[] };
  request: { task: string; readable: string[]; writable: string[]; check: string; endpoint: string };
  draft: { id: string; state: string };
  proposal: Proposal;
  check: { passed: boolean; exitCode: number; stdout: string; stderr: string } | null;
  verdict: "passed" | "failed-test" | "not-proposed";
};

type TryOptions = {
  task: string;
  readable: string[];
  writable: string[];
  check: string;
  endpoint?: string;
};

type LocalConfig = {
  endpoint: string;
  runKey: string;
};

function output(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function configPath() {
  return join(process.env.NO_FS_AGENT_CONFIG_DIR ?? join(homedir(), ".config", "no-fs-agent"), "config.json");
}

async function readLocalConfig(): Promise<LocalConfig | null> {
  try {
    const value = (await Bun.file(configPath()).json()) as Partial<LocalConfig>;
    return typeof value.endpoint === "string" && typeof value.runKey === "string" ? value : null;
  } catch {
    return null;
  }
}

async function writeLocalConfig(config: LocalConfig) {
  const path = configPath();
  await mkdir(join(path, ".."), { recursive: true });
  await Bun.write(path, JSON.stringify(config, null, 2));
}

function generatedRunKey() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function unique(values: string[]) {
  return [...new Set(values)];
}

function optionValues(args: string[], name: string) {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) {
      const value = args[++i];
      if (!value || value.startsWith("--")) fail(`${name} needs a value.`);
      values.push(value);
    }
  }
  return values;
}

function oneOption(args: string[], name: string) {
  const values = optionValues(args, name);
  if (values.length > 1) fail(`${name} may appear once.`);
  return values[0];
}

async function command(command: string[], cwd: string) {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exitCode };
}

async function repoRoot() {
  const result = await command(["git", "rev-parse", "--show-toplevel"], process.cwd());
  if (result.exitCode !== 0) fail("Run no-fs-agent inside a git repository.");
  return result.stdout.trim();
}

async function sha256(value: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function checkedPath(root: string, path: string) {
  if (!path || isAbsolute(path) || path.split(/[\\/]/).includes("..")) fail(`Unsafe path: ${JSON.stringify(path)}.`);
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) fail(`Path is outside the repository: ${JSON.stringify(path)}.`);
  const stat = await Bun.file(absolute).exists();
  if (!stat) fail(`File does not exist: ${path}.`);
  const nodeStat = await import("node:fs/promises").then(({ lstat }) => lstat(absolute));
  if (!nodeStat.isFile()) fail(`Path is not a regular file: ${path}.`);
  return { path: rel, absolute };
}

async function readSources(root: string, paths: string[]) {
  const sources: { path: string; contents: string; sha256: string }[] = [];
  for (const path of paths) {
    const checked = await checkedPath(root, path);
    const contents = await Bun.file(checked.absolute).text();
    sources.push({ path: checked.path, contents, sha256: await sha256(contents) });
  }
  return sources;
}

function parseTry(args: string[]): TryOptions {
  const task = oneOption(args, "--task");
  const readable = unique(optionValues(args, "--read"));
  const writable = unique(optionValues(args, "--write"));
  const check = oneOption(args, "--check");
  const endpoint = oneOption(args, "--endpoint") ?? process.env.NO_FS_AGENT_ENDPOINT;
  if (!task) fail("--task is required.");
  if (task.length > 4_000) fail("--task is too long.");
  if (readable.length === 0) fail("At least one --read path is required.");
  if (writable.length === 0) fail("At least one --write path is required.");
  if (!check) fail("--check is required.");
  if (args.some((arg) => arg.startsWith("--") && !["--task", "--read", "--write", "--check", "--endpoint"].includes(arg))) fail("Unknown option.");
  return { task, readable, writable, check, endpoint: endpoint?.replace(/\/$/, "") };
}

async function ensureClean(root: string) {
  const result = await command(["git", "status", "--porcelain"], root);
  if (result.exitCode !== 0) fail("Could not check git status.");
  if (result.stdout.trim()) fail("Commit or stash tracked changes before starting a run.");
}

function limit(value: string) {
  return value.slice(0, 32_000);
}

async function applyToTestWorktree(root: string, sources: { path: string; contents: string }[], diffs: Diff[], check: string) {
  const path = join(tmpdir(), `no-fs-agent-check-${crypto.randomUUID()}`);
  const added = await command(["git", "worktree", "add", "--detach", path, "HEAD"], root);
  if (added.exitCode !== 0) fail(`Could not make a test copy: ${limit(added.stderr)}`);
  try {
    for (const source of sources) await Bun.write(join(path, source.path), source.contents);
    for (const diff of diffs) await Bun.write(join(path, diff.path), diff.after);
    const result = await command(["/bin/bash", "-lc", check], path);
    return { passed: result.exitCode === 0, exitCode: result.exitCode, stdout: limit(result.stdout), stderr: limit(result.stderr) };
  } finally {
    await command(["git", "worktree", "remove", "--force", path], root);
  }
}

function validProposal(proposal: Proposal, writable: string[]) {
  if (proposal.verdict !== "proposed" || !Array.isArray(proposal.diffs) || proposal.diffs.length === 0) return false;
  const paths = proposal.diffs.map((diff) => diff.path);
  return unique(paths).length === paths.length && paths.every((path) => writable.includes(path));
}

async function saveReceipt(root: string, receipt: CheckedPatchReceipt) {
  const directory = join(root, ".no-fs-agent", "runs", receipt.id);
  await mkdir(directory, { recursive: true });
  await Bun.write(join(directory, "receipt.json"), JSON.stringify(receipt, null, 2));
  return join(directory, "receipt.json");
}

async function tryTask(args: string[]) {
  const options = parseTry(args);
  const config = await readLocalConfig();
  const endpoint = options.endpoint ?? process.env.NO_FS_AGENT_ENDPOINT ?? config?.endpoint;
  if (!endpoint) fail("Run no-fs-agent init or set NO_FS_AGENT_ENDPOINT.");
  const runKey = process.env.NO_FS_RUN_KEY ?? config?.runKey;
  if (!runKey) fail("Run no-fs-agent init or set NO_FS_RUN_KEY.");
  const root = await repoRoot();
  await ensureClean(root);
  const readable = unique([...options.readable, ...options.writable]);
  const sources = await readSources(root, readable);
  const writable = unique((await Promise.all(options.writable.map((path) => checkedPath(root, path)))).map((file) => file.path));
  const files = Object.fromEntries(sources.map((source) => [source.path, source.contents]));
  const headers = { Authorization: `Bearer ${runKey}`, "content-type": "application/json" };
  const createdResponse = await fetch(`${endpoint}/drafts`, {
    method: "POST",
    headers,
    body: JSON.stringify({ task: options.task, files, writable }),
    signal: AbortSignal.timeout(270_000),
  });
  const created = (await createdResponse.json()) as Draft;
  if (!createdResponse.ok || !created.id) fail(`Worker refused the task: ${JSON.stringify(created)}`);

  const runResponse = await fetch(`${endpoint}/drafts/${created.id}/run`, { method: "POST", headers, signal: AbortSignal.timeout(270_000) });
  const draft = (await runResponse.json()) as Draft;
  if (!runResponse.ok || !draft.proposal) fail(`Worker could not run the draft: ${JSON.stringify(draft)}`);
  const proposal = draft.proposal;

  const id = crypto.randomUUID();
  const source = { repo: root, files: sources.map(({ path, sha256 }) => ({ path, sha256 })) };
  const request = { task: options.task, readable, writable, check: options.check, endpoint };
  let receipt: CheckedPatchReceipt;
  if (!validProposal(proposal, writable)) {
    receipt = { schema: "no-fs-agent.checked-patch.v0", id, createdAt: new Date().toISOString(), source, request, draft: { id: created.id, state: draft.state }, proposal, check: null, verdict: "not-proposed" };
  } else {
    const diffs = proposal.diffs ?? [];
    const sourceByPath = new Map(sources.map((item) => [item.path, item.contents]));
    if (diffs.some((diff) => sourceByPath.get(diff.path) !== diff.before || typeof diff.after !== "string")) fail("Worker returned a patch that does not match the draft it received.");
    const check = await applyToTestWorktree(root, sources, diffs, options.check);
    const checkedResponse = await fetch(`${endpoint}/drafts/${created.id}/check`, { method: "POST", headers, body: JSON.stringify(check), signal: AbortSignal.timeout(30_000) });
    const checked = (await checkedResponse.json()) as Draft;
    if (!checkedResponse.ok) fail(`Worker could not save the check: ${JSON.stringify(checked)}`);
    receipt = { schema: "no-fs-agent.checked-patch.v0", id, createdAt: new Date().toISOString(), source, request, draft: { id: created.id, state: checked.state }, proposal, check, verdict: check.passed ? "passed" : "failed-test" };
  }
  const receiptPath = await saveReceipt(root, receipt);
  output({ id, verdict: receipt.verdict, receipt: receiptPath });
  if (receipt.verdict !== "passed") process.exit(1);
}

async function initTask(args: string[]) {
  const endpoint = oneOption(args, "--endpoint");
  const worker = oneOption(args, "--worker");
  if (!endpoint || !worker || args.some((arg) => arg.startsWith("--") && !["--endpoint", "--worker"].includes(arg))) fail("Usage: no-fs-agent init --endpoint <https://worker.workers.dev> --worker <worker-name>.");
  const runKey = generatedRunKey();
  const node = Bun.which("node");
  const npx = Bun.which("npx");
  if (!node || !npx) fail("init requires Node.js and npx to set the Worker secret.");
  const child = Bun.spawn([node, npx, "wrangler", "secret", "put", "RUN_KEY", "--name", worker], { stdin: new Blob([runKey]).stream(), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exitCode !== 0) fail(`Could not set RUN_KEY with Wrangler: ${stderr || stdout}`);
  await writeLocalConfig({ endpoint: endpoint.replace(/\/$/, ""), runKey });
  output({ verdict: "initialized", endpoint: endpoint.replace(/\/$/, ""), config: configPath() });
}

async function applyReceipt(args: string[]) {
  const receiptPath = args[0];
  if (!receiptPath || args.length !== 1) fail("Usage: no-fs-agent apply <receipt.json>.");
  const receipt = JSON.parse(await Bun.file(receiptPath).text()) as CheckedPatchReceipt;
  if (receipt.schema !== "no-fs-agent.checked-patch.v0" || receipt.verdict !== "passed") fail("Only a passing no-fs-agent receipt can be applied.");
  const root = await repoRoot();
  if (root !== receipt.source.repo) fail("Run apply from the repository that created this receipt.");
  const sourceByPath = new Map(receipt.source.files.map((file) => [file.path, file.sha256]));
  for (const [path, expected] of sourceByPath) {
    const checked = await checkedPath(root, path);
    if (await sha256(await Bun.file(checked.absolute).text()) !== expected) fail(`Refused: ${path} changed after this run.`);
  }
  for (const diff of receipt.proposal.diffs ?? []) {
    if (!receipt.request.writable.includes(diff.path)) fail(`Refused: receipt changes a file outside its grant.`);
    const expected = sourceByPath.get(diff.path);
    if (!expected || (await sha256(diff.before)) !== expected) fail(`Refused: receipt does not match its source draft for ${diff.path}.`);
    const checked = await checkedPath(root, diff.path);
    await Bun.write(checked.absolute, diff.after);
  }
  output({ id: receipt.id, verdict: "applied", files: (receipt.proposal.diffs ?? []).map((diff) => diff.path) });
}

const [commandName, ...args] = process.argv.slice(2);
if (commandName === "init") await initTask(args);
else if (commandName === "try") await tryTask(args);
else if (commandName === "apply") await applyReceipt(args);
else fail("Usage: no-fs-agent <init|try|apply> ...");
