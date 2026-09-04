#!/usr/bin/env node
/*
 * L7 window gates for the ETOKRS_Review sample.
 *
 * check-source.mjs proves the sources are coherent. This proves the window actually exists in a
 * running instance: the AD rows are wired, the bundle the browser will eval is on disk and served
 * from OBUIAPP_MainLayout/View, both datasources answer over HTTP, the department filter is
 * enforced in SQL rather than in the UI, and every number in docs/samples/okr-review.md section 5
 * is recomputed here from the raw ETOKRS_* rows and compared against what the datasource returned.
 *
 * It needs the instance up (localhost:8888 by default) and the database container reachable, so it
 * is an integration gate, not a commit gate. Gates that cannot run are reported SKIP, never PASS.
 *
 * Usage: node modules/com.etendoerp.uikit/verify/check-window.mjs [--verbose]
 * Exit code 0 only when no gate failed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const CORE = path.resolve(import.meta.dirname, '../../..');
const MODULES = path.join(CORE, 'modules');
const MANIFEST = path.join(MODULES, 'com.etendoerp.uikit.samples/etokrs-review.view.json');
const APP_JS = path.join(
  MODULES,
  'com.etendoerp.uikit.samples/web/com.etendoerp.uikit.samples/js/okr-review.js'
);
const CONTAINER = process.env.ETENDO_DB_CONTAINER || 'etendo-db-1';
const VERBOSE = process.argv.includes('--verbose');

const VIEW = 'ETOKRS_Review';
const TREE = 'com.etendoerp.uikit.samples.okr.ReviewTree';
const CHECKINS = 'com.etendoerp.uikit.samples.okr.Checkins';
/** Field separator for psql -A: something psql will not quote, and no control characters. */
const SEP = '~|~';

const results = [];
const pass = (id, name, detail) => results.push({ id, name, state: 'PASS', detail });
const fail = (id, name, detail) => results.push({ id, name, state: 'FAIL', detail });
const skip = (id, name, detail) => results.push({ id, name, state: 'SKIP', detail });

const rel = (p) => path.relative(CORE, p);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

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
  const out = psql(sql);
  return out === '' ? [] : out.split('\n').map((line) => line.split(SEP));
}

/* ------------------------------------------------------------------------- http client */

let cookie = null;

function collectCookies(res) {
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const pairs = raw.map((c) => c.split(';')[0]).filter(Boolean);
  return pairs.length ? pairs.join('; ') : null;
}

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
  cookie = collectCookies(res) || jar;
  return cookie;
}

async function get(url) {
  const res = await fetch(url, { headers: { cookie: await login() } });
  return { status: res.status, text: await res.text() };
}

/** Calls a kernel ActionHandler by FQCN -- the same URL shape OB.UIKit.fetch builds. */
async function action(fqcn, params) {
  const qs = new URLSearchParams({ ...params, _action: fqcn }).toString();
  const { status, text } = await get(`${BASE}/org.openbravo.client.kernel?${qs}`);
  if (status !== 200) throw new Error(`HTTP ${status} en ${fqcn}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${fqcn} no devolvio JSON: ${text.slice(0, 160)}`);
  }
}

/* ------------------------------------------------------------------------------- gates */

/** W1: the AD rows a custom Classic window needs, and nothing standing in for them. */
function gateAdWiring() {
  const impl = query(`select v.name, coalesce(v.classname, ''), coalesce(t.name, ''),
      coalesce(t.templateclasspathlocation, '')
    from obuiapp_view_impl v
      left join obclker_template t on t.obclker_template_id = v.obclker_template_id
    where v.name = '${VIEW}'`);
  if (impl.length !== 1) {
    return fail('W1', 'AD wiring', `OBUIAPP_View_Impl ${VIEW}: ${impl.length} filas, esperaba 1`);
  }
  const [, classname, template, classpath] = impl[0];
  const problems = [];
  // ViewComponent only falls back to the generic BaseTemplateComponent when there is no class.
  if (classname) problems.push(`la vista declara classname ${classname}, deberia servirse sin Java`);
  if (template !== VIEW) problems.push(`plantilla asociada = "${template}"`);
  if (!classpath.startsWith('/')) {
    problems.push(`templateclasspathlocation "${classpath}" sin barra inicial`);
  }

  const menu = query(`select m.name, coalesce(m.action, ''), coalesce(n.parent_id, '')
    from ad_menu m
      join obuiapp_view_impl v on v.obuiapp_view_impl_id = m.em_obuiapp_view_impl_id
      left join ad_treenode n on n.node_id = m.ad_menu_id and n.ad_tree_id = '10'
    where v.name = '${VIEW}'`);
  if (menu.length !== 1) {
    problems.push(`AD_MENU apuntando a ${VIEW}: ${menu.length} filas, esperaba 1`);
  } else {
    const [name, act, parent] = menu[0];
    if (act !== 'OBUIAPP_OpenView') problems.push(`AD_MENU.action = "${act}"`);
    if (!parent) problems.push(`el menu "${name}" no esta colgado del arbol 10`);
  }

  const grants = Number(
    query(`select count(*) from obuiapp_view_role_access a
      join obuiapp_view_impl v on v.obuiapp_view_impl_id = a.obuiapp_view_impl_id
      where v.name = '${VIEW}' and a.isactive = 'Y'`)[0][0]
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
function gateBundle() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
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
async function gateServedView() {
  const { status, text } = await get(
    `${BASE}/org.openbravo.client.kernel/OBUIAPP_MainLayout/View?viewId=${VIEW}`
  );
  if (status !== 200) return fail('W3', 'servida desde MainLayout/View', `HTTP ${status}`);
  const problems = [];
  // fetchViewCallback throws "The view <name> not defined" unless the eval defines isc[name].
  if (!text.includes(VIEW)) problems.push(`la respuesta no menciona ${VIEW}`);
  if (!text.includes('defineView')) problems.push('la respuesta no define la vista');
  if (text.includes('#noparse')) problems.push('FreeMarker no proceso el noparse');
  if (/^\s*<(!DOCTYPE|html)/i.test(text)) {
    problems.push('la respuesta es HTML, probablemente una pagina de error');
  }
  return problems.length
    ? fail('W3', 'servida desde MainLayout/View', problems.join('; '))
    : pass('W3', 'servida desde MainLayout/View', `${(text.length / 1024).toFixed(1)} kB evaluables`);
}

/** W4: one call returns the whole tree, as the sample's data contract promises. */
async function gateTreeContract() {
  const tree = await action(TREE, { cycle: 'null', dept: 'all' });
  const problems = [];
  for (const key of ['cycles', 'cycle', 'depts', 'deptStats', 'objs', 'krs']) {
    if (!(key in tree)) problems.push(`falta "${key}" en la respuesta`);
  }
  if (problems.length) return fail('W4', 'contrato del arbol', problems.join('; '));
  if (!tree.cycle) return skip('W4', 'contrato del arbol', 'ningun ciclo tiene datos');
  for (const key of ['days', 'day']) {
    if (typeof tree.cycle[key] !== 'number') problems.push(`cycle.${key} no es numero`);
  }
  if (tree.cycle.day < 0 || tree.cycle.day > tree.cycle.days) {
    problems.push(`cycle.day ${tree.cycle.day} fuera de [0, ${tree.cycle.days}]`);
  }
  const kr = tree.krs[0];
  for (const key of ['id', 'obj', 'title', 'base', 'current', 'target', 'score', 'scoreTarget',
    'weight', 'unit', 'confidence']) {
    if (kr && !(key in kr)) problems.push(`falta krs[].${key}`);
  }
  const objIds = new Set(tree.objs.map((o) => o.id));
  const orphans = tree.krs.filter((k) => !objIds.has(k.obj)).length;
  if (orphans) problems.push(`${orphans} KR sin su objetivo en la misma respuesta`);
  const checkins = await action(CHECKINS, { cycle: 'null', dept: 'all' });
  if (!Array.isArray(checkins.checkins)) problems.push('ETOKRS_Checkins no devolvio checkins[]');
  return problems.length
    ? fail('W4', 'contrato del arbol', problems.join('; '))
    : pass('W4', 'contrato del arbol',
      `${tree.cycle.name}: dia ${tree.cycle.day}/${tree.cycle.days}, ${tree.depts.length} deptos, ` +
      `${tree.objs.length} objetivos, ${tree.krs.length} KR, ${checkins.checkins.length} check-ins`);
}

/**
 * W5: fact F6 -- ViewComponent never consults OBUIAPP_View_Role_Access, so the department filter
 * has to be enforced by the datasource. A filter that only hid rows in the browser would still
 * ship every department's numbers down the wire.
 */
async function gateFilterInDatasource() {
  const all = await action(TREE, { cycle: 'null', dept: 'all' });
  if (!all.cycle || all.depts.length < 2) {
    return skip('W5', 'filtro en el datasource', 'hacen falta dos departamentos con datos');
  }
  const problems = [];
  for (const dept of all.depts) {
    const one = await action(TREE, { cycle: 'null', dept: dept.id });
    const foreign = one.objs.filter((o) => o.dept !== dept.id);
    if (foreign.length) {
      problems.push(`dept=${dept.name} devolvio ${foreign.length} objetivo(s) de otro departamento`);
    }
    const kept = new Set(one.objs.map((o) => o.id));
    const foreignKrs = one.krs.filter((k) => !kept.has(k.obj));
    if (foreignKrs.length) problems.push(`dept=${dept.name} devolvio ${foreignKrs.length} KR ajeno(s)`);
    if (one.objs.length >= all.objs.length) {
      problems.push(`dept=${dept.name} no estrecho nada (${one.objs.length} de ${all.objs.length})`);
    }
    // The rail draws every department, so the rollups must survive the filter.
    if (one.deptStats.length !== all.deptStats.length) {
      problems.push(
        `dept=${dept.name} perdio deptStats (${one.deptStats.length} de ${all.deptStats.length})`
      );
    }
  }
  // And the UI must not be re-filtering what the server already narrowed.
  const app = fs.readFileSync(APP_JS, 'utf8').replace(/\s+/g, ' ');
  if (/\.(objs|krs) ?\.filter\(/.test(app)) {
    problems.push('okr-review.js filtra objs/krs en el cliente');
  }
  return problems.length
    ? fail('W5', 'filtro en el datasource', problems.join('; '))
    : pass('W5', 'filtro en el datasource',
      `${all.depts.length} departamentos, cada uno estrechado en SQL`);
}

/**
 * W6: section 5 of the sample, recomputed here from the raw rows and compared with what the
 * datasource returned. Independent arithmetic is the whole point -- reusing the datasource's own
 * SQL would only prove it agrees with itself.
 */
async function gateFormulas() {
  const tree = await action(TREE, { cycle: 'null', dept: 'all' });
  if (!tree.cycle) return skip('W6', 'formulas de la seccion 5', 'ningun ciclo tiene datos');
  const rows = query(`select o.etokrs_department_id, o.etokrs_objective_id, o.weight, k.weight,
      k.basevalue, k.currentvalue, k.targetvalue, k.score, k.scoretarget
    from etokrs_keyresult k
      join etokrs_objective o on o.etokrs_objective_id = k.etokrs_objective_id
    where k.isactive = 'Y' and o.isactive = 'Y' and o.etokrs_cycle_id = '${tree.cycle.id}'`);
  if (rows.length === 0) return fail('W6', 'formulas de la seccion 5', 'el ciclo no tiene KR');

  // avance = (actual - base) / (meta - base), acotado a [0, 1]; sirve igual cuando menos es mejor.
  const byObj = new Map();
  for (const [dept, obj, owgt, kwgt, base, cur, target, score, scoreTarget] of rows) {
    const span = Number(target) - Number(base);
    const frac = span === 0
      ? (Number(cur) >= Number(target) ? 1 : 0)
      : clamp((Number(cur) - Number(base)) / span, 0, 1);
    if (!byObj.has(obj)) byObj.set(obj, { dept, weight: Number(owgt), krs: [] });
    byObj.get(obj).krs.push({
      weight: Number(kwgt), frac, score: Number(score), scoreTarget: Number(scoreTarget)
    });
  }
  // Both rollup levels are weighted means: KR into objective, objective into department.
  const mean = (list, get) => {
    const w = list.reduce((a, x) => a + x.weight, 0);
    return w === 0 ? 0 : list.reduce((a, x) => a + get(x) * x.weight, 0) / w;
  };
  const byDept = new Map();
  for (const objective of byObj.values()) {
    const roll = {
      weight: objective.weight,
      frac: mean(objective.krs, (k) => k.frac),
      score: mean(objective.krs, (k) => k.score),
      scoreTarget: mean(objective.krs, (k) => k.scoreTarget),
      krs: objective.krs.length
    };
    if (!byDept.has(objective.dept)) byDept.set(objective.dept, []);
    byDept.get(objective.dept).push(roll);
  }

  const problems = [];
  for (const stat of tree.deptStats) {
    const objs = byDept.get(stat.id);
    if (!objs) {
      problems.push(`deptStats trae ${stat.id}, que no existe en la base`);
      continue;
    }
    const expected = {
      pct: mean(objs, (o) => o.frac) * 100,
      score: mean(objs, (o) => o.score),
      scoreTarget: mean(objs, (o) => o.scoreTarget),
      objs: objs.length,
      krs: objs.reduce((a, o) => a + o.krs, 0)
    };
    for (const [key, tol] of [['pct', 0.05], ['score', 0.005], ['scoreTarget', 0.005],
      ['objs', 0], ['krs', 0]]) {
      if (Math.abs(Number(stat[key]) - expected[key]) > tol) {
        problems.push(
          `${stat.id}.${key}: datasource ${stat[key]}, seccion 5 da ${expected[key].toFixed(4)}`
        );
      }
    }
  }
  if (byDept.size !== tree.deptStats.length) {
    problems.push(`deptStats devolvio ${tree.deptStats.length} filas, la base tiene ${byDept.size}`);
  }
  // ritmo esperado = dia / dias del ciclo; el dia va acotado al ciclo, no puede pasarse.
  const days =
    Math.round((Date.parse(tree.cycle.dateto) - Date.parse(tree.cycle.datefrom)) / 86400000) + 1;
  if (tree.cycle.days !== days) problems.push(`cycle.days ${tree.cycle.days}, el rango da ${days}`);

  // Every KR the UI draws must produce an avance the rail can actually place.
  for (const kr of tree.krs) {
    const span = kr.target - kr.base;
    const p = span === 0
      ? (kr.current >= kr.target ? 100 : 0)
      : clamp(((kr.current - kr.base) / span) * 100, 0, 100);
    if (!Number.isFinite(p)) problems.push(`el KR "${kr.title}" da un avance no finito`);
    if (kr.score < 0 || kr.score > 1 || kr.scoreTarget < 0 || kr.scoreTarget > 1) {
      problems.push(`el KR "${kr.title}" tiene score fuera de [0, 1]`);
    }
  }

  return problems.length
    ? fail('W6', 'formulas de la seccion 5', problems.join('; '))
    : pass('W6', 'formulas de la seccion 5',
      `${tree.deptStats.length} rollups, el ritmo del ciclo y ${tree.krs.length} avances ` +
      'coinciden con el calculo independiente');
}

/* ------------------------------------------------------------------------------ runner */

async function main() {
  let dbBroken = null;
  try {
    query('select 1');
  } catch (e) {
    dbBroken = e.message.split('\n')[0];
  }

  let reachable = true;
  try {
    await login();
  } catch (e) {
    reachable = false;
    for (const [id, name] of [
      ['W3', 'servida desde MainLayout/View'],
      ['W4', 'contrato del arbol'],
      ['W5', 'filtro en el datasource'],
      ['W6', 'formulas de la seccion 5']
    ]) {
      skip(id, name, `instancia inaccesible en ${BASE}: ${e.message}`);
    }
  }

  if (dbBroken) skip('W1', 'AD wiring', `base inaccesible: ${dbBroken}`);
  else gateAdWiring();
  gateBundle();

  if (reachable) {
    await gateServedView();
    await gateTreeContract();
    await gateFilterInDatasource();
    if (dbBroken) skip('W6', 'formulas de la seccion 5', `base inaccesible: ${dbBroken}`);
    else await gateFormulas();
  }

  results.sort((a, b) => a.id.localeCompare(b.id));
  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) {
    const mark = r.state === 'PASS' ? 'ok  ' : r.state === 'FAIL' ? 'FAIL' : 'skip';
    console.log(`  ${mark}  ${r.id}  ${r.name.padEnd(width)}  ${r.detail}`);
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
