#!/usr/bin/env node
/*
 * L6 source gates for com.etendoerp.uikit.
 *
 * Everything here runs without a browser and without a running Etendo, so it can gate every
 * commit. The one thing it refuses to approximate is minification: it compiles and runs the
 * kernel's own JSMin, because a harness that minifies differently from production proves
 * nothing about production.
 *
 * Usage: node modules/com.etendoerp.uikit/verify/check-source.mjs [--verbose]
 * Exit code 0 only when no gate failed.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERIFY = path.dirname(fileURLToPath(import.meta.url));
const MODULE = path.dirname(VERIFY);
const ROOT = path.resolve(MODULE, '..', '..');
const KERNEL = path.join(ROOT, 'modules_core/org.openbravo.client.kernel/src/org/openbravo/client/kernel');
const CACHE = path.join(VERIFY, '.cache');
const VERBOSE = process.argv.includes('--verbose');

const results = [];
const pass = (id, name, detail) => results.push({ id, name, state: 'PASS', detail });
const fail = (id, name, detail) => results.push({ id, name, state: 'FAIL', detail });
const skip = (id, name, detail) => results.push({ id, name, state: 'SKIP', detail });

const rel = (p) => path.relative(ROOT, p);
const read = (p) => fs.readFileSync(p, 'utf8');
const exists = (p) => fs.existsSync(p);

function walk(dir, filter) {
  if (!exists(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, filter));
    else if (filter(full)) out.push(full);
  }
  return out;
}

/* ------------------------------------------------------------------ the real minifier */

let jsminReady = null;

function ensureJsmin() {
  if (jsminReady !== null) return jsminReady;
  const classes = path.join(CACHE, 'classes');
  const runner = path.join(VERIFY, 'jsmin', 'JSMinRunner.java');
  const source = path.join(KERNEL, 'JSMin.java');
  if (!exists(source)) {
    jsminReady = { ok: false, why: `kernel JSMin not found at ${rel(source)}` };
    return jsminReady;
  }
  const stampFile = path.join(CACHE, 'stamp');
  const stamp = [source, runner].map((f) => `${f}:${fs.statSync(f).mtimeMs}`).join('|');
  const compiled = exists(path.join(classes, 'org/openbravo/client/kernel/JSMinRunner.class'));
  if (!compiled || !exists(stampFile) || read(stampFile) !== stamp) {
    fs.mkdirSync(classes, { recursive: true });
    try {
      execFileSync('javac', ['-nowarn', '-d', classes, source, runner], { stdio: 'pipe' });
    } catch (err) {
      jsminReady = { ok: false, why: `javac failed: ${String(err.stderr || err.message).trim().split('\n')[0]}` };
      return jsminReady;
    }
    fs.writeFileSync(stampFile, stamp);
  }
  jsminReady = { ok: true, classes };
  return jsminReady;
}

/** Minify with the kernel's JSMin, then parse the result the way a browser would. */
function minifyAndParse(file) {
  const jsmin = ensureJsmin();
  if (!jsmin.ok) return { ok: false, stage: 'setup', message: jsmin.why };
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'uikit-jsmin-')), 'out.js');
  const min = spawnSync('java', ['-cp', jsmin.classes, 'org.openbravo.client.kernel.JSMinRunner', file, out],
    { encoding: 'utf8' });
  if (min.status !== 0) {
    return { ok: false, stage: 'jsmin', message: (min.stderr || '').trim().split('\n').slice(-1)[0] || 'jsmin failed' };
  }
  const check = spawnSync(process.execPath, ['--check', out], { encoding: 'utf8' });
  if (check.status !== 0) {
    return { ok: false, stage: 'parse', message: (check.stderr || '').trim().split('\n').filter(Boolean).slice(-1)[0] };
  }
  return { ok: true, bytes: fs.statSync(out).size };
}

/* ------------------------------------------------------------------ G0 gate self-test */

{
  const ok = path.join(VERIFY, 'fixtures', 'es2018-ok.js');
  const bad = path.join(VERIFY, 'fixtures', 'broken.js');
  const good = minifyAndParse(ok);
  const broken = minifyAndParse(bad);
  if (!good.ok) {
    fail('G0', 'jsmin-selftest', `ES2018 fixture rejected at ${good.stage}: ${good.message} — fact F1 would be wrong`);
  } else if (broken.ok) {
    fail('G0', 'jsmin-selftest', 'broken.js was accepted; the gate is not checking anything');
  } else {
    pass('G0', 'jsmin-selftest', `ES2018 accepted (${good.bytes} B minified), broken.js rejected at ${broken.stage}`);
  }
}

/* ------------------------------------------------------------------ G1/G2 shipped files */

const shipped = walk(path.join(MODULE, 'web'), (f) => f.endsWith('.js'));

if (shipped.length === 0) {
  skip('G1', 'jsmin-shipped', 'no web resources shipped yet (R0: the runtime is unwritten)');
  skip('G2', 'iife', 'no web resources shipped yet');
} else {
  const bad = [];
  for (const file of shipped) {
    const r = minifyAndParse(file);
    if (!r.ok) bad.push(`${rel(file)} (${r.stage}: ${r.message})`);
  }
  bad.length ? fail('G1', 'jsmin-shipped', bad.join('; '))
    : pass('G1', 'jsmin-shipped', `${shipped.length} file(s) minify and parse`);

  const leaks = [];
  for (const file of shipped) {
    const src = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const body = src.trim();
    if (!/^[;(]?\s*\(?\s*function\s*\(|^\s*\(\s*\(\s*\)\s*=>/.test(body)) leaks.push(`${rel(file)}: does not open with an IIFE`);
    const tops = body.split('\n').filter((l) => /^(var|let|const|function|class)\s/.test(l));
    if (tops.length) leaks.push(`${rel(file)}: ${tops.length} top-level binding(s)`);
  }
  leaks.length ? fail('G2', 'iife', leaks.join('; ')) : pass('G2', 'iife', `${shipped.length} file(s) are single IIFEs`);
}

/* ------------------------------------------------------------------ G3 L0 budget */

{
  const l0 = path.join(MODULE, 'AGENTS.md');
  if (!exists(l0)) {
    fail('G3', 'L0-budget', 'AGENTS.md is missing; an agent has no entry point');
  } else {
    const text = read(l0);
    const lines = text.split('\n').length;
    const problems = [];
    if (lines > 120) problems.push(`${lines} lines exceeds the 120-line budget`);
    for (const n of [1, 2, 3, 4, 5]) {
      if (!new RegExp(`^${n}\\. \\*\\*`, 'm').test(text)) problems.push(`step ${n} of the workflow is missing`);
    }
    if (!/^## Invariants/m.test(text)) problems.push('the Invariants section is missing');
    if (!/^## Router/m.test(text)) problems.push('the Router table is missing');
    if (!/never edit core/i.test(text)) problems.push('the "never edit core" invariant is missing');
    problems.length ? fail('G3', 'L0-budget', problems.join('; '))
      : pass('G3', 'L0-budget', `${lines}/120 lines, five steps, invariants and router present`);
  }
}

/* ------------------------------------------------------------------ G4 index integrity */

const indexPath = path.join(MODULE, 'uikit.contract.json');
let index = null;
{
  const problems = [];
  if (!exists(indexPath)) {
    fail('G4', 'index', 'uikit.contract.json is missing; docs cannot be selected by budget');
  } else {
    try {
      index = JSON.parse(read(indexPath));
    } catch (err) {
      problems.push(`not valid JSON: ${err.message}`);
    }
    if (index) {
      for (const doc of index.docs ?? []) {
        const full = path.join(MODULE, doc.file);
        if (doc.status === 'present') {
          if (!exists(full)) problems.push(`${doc.id}: declared present but ${doc.file} does not exist`);
          else {
            const lines = read(full).split('\n').length;
            if (doc.budget_lines && lines > doc.budget_lines) {
              problems.push(`${doc.id}: ${lines} lines over its ${doc.budget_lines}-line budget`);
            }
          }
        } else if (doc.status === 'planned') {
          if (exists(full)) problems.push(`${doc.id}: ${doc.file} now exists but the index still says planned`);
        } else {
          problems.push(`${doc.id}: unknown status "${doc.status}"`);
        }
      }
      const ids = new Set((index.docs ?? []).map((d) => d.id));
      for (const sym of index.symbols ?? []) {
        if (!ids.has(sym.documented_in)) problems.push(`symbol ${sym.name} points at unknown doc ${sym.documented_in}`);
      }
      const l0text = exists(path.join(MODULE, 'AGENTS.md')) ? read(path.join(MODULE, 'AGENTS.md')) : '';
      if (l0text && (index.invariants ?? []).length === 0) problems.push('the index lists no invariants');
    }
    problems.length ? fail('G4', 'index', problems.join('; '))
      : pass('G4', 'index', `${(index.docs ?? []).length} docs indexed, ${(index.docs ?? []).filter((d) => d.status === 'present').length} present`);
  }
}

/* ------------------------------------------------------------------ G5 docs are code */

{
  const docs = [path.join(MODULE, 'AGENTS.md'), ...walk(path.join(MODULE, 'docs'), (f) => f.endsWith('.md'))];
  const known = new Set((index?.symbols ?? []).map((s) => s.name));
  const problems = [];
  let blocks = 0;
  const named = new Set();
  for (const doc of docs) {
    if (!exists(doc)) continue;
    const text = read(doc);
    for (const m of text.matchAll(/```(?:js|javascript)\n([\s\S]*?)```/g)) {
      blocks += 1;
      const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'uikit-doc-')), 'block.js');
      fs.writeFileSync(tmp, m[1]);
      const r = minifyAndParse(tmp);
      if (!r.ok) problems.push(`${rel(doc)}: code block ${blocks} fails at ${r.stage}: ${r.message}`);
    }
    for (const m of text.matchAll(/OB\.UIKit\.([A-Za-z_$][\w$]*)/g)) named.add(`OB.UIKit.${m[1]}`);
  }
  for (const name of named) {
    if (!known.has(name)) problems.push(`the docs name ${name}, which is not in uikit.contract.json symbols`);
  }
  if (blocks === 0) problems.push('the docs contain no runnable code block, so this gate proves nothing');
  problems.length ? fail('G5', 'doc-code', problems.join('; '))
    : pass('G5', 'doc-code', `${blocks} code block(s) minify and parse, ${named.size} symbol reference(s) all indexed`);
}

/* ------------------------------------------------------------------ G6 citations resolve */

{
  const docs = walk(path.join(MODULE, 'docs'), (f) => f.endsWith('.md'));
  const problems = [];
  let checked = 0;
  for (const doc of docs) {
    const text = read(doc);
    for (const m of text.matchAll(/<!--cite ([^|]+)\|(\d+)\|([\s\S]*?)-->/g)) {
      checked += 1;
      const [, file, lineNo, expected] = m;
      const target = path.join(ROOT, file.trim());
      if (!exists(target)) { problems.push(`${rel(doc)}: cited file ${file.trim()} does not exist`); continue; }
      const lines = read(target).split('\n');
      const line = lines[Number(lineNo) - 1];
      if (line === undefined) { problems.push(`${file.trim()} has no line ${lineNo}`); continue; }
      if (!line.includes(expected.trim())) {
        const found = lines.findIndex((l) => l.includes(expected.trim())) + 1;
        problems.push(`${file.trim()}:${lineNo} no longer contains "${expected.trim()}"${found ? ` (now at line ${found})` : ' (not found in the file at all)'}`);
      }
    }
  }
  if (checked === 0) fail('G6', 'citations', 'no citations found; L5 cannot be trusted without them');
  else problems.length ? fail('G6', 'citations', problems.join('; '))
    : pass('G6', 'citations', `${checked} citation(s) still resolve in core`);
}

/* ------------------------------------------------------------------ G7 core untouched */

{
  const CORE = ['src/', 'src-core/', 'src-wad/', 'modules_core/', 'src-db/', 'src-trl/'];
  let out = null;
  try {
    out = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
  } catch {
    skip('G7', 'core-untouched', 'not a git checkout');
  }
  if (out !== null) {
    const touched = out.split('\n')
      .filter((l) => /^[ MARCD][MARCD]? /.test(l))
      .map((l) => l.slice(3).trim())
      .filter((f) => CORE.some((prefix) => f.startsWith(prefix)));
    touched.length ? fail('G7', 'core-untouched', `modified core file(s): ${touched.join(', ')}`)
      : pass('G7', 'core-untouched', 'no core file modified in the working tree');
  }
}

/* ------------------------------------------------------------------ report */

const width = Math.max(...results.map((r) => r.name.length));
for (const r of results) {
  const mark = r.state === 'PASS' ? 'ok  ' : r.state === 'FAIL' ? 'FAIL' : 'skip';
  console.log(`${mark} ${r.id} ${r.name.padEnd(width)}  ${r.detail}`);
}
const failed = results.filter((r) => r.state === 'FAIL');
const skipped = results.filter((r) => r.state === 'SKIP');
console.log('');
console.log(`${results.length - failed.length - skipped.length}/${results.length - skipped.length} gates green` +
  (skipped.length ? `, ${skipped.length} not applicable yet` : '') +
  (failed.length ? ` — FAILED: ${failed.map((f) => f.id).join(', ')}` : ''));
if (VERBOSE) console.log(JSON.stringify(results, null, 2));
process.exit(failed.length ? 1 : 0);
