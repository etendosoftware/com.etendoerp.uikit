#!/usr/bin/env node
/*
 * L7 window gates, manifest-driven.
 *
 * check-source.mjs proves the sources are coherent. This proves the windows actually exist in a
 * running instance: the AD rows are wired, the bundle the browser will eval is on disk and served
 * from OBUIAPP_MainLayout/View, every datasource the manifest declares answers over HTTP with the
 * keys it promises, and every write the manifest declares refuses a request that carries no CSRF
 * token. Whatever else is true of one window and of no other lives in that window's own checks
 * module, not here -- the alternative was copying these 489 lines once per demo.
 *
 * It needs the instance up (localhost:8888 by default) and the database container reachable, so it
 * is an integration gate, not a commit gate. Gates that cannot run are reported SKIP, never PASS.
 *
 * Usage: node modules/com.etendoerp.uikit/verify/check-window.mjs [options]
 *          --view <NAME>       only the window whose manifest declares this "view"
 *          --manifest <path>   only this manifest file
 *          --verbose           print the instance and classpath it used
 * With no selector it sweeps every modules/<module>/<slug>.view.json, which against a live
 * instance is slow on purpose: each window costs several HTTP round trips.
 * Exit code 0 only when no gate failed.
 *
 * ---------------------------------------------------------------------------------------------
 * THE MANIFEST KEYS THIS RUNNER READS
 *
 *   view          the OBUIAPP_View_Impl / OBCLKER_TEMPLATE name. Must be a valid JS identifier
 *                 and carry an ETxxx_ prefix; it reaches SQL, so it is validated, not trusted.
 *   module        javapackage of the owning module. Reported, not enforced.
 *   source        \
 *   classpath      >  read by deploy-view.mjs too; W2 checks they agree.
 *   bundle[]      /
 *   datasources[] [{ action, params, requires[] }]  feeds W4.
 *   writes[]      [{ action, payload }]             feeds W7.
 *   checks        path under modules/, same convention as bundle[].path, to an ESM module
 *                 exporting `export default async function (ctx)`. Feeds W5.
 *
 * ---------------------------------------------------------------------------------------------
 * THE CHECKS-MODULE CONTRACT  (frozen: five demos are written against it)
 *
 *   export default async function (ctx) { ... }
 *
 * The runner awaits that default export once per window and treats a throw as a FAIL for the
 * window -- unless the throw is the instance or the database being unreachable, which is a SKIP.
 * A checks module that records nothing at all is a FAIL: a gate that reports nothing is not a
 * gate that passed.
 *
 *   ctx.manifest                       the parsed manifest object, as-is.
 *
 *   await ctx.action(name, params, body)
 *       Calls the kernel ActionHandler `name` (its FQCN) -- the same URL shape OB.UIKit.fetch
 *       builds: /org.openbravo.client.kernel?<params>&_action=<name>. `params` is an object of
 *       query-string values and may be omitted. `body` non-null makes it a POST with that value
 *       JSON-encoded as the request body; omit it (or pass null) for a GET.
 *       Returns the parsed JSON body. THROWS on a non-200 status or a body that is not JSON.
 *       Does not inspect the body for an application-level error -- a handler that answers 200
 *       with {"response":{"error":...}} comes back as that object, for the caller to judge.
 *
 *   await ctx.get(url, init)
 *       Raw authenticated request. `url` is absolute; the session cookie is added. `init` is an
 *       optional fetch init, so a checks module can POST or set headers when it must.
 *       Returns { status, text } and never throws on an HTTP status.
 *
 *   ctx.query(sql)
 *       Read-only SQL against the instance's own database, via psql in the db container.
 *       Returns rows as arrays of column strings; an empty result is [], not one blank row.
 *       SYNCHRONOUS. Interpolated values must be escaped by the caller: `.replace(/'/g, "''")`.
 *
 *   ctx.pass(id, what, detail) / ctx.fail(...) / ctx.skip(...)
 *       Record one result. `id` is short ("W6"); the runner namespaces it as "W6/<view>", so ids
 *       only have to be unique within one window. W1, W2, W3, W4 and W7 are reserved by the
 *       runner -- a checks module picks anything else. `what` is the column heading, `detail`
 *       the sentence after it. Every one of the three is a terminal statement about that id;
 *       returning the call is the idiom (`return fail(...)`).
 *
 * `ctx` is deliberately small. Reading files is not on it: a checks module lives inside the
 * module it checks, so it resolves its own paths from import.meta.dirname.
 * ---------------------------------------------------------------------------------------------
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const CORE = path.resolve(import.meta.dirname, '../../..');
const MODULES = path.join(CORE, 'modules');
const CONTAINER = process.env.ETENDO_DB_CONTAINER || 'etendo-db-1';
const VERBOSE = process.argv.includes('--verbose');
/** Field separator for psql -A: something psql will not quote, and no control characters. */
const SEP = '~|~';
/** Ids the runner emits itself; a checks module must not reuse them. */
const RESERVED = ['W1', 'W2', 'W3', 'W4', 'W7'];

const results = [];
const rel = (p) => path.relative(CORE, p);
/** Every value that reaches SQL goes through this. The view name now comes from a file. */
const q = (value) => String(value).replace(/'/g, "''");

function flag(name) {
  const i = process.argv.indexOf(name);
  return i < 0 ? null : process.argv[i + 1] || null;
}

/** Raised when a gate cannot run, as opposed to failing. Becomes SKIP, never PASS and never FAIL. */
class Unavailable extends Error {}

/* --------------------------------------------------------------------- instance access */

/** Credentials and URLs come from the instance's own properties, never from source. */
function properties() {
  const file = path.join(CORE, 'config/Openbravo.properties');
  if (!fs.existsSync(file)) return null;
  const props = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([\w.]+)\s*=\s*(.*)$/.exec(line);
    // It is a Java properties file: ':' and '=' inside a value arrive backslash-escaped.
    if (m) props[m[1]] = m[2].trim().replace(/\\(.)/g, '$1');
  }
  return props;
}

const PROPS = properties();
const CONTEXT = PROPS?.['context.name'] || 'etendo';
/*
 * context.url records where the instance was *installed*, which in a docker development setup is
 * routinely not where it is *served* (here it still says 8080/etendo while Tomcat is published on
 * 8888 under context.name). So the default follows the published mapping and context.name, and
 * ETENDO_URL overrides it for any instance that lives elsewhere.
 */
const BASE = (process.env.ETENDO_URL || `http://localhost:8888/${CONTEXT}`).replace(/\/$/, '');
// Same tree deploy-view.mjs writes into, and it keys off context.name too.
const WEBAPP =
  process.env.ETENDO_WEBAPP_CLASSES ||
  path.join(CORE, 'volumes/tomcat/webapps', CONTEXT, 'WEB-INF/classes');

/** Set once by the bootstrap: the first line of why the database is out, or null. */
let dbBroken = null;

function psql(sql) {
  if (!PROPS?.['bbdd.user']) throw new Error('Openbravo.properties no declara bbdd.user');
  const db = PROPS['bbdd.sid'] || PROPS['bbdd.systemUser'];
  return execFileSync(
    'docker',
    ['exec', '-i', CONTAINER, 'psql', '-U', PROPS['bbdd.user'], '-d', db,
      '-t', '-A', '-F', SEP, '-v', 'ON_ERROR_STOP=1', '-c', sql],
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
  ).trim();
}

/** Rows as arrays of column strings; an empty result is an empty array, not one blank row. */
function query(sql) {
  if (dbBroken) throw new Unavailable(`base inaccesible: ${dbBroken}`);
  const out = psql(sql);
  return out === '' ? [] : out.split('\n').map((line) => line.split(SEP));
}

/* ------------------------------------------------------------------------- http client */

let cookie = null;
/** Set once by the bootstrap: why the instance is out, or null. */
let httpBroken = null;

function collectCookies(res) {
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const pairs = raw.map((c) => c.split(';')[0]).filter(Boolean);
  return pairs.length ? pairs.join('; ') : null;
}

/** One session for the whole sweep: logging in per window would cost a session per window. */
async function login() {
  if (cookie) return cookie;
  const seed = await fetch(`${BASE}/security/Login`, { redirect: 'manual' });
  const jar = collectCookies(seed);
  const res = await fetch(`${BASE}/secureApp/LoginHandler.html`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar },
    // The local development credentials; this script only ever talks to BASE.
    body: new URLSearchParams({ user: 'admin', password: 'admin' }).toString()
  });
  const body = await res.text();
  if (/Login_TextBox|frmIdentificacion/.test(body)) {
    throw new Error('el login devolvio otra vez el formulario: credenciales o instancia distintas');
  }
  /*
   * A 200 is not a usable session. LoginHandler has exactly one success exit -- goToTarget, the
   * only one that answers showMessage:false -- and every other exit returns a message *before* it
   * chooses a role: last build failed, tomcat not restarted, no non-restricted role. That session
   * authenticates, carries no role, and therefore reads client '0' / org '0', where no business
   * data lives. Without this check a pending rebuild does not fail the sweep loudly: it turns
   * every gate downstream into "no hay datos", which blames the dataset for a broken instance.
   */
  let envelope = null;
  try {
    envelope = JSON.parse(body);
  } catch {
    // Not the JSON envelope. Older paths redirect straight to the menu, and that is a success.
  }
  if (envelope && envelope.showMessage) {
    const said = `${envelope.messageTitle || ''} ${envelope.messageText || ''}`
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    throw new Error(`el login no dejo la sesion utilizable: ${said}`);
  }
  cookie = collectCookies(res) || jar;
  return cookie;
}

async function get(url, init = {}) {
  if (httpBroken) throw new Unavailable(`instancia inaccesible en ${BASE}: ${httpBroken}`);
  const res = await fetch(url, {
    ...init,
    headers: { ...(init.headers || {}), cookie: await login() }
  });
  return { status: res.status, text: await res.text() };
}

/** The kernel ActionHandler URL -- the same shape OB.UIKit.fetch builds. Raw, does not throw. */
function actionUrl(fqcn, params = {}) {
  const qs = new URLSearchParams({ ...params, _action: fqcn }).toString();
  return `${BASE}/org.openbravo.client.kernel?${qs}`;
}

async function callAction(fqcn, params = {}, body = null) {
  const init = body === null
    ? {}
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  return get(actionUrl(fqcn, params), init);
}

/** Calls a kernel ActionHandler and insists on parseable JSON. body non-null => POST. */
async function action(fqcn, params = {}, body = null) {
  const { status, text } = await callAction(fqcn, params, body);
  if (status !== 200) throw new Error(`HTTP ${status} en ${fqcn}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${fqcn} no devolvio JSON: ${text.slice(0, 160)}`);
  }
}

/*
 * The CSRF token the browser would send. LoginUtils stores it in the session as #CSRF_TOKEN at
 * login and ApplicationDynamicComponent publishes it to the client as OB.User.csrfToken inside the
 * session-dynamic kernel component; CsrfUtil.checkCsrfToken compares the two. So the honest way to
 * get it for a scripted session is to read the same JS the browser reads.
 */
const CSRF_URL = `${BASE}/org.openbravo.client.kernel/OBCLKER_Kernel/SessionDynamic`;
let csrf; // undefined = not asked yet, {token} or {why} once asked.

async function csrfToken() {
  if (csrf !== undefined) return csrf;
  try {
    const { status, text } = await get(CSRF_URL);
    if (status !== 200) {
      csrf = { why: `${rel(CSRF_URL)} respondio HTTP ${status}` };
    } else {
      const m = /csrfToken\s*:\s*'([A-Za-z0-9]+)'/.exec(text);
      csrf = m
        ? { token: m[1] }
        : { why: `SessionDynamic no publico OB.User.csrfToken (${(text.length / 1024).toFixed(1)} kB leidos)` };
    }
  } catch (e) {
    csrf = { why: `no pude leer SessionDynamic: ${e.message}` };
  }
  return csrf;
}

/**
 * How a rejected write looks. The kernel wraps a handler exception into a 200 with
 * {"response":{"status":-1,"error":{...}}}, so status alone would call every rejection a success.
 */
function rejection({ status, text }) {
  if (status >= 400) return `HTTP ${status}`;
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return `respuesta no JSON: ${text.slice(0, 120)}`;
  }
  const r = body?.response ?? body;
  const err = r?.error ?? body?.error;
  if (err) return err.message || err.title || JSON.stringify(err).slice(0, 120);
  if (typeof r?.status === 'number' && r.status < 0) return `response.status ${r.status}`;
  return null; // accepted
}

/* ------------------------------------------------------------------------------- gates */

/** W1: the AD rows a custom Classic window needs, and nothing standing in for them. */
function gateAdWiring(view, { pass, fail }) {
  const impl = query(`select v.name, coalesce(v.classname, ''), coalesce(t.name, ''),
      coalesce(t.templateclasspathlocation, '')
    from obuiapp_view_impl v
      left join obclker_template t on t.obclker_template_id = v.obclker_template_id
    where v.name = '${q(view)}'`);
  if (impl.length !== 1) {
    return fail('W1', 'AD wiring', `OBUIAPP_View_Impl ${view}: ${impl.length} filas, esperaba 1`);
  }
  const [, classname, template, classpath] = impl[0];
  const problems = [];
  // ViewComponent only falls back to the generic BaseTemplateComponent when there is no class.
  if (classname) problems.push(`la vista declara classname ${classname}, deberia servirse sin Java`);
  if (template !== view) problems.push(`plantilla asociada = "${template}"`);
  if (!classpath.startsWith('/')) {
    problems.push(`templateclasspathlocation "${classpath}" sin barra inicial`);
  }

  const menu = query(`select m.name, coalesce(m.action, ''), coalesce(n.parent_id, '')
    from ad_menu m
      join obuiapp_view_impl v on v.obuiapp_view_impl_id = m.em_obuiapp_view_impl_id
      left join ad_treenode n on n.node_id = m.ad_menu_id and n.ad_tree_id = '10'
    where v.name = '${q(view)}'`);
  if (menu.length !== 1) {
    problems.push(`AD_MENU apuntando a ${view}: ${menu.length} filas, esperaba 1`);
  } else {
    const [name, act, parent] = menu[0];
    if (act !== 'OBUIAPP_OpenView') problems.push(`AD_MENU.action = "${act}"`);
    if (!parent) problems.push(`el menu "${name}" no esta colgado del arbol 10`);
  }

  const grants = Number(
    query(`select count(*) from obuiapp_view_role_access a
      join obuiapp_view_impl v on v.obuiapp_view_impl_id = a.obuiapp_view_impl_id
      where v.name = '${q(view)}' and a.isactive = 'Y'`)[0][0]
  );
  if (grants === 0) problems.push('sin filas en OBUIAPP_View_Role_Access: el menu no se veria');

  return problems.length
    ? fail('W1', 'AD wiring', problems.join('; '))
    : pass('W1', 'AD wiring',
      `sin Java, plantilla en ${classpath}, menu en el arbol, ${grants} rol(es)`);
}

/**
 * W2: the bundle the browser evals exists as a build artifact, is wrapped, and holds every part of
 * the manifest.
 *
 * The file that counts is the one under the module's src/, because that is the one src/build.xml
 * copies into WEB-INF/classes. The copy already sitting on the running classpath is checked too,
 * and checked for being the *same* file -- a stale or hand-edited mirror is how the window ends up
 * passing here and dying on the next war redeploy.
 */
function gateBundle(manifest, { pass, fail }) {
  const problems = [];
  if (!manifest.source) {
    return fail('W2', 'bundle en el classpath', 'el manifest no declara "source": no hay artefacto de build');
  }
  const target = path.join(MODULES, manifest.source);
  if (!fs.existsSync(target)) {
    return fail('W2', 'bundle en el classpath', `falta ${rel(target)}; corre deploy-view.mjs`);
  }
  // The build's mapper strips "<module>/src", so this is the path smartbuild will deliver to.
  const cut = manifest.source.indexOf('/src/');
  const delivered = cut < 0 ? null : manifest.source.slice(cut + 4);
  if (delivered !== manifest.classpath) {
    problems.push(
      `el build entrega ${delivered || '(source sin /src/)'} pero la plantilla apunta a ${manifest.classpath}`
    );
  }
  const text = fs.readFileSync(target, 'utf8');
  const onClasspath = path.join(WEBAPP, manifest.classpath.replace(/^\//, ''));
  if (!fs.existsSync(onClasspath)) {
    problems.push(`el webapp no tiene ${rel(onClasspath)}: falta smartbuild o deploy-view.mjs`);
  } else if (fs.readFileSync(onClasspath, 'utf8') !== text) {
    problems.push(`${rel(onClasspath)} no coincide con la fuente: el classpath quedo viejo`);
  }
  // FreeMarker would eat every ${...} in a JS template literal without this.
  if (!text.startsWith('<#noparse>')) problems.push('el bundle no empieza con <#noparse>');
  if (!/<\/#noparse>\s*$/.test(text)) problems.push('el bundle no cierra el noparse');
  for (const part of manifest.bundle) {
    if (!part.path) continue;
    const source = fs.readFileSync(path.join(MODULES, part.path), 'utf8');
    // The longest real line of each part, so a half-assembled bundle cannot pass.
    const probe = source
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 24 && !l.startsWith('*') && !l.startsWith('//'))
      .sort((a, b) => b.length - a.length)[0];
    if (probe && !text.includes(probe)) {
      problems.push(`${path.basename(part.path)} no esta en el bundle`);
    }
  }
  if (!text.includes('defineView')) problems.push('el bundle no llama a defineView');
  const built = fs.statSync(target).mtimeMs;
  const newest = manifest.bundle
    .filter((p) => p.path)
    .map((p) => fs.statSync(path.join(MODULES, p.path)).mtimeMs)
    .reduce((a, b) => Math.max(a, b), 0);
  if (newest > built) problems.push('hay fuentes mas nuevas que el bundle: falta redesplegar');
  return problems.length
    ? fail('W2', 'bundle en el classpath', problems.join('; '))
    : pass('W2', 'bundle en el classpath',
      `${(text.length / 1024).toFixed(1)} kB en ${rel(target)}, entregado a ${manifest.classpath}`);
}

/** W3: the lazy view path. This is the exact URL fetchView GETs before it evals the response. */
async function gateServedView(view, { pass, fail }) {
  const { status, text } = await get(
    `${BASE}/org.openbravo.client.kernel/OBUIAPP_MainLayout/View?viewId=${encodeURIComponent(view)}`
  );
  if (status !== 200) return fail('W3', 'servida desde MainLayout/View', `HTTP ${status}`);
  const problems = [];
  // fetchViewCallback throws "The view <name> not defined" unless the eval defines isc[name].
  if (!text.includes(view)) problems.push(`la respuesta no menciona ${view}`);
  if (!text.includes('defineView')) problems.push('la respuesta no define la vista');
  if (text.includes('#noparse')) problems.push('FreeMarker no proceso el noparse');
  if (/^\s*<(!DOCTYPE|html)/i.test(text)) {
    problems.push('la respuesta es HTML, probablemente una pagina de error');
  }
  return problems.length
    ? fail('W3', 'servida desde MainLayout/View', problems.join('; '))
    : pass('W3', 'servida desde MainLayout/View', `${(text.length / 1024).toFixed(1)} kB evaluables`);
}

/**
 * W4: every datasource the manifest declares answers 200, answers JSON, and carries the keys it
 * promised. Deliberately weak: it is the shape of the contract, not the contents. Anything about
 * what the numbers mean is true of one window only and belongs in its checks module.
 */
async function gateDatasources(manifest, { pass, fail, skip }) {
  const declared = manifest.datasources || [];
  if (!declared.length) {
    return skip('W4', 'datasources declarados', 'el manifest no declara datasources[]');
  }
  const problems = [];
  const seen = [];
  for (const ds of declared) {
    if (!ds.action) {
      problems.push('una entrada de datasources[] no declara "action"');
      continue;
    }
    const short = ds.action.split('.').pop();
    const { status, text } = await callAction(ds.action, ds.params || {});
    if (status !== 200) {
      problems.push(`${short}: HTTP ${status}`);
      continue;
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      problems.push(`${short}: no devolvio JSON (${text.slice(0, 80)})`);
      continue;
    }
    const missing = (ds.requires || []).filter((key) => !(key in body));
    if (missing.length) {
      problems.push(`${short}: falta(n) ${missing.join(', ')} en el nivel superior`);
      continue;
    }
    seen.push(`${short} (${(ds.requires || []).length} clave(s))`);
  }
  return problems.length
    ? fail('W4', 'datasources declarados', problems.join('; '))
    : pass('W4', 'datasources declarados', seen.join(', '));
}

/**
 * W5: the window's own checks module. No module means no window-specific gate, which is a SKIP --
 * a window nobody wrote assertions for has not been verified, it has only been left alone.
 */
async function gateChecks(manifest, recorder) {
  const { pass, fail, skip } = recorder;
  if (!manifest.checks) {
    return skip('W5', 'gate propio de la ventana',
      `${manifest.view} no declara "checks": sin gate propio, nadie afirma nada sobre esta ventana`);
  }
  const file = path.join(MODULES, manifest.checks);
  let mod;
  try {
    mod = await import(`file://${file}`);
  } catch (e) {
    return fail('W5', 'gate propio de la ventana', `no pude cargar ${manifest.checks}: ${e.message}`);
  }
  if (typeof mod.default !== 'function') {
    return fail('W5', 'gate propio de la ventana',
      `${manifest.checks} no exporta "export default async function (ctx)"`);
  }
  const before = recorder.count();
  try {
    // Exactly the seven keys of the contract: count()/ids() are the runner's, not the plugin's.
    await mod.default({ manifest, action, get, query, pass, fail, skip });
  } catch (e) {
    return e instanceof Unavailable
      ? skip('W5', 'gate propio de la ventana', e.message)
      : fail('W5', 'gate propio de la ventana', `${manifest.checks} lanzo: ${e.message}`);
  }
  if (recorder.count() === before) {
    return fail('W5', 'gate propio de la ventana',
      `${manifest.checks} corrio sin registrar ningun resultado`);
  }
  const clashes = recorder.ids(before).filter((id) => RESERVED.includes(id));
  if (clashes.length) {
    return fail('W5', 'gate propio de la ventana',
      `${manifest.checks} usa ${clashes.join(', ')}, que son del runner`);
  }
  return null;
}

/**
 * W7: the write path. For each declared write, the same POST is sent twice -- once with no CSRF
 * token, once with the token the session really holds. The first must be refused and the second
 * accepted, and it takes both legs to mean anything: the accepted leg is what proves the refusal
 * was about the missing token and not about a payload the handler would have rejected anyway.
 *
 * Note this actually performs the write on the second leg. That is the gate, not a side effect:
 * a "write" that a valid token cannot complete is not a write path.
 */
async function gateCsrf(manifest, { pass, fail, skip }) {
  const declared = manifest.writes || [];
  if (!declared.length) {
    return skip('W7', 'CSRF en las escrituras', 'el manifest no declara writes[]');
  }
  const tok = await csrfToken();
  if (!tok.token) {
    return skip('W7', 'CSRF en las escrituras',
      `sin token de sesion no puedo probar la pata aceptada: ${tok.why}`);
  }
  const problems = [];
  const seen = [];
  for (const w of declared) {
    if (!w.action) {
      problems.push('una entrada de writes[] no declara "action"');
      continue;
    }
    const short = w.action.split('.').pop();
    const payload = w.payload || {};
    const naked = rejection(await callAction(w.action, {}, payload));
    if (naked === null) {
      problems.push(`${short}: acepto un POST sin token CSRF`);
      continue;
    }
    const armed = rejection(await callAction(w.action, {}, { ...payload, csrfToken: tok.token }));
    if (armed !== null) {
      problems.push(`${short}: rechazo tambien el POST con token valido (${armed})`);
      continue;
    }
    seen.push(`${short} (sin token: ${naked})`);
  }
  return problems.length
    ? fail('W7', 'CSRF en las escrituras', problems.join('; '))
    : pass('W7', 'CSRF en las escrituras', seen.join(', '));
}

/* ------------------------------------------------------------------------------ runner */

/** One recorder per window: it namespaces every id by view so a sweep stays readable. */
function recorderFor(view) {
  const mine = [];
  const push = (state) => (id, name, detail) => {
    const row = { id: `${id}/${view}`, bare: id, name, state, detail };
    mine.push(row);
    results.push(row);
    return row;
  };
  return {
    pass: push('PASS'),
    fail: push('FAIL'),
    skip: push('SKIP'),
    count: () => mine.length,
    /** Only the ids recorded from `from` onwards, so the runner can inspect one gate's output. */
    ids: (from = 0) => mine.slice(from).map((r) => r.bare)
  };
}

/** A manifest is a file on disk, so every assumption about its contents is checked here. */
function validate(manifest) {
  if (!manifest || typeof manifest !== 'object') return 'el manifest no es un objeto';
  const view = manifest.view;
  if (typeof view !== 'string' || !view) return 'el manifest no declara "view"';
  // The name reaches SQL, a URL and an isc[] key, so it has to be an identifier, not a string.
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(view)) {
    return `"view" = ${JSON.stringify(view)} no es un identificador JS valido`;
  }
  if (!/^ET[A-Z0-9]{2,}_/.test(view)) {
    return `"view" = ${view} no lleva prefijo ETxxx_ (el dbprefix del modulo)`;
  }
  if (!Array.isArray(manifest.bundle)) return 'el manifest no declara "bundle" como lista';
  for (const key of ['datasources', 'writes']) {
    if (key in manifest && !Array.isArray(manifest[key])) return `"${key}" no es una lista`;
  }
  if ('checks' in manifest && typeof manifest.checks !== 'string') return '"checks" no es una ruta';
  return null;
}

/** modules/<module>/<slug>.view.json, sorted, so a new demo needs no change here. */
function discover() {
  const found = [];
  for (const module of fs.readdirSync(MODULES).sort()) {
    const dir = path.join(MODULES, module);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const entry of fs.readdirSync(dir).sort()) {
      if (/^[a-z0-9][a-z0-9-]*\.view\.json$/.test(entry)) found.push(path.join(dir, entry));
    }
  }
  return found;
}

async function runWindow(file) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    // A broken manifest takes its own window down, not the sweep.
    recorderFor(path.basename(file, '.view.json')).fail('W0', 'manifest', `${rel(file)}: ${e.message}`);
    return;
  }
  const bad = validate(manifest);
  if (bad) {
    recorderFor(String(manifest?.view || path.basename(file, '.view.json')))
      .fail('W0', 'manifest', `${rel(file)}: ${bad}`);
    return;
  }

  const view = manifest.view;
  const rec = recorderFor(view);

  if (dbBroken) rec.skip('W1', 'AD wiring', `base inaccesible: ${dbBroken}`);
  else gateAdWiring(view, rec);
  gateBundle(manifest, rec);

  if (httpBroken) {
    const why = `instancia inaccesible en ${BASE}: ${httpBroken}`;
    rec.skip('W3', 'servida desde MainLayout/View', why);
    rec.skip('W4', 'datasources declarados', why);
    rec.skip('W5', 'gate propio de la ventana', why);
    rec.skip('W7', 'CSRF en las escrituras', why);
    return;
  }
  await gateServedView(view, rec);
  await gateDatasources(manifest, rec);
  await gateChecks(manifest, rec);
  await gateCsrf(manifest, rec);
}

async function main() {
  // Bootstrap once for the whole sweep: the properties file, the psql probe, one login.
  try {
    query('select 1');
  } catch (e) {
    dbBroken = e.message.split('\n')[0];
  }
  try {
    await login();
  } catch (e) {
    httpBroken = e.message;
  }

  const only = flag('--view');
  const one = flag('--manifest');
  const all = discover();
  let files = all;
  if (one) {
    files = [path.resolve(one)];
  } else if (only) {
    files = all.filter((f) => {
      try {
        return JSON.parse(fs.readFileSync(f, 'utf8')).view === only;
      } catch {
        return false;
      }
    });
    if (!files.length) {
      console.error(`check-window: ningun manifest declara view "${only}" (${all.length} encontrados)`);
      process.exit(1);
    }
  }
  console.log(
    `  ${all.length} manifest(s) en modules/*/*.view.json` +
    (files.length === all.length ? '' : `, ${files.length} seleccionado(s)`)
  );

  for (const file of files) await runWindow(file);

  results.sort((a, b) => a.id.localeCompare(b.id));
  const width = Math.max(...results.map((r) => r.name.length), 0);
  const idWidth = Math.max(...results.map((r) => r.id.length), 0);
  for (const r of results) {
    const mark = r.state === 'PASS' ? 'ok  ' : r.state === 'FAIL' ? 'FAIL' : 'skip';
    console.log(`  ${mark}  ${r.id.padEnd(idWidth)}  ${r.name.padEnd(width)}  ${r.detail}`);
  }
  const failed = results.filter((r) => r.state === 'FAIL').length;
  const skipped = results.filter((r) => r.state === 'SKIP').length;
  console.log(
    `\n  ${results.length - failed - skipped} pasaron, ${failed} fallaron, ${skipped} sin correr`
  );
  if (VERBOSE) console.log(`\n  instancia ${BASE}\n  classes   ${rel(WEBAPP)}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`check-window: ${e.stack || e.message}`);
  process.exit(1);
});
