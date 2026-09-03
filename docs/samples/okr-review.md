# Sample: quarterly OKR review

> **STATUS: design only.** No runtime, no AD rows, no `web/` file exists for this yet. This
> document is the agreed shape; it is what R1 must be able to produce. If you are an agent and
> you were asked to build the OKR review, build exactly this — do not redesign it.

**Recipe shape:** master–detail (`L1-master-detail`), plus two things that shape does not cover
on its own: filters that live in state rather than in navigation, and a derived list computed
in the client over data already loaded.

**Why this sample exists.** It is the third consumer of the kit, after POS and the order board.
Two consumers never amortise a framework; three do. It is also the most representative of what
a customer actually asks for: filters, a three-level hierarchy, derived numbers, and a layout
that is not a grid.

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
| `cycle` | `ETOKR_Cycle.id`                | which quarter is loaded; changing it reloads     |
| `dept`  | `'all'` or `ETOKR_Department.id`| the detail panel and the agenda                  |
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
ETOKRS_ReviewTree  ->  { cycle:   { id, name, datefrom, dateto, day, days },
                         depts:   [ { id, name, lead } ],
                         objs:    [ { id, dept, title, owner, weight, scoreTarget } ],
                         krs:     [ { id, obj, title, owner, unit, base, target,
                                      current, score, scoreTarget, weight, confidence } ] }

ETOKRS_Checkins    ->  [ { id, kr, date, author, valueFrom, valueTo,
                           scoreFrom, scoreTo, confidence, note } ]
```

`day` and `days` are computed server-side from `datefrom`/`dateto` against the request date, so
pace never depends on the browser clock.

## 7. AD rows required

Five tables in `com.etendoerp.uikit.samples`, prefix `ETOKRS`. None of this exists in core.

| table               | holds                | columns that matter                                                                        |
| ------------------- | -------------------- | ------------------------------------------------------------------------------------------ |
| `ETOKR_Cycle`       | the quarter          | `name`, `datefrom`, `dateto`, `isactive`, `status`                                          |
| `ETOKR_Department`  | the department       | `name`, `lead` (AD_User), optional `ad_org_id`                                              |
| `ETOKR_Objective`   | the objective        | `cycle`, `department`, `title`, `owner`, `weight`, `score_target`                           |
| `ETOKR_KeyResult`   | the KR (child tab)   | `objective`, `title`, `owner`, `unit`, `base`, `target`, `current`, `score`, `score_target` |
| `ETOKR_Checkin`     | the update (grandchild tab) | `keyresult`, `date`, `author`, `value_from`, `value_to`, `confidence`, `note`        |

Plus the usual view rows: one `OBUIAPP_View_Impl`, one `AD_MENU` entry, one
`OBUIAPP_View_Role_Access` per role, and one `AD_MESSAGE` per visible string.

**Read fact F6 before wiring permissions.** `ViewComponent` serves a view without checking
`OBUIAPP_View_Role_Access`, so the department filter cannot be a UI concern — it has to be
enforced in the datasource, or any authenticated user can read every department.

## 8. The skeleton

```js
(function () {
  'use strict';

  OB.UIKit.defineDatasource('ETOKRS_ReviewTree', { entity: 'ETOKR_Objective', depth: 2 });
  OB.UIKit.defineDatasource('ETOKRS_Checkins', { entity: 'ETOKR_Checkin' });

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
    key: 'etokrs.review',
    title: OB.UIKit.t('ETOKRS_ReviewTitle'),
    state: { cycle: null, dept: 'all', tab: 'obj', sort: 'pace', open: {} },
    data: { tree: 'ETOKRS_ReviewTree', updates: 'ETOKRS_Checkins' },
    keepScroll: ['panel'],

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

  function railRegion(s, d, pace) {
    return d.tree.depts.map((dept) => OB.UIKit.badge(dept.name, stateOf(pace))).join('');
  }
  function agendaRegion(behind) {
    return behind.map((x, i) => `${i + 1}. ${x.kr.title}`).join('');
  }
  function panelRegion() {
    return '';
  }
})();
```

## 9. Decisions still open — do not guess these

1. **Department: an Etendo organisation or its own table?** `AD_Org` inherits the permission
   tree for free but ties OKRs to the accounting structure. Own table is conceptually cleaner
   and forces you to solve permissions by hand. Recommendation: own table, with an optional
   `ad_org_id`.
2. **Score scale 0.00–1.00 or 0–10?** The design assumes 0.00–1.00 with a typical target of
   0.70–0.80. A 0–10 scale changes the meter and every label.
3. **Are KRs weighted?** The rollup supports per-KR weight and the UI shows it only when it
   differs from 1. If everything weighs the same, drop the column.
4. **Read-only, or editable in place?** The honest PoC is read-only plus one action that opens
   the standard check-in tab. Inline editing is a later round.
5. **Who sees what?** A department head seeing their own department and management seeing all
   is a datasource rule, not a UI rule. See fact F6.

## 10. What the gates will demand

* `G1`/`G2` — the shipped app file minifies with the kernel's JSMin and is a single IIFE.
* `G5` — every code block here keeps minifying and parsing, and every `OB.UIKit.*` it names
  stays in `uikit.contract.json`.
* `G8` — the symbols this sample leans on must not be marked `planned` in the index once the
  runtime ships them, and this file must stay registered in the index.
