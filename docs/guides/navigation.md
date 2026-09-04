# Opening standard windows and records

> **STATUS: shipped.** `OB.UIKit.nav` is in the runtime and `UikQuery.tabFor` is committed on the
> server side.

A uikit window is a reading surface. Maintenance — create, edit, delete, audit, attachments — is
what a standard window already does well, and re-implementing it inside a custom view is how a
cockpit turns into a second, worse ERP. So the drill-down is the most important interaction on the
screen after the filters: every number a user can question must lead to the record behind it.

## 1. The call

```js
OB.UIKit.defineView({
  name: 'ETDEMO_Cockpit',
  regions: ['list'],
  state: { rows: [] },
  render: function (state) {
    return { list: '<a href="javascript:void(0)" data-order="1">SO/0001</a>' };
  },
  on: {
    'click [data-order]': function (ctx, event, el) {
      OB.UIKit.nav(ctx.data.meta.orderTab, el.getAttribute('data-order'));
    }
  }
});
```

Two arguments, and only two. `recordId` is optional: without it the window opens in grid mode,
which is the right target for "show me all of them" rather than "show me this one".

`OB.UIKit.nav` **warns and returns** when there is nothing to navigate with — no tab id, or no
`OB.Utilities.openDirectTab` on the page — and it swallows a throw from core rather than letting it
out. This is not defensiveness for its own sake: the caller is a delegated click handler, and an
exception thrown there propagates out of the listener, so a single bad row can leave the whole
region unresponsive to every later click. A drill-down that does nothing is a much smaller failure
than a dead window.

## 2. What core does with it

`OB.Utilities.openDirectTab(tabId, recordId, command, position, criteria, direct, urlParams)` is
core's own entry point, and the wrapper deliberately exposes only the first two arguments.

<!--cite modules_core/org.openbravo.client.application/web/org.openbravo.client.application/js/utilities/ob-utilities.js|371|OB.Utilities.openDirectTab = function(-->

The mechanism matters because it explains the latency and the failure mode. `openDirectTab` does
**not** know which window a tab belongs to. It asks the server:

<!--cite modules_core/org.openbravo.client.application/web/org.openbravo.client.application/js/utilities/ob-utilities.js|431|  OB.RemoteCallManager.call(-->

`ComputeWindowActionHandler` answers with the window id, the tab id and the tab title, and only
then does `OB.Layout.ViewManager.openView` run. So:

- **A drill-down costs one round trip.** It is not instant, and there is no point pre-warming it.
- **A wrong tab id fails on the server, asynchronously**, after the click. There is nothing to
  validate in the browser.
- **The window is derived, not chosen.** You cannot open a record in a different window by passing
  a window id; the tab decides.

`recordId` also drives `direct`: when a record is given, core opens the form directly on it
instead of the grid with a filter.

## 3. The tab id comes from SQL. Always.

**Never hardcode an `AD_TAB_ID` in JavaScript, and never derive one from a window id in the
client.** A tab id in a JS constant is wrong in every instance but the one it was copied from: tab
rows are dictionary data, they differ per instance, they are re-created by module installs, and
nothing in the browser can detect that the constant has gone stale.

Worse, a window usually has several tabs on the same table. In this instance `c_order` has six
header tabs — sales order, purchase order, return material, return to vendor and so on — so a
guessed tab id does not fail loudly. It opens *the wrong window on the right record*: "Return to
vendor" for a sales order, with the record loaded and editable.

The resolution therefore belongs to the server, once, in `UikQuery.tabFor(conn, windowId,
tableName)`. It joins `AD_TAB` to `AD_TABLE`, filters both to active rows, and orders by
`tablevel, seqno` with `limit 1` — the lowest level and lowest sequence, which is the header tab
the window itself opens on. A miss returns `null`.

A datasource hands the ids down with the rest of its metadata:

```js
OB.UIKit.datasource('cockpit', { action: 'com.etendoerp.uikit.demos.orders.Cockpit' });
OB.UIKit.fetch('cockpit', {}, function (err, data) {
  if (err) {
    return;
  }
  OB.UIKit.nav(data.meta.orderTab, data.rows[0].id);
});
```

so the client never holds a tab id it did not receive in this session. Resolve once per request in
the datasource, put the ids under a `meta` key, and read them from `ctx.data` in the handler.

When `tabFor` returns `null`, pass it on. `OB.UIKit.nav` will warn and do nothing, and the correct
render for a row with no reachable tab is plain text rather than a link — an unavailable link is a
smaller failure than a wrong one, and a link that looks live and is not trains users to distrust
the whole screen.

## 4. Navigation is not authorization

Opening a standard window grants nothing and proves nothing. The target window enforces its own
access, and `OB.UIKit.nav` neither checks nor claims anything about the user's rights to the
record — showing a link is a UI decision, not a permission. The corollary for your own server
actions is fact F6, in `docs/guides/actions-and-permissions.md`: the window a request came from
authorizes none of it.

Do not use navigation as a substitute for a write, either. "Open the standard window so the user
can change the field themselves" is a legitimate design when the edit is rich or rare; it is a
cop-out when the cockpit's whole job is that one toggle. That case is `OB.UIKit.defineAction`.
