# Etendo UI Kit — instructions for the agent building a custom window

You are here because someone asked for a screen Etendo does not have: a board, a POS,
a picking view, a tile dashboard. This module is how you build it. Read this file, then
the worked sample. Do not read core.

> **STATUS: the runtime ships.** `OB.UIKit` (14 public symbols) and the quarterly OKR review
> window both run in the live instance. For signatures read `docs/api/uikit.d.ts`, generated from
> the runtime's own JSDoc. The recipes and the per-symbol reference are not written yet: never cite them.

## The workflow — five steps, in this order, no exceptions

1. **Pick the shape.** Read `docs/samples/okr-review.md`. It is the only complete worked example
   of every layer — state, regions, derived numbers, data contract, AD rows, gates — so name the
   part of it you are copying before you write any code. If the request is nothing like it, say
   which shape you propose and why, then build that the same way. Do not improvise silently.
2. **Create the AD rows.** A window needs `OBUIAPP_View_Impl`, `AD_MENU`,
   `OBUIAPP_View_Role_Access` and one `AD_MESSAGE` per label; §7 of the sample is the worked
   list, and `docs/ad/README.md` is planned, not written. **Without these rows the window does
   not exist**, however good the JavaScript is. This is the step agents skip.
3. **Write the app.** One file, one IIFE, one `OB.UIKit.defineView({...})` call. Its CSS
   uses `--uik-*` tokens only.
4. **Run the gates** until green: `node modules/com.etendoerp.uikit/verify/check-source.mjs`,
   then the runtime scenario. A gate failure is the answer, not an obstacle.
5. **Report the gate output verbatim.** Never declare a window done from code you have not
   seen load in a browser.

## Invariants — a violation is a bug even when the screen looks right

- **Never edit core.** `src/`, `src-core/`, `src-wad/`, `modules_core/` are off limits.
  Everything you need is an extension point; see `docs/platform/facts.md`.
- **Never touch the SmartClient handle after draw.** No `setStyleName`, no writing
  `getHandle().innerHTML`. You own `div.uik-root` and nothing above it.
- **Never listen on `document` or `window`.** Use the view's `on:` map. Document listeners
  are never unbound, leak across view lifetimes, and see other views' events.
- **Every visible string goes through `t('KEY')`** and needs an `AD_MESSAGE` row in *your*
  module. No English (or Spanish) literals in markup.
- **CSS: `--uik-*` only.** Never a `--sk-*` reference outside the uikit token block, never a
  `.etskin-*` selector. The skin may be absent, and its load order is not guaranteed.
- **One IIFE per file, no top-level bindings.** Every static file is concatenated into a
  single scope; a colliding top-level `const` throws at load and takes the login page with it.
- **ES2018 is allowed and correct.** Arrows, `const`/`let`, template literals, spread,
  destructuring, `async`/`await`. Do *not* "fix" these to ES5 — see fact F1. Avoid `?.`
  and `??`, which buy nothing here.
- **Parsing is not working.** The gates load the page; you must too.

## Router — read only what the row says

| You need to… | Read | Layer |
|---|---|---|
| build any window at all | this file | L0 |
| the one complete worked example, end to end | `docs/samples/okr-review.md` | L1 |
| a board, form, master-detail, tiles, wizard | `docs/recipes/<shape>.md` — **planned, do not cite it**; work from the sample | L1 |
| an exact signature, an option name | `docs/api/uikit.d.ts` | L2 |
| one symbol at a time, with examples | `docs/api/reference.md` — **planned, do not cite it** | L2 |
| criteria, paging, writes, permissions, drag, i18n, theming, navigation | `docs/guides/<topic>.md` — **planned, do not cite it** | L3 |
| the AD rows a window needs | `docs/ad/README.md` — **planned, do not cite it**; use §7 of the sample | L4 |
| to check a claim about the platform, or to resolve a contradiction | `docs/platform/facts.md` | L5 |
| to prove the window works | `verify/` — run it, don't read it | L6 |

The four planned rows are layers that exist and are empty. That is deliberate: knowing the layer
is there stops you inventing one. Do not create the file, do not cite it as if it were written —
work from the sample and the `.d.ts` instead, and say in your report what you had to infer.

`uikit.contract.json` indexes every one of those with a token cost, so you can choose by
budget. A typical window is this file + the sample + the `.d.ts` — about 10k tokens, and
zero core files read.

## When something contradicts this file

`docs/platform/facts.md` carries `file:line` citations into core, and the gate re-checks every
one of them on every run. If it disagrees with your prior, the citation wins. If the citation
itself no longer resolves, the gate fails and the fact — not your code — is what needs fixing.

## When you are stuck

Say which step you are on and what the gate printed. Do not work around a gate, do not
disable a check, do not widen a selector until something happens. A window that cannot be
built inside these invariants is a gap in the framework, and reporting it is the useful move.
