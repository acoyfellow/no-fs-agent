# no-fs-agent

This repo is a small proof.

A model fixed a bug while running inside a Cloudflare Worker. It did not have a filesystem, a shell, or Node. It could only ask to list files, read files, write one allowed file, see its changes, save its work, and finish.

The model took six steps:

```text
read → read → write → diff → commit → done
```

An ordinary program checked the result. The model saying it was done did not count as proof.

The live Worker is here: https://no-fs-agent.coy.workers.dev/

## The proof

The main task starts with a small broken function. It says hello to every person using the first person's name.

The model fixed it and saved the change. The checker said the fix was good.

- [Main receipt](proof/run-greetall-same-name.json)
- Result: `invariant-satisfied`
- Steps: 6
- Saved change: `c098e949db066`

Each receipt includes the old file, the new file, the steps the model took, and the saved change. You can read the proof without running the Worker yourself.

## Things we tried

### A file that lies

One task includes a `MAINTAINER.md` file that says nothing is wrong and tells the model not to edit the code. The actual bug is still there.

The model read the evidence, ignored the bad advice, fixed the bug, and saved the change.

- [Receipt for the lying-file task](proof/run-misleading-fixture.json)

### Checking the checker

The checker had a real blind spot. It could miss code that used `users.at(0)` or `users[ 0 ]` to make the same bad greeting.

We gave the model a copy of that checker, the bad examples, and one good example. The model had to improve the checker without making it reject the good example.

The first two attempts were not accepted. They are kept here:

- [First failed attempt](proof/run-verifier-sensitivity-round0-attempt1-unknown-shape.json)
- [Second failed attempt](proof/run-verifier-sensitivity-round0-attempt2-unknown-shape.json)

The third attempt passed. The outside checker took the regexes the model wrote and ran them against all the examples. Then a human copied that fix into the real checker and ran the earlier tasks again.

- [Passing checker receipt](proof/run-verifier-sensitivity.json)

## Run it yourself

You need a Cloudflare account with Workers AI and `wrangler`.

```sh
npx wrangler deploy
echo "$RUN_KEY" | npx wrangler secret put RUN_KEY
NO_FS_RUN_KEY="$RUN_KEY" bun run prove
```

The proof script calls the live Worker. It exits with an error unless the model really fixed the bug, read before it wrote, saved the change, and had no filesystem, shell, or Node access.

The Worker needs `Authorization: Bearer $RUN_KEY` to run a task. This stops strangers from spending your Workers AI credits. Local development works without the secret.

## Home proof

Home is the local program that keeps track of work over time. It can run this check and save the result.

The adapter is [scripts/home-loop-check.ts](scripts/home-loop-check.ts). It runs no-fs-agent and turns its result into the small JSON shape Home expects:

```json
{
  "status": "pass",
  "summary": "No-fs-agent greetall-same-name: invariant-satisfied."
}
```

This was run for real. Home saved a passing result in 3.6 seconds. Its saved result includes the model's change and the outside check.

- [Home proof](proof/home-loop-proof.json)
- [Adapter result](proof/home-loop-check-direct.json)

To add the loop to Home after you set `RUN_KEY` above:

```sh
umask 077
printf '%s' "$RUN_KEY" > "$HOME/Library/Application Support/Home/no-fs-agent-run.token"
homectl loop-add ./home-loop.json
homectl loop-resume no-fs-agent-gate
homectl loop-check no-fs-agent-gate
homectl loop-pause no-fs-agent-gate
```

The loop file does not contain the secret. The secret stays in a local file that only your user can read. The loop is left paused after the proof, so it does not keep using AI credits.

## What this shows

For this small task, a model did useful code work without access to a computer's normal file and command tools. A small set of named actions was enough.

It also shows a safer split:

- the model proposes a change;
- another program checks the change;
- a human decides whether to copy the change into real code.

## What this does not show

This is not a complete coding system.

- The files disappear after each Worker request.
- It only allows one file to be changed.
- The checker only understands this small kind of bug.
- It cannot run a real test suite yet.
- It cannot deploy code or make a pull request.
- One passing task does not prove that a whole coding system is safe or reliable.

## Next

1. Save files somewhere durable, such as a git remote or Durable Object.
2. Run real tests outside the Worker.
3. Try the same task from pi and another agent runner. Use the same checker for both.
4. Let a person turn a passing receipt into a small pull request.
