# no-fs-agent

Smallest POC for one claim: **an agent does not need a filesystem, shell, or Node to do real code work.** It needs addressable state, durable authorship, and a boundary it cannot cross.

An LLM agent runs entirely inside a Cloudflare Worker and fixes a planted bug through six verbs against an in-memory tree: `ls`, `read`, `write`, `diff`, `commit`, `done`. No filesystem. No subprocess. No Node. The write grant covers exactly one file, mcpu-style.

## The claim, falsifiably

Claim: the agent fixes `greetAll` (greets everyone with the first user's name) in a three-file tree it cannot see except through verbs, then commits.

It fails in any of these observable ways, all emitted in one JSON receipt:

- `no-change` — the agent finished without touching app.js
- `defect-remains` — the bug pattern survives while the agent claims done (a dishonest-pass detector)
- `fixed-but-uncommitted` — the change exists but was never made durable
- `unknown-shape` — the patch deviates from the frozen verifier's honest expectation (the verifier says so, openly)
- `agent-protocol-failed` — the model cannot operate the verb protocol at all

The verdict comes from a **frozen verifier outside the agent loop**. The agent's own claims never influence the verdict.

## Run

```sh
npx wrangler deploy
echo "$RUN_KEY" | npx wrangler secret put RUN_KEY   # gate AI spend on /run
NO_FS_RUN_KEY="$RUN_KEY" bun run prove
```

`GET /run` requires `Authorization: Bearer $RUN_KEY` when the secret is set, because
a public endpoint that spends Workers AI neurons for anyone is not acceptable on a
personal account. Local dev without the secret stays open.

`bun run prove` hits `GET /run` on the live Worker and fails the exit code unless the receipt shows `invariant-satisfied` — with a real `read` before the `write`, a digest-shaped commit id, and `capabilities: { filesystem: false, subprocess: false, node: false }`.

Live receipt: `GET https://no-fs-agent.coy.workers.dev/run`

## What this is not

- It says nothing about durability across requests (state dies with the request; next step is a Durable Object or a git remote — mcpu's job).
- It says nothing about grants beyond one hardcoded writable path — mcpu already solved that properly.
- It says nothing about deployment authority — no imprint-like verified release here.
- `unknown-shape` means the verifier cannot judge, not that the agent is wrong. The verifier is one frozen predicate, not a code reviewer.

## What it proves if it passes

The middle of the classic agent loop — perceive, change, make durable — needs zero POSIX. The filesystem was a dependency, not a requirement. The rest (durability, authority, verification-as-release) are separable problems with their own owners.
