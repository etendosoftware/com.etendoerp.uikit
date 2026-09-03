# com.etendoerp.uikit

A framework for building custom windows on Etendo Classic's SmartClient UI, so that a board
or a POS is a screen definition instead of eight hundred lines of plumbing.

Its documentation is written for an **agent**, not for a reader: layered, budgeted, and
gated. If you are a person, the same entry point works — start at
[`AGENTS.md`](AGENTS.md), and use [`uikit.contract.json`](uikit.contract.json) as the index.

**Status: R0.** The runtime is not written yet. What exists today is the layer that had to
come first: the platform facts with citations the harness re-checks, and the gates
themselves.

```
node modules/com.etendoerp.uikit/verify/check-source.mjs
```

Design proposal, decisions and plan: see the round R0 notes in `oguard.contract.json`.
