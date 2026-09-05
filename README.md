# no-fs-agent

No-fs-agent is a command-line tool for letting an AI try a small code change before it touches your real repo.

You give it a task, the files it may read, the files it may change, and a test. It keeps a draft, gives you a patch and a receipt, and lets you decide whether to apply it.

The AI runs in a Cloudflare Worker. It has no filesystem, shell, or Node access. It can only list files, read files, write an allowed file, look at its changes, save its work, and finish. Every Worker request needs your run key.

## Install your Worker

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/acoyfellow/no-fs-agent)

Click the button and sign in to your own Cloudflare account. Cloudflare deploys the Worker into that account. Until you finish setup, it refuses every request.

Copy the Worker URL from Cloudflare, then run this once. `init` generates a run key, stores it in your user config, and sets it as a Cloudflare Worker secret through Wrangler's browser login.

```sh
bunx --bun github:acoyfellow/no-fs-agent init \
  --endpoint https://your-worker.your-subdomain.workers.dev \
  --worker no-fs-agent
```

If you prefer the terminal, run `npx wrangler login` and `npx wrangler deploy` from a checkout. The config deliberately contains no account ID. Wrangler asks which of your accounts to use.

## Try a change

Go to a clean git repo. Tell no-fs-agent exactly what it may see, what it may change, and how to check the result:

```sh
cd /path/to/your-repo
bunx --bun github:acoyfellow/no-fs-agent try \
  --task "Fix the greeting bug" \
  --read src/greet.ts \
  --read test/greet.test.ts \
  --write src/greet.ts \
  --check "bun install --frozen-lockfile && bun test"
```

It prints a receipt path like this:

```text
.no-fs-agent/runs/<run-id>/receipt.json
```

Read the patch and the test result. If you want the change, apply that exact receipt:

```sh
bunx --bun github:acoyfellow/no-fs-agent apply \
  .no-fs-agent/runs/<run-id>/receipt.json
```

`apply` checks that the files are still exactly as they were when the run started. If you changed one, it refuses. It does not guess, merge, or overwrite your work.

## What happens

1. The tool checks that your git repo has no tracked changes.
2. It copies only the files you named into a draft stored by the Worker.
3. The Worker lets the model work only through named actions.
4. The Worker saves the proposed patch in that draft. It does not touch your repo.
5. The tool puts that patch in a temporary git worktree and runs your check there.
6. The tool saves the test result back to the draft and writes a local receipt with the task, file hashes, model steps, patch, and test result.
7. You can read the same draft later or apply a passing receipt yourself.

A failed test still leaves a receipt. A model that does not make a usable patch still leaves a receipt. Nothing is applied automatically.

## A real run on this repo

The product proof used no-fs-agent on no-fs-agent itself. The task changed the Worker’s real draft-file limit from 20 to 21 in a temporary copy of this repo.

The model read `src/limits.ts`, changed it, looked at the diff, and saved the change. The Worker kept the draft and the outside check result. An outside `bun` command imported the changed file and checked that the limit was 21. Then the source file was changed by hand and `apply` refused the old receipt.

- [Product proof](proof/product-self-run.json)
- Result: `passed`
- Model steps: `read → write → diff → commit → done`

## Other proof runs

The built-in tasks are still here. They show the Worker part of the product in isolation.

- [Simple bug fix](proof/run-greetall-same-name.json)
- [A file gives bad advice, but the model fixes the real bug](proof/run-misleading-fixture.json)
- [The model improves a blind spot in the checker](proof/run-verifier-sensitivity.json)
- [Two rejected checker attempts](proof/run-verifier-sensitivity-round0-attempt1-unknown-shape.json) and [attempt two](proof/run-verifier-sensitivity-round0-attempt2-unknown-shape.json)

## What it keeps away from the AI

The AI does not get your computer.

- It cannot read files you did not name.
- It cannot change files outside the allowed list.
- It cannot run commands.
- It cannot apply a patch to your repo.
- It cannot open a pull request or deploy code.

Your test command does run on your machine, in a temporary git worktree. That command is yours, not the AI's. It can do whatever you put in `--check`, so use a command you trust.

## What it does not do yet

- It needs a clean git repo.
- It starts from a small list of files; it does not search a large repo for you.
- It keeps small drafts in one Worker. It has no accounts, team sharing, or draft browser yet.
- It does not install itself as a normal `no-fs-agent` command yet.
- It does not open pull requests, merge changes, or deploy.
- It does not prove that every test command is a good test.

## Check this repo

```sh
export NO_FS_RUN_KEY="your-run-key"
bun run prove
bun run product:prove
```

The first command checks the built-in Worker task. The second command runs the standalone product flow against this repo and checks that `apply` refuses a changed source file.
