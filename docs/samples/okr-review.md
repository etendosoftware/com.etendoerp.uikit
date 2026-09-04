# Sample: quarterly OKR review

> **STATUS: shipped.** The window runs in the live instance, reached from `AD_MENU` under the
> "UIKit demo" folder: an `OBUIAPP_View_Impl` row carrying a FreeMarker template with a NULL
> `classname`, so it needs no Java view code. This document is the shape it was built to — if
> you are asked to change the window, change this document with it.

**Recipe shape:** master–detail (`L1-master-detail`, a planned recipe — it is not written, do
not go looking), plus two things that shape does not cover on its own: filters that live in state
rather than in navigation, and a derived list computed in the client over data already loaded.

**Why this sample exists.** It is the kit's first real consumer, and the most representative of
what a customer actually asks for: filters, a three-level hierarchy, derived numbers, and a
layout that is not a grid. One consumer does not amortise a framework, which is what the demo
module `com.etendoerp.uikit.demos` is for.

---

## 1. The user's workflow, in their words

Filter by quarter (Q3 2026) → filter by department → each department has its objectives, its
key results (a tab) and its KR updates. Every objective and every KR carries a percentage, a
current score and a target score.

That sentence fixes the hierarchy: **objective → key result → check-in**, three levels, which is
exactly Etendo's window/tab/tab nesting. Data maintenance therefore comes free from a standard
window; this view only owns the *reading* of the review.

## 2. State

One object, five keys. Everything on screen is a function of it plus the loaded data.

| key     | values                          | what it drives                                   |
| ------- | ------------------------------- | ------------------------------------------------ |
| `cycle` | `ETOKRS_Cycle.id`                | which quarter is loaded; changing it reloads     |
| `dept`  | `'all'` or `ETOKRS_Department.id`| the detail panel and the agenda                  |
| `tab`   | `'obj' \| 'kr' \| 'upd'`        | which detail tab is open                         |
| `sort`  | `'pace' \| 'pct' \| 'score'`    | ordering inside the panel                        |
| `open`  | `{ [objectiveId]: true }`       | which objective cards are expanded               |

`cycle` is the only key whose change costs a round trip. The other four re-render from data
already in memory — that is the whole reason the tree is fetched in one call.

## 3. Regions

Four regions, so a department change never redraws the filter bar the user just clicked.

| region    | contents                                                        | redrawn when                     |
| --------- | --------------------------------------------------------------- | -------------------------------- |
| `filters` | quarter segmented control, department chips, quarter clock       | `cycle` changes                  |
| `rail`    | one card per department: percentage, score, pace strip           | `cycle` or `dept` changes        |
| `agenda`  | the four KRs furthest behind pace, ranked                        | `cycle` or `dept` changes        |
| `panel`   | the three tabs and their contents                                | any state change                 |

`keepScroll: ['panel']` — the panel is the only region tall enough to scroll, and losing its
scroll position on a tab change is the bug users notice first.

## 4. The two instruments

Neither is a progress bar, and building them as progress bars loses the point of the screen.

**The pace rail.** A track with the completion percentage as fill and a vertical tick at the
*expected* percentage for today. The fill colour comes from the distance to that tick, not from
the absolute value: at day 62 of 92 a KR at 62% is amber while one at 70% is green. CSS contract:

```css
.uik-rail { --uik-p: 71%; --uik-e: 67%; }   /* p = progress, e = expected */
```

**The score meter.** Ten cells for a 0.00–1.00 score, filled to the current score, with an
outlined cell at the target score. It answers "will the commitment be met" without asking the
reader to compare two numbers.

## 5. Derived numbers — the authoritative definitions

```text
progress% = clamp((current - base) / (target - base), 0, 1) * 100
            works unchanged when lower is better (churn 4.1% -> 2.0%): both deltas are
            negative and the quotient comes out positive. Do not special-case it.
pace%     = elapsed days / quarter days
deviation = progress% - pace%
            on pace >= 0 | at risk >= -12 | off pace < -12
score     = a 0.00-1.00 judgement entered by the KR owner. It is NOT progress%.
            progress measures the metric; score measures whether moving the metric moved the
            business. A wide gap between them is the conversation, so never derive one from
            the other and never hide either.
rollup    = weighted mean of the children, weight per KR, default 1, for progress and score
            alike. Objective target score is entered, not derived.
agenda    = every KR of the current department filter, sorted by deviation ascending, first 4.
```

## 6. Data contract

The view asks for two datasources. Build against these shapes; they are the contract even
before the tables exist.

```text
ETOKRS_ReviewTree  ->  { cycles:    [ { id, name, datefrom, dateto, hasData } ],
                         cycle:     { id, name, datefrom, dateto, day, days } | null,
                         depts:     [ { id, name, lead } ],
                         deptStats: [ { id, objs, krs, pct, score, scoreTarget } ],
                         objs:      [ { id, dept, title, owner, weight, scoreTarget } ],
                         krs:       [ { id, obj, title, owner, unit, base, target,
                                        current, score, scoreTarget, weight, confidence } ] }

ETOKRS_Checkins    ->  { checkins: [ { id, kr, krTitle, date, author, valueFrom, valueTo,
                                       scoreFrom, scoreTo, confidence, note, unit } ] }
```

`day` and `days` are computed server-side from `datefrom`/`dateto` against the request date, so
pace never depends on the browser clock. `cycle` is null when no cycle is readable; every array is
then empty and the view renders its empty state rather than failing.

Two of these six exist because of where the filtering happens, and they are the part worth
understanding before copying the shape:

- `cycles` lists every quarter the user may open, with `hasData` so the picker can dim an empty
  one. It ignores the department filter — the picker must not shrink as the user narrows.
- `deptStats` carries the finished rollup for **every** readable department, computed in SQL by
  the same arithmetic as section 5. `objs` and `krs` are narrowed by `dept`, so the rail could not
  be derived from them: it has to keep drawing the departments the user is *not* looking at.

`lead` is the department lead's display name, already resolved from `AD_User`; the client never
receives the user id, because it has nothing to do with one.

## 7. AD rows required

Five tables in `com.etendoerp.uikit.samples`, prefix `ETOKRS`. None of this exists in core.

| table                | holds                       | columns that matter                                                                                 |
| -------------------- | --------------------------- | --------------------------------------------------------------------------------------------------- |
| `ETOKRS_Cycle`       | the quarter                 | `name`, `datefrom`, `dateto`, `isactive`                                                             |
| `ETOKRS_Department`  | the department              | `name`, `lead`, `seqno`, `ad_org_id`                                                                 |
| `ETOKRS_Objective`   | the objective               | `etokrs_cycle_id`, `etokrs_department_id`, `name`, `owner`, `weight`, `scoretarget`, `seqno`         |
| `ETOKRS_KeyResult`   | the KR (child tab)          | `etokrs_objective_id`, `name`, `owner`, `uom`, `basevalue`, `targetvalue`, `currentvalue`, `score`, `scoretarget`, `weight`, `confidence`, `seqno` |
| `ETOKRS_Checkin`     | the update (grandchild tab) | `etokrs_keyresult_id`, `checkindate`, `author`, `valuefrom`, `valueto`, `scorefrom`, `scoreto`, `confidence`, `note` |

The column names are the physical ones, because the datasources are SQL and rename on the way out:
`name` becomes `title`, `uom` becomes `unit`, `basevalue` becomes `base`. Section 6 is what the
client sees; this table is what the database holds.

Plus the usual view rows: one `OBUIAPP_View_Impl`, one `AD_MENU` entry, one
`OBUIAPP_View_Role_Access` per role, and one `AD_MESSAGE` per visible string.

**Read fact F6 before wiring permissions.** `ViewComponent` serves a view without checking
`OBUIAPP_View_Role_Access`, so the department filter cannot be a UI concern — it has to be
enforced in the datasource, or any authenticated user can read every department.

## 8. The skeleton

```js
(function () {
  'use strict';

  // A datasource is a name pointing at an action handler. KernelServlet publishes a handler by
  // fully qualified class name, so this needs no AD row of its own.
  OB.UIKit.datasource('ETOKRS_ReviewTree', { action: 'com.etendoerp.uikit.samples.okr.ReviewTree' });
  OB.UIKit.datasource('ETOKRS_Checkins', { action: 'com.etendoerp.uikit.samples.okr.Checkins' });

  const PACE_AT_RISK = -12;

  const progress = (kr) => {
    const span = kr.target - kr.base;
    if (span === 0) return kr.current >= kr.target ? 100 : 0;
    return Math.min(100, Math.max(0, ((kr.current - kr.base) / span) * 100));
  };

  const stateOf = (deviation) =>
    deviation >= 0 ? 'ok' : deviation >= PACE_AT_RISK ? 'risk' : 'bad';

  OB.UIKit.defineView({
    name: 'ETOKRS_Review',
    // A label key, not a translated string: the runtime resolves it, and it also becomes the tab
    // title. Pass t() here and you translate before the labels are registered.
    title: 'ETOKRS_ReviewTitle',
    regions: ['filters', 'rail', 'agenda', 'panel'],
    keepScroll: ['panel'],
    state: { cycle: null, dept: 'all', tab: 'obj', sort: 'pace', open: {} },
    data: { tree: 'ETOKRS_ReviewTree', updates: 'ETOKRS_Checkins' },

    // Only these reach the server, and a change to them is what triggers a refetch. Everything
    // else in state -- tab, sort, open -- is local, so clicking a tab costs no request. This is
    // also what the URL carries, so a bookmarked filter comes back.
    params: (s) => ({ cycle: s.cycle, dept: s.dept }),

    render(s, d) {
      const pace = d.tree.cycle ? (d.tree.cycle.day / d.tree.cycle.days) * 100 : 0;
      const objDept = new Map(d.tree.objs.map((o) => [o.id, o.dept]));
      const behind = d.tree.krs
        .filter((k) => s.dept === 'all' || objDept.get(k.obj) === s.dept)
        .map((k) => ({ kr: k, deviation: progress(k) - pace }))
        .sort((a, b) => a.deviation - b.deviation)
        .slice(0, 4);
      return {
        filters: OB.UIKit.html`<div class="uik-row">${d.tree.cycle.name}</div>`,
        rail: railRegion(s, d, pace),
        agenda: agendaRegion(behind),
        panel: panelRegion(s, d, pace)
      };
    },

    on: {
      'click [data-cycle]': (ctx, e, el) => ctx.set({ cycle: el.dataset.cycle, open: {} }),
      'click [data-dept]': (ctx, e, el) => ctx.set({ dept: el.dataset.dept }),
      'click [data-tab]': (ctx, e, el) => ctx.set({ tab: el.dataset.tab }),
      'click [data-sort]': (ctx, e, el) => ctx.set({ sort: el.dataset.sort }),
      'click [data-obj]': (ctx, e, el) => ctx.toggle('open', el.dataset.obj)
    }
  });

  // Interpolate the array, never .join('') it: html`` returns already-safe HTML, and joining
  // flattens that back to a plain string which the enclosing html`` then escapes on sight.
  function railRegion(s, d, pace) {
    return OB.UIKit.html`<div class="uik-row">${d.tree.deptStats.map((st) =>
      OB.UIKit.badge(deptName(d, st.id), stateOf(st.pct - pace)))}</div>`;
  }
  function agendaRegion(behind) {
    return OB.UIKit.html`<ol>${behind.map((x) => OB.UIKit.html`<li>${x.kr.title}</li>`)}</ol>`;
  }
  function deptName(d, id) {
    const dept = d.tree.depts.find((x) => x.id === id);
    return dept ? dept.name : id;
  }
  function panelRegion() {
    return '';
  }
})();
```

What the runtime does for you here, and what it will not:

- `title` is looked up as a label key and pushed onto the tab. A lazily fetched view arrives after
  its tab exists — core opens the tab titled with the view id and never relabels it — so the
  runtime fixes the title from `setViewTabId`, the hook core calls once the tab is ours.
- `params` is published through `getBookMarkParams` (core spells it with a capital M and P; misname
  it and the URL silently stops carrying state), and the runtime pushes history whenever those
  params change, which is what makes `dept=Comercial` survive a reload.
- Nothing deduplicates your renders for you beyond the per-region string diff: `render` returns
  every region every time, and only the regions whose HTML actually changed are written.

## 9. Decisions, and what they cost

These were open questions in the design round. The window shipped, so they are answered — kept
here because each one is a fork a similar window will reach, and the reasoning outlives the choice.

1. **Department is its own table, not an `AD_Org`.** `AD_Org` would have inherited the permission
   tree for free, but it ties OKRs to the accounting structure, and OKR departments do not survive
   contact with a chart of accounts. `ETOKRS_Department` keeps an optional `ad_org_id` for the
   installations where the two really do coincide.
2. **Score is 0.00–1.00**, with targets typically 0.70–0.80. The meter's ten cells are that scale;
   a 0–10 scale would change the instrument and every label with it.
3. **KRs are weighted.** `weight` exists on both the objective and the KR, and both rollup levels
   are weighted means. The UI shows a weight only when it differs from 1, so an installation that
   weighs everything equally never sees the column.
4. **Read-only.** Every number on screen is derived, and there is no write path: the meeting reads
   this window and edits in the standard tabs. Inline editing is a later round.
5. **Scope is a datasource rule.** `OkrQuery.scopeClause` is in every query, including the one
   behind `deptStats`, because fact F6 means a served view proves nothing about who may read it.

## 10. What the gates demand

Source gates, on every commit (`verify/check-source.mjs`):

* `G1`/`G2` — the shipped app file minifies with the kernel's JSMin and is a single IIFE.
* `G5` — every code block here keeps minifying and parsing, and every `OB.UIKit.*` it names
  stays in `uikit.contract.json`.
* `G8` — the symbols this sample leans on must not be marked `planned` in the index once the
  runtime ships them, and this file must stay registered in the index.
* `G9` — `docs/api/uikit.d.ts` still matches the JSDoc it is generated from.

Window gates, against a running instance (`verify/check-window.mjs`):

* `W1`/`W2`/`W3` — the AD rows are wired with no Java class, the bundle on the classpath is
  current, and `OBUIAPP_MainLayout/View` serves something the browser can eval.
* `W4` — one call really does return cycle, departments, objectives and KRs, with no orphan KR.
* `W5` — every department narrows in SQL, `deptStats` survives the filter, and the app does not
  re-filter `objs`/`krs` in the client.
* `W6` — section 5 recomputed independently from the raw rows, and compared against what the
  datasource returned. If you change a formula here, that gate is what fails.
