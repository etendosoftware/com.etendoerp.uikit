# Sample: business partner 360

> **STATUS: shipped.** `ETDEMO_Partner360` runs in the live instance, reached from `AD_MENU` under
> the "UIKit demo" folder: an `OBUIAPP_View_Impl` row carrying a FreeMarker template with a NULL
> `classname`, so it needs no Java view code. This document is the shape the window was built to.
> Change the window, change this.

A business partner file: a searchable directory on the left, a header of per-tab totals for the
selected partner, one page of documents for the active tab. Six document kinds — sales and purchase
orders, sales and purchase invoices, receipts and payments — each in its own tab, each opening in
its own standard window. Read this sample when your window has **more than one datasource and they
are not all needed at once**: it is the reason the runtime has lazy aliases (§5), and the only
sample that resolves a different `AD_TAB` per row (§7.3).

The window is view impl `DE30C1A4B2F94E3E8A6D5C4B3A291501`; the app is
`web/com.etendoerp.uikit.samples/js/partner-360.js`, the four handlers live in
`src/com/etendoerp/uikit/samples/partner360/`, and the manifest and the gate plugin are
`etdemo-partner360.view.json` and `verify/etdemo-partner360.checks.mjs`, all under
`modules/com.etendoerp.uikit.samples`.

**Evidence.** The live window at 1440x900, opened from the menu, not a mockup:
[initial state](img/partner-360-initial.png) - [a lazy tab just loaded](img/partner-360-lazy-tab.png).

## 0. What this data can and cannot show — read this first

Unlike the stock and alert samples, **this window has genuinely good data in the demo instance.**
Measured on 2026-09-04, under the admin role's readable scope (clients
`23C59575B9CF467C9620760EB255B389` and `0`, eight organizations):

| partner | SO | PO | SI | PI | receipts | payments |
| --- | --- | --- | --- | --- | --- | --- |
| ES-C1/0001 Alimentos y Supermercados | 132 | 0 | 121 | 0 | 118 | 0 |
| US-C1/0001 Healthy Food Supermarkets | 117 | 0 | 137 | 0 | 135 | 0 |
| ES-C3/0001 Hoteles Buenas Noches | 121 | 0 | 124 | 0 | 122 | 0 |
| US-C3/0001 Sleep Well Hotels | 117 | 0 | 132 | 0 | 130 | 0 |
| ES-C2/0001 Restaurantes Luna Llena | 118 | 0 | 121 | 0 | 119 | 0 |
| ES-PR/0003 Refrescos Naturales | 0 | 120 | 0 | 120 | 0 | 92 |
| US-SP/0004 O2O | 0 | 0 | 0 | 2 | 0 | 2 |

25 partners are in scope; seven carry documents and the busiest carries 389, so the window has
real paging, real per-tab counts and a real reason for six tabs. Three honest limits:

1. **The sales/purchase split is real but not mixed.** Five customers carry only sales documents
   and receipts, one vendor only purchase documents and payments, and no partner is both — so the
   screen never shows six populated tabs at once. The empty tabs are correct, not broken.
2. **One currency per partner.** ES partners are in EUR, US partners in USD, and none mixes them.
   The header still counts currencies per tab and refuses to print a total when there is more than
   one (§7.2): the guard is untested by this data and still the only correct behaviour.
3. **Status names are English.** `AD_REF_LIST_TRL` has no `es_ES` rows and the only installed
   language is `en_US`, so the badge shows the raw code (`CO`, `DR`, `RPPC`) with the dictionary
   name beside it. Both are data; neither is a literal in the source.

## 1. The screen

Four regions, in DOM order: `dir`, `head`, `tabs`, `docs`.

- **`dir`** — search box plus twelve partners a page, ordered by document count descending, with
  code, name, tax id, customer/vendor marks and document count.
- **`head`** — the partner's name, code, tax id and group, linking into the standard window.
- **`tabs`** — seven buttons: a summary plus the six kinds, **each with its count already on it**.
  That is the whole point of the `head` alias: you see there are 137 sales invoices before opening
  the tab.
- **`docs`** — on the summary tab, all six kinds with count, total and last date; on any other tab,
  one page of twenty documents with number, date, amount and status.

Nothing is filtered, sorted, counted or paged in the browser.

## 2. State, and the bookmark

```js
OB.UIKit.defineView({
  name: 'ETDEMO_Partner360',
  regions: ['dir', 'head', 'tabs', 'docs'],
  loading: 'dir',
  keepScroll: ['dir', 'docs'],
  state: { q: '', page: 1, bp: '', tab: 'sum', dpage: 1 },
  params: function (s) { return { q: s.q, page: s.page, bp: s.bp, tab: s.tab, dpage: s.dpage }; },
  render: function () { return {}; }
});
```

Five scalars, all JSON-serializable, and every one of them in `params` — so a bookmark of the
payments tab of one partner, on page 2 of a filtered directory, reopens as exactly that. `q` and
`page` belong to the directory, `bp` picks the partner, `tab` and `dpage` belong to the document
list; that separation is what §3 is about.

## 3. What ignores what, and why

This is the table to read before changing anything.

| when this moves | `list` refetches | `head` refetches | `docs` refetches | why |
| --- | --- | --- | --- | --- |
| `q` (search) | **yes** | no | no | the directory is a directory; the open file does not change because you searched |
| `page` (directory) | **yes** | no | no | same |
| `bp` (pick a partner) | no | **yes** | **yes** | the file changes; the directory keeps its page and its search text |
| `tab` (pick a tab) | no | **no** | **yes** | the counts on the tab strip are already right for every tab |
| `dpage` (page documents) | no | no | **yes** | only the list is paged |

Two of those rows are the design, not an optimization:

- **`head` ignores `tab` on purpose.** Its six counts and sums are computed in SQL over *all* of
  the partner's documents, with no reference to the active tab, so the tab strip can show counts
  for tabs nobody has opened. A header that only counted the active tab would make the other six
  numbers unavailable exactly when they are most useful.
- **`list` ignores `bp` and `tab` on purpose.** Selecting a partner must not reshuffle the list you
  selected it from — you lose your place, and on a filtered page 2 you lose your filter too.

W5 and W8 in the plugin assert both directions: the header's totals are byte-identical when the
same request carries `tab=sum`, `tab=so` and `tab=pm`, and the directory's row order is identical
with and without `bp` and `tab`.

## 4. Data contract

Three aliases, three conditions:

```js
OB.UIKit.datasource('ETDEMO_P360Head', {
  action: 'com.etendoerp.uikit.samples.partner360.PartnerHead'
});
var data = {
  list: {
    source: 'ETDEMO_P360List',
    params: function (s) { return { q: s.q, page: s.page, limit: 12 }; }
  },
  head: {
    source: 'ETDEMO_P360Head',
    params: function (s) { return { bp: s.bp }; },
    when: function (s) { return !!s.bp; }
  },
  docs: {
    source: 'ETDEMO_P360Docs',
    params: function (s) { return { bp: s.bp, tab: s.tab, page: s.dpage, limit: 20 }; },
    when: function (s) { return !!s.bp && s.tab !== 'sum'; }
  }
};
```

Every alias declares **its own** `params`. An alias without them falls back to the view's `params`,
which here mentions all five state keys — and that would refetch the directory on every tab click.
The `when` predicates are the other half: `head` and `docs` are never requested at all until there
is something to request them for.

Response shapes, all three of which W4 checks for their top-level keys:

| alias | shape |
| --- | --- |
| `list` | `{ rows: [{ id, code, name, taxId, group, docs, customer, vendor }], page, meta: { q, partnerTab, scope } }` |
| `head` | `{ partner: { id, code, name, taxId, group, customer, vendor } \| null, totals: [{ tab, count, amount, currencies, currency, iso, last }], meta: { bp, tabs, partnerTab, scope } }` |
| `docs` | `{ rows: [{ id, docNo, date, amount, currency, iso, status, statusName }], page, meta: { bp, tab, table, tabId, scope } }` |

`meta.scope` publishes the readable clients and organizations the handler filtered on, so the gates
can rebuild the handler's row set in independent SQL instead of guessing at it.

## 5. Lazy aliases: the feature this window exists to exercise

Before decision D6 landed in the runtime, `uikLoad` refetched **every** alias on **every** state
change. On this window that meant clicking the "payments" tab reloaded the partner directory and
the header along with the document list — three requests, two of them for data already on screen,
and the directory's scroll position sacrificed for nothing.

Now the loader keeps a params signature per alias plus one for the view, and requests only aliases
whose own signature moved:

<!--cite modules/com.etendoerp.uikit/web/com.etendoerp.uikit/js/uikit.js|1197|uikParams is a signature per alias plus one for the view, so an alias is requested when-->

An alias whose `when(state)` is false is not requested at all. What happens to its cached value is
the `keep` flag, normalised with the other three keys in `dataEntry`:

<!--cite modules/com.etendoerp.uikit/web/com.etendoerp.uikit/js/uikit.js|841|function dataEntry(value) {-->

`keep` defaults to **true**, and this window leaves it there:

<!--cite modules/com.etendoerp.uikit/web/com.etendoerp.uikit/js/uikit.js|838|false the alias's last value is kept, so flipping a panel closed and open again costs no-->

So going from the invoices tab to the summary and back costs **no round trip**: the `docs` alias
kept its last value while `when` was false, and its signature has not moved since. `keep: false` is
the opt-out for a source whose stale answer would mislead — a live balance, a lock, a queue — and
none of the three here qualifies: a partner's order history does not change while you read it.

One more thing the same fix carries: only the *first* load blanks a region.

<!--cite modules/com.etendoerp.uikit/web/com.etendoerp.uikit/js/uikit.js|1205|wrote a loading block into a hardcoded region on every single refetch, which erased a-->

**How laziness is proved, and where it is not.** No gate here can observe which aliases the
browser fetched: a server sees three independent kernel requests and cannot tell a refetch from a
first fetch. The plugin therefore asserts the *data contracts* that make laziness safe — the header
is tab-independent, the list narrows, the directory does not move — and the proof that the client
skips the requests belongs to the runtime harness in `verify/`, which drives the view and counts
requests per alias. Do not add a "laziness gate" that passes by reading a response body.

## 6. The SQL, in five queries

All five run on the DAL connection from `UikQuery.connection()`, and every one of them ends in
`UikQuery.scopeClause` with `isactive = 'Y'` — the only place access is enforced (fact F6).

1. **Directory rows.** The three tables are `union all`-ed into a `doc` CTE of partner ids, grouped
   into `cnt`, then left-joined onto `c_bpartner` so a partner with no documents still appears with
   a zero. The `ilike` over code, name and tax id is `UikQuery.likeClause` bound with `bindLike`;
   the order is `docs desc, name, id` and the window is `limit ? offset ?` from `UikQuery.page`.
2. **Directory total.** `count(*)` over the same CTEs, so the pager's total is its own query.
3. **Header totals.** Six `union all` branches, one per kind, each
   `count(*), coalesce(sum(<amount>), 0), max(<date>), count(distinct c_currency_id)` filtered by
   partner and direction only. No tab appears anywhere in it.
4. **Document page.** One kind's rows, newest first, with its currency symbol and status name
   joined per row, `limit ? offset ?`.
5. **Tab resolution.** `UikQuery.tabFor(conn, windowId, tableName)` once per document kind:

<!--cite modules/com.etendoerp.uikit/src/com/etendoerp/uikit/server/UikQuery.java|373|public static String tabFor(Connection conn, String windowId, String tableName)-->

The taxonomy that drives 3, 4 and 5 lives in one place, `Partner360.KINDS`, as six constants of
`{key, table, dateCol, amtCol, statusCol, dirCol, dirVal, window}`. Nothing in it is user input, so
it can be concatenated into SQL while the partner id, the search text and the page stay bound
parameters. The direction column is **not** uniform: `c_order` and `c_invoice` use `issotrx`,
`fin_payment` uses `isreceipt`. A single boolean would have been wrong for two of the three tables.

## 7. The client, in the four places it is not obvious

### 7.1 One debounced setter per view

`OB.UIKit.debounce` is called per open view, keyed on the state object in a `WeakMap`, and cancelled
in `destroy`. A module-level debounce would be shared by two open copies of the window, and the
second would search for the first.

### 7.2 A currency that was returned, never one that was chosen

Amounts go through `OB.UIKit.fmt(value, 'amount', { currency: row.currency })` with the symbol the
datasource returned beside the amount. Where a header total spans more than one currency the
handler emits `amount: null` and the screen says so in words: an amount whose currency was guessed
is not money.

### 7.3 A tab id per document type, or no link

Six kinds, six standard windows, six different tabs — resolved in SQL, per kind, per request, and
handed down in `meta`. `c_order` alone has six level-0 tabs in this instance (sales order, purchase
order, return from customer, return to vendor, copy-from-orders, sales quotation), so a hardcoded
constant does not fail loudly: it opens the right record in the wrong window. When `tabFor` returns
null the row renders as plain text:

```js
var link = tab
  ? OB.UIKit.html`<a href="javascript:void(0)" data-doc="${row.id}">${row.docNo}</a>`
  : OB.UIKit.html`<span>${row.docNo}</span>`;
```

so the click handler can only ever be reached with a tab the dictionary returned, and
`OB.UIKit.nav` is never called with a null.

### 7.4 Status codes are data, badges are a mapping

`OB.UIKit.badge(row.status, STATES[row.status] || 'flat')` — eleven observed codes map to the four
badge states and anything unknown degrades to neutral. The dictionary name comes from
`AD_REF_LIST`, joined on the reference **the column itself declares** in `AD_COLUMN`, not on a
reference id in source: `CO` means "Complete", "Booked" or "Completed" depending on which of the
nine references holding that value you meant.

## 8. Labels

38 `AD_MESSAGE` rows, `ETDEMO_P360*`, module `com.etendoerp.uikit.samples`, client and org `'0'`,
`isincludeini18n = 'N'`, Spanish text. Every visible string goes through `OB.UIKit.t`, including
the six tab names, the pager captions and the three notes under the tables. The manifest declares
both prefixes, `ETDEMO_` and `ETUIK_`, so the runtime's own four keys are baked in too.

Labels are read at **deploy** time and written into the bundle. Editing a row does not change a
deployed window: re-run `verify/deploy-view.mjs`.

## 9. Styling

`partner-360.css` is scoped under `.uik-etdemo_partner360` and uses `--uik-*` tokens only. Tables
are `.uik-table`, pagers `.uik-pager`, the customer/vendor marks `.uik-chip` — frozen classes,
untouched here beyond layout. Above 900px the root becomes a two-column grid with the directory
sticky in column 1; below that it falls back to the runtime's stacked regions, because the region
markup is the same either way.

## 10. What the gates demand

`node modules/com.etendoerp.uikit/verify/check-window.mjs --view ETDEMO_Partner360` runs the shared
gates W1–W4 (AD wiring, bundle on the classpath, served through `OBUIAPP_MainLayout/View`, the
three declared datasources answering JSON with their required keys) and W7 skips: the window is
read-only, so there is no write to check the CSRF token on.

The four window-specific gates ask the datasources and the database, never the DOM:

| gate | asserts |
| --- | --- |
| W5 | every header count and sum equals an independent `count(*)`/`sum()` per kind; the totals are identical under `tab=sum`, `tab=so` and `tab=pm`; a request with no partner, an empty partner and an unknown partner each answers 200 with `partner: null` and no totals |
| W6 | each tab's document page has exactly as many rows as its header count claims, every returned id really belongs to that kind in SQL, the six row sets are pairwise disjoint, and `limit`/`offset` are the server's |
| W8 | the directory's total equals an independent count, the search narrows in SQL to a subset, pages 1 and 2 are disjoint, and neither `bp` nor `tab` changes the rows |
| W10 | all six resolved `AD_TAB_ID`s exist, are active and sit on the kind's own table, sales and purchase resolve to **different** tabs in all three pairs, and `partnerTab` is a `c_bpartner` tab |

The plugin is deliberately silent about laziness itself; §5 says why.

## 11. Decisions, and what they cost

| decision | instead of | cost |
| --- | --- | --- |
| three datasources with `when` | one datasource returning everything | three round trips on a cold partner instead of one, and three handlers to keep in step |
| header totals ignore the tab | counting only the active tab | six aggregates per header request, always, even for tabs the user never opens |
| `keep` left at its default | `keep: false` on `docs` | a revisited tab is free, and shows data as of when it was first opened |
| six kinds hardcoded in `Partner360.KINDS` | reading document types from `C_DOCTYPE` | new document types need a code change; in exchange, table and column names never come from a request |
| tab ids resolved per kind, per request | one lookup cached in a static | one extra dictionary query per request, and a module install can never leave a stale id behind |
| directory ordered by document count | alphabetical | the seven partners that have data are the seven at the top, which is what makes the demo demonstrate anything |
