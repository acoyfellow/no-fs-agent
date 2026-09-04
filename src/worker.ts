export interface Env {
  AI: Ai;
  RUN_KEY?: string;
}

const WORKER_VERSION = "no-fs-agent@0.1.0";
const MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MAX_TURNS = 6;
const MAX_INVALID = 3;

const SCENARIO_ID = "greetall-same-name";

const START_TREE: Record<string, string> = {
  "app.js": [
    "export function greetAll(users) {",
    "  const name = users[0];",
    "  return users.map(() => `hello ${name}`);",
    "}",
    "",
  ].join("\n"),
  "BUG.md": [
    "# greetAll greets everyone with the same name",
    "",
    "greetAll(['ada', 'grace']) returns ['hello ada', 'hello ada'].",
    "Expected: ['hello ada', 'hello grace']. Each person gets their own name.",
    "",
  ].join("\n"),
  "README.md": ["# tiny app", "", "One function: greetAll(users).", ""].join("\n"),
};

const GRANTS = { writable: ["app.js"] } as const;

const SYSTEM_PROMPT = [
  "You are an agent fixing a bug in a tiny JavaScript app.",
  "You have no filesystem and no shell. You act ONLY through these verbs, one per turn.",
  "Reply with exactly one JSON object and nothing else, every turn:",
  '{"verb":"ls"}',
  '{"verb":"read","path":"<file>"}',
  '{"verb":"write","path":"<file>","contents":"<full new file contents>"}',
  '{"verb":"diff"}',
  '{"verb":"commit","message":"<message>"}',
  '{"verb":"done"}',
  "Only app.js is writable. README.md and BUG.md are read-only.",
  "When the bug is fixed and committed, call done.",
].join("\n");

const TASK = "BUG.md describes a defect in app.js. Read the files, fix app.js so every user gets their own name, commit, then done.";

function extractJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    return typeof value.verb === "string" ? value : null;
  } catch {
    return null;
  }
}

async function treeDigest(tree: Record<string, string>): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(tree));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash).slice(0, 6), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function runScenario(env: Env): Promise<Record<string, unknown>> {
  const tree: Record<string, string> = { ...START_TREE };
  const commits: { id: string; message: string }[] = [];
  const verbsLog: { turn: number; verb: string; ok: boolean; note?: string }[] = [];
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: TASK },
    { role: "assistant", content: '{"verb":"ls"}' },
    { role: "user", content: `RESULT: ${JSON.stringify({ files: Object.keys(tree) })}` },
  ];

  let turns = 0;
  let invalid = 0;
  let stopReason = "max-turns";

  while (turns < MAX_TURNS) {
    const aiResult = (await env.AI.run(MODEL_ID, { messages, temperature: 0 })) as {
      response?: unknown;
      choices?: { message?: { content?: string } }[];
    };
    const choiceContent = aiResult.choices?.[0]?.message?.content;
    const reply =
      typeof aiResult.response === "string"
        ? aiResult.response
        : typeof choiceContent === "string"
          ? choiceContent
          : JSON.stringify(aiResult.response ?? aiResult);
    if (typeof reply !== "string" || reply.length === 0) {
      const excerpt = JSON.stringify(aiResult)?.slice(0, 900);
      throw new Error(`ai-response-shape: ${excerpt}`);
    }
    const call = extractJsonObject(reply);
    messages.push({ role: "assistant", content: reply });
    turns++;

    if (!call) {
      invalid++;
      verbsLog.push({ turn: turns, verb: "(unparseable)", ok: false });
      messages.push({ role: "user", content: "INVALID. Reply with exactly one JSON verb object and nothing else." });
      if (invalid >= MAX_INVALID) {
        stopReason = "agent-protocol-failed";
        verbsLog.length = Math.min(verbsLog.length, 12);
        break;
      }
      continue;
    }

    const verb = call.verb as string;
    let result: Record<string, unknown>;
    switch (verb) {
      case "ls":
        result = { files: Object.keys(tree) };
        break;
      case "read": {
        const path = String(call.path ?? "");
        result = path in tree ? { path, contents: tree[path] } : { error: "no such file" };
        break;
      }
      case "write": {
        const path = String(call.path ?? "");
        const contents = String(call.contents ?? "");
        if (!GRANTS.writable.includes(path as never)) {
          result = { error: "403 not writable" };
        } else {
          const previous = tree[path];
          tree[path] = contents;
          result = { path, ok: true, changed: previous !== contents };
        }
        break;
      }
      case "diff": {
        const changed = Object.keys(tree).filter((p) => tree[p] !== START_TREE[p]);
        result = { changed };
        break;
      }
      case "commit": {
        const message = String(call.message ?? "").slice(0, 120);
        const id = `c${await treeDigest(tree)}`;
        commits.push({ id, message });
        result = { id, files: Object.keys(tree).length };
        break;
      }
      case "done":
        result = { ok: true };
        break;
      default:
        result = { error: `unknown verb ${JSON.stringify(verb)}` };
    }

    verbsLog.push({ turn: turns, verb, ok: !("error" in result), note: "error" in result ? String(result.error) : undefined });
    messages.push({ role: "user", content: `RESULT: ${JSON.stringify(result)}` });

    if (verb === "done") {
      stopReason = "done";
      break;
    }
  }

  const src = tree["app.js"] ?? "";
  const changed = src !== START_TREE["app.js"];
  const stillBuggy = /const name = users\[0\]/.test(src) && src.includes("hello ${name}");
  const perUserGreeting = /users\.map\(\s*\(?[\w$]+\s*\)?\s*=>\s*`hello \$\{[\w$]+\}`\)/.test(src);

  let verdict: string;
  if (stopReason === "agent-protocol-failed") verdict = "agent-protocol-failed";
  else if (!changed) verdict = "no-change";
  else if (stillBuggy) verdict = "defect-remains";
  else if (!perUserGreeting) verdict = "unknown-shape";
  else if (commits.length === 0) verdict = "fixed-but-uncommitted";
  else verdict = "invariant-satisfied";

  return {
    schema: "no-fs-agent.receipt.v0",
    scenario: SCENARIO_ID,
    workerVersion: WORKER_VERSION,
    model: MODEL_ID,
    verdict,
    stopReason,
    turns,
    commits,
    appJsSha: await treeDigest({ "app.js": src }),
    verbsLog: verbsLog.slice(0, 24),
    capabilities: { filesystem: false, subprocess: false, node: false },
    grants: GRANTS,
    notes: [
      "Agent acted only through six verbs against an in-memory tree.",
      "Verdict comes from a frozen verifier outside the agent loop; the agent's own claims are ignored.",
      "Proves nothing about durability across requests, git remotes, or mcpu-grade grants.",
    ],
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      return Response.json({
        name: WORKER_VERSION,
        claim: "An LLM agent can read code, fix a planted bug, diff, and commit with no filesystem, shell, or Node.",
        links: { run: "/run", source: "https://github.com/acoyfellow/no-fs-agent" },
      });
    }
    if (url.pathname === "/run") {
      if (env.RUN_KEY && request.headers.get("Authorization") !== `Bearer ${env.RUN_KEY}`) {
        return Response.json({ error: "run key required", header: "Authorization: Bearer" }, { status: 401 });
      }
      try {
        return Response.json(await runScenario(env));
      } catch (error) {
        return Response.json({
          schema: "no-fs-agent.receipt.v0",
          scenario: SCENARIO_ID,
          workerVersion: WORKER_VERSION,
          verdict: "runner-error",
          error: String(error),
        });
      }
    }
    return new Response("not found", { status: 404 });
  },
};

interface ChatCompletionMessageParam {
  role: "system" | "user" | "assistant";
  content: string;
}
