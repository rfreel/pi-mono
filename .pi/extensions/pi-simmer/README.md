# @rfreel/pi-simmer

One Pi package with three layers:

1. **Pi** — host/agent loop.
2. **OptMem** — persistent append-only memory.
3. **Simsimmer 0.1.0** — pinned synthetic search-policy simulation before each agent run.

## Why Simsimmer 0.1.0

Use the current executable evaluator from `rfreel/Simsimmer`, pinned at
`cdc74975f620853d76991c84f862aa90833c28a1`. Its evaluator hash is
`be6a39b09e522778c00ffa4d14258140f897110f9eb9cef53bbd198a960c9320`.

`immutable-context-sim 1.1.0` remains useful prior decomposition-policy evidence inside
Simsimmer, but it is not the repository's current executable evaluator. This package
therefore uses Simsimmer 0.1.0 as runtime and does not relabel the older evidence as the
active simulator.

## OptMem

OptMem is not copied into this repository. `/simmer-setup` downloads the exact `memo`
file from `VictorTaelin/OptMem@1fb164cf39028047781f72ac3bb1e5a691c1dcb0`,
writes it to `~/.optmem/memo`, and initializes it. Nothing is downloaded automatically
on package load.

On session start the extension runs the complete paginated `memo wake` sequence. It
exposes:

- `optmem_wake`
- `optmem_note`
- `optmem_recall`
- `optmem_nap`

If OptMem requests a compression, the agent is instructed to settle it before further
state-changing work.

## Simsimmer

`/simmer-setup` also downloads the seven files required by the current Simsimmer
evaluator from the pinned commit and verifies each Git blob identity before writing to
`~/.pi-simmer/simsimmer-0.1.0/`. Runtime research state is kept separately under its
`state/` directory.

After setup, each agent run deterministically maps the prompt to one of four policy
search variants and runs eight iterations by default:

- `explore`
- `exploit`
- `transfer`
- `compress`

Set `PI_SIMMER_AUTO_SIM=0` to disable automatic simulation or
`PI_SIMMER_AUTO_ITERATIONS=<1..64>` to change the search budget.

The simulator output is injected as **synthetic policy evidence** only. It can tune
search breadth, depth, verification, tracing, reuse, transfer, ablation, and compression.
It is not treated as task correctness or implementation verification.

The `simsimmer_policy_sim` tool runs an explicit larger search on demand. With
`promote=true`, accepted state is persisted under `~/.pi-simmer/simsimmer-0.1.0/state/`.
Automatic runs never pass `--write`.

## Project integration

This package lives at `.pi/extensions/pi-simmer/`, so this Pi checkout auto-discovers
it as a project-local extension. No workspace or lockfile mutation is required.

Inside Pi, run:

```text
/simmer-setup
/simmer-status
```

`/simmer-setup` refuses to overwrite a different OptMem payload at `~/.optmem/memo`;
set `PI_SIMMER_MEMO_PATH` if a separate pinned install is preferred. Simsimmer source
files live in the package-managed runtime directory and setup repairs them to the exact pin
without touching `state/`.

Requirements: Node.js 20+ and Python 3.11+.

## Pins

See `versions.json`.
