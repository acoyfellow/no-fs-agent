const origin = process.argv[2] ?? "https://no-fs-agent.coy.workers.dev";
const localRunKey = (await Bun.file(".run-key").exists()) ? (await Bun.file(".run-key").text()).trim() : "";
const runKey = process.argv[3] ?? process.env.NO_FS_RUN_KEY ?? localRunKey;

interface Receipt {
  schema: string;
  scenario: string;
  workerVersion: string;
  model: string;
  verdict: string;
  turns: number;
  commits: { id: string; message: string }[];
  appJsSha: string;
  verbsLog: { turn: number; verb: string; ok: boolean }[];
  capabilities: { filesystem: boolean; subprocess: boolean; node: boolean };
}

const response = await fetch(`${origin}/run`, {
  headers: runKey ? { Authorization: `Bearer ${runKey}` } : {},
});
if (!response.ok) {
  console.error(`FAIL: ${origin}/run returned ${response.status}`);
  process.exit(1);
}

const receipt = (await response.json()) as Receipt;
const failures: string[] = [];

if (receipt.schema !== "no-fs-agent.receipt.v0") failures.push(`unexpected schema: ${receipt.schema}`);
if (receipt.verdict !== "invariant-satisfied") failures.push(`verdict: ${receipt.verdict} (expected invariant-satisfied)`);
if (receipt.capabilities.filesystem !== false) failures.push("receipt claims filesystem use");
if (receipt.capabilities.subprocess !== false) failures.push("receipt claims subprocess use");
if (receipt.turns < 3) failures.push(`turns: ${receipt.turns} (fix with no read?)`);

const sequence = receipt.verbsLog.map((v) => v.verb);
for (const verb of ["read", "write", "commit", "done"]) {
  if (!sequence.includes(verb)) failures.push(`missing verb in log: ${verb}`);
}
const readIndex = sequence.indexOf("read");
const writeIndex = sequence.indexOf("write");
if (readIndex === -1 || writeIndex === -1 || readIndex > writeIndex) failures.push("wrote before reading");

if (!commitLooksWellFormed(receipt)) failures.push("expected one commit with a digest-shaped id");

function commitLooksWellFormed(r: Receipt): boolean {
  return r.commits.length > 0 && /^c[0-9a-f]{12}$/.test(r.commits[0].id);
}

if (failures.length > 0) {
  console.error(`FAIL: no-fs-agent proof failed with ${failures.length} finding(s)`);
  for (const f of failures) console.error(` - ${f}`);
  console.error(JSON.stringify(receipt, null, 2));
  process.exit(1);
}

console.log(`PASS: ${receipt.scenario} fixed in ${receipt.turns} turns, commit ${receipt.commits[0].id}, verdict ${receipt.verdict}`);
console.log(`capabilities: filesystem=${receipt.capabilities.filesystem} subprocess=${receipt.capabilities.subprocess} node=${receipt.capabilities.node}`);
