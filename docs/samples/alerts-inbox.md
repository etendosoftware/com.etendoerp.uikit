# Sample: administrator alert inbox

> **STATUS: shipped.** `ETDEMO_Alerts` runs in the live instance: an `OBUIAPP_View_Impl` row whose
> `classname` is NULL, carrying an `OBCLKER_TEMPLATE` written by `verify/deploy-view.mjs`, so the
> window needs no Java view code; its gates are
> `modules/com.etendoerp.uikit.samples/verify/etdemo-alerts.checks.mjs`. This document is the shape
> it was built to — if you are asked to change the window, change this document with it.

**Recipe shape:** a counted rail over a filtered list, plus the one thing no other sample in the kit
has — a **write**. It is therefore the reference for `OB.UIKit.defineAction`: optimistic repaint,
rollback on failure, an in-flight guard that eats the second click of a double click, a server-side
whitelist, and a CSRF token that is verified before the handler body is entered.

**Evidence.** The live window at 1440x900, opened from the menu, not a mockup:
[initial state](img/alerts-inbox-initial.png) - [rail filtered to NEW](img/alerts-inbox-filtered-new.png)
- [after an optimistic acknowledge](img/alerts-inbox-after-ack.png).

## 0. What was asked for, and what the data actually is

The request was an alert inbox. The instance has one, and it is **not** a business inbox. Every
active alert in it was written by the dictionary's own consistency rules, and there are 36 of them
across 3 rules:

| rule | its tab | status | rows | reaches you by |
| --- | --- | --- | --- | --- |
| Columns with search reference and reference value null | 101 | `NEW` | 25 | `ad_alert.ad_role_id` → System Administrator |
| Wrong Purchase Order Payment Plan | 294 | `SUPPRESSED` | 10 | `ad_alertrecipient` (14 roles) |
| G/L ITEM WITHOUT ACCOUNTING | 800033 | `ACKNOWLEDGED` | 1 | both arms |

Three consequences, stated here rather than discovered later on screen:

1. **The default view of this window is not actionable.** `admin`'s default role is F&B
   International Group Admin, which is a recipient of two rules and is not the System
   Administrator. So the inbox opens on **11 alerts, of which zero are `NEW`**: 10 `SUPPRESSED` and
   1 `ACKNOWLEDGED`. The acknowledge button appears on `NEW` rows only, so at rest there is nothing
   to click. That is the data, not a bug, and section 9 says what to do about it for a demo.
2. **Switching role changes the window completely**, which is the point. As System Administrator the
   same window shows the 25 `NEW` dictionary alerts, because those are addressed to that role
   directly. Nothing in the client changes; the predicate in section 4 resolves differently.
3. **Every row here has a drill-down.** All 11 alerts the F&B admin sees carry both a
   `referencekey_id` and a rule tab, so the link in the first column always resolves. That is
   luckier than the plan assumed and it is worth not relying on: a rule with no `ad_tab_id` renders
   as plain text, and the gate does not require any particular ratio.

The upside of this dataset is real and is why the sample was built on it anyway: **alerts are
regenerable**. The alert process rewrites them from the rules, so a window that writes to
`ad_alert.status` is the one place in the kit where an experiment costs nothing. Nothing else in
Etendo would forgive being used this way, which is exactly why the write lives here.

## 1. The window

Three regions, and the load order the manifest fixes: runtime, styles, labels, app.

- `bar` — the title, the source sentence, the refresh controls, and the failure note.
- `rail` — status chips and the per-rule table, both counted over everything the role may see.
- `list` — the detail, the only region a filter reaches.

State is seven keys and only three of them are the server's business.

```js
var VIEW = {
  name: 'ETDEMO_Alerts',
  regions: ['bar', 'rail', 'list'],
  loading: 'list',
  keepScroll: ['list'],
  state: {
    status: '', rule: '', limit: 100,
    acked: {}, refreshMs: 30000, polling: true, note: ''
  },
  params: function (s) {
    return { status: s.status, rule: s.rule, limit: s.limit };
  }
};
```

`acked`, `refreshMs`, `polling` and `note` are presentation and must stay out of `params`. This is
not tidiness: `params(state)` is the datasource signature, so a key that the optimistic write
mutates would refetch the inbox on every click **and** again on every rollback — the refetch storm
the optimistic path exists to avoid. `loading: 'list'` puts the first-load block in the region that
will hold rows, and after that the runtime only marks the root busy, so a filter change no longer
blanks a painted screen.

## 2. The write

One action, declared once, invoked only through `ctx.run`.

```js
OB.UIKit.defineAction({
  name: 'ack',
  action: 'com.etendoerp.uikit.samples.alerts.AckAlert',
  payload: function (s, arg) {
    return { id: arg.id, status: 'ACKNOWLEDGED' };
  },
  optimistic: function (s, arg) {
    s.acked[arg.id] = true;
    s.note = '';
  }
});
```

Five things about that declaration, in the order they matter:

**No `refetch`.** The optimistic repaint already shows the new status; reloading the inbox on every
acknowledgement would recount every rule for one row. The next auto-refresh reconciles.

**The status in the payload is decoration.** `AckAlert` never reads it. It is sent because the
manifest's replayable `writes[]` payload needs a complete body, and because the optimistic path
needs a value to paint. A precondition asserted by the caller is not a check — the server re-reads
the row and consults its own table.

**`optimistic` marks, it does not overwrite.** `s.acked[id] = true` is a marker, and the rail's
correction is computed at render time from `rows` plus that marker. A row the user just acknowledged
still arrives from the server as `NEW` until the next refresh, so a stored correction would need
cleanup; a derived one lapses by itself the moment the server agrees.

**The in-flight guard is the double-click defence.** `ctx.run` returns `false` when the same
`(name, arg)` is already in flight, so the second click never leaves the browser. There is no
`disabled` attribute and no flag of our own.

```js
function onAck(ctx, e, el) {
  ctx.run('ack', { id: el.dataset.ack }, function (err, data) {
    if (err) {
      ctx.set({ note: OB.UIKit.t('ETDEMO_AlertsAckFailed') + ' ' + err.message });
      return;
    }
    if (data && data.changed === false) { ctx.set({ note: '' }); }
  });
}
```

**Failure is visible and the state is restored.** On error the runtime rolls the state back from the
snapshot it took before `optimistic` ran, and the callback puts the server's own sentence in `note`.
Because the rollback is a `JSON.stringify` snapshot, **state must be serializable** — which is why
the polling timer lives in a `WeakMap` keyed by the state object and not in the state.

## 3. The asymmetry table

| state moves | `statuses` | `rules` | `total` | `rows` |
| --- | --- | --- | --- | --- |
| `status` (chip) | **no** | **no** | **no** | narrows |
| `rule` (rail) | **no** | **no** | **no** | narrows |
| `limit` | no | no | no | truncates, and says so |

The rail is counted with both filters ignored, in SQL, over every alert the role may see. An inbox
whose counters only describe what is already on screen cannot answer the question an inbox exists
for — *what am I not looking at*. `statuses` always returns all four states, zeros included, so the
chip row does not reflow as the data changes.

## 4. Who may see one alert

Fact F6: `ViewComponent.generateView` never consults `OBUIAPP_View_Role_Access`, so the window
grants the caller nothing and **the predicate below is the entire access decision**. Core says the
same thing about its own alert datasource, in its own words:

<!--cite modules_core/org.openbravo.client.application/src/org/openbravo/client/application/ADAlertDatasourceService.java|92|Alert datasource is accessible by all roles-->

> `// Alert datasource is accessible by all roles. Fetch method implements security access based on`
> `// Alerts. Alerts are filtered based on each user/role.`

Every query in `AlertInbox` and the two in `AckAlert` share one string, `VIS`, so there is one
predicate and not five copies of one:

```sql
scope(a) and scope(r)
and (   a.ad_user_id = :user
     or (a.ad_user_id is null and a.ad_role_id = :role)
     or exists (select 1 from ad_alertrecipient p
                 where p.ad_alertrule_id = r.ad_alertrule_id and p.isactive = 'Y'
                   and (p.ad_user_id = :user
                        or (p.ad_user_id is null and p.ad_role_id = :role))))
```

Bind order is fixed and every caller repeats it: `scope(a)`, `scope(r)`, user, role, user, role.

**Two arms, because the schema has two**, and in this instance each one is exercised by real rows
with a *different* role: the direct arm is how the 26 dictionary alerts reach System Administrator,
and the recipient list is how the 10 purchase-order alerts reach the F&B admin. Core implements
only the second:

<!--cite modules_core/org.openbravo.client.application/src/org/openbravo/client/application/ADAlertDatasourceService.java|103|FROM ad_alertrecipient arecipient-->

That divergence is deliberate and it is the one place this window is **more** permissive than core's
own datasource: an alert addressed to you personally, whose rule lists no recipients, appears here
and not in core's alert bell. It is still scoped and still addressed to you. Section 9 records the
part of core's behaviour this window does not reproduce.

Status is normalised the same way core normalises it, so a NULL never leaks to the client as one:

<!--cite modules_core/org.openbravo.client.application/src/org/openbravo/client/application/ADAlertDatasourceService.java|172|coalesce(to_char(status), 'NEW')-->

## 5. The formulas the gate recalculates

Measured for `admin` (role F&B International Group Admin) at the time of writing:

| quantity | definition | value |
| --- | --- | --- |
| `total` | `count(*)` over `VIS` | 11 |
| `statuses[s].n` | `count(*)` grouped by normalised status, filters ignored | 0 / 1 / 0 / 10 |
| `rules[r].<status>` | `count(*)` per (rule, status), filters ignored | see section 0 |
| `rows` | the same predicate plus the two filters, ordered, `limit`-ed | 11 |
| probe role sees | the same predicate for a non-admin role | 10 |

The last row is the one that matters. 25 of the 36 alerts are addressed by role, so a gate that only
ever asks as `admin` proves nothing about the recipient filter: it would pass just as happily if the
predicate were `1 = 1` for anyone. So W8 creates a probe user for the stock `F&BESRNUser` role,
logs in over HTTP as that user, and asserts both halves — that it sees strictly fewer alerts, and
that every alert it lost is still **inside its own scope**, which is what makes the loss
attributable to `ad_alertrecipient` and not to the scope clause.

The probe carries `admin`'s own password hash, so it introduces no new secret, and it is left
`isactive = 'N'`, `islocked = 'Y'` in a `finally`: a verification script must not leave a usable
account behind.

## 6. The whitelist, on the server

`AckAlert` performs exactly one transition:

```java
private static final Map<String, String> TRANSITIONS = Map.of("NEW", "ACKNOWLEDGED");
```

`SOLVED` and `SUPPRESSED` are absent on purpose. Re-opening a resolved alert and un-silencing a
suppressed one are different decisions with different consequences, and a window whose single
button performs whichever of them the row happens to need is a window nobody can reason about.

The handler's order is the interesting part, and it is the order any write in this kit should use:

1. **CSRF first**, in a `final execute` in `UikAction`, before the body is entered. Neither
   `KernelServlet` nor `BaseActionHandler` verifies it, so each write verifies it itself:
   <!--cite src/org/openbravo/erpCommon/utility/CsrfUtil.java|37|public static void checkCsrfToken-->
2. **The scoped re-read is the authorization.** An id that does not come back is answered exactly
   like an id that does not exist — `ETDEMO_AlertsNotVisible`, never "forbidden", which would
   confirm the row exists.
3. **The whitelist**, with the current status named in the message, so a refusal is a sentence.
4. **The status and the visibility predicate are restated in the `UPDATE`'s `WHERE`.** The read and
   the write are two statements; between them another session can acknowledge the same row.
   Repeating both makes that a no-op instead of a second acknowledgement, and zero rows affected is
   reported rather than claimed as success.
5. **Idempotent**: acknowledging an already-acknowledged alert succeeds with `changed: false`. That
   is what makes the manifest's `writes[]` payload safe for the gate to replay on every run.

There is no explicit commit. The DAL request filter commits the borrowed connection when the request
ends without error and rolls it back otherwise, so raw SQL here joins the request's transaction.

A domain refusal is an envelope, not an exception — throwing would collapse every reason into the
generic `ETUIK_Failed` and lose the sentence:

```json
{"error":{"code":"ETDEMO_AlertsBadTransition","message":"Solo se puede revisar una alerta nueva. Estado actual: SUPPRESSED."},"success":false}
```

HTTP 200 with `success: false`. Judging a write by its status code would call that a success, which
is why gate W7 reads the body.

## 7. Auto-refresh, and who owns the timer

`ctx.later` returns a cancel function and the runtime cancels every pending timer on destroy, so a
one-shot timer that re-arms itself in its own callback becomes an interval the runtime still owns.
The view arms it in `activate` and cancels in `deactivate`, which are `tabSelected` and
`tabDeselected`, so the inbox polls only while its own tab is the visible one. The rate lives in
state — 15, 30 or 60 seconds, 30 by default — so the screen can say what it is and the reader can
slow it down. 30 s is the honest number for a table a dictionary job writes to a few times a day.

## 8. Drill-down

Two links, both using a tab id the datasource resolved in SQL, never a constant: the row opens its
own record through `OB.UIKit.nav(tab, refkey)`, and the rule opens its tab with no record. A row
whose rule has no active tab renders as plain text, so the only ids that reach `OB.UIKit.nav` came
from the dictionary. Purchase-order alerts land on tab 294 — and `c_order` has six header tabs, so a
hardcoded id here would silently open a return window for a sales order.

## 9. What this window does not do

- **It ignores `ad_alertrule.filterclause`.** Core's datasource appends it, narrowing which alerts a
  recipient sees. No rule in this instance has one — 0 of 27 — so nothing is over-exposed today, but
  a rule that carried one would be honoured by core's bell and not here. Anyone copying this
  predicate into a window over real alerts should add that clause.
- **It does not acknowledge in bulk.** One row, one click, one row-level whitelist check.
- **It never deletes or re-runs a rule.** The alert process owns the table's contents.
- **Its counters are not a business metric.** They count dictionary noise; see section 0.
- **For a demo, force a fixture.** The natural state has no `NEW` row for the F&B admin. Set one
  alert to `NEW`, exercise the acknowledge, and restore it — which is precisely what gate W9 does in
  a `try/finally`, and the same recipe works for a screenshot.

## 10. Gates

`verify/etdemo-alerts.checks.mjs`, run by `check-window.mjs --view ETDEMO_Alerts`. W1–W4 and W7 are
the runner's; W5, W6, W8, W9 and W10 are this window's, and all ten pass.

| id | what it asserts |
| --- | --- |
| W5 | three different filters leave the four status counts and the two rule rows identical, and an independent `count(*)` agrees |
| W6 | each filter really narrows the detail, and the id set matches the set an independent query returns |
| W7 | the write POSTed without a token is rejected, judged by the body and not the status |
| W8 | a non-admin role sees strictly fewer alerts, and every alert it lost is inside its own scope |
| W9 | the write reaches `ad_alert`, the replay answers `changed: false`, and the fixture is restored |
| W10 | a transition outside the whitelist is refused with `ETDEMO_AlertsBadTransition`, HTTP 200 and the row intact, and an out-of-scope id with `ETDEMO_AlertsNotVisible` |

W7 had never fired against a real write before this window existed: it is the first `writes[]` in
the repository, and it was proven in both directions on throwaway manifests before being trusted
here.
