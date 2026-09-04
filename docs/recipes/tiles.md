# Recipe: tiles

**Prescriptive.** This tells you what to build and in what order -- the shape of the client and the
contract it needs from the server. Signatures: `docs/api/uikit.d.ts`. Whole windows: the samples.

## 1. What a tile row is, and what it is not

A tile row is a region of **aggregate numbers over the whole readable population** -- counts, sums,
aging buckets, per-department cards -- above a list or detail that shows a *slice* of it. Its job is
to keep the slice honest: the reader sees 12 rows and, next to them, that there are 1,840.

* **It is not a dashboard.** No window in the kit is a page of tiles and nothing else, and none
  should be. A tile row is the top region of a window that also *does* something.
* **It is not a framework primitive.** There is no `.uik-tile`, `.uik-stat` or `.uik-card` in
  `css/uikit.css`. Tiles are your own two rules (§6), or `OB.UIKit.bars` / `OB.UIKit.rail`.
* **It is not necessarily read-only.** In four of the five windows below the tiles are *also* the
  filter control -- the normal case, and where §2 gets broken.

Distilled from five shipped windows:

| Window | sample doc | tile region | the tiles are |
| --- | --- | --- | --- |
| `ETDEMO_Stock` | `docs/samples/stock-pivot.md` | `summary` | read-only text |
| `ETDEMO_Alerts` | `docs/samples/alerts-inbox.md` | `rail` | status filter, `aria-pressed` |
| `ETDEMO_Cash` | `docs/samples/cash-portfolio.md` | `rail` | aging filter, `OB.UIKit.bars` |
| `ETDEMO_Partner360` | `docs/samples/partner-360.md` | `tabs` | counted tab strip |
| `ETOKRS_Review` | `docs/samples/okr-review.md` | `rail` | department filter |

## 2. The rule: an aggregate ignores the filter it offers

**A tile that offers a filter must not count only what that filter selects.** If clicking "Overdue"
makes the Overdue tile read 12, it has stopped being a measurement and become a caption -- and the
user can no longer see that Current holds 400.

So: navigation aggregates are computed **over the whole readable set**, and only the detail region
narrows. The five windows differ in what "narrows" means, never in this.

**Enforce it in the parameter list, not by remembering.** Aggregate and detail are separate methods,
and the filter is simply absent from the aggregate's parameters, so no later edit can quietly start
using it. Language-independent; in the samples it reads:

<!--cite modules/com.etendoerp.uikit.samples/src/com/etendoerp/uikit/samples/cash/Portfolio.java|287|private JSONArray bucketRows(Connection conn, String asOf, String sotrx, String cur)-->
<!--cite modules/com.etendoerp.uikit.samples/src/com/etendoerp/uikit/samples/cash/Portfolio.java|338|private JSONArray partners(Connection conn, String asOf, String sotrx, String cur, String bucket)-->

The same discipline, four more times: `ETDEMO_Stock`'s warehouse axis never reads the search text;
`AlertInbox.statuses()` receives only the visibility parameter; `PartnerHead`'s totals are not
tab-aware; `ETOKRS_Review`'s stats cover every department the role reads, not the selected one.

Write the check before the window: request the datasource twice, with and without the filter, and
assert the aggregate block is byte-identical.

> **R2 note.** These datasources run raw SQL on a borrowed connection and hand-write only the
> client/organisation predicate. That is under review, not a pattern to copy: the target is HQL
> through `OBQuery`/`OBCriteria` with the DAL's default filtering, which is where readable client
> and organisation, the active flag and entity access come from. Copy the parameter discipline
> above and the contract in §3, not the query bodies. Permission filtering belongs in the query and
> never in `render` -- fact F6, `docs/guides/actions-and-permissions.md`.

## 3. Complete key sets, with zeros, seeded on the server

A tile row must not change shape when the data changes. Seed the full set of keys on the server
with zeros, then overwrite the ones the query returned -- `AlertInbox` does this with four statuses,
`Portfolio` with five aging buckets, `PartnerHead` with six document kinds. Two reasons:

* **A missing row is not a zero.** A grouped query returns nothing for an empty bucket, so rendering
  straight off the result set drops "Overdue: 0" exactly when it matters.
* **Never derive the set in the client.** A key list built from the rows you happened to fetch
  depends on the page number.

## 4. State and params

Tiles hold no state of their own. What they need is already in the two things the view has:
**`state`** carries the *selection* the tiles offer -- `status`, `bucket`, `dept`, `tab` -- as a
scalar id (`''` for none), never as a set; one tile is active at a time. **`params(state)`** must
include that key, because it is also what the bookmark publishes: a cockpit whose filter is not in
the URL cannot be sent to a colleague.

Do **not** give the aggregate its own alias merely to escape the filter. One datasource returning
`{ tiles, rows, page }` is the shape all five windows use, and it is what keeps the numbers on
screen consistent: computed in one transaction, against one snapshot. Split into a second alias
only when the tiles are genuinely *lazy* -- see `docs/recipes/master-detail.md` §3.

## 5. Rendering

One region, one string, no inner state, every visible word through `t('KEY')`.

```js
/* ETDEMO_Stock, region 'summary' -- the read-only shape: numbers and a sentence. */
function summaryRegion(state, data) {
  var K = OB.UIKit;
  var d = data.stock;
  if (!d) { return ''; }
  return K.html`
    <div class="stk-sum">
      <span class="stk-stat"><b>${K.fmt(d.page.total, 'int')}</b>
        <em>${K.t('ETDEMO_StockProducts')}</em></span>
      <span class="stk-stat"><b>${K.fmt(d.summary.grand, 'qty')}</b>
        <em>${K.t('ETDEMO_StockGrand')}</em></span>
      <p class="stk-note">${K.t('ETDEMO_StockAxisNote')}</p>
    </div>`;
}
```

```js
/* The filtering shape: the tile is a button, and its count still ignores the click. */
function railRegion(state, data) {
  var K = OB.UIKit;
  var tiles = (data.pf && data.pf.buckets) || [];
  var chips = tiles.map(function (b) {
    var on = state.bucket === b.id;
    return K.html`<button type="button" class="uik-chip ${on ? 'on' : ''}"
        data-bucket="${b.id}" aria-pressed="${on ? 'true' : 'false'}">
      ${K.t(b.labelKey)} <b>${K.fmt(b.amount, 'amount', { currency: data.pf.currency })}</b>
    </button>`;
  });
  return K.html`<div class="uik-rail">${chips}</div>`;
}
```

1. **Interpolate the array, never `.join('')` it.** `html` returns already-escaped `Raw`; joining
   flattens it to a string the outer template escapes again, and the user sees markup.
2. **A number is not money.** `OB.UIKit.fmt(v, 'amount', { currency: ... })` with the symbol the
   datasource returned. There is no session currency in the client.
3. **Active state is `aria-pressed` plus `.uik-chip.on`**, not a colour alone.
4. **Never omit the region.** A region missing from the map `render` returns is written as the empty
   string, so a guard returning nothing on first paint makes the row vanish -- return a skeleton.
<!--cite modules/com.etendoerp.uikit/web/com.etendoerp.uikit/js/uikit.js|1289|out[r] === undefined ? '' : out[r]-->

## 6. The tile CSS is yours, and it is scoped

The runtime gives the view's root element `uik uik-<viewname lowercased>`, which is the hook to
write two rules without leaking into another window:

<!--cite modules/com.etendoerp.uikit/web/com.etendoerp.uikit/js/uikit.js|1030|root.className = 'uik uik-' + name.toLowerCase();-->

```css
.uik-etdemo_stock .stk-stat b { font-weight: 700; font-variant-numeric: tabular-nums; }
```

Colours from `--uik-*` tokens only. The file goes in the window's own stylesheet, a `css` entry in
its `<window>.view.json` bundle after the kit's own -- never inline, never in `uikit.css`.

## 7. The sentence under the numbers

Every tile row in the kit carries a small permanent line saying what the numbers are over --
`ETDEMO_StockAxisNote`, `ETDEMO_AlertsRailNote`, `ETDEMO_CashAgingNote`. Not a tooltip: §2 makes the
number wider than the list, and the reader cannot know that unless it is on the screen.

## 8. Build order

1. **Decide the key set** and write it as a constant in the datasource (§3).
2. **Write the aggregate query with no filter parameter**, and the detail query with it (§2).
3. **Write the check that the aggregate is identical with and without the filter.** Before any JS.
4. **`AD_MESSAGE` rows**: one per tile label, plus the §7 sentence.
5. **The region function, read-only first** -- numbers on screen before any of them is clickable.
6. **Then make them buttons** -- `'click [data-bucket]'` calling `ctx.set` -- and re-run step 3.

## 9. Where the samples deviate from this recipe

* **`ETDEMO_Stock`** is the only genuinely read-only tile row -- the model of §5's first block. It
  folds *two* sentences into the note (`...AxisNote`, `...ScopeNote`), because its numbers are
  narrowed by role scope even though they are not narrowed by the filter.
* **`ETDEMO_Alerts`** writes. After an optimistic acknowledge the server counts are stale until the
  refetch lands, so it corrects the tile at render time from `state.acked` rather than showing a
  number it knows is wrong. Tiles above a write need that correction too.
* **`ETDEMO_Cash`** does not hand-roll tiles at all: the aging rail is `OB.UIKit.bars`, a shared
  scale across buckets for free -- prefer it when the tiles are comparable magnitudes of one unit.
  It also groups its detail rows by partner **in the client**, from a single payload.
* **`ETDEMO_Partner360`** hangs its counts on tab buttons, and its head alias is lazy (`when`), so
  the tiles do not exist until a partner is selected. The counts still ignore which tab is open.
* **`ETOKRS_Review`** computes two derived numbers per card (pace, state) in the client from two
  server numbers -- fine, that is arithmetic on aggregates, not aggregation. Its JS is also the one
  file in the kit with Spanish literals instead of `t('KEY')`: do not copy its strings.

## 10. Gates this recipe must survive

Every visible string through `t('KEY')`, no literal in JS; frozen classes and `--uik-*` tokens only;
no filtering, sorting or paging in the browser -- the aggregate is computed on the server and §8
step 3 proves it; permission filtering in the query; one IIFE per file, one `defineView`.
