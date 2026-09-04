# Sample: order preparation and confirm

> **STATUS: shipped.** `ETDEMO_Picking` runs in the live instance: an `OBUIAPP_View_Impl` row whose
> `classname` is NULL, carrying an `OBCLKER_TEMPLATE` written by `verify/deploy-view.mjs`, so the
> window needs no Java view code; its gates are
> `modules/com.etendoerp.uikit.samples/verify/etdemo-picking.checks.mjs`. If you are asked to
> change the window, change this document with it.

**Recipe shape:** the only sample in the kit that **mutates a real ERP document** — `ETDEMO_Alerts`
writes to a table a batch job regenerates; this one calls `ProcessOrderUtil` and moves
`c_order.docstatus`. It is the reference for a **document-action whitelist on the server**, a **dry
run that is the default and must be disarmed on purpose**, a **scoped re-read that is the whole
authorization**, and an **ERP error printed verbatim**.

## 0. What was asked for, and what the data actually is

The brief asked for "about ten draft sales orders to prepare". Measured through the window's own
datasource, logged in as `admin` (role `42D0EEB1C66F497A90DD526DC597E6F0`, user `100`, readable
clients `23C59575…B389` and `0`, eight readable orgs), the truth is:

| `docstatus` | orders in scope | what the window offers on them |
| --- | --- | --- |
| `DR` draft | **8** | `CO` — confirm |
| `CO` completed | **712** | `RE` — reopen |
| `CL` closed | **1** | nothing |
| `VO` voided | **0** | nothing |
| total | **721** | |

Not ten drafts: eight. The missing ones (`50012`–`50015`, `RFC/2`) belong to the QA client, which
this role cannot read. Everything below is measured inside that scope: a number measured outside it
describes a screen nobody can open.

Four consequences, stated here rather than discovered later on screen:

1. **The interesting tone lives in the history, not the drafts.** Of 5993 order lines in scope, 488
   are non-stocked products and **487 of those sit on completed orders**, so the `na` tone — a line
   the light must refuse to judge — is unreachable from the drafts. Hence a selector listing `DR`
   first and then `CO` rather than hiding completed orders.
2. **All eight drafts are dated `2026-09-03`** and five carry exactly one stocked line each, so
   `asOf` reports `asOfSource: "data"` and a typical draft's light is one bar at 1/1.
3. **Three drafts have no lines at all** (`1000000`, `1000363`, `1000365`) — not a defect, but the
   fixture that makes section 6 possible: confirming a line-less order is a refusal core produces
   on its own, with a rollback, on a real document.
4. **Confirming really confirms.** There is no sandbox: `1000372` went `DR → CO → DR` in `c_order`
   during the gate run behind this document. The `RE` half is what makes that acceptable — the demo
   is repeatable because the window can put the document back.

## 1. The window

Three regions, and the load order the manifest fixes: runtime, styles, labels, app.

- `bar` — title, `asOf` sentence, status chips, counted rail, and the result of the last attempt.
- `list` — the selector: orders, draft first, searchable and paged.
- `detail` — the chosen order's lines and its availability light.

```js
var VIEW = {
  name: 'ETDEMO_Picking',
  regions: ['bar', 'list', 'detail'],
  loading: 'detail',
  keepScroll: ['list'],
  state: { status: '', q: '', page: 1, limit: 25, order: '', armed: false, last: null },
  params: function (s) {
    return { status: s.status, q: s.q, order: s.order, page: s.page, limit: s.limit };
  }
};
```

`armed` and `last` are presentation and must stay out of `params`. That is not tidiness:
`params(state)` is the datasource signature and `last` is mutated by the optimistic path, so putting
it there would refetch 721 orders on every click **and** again on every rollback.

## 2. The dry run is the default, and it is a server-side default

The button the reader meets first says *Simular*: it runs the whole handler — scoped re-read,
whitelist, core's action list — and mutates nothing. The real run takes two deliberate acts, arming
the strip (*Armar ejecucion real*) and then *Ejecutar de verdad*, which asks "*Vas a modificar este
pedido en el ERP. Continuar?*" through the action's `confirm`.

```js
OB.UIKit.defineAction({
  name: 'confirm',
  action: 'com.etendoerp.uikit.samples.picking.ConfirmOrder',
  payload: function (s, arg) {
    return { orderId: s.order, action: arg.action, dryRun: arg.dryRun !== false };
  },
  confirm: function (s, arg) {
    return arg.dryRun === false ? OB.UIKit.t('ETDEMO_PickingAsk') : '';
  },
  optimistic: function (s, arg) {
    s.last = { phase: 'sending', action: arg.action, dryRun: arg.dryRun !== false };
  }
});
```

The arming is a convenience; the **default that matters is on the server**, written so a parsing
mistake falls towards "simulate":

```java
private boolean isDryRun(JSONObject payload) {
  final Object flag = payload.opt("dryRun");
  if (Boolean.FALSE.equals(flag)) {
    return false;
  }
  return !"false".equalsIgnoreCase(String.valueOf(flag));
}
```

Deliberately not `optBoolean("dryRun", true)`: a missing key, a null, a number, an object and the
string `"maybe"` all mean *simulate* here; only `false` and `"false"` arm the write. Gate W5 posts
the flag absent, `true` and garbage, and all three answer `dryRun: true, applied: false`. And
`confirm` returns `''` for the simulation on purpose: a dialog on every harmless click teaches the
reader to dismiss dialogs, the habit that makes the dangerous one useless.

## 3. The whitelist, on the server

```java
static final Map<String, String> TRANSITIONS = transitions();  // DR -> CO, CO -> RE
```

Two entries. `CL`, `VO`, `PR` and everything else the dictionary offers are absent, and the
selector's `nextaction` column — `case o.docstatus when 'DR' then 'CO' when 'CO' then 'RE' else ''
end` — is generated from that same map, so screen and handler cannot disagree.

The handler's order is the part worth copying:

1. **CSRF first**, in a `final execute` in `UikAction`, before the body is entered — neither
   `KernelServlet` nor `BaseActionHandler` verifies it <!--cite src/org/openbravo/erpCommon/utility/CsrfUtil.java|37|public static void checkCsrfToken-->.
2. **The scoped re-read is the authorization** (section 4).
3. **The whitelist**, keyed by the status just read from the database, never by browser input.
4. **The caller's `action`, if present, must equal the whitelist's target** — checked, never obeyed:
   a precondition asserted by the caller is not a check.
5. **Core's action list is read *before* any write**, and only printed: information beside the
   verdict, never permission.
6. Only then, in the armed case, `process()`.

Every refusal is an envelope with HTTP 200 and `success: false`, never a throw — throwing would
collapse every reason into the generic `ETUIK_Failed` and lose the sentence:

```json
{"error":{"code":"ETDEMO_PickingBadTransition",
  "message":"Esta ventana solo confirma borradores y reabre completados. Estado actual: CL."},
 "success":false}
```

## 4. Who may see one order

Fact F6: `ViewComponent.generateView` never consults `OBUIAPP_View_Role_Access`
<!--cite modules_core/org.openbravo.client.application/src/org/openbravo/client/application/ViewComponent.java|259|protected String generateView-->,
so the window grants the caller nothing. The 29 role-access rows decide who finds the menu entry,
nothing more: **the predicate below is the whole access decision**, it is one string, and the write
re-runs the selector's own query before doing anything:

```sql
scope(o) and o.issotrx = 'Y'
```

`ConfirmOrder` calls `PickList.head(conn, id)` — same `FROM`, same predicate — and an id that does
not come back is answered exactly like an id that never existed: `ETDEMO_PickingNotVisible`,
*"Ese pedido no existe o no es visible para tu rol."* Never "forbidden", which would confirm the row
exists. Verified: an out-of-scope QA order and a nonexistent id give byte-identical answers from the
datasource (`order: null`, `lines: []`) and from the write.

`issotrx = 'Y'` is part of the predicate, not a filter: purchase orders share `c_order` and the
`DR`/`CO` statuses, so leaving it out would let a sales-order screen book a purchase order.

## 5. Reads before `process()`, and how the bean is obtained

`ProcessOrderUtil.process` commits and closes the DAL session inside itself
<!--cite modules_core/org.openbravo.advpaymentmngt/src/org/openbravo/advpaymentmngt/ProcessOrderUtil.java|124|OBDal.getInstance().commitAndClose();-->. Two rules follow, both load-bearing:

- **Every read happens before the call.** `documentNo`, `before` and `allowed` are already in the
  response object when `process()` runs; a `UikQuery.connection()` borrowed from the DAL before that
  line is unusable after it.
- **The post-state needs a new connection.** `statusNow` opens
  `new DalConnectionProvider(false).getConnection()` and re-reads the head; if that fails it degrades
  to the status read before the call — wrong by one refresh beats hiding a mutation that happened.

`applied` is `!before.equals(after)`: two reads of `c_order.docstatus`, one on each side of the call
— not a guess, and not the ERP's opinion.

The bean is **not** constructed with `new`: `ProcessOrderUtil` has an injection point
<!--cite modules_core/org.openbravo.advpaymentmngt/src/org/openbravo/advpaymentmngt/ProcessOrderUtil.java|45|private Instance<ProcessOrderHook> hooks;-->,
so a hand-built instance leaves `hooks` null and every module hooking order processing is silently
skipped. Outside a `@Inject` context the sanctioned lookup is
<!--cite modules_core/org.openbravo.base.weld/src/org/openbravo/base/weld/WeldUtils.java|88|public static <T> T getInstanceFromStaticBeanManager-->.

Core's action list comes from `getDocumentActionList`
<!--cite modules_core/org.openbravo.advpaymentmngt/src/org/openbravo/advpaymentmngt/ProcessOrderUtil.java|138|public static List<String> getDocumentActionList-->,
guarded here because `ActionButtonUtility.docAction` returns null from its own catch block
<!--cite src/org/openbravo/erpCommon/ad_actionButton/ActionButtonUtility.java|93|return null;--> and
the list method then iterates it and throws `NullPointerException`. Caught, logged, reported as an
empty list: "core told us nothing" is honest, and it never becomes permission.

## 6. The ERP's own sentence, verbatim

Confirming a line-less draft, armed, against the real process:

```json
{"orderId":"232E6BDB…86F7E","documentNo":"1000363","action":"CO","dryRun":false,
 "before":"DR","allowed":["CO","PR","VO"],"after":"DR","applied":false,
 "error":{"code":"ETDEMO_PickingErpError",
          "message":"The order cannot be booked because it has no lines"},
 "success":false}
```

The row afterwards: `1000363 | DR | processed=N`. `ProcessOrderUtil` rolled its own transaction back,
so `after` equals `before` and `applied` is false — stated, not inferred.

`message` is `OBError.getMessage()` and nothing else: not prefixed, not rewritten, not translated.
It arrives in English because core's message table has no Spanish row for it, and that is
information — a doctored sentence would hide which layer refused. The screen prints it in a `<q>`
under a heading of ours, *"El ERP responde"*, so the reader can tell whose words are whose.

## 7. The asymmetry table

| state moves | `statuses` | `total` | `orders` | `order` + `lines` |
| --- | --- | --- | --- | --- |
| `status` (chip) | **no** | **no** | narrows | untouched |
| `q` (search) | **no** | **no** | narrows | untouched |
| `order` (selection) | **no** | **no** | **no** | *is* the detail |
| `page`, `limit` | no | no | pages | untouched |

The four status counts and `total` are computed in SQL over everything the role may see, every
filter ignored. **Selecting an order changes nothing but the detail**: a counter that moved when you
clicked a row would answer a question nobody asked. Gate W11 sends five probes, two of them changing
only `order`. `statuses` always returns all four states, zeros included — `VO` is 0 here and still
occupies its chip, so the row does not reflow as data arrives.

## 8. The availability light

Per line, in SQL, from the order's own warehouse:

| quantity | definition |
| --- | --- |
| `pending` | `greatest(0, ol.qtyordered - ol.qtydelivered)` |
| `stocked` | `p.isstocked = 'Y' and p.producttype = 'I'` |
| `onhand` | `sum(m_storage_detail.qtyonhand)` over locators of `o.m_warehouse_id`, else 0 |
| `tone` | `na` if not stocked · `done` if `pending <= 0` · `ok` if `onhand >= pending` · `partial` if `onhand > 0` · else `short` |

Three decisions in that table:

- **`greatest(0, …)` is a clamp, not decoration.** An over-delivered line has
  `qtydelivered > qtyordered`, and a negative pending renders as a bar pointing the wrong way and a
  red light on a finished line. Gate W10 sets `qtyordered = -1` on a real line in a `try/finally`,
  asserts `pending: 0, tone: done`, and restores it.
- **A service line is grey, never green:** it has no stock to be short of, and painting it
  available would claim an availability nobody measured.
- **The light counts stocked lines only** — `covered / stocked` — so a service line neither helps
  nor hurts the ratio, and the service count is printed beside it as its own sentence.

```js
function semaphore(lines) {
  var out = { stocked: 0, services: 0, ok: 0, partial: 0, short: 0, done: 0 };
  lines.forEach(function (l) {
    if (l.tone === 'na') { out.services += 1; return; }
    out.stocked += 1;
    out[l.tone] += 1;
  });
  return out;
}
```

`OB.UIKit.meter(covered / sem.stocked, 1)` draws it, `OB.UIKit.badge` counts the exceptions, and
`OB.UIKit.nav(tab, id)` opens the order on tab `186`, resolved in SQL from window `143` and never
hardcoded: `c_order` has six header tabs, and a constant would open a return window for a sale.

## 9. What this window does not do

- **It does not use `com.smf.jobs.defaults.ProcessOrders`.** That action is shaped for the Jobs
  framework's request; from a `BaseActionHandler` the honest call is `ProcessOrderUtil` — which is
  what the Jobs action itself ends up calling anyway.
- **It does not check availability before confirming.** The light is advice, not a gate: core owns
  what a document may do, and a second copy of that judgement would only be staler.
- **It ignores the order's own `docaction` column**, so what this screen can do does not change with
  the document's stored preference. And there is no bulk confirm: one order, one whitelist lookup,
  one process call.
- **`writes[]` is declared with `dryRun: true`** and no `action` key, so the manifest's replay is
  valid whether the fixture is `DR` or `CO`, and mutates nothing. The armed path belongs to gate W6,
  which owns its fixture and restores it.

## 10. Gates

`verify/etdemo-picking.checks.mjs`, run by `check-window.mjs --view ETDEMO_Picking`. W1–W4 and W7
are the runner's; W5, W6, W8–W11 are this window's. All eleven pass.

| id | what it asserts |
| --- | --- |
| W5 | three bodies — flag absent, `true`, garbage — all answer `dryRun: true, applied: false`, and `c_order.docstatus` stays `DR` |
| W6 | the armed `CO` really moves `docstatus` and the armed `RE` puts it back, so the gate is repeatable; a `finally` restores the fixture |
| W8 | a status outside the whitelist is refused with `ETDEMO_PickingBadTransition`, HTTP 200 and the row intact, and an out-of-scope order with `ETDEMO_PickingNotVisible` |
| W9 | service lines are `na`, and every stocked line carries the tone `pending` and `onhand` dictate |
| W10 | with `qtyordered = -1` the line answers `pending: 0, tone: done`, and the fixture is restored |
| W11 | five probes, two of them only changing the selected order, leave the four counts identical, each matching an independent `count(*)` |

W6 is the first gate in the repository that commits a change to a business document. It is built
around the round trip rather than a snapshot: `DR → CO → RE` returns the document through the ERP's
own process, which is stronger than restoring the column by hand — and the only reason a gate is
allowed to touch `c_order` at all.
