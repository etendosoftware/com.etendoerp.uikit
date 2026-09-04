#!/usr/bin/env node
/*
 * L6 i18n report for com.etendoerp.uikit: literales visibles que no pasan por OB.UIKit.t().
 *
 * El invariante que audita: ningun texto que el usuario lee esta escrito en el JS. Las etiquetas
 * viven en AD_MESSAGE con prefijo de modulo, deploy-view.mjs las hornea en el bundle y el runtime
 * las resuelve con OB.UIKit.t(clave). Nada lo verificaba, asi que este script lo mira.
 *
 * ES UN INFORME, NO UNA BARANDA. Sale con 0 aunque encuentre cosas, a proposito: es un gate nuevo
 * sobre codigo viejo, y volver rojo el pipeline de otro por deuda heredada no ayuda a nadie. Con
 * --strict devuelve 1 si hay hallazgos, que es como se engancharia el dia que el arbol este limpio.
 *
 * Usage: node modules/com.etendoerp.uikit/verify/check-literals.mjs [opciones]
 *          --strict        salir 1 si hay hallazgos (por defecto sale 0 siempre)
 *          --file <path>   solo este archivo (absoluto o relativo a modules/)
 *          --all           listar todos los hallazgos, sin recortar a 12 por archivo
 *          --ignored       imprimir tambien los literales descartados y por que regla
 *          --orphans       auditar tambien los .js que ningun manifest declara todavia
 *          --json          volcar el informe crudo como JSON
 *
 * QUE ARCHIVOS MIRA
 * Los que declaran los manifests: modules/<module>/<slug>.view.json, entradas bundle[] de
 * type "js". Descubiertos, no listados, para que una ventana nueva entre sola. Un .js bajo web/
 * que ningun manifest declare se reporta aparte: no se audita lo que nadie despliega, pero que
 * exista sin manifest es dato.
 *
 * COMO DECIDE
 * El problema de un gate de literales no es la cobertura, es el falso positivo: el que grita por
 * cada string es el que nadie corre dos veces. Asi que primero descarta por CONTEXTO (donde esta
 * el literal) y despues por FORMA (que dice), y solo lo que sobrevive a las dos pasadas se marca.
 * Las reglas de descarte estan en IGNORE y las de marcado en flagQuoted()/scanMarkup(); cada
 * hallazgo y cada descarte lleva el nombre de la regla que lo decidio, para poder discutirla.
 *
 * La senal mas fuerte no es la forma del string sino su destino: un literal que cae en un nodo de
 * texto de una plantilla html`` ya esta en la pantalla, no hace falta adivinar. Por eso los
 * template literals se parsean como markup en vez de mirarse como strings.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERIFY = path.dirname(fileURLToPath(import.meta.url));
const MODULE = path.dirname(VERIFY);
const MODULES = path.dirname(MODULE);
const ROOT = path.resolve(MODULES, '..');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const flag = (f) => {
  const i = argv.indexOf(f);
  return i === -1 ? null : argv[i + 1];
};
const STRICT = has('--strict');
const ALL = has('--all');
const SHOW_IGNORED = has('--ignored');
const AS_JSON = has('--json');
const WITH_ORPHANS = has('--orphans');
const ONLY = flag('--file');
const CAP = 12;

const rel = (p) => {
  const r = path.relative(ROOT, p);
  return r.startsWith('..') ? p : r;
};
const read = (p) => fs.readFileSync(p, 'utf8');
const exists = (p) => fs.existsSync(p);

/* ============================================================ el tokenizador de JavaScript */

/*
 * Un lexer chico, no un parser. Solo tiene que saber lo suficiente para no confundirse:
 * comentarios (un literal que solo aparece comentado no es texto de pantalla), literales de
 * regex (`/'/g` no abre un string), y template literals con ${} anidados, que son la mitad del
 * problema porque ahi vive el markup.
 *
 * Emite dos cosas: strings entrecomillados con su contexto, y template literals con sus trozos
 * estaticos y la linea de cada uno. Va armando en paralelo `code`, el fuente con cada literal y
 * cada comentario reemplazado por un caracter opaco, que es lo que permite despues preguntar
 * "dentro de que llamada estaba este literal" sin volver a parsear.
 */
const OPAQUE = '\u0001';   // un literal ya consumido
const COMMENT = '\u0002';  // un comentario ya consumido: para la mirada atras cuenta como espacio

/** Recorta espacios y comentarios del final: mirar atras no debe tropezar con un `// ...`. */
const trimCode = (code) => code.replace(/[\s\u0002]+$/, '');

/** true si un `/` en esta posicion abre una regex y no es una division. */
function regexAllowed(code) {
  const tail = trimCode(code);
  if (tail === '') return true;
  const last = tail[tail.length - 1];
  if (/[)\]}]/.test(last)) return false;
  if (/[\w$]/.test(last)) {
    // Una palabra clave admite regex a la derecha; un identificador o un numero, no.
    const word = /([A-Za-z_$][\w$]*)$/.exec(tail);
    return !!word && /^(return|typeof|instanceof|in|of|new|delete|void|do|else|case|yield|await|throw)$/.test(word[1]);
  }
  if (last === OPAQUE) return false;
  return true;
}

function cook(rawText) {
  return rawText.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (whole, esc) => {
    if (esc[0] === 'u' || esc[0] === 'x') {
      try {
        return JSON.parse(`"\\${esc}"`);
      } catch {
        return whole;
      }
    }
    return { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' }[esc] ?? esc;
  });
}

function tokenize(text) {
  const strings = [];
  const templates = [];
  let code = '';
  let i = 0;
  let line = 1;
  // Pila de frames. CODE lleva la profundidad de llaves para saber cual `}` cierra un ${}.
  const stack = [{ type: 'CODE', braces: 0, inTemplate: false }];

  const advance = (n) => {
    for (let k = 0; k < n; k++) if (text[i + k] === '\n') line++;
    i += n;
  };

  while (i < text.length) {
    const top = stack[stack.length - 1];

    if (top.type === 'TMPL') {
      let chunk = '';
      const chunkLine = line;
      for (;;) {
        if (i >= text.length) break;
        const ch = text[i];
        if (ch === '\\') {
          chunk += text.slice(i, i + 2);
          advance(2);
          continue;
        }
        if (ch === '`') {
          advance(1);
          top.chunks.push({ text: cook(chunk), line: chunkLine });
          stack.pop();
          templates.push(top);
          code += OPAQUE;
          break;
        }
        if (ch === '$' && text[i + 1] === '{') {
          advance(2);
          top.chunks.push({ text: cook(chunk), line: chunkLine });
          top.exprs += 1;
          stack.push({ type: 'CODE', braces: 0, inTemplate: true });
          break;
        }
        chunk += ch;
        advance(1);
      }
      continue;
    }

    const ch = text[i];
    const two = text.slice(i, i + 2);

    if (two === '//') {
      const end = text.indexOf('\n', i);
      advance((end === -1 ? text.length : end) - i);
      code += COMMENT;
      continue;
    }
    if (two === '/*') {
      const end = text.indexOf('*/', i + 2);
      advance((end === -1 ? text.length : end + 2) - i);
      code += COMMENT;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const startLine = line;
      const startCode = code;
      let body = '';
      advance(1);
      while (i < text.length && text[i] !== ch) {
        if (text[i] === '\\') {
          body += text.slice(i, i + 2);
          advance(2);
          continue;
        }
        if (text[i] === '\n') break; // string sin cerrar: no vale la pena adivinar
        body += text[i];
        advance(1);
      }
      advance(1);
      code += OPAQUE;
      strings.push({
        value: cook(body),
        line: startLine,
        before: startCode,
        after: i,
        // Dentro de un ${} de un template literal: lo que salga de aca se interpola en el markup.
        inTemplateExpr: stack.some((f) => f.type === 'TMPL')
      });
      continue;
    }
    if (ch === '`') {
      const tag = /([A-Za-z_$][\w$.]*)$/.exec(trimCode(code));
      advance(1);
      stack.push({
        type: 'TMPL',
        tag: tag ? tag[1] : null,
        chunks: [],
        exprs: 0,
        line,
        before: code
      });
      continue;
    }
    if (ch === '/' && regexAllowed(code)) {
      advance(1);
      let inClass = false;
      while (i < text.length) {
        const c = text[i];
        if (c === '\\') { advance(2); continue; }
        if (c === '\n') break;
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) { advance(1); break; }
        advance(1);
      }
      while (i < text.length && /[dgimsuvy]/.test(text[i])) advance(1);
      code += OPAQUE;
      continue;
    }
    if (ch === '{') top.braces += 1;
    else if (ch === '}') {
      if (top.braces > 0) top.braces -= 1;
      else if (top.inTemplate) {
        stack.pop();
        advance(1);
        continue;
      }
    }
    code += ch;
    advance(1);
  }
  return { strings, templates };
}

/* ============================================================ contexto de un literal */

/**
 * El nombre de la funcion en cuya lista de argumentos cae el literal, o null.
 * Camina `code` hacia atras hasta el primer `(` sin cerrar y lee la cadena de identificadores
 * que lo precede, asi `K.t(` devuelve "K.t" y `console.warn(` devuelve "console.warn".
 */
function enclosingCall(code) {
  let depth = 0;
  for (let i = code.length - 1; i >= 0; i--) {
    const c = code[i];
    if (c === ')' || c === ']') depth += 1;
    else if (c === '[') { if (depth === 0) return null; depth -= 1; }
    else if (c === '(') {
      if (depth > 0) { depth -= 1; continue; }
      const m = /([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)$/.exec(trimCode(code.slice(0, i)));
      return m ? m[1].replace(/\s+/g, '') : null;
    } else if (c === ';' || c === '{' || c === '}') {
      if (depth === 0) return null;
    }
  }
  return null;
}

/** El nombre de la propiedad de la que este literal es el valor (`label: 'x'`), o null. */
function ownerProperty(code) {
  const head = trimCode(code);
  if (head[head.length - 1] !== ':') return null;
  const m = /([A-Za-z_$][\w$]*|'[^']*'|"[^"]*")\s*:$/.exec(head);
  if (!m) return null;
  return m[1].replace(/^['"]|['"]$/g, '');
}

/**
 * true si el literal se asigna a className o a una propiedad de style: es CSS, no texto.
 * `root.className = 'uik uik-' + name` pasaria por frase si no se preguntara esto.
 */
function isCssTarget(code) {
  return /\.(className|class)\s*=$/.test(trimCode(code)) || /\.style\.[\w-]+\s*=$/.test(trimCode(code));
}

/** true si el literal ocupa el lugar de la clave y no del valor: `{ 'NEW': ... }`. */
function isPropertyKey(text, lit) {
  const before = trimCode(lit.before);
  const opener = before[before.length - 1];
  if (opener !== '{' && opener !== ',' && before !== '') return false;
  let j = lit.after;
  while (j < text.length && /\s/.test(text[j])) j++;
  return text[j] === ':' && text[j + 1] !== ':';
}

/** El nombre de la variable/propiedad a la que se esta asignando el objeto que contiene al literal. */
function enclosingAssignment(code) {
  let depth = 0;
  for (let i = code.length - 1; i >= 0; i--) {
    const c = code[i];
    if (c === '}' || c === ')' || c === ']') depth += 1;
    else if (c === ')' || c === ']') depth -= 1;
    else if (c === '{') {
      if (depth > 0) { depth -= 1; continue; }
      const head = trimCode(code.slice(0, i));
      const m = /(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=$/.exec(head)
        || /([A-Za-z_$][\w$]*)\s*[=:]$/.exec(head);
      return m ? m[1] : null;
    } else if (c === '(') {
      if (depth > 0) depth -= 1;
      else return null;
    } else if (c === ';') {
      if (depth === 0) return null;
    }
  }
  return null;
}

/* ============================================================ reglas de forma */

const LETTER = 'A-Za-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u00FF';
const RE_LETTER = new RegExp(`[${LETTER}]`, 'g');
const RE_SPANISH = /[áéíóúÁÉÍÓÚñÑüÜ¿¡]/;
const RE_CSS_TOKEN = /^-?[a-z][a-z0-9]*(?:[-_]{1,2}[a-z0-9]+)*[-_]?$/;
const RE_INTERNAL_TAG = /^\[object [A-Za-z]+\]$/;
const RE_UUID = /^(?:[0-9A-Fa-f]{32}|[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})$/;
const RE_AD_KEY = /^[A-Z][A-Z0-9]*_[A-Za-z0-9_]+$/;
const RE_FQCN = /^[a-z][a-z0-9_]*(?:\.[A-Za-z_][\w$]*){2,}$/;
const SQL_WORDS = /\b(select|from|where|inner join|left join|group by|order by|insert into|update|delete from|coalesce|having)\b/gi;

const HTML_TAGS = new Set(('a abbr article aside b body br button canvas caption code col colgroup dd details dialog div dl dt '
  + 'em fieldset figure footer form h1 h2 h3 h4 h5 h6 head header hr html i iframe img input label legend li link main mark '
  + 'menu meta nav ol option optgroup p pre progress s script section select small source span strong style sub summary sup '
  + 'svg table tbody td template textarea tfoot th thead time title tr u ul video wbr path circle rect line polyline g text')
  .split(' '));

/* Funciones cuyo primer argumento es una clave de AD_MESSAGE, no texto. */
const T_CALLS = /(^|\.)(t|tr|fill|label|msg)$/;
/* Funciones cuyos argumentos son de maquina: no llegan a la pantalla. */
const MACHINE_CALLS = new Set([
  'console.log', 'console.warn', 'console.error', 'console.info', 'console.debug', 'console.trace',
  'querySelector', 'querySelectorAll', 'getElementById', 'getElementsByClassName', 'createElement',
  'createElementNS', 'closest', 'matches', 'getAttribute', 'setAttribute', 'removeAttribute',
  'hasAttribute', 'addEventListener', 'removeEventListener', 'dispatchEvent', 'CustomEvent',
  'classList.add', 'classList.remove', 'classList.toggle', 'classList.contains', 'classList.replace',
  'setProperty', 'removeProperty', 'getPropertyValue', 'getComputedStyle', 'RegExp', 'Number',
  'parseInt', 'parseFloat', 'JSON.parse', 'JSON.stringify', 'encodeURIComponent', 'decodeURIComponent',
  'localStorage.getItem', 'localStorage.setItem', 'sessionStorage.getItem', 'sessionStorage.setItem',
  'isc.ClassFactory.defineClass', 'defineView', 'datasource', 'require', 'importScripts'
]);
/* Propiedades cuyo valor es, por definicion, texto que alguien lee. */
const DISPLAY_PROPS = new Set(['label', 'title', 'text', 'heading', 'caption', 'placeholder', 'tooltip',
  'message', 'msg', 'description', 'hint', 'legend', 'summary', 'ariaLabel', 'aria-label', 'prompt',
  'header', 'subtitle', 'empty', 'error', 'unit', 'suffix', 'prefix']);
/*
 * Propiedades que a veces llevan texto y a veces un codigo, sin forma de saber cual desde el
 * fuente. `name` es el caso: en este arbol hay `name: 'ETDEMO_Alerts'` (el nombre de la vista),
 * `name: 'ack'` (el id de una region) y `name: 'Todos'` (la etiqueta del chip "todos los
 * departamentos"). Meterla en DISPLAY_PROPS encontraba el tercero al precio de inventar los otros
 * dos, asi que van al balde de sospechas y las mira una persona.
 */
const AMBIGUOUS_PROPS = new Set(['name', 'value', 'key', 'code']);
/* Atributos HTML cuyo valor sale por pantalla o por el lector de pantalla. */
const DISPLAY_ATTRS = new Set(['title', 'placeholder', 'alt', 'aria-label', 'aria-description',
  'aria-roledescription', 'aria-valuetext', 'aria-placeholder', 'label', 'value']);
/* Variables cuyo objeto es un mapa de etiquetas: todo valor adentro es pantalla. */
const RE_LABEL_HOLDER = /LABEL|LABELS|TEXTO|TEXTS|TITLE|TITULO|CAPTION|MSG|MESSAGE|WORDING|COPY/i;
/* Llamadas cuyo texto es para el que programa, no para el que mira la pantalla. */
const ERROR_CALLS = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'actionError', 'assert']);

/*
 * El vocabulario de estados del propio runtime -- 'ok', 'risk', 'bad', 'flat'. Es la fuente del
 * unico falso positivo que costaba caro: `{ NEW: 'bad' }` y `{ CO: 'ok' }` son mapas de codigo de
 * dominio a estado del framework, no mapas de etiquetas, y sin esta lista la regla mapa-codigo los
 * marcaba a los doce. Se lee de uikit.js en vez de escribirse aca para que un estado nuevo entre
 * solo; si el objeto cambia de forma queda la lista de respaldo y el informe lo dice.
 */
function runtimeVocabulary() {
  const file = path.join(MODULE, 'web', 'com.etendoerp.uikit', 'js', 'uikit.js');
  const fallback = new Set(['ok', 'risk', 'bad', 'flat', 'neutral']);
  if (!exists(file)) return { set: fallback, from: 'lista de respaldo (no se encontro uikit.js)' };
  const m = /var\s+STATES\s*=\s*\{([^}]*)\}/.exec(read(file));
  if (!m) return { set: fallback, from: 'lista de respaldo (uikit.js no declara var STATES)' };
  const found = new Set();
  for (const pair of m[1].matchAll(/([A-Za-z_$][\w$]*)\s*:\s*'([^']*)'/g)) {
    found.add(pair[1]);
    found.add(pair[2]);
  }
  if (found.size === 0) return { set: fallback, from: 'lista de respaldo (STATES vacio)' };
  return { set: found, from: 'uikit.js var STATES' };
}
const VOCAB = runtimeVocabulary();

const letters = (s) => (s.match(RE_LETTER) || []).length;

/** Palabras separadas por espacio, de las cuales al menos dos tienen letras. */
function isPhrase(s) {
  const words = s.trim().split(/\s+/).filter((w) => RE_LETTER.test(w) || /[a-zA-Z]/.test(w));
  return words.filter((w) => letters(w) >= 1).length >= 2;
}

/*
 * Una lista de clases CSS, no una frase.
 *
 * La primera version de esta regla decia "todos los tokens tienen forma de clase Y hay mas de un
 * token", y con eso se tragaba "en riesgo", "fuera de ritmo" y "brecha de score" -- tres etiquetas
 * de pantalla del OKR -- porque dos palabras minusculas sueltas tienen exactamente la misma forma
 * que dos clases. El discriminante real es el guion: en este arbol toda clase lo lleva (uik-card,
 * okr-agenda-item, p360-on, is-open), y ninguna etiqueta castellana lo lleva.
 */
function looksLikeCssList(s) {
  const parts = s.trim().split(/\s+/);
  if (RE_SPANISH.test(s) || parts.length === 0) return false;
  return parts.every((p) => RE_CSS_TOKEN.test(p) && /[-_]/.test(p));
}

function looksLikeSelector(s) {
  if (/\s/.test(s.trim()) && !/^[.#\[a-z]/.test(s.trim())) return false;
  return /^[.#]/.test(s.trim()) || /^\[[a-z-]+[\]=]/.test(s.trim())
    || /^[a-z][\w-]*(?:[.#:\[][\w-]+)+/.test(s.trim());
}

/**
 * Por que se descarta este literal entrecomillado, o null si hay que mirarlo.
 * Primero contexto, despues forma: un `t('Hola mundo')` es una clave rarisima pero es una clave,
 * y una clase CSS con espacios sigue siendo una clase CSS.
 */
function ignoreQuoted(lit, ctx) {
  const v = lit.value;
  const t = v.trim();

  // --- contexto
  if (ctx.call && T_CALLS.test(ctx.call)) return { rule: 'clave-t', note: `argumento de ${ctx.call}()` };
  if (ctx.call && MACHINE_CALLS.has(ctx.call)) return { rule: 'api-maquina', note: `argumento de ${ctx.call}()` };
  if (ctx.call && /^console\./.test(ctx.call)) return { rule: 'console', note: ctx.call };
  if (ctx.isKey) return { rule: 'clave-objeto', note: 'ocupa el lugar de la clave' };
  if (ctx.cssTarget) return { rule: 'css', note: 'se asigna a className o a style' };

  // --- forma
  if (t === '') return { rule: 'vacio' };
  if (t.length < 2) return { rule: 'un-caracter' };
  if (letters(t) < 2) return { rule: 'sin-letras', note: 'puntuacion, numero o mascara de formato' };
  if (/^use (strict|asm)$/.test(t)) return { rule: 'directiva' };
  if (RE_UUID.test(t)) return { rule: 'uuid' };
  if (RE_INTERNAL_TAG.test(t)) return { rule: 'marca-interna', note: 'resultado de Object.prototype.toString' };
  if (VOCAB.set.has(t)) return { rule: 'vocabulario-runtime', note: `estado del framework (${VOCAB.from})` };
  if (RE_AD_KEY.test(t)) return { rule: 'clave-ad', note: 'tiene forma de clave con prefijo de modulo' };
  if (RE_FQCN.test(t)) return { rule: 'fqcn', note: 'nombre de clase Java' };
  if ((t.match(SQL_WORDS) || []).length >= 2) return { rule: 'sql' };
  if (/^(?:data|aria)-[a-z][a-z0-9-]*$/.test(t)) return { rule: 'atributo' };
  if (HTML_TAGS.has(t)) return { rule: 'tag' };
  if (looksLikeSelector(t)) return { rule: 'selector' };
  if (looksLikeCssList(t)) return { rule: 'css' };
  if (/^[a-z][a-z0-9]*:\/\//i.test(t) || /^[./]{1,2}[\w./-]+$/.test(t)) return { rule: 'ruta' };
  return null;
}

/**
 * Por que este literal es texto de pantalla, o null.
 *
 * Tres senales, en orden de confianza:
 *   frase      dos o mas letras y un espacio entre palabras, o acentos/¿¡ castellanos
 *   propiedad  es el valor de una propiedad que solo puede llevar texto (label:, title:, ...)
 *   mapa       vive en un objeto cuyo nombre dice que es un mapa de etiquetas, o su clave es un
 *              codigo en mayusculas y su valor no lo es -- {HIGH: 'alta'}
 */
function flagQuoted(lit, ctx) {
  const t = lit.value.trim();
  if (RE_SPANISH.test(t)) return { rule: 'acentos', why: 'lleva acentos o signos castellanos' };
  if (isPhrase(t) && letters(t) >= 2) return { rule: 'frase', why: 'varias palabras con letras' };
  if (ctx.prop && DISPLAY_PROPS.has(ctx.prop)) {
    return { rule: 'propiedad', why: `valor de ${ctx.prop}:` };
  }
  /*
   * Concatenado dentro de un ${} de una plantilla: lo que sale de esa expresion se interpola en
   * el markup, asi que un pedacito de dos letras tambien es pantalla. Es la unica forma de ver
   * los conectores -- ' de ', ' pts', ' · peso ' -- que una regla de frase nunca va a alcanzar.
   */
  if (lit.inTemplateExpr && ctx.concat && letters(t) >= 2) {
    return { rule: 'pegado-a-markup', why: 'se concatena dentro de un ${} de una plantilla' };
  }
  if (ctx.holder && RE_LABEL_HOLDER.test(ctx.holder)) {
    return { rule: 'mapa-etiquetas', why: `vive en ${ctx.holder}` };
  }
  if (ctx.prop && /^[A-Z][A-Z0-9_]{1,}$/.test(ctx.prop) && t.toUpperCase() !== ctx.prop
    && !/^[A-Z0-9_]+$/.test(t) && letters(t) >= 3 && !/[-_.\/]/.test(t)) {
    return { rule: 'mapa-codigo', why: `${ctx.prop}: '${t}' -- codigo a la izquierda, palabra a la derecha` };
  }
  return null;
}

/* ============================================================ el markup */

/*
 * Los trozos estaticos de un template literal se pegan en una sola cadena, con \u0000 en el
 * lugar de cada ${}, y se recorren como HTML. Se hace asi y no trozo por trozo porque una
 * etiqueta o un nodo de texto cruza los limites: en `<em>${owner} · confianza ${nivel}</em>` el
 * " · confianza " es un trozo entero que solo se entiende sabiendo que veniamos de un nodo de
 * texto abierto.
 *
 * Un nodo de texto es la senal mas fuerte que hay: no hay que decidir si "parece" texto de
 * pantalla, esta literalmente en la pantalla.
 */
const HOLE = '\u0000';

function joinChunks(chunks) {
  let s = '';
  const lineAt = [];
  chunks.forEach((c, idx) => {
    if (idx > 0) { s += HOLE; lineAt.push(c.line); }
    let line = c.line;
    for (const ch of c.text) {
      s += ch;
      lineAt.push(line);
      if (ch === '\n') line += 1;
    }
  });
  return { s, lineAt };
}

function textRuns(joined, from, to) {
  const out = [];
  let start = from;
  for (let i = from; i <= to; i++) {
    if (i === to || joined[i] === HOLE) {
      if (i > start) out.push({ from: start, to: i });
      start = i + 1;
    }
  }
  return out;
}

const decode = (s) => s.replace(/&(?:nbsp|amp|lt|gt|quot|#\d+|#x[0-9a-fA-F]+|[a-z]+);/g, ' ');

/*
 * Un string entrecomillado que es un pedazo de markup concatenado a mano. uikit.js arma sus
 * instrumentos asi -- '<span class="uik-rail uik-' + estado + '" role="img" aria-label="' + ... --
 * y mirar esos pedazos como texto daba veintitres falsos positivos de un tiron: la primera version
 * de este gate marcaba cada fragmento por "tener dos palabras con letras".
 */
function isMarkupFragment(v) {
  return /<[a-zA-Z/!]/.test(v) || /=\s*["']/.test(v) || /^\s*["']?\s*>/.test(v);
}

/**
 * En que estado del parser HTML empieza un fragmento: 'TAG' si viene de una etiqueta abierta.
 * '" role="img" aria-label="' no es texto de pantalla, es la mitad de un <span>.
 */
function markupStart(v) {
  if (/^\s*["']?\s*>/.test(v)) return 'TAG';
  const tag = v.search(/<[a-zA-Z/!]/);
  const attr = v.search(/[A-Za-z_:][\w:.-]*\s*=\s*["']/);
  if (attr !== -1 && (tag === -1 || attr < tag)) return 'TAG';
  return 'TEXT';
}

/**
 * Recorre el markup y devuelve lo que sale por pantalla: nodos de texto y valores de atributo
 * visible. `initial` dice si se entra en medio de una etiqueta.
 *
 * Un nodo de texto es la senal mas fuerte que hay -- no hay que decidir si "parece" texto de
 * pantalla, esta literalmente en la pantalla -- y por eso es la unica regla de este archivo que
 * no mira la forma del string.
 */
function scanMarkup(chunks, initial) {
  const { s, lineAt } = joinChunks(chunks);
  const found = [];
  /*
   * La linea del primer caracter que no es espacio. Un nodo de texto arranca justo despues del
   * `}` que cierra la interpolacion anterior, asi que su primer caracter suele ser el salto de
   * linea de esa linea y no de la linea donde se lee el texto: sin esto, "· confianza" apuntaba
   * a un `)}` suelto y archivo:linea no llevaba a ninguna parte.
   */
  const lineOfRun = (from, to) => {
    let i = from;
    while (i < to && /\s/.test(s[i])) i += 1;
    return lineAt[i < to ? i : from];
  };
  const emitText = (from, to) => {
    if (from < 0) return;
    for (const run of textRuns(s, from, to)) {
      found.push({ kind: 'texto', text: s.slice(run.from, run.to), line: lineOfRun(run.from, run.to) });
    }
  };
  if (!initial && !/<[a-zA-Z/!]/.test(s)) {
    // No es markup: un template usado como texto plano. Se mira con las reglas de un string.
    for (const run of textRuns(s, 0, s.length)) {
      found.push({ kind: 'plano', text: s.slice(run.from, run.to), line: lineAt[run.from] ?? chunks[0]?.line });
    }
    return found;
  }
  let state = initial || 'TEXT';
  let i = 0;
  let textStart = state === 'TEXT' ? 0 : -1;
  while (i < s.length) {
    if (state === 'TEXT') {
      if (s[i] === '<' && /[a-zA-Z/!]/.test(s[i + 1] || '')) {
        emitText(textStart, i);
        textStart = -1;
        state = 'TAG';
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (s[i] === '>') {
      state = 'TEXT';
      i += 1;
      textStart = i;
      continue;
    }
    const attr = /^([A-Za-z_:][\w:.-]*)\s*=\s*(["'])/.exec(s.slice(i));
    if (attr) {
      const quote = attr[2];
      const valFrom = i + attr[0].length;
      let valTo = valFrom;
      while (valTo < s.length && s[valTo] !== quote) valTo += 1;
      if (DISPLAY_ATTRS.has(attr[1].toLowerCase())) {
        for (const run of textRuns(s, valFrom, valTo)) {
          found.push({
            kind: `@${attr[1].toLowerCase()}`,
            text: s.slice(run.from, run.to),
            line: lineOfRun(run.from, run.to)
          });
        }
      }
      i = Math.min(valTo + 1, s.length);
      continue;
    }
    i += 1;
  }
  if (state === 'TEXT') emitText(textStart, s.length);
  return found;
}

/* ============================================================ un archivo */

function analyze(file) {
  const text = read(file);
  const { strings, templates } = tokenize(text);
  const findings = [];   // alta confianza: cuentan y son lo que --strict mira
  const suspects = [];   // baja confianza: se listan aparte y no cuentan
  const ignored = [];
  const keys = new Set();

  /* Un pedazo de markup ya parseado -> hallazgo, descarte o sospecha. */
  const judgeMarkup = (piece, origin) => {
    const t = decode(piece.text).trim();
    if (t === '' || letters(t) < 2) return;
    if (piece.kind === 'texto') {
      findings.push({ line: piece.line, text: t, kind: `nodo-texto/${origin}`, rule: 'nodo-texto',
        why: 'texto suelto entre etiquetas: ya esta en la pantalla' });
      return;
    }
    if (RE_AD_KEY.test(t)) { ignored.push({ line: piece.line, text: t, rule: 'clave-ad' }); return; }
    if (VOCAB.set.has(t)) { ignored.push({ line: piece.line, text: t, rule: 'vocabulario-runtime' }); return; }
    if (piece.kind === '@value' && !isPhrase(t) && !RE_SPANISH.test(t)) {
      ignored.push({ line: piece.line, text: t, rule: 'atributo-valor',
        note: 'value= sin forma de frase: casi siempre un codigo de dominio' });
      return;
    }
    findings.push({ line: piece.line, text: t, kind: piece.kind, rule: 'atributo-visible',
      why: `valor de ${piece.kind.slice(1)}=, lo lee el lector de pantalla` });
  };

  for (const lit of strings) {
    const ctx = {
      call: enclosingCall(lit.before),
      prop: ownerProperty(lit.before),
      holder: enclosingAssignment(lit.before),
      isKey: isPropertyKey(text, lit),
      cssTarget: isCssTarget(lit.before),
      concat: /\+$/.test(trimCode(lit.before)) || /^\s*\+/.test(text.slice(lit.after, lit.after + 8))
    };
    if (ctx.call && T_CALLS.test(ctx.call) && /^[A-Za-z_][\w.]*$/.test(lit.value.trim())) {
      keys.add(lit.value.trim());
    }
    const skipped = ignoreQuoted(lit, ctx);
    if (skipped) {
      ignored.push({ line: lit.line, text: lit.value, ...skipped });
      continue;
    }
    // Fragmento de markup concatenado: se parsea, no se mira como frase.
    if (isMarkupFragment(lit.value)) {
      ignored.push({ line: lit.line, text: lit.value, rule: 'fragmento-markup',
        note: 'pedazo de etiqueta concatenado; se parsea su contenido' });
      for (const piece of scanMarkup([{ text: lit.value, line: lit.line }], markupStart(lit.value))) {
        judgeMarkup(piece, 'string');
      }
      continue;
    }
    const hit = flagQuoted(lit, ctx);
    if (!hit) {
      if (ctx.prop && AMBIGUOUS_PROPS.has(ctx.prop) && letters(lit.value) >= 3) {
        suspects.push({ line: lit.line, text: lit.value, rule: 'propiedad-ambigua',
          why: `valor de ${ctx.prop}:, que aca lleva tanto etiquetas como ids` });
        continue;
      }
      ignored.push({ line: lit.line, text: lit.value, rule: 'palabra-suelta',
        note: 'una sola palabra, sin acentos y sin contexto de pantalla' });
      continue;
    }
    /*
     * Un mensaje de excepcion suele ser texto para el que programa -- salvo en este runtime, donde
     * uikFail pinta esc(err.message) en la region de error y el comentario de envelopeError dice
     * "the message is written for a user, so it is safe to render". O sea que aca casi todos SI
     * los lee un usuario. No se decide por adivinanza: van al balde de sospechas, que se lista
     * aparte, no suma al total y no rompe --strict, y el informe dice cuantos eran de verdad.
     */
    if (ctx.call && ERROR_CALLS.has(ctx.call.split('.').pop())) {
      suspects.push({ line: lit.line, text: lit.value, rule: 'mensaje-error',
        why: `argumento de ${ctx.call}(): mensaje de excepcion` });
      continue;
    }
    findings.push({ line: lit.line, text: lit.value, kind: 'string', rule: hit.rule, why: hit.why });
  }

  for (const tmpl of templates) {
    for (const piece of scanMarkup(tmpl.chunks, null)) {
      if (piece.kind !== 'plano') { judgeMarkup(piece, 'template'); continue; }
      const t = decode(piece.text).trim();
      if (t === '' || letters(t) < 2) continue;
      const fake = { value: piece.text, line: piece.line, before: tmpl.before, after: 0 };
      const ctx = {
        call: enclosingCall(tmpl.before),
        prop: ownerProperty(tmpl.before),
        holder: enclosingAssignment(tmpl.before),
        isKey: false,
        cssTarget: isCssTarget(tmpl.before)
      };
      const skipped = ignoreQuoted(fake, ctx);
      if (skipped) { ignored.push({ line: piece.line, text: piece.text, ...skipped }); continue; }
      const hit = flagQuoted(fake, ctx);
      if (hit) findings.push({ line: piece.line, text: piece.text, kind: 'template', rule: hit.rule, why: hit.why });
      else ignored.push({ line: piece.line, text: piece.text, rule: 'palabra-suelta' });
    }
  }

  const byLine = (a, b) => a.line - b.line || String(a.text).localeCompare(String(b.text));
  findings.sort(byLine);
  suspects.sort(byLine);
  ignored.sort(byLine);
  return { file, lines: text.split('\n').length, findings, suspects, ignored, keys: [...keys].sort() };
}

/* ============================================================ descubrimiento */

function manifests() {
  const out = [];
  for (const mod of fs.readdirSync(MODULES).sort()) {
    const dir = path.join(MODULES, mod);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const entry of fs.readdirSync(dir).sort()) {
      if (/^[a-z0-9][a-z0-9-]*\.view\.json$/.test(entry)) out.push(path.join(dir, entry));
    }
  }
  return out;
}

function walkJs(dir) {
  if (!exists(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkJs(full));
    else if (full.endsWith('.js')) out.push(full);
  }
  return out;
}

function discover() {
  const declared = new Map(); // file -> [views]
  const broken = [];
  for (const file of manifests()) {
    let m;
    try {
      m = JSON.parse(read(file));
    } catch (e) {
      broken.push(`${rel(file)}: ${e.message.split('\n')[0]}`);
      continue;
    }
    const view = m.view || path.basename(file, '.view.json');
    for (const part of Array.isArray(m.bundle) ? m.bundle : []) {
      if (part && part.type === 'js' && typeof part.path === 'string') {
        const full = path.join(MODULES, part.path);
        if (!exists(full)) { broken.push(`${rel(file)}: declara ${part.path}, que no existe`); continue; }
        if (!declared.has(full)) declared.set(full, []);
        declared.get(full).push(view);
      }
    }
  }
  // Un .js bajo web/ de un modulo uikit* que ningun manifest declara: no se audita, se avisa.
  const shipped = fs.readdirSync(MODULES, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^com\.etendoerp\.uikit(\.|$)/.test(e.name))
    .flatMap((e) => walkJs(path.join(MODULES, e.name, 'web')));
  const orphans = shipped.filter((f) => !declared.has(f)).sort();
  return { declared, broken, orphans, manifestCount: manifests().length };
}

/* ============================================================ informe */

const clip = (s, n) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length <= n ? one : `${one.slice(0, n - 1)}…`;
};

function main() {
  const { declared, broken, orphans, manifestCount } = discover();
  let files = [...declared.keys()].sort();
  if (WITH_ORPHANS) files = [...files, ...orphans].sort();
  if (ONLY) {
    const target = path.isAbsolute(ONLY) ? ONLY : path.resolve(MODULES, ONLY);
    files = files.filter((f) => f === target);
    if (!files.length) {
      if (!exists(target)) {
        console.error(`check-literals: ${ONLY} no existe`);
        process.exitCode = 1;
        return;
      }
      files = [target];
    }
  }

  const reports = files.map(analyze);

  if (AS_JSON) {
    console.log(JSON.stringify({ manifestCount, broken, orphans: orphans.map(rel), reports: reports.map((r) => ({ ...r, file: rel(r.file) })) }, null, 2));
    return;
  }

  console.log(`  ${manifestCount} manifest(s) en modules/*/*.view.json, ${files.length} bundle(s) js `
    + `auditado(s)${WITH_ORPHANS && orphans.length ? ` (${orphans.length} sin manifest, incluido por --orphans)` : ''}`);
  for (const b of broken) console.log(`  warn  manifest       ${b}`);
  for (const o of orphans) {
    console.log(`  warn  sin-manifest   ${rel(o)}: ningun manifest lo declara`
      + (WITH_ORPHANS ? ', se audita por --orphans' : '; --orphans para auditarlo igual'));
  }
  console.log('');

  // --- detalle por archivo
  for (const r of reports) {
    const mark = r.findings.length === 0 ? 'ok  ' : 'HALL';
    console.log(`  ${mark}  ${rel(r.file)}`);
    console.log(`        ${r.lines} lineas, ${r.keys.length} clave(s) t() distinta(s), `
      + `${r.findings.length} hallazgo(s)${r.suspects.length ? `, ${r.suspects.length} sospecha(s)` : ''}`);
    const show = ALL ? r.findings : r.findings.slice(0, CAP);
    for (const f of show) {
      console.log(`        ${rel(r.file)}:${f.line}  [${f.rule}] ${clip(f.text, 68)}`);
    }
    if (show.length < r.findings.length) {
      console.log(`        … ${r.findings.length - show.length} mas (--all para verlos)`);
    }
    for (const f of r.suspects) {
      console.log(`        ${rel(r.file)}:${f.line}  [?${f.rule}] ${clip(f.text, 66)}`);
    }
    if (SHOW_IGNORED) {
      const byRule = new Map();
      for (const g of r.ignored) byRule.set(g.rule, (byRule.get(g.rule) || 0) + 1);
      console.log(`        descartados: ${[...byRule].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join(' ')}`);
      for (const g of r.ignored) console.log(`          - ${rel(r.file)}:${g.line}  [${g.rule}] ${clip(g.text, 60)}`);
    }
    console.log('');
  }

  // --- tabla resumen
  const nameW = Math.max(...reports.map((r) => path.basename(r.file).length), 8);
  console.log(`  ${'archivo'.padEnd(nameW)}  lineas  claves t()  hallazgos  sospechas  reglas`);
  console.log(`  ${'-'.repeat(nameW)}  ------  ----------  ---------  ---------  ------`);
  let totalFindings = 0;
  let totalSuspects = 0;
  let totalKeys = 0;
  for (const r of reports) {
    totalFindings += r.findings.length;
    totalSuspects += r.suspects.length;
    totalKeys += r.keys.length;
    const byRule = new Map();
    for (const f of r.findings) byRule.set(f.rule, (byRule.get(f.rule) || 0) + 1);
    const rules = [...byRule].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join(' ') || '-';
    console.log(`  ${path.basename(r.file).padEnd(nameW)}  ${String(r.lines).padStart(6)}  `
      + `${String(r.keys.length).padStart(10)}  ${String(r.findings.length).padStart(9)}  `
      + `${String(r.suspects.length).padStart(9)}  ${rules}`);
  }
  const dirty = reports.filter((r) => r.findings.length > 0);
  console.log('');
  console.log(`  ${totalFindings} hallazgo(s) en ${dirty.length}/${reports.length} archivo(s), `
    + `${totalSuspects} sospecha(s) sin contar; ${totalKeys} clave(s) t() en total`);
  console.log(`  vocabulario de estados leido de ${VOCAB.from}: ${[...VOCAB.set].sort().join(' ')}`);
  if (dirty.length) {
    console.log(`  a internacionalizar: ${dirty.map((r) => `${path.basename(r.file)} (${r.findings.length})`).join(', ')}`);
  }
  console.log(`  modo ${STRICT ? 'strict: sale 1 si hay hallazgos' : 'informe: sale 0 siempre (--strict para lo otro)'}`);
  /*
   * exitCode y no exit(): process.exit() mata el proceso antes de que stdout termine de
   * escribirse cuando la salida esta en un pipe, y --json se truncaba a los 64 KB.
   */
  process.exitCode = STRICT && totalFindings ? 1 : 0;
}

main();
