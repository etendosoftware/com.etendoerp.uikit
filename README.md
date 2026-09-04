# com.etendoerp.uikit

A framework for building custom windows on Etendo Classic's SmartClient UI, so that a board
or a POS is a screen definition instead of eight hundred lines of plumbing.

Its documentation is written for an **agent**, not for a reader: layered, budgeted, and
gated. If you are a person, the same entry point works — start at
[`AGENTS.md`](AGENTS.md), and use [`uikit.contract.json`](uikit.contract.json) as the index.

**Status: the runtime ships.** `OB.UIKit` is implemented in
`web/com.etendoerp.uikit/js/uikit.js` and exports 20 public symbols; every window in
`docs/samples/` runs in the live instance off a FreeMarker template with no Java view class, all
of them in `com.etendoerp.uikit.samples`. Written this round: the three L3 guides, and two of the
five L1 recipes harvested from those windows. Still unwritten: the other three recipes and the
per-symbol API reference — `uikit.contract.json` marks them `planned`, and they must not be cited.

```
node modules/com.etendoerp.uikit/verify/check-source.mjs
```

Objective, round, acceptance criteria and the gate commands live in `oguard.contract.json` at
the repo root — currently round `R1-OKR-CLASSIC` under objective `O-UIKIT`. The design itself
(shape, state, regions, formulas, data contract, AD rows) is
[`docs/samples/okr-review.md`](docs/samples/okr-review.md); the decisions and what they cost are
its §9.
