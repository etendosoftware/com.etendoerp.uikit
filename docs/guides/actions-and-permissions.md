# Server actions and access control

> **STATUS: shipped.** `OB.UIKit.defineAction` and `ctx.run` are in the runtime and the server
> half (`UikAction`, `UikQuery.scopeClause`) is committed. Everything below is behaviour you can
> rely on today.

Reads and writes take different doors, on purpose.

| | reads | writes |
| --- | --- | --- |
| declared with | `OB.UIKit.datasource` | `OB.UIKit.defineAction` |
| called from | `OB.UIKit.fetch`, or `data:` in a view | `ctx.run` only |
| HTTP | GET | POST |
| CSRF token | not sent | always sent |
| server base class | any action handler | **must** extend `UikAction` |

There is no third door. If you find yourself reaching for `OB.RemoteCallManager` directly, you are
about to lose the token, the in-flight guard and the rollback all at once.

## 1. Declaring a write

```js
OB.UIKit.defineAction({
  name: 'approve',
  action: 'com.etendoerp.uikit.demos.orders.Approve',
  confirm: 'ETDEMO_ConfirmApprove',
  payload: function (state, arg) {
    return { orderId: arg.id, note: state.note };
  },
  optimistic: function (state, arg) {
    state.approved[arg.id] = true;
  },
  refetch: 'summary'
});
```

`name` is what `ctx.run` uses. `action` is the handler's fully qualified class name — `KernelServlet`
dispatches on the class name and needs no AD row, so a new action is a Java class and nothing else.

## 2. Running it

`ctx.run(name, arg, callback)` is the only caller. It returns a boolean, and the boolean matters:

```js
OB.UIKit.defineView({
  name: 'ETDEMO_Orders',
  regions: ['list'],
  state: { approved: {}, note: '' },
  render: function (state) {
    return { list: '<button data-approve="7">ok</button>' };
  },
  on: {
    'click [data-approve]': function (ctx, event, el) {
      var sent = ctx.run('approve', { id: el.getAttribute('data-approve') }, function (err) {
        if (err) {
          console.warn(err.code + ': ' + err.message);
        }
      });
      if (!sent) {
        return;
      }
    }
  }
});
```

`false` means nothing left the browser, and there are exactly four reasons:

1. **no such action** — a typo in the name; the callback fires with code `ETUIK_NoAction`.
2. **the confirm was declined** — the user said no.
3. **no CSRF token** — see §4. The callback fires with code `ETUIK_NoCsrf`.
4. **the same `(name, arg)` is already in flight** — the double click. `arg` is compared by its
   JSON, so two clicks on the same row collapse and two clicks on different rows both go out.

That last one is why the button does not need a disabled state to be safe. It still deserves one:
`ui.busy` is true while any request is outstanding, and the root carries `uik-busy`.

## 3. Optimistic writes, and the two rules they impose

`optimistic(state, arg)` mutates state before the request and the view repaints immediately. The
mutation deliberately does **not** go through `ctx.set`: `ctx.set` reconciles, and reconciling
mid-write would let the server's pre-write answer land on top of the user's action. So it mutates,
paints, and nothing else.

Before the mutation the runtime takes a `JSON.stringify` snapshot of state. If the request fails —
transport, envelope, or a rejection — state is restored from that snapshot, in place, and the view
repaints. Two consequences, and they are not negotiable:

**Rule 1: state must be JSON-serializable.** A `Date`, a function, a DOM node, a `Map` or a cycle
does not survive the snapshot, so it cannot live in state. Keep the ISO string the datasource sent
and format it at render time with `OB.UIKit.fmt`.

**Rule 2: `optimistic` must not touch any key that `params(state)` reads.** Changing one changes a
datasource signature, which provokes exactly the refetch the optimistic path exists to avoid — and
then the rollback provokes a second one. Optimistic keys are presentation keys: a set of ids, a
count, a flag. Filters are not.

```js
OB.UIKit.defineView({
  name: 'ETDEMO_Split',
  regions: ['body'],
  state: { cycle: 'Q3', approved: {} },
  params: function (state) {
    return { cycle: state.cycle };
  },
  render: function (state) {
    return { body: String(Object.keys(state.approved).length) };
  }
});
```

`approved` is safe to mutate optimistically. `cycle` is not: it is in `params`.

`refetch` says what to reload once the server agrees — `true` for every source, or an alias, or a
list of aliases. Reloading one alias is almost always right: the write changed one thing.

## 4. CSRF, and why this module has its own base class

`KernelServlet` and `BaseActionHandler` do not verify the CSRF token. Only `DataSourceServlet` and
`DeleteImageActionHandler` do. So an action handler that writes and does not check the token itself
is a cross-site write waiting to happen — which is the entire reason `UikAction` exists, and why it
performs the check in a `final execute` that a subclass cannot forget or override.

The client half is automatic: `ctx.run` reads `OB.User.csrfToken` and puts it in the body as
`csrfToken`, added last so a `payload` function cannot shadow it.

<!--cite modules_core/org.openbravo.client.kernel/src/org/openbravo/client/kernel/templates/application-dynamic-js.ftl|54|csrfToken: '${data.csrfToken?js_string}'-->

<!--cite src/org/openbravo/erpCommon/utility/CsrfUtil.java|37|public static void checkCsrfToken(String requestToken, HttpServletRequest request)-->

**If the page has no token, the request is not sent.** The callback receives an `Error` with
`code === 'ETUIK_NoCsrf'` — the same code the server returns when it rejects a token, because from
the caller's side the two failures are the same failure. Sending the write anyway and letting the
server reject it would be strictly worse: it would teach an app that a tokenless POST is normal.

The envelope `UikAction` returns is fixed. Success is the handler's own keys plus `success: true`.
Failure is `{ success: false, error: { code, message } }` with `ETUIK_NoCsrf` or `ETUIK_Failed`, and
the message is written for a user to read — the stack trace and the SQL stay in the server log,
because a client-facing message that quotes them is a free schema dump.

## 5. Fact F6: the window granted you nothing

`ViewComponent.generateView` returns a view's JavaScript **without consulting
`OBUIAPP_View_Role_Access`**. Only the menu filters by it. A user who knows a view name reaches it
by bookmark.

<!--cite modules_core/org.openbravo.client.application/src/org/openbravo/client/application/ViewComponent.java|259|protected String generateView(String viewName)-->

Read that as a security statement, because it is one:

- The fact that a user opened your window proves **nothing** about what they may see or change.
- The record id in a payload is a **claim by the browser**, not an authorization.
- A filter in the UI — a department chip, a hidden row, a greyed-out button — is **decoration**.
  It is good decoration and you should still write it, but it is not access control and must never
  be the only thing standing between a role and a row.

So every permission decision lives in SQL, in the datasource and in the action:

```js
OB.UIKit.datasource('orders', { action: 'com.etendoerp.uikit.demos.orders.List' });
```

and, on the server, every statement — read and write alike — carries
`UikQuery.scopeClause(alias)` and binds it with `UikQuery.bindScope`. The clause restricts an alias
to the readable clients and organisations of the session and to active rows; an empty scope renders
`in (null)` and matches nothing, which is the correct answer for a role with no access.

A write does the same thing twice over. Before mutating, a `UikAction` subclass **re-reads its
target under the scope clause** and proceeds only if that read finds the row. That read is the
authorization: if the row is out of scope, the scoped select returns nothing and the handler
rejects, whatever the payload claimed.

Do not build a permission model of your own on top of this. There is no `OBUIAPP_View_Role_Access`
check to add, no client-side role list worth keeping, and no allow-list in JavaScript that a
console cannot edit. The scoped read is the whole mechanism.
