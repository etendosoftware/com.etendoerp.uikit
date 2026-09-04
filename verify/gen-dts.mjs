#!/usr/bin/env node
/*
 * Generates docs/api/uikit.d.ts from the runtime's own JSDoc.
 *
 * L2 exists so an agent can look up an exact signature without reading the runtime. Hand-writing
 * that file would guarantee it drifts from the code within a round, so it is generated: the
 * annotations next to each function are the single source of truth, and gate G9 fails the build
 * when the checked-in file no longer matches what these annotations produce.
 *
 * Usage: node modules/com.etendoerp.uikit/verify/gen-dts.mjs [--check]
 *   --check  writes nothing; exits non-zero when the file on disk is stale
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERIFY = path.dirname(fileURLToPath(import.meta.url));
const MODULE = path.dirname(VERIFY);
const RUNTIME = path.join(MODULE, 'web/com.etendoerp.uikit/js/uikit.js');
const TARGET = path.join(MODULE, 'docs/api/uikit.d.ts');

/** JSDoc types to TypeScript. Anything unmapped is passed through, which keeps the table honest. */
const TYPES = [
  [/^\*$/, 'unknown'],
  [/^\.\.\.\*$/, 'unknown[]'],
  [/^Object$/, 'object'],
  [/^Object<string, ?string>$/, 'Record<string, string>'],
  [/^Object<string, ?\*>$/, 'Record<string, unknown>'],
  [/^Object<string, ?string\|Raw>$/, 'Record<string, string | Raw>'],
  [/^string\[\]$/, 'string[]'],
  [/^\{ action: string \}$/, '{ action: string }']
];

function tsType(jsdoc) {
  for (const [re, ts] of TYPES) {
    if (re.test(jsdoc)) return ts;
  }
  // function(A, B): C -> (a: A, b: B) => C, with names taken from the trailing prose when present.
  const fn = /^function\((.*)\): ?(.*)$/.exec(jsdoc);
  if (fn) {
    const args = fn[1] === '' ? [] : splitTop(fn[1]);
    const names = ['a', 'b', 'c', 'd'];
    const params = args.map((arg, i) => {
      const optional = arg.endsWith('=');
      const bare = optional ? arg.slice(0, -1) : arg;
      return `${names[i]}${optional ? '?' : ''}: ${tsType(bare.trim())}`;
    });
    return `(${params.join(', ')}) => ${tsType(fn[2].trim())}`;
  }
  const generic = /^Object<string, ?(.+)>$/.exec(jsdoc);
  if (generic) return `Record<string, ${tsType(generic[1].trim())}>`;
  return jsdoc.replace(/\|/g, ' | ');
}

/** Splits a JSDoc type list on top-level commas, so function(A, B) survives as one argument. */
function splitTop(text) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if ('({['.includes(c)) depth++;
    else if (')}]'.includes(c)) depth--;
    else if (c === ',' && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Every /** ... *\/ block paired with the function declaration that follows it. */
function annotated(source) {
  const out = new Map();
  const re = /\/\*\*([\s\S]*?)\*\/\s*function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g;
  for (const m of source.matchAll(re)) {
    const body = m[1]
      .split('\n')
      .map((line) => line.replace(/^\s*\*ap?/, '').replace(/^\s*\* ?/, '').trimEnd())
      .join('\n');
    const params = [];
    const returns = { type: 'void', text: '' };
    const prose = [];
    for (const line of body.split('\n')) {
      const p = /^@param\s+\{(.+?)\}\s+(\[?[\w$.]+\]?)\s*(.*)$/.exec(line.trim());
      const r = /^@returns?\s+\{(.+?)\}\s*(.*)$/.exec(line.trim());
      if (p) {
        const optional = p[2].startsWith('[');
        params.push({
          type: p[1],
          name: p[2].replace(/^\[|\]$/g, ''),
          optional,
          text: p[3].trim()
        });
      } else if (r) {
        returns.type = r[1];
        returns.text = r[2].trim();
      } else if (!line.trim().startsWith('@')) {
        prose.push(line);
      }
    }
    out.set(m[2], {
      params,
      returns,
      args: splitTop(m[3]),
      prose: prose.join('\n').trim()
    });
  }
  return out;
}

/** The names the runtime publishes, in the order the OB.UIKit literal lists them. */
function surface(source) {
  const start = source.indexOf('{', source.search(/OB\.UIKit\s*=\s*\{/));
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) {
      return [...source.slice(start + 1, i).matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)].map(
        (m) => m[1]
      );
    }
  }
  return [];
}

function block(prose, indent) {
  if (!prose) return '';
  const lines = prose.split('\n');
  return (
    `${indent}/**\n` +
    lines.map((l) => `${indent} *${l ? ` ${l}` : ''}`).join('\n') +
    `\n${indent} */\n`
  );
}

function signature(name, doc) {
  // A nested spec (@param {T} spec.field) becomes an inline object type, so the caller sees the
  // whole shape at the call site instead of chasing an interface.
  const nested = doc.params.filter((p) => p.name.includes('.'));
  const flat = doc.params.filter((p) => !p.name.includes('.'));
  if (nested.length) {
    const root = nested[0].name.split('.')[0];
    const fields = nested
      .map((p) => {
        const comment = p.text ? `  // ${p.text}` : '';
        return `    ${p.name.split('.').slice(1).join('.')}${p.optional ? '?' : ''}: ${tsType(p.type)};${comment}`;
      })
      .join('\n');
    return `  function ${name}(${root}: {\n${fields}\n  }): ${tsType(doc.returns.type)};`;
  }
  const args = flat
    .map((p) => {
      const rest = p.type.startsWith('...') ? '...' : '';
      const type = rest ? tsType(p.type) : tsType(p.type);
      return `${rest}${p.name}${p.optional ? '?' : ''}: ${type}`;
    })
    .join(', ');
  return `  function ${name}(${args}): ${tsType(doc.returns.type)};`;
}

const source = fs.readFileSync(RUNTIME, 'utf8');
const docs = annotated(source);
const names = surface(source);
const version = /var VERSION = '([^']+)'/.exec(source)?.[1] ?? '0.0.0';

const parts = [
  '/*',
  ' * The public surface of com.etendoerp.uikit.',
  ' *',
  ' * GENERATED by verify/gen-dts.mjs from the JSDoc in web/com.etendoerp.uikit/js/uikit.js.',
  ' * Do not edit: gate G9 regenerates it and fails the build if this file disagrees with the',
  ' * runtime. To change a signature, change the annotation next to the function.',
  ' *',
  ' * There is no module system in a Classic page: the runtime publishes one global, OB.UIKit,',
  ' * and every name below is reached through it.',
  ' */',
  '',
  'declare namespace OB.UIKit {',
  '  /** Already-escaped HTML. Only html`` and raw() produce one; nothing else should. */',
  '  interface Raw {',
  '    html: string;',
  '    toString(): string;',
  '  }',
  '',
  `  /** The runtime's own version, for a view that needs to assert a minimum. */`,
  '  const version: string;',
  ''
];

const missing = [];
for (const name of names) {
  if (name === 'version') continue;
  const doc = docs.get(name);
  if (!doc) {
    missing.push(name);
    continue;
  }
  parts.push(block(doc.prose, '  ') + signature(name, doc), '');
}
parts.push('}', '');

if (missing.length) {
  console.error(`gen-dts: sin JSDoc anotado: ${missing.join(', ')}`);
  process.exit(1);
}

const output = parts.join('\n').replace(/\n{3,}/g, '\n\n');
const current = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, 'utf8') : null;

if (process.argv.includes('--check')) {
  if (current === output) {
    console.log(`  uikit.d.ts al dia: ${names.length} simbolo(s), version ${version}`);
    process.exit(0);
  }
  console.error(
    current === null
      ? 'gen-dts: docs/api/uikit.d.ts no existe; corre gen-dts.mjs'
      : 'gen-dts: docs/api/uikit.d.ts no coincide con el JSDoc del runtime; corre gen-dts.mjs'
  );
  process.exit(1);
}

fs.mkdirSync(path.dirname(TARGET), { recursive: true });
fs.writeFileSync(TARGET, output, 'utf8');
console.log(
  `  ${path.relative(MODULE, TARGET)}: ${names.length} simbolo(s), ` +
  `${output.split('\n').length} lineas${current === output ? ' (sin cambios)' : ''}`
);
