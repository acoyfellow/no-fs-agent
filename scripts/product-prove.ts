import { readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

type Receipt = {
  verdict: string;
  source: { repo: string; files: { path: string; sha256: string }[] };
  request: { task: string; readable: string[]; writable: string[]; check: string };
  proposal: { verdict?: string; diffs?: { path: string; before: string; after: string }[]; turns?: number; commits?: unknown[] };
  check: { passed: boolean; exitCode: number } | null;
};

async function run(command: string[], cwd: string) {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe", env: process.env });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exitCode };
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const runKey = process.env.NO_FS_RUN_KEY;
if (!runKey) fail("Set NO_FS_RUN_KEY before running the product proof.");

const sourceRoot = process.cwd();
const worktree = join(tmpdir(), `no-fs-agent-product-proof-${crypto.randomUUID()}`);
const added = await run(["git", "worktree", "add", "--detach", worktree, "HEAD"], sourceRoot);
if (added.exitCode !== 0) fail(`Could not create proof worktree: ${added.stderr}`);

try {
  const cli = resolve(sourceRoot, "scripts", "cli.ts");
  const task = "In src/limits.ts, change export const MAX_DRAFT_FILES = 20; to export const MAX_DRAFT_FILES = 21;. Change nothing else. Read the file first, make the edit, inspect the diff, commit, then done.";
  const tried = await run(
    [
      Bun.which("bun") ?? "bun",
      cli,
      "try",
      "--task",
      task,
      "--read",
      "src/limits.ts",
      "--write",
      "src/limits.ts",
      "--check",
      "bun -e \"import('./src/limits.ts').then(({ MAX_DRAFT_FILES }) => process.exit(MAX_DRAFT_FILES === 21 ? 0 : 1))\"",
    ],
    worktree,
  );
  if (tried.exitCode !== 0) fail(`The checked patch did not pass: ${tried.stderr || tried.stdout}`);
  const result = JSON.parse(tried.stdout) as { verdict: string; receipt: string };
  if (result.verdict !== "passed") fail("The product did not return a passing receipt.");
  const receipt = JSON.parse(await readFile(result.receipt, "utf8")) as Receipt;
  if (receipt.verdict !== "passed" || !receipt.check?.passed || receipt.proposal.verdict !== "proposed") fail("The receipt does not prove a checked proposal.");
  if (!receipt.proposal.diffs?.some((diff) => diff.path === "src/limits.ts" && diff.after.includes("export const MAX_DRAFT_FILES = 21;"))) fail("The receipt lacks the expected source change.");

  const changedSource = join(worktree, "src", "limits.ts");
  const current = await readFile(changedSource, "utf8");
  await writeFile(changedSource, current.replace("export const MAX_DRAFT_FILES = 20;", "export const MAX_DRAFT_FILES = 999;"));
  const applied = await run([Bun.which("bun") ?? "bun", cli, "apply", result.receipt], worktree);
  if (applied.exitCode === 0 || !applied.stderr.includes("changed after this run")) fail("Apply did not refuse changed source.");

  const proof = {
    schema: "no-fs-agent.product-proof.v0",
    task: receipt.request.task,
    source_files: receipt.source.files.map((file) => ({ path: file.path, sha256: file.sha256 })),
    proposal: receipt.proposal,
    check: receipt.check,
    verdict: receipt.verdict,
    apply_after_source_change: "refused",
  };
  await Bun.write(join(sourceRoot, "proof", "product-self-run.json"), JSON.stringify(proof, null, 2));
  process.stdout.write("PASS: checked patch receipt created and changed source refused by apply\n");
} finally {
  await run(["git", "worktree", "remove", "--force", worktree], sourceRoot);
}
