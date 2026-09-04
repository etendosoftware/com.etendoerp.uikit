# Recipe: master-detail

**Prescriptive.** This tells you what to build and in what order. For a signature go to
`docs/api/uikit.d.ts`; for a whole window go to the sample it was distilled from. This recipe is
about the **shape of the client**: regions, state, `params`, aliases, lifecycle.

## 1. Which of the two shapes you are building

A master-detail window shows a **population** and one **selected member** of it at the same time.
Two shapes, and the choice decides everything downstream:

**A. Separate panes.** The master is a searched, paged list in its own region; selecting loads the
detail from *its own datasources*, lazily. Use it when the detail is large, unbounded or tabbed --
a partner's documents. One sample: `ETDEMO_Partner360`.

**B. Inline disclosure.** The rows expand in place; the detail comes out of the **same payload**
that drew the row. Use it when the detail is small and bounded -- the invoices behind an aging
bucket. Two samples: `ETDEMO_Cash`, `ETOKRS_Review`.

Choose B unless the detail cannot be bounded. It is one datasource, one transaction, no `when`, no
alias bookkeeping, and master and detail can never disagree with each other.

| Window | sample doc | shape | selection state |
| --- | --- | --- | --- |
| `ETDEMO_Partner360` | `docs/samples/partner-360.md` | A: `dir` / `head` + `docs` | `bp` scalar |
| `ETDEMO_Cash` | `docs/samples/cash-portfolio.md` | B: rows expand | `open` bag |
| `ETOKRS_Review` | `docs/samples/okr-review.md` | B: cards expand | `open` bag |

**Two things this recipe does not cover.** `ETDEMO_Alerts` is *not* master-detail -- a filtered list
with a write and no detail pane; look there for the write path (§7), not the shape. And a window
that acts on a *basket* of selected records has no sample here: nothing in the kit multi-selects, so
that is extending the pattern, not following it.

## 2. State

`state` is JSON only -- no `Date`, function, DOM node or cycle -- because an optimistic write
snapshots it with `JSON.stringify` to roll back. Beyond that:

* **Shape A: the selection is one scalar id**, `''` when nothing is selected (`bp: ''`). Not an
  object, not an array: one member is shown, and `''` is what the `when` in §3 tests.
* **Shape B: the disclosure set is a bag**, `open: {}`, driven by `ctx.toggle('open', id)`. It is a
  set of *open panels*, not a selection -- several may be open, and no request depends on it.
* **The master's keys and the detail's page key are separate.** `ETDEMO_Partner360` carries `page`
  for the directory and `dpage` for the documents; one shared `page` refetches the master.
* **Reset the disclosure bag whenever the population changes.** `ETOKRS_Review` does exactly this,
  `ctx.set({ dept: el.dataset.dept, open: {} })`: panel ids from the previous department are
  meaningless, and a stale bag silently re-opens an unrelated row.

That reset matters for a second reason. The runtime clones `spec.state` **shallowly** into each
instance, and `ctx.toggle` mutates the bag in place rather than replacing it:

<!--cite modules/com.etendoerp.uikit/web/com.etendoerp.uikit/js/uikit.js|950|this.uikState = isc.shallowClone(spec.state);-->
<!--cite modules/com.etendoerp.uikit/web/com.etendoerp.uikit/js/uikit.js|1093|var bag = self.uikState[key] || {};-->

So the `{}` you wrote in `spec.state` is not proven to be a fresh object per open tab, while
scalars -- which `ctx.set` replaces -- are safe. Prefer scalars; where you need a bag, replace it
with `ctx.set({ open: {} })` at every population change, which unshares it.

## 3. Data: the lazy alias is the spine of shape A

This is the whole mechanism, and shape A rests on it. An alias is either a datasource name or an
entry of `{ source, params, when, keep }`:

<!--cite modules/com.etendoerp.uikit/web/com.etendoerp.uikit/js/uikit.js|823|function dataEntry(value) {-->

```js
/* ETDEMO_Partner360: three aliases, three conditions. The shape to copy for shape A. */
var spec = {
  name: 'ETDEMO_Partner360',
  regions: ['dir', 'head', 'tabs', 'docs'],
  loading: 'dir',
  keepScroll: ['dir', 'docs'],
  state: { q: '', page: 1, bp: '', tab: 'summary', dpage: 1 },
  data: {
    /* The master. Its params never mention bp or tab, so selecting never refetches the list. */
    list: {
      source: 'ETDEMO_P360List',
      params: function (s) { return { q: s.q, page: s.page, limit: 20 }; }
    },
    /* The detail head: requested only once something is selected. */
    head: {
      source: 'ETDEMO_P360Head',
      params: function (s) { return { bp: s.bp }; },
      when: function (s) { return !!s.bp; }
    },
    /* The detail body: also gated on the open tab, and paged on its own key. */
    docs: {
      source: 'ETDEMO_P360Docs',
      params: function (s) { return { bp: s.bp, tab: s.tab, page: s.dpage, limit: 20 }; },
      when: function (s) { return !!s.bp && s.tab !== 'summary'; }
    }
  },
  /* Every key, including the ones no alias sends: this is also the bookmark. */
  params: function (s) {
    return { q: s.q, page: s.page, bp: s.bp, tab: s.tab, dpage: s.dpage };
  }
};
```

Five rules, all load-bearing:

1. **Give every alias its own `params`.** An alias with no `params` inherits the view's and reloads
   whenever *any* view key moves -- which is how selecting a partner refetches the directory.
2. **`when` is the laziness**, and it tests the selection, not the data. No request goes out for a
   detail nobody asked for, and `ui.first` stays honest because the master alone gates it.
3. **`keep` defaults to true, so leave it alone.** When a `when` turns false the alias holds its
   last value, so reopening a tab, or reselecting the partner already loaded, costs no round trip.
   Set `keep: false` only when a stale value would be *wrong* -- and then handle `undefined`.
<!--cite modules/com.etendoerp.uikit/web/com.etendoerp.uikit/js/uikit.js|1205|next[alias] = was[alias];-->
4. **A refetch happens only when an alias's signature actually moves.** Same params, no request:
   that is why paging the detail is one request, not three.
<!--cite modules/com.etendoerp.uikit/web/com.etendoerp.uikit/js/uikit.js|1215|if (sig !== was[alias] || self.uikData[alias] === undefined) {-->
5. **The view-level `params` still names every key**, including the ones no alias reads: it is what
   `getBookMarkParams` publishes, so a master-detail window whose selection is missing from it
   cannot be linked to. History moves only when that signature moves.

**Shape B has none of this.** One alias, no `when`, and the detail rows are grouped out of the same
payload -- `ETDEMO_Cash` builds a `byPartner` index at render time. Do not reach for a second alias
to save a few rows; reach for it when the detail is unbounded.

## 4. Regions

Name a region per job, in paint order: `['dir', 'head', 'tabs', 'docs']`. The master is one region
and the detail two or three, because a region is rewritten only when its string changed -- so
paging the documents does not touch the directory's DOM, nor typing blank the detail.

* **`loading` is the master**, not the detail: it is the region that shows the first-load block.
* **`keepScroll` covers every scrollable region** -- `['dir', 'docs']`. Selecting *redraws* the
  master (the row is now highlighted) without *refetching* it, and the list would jump to the top.
* **Return every region, every time.** A region missing from the map `render` returns is written as
  the empty string: return an explicit empty state for `head`/`docs`, not nothing.
* **Render from `ui`, not from guesses**: `ui.first` for the initial skeleton, `ui.busy` for the
  in-flight hint, `ui.errors[alias]` beside the pane that failed -- a detail that could not load
  must not blank a master that is perfectly good.

## 5. The datasource contract

The recipe does not tell you how to query. It tells you what each pane's datasource must return,
because that is what fixes the division of labour:

* **The master returns one page and the population's total** -- narrowed, ordered and limited on
  the server, the count as its own query. Never limit a count, never use `rows.length` for it.
* **Each detail pane returns exactly what its region renders**, for the one selected id it was
  given, with its own page and total.
* **Every aggregate is computed on the server**, over the whole readable set -- see
  `docs/recipes/tiles.md` §2 for the rule that the navigation numbers ignore the active filter.
* **Permission filtering lives in the query, never in the UI.** Fact F6: view generation does not
  consult `OBUIAPP_View_Role_Access`, so a user who knows a view name reaches the window by
  bookmark and the datasource is the only gate. Hiding a row in `render` protects nothing.
<!--cite modules_core/org.openbravo.client.application/src/org/openbravo/client/application/ViewComponent.java|259|protected String generateView(String viewName)-->

> **R2 note.** The datasources behind today's samples run raw SQL on a borrowed connection and
> hand-write only the client/organisation predicate. That is under review, not a pattern to copy:
> the target is HQL through `OBQuery`/`OBCriteria` with the DAL's default filtering, which is where
> readable client and organisation, the active flag and entity access come from. Take the contract
> above from these samples, not their query bodies.

**In the client, only** grouping and arithmetic over a payload you already have: `ETDEMO_Cash`
groups detail rows by partner, `ETOKRS_Review` derives pace and state from two server numbers.

**Sorting in the client is legitimate in exactly one case:** the payload is the whole population,
unpaged, and the sort key is derived and does not exist in the query -- `ETOKRS_Review` sorts by
*pace* over a full cycle tree. Once a list is paged, a client sort reorders one page and lies.

## 6. Selection and events

Selecting is one `ctx.set`, and it resets the detail's own keys:

```js
var on = {
  /* Registered first: the first matching rule wins, so a link inside a row shadows the row. */
  'click [data-invoice]': function (ctx, e, el) {
    var d = ctx.data.pf;
    OB.UIKit.nav(d && d.meta ? d.meta.invoiceTab : null, el.getAttribute('data-invoice'));
  },
  /* Shape A: selecting resets the tab and the detail page, never the master's page. */
  'click [data-bp]': function (ctx, e, el) {
    ctx.set({ bp: el.getAttribute('data-bp'), tab: 'summary', dpage: 1 });
  },
  /* Shape B: the row expands, and nothing is requested. */
  'click [data-partner]': function (ctx, e, el) {
    ctx.toggle('open', el.getAttribute('data-partner'));
  }
};
```

<!--cite modules/com.etendoerp.uikit/web/com.etendoerp.uikit/js/uikit.js|1069|First match wins. Registration order is the priority order-->

* **Register the specific selector before the general one.** A row containing a drill-down link
  needs `[data-invoice]` before `[data-partner]`, or the click only ever expands the row.
* **A drill-down tab id comes from the server**, never a constant in JavaScript: `c_order` has
  several header tabs and the wrong one opens the wrong window for the record.
* **One `data-` attribute per interactive element**, and a stable one: the runtime rebuilds a
  focused element's selector out of *all* its `data-*` attributes to restore the caret.

## 7. When the detail writes

Use `defineAction` plus `ctx.run`; never POST by hand. Three constraints, all from `ETDEMO_Alerts`,
the only sample in the kit that writes:

* **`optimistic` must not touch a key that `params(state)` reads**, or the mutation -- and the
  rollback -- changes a signature and provokes the refetch the optimistic path exists to avoid.
* **`refetch` names the detail alias, not `true`.** In shape A the master and the detail come from
  different sources; reloading everything throws away the list the user is reading.
* **Correct the aggregates at render time** from whatever the optimistic write recorded, until the
  refetch lands. Do not display a number you already know is stale.

## 8. Lifecycle: the debounce, and the hook that does not receive what you think

The master has a search box, so it has a debounce, and a debounce is per *instance*: two open tabs
of the same window must not cancel each other's pending search.

```js
var searchers = new WeakMap();

/* Keyed on ctx.state: the runtime creates that object once per instance and never replaces it. */
function searcher(ctx) {
  var fn = searchers.get(ctx.state);
  if (!fn) {
    fn = OB.UIKit.debounce(function (text) { ctx.set({ q: text, page: 1 }); }, 300);
    searchers.set(ctx.state, fn);
  }
  return fn;
}

var hooks = {
  /* destroy receives a ctx, not the state. Reach through ctx.state or the lookup misses. */
  destroy: function (ctx) {
    var fn = searchers.get(ctx.state);
    if (fn) {
      fn.cancel();
      searchers.delete(ctx.state);
    }
  }
};
```

<!--cite modules/com.etendoerp.uikit/web/com.etendoerp.uikit/js/uikit.js|999|spec.destroy(this.uikCtx());-->

**Get this one right; two shipped samples do not.** `activate`, `deactivate` and `destroy` all
receive a `ctx`, and `ctx` is a fresh object on every call -- so `destroy: function (s) {
searchers.get(s) }` looks up a key never inserted, finds nothing and cancels nothing.
`partner-360.js` and `stock-pivot.js` both have that bug, and `docs/samples/stock-pivot.md` §6.1
describes the cancel as if it worked. Timers taken with `ctx.later` need no cleanup: the runtime
owns them and refuses to fire into a dead view.

## 9. Build order

1. **Pick the shape** (§1). If the detail is bounded, stop at B -- one datasource, and skip to 4.
2. **The master datasource**: the contract in §5, page plus its own total.
3. **The detail datasources**, one per pane, each taking the selection id as a bound parameter.
4. **`AD_MESSAGE` rows** for every label, including the empty states of §4.
5. **The view with the master alias only.** Get search, paging and the pager total on screen first.
6. **Add the detail aliases with `params` and `when`** (§3), then `keepScroll` (§4).
7. **The `destroy` hook** (§8) before the search box ships, not after.
8. **Only then** the writes (§7).

## 10. Where the samples deviate from this recipe

* **`ETDEMO_Partner360`** is the source of §3 and follows it, but its `destroy` hook has the §8 bug,
  and its documents alias is gated on `s.tab !== SUMMARY`, so the summary tab renders from the
  `head` alias alone -- one more reason the two panes need separate aliases.
* **`ETDEMO_Cash`** groups the detail in the client and registers `[data-invoice]` before
  `[data-partner]` on purpose (§6). Its `open` bag is never reset, because its rows are partners
  and the filter changes which partners are listed, not what a partner id means.
* **`ETOKRS_Review`** deviates most, and is worth reading for the reasons: it sorts in the client
  (legitimate, §5), computes progress and pace in the client (legitimate), keeps `tab` and `sort`
  out of `params` so neither is bookmarkable (a real cost, accepted deliberately), and ships
  Spanish literals instead of `t('KEY')` (not acceptable). Its own doc calls the window
  master-detail and sketches a client-side re-filter in §8 the shipped code does not do.
* **`ETDEMO_Alerts`** is the counter-example named in §1: filter, list, write, no detail pane.
* **No sample uses `keep: false`**, and none multi-selects. Both are unproven ground.

## 11. Gates this recipe must survive

Every visible string through `t('KEY')`; no filtering, paging or -- for a paged list -- sorting in
the browser; permission filtering in the query, never in `render`; frozen classes and `--uik-*`
tokens only; state JSON-serializable; one IIFE per file, one `defineView`; and a check per pane
proving the master's request did not change when the selection did.
