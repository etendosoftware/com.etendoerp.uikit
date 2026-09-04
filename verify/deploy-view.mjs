#!/usr/bin/env node
/*
 * Assembles a uikit view's bundle and installs it as the view's FreeMarker template.
 *
 * Why this exists: ViewComponent serves a template-only OBUIAPP_View_Impl through a generic
 * BaseTemplateComponent, so a window needs no Java class of its own -- but it does need a template
 * body. OBCLKER_TEMPLATE.template is varchar(2000), far too small for a real bundle, so we use the
 * other option the platform already offers: TEMPLATECLASSPATHLOCATION, which BaseTemplateProcessor
 * reads with getResourceAsStream (hence the leading slash) at request time.
 *
 * The bundle is a build artifact, and it is written where the build reads it:
 * modules/<module>/src/<package>/templates/<view>.ftl. src/build.xml's postsrc.modules copies
 * everything under a module's src/ except the .java into WEB-INF/classes, stripping the
 * "<module>/src" prefix, so that one file is what smartbuild delivers to the classpath location
 * the AD row points at. That is the same convention core's own modules follow, and the reason
 * matters: a war redeploy re-explodes WEB-INF/classes, so anything only ever hand-placed there
 * disappears with the next build and takes the window down with it.
 *
 * The exploded webapp copy this also writes is a convenience, not the deliverable: it is how the
 * running Tomcat sees the change without a build. BaseTemplateProcessor skips its template cache
 * while the owning module is in development, so editing the bundle stays one deploy-view run and a
 * browser reload -- but the file under src/ is the one that has to be committed.
 *
 * The whole bundle is wrapped in <#noparse>: the template language is FreeMarker, which would
 * otherwise eat every ${...} in a JavaScript template literal.
 *
 * Known limitation: the AD_MESSAGE labels are read here, at deploy time, and baked into the
 * bundle. That keeps the runtime free of a per-request lookup, but it also freezes the window in
 * one language -- every user gets the labels as they read at deploy time, whatever their own
 * language is. Fixing it means having the template read the labels per request, at which point
 * the bundle stops being a static file; that is a deliberate later decision, not an oversight.
 *
 * Usage: node modules/com.etendoerp.uikit/verify/deploy-view.mjs <manifest.json> [--print]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const CONTAINER = process.env.ETENDO_DB_CONTAINER || 'etendo-db-1';
const CORE = path.resolve(import.meta.dirname, '../../..');
const MODULES = path.join(CORE, 'modules');

function fail(message) {
  console.error(`deploy-view: ${message}`);
  process.exit(1);
}

/** Database credentials come from the instance's own properties file, never from source. */
function dbConfig() {
  const file = path.join(CORE, 'config/Openbravo.properties');
  if (!fs.existsSync(file)) {
    fail(`no encontre ${path.relative(CORE, file)}`);
  }
  const props = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([\w.]+)\s*=\s*(.*)$/.exec(line);
    if (m) {
      props[m[1]] = m[2].trim();
    }
  }
  const name = props['bbdd.sid'] || props['bbdd.systemUser'];
  if (!props['bbdd.user'] || !name) {
    fail('Openbravo.properties no declara bbdd.user / bbdd.sid');
  }
  return { user: props['bbdd.user'], db: name };
}

const DB = dbConfig();

function psql(sql, args = []) {
  return execFileSync(
    'docker',
    ['exec', '-i', CONTAINER, 'psql', '-U', DB.user, '-d', DB.db, '-t', '-A', '-v', 'ON_ERROR_STOP=1', ...args, '-c', sql],
    { encoding: 'utf8' }
  ).trim();
}

/** Reads the module file, refusing silently-empty input. */
function read(rel) {
  const file = path.join(MODULES, rel);
  if (!fs.existsSync(file)) {
    fail(`el manifest apunta a ${rel}, que no existe`);
  }
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) {
    fail(`${rel} esta vacio`);
  }
  return text;
}

/** Pulls the visible strings out of AD_MESSAGE so the bundle never hardcodes a translation. */
function labels(prefixes) {
  const where = prefixes.map((p) => `value like '${p.replace(/'/g, "''")}%'`).join(' or ');
  const rows = psql(
    `select value || E'\\t' || msgtext from ad_message where isactive = 'Y' and (${where}) order by value`
  );
  const map = {};
  for (const line of rows.split('\n').filter(Boolean)) {
    const [key, ...rest] = line.split('\t');
    map[key] = rest.join('\t');
  }
  return map;
}

const manifestPath = process.argv[2];
if (!manifestPath) {
  fail('falta el manifest: node verify/deploy-view.mjs <manifest.json>');
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const parts = [];

for (const entry of manifest.bundle) {
  if (entry.type === 'js') {
    parts.push(`/* ${entry.path} */\n${read(entry.path)}`);
  } else if (entry.type === 'css') {
    parts.push(
      `/* ${entry.path} */\nOB.UIKit.style(${JSON.stringify(entry.key)}, ${JSON.stringify(read(entry.path))});`
    );
  } else if (entry.type === 'labels') {
    const map = labels(entry.prefixes);
    const found = Object.keys(map).length;
    // A diagnostic, so stderr: --print sends the bundle itself to stdout, and a line of prose at
    // the top of a redirected .ftl is a template that fails to parse.
    console.error(`  ${found} etiqueta(s) desde AD_MESSAGE: ${Object.keys(map).join(', ') || '(ninguna)'}`);
    parts.push(`/* AD_MESSAGE */\nOB.UIKit.labels(${JSON.stringify(map)});`);
  } else {
    fail(`tipo de entrada desconocido: ${entry.type}`);
  }
}

const banner =
  `/* ${manifest.view} -- generado por verify/deploy-view.mjs. No editar en base de datos:\n` +
  `   la fuente son los archivos web/ de los modulos, y este bundle se regenera desde ahi. */\n`;
const bundle = `<#noparse>\n${banner}${parts.join('\n\n')}\n</#noparse>\n`;

if (process.argv.includes('--print')) {
  process.stdout.write(bundle);
  process.exit(0);
}

/*
 * Where the running webapp reads its classes from. Writing here is the dev-loop mirror only; it is
 * wiped and rebuilt every time the war is re-exploded, which is exactly why the file under the
 * module's src/ is the real deliverable.
 */
function webappClasses() {
  if (process.env.ETENDO_WEBAPP_CLASSES) {
    return process.env.ETENDO_WEBAPP_CLASSES;
  }
  const props = fs.readFileSync(path.join(CORE, 'config/Openbravo.properties'), 'utf8');
  const context = /^context\.name\s*=\s*(.+)$/m.exec(props);
  if (!context) {
    fail('Openbravo.properties no declara context.name');
  }
  return path.join(CORE, 'volumes/tomcat/webapps', context[1].trim(), 'WEB-INF/classes');
}

if (!manifest.classpath || !manifest.classpath.startsWith('/')) {
  fail('el manifest necesita "classpath" con barra inicial: BaseTemplateProcessor usa getResourceAsStream');
}
if (!manifest.source) {
  fail('el manifest necesita "source": la ruta bajo modules/ que el build empaqueta');
}
/*
 * The build's mapper is <module>/src -> "", so these two have to agree or smartbuild will deliver
 * the template to a path the AD row does not name, and the window dies on the next war redeploy
 * with the file sitting right there on disk.
 */
const cut = manifest.source.indexOf('/src/');
if (cut < 0 || manifest.source.slice(cut + 4) !== manifest.classpath) {
  fail(
    `"source" y "classpath" no concuerdan: el build entrega ${manifest.source.slice(cut + 4) || '(sin /src/)'}` +
      ` pero la plantilla apunta a ${manifest.classpath}`
  );
}

const target = path.join(MODULES, manifest.source);
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, bundle, 'utf8');

// The mirror, so the running instance picks the change up without waiting for a build.
const classes = webappClasses();
let mirrored = null;
if (fs.existsSync(classes)) {
  mirrored = path.join(classes, manifest.classpath.slice(1));
  fs.mkdirSync(path.dirname(mirrored), { recursive: true });
  fs.copyFileSync(target, mirrored);
}

// Idempotent: only writes when the row does not already point at this file.
const pointed = psql(
  `update obclker_template set templateclasspathlocation = '${manifest.classpath}',` +
    ` template = '/* el cuerpo vive en ' || '${manifest.classpath}' || ' */',` +
    ` updated = now(), updatedby = '100'` +
    ` where name = '${manifest.view}'` +
    ` and coalesce(templateclasspathlocation, '') <> '${manifest.classpath}'` +
    ` returning obclker_template_id`
);

console.log(
  `  ${manifest.view}: ${(bundle.length / 1024).toFixed(1)} kB -> ${path.relative(CORE, target)}`
);
console.log(
  mirrored
    ? `  espejado en ${path.relative(CORE, mirrored)} (lo definitivo lo entrega smartbuild)`
    : '  sin webapp explotado: solo queda la fuente, la entrega el build'
);
console.log(
  pointed
    ? `  OBCLKER_TEMPLATE apuntada a ${manifest.classpath}`
    : `  OBCLKER_TEMPLATE ya apuntaba a ${manifest.classpath}`
);
