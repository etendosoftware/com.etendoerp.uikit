# L5 — verified facts about Etendo core

Every fact below carries a `file:line` citation and the exact text expected on that line.
`verify/check-source.mjs` re-checks all of them on every run: if core moves, the gate fails
here and the fact gets fixed, not the code that trusted it.

Read this layer only to settle a contradiction. If your prior disagrees with a fact whose
citation still resolves, the fact wins.

Checked against: core 26.2.10, SmartClient 10.0d.

---

## F1 — Modern JavaScript survives the kernel's minifier

The kernel minifies with a Java port of Crockford's jsmin, and it **handles template
literals explicitly** — the widespread belief that Etendo's bundle is ES5-only is false.

<!--cite modules_core/org.openbravo.client.kernel/src/org/openbravo/client/kernel/JSMin.java|185|boolean templateLiteral = theA == '`'-->

Running that minifier over arrows, `const`/`let`, template literals, spread, destructuring,
`class` and `async`/`await` produces output that still parses. `verify/fixtures/es2018-ok.js`
is that proof, and gate G0 runs it every time.

**Consequence:** write ES2018. Do not downgrade modern syntax "for the bundle".

This block is minified by the kernel's JSMin and re-parsed on every gate run, so it is not an
illustration — it is a claim under test:

```js
(function () {
  const COLUMNS = ['DR', 'CO', 'CL'];
  const label = (key, fallback = key) => `uik:${key}/${fallback}`;
  const summarise = async (load) => {
    const { rows = [], total = 0 } = await load();
    const [head, ...tail] = rows;
    return { head, tail, total, labels: COLUMNS.map((c) => label(c)) };
  };
  window.__uikitFactF1 = summarise;
}());
```

## F2 — A minifier failure degrades, it does not break

Compression is wrapped in a `Throwable` catch that returns the original source, so even a
construct jsmin could not handle would ship uncompressed rather than corrupt.

<!--cite modules_core/org.openbravo.client.kernel/src/org/openbravo/client/kernel/JSCompressor.java|59|} catch (Throwable t) {-->

**Consequence:** the real hazard is not minification, it is a *syntax error you wrote*. One
bad character anywhere in the concatenated static bundle stops the browser parsing the whole
file — including the login page. That is why app code is served per view, not bundled.

## F3 — The static bundle is cached for the life of the application

Static resources live in an application-scoped cached map, so in a production instance the
bundle is built once and only a restart (or a JMX invalidation) rebuilds it.

<!--cite modules_core/org.openbravo.client.kernel/src/org/openbravo/client/kernel/StaticResourceProvider.java|40|@ApplicationScoped-->
<!--cite modules_core/org.openbravo.client.kernel/src/org/openbravo/client/kernel/StaticResourceProvider.java|45|new CachedConcurrentMap<>("staticResources")-->

**Consequence:** with any module in development the bundle is rebuilt per request and
uncompressed, so a green harness run in development proves less than one in production mode.
Verify both.

## F4 — Module resource order is by dependency, and ties are arbitrary

Resources are emitted following the module dependency order.

<!--cite modules_core/org.openbravo.client.kernel/src/org/openbravo/client/kernel/KernelUtils.java|251|public List<Module> getModulesOrderedByDependency()-->

The UI Kit and the skin both depend on core plus User Interface Application and neither
depends on the other, so **their relative CSS order is not defined**.

**Consequence:** theming can never rely on the cascade. Tokens are consumed as
`var(--sk-x, fallback)` inside the UI Kit's own scope, which resolves at computed-style time
and is order-independent.

## F5 — View generation runs as admin

The view component path elevates the context before it does anything.

<!--cite modules_core/org.openbravo.client.application/src/org/openbravo/client/application/ViewComponent.java|100|OBContext.setAdminMode();-->

## F6 — View generation does not check view role access

`generateView` instantiates the view and returns its JavaScript without consulting
`OBUIAPP_View_Role_Access`. Only the *menu* filters by it, so a user who knows a view name can
reach it by bookmark.

<!--cite modules_core/org.openbravo.client.application/src/org/openbravo/client/application/ViewComponent.java|259|protected String generateView(String viewName)-->

**Consequence:** data access is still enforced at the datasource and entity layer, but any
server action you write **must check access itself**. This is a security-relevant gap in core,
not a convenience.

## F7 — The folder inside `web/` is the public URL path

The build copies `<module>/web/<folder>/**` into the context's `web/`, stripping the module
directory, so `<folder>` — by convention the module's javapackage — is what the browser
requests.

<!--cite src/build.xml|616|<target name="build.web.folder.base">-->

**Consequence:** ship files under `modules/<javapackage>/web/<javapackage>/…` and reference
them as `web/<javapackage>/…`. Any other folder name silently changes the URL.
