# Sample: receivables and payables portfolio

> **STATUS: shipped.** `ETDEMO_Cash` runs in the live instance: an `OBUIAPP_View_Impl` row whose
> `classname` is NULL, carrying an `OBCLKER_TEMPLATE` written by `verify/deploy-view.mjs`, so the
> window needs no Java view code; its gates are
> `modules/com.etendoerp.uikit.samples/verify/etdemo-cash.checks.mjs`. This document is the shape it
> was built to — if you are asked to change the window, change this document with it.

**Recipe shape:** an aggregate rail over a filtered detail table, two instruments (`OB.UIKit.bars`
for the aging spread, `OB.UIKit.spark` for the cash series) and a drill-down into a standard window.
What it adds to the OKR sample: a reference date that is part of the contract, a filter whose
selection deliberately does **not** move the numbers above it, and a currency rule that removes
rows and says so.

## 0. What was asked for, and what the data actually is

The request was a receivables cockpit: who owes us, how overdue, how much. The instance cannot
answer that honestly. Measured over invoice-backed outstanding schedules (`fin_payment_schedule`
joined to `c_invoice`, `outstandingamt > 0`, both rows active), with no role restriction:

| side | docs | partners | currencies | outstanding | due dates |
| ---- | ---- | -------- | ---------- | ----------- | --------- |
| AR (receivables) | 31 | 2 | 1 (EUR) | 8,691.30 | 2011-02-05 → 2015-05-05 |
| AP (payables) | 36 | 18 | 2 (EUR, USD) | 2,650,306.47 | 2011-04-02 → 2021-09-01 |

Receivables are a museum: 31 documents from two partners, the newest due in 2015, all more than
five years past due. Aged against their own newest due date the spread is
`cur 0 / d30 1 / d60 0 / d90 1 / d90p 29` — one bar, which is not a portfolio but a straight line.
Payables are alive: 18 suppliers, two currencies, a real spread (`cur 0 / d30 5 / d60 13 / d90 1 /
d90p 17`).

So the window **opens on payables and says why on screen** (`ETDEMO_CashWhySide`), listing the
documents, partners, currencies and due-date range of *both* sides next to the switch, one click
away. Opening on receivables to match the words of the request would have produced a demo whose
every screenshot showed one bar and two partner names. Reframing the question in public is honest;
a screen that looks rich because it was pointed away from the ugly half is not.

Two consequences worth knowing first.

- **What a role sees is much smaller.** Outstanding documents span two clients: F&B International
  Group holds 19 AP documents and **zero** AR ones, QA Testing the other 17 AP and all 31 AR.
  `admin`'s default role is F&B International Group Admin, so the live window — and every gate run —
  shows 19 payables and an empty receivables side, rendered as `ETDEMO_CashEmptySide` and not as a
  zero that looks like a bug.
- **The seed data mirrors payments across currencies.** `fin_payment` carries seven EUR and seven USD
  payments a month and only the amounts differ (the ratio is a EUR/USD rate), so the currency filter
  is working even where the counts look suspiciously equal — check amounts, not counts.

## 1. The user's workflow, in their words

Pick a side → pick a currency → look at how the portfolio is aged → click the tramo you care about →
see which partners are in it → open a document. And, always asked second and never in the request:
*is this getting better or worse?* — the twelve-month series.

## 2. State

Five keys, and only `open` never reaches the server.

| key      | values                                             | what it drives                    |
| -------- | -------------------------------------------------- | --------------------------------- |
| `side`   | `'AP'` (default) or `'AR'`                          | which half of the portfolio       |
| `asOf`   | `null` or `yyyy-MM-dd`                              | the reference date; see §4        |
| `cur`    | `null` or `C_Currency.id`                           | the one currency shown            |
| `bucket` | `null` or `'cur' \| 'd30' \| 'd60' \| 'd90' \| 'd90p'` | the detail table only          |
| `open`   | `{ [partnerId]: true }`                             | which partner rows are expanded   |

`bucket` costs a round trip even though it narrows nothing above the table. Deliberately: the server
decides what "the whole side" means, and a client filtering rows it already had would have to be
trusted to agree. Changing `side` clears `cur` and `bucket` — they name things that belong to the
side being left.

## 3. Regions

Four, declared in `regions[]`, which is what makes each replaceable on its own. The root gets
`uik uik-etdemo_cash` <!--cite modules/com.etendoerp.uikit/web/com.etendoerp.uikit/js/uikit.js|1048|root.className = 'uik uik-'--> and every rule in `css/cash-portfolio.css` is scoped under it.

| region    | contents                                                              |
| --------- | --------------------------------------------------------------------- |
| `filters` | side switch, the `.uik-chip` reference-date chip, currency chips, the imbalance text, the exclusion note |
| `rail`    | five aging bars over the whole side, the portfolio total, the bucket chips |
| `series`  | twelve months of settled cash as a sparkline, with its first and last month labelled |
| `detail`  | partners as a `.uik-table`, each expandable into its documents        |

`loading: 'rail'` puts the first-load block where the numbers land; `keepScroll: ['detail']` keeps
the table where the reader left it when a chip is clicked.

## 4. The reference date — decision D5, and why `current_date` is banned

Aging is a subtraction, so it needs a day to subtract from. The server's today would put every
document in this instance in `d90p` — correct, useless, and useless in a way that looks like a bug
in the aging code rather than the age of the data.

The contract, implemented by `UikQuery.asOf`
<!--cite modules/com.etendoerp.uikit/src/com/etendoerp/uikit/server/UikQuery.java|246|public static JSONObject asOf(Connection conn, String requested, String maxDateSql)-->:

1. `asOf` given as a parameter and well formed → use it, `asOfSource: 'param'`.
2. Absent or malformed → **the maximum in-scope data date, computed in SQL**, `asOfSource: 'data'`:
   `max(ps.duedate)` over the outstanding invoice-backed portfolio, here **2021-09-01**.
3. Only if that query returns nothing → the server's today, `asOfSource: 'today'`.

The chip shows the date *and* which of the three it came from: a cockpit that quietly invents its own
reference date is worse than one that says which day it is talking about. A malformed `asOf` falls
into case 2 rather than erroring: the parameter arrives from a URL, and the answer to junk in a URL
is the documented default, not a stack trace.

The easy thing to get wrong is the scope of case 2. The data fallback spans **both sides**, not the
visible one: the reference date is a property of the dataset, not of the half being looked at. If it
followed the side, the chip would jump to 2015-05-05 on a switch, and the empty AR side under the
gate's role would find no date at all and fall through to case 3 — the 2026-dated lie D5 exists to
prevent.

## 5. The aging buckets — the authoritative definitions

Let `days = asOf - duedate`, in whole days, both cast to `date`.

| bucket | condition        | label                |
| ------ | ---------------- | -------------------- |
| `cur`  | `days < 0`       | not yet due          |
| `d30`  | `0 ≤ days ≤ 30`  | 1 to 30 days         |
| `d60`  | `31 ≤ days ≤ 60` | 31 to 60 days        |
| `d90`  | `61 ≤ days ≤ 90` | 61 to 90 days        |
| `d90p` | `days > 90`      | more than 90 days    |

All five are always returned, in that order, zeros included: a rail that dropped its empty tramos
would change shape as the data moved, and an empty bucket would be indistinguishable from one never
computed. Measured for the gate's role at `asOf = 2021-09-01`, EUR payables: `d30` 2 docs /
144,740.20, `d60` 7 / 1,291,405.17 — total 9 / 1,436,145.37. USD: `d30` 3 / 119,730.00, `d60` 6 /
1,075,167.00, `d90` 1 / 105.00 — total 10 / 1,195,002.00.

**What ignores what, and why.** This is the asymmetry the window is built around. Selecting a tramo narrows the **table** and
nothing else; every aggregate is computed over the whole side and currency, ignoring `bucket`.

| answer key   | reads `side` | reads `cur` | reads `asOf` | reads `bucket` | why |
| ------------ | ------------ | ----------- | ------------ | -------------- | --- |
| `sides`      | no           | no          | no           | no             | the switch has to show both halves, including the one you are not on |
| `currencies` | yes          | no          | no           | no             | you cannot pick a currency from a list already filtered by it |
| `currency`   | yes          | yes         | no           | no             | the resolved choice: the request's, or the largest outstanding |
| `excluded`   | yes          | yes         | no           | no             | a count of what the currency rule removed, never a sum |
| `buckets`    | yes          | yes         | yes          | **no**         | the rail is the context for the selection; if it moved, the selection would redefine the thing being measured |
| `total`      | yes          | yes         | yes          | **no**         | its own query, so "the buckets add up" is a real assertion and not a tautology |
| `partners`, `rows` | yes    | yes         | yes          | **yes**        | the detail is what the selection is for |
| `series`     | yes          | yes         | yes          | no             | a trend narrowed to one age band would not be a trend |
| `meta`       | yes          | no          | no           | no             | the drill-down tab depends on the side; the scope does not depend on anything |

The gate asserts this instead of trusting it: for every non-empty tramo it fetches the answer again
with `bucket` set and demands identical bucket and portfolio totals while the rows narrow to exactly
that tramo's document count.

## 6. One currency at a time — and the cleanest demonstration of fact F6

Adding EUR to USD produces a number that is not money. So `cur` lives in state, exactly one currency
is ever shown, and documents in every other currency are **excluded from every figure on screen and
counted in visible text**: `10 documento(s) en otras monedas no se muestran: USD (10)` when EUR is
selected, 9 EUR documents when USD is. The default is the currency with the largest outstanding
amount — a choice, not a law, hence the chips.

The exclusion is also the sample's best demonstration of fact **F6**: `ViewComponent.generateView`
never consults `OBUIAPP_View_Role_Access`
<!--cite modules_core/org.openbravo.client.application/src/org/openbravo/client/application/ViewComponent.java|259|protected String generateView(String viewName)-->, so every scope
restriction has to live in the datasource's SQL. Here the split is clean by **organisation** — each
holds outstanding documents in exactly one currency — so a role narrowed to one organisation watches
the exclusion note disappear by itself, no client-side code and no branch in the view; nothing else
in the demo set makes the invariant that visible. The split is *not* geographical, though: the
`F&B US` organisations are the USD ones, while the organisation literally named **USA** holds EUR
documents (10 payables, 337.00; 24 receivables, 2,169.75).

## 7. Data contract

One datasource, `com.etendoerp.uikit.samples.cash.Portfolio`, one call, thirteen keys, four optional
parameters — `side`, `asOf`, `cur`, `bucket` — each validated against a whitelist or a regex.

```json
{
  "asOf": "2021-09-01", "asOfSource": "data", "side": "AP", "bucket": null,
  "sides": [{ "id": "AP", "docs": 19, "partners": 14, "currencies": 2, "oldest": "2021-07-02" }],
  "currencies": [{ "id": "102", "iso": "EUR", "symbol": "€", "docs": 9, "amount": 1436145.37 }],
  "currency": { "id": "102", "iso": "EUR", "symbol": "€", "docs": 9, "amount": 1436145.37 },
  "excluded": { "docs": 10, "currencies": [{ "iso": "USD", "docs": 10 }] },
  "buckets": [{ "id": "d30", "docs": 2, "amount": 144740.20 }],
  "total": { "docs": 9, "amount": 1436145.37 },
  "partners": [{ "id": "858B", "name": "Bebidas Alegres, S.L.", "docs": 1, "maxDays": 33 }],
  "rows": [{ "id": "FD3C", "invoice": "0F13", "doc": "10001732", "invoiced": "2021-06-30", "days": 33,
             "due": "2021-07-30", "amount": 839135, "partner": "858B", "bucket": "d60" }],
  "series": [{ "month": "2020-10", "docs": 7, "amount": 1951321.02 }],
  "meta": { "invoiceTab": "290", "scopeClients": ["23C5", "0"], "scopeOrgs": ["0", "E443"] }
}
```

`sides` and `buckets` are always complete — both sides, five tramos — and `series` is always exactly
twelve months. `meta.scopeClients` / `meta.scopeOrgs` report the scope the answer was computed
under, which is what lets the gate recompute the arithmetic in SQL under the same restriction
instead of guessing at `OBContext`. Each `rows` entry also carries `partnerName`, so the table needs
no second lookup.

**The currency symbol comes from the datasource** (`coalesce(nullif(cursymbol, ''), iso_code)`) and
reaches `OB.UIKit.fmt` as `{ currency: symbol }`: hard-coding it in the view would create a second
source of truth for what the number means.

**The series is gap-filled in Java, not in SQL.** The query groups by month and returns only months
that have payments — here nine of twelve, with 2021-07, 2021-08 and 2021-09 empty — and the twelve
slots are generated from `asOf` and merged afterwards. In SQL that is a `generate_series` left-joined
to the aggregate: more SQL to read and to keep in step with the scope clause, for a four-line loop.
The filling is not optional, though. `OB.UIKit.spark` spaces its points evenly, so nine points drawn
as twelve months puts the last three steps in the wrong place — a chart that lies about *when*,
which is the one thing a trend line is for.

## 8. AD rows required

- One `OBUIAPP_View_Impl` named `ETDEMO_Cash`, `classname` NULL.
- One `OBCLKER_TEMPLATE` of the same name whose `templateclasspathlocation` is
  `/com/etendoerp/uikit/samples/cash/templates/ETDEMO_Cash.ftl`; the file itself is written by
  `deploy-view.mjs` from `etdemo-cash.view.json` and never by hand.
- One `AD_MENU` entry with its `AD_TREENODE`, and `OBUIAPP_View_Role_Access` grants — which buy
  reachability from the menu, not filtering (§6).
- 44 `AD_MESSAGE` rows prefixed `ETDEMO_Cash`, module `com.etendoerp.uikit.samples`,
  `isincludeini18n = 'N'` — every visible string is one of them. The manifest's labels entry declares
  both `ETUIK_` (the runtime's) and `ETDEMO_`, and the bundle bakes them at deploy time, so **a new
  label needs a re-deploy**, not just a page reload.
- No `AD_PROCESS` and no write handler: a portfolio is a photograph of the data, so `writes[]` is
  empty and the CSRF gate reports SKIP — the honest result, not a hole.

## 9. The skeleton

```js
OB.UIKit.defineView({
  name: 'ETDEMO_Cash',
  regions: ['filters', 'rail', 'series', 'detail'],
  state: { side: 'AP', asOf: null, cur: null, bucket: null, open: {} },
  data: { pf: 'ETDEMO_CashPortfolio' },
  params: function (s) { return { side: s.side, asOf: s.asOf, cur: s.cur, bucket: s.bucket }; },
  render: function (s, d) {
    if (!d.pf || !d.pf.asOf) { return { filters: note(OB.UIKit.t('ETDEMO_CashEmptySide')) }; }
    return { filters: filters(s, d.pf), rail: rail(s, d.pf), detail: detail(s, d.pf) };
  },
  on: {
    'click [data-bucket]': function (ctx, e, el) {
      var id = el.getAttribute('data-bucket');
      ctx.set({ bucket: id === 'all' ? null : id, open: {} });
    }
  }
});
```

The rail, and the only place an amount is formatted:

```js
var rail = OB.UIKit.bars({
  label: OB.UIKit.t('ETDEMO_CashAgingAria'),
  items: data.buckets.map(function (b) {
    return { label: OB.UIKit.t(LABEL[b.id]), value: b.amount, state: STATE[b.id],
      sub: OB.UIKit.fmt(b.docs, 'int') + ' ' + OB.UIKit.t('ETDEMO_CashDocsWord') };
  }),
  format: function (v) { return OB.UIKit.fmt(v, 'amount', { currency: data.currency.symbol }); }
});
```

`c_invoice` is shown by several tabs in this instance — window 183 *Purchase Invoice* → tab **290**,
window 167 *Sales Invoice* → tab **263**, window 291 *Business Partner Info* → tab 553 at level 1 —
which is why the drill-down tab is resolved in SQL by `UikQuery.tabFor`
<!--cite modules/com.etendoerp.uikit/src/com/etendoerp/uikit/server/UikQuery.java|373|public static String tabFor(Connection conn, String windowId, String tableName)--> and never
written as a constant. When it resolves to nothing, the reference is rendered as plain text:

```js
var tab = data.meta.invoiceTab;
var ref = tab
  ? OB.UIKit.html`<a href="javascript:void(0)" data-invoice="${row.invoice}">${row.doc}</a>`
  : OB.UIKit.html`<span title="${OB.UIKit.t('ETDEMO_CashNoTab')}">${row.doc}</span>`;
```

## 10. Decisions, and what they cost

- **AP by default, stated on screen.** Costs a sentence of screen space and the risk of looking like
  an excuse; buys a real aging spread and a reader who knows which half of the data is dead.
- **`bucket` round-trips.** Costs one request per chip click on a screen whose data would fit in
  memory; buys a single definition of "the whole side", in SQL, and a gate that can prove it.
- **`total` is its own query.** Costs a query, buys an independent check that the five tramos add
  up; recomputing it from the buckets would only prove that addition works.
- **One currency, never converted.** Costs the multi-currency total a controller might ask for, buys
  numbers that mean something: conversion needs a rate, a date for the rate and a way to show which
  — three more things on screen, all of them wrong sometimes.
- **The reference date comes from the data.** Costs an explanation, on screen and here; buys a
  screen that is readable on a dataset that stopped in 2021.

## 11. What the gates demand

`node verify/check-window.mjs --view ETDEMO_Cash` runs W1–W4 (AD wiring, bundle on the classpath and
newer than its sources, the view served from `MainLayout/View`, the declared datasource answering
with all thirteen keys), W7 SKIPs for want of writes, and W5 loads this window's module, which
records five results:

| id    | what it asserts |
| ----- | --------------- |
| `W5`  | every bucket's document count and total recomputed in independent SQL against `asOf`, and the five adding up to `total` |
| `W6`  | `asOf` absent ⇒ `asOfSource: 'data'` and the date equals an independent `max(duedate)`; passed ⇒ `'param'`, with SQL counting how many documents change tramo at the shifted date and demanding at least one |
| `W8`  | the five bucket totals and the portfolio total identical with and without `bucket` selected, while `rows` narrows to exactly that tramo |
| `W9`  | `excluded.docs` equals an independent `count(*)` of the other currencies, no returned row carries another currency, and the currency brings a symbol |
| `W10` | exactly twelve consecutive months, gaps included, ending in the month of `asOf` |

None looks at the DOM: every claim this window makes is about numbers, so the gates recompute them.
