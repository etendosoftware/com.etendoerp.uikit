# Etendo UI Kit — instructions for the agent building a custom window

You are here because someone asked for a screen Etendo does not have: a board, a POS,
a picking view, a tile dashboard. This module is how you build it. Read this file, then
exactly one recipe. Do not read core.

> **STATUS: R0.** The runtime does not exist yet — `OB.UIKit` is unimplemented, recipes and
> the API reference land in R1. What is real today: the platform facts (L5) and the gates
> (L6). Do not write app code against this document yet; see `uikit.contract.json`.

## The workflow — five steps, in this order, no exceptions

1. **Pick the shape.** Match the request to one recipe in `docs/recipes/`. If nothing
   matches, stop and say so — do not improvise a sixth shape.
2. **Create the AD rows** from `docs/ad/`. A window needs `OBUIAPP_View_Impl`, `AD_MENU`,
   `OBUIAPP_View_Role_Access` and one `AD_MESSAGE` per label. **Without these the window
   does not exist**, however good the JavaScript is. This is the step agents skip.
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
| a board, form, master-detail, tiles, wizard | `docs/recipes/<shape>.md` | L1 |
| an exact signature, an option name | `docs/api/reference.md`, `docs/api/uikit.d.ts` | L2 |
| criteria, paging, writes, permissions, drag, i18n, theming, navigation | `docs/guides/<topic>.md` | L3 |
| the AD rows a window needs | `docs/ad/README.md` | L4 |
| to check a claim about the platform, or to resolve a contradiction | `docs/platform/facts.md` | L5 |
| to prove the window works | `verify/` — run it, don't read it | L6 |

`uikit.contract.json` indexes every one of those with a token cost, so you can choose by
budget. A typical window is this file + one recipe + the `.d.ts` — about 10k tokens, and
zero core files read.

## When something contradicts this file

`docs/platform/facts.md` carries `file:line` citations into core, and the gate re-checks every
one of them on every run. If it disagrees with your prior, the citation wins. If the citation
itself no longer resolves, the gate fails and the fact — not your code — is what needs fixing.

## When you are stuck

Say which step you are on and what the gate printed. Do not work around a gate, do not
disable a check, do not widen a selector until something happens. A window that cannot be
built inside these invariants is a gap in the framework, and reporting it is the useful move.
