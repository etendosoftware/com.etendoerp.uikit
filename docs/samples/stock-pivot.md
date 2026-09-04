# Sample: stock by product and warehouse

> **STATUS: shipped.** `ETDEMO_Stock` runs in the live instance, reached from `AD_MENU` under the
> "UIKit demo" folder: an `OBUIAPP_View_Impl` row carrying a FreeMarker template with a NULL
> `classname`, so it needs no Java view code — `generateView` loads a class only when there is one.
> This document is the shape the window was built to. Change the window, change this.

<!--cite modules_core/org.openbravo.client.application/src/org/openbravo/client/application/ViewComponent.java|259|protected String generateView(String viewName)--><!--cite modules_core/org.openbravo.client.application/src/org/openbravo/client/application/ViewComponent.java|263|if (viewImpDef.getJavaClassName() != null)-->

**What it is for.** A paged pivot with a search box: rows are products, columns are warehouses,
cells are quantity on hand. The interesting part is not the pivot — it is the **asymmetry**
(section 3): the column axis and the column totals deliberately do *not* obey the same subset of
the state that the row detail obeys, and the screen says so out loud.

**Files.** All in `com.etendoerp.uikit.samples`: `stock-pivot.js`, `stock-pivot.css`,
`stock/StockPivot.java`, `etdemo-stock.view.json`, `verify/etdemo-stock.checks.mjs`.

**Evidence.** The live window at 1440x900, opened from the menu, not a mockup:
[initial state](img/stock-pivot-initial.png) - [search in flight](img/stock-pivot-search.png).

## 0. What this data can and cannot show — read this first

This section is first because it is the thing most likely to be misread.

`m_storage_detail` in this instance holds **255 rows across 50 products and 6 warehouses**, split
between two clients (F&B International Group 193 rows / 26 products, QA Testing 62 rows / 24
products). An admin session in F&B sees **193 rows, 26 products, 4 warehouses, 16 locators** and a
grand total of **6,016,946**.

**This window does not demonstrate volume.** The debounce, the `limit`/`offset` and the `ilike` are
real — they run where this document says, and section 9's gates prove it against the database — but
on 26 products they are unimpressive, and nobody will look at this screen and be persuaded that
paging matters. Build it this way anyway: it is the only version that still works when
`m_storage_detail` reaches the size it has in a real warehouse, and retrofitting server-side paging
onto a client that already sorted an array is a rewrite, not a change. What the data *does* show:

| Property | Value here | Why it matters to the code |
| --- | --- | --- |
| Sparsity | 57 of 26 × 4 = 104 cells exist | Missing and zero must render differently — see 6.3 |
| Zero cells | 30 of those 57 sum to exactly 0 | So "no row" ≠ "zero"; both occur |
| Locators per warehouse | 4 | 193 rows collapse to 57 cells: the pivot must aggregate |
| Units of measure | 2 in scope (`Ud` ×25, `L` ×1) | The unit cannot be hard-coded; it is per row |
| Products with a zero total | 0 | The `zeros` switch is wired and correct, but inert here |

That last row deserves saying plainly: **the "show zeros" toggle changes nothing on this data.** It
is implemented, bound to state, and gated against losing rows — and it will do nothing visible
until someone holds stock that nets to zero.

**Do not seed stock to make this demo look better.** `m_storage_detail` is derived state,
maintained by core's transaction, inventory and reservation logic; hand-written rows would be
invisible to costing and would make the standard stock report disagree with this window — a far
worse demo than a small one.

<!--cite src-db/database/model/functions/M_UPDATE_INVENTORY.xml|120|UPDATE M_STORAGE_DETAIL--><!--cite src-db/database/model/triggers/M_TRANSACTION_TRG2.xml|63|FROM m_storage_detail sd-->

## 1. The screen

Four regions, in DOM order:

| Region | Holds | Redraws when |
| --- | --- | --- |
| `filters` | search box, sort chips, zero toggle, page size | state changes |
| `summary` | product count, warehouse count, grand total, the asymmetry note | data arrives |
| `pivot` | the table, with a `tfoot` of column totals | data arrives |
| `pager` | prev/next, page *n* of *m*, "1–25 of 26 products" | data arrives |

`loading: 'pivot'` puts the first-load placeholder in the table rather than the first region, so the
filter bar paints immediately and the user can type before the first response lands; and
`keepScroll: ['pivot']` matters because the table scrolls horizontally on a narrow window.

## 2. State, and the bookmark

```js
OB.UIKit.defineView({
  name: 'ETDEMO_Stock',
  regions: ['filters', 'summary', 'pivot', 'pager'],
  loading: 'pivot',
  keepScroll: ['pivot'],
  state: { q: '', page: 1, limit: 25, zeros: 'N', sort: 'code' },
  data: { stock: 'ETDEMO_Stock' },
  params: function (s) {
    return { q: s.q, page: s.page, limit: s.limit, zeros: s.zeros, sort: s.sort };
  }
});
```

Five keys, and **all five are in `params`** — the whole bookmark story, since `params` is what
`getBookMarkParams` publishes: a bookmark of page 3 of `cola` sorted by quantity reopens as page 3
of `cola` sorted by quantity. A key that shapes the query but is missing from `params` produces a
bookmark that lies, which is worse than no bookmark. Every filter change also resets `page` to 1:
staying on page 3 of a set that now has one page shows an empty table, which the user reads as "no
stock" rather than "wrong page".

## 3. What ignores what, and why

The rule this window exists to demonstrate: **navigation aggregates are computed in SQL ignoring
the active filter; only the detail narrows.**

| Output | `q` | `page` | `limit` | `zeros` | `sort` | Computed over |
| --- | --- | --- | --- | --- | --- | --- |
| `warehouses` (column axis) | ignores | ignores | ignores | ignores | ignores | every readable warehouse holding any readable stock |
| `rows` (the page) | **honours** | **honours** | **honours** | **honours** | **honours** | one page of the filtered products |
| `cells` | honours | honours | honours | honours | honours | only the products on the page |
| `colTotals` | **honours** | ignores | ignores | **honours** | ignores | the whole filtered set |
| `summary.products` | **honours** | ignores | ignores | **honours** | ignores | the whole filtered set |
| `summary.grand` | **honours** | ignores | ignores | **honours** | ignores | the whole filtered set |
| `page.total` | **honours** | ignores | ignores | **honours** | ignores | the whole filtered set |

Three claims, and the reason for each:

**The axis ignores `q`.** The columns are the shape of the table, not a result. Built from the
filtered rows instead, typing `c`, `co`, `col` would make columns appear and vanish under the
cursor: the header row would dance and every cell would shift sideways between keystrokes, and a
pivot whose columns move is unreadable. The cost is a column of dashes when the filter matches
nothing in `US West coast` — the right trade, and itself *information*: that warehouse holds none
of what was searched for.

**The axis ignores `page`.** The same argument, slower: paging would silently re-shape the table.

**`colTotals` ignores `page` but honours `q`.** A column total over the visible page answers a
question nobody asked ("how much of these 25 products"); over the whole filtered set it answers the
real one. This is the one place where an honest number is guaranteed to disagree with what the
reader can add up on screen, so **the screen says which**: the `tfoot` carries
`ETDEMO_StockColTotals` and `summary` carries `ETDEMO_StockAxisNote`.

**`cells` honours everything.** Cells are detail, and detail narrows. Fetching every cell so the
client can pick 25 out makes the payload grow with the table instead of the page — the mistake
server-side paging exists to avoid.

## 4. Data contract

One datasource, `com.etendoerp.uikit.samples.stock.StockPivot`, resolved by FQCN through
`KernelServlet` and so needing no dictionary row. It answers:

```
warehouses  [{ id, code, name }]                      the axis, in name order
rows        [{ id, code, name, uom, total, cells }]   one page; cells is { warehouseId: qty }
colTotals   [{ id, total }]                           one per axis column
summary     { products, grand }
page        { limit, offset, page, total, pages }
meta        { productTab, sort, q, zeros, scope: { clients, orgs } }
```

`meta.scope` is not decoration: it publishes the session's readable clients and organizations, so
section 9's independent SQL sees exactly the rows the handler was allowed to see. Without it every
arithmetic comparison would be confounded by permissions, and a scope bug would read as one.

`uom` comes from `c_uom.uomsymbol` via the datasource, never the client. That column is
`character(3)`, so it arrives blank-padded and is trimmed in SQL as
`coalesce(nullif(trim(u.uomsymbol), ''), u.name, '')`.

## 5. The SQL, in five queries

A shared `BASE` prelude defines two CTEs: `det` (storage rows joined to locator and warehouse, both
scope-filtered) and `prod` (products with their total, carrying the `ilike` and the zero switch).
Five queries run against it, each taking exactly the parameters section 3 says:

1. **axis** — `m_warehouse` where `exists (readable storage row)`, `order by w.name`. It does not
   use `BASE` at all: that is the structural guarantee it cannot accidentally see `q`.
2. **page** — `from prod order by <sort> limit ? offset ?`.
3. **cells** — one query over the page's product ids, expanded with `UikQuery.marks(n)`.
4. **colTotals** — `select wh, sum(qty) from det join prod group by 1`; **summary** —
   `select count(*), coalesce(sum(total), 0) from prod`.

Search is `UikQuery.likeClause("p.value", "p.name")` plus `UikQuery.bindLike(st, i, q, 2)` — a
case-insensitive `ilike` over code and name, bound, never concatenated. Paging is
`UikQuery.page(parameters)`, which clamps `limit` to 1..200 and defaults to 50, so a hostile URL
parameter cannot ask for a million rows. `page.total` is `summary.products` — a real `count(*)`
over the filtered set, not `rows.length`, which is why the pager says "1–25 of 26".

Two Postgres details that cost time. The zero switch is `having ?::text = 'Y' or sum(d.qty) <> 0`;
the `::text` cast is required, because a bare `?` compared to a literal leaves the parameter type
ambiguous. And the `having` sits in `prod` rather than a wrapper, so `colTotals` joining `prod`
inherits the same product set for free.

## 6. The client, in the four places it is not obvious

### 6.1 One debounced setter per view, not per module

```js
var searchers = new WeakMap();

function searcher(ctx) {
  var fn = searchers.get(ctx.state);
  if (!fn) {
    fn = OB.UIKit.debounce(function (text) {
      ctx.set({ q: text, page: 1 });
    }, 300);
    searchers.set(ctx.state, fn);
  }
  return fn;
}
```

A module-level `OB.UIKit.debounce` would be shared by every open instance, and the second typist
would cancel the first's pending search. The key is `ctx.state`, which the runtime creates once per
instance and never replaces; `destroy` calls `fn.cancel()`, so a pending search cannot fire into a
DOM that is already gone. 300 ms, trailing edge: one request when typing stops, not one per letter.

### 6.2 The caret survives the redraw

The search input carries a **single** `data-*` attribute, `data-q="1"`, on purpose. The runtime
rewrites the whole `filters` region as a string and restores focus by re-finding the element from
its attributes, so one distinctive attribute gives it a stable `input[data-q="1"]`. Add a second
`data-` attribute that changes with state and the caret jumps to the end of the box mid-word.

### 6.3 Missing is not zero

```js
function qty(value, unit) {
  if (value === null || value === undefined) {
    return '—';
  }
  var text = OB.UIKit.fmt(value, 'qty');
  return unit ? text + ' ' + unit : text;
}
```

`row.cells` only carries warehouses where a storage row exists, so an absent key renders `—` and a
present `0` renders `0` — on this data, 47 empty cells against 30 genuine zeros (section 0), and
collapsing them would claim a warehouse had been counted when it had not. The guard tests
`undefined` explicitly rather than falsiness: `0` is falsy, so `if (!value)` would print a dash over
every real zero. All numbers go through `OB.UIKit.fmt`, `'qty'` or `'int'`, so they match a
standard grid in the user's locale.

### 6.4 Navigation that degrades to text

`meta.productTab` is resolved server-side by `UikQuery.tabFor(conn, "140", "m_product")` — window
`140`, table `m_product`, lowest tab level, lowest sequence — which here returns tab **`180`**. The
product name is a link only when that came back non-null:

```js
var on = { 'click [data-product]': function (ctx, e, el) {
  OB.UIKit.nav(ctx.data.stock.meta.productTab, el.dataset.product);
} };
```

If `tabFor` cannot resolve — window renamed, module absent, role without access — the cell is plain
text. A dead link that throws on click is worse than a plain name.

## 7. Labels

Every visible string is an `AD_MESSAGE` row with the `ETDEMO_` prefix, read through `OB.UIKit.t`;
there is no Spanish or English literal in the JavaScript. The manifest declares
`"prefixes": ["ETDEMO_", "ETUIK_"]` — this window's labels and the runtime's, since `uikit.js` calls
`OB.UIKit.t` for its own error and empty states.

23 labels, all `ETDEMO_Stock` + `Title`, `Search`, `Product`, `Uom`, `Total`, `ColTotals`,
`Products`, `Warehouses`, `Grand`, `Zeros`, `Sort`, `SortCode`, `SortName`, `SortQty`, `Prev`,
`Next`, `Page`, `Of`, `PageSize`, `Empty`, `ScopeNote`, `AxisNote`, `OpenProduct`.
`deploy-view.mjs` bakes them into the template — 27 rows including the four `ETUIK_*` — so the
window spends no round trip fetching its own captions.

## 8. Styling

Window CSS lives in `stock-pivot.css`, scoped under `.uik-etdemo_stock`, using `--uik-*` tokens
only — no literal colour, so the window follows the theme it is dropped into. The table is
`.uik-table` and the pager `.uik-pager`; only what is specific to a pivot is local:
`.stk-wrap { overflow-x: auto }` and `.stk-pivot .stk-prod { position: sticky; left: 0 }`, keeping
the product column visible while the warehouse columns scroll. Nothing under
`com.etendoerp.uikit/web/` was touched — a window needing a framework CSS change is a wrong window.

## 9. What the gates demand

`verify/etdemo-stock.checks.mjs` adds four gates to `check-window.mjs`'s W1–W4. Each asks the
datasource and the database; **none looks at the DOM**, because a gate reading rendered HTML proves
the renderer ran, not that the server did the work.

- **W5 search in SQL.** Calls the datasource with and without `q`, compares the row *sets* (the
  filtered ids must be a proper subset of the unfiltered ones), and checks `page.total` against an
  independent `count(*)` over the same CTEs rebuilt from `meta.scope`. Two probes, a prefix and a
  full code; if neither narrows, it fails, because nothing was proved.
- **W6 paging on the server.** Page 1 and page 2 at `limit: 2` must be disjoint, `limit` honoured,
  and `page.total` must equal an independent `count(*)`.
- **W8 the axis holds still.** The warehouse id list must be **identical** under four probes — a
  narrowing `q`, page 2, `zeros: 'Y'`, `sort: 'qty'` — and must equal the axis computed straight
  from `m_warehouse`. Section 3's first claim, mechanised.
- **W9 the arithmetic.** Row totals, each row's cell sum, every column total, the product count and
  the grand total, all recomputed in plain SQL and compared — plus that the column totals sum to
  `summary.grand`, which catches a column dropped from the axis.

W7 (writes) **SKIPs**, correctly: the manifest declares `"writes": []` because the window is
read-only. Per section 0, the table is core's to maintain.

Source-side, `check-source.mjs` must stay 10/10. Two gates bite here: **G4**, this file must exist
and stay inside its 300-line budget once the contract says `present`; and **G5**, every JavaScript
block above is minified with the kernel's own JSMin and parsed as ES2018 — no ellipses in code
blocks, no `?.` or `??`, and every `OB.UIKit` name in this prose must be in `symbols[]`.

## 10. Decisions, and what they cost

| Decision | Cost |
| --- | --- |
| Axis ignores `q` | Columns of dashes when the filter is narrow |
| Column totals over the filtered set, not the page | A number the reader cannot verify by adding up the visible column — mitigated by labelling it |
| Cells only for the page | Five queries per request instead of one |
| `limit` clamped to 200 server-side, sorts a whitelist | A URL asking for 1000 gets 200; a new sort means touching the handler |
| Search on code and name only | Searching by warehouse or attribute needs a second control |
| Server-side everything on 26 products | Looks like over-engineering, and on this data it is |

That last row is the honest summary of this sample: it does not show these techniques are *needed*
here, it shows what they look like written correctly, on data small enough to fit one document.
