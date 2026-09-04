/*
 * com.etendoerp.uikit runtime.
 *
 * One job: let a module own a rectangle of the DOM inside an Etendo Classic tab, and render it
 * from state with plain strings, without learning SmartClient. Everything here is in service of
 * OB.UIKit.defineView; the rest of the surface exists because defineView needs it.
 *
 * There are two doors into the server and no third one. Reads go through datasource() + fetch(),
 * which GET an action handler. Writes go through defineAction() and are reached only from
 * ctx.run(), which is where the CSRF token is attached and where the double click is stopped.
 *
 * The contract this file implements is documented in docs/ -- L0 for the shape, L2 for the API,
 * L3 for the guides. If they disagree, gate G8 fails the build, so change both or neither.
 */
(function () {
  'use strict';

  if (typeof OB === 'undefined') {
    window.OB = {};
  }
  if (OB.UIKit) {
    return;
  }

  var VERSION = '0.3.0';
  var DATASOURCES = {};
  var ACTIONS = {};
  var LABELS = {};
  var STYLES = {};

  /* ------------------------------------------------------------------ text */

  var ENTITIES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  };

  /**
   * Escapes a value for HTML text or a quoted attribute. Null and undefined become the empty
   * string, so a missing field renders as nothing instead of the word "undefined".
   *
   * @param {*} value
   * @returns {string}
   */
  function esc(value) {
    if (value === null || value === undefined) {
      return '';
    }
    return String(value).replace(/[&<>"']/g, function (c) {
      return ENTITIES[c];
    });
  }

  /**
   * Marks a string as already-safe HTML, so html`` will not escape it again.
   *
   * @param {string} html
   */
  function Raw(html) {
    this.html = html;
  }

  // So a Raw can be concatenated or assigned to innerHTML without unwrapping it by hand.
  Raw.prototype.toString = function () {
    return this.html;
  };

  /**
   * Wraps already-safe HTML. Idempotent, so passing a Raw through it is free and safe.
   *
   * @param {string|Raw} html
   * @returns {Raw}
   */
  function raw(html) {
    return html instanceof Raw ? html : new Raw(html);
  }

  /**
   * Tagged template that escapes every interpolation. Arrays are joined with no separator, so
   * `html`<ul>${items.map(li)}</ul>`` works, and a raw() value passes through untouched.
   *
   * Returns a Raw, which is what makes composition work: the result of one html`` interpolated
   * into another is already-safe HTML and must not be escaped a second time. Do not `.join('')`
   * a list of results -- that flattens them back to a plain string, which the next html`` will
   * escape; interpolate the array itself instead.
   *
   * @param {string[]} strings
   * @param {...*} values
   * @returns {Raw}
   */
  function html(strings) {
    var out = strings[0];
    for (var i = 1; i < arguments.length; i++) {
      out += interpolate(arguments[i]) + strings[i];
    }
    return new Raw(out);
  }

  function interpolate(value) {
    if (value instanceof Raw) {
      return value.html;
    }
    if (Array.isArray(value)) {
      return value.map(interpolate).join('');
    }
    return esc(value);
  }

  /* ---------------------------------------------------------------- labels */

  /**
   * Registers translated strings. Values come from AD_MESSAGE, never from source.
   *
   * @param {Object<string, string>} map
   * @returns {void}
   */
  function labels(map) {
    Object.keys(map).forEach(function (k) {
      LABELS[k] = map[k];
    });
  }

  /**
   * The label for a key, or the key itself, which makes a missing AD_MESSAGE visible on screen.
   *
   * @param {string} key
   * @returns {string}
   */
  function t(key) {
    return LABELS[key] === undefined ? key : LABELS[key];
  }

  /*
   * Interpolates one AD_MESSAGE label: every %{name} in the msgtext is replaced by vars.name.
   *
   * Private on purpose. It returns null -- not the key -- when the row is missing, because the
   * only strings the runtime itself labels are aria-labels, and an aria-label reading
   * "ETUIK_RailAria" is worse for a screen-reader user than the bare numbers. Every caller
   * therefore carries a numeric fallback, and the window keeps working in an instance where the
   * two ETUIK_ rows have not been inserted yet.
   */
  function fill(key, vars) {
    if (LABELS[key] === undefined) {
      return null;
    }
    var text = String(LABELS[key]);
    if (!vars) {
      return text;
    }
    return text.replace(/%\{([A-Za-z_]\w*)\}/g, function (whole, name) {
      return vars[name] === undefined ? whole : String(vars[name]);
    });
  }

  /* ----------------------------------------------------------- datasources */

  /**
   * Maps a logical datasource name to the action handler that answers it. Handlers are reached by
   * fully qualified class name; KernelServlet needs no AD row to publish one.
   *
   * @param {string} name
   * @param {{ action: string }} spec  action is the handler's fully qualified class name
   * @returns {void}
   */
  function datasource(name, spec) {
    DATASOURCES[name] = spec;
  }

  /**
   * GETs one datasource. The callback receives (error, data): exactly one of the two is set, and
   * a server-side error arrives as an Error rather than as data the caller might render.
   *
   * @param {string} name
   * @param {Object<string, *>} params
   * @param {function(Error|null, Object=): void} callback
   * @returns {void}
   */
  function fetch(name, params, callback) {
    var spec = DATASOURCES[name];
    if (!spec) {
      callback(new Error('unknown datasource ' + name));
      return;
    }
    OB.RemoteCallManager.call(
      spec.action,
      null,
      params || {},
      function (response, data) {
        if (!data) {
          callback(new Error('empty response from ' + name));
        } else if (data.error) {
          callback(new Error(data.error.message || String(data.error)));
        } else {
          callback(null, data);
        }
      },
      null,
      function () {
        callback(new Error('request to ' + name + ' failed'));
      }
    );
  }

  /* ---------------------------------------------------------------- styles */

  /**
   * Injects a stylesheet once per key, so a redraw or a second tab cannot duplicate it.
   *
   * @param {string} key
   * @param {string} css
   * @returns {void}
   */
  function style(key, css) {
    if (STYLES[key]) {
      return;
    }
    var el = document.createElement('style');
    el.setAttribute('data-uikit-style', key);
    el.textContent = css;
    document.head.appendChild(el);
    STYLES[key] = true;
  }

  /* ------------------------------------------------------------ formatting */

  /*
   * The default masks, copied from the *Inform / *Relation entries of config/Format.xml, which is
   * where this instance's real masks live. They are defaults, not a guess at the user's locale:
   * OB.Format is generated at runtime by an AD template and is not in the source tree, so the only
   * keys of it read here are the three core itself reads by name -- date, dateTime and
   * defaultGroupingSize. Anything else a caller needs is passed through opts.
   */
  var FMT_MASKS = {
    number: '#,##0.00',
    int: '#,##0',
    qty: '#,##0.###',
    price: '#,##0.00',
    amount: '#,##0.00',
    pct: '#,##0.0'
  };

  /**
   * Formats one value the way the rest of Etendo formats it, and never throws.
   *
   * Delegates to OB.Utilities.Number.JSToOBMasked and OB.Utilities.Date.JSToOB, so a number here
   * reads exactly like the same number in a standard grid. `pct` expects percentage points, not a
   * fraction: 62.5 renders as "62.5%", which is what rail() and every pace calculation produce.
   *
   * There is no session currency in the client, so this function never invents one: pass
   * opts.currency with the symbol or ISO code the datasource returned, next to the amount it
   * belongs to. An amount without its currency is a number, not money.
   *
   * Returns a plain string, not a Raw: the caller decides whether to escape it. When OB.Format is
   * absent -- an early page, a test harness, a stripped instance -- it degrades to String(value)
   * rather than failing, because a screen showing raw numbers is still a working screen.
   *
   * @param {*} value  a number, or an ISO date string, or a Date
   * @param {'number'|'int'|'qty'|'price'|'amount'|'pct'|'date'|'dateTime'} kind
   * @param {Object} [opts]  currency, and mask / dec / group to override the defaults
   * @returns {string}
   */
  function fmt(value, kind, opts) {
    var o = opts || {};
    if (value === null || value === undefined || value === '') {
      return '';
    }
    try {
      if (kind === 'date' || kind === 'dateTime') {
        return fmtDate(value, kind, o);
      }
      return fmtNumber(value, kind, o);
    } catch (e) {
      return String(value);
    }
  }

  function fmtNumber(value, kind, o) {
    var n = typeof value === 'number' ? value : Number(value);
    if (!isFinite(n)) {
      return String(value);
    }
    var mask = o.mask || FMT_MASKS[kind];
    var lib = OB.Utilities && OB.Utilities.Number;
    var out;
    if (!mask || !OB.Format || !lib || typeof lib.JSToOBMasked !== 'function') {
      out = String(n);
    } else {
      // application-js.ftl publishes the session's own separators next to the masks; reading them
      // is what makes a uikit number identical to the same number in a standard grid.
      var dec = o.dec === undefined ? OB.Format.defaultDecimalSymbol : o.dec;
      var group = o.group === undefined ? OB.Format.defaultGroupingSymbol : o.group;
      out = String(
        lib.JSToOBMasked(
          n,
          mask,
          dec === undefined || dec === null ? '.' : dec,
          group === undefined || group === null ? ',' : group,
          OB.Format.defaultGroupingSize || 3
        )
      );
    }
    if (kind === 'pct') {
      return out + '%';
    }
    return o.currency ? out + ' ' + o.currency : out;
  }

  function fmtDate(value, kind, o) {
    var d = toDate(value);
    var lib = OB.Utilities && OB.Utilities.Date;
    var pattern = o.mask;
    if (!pattern && OB.Format) {
      pattern = kind === 'dateTime' ? OB.Format.dateTime : OB.Format.date;
    }
    if (!d || !pattern || !lib || typeof lib.JSToOB !== 'function') {
      return String(value);
    }
    var out = lib.JSToOB(d, pattern);
    return out === null || out === undefined ? String(value) : String(out);
  }

  /*
   * Builds a Date from what UikQuery.date actually emits: yyyy-MM-dd, optionally with a time.
   * The parts are fed to the local-time constructor rather than to Date.parse, which reads a bare
   * yyyy-MM-dd as UTC and so moves a business date by a day for anyone west of Greenwich.
   */
  function toDate(value) {
    if (Object.prototype.toString.call(value) === '[object Date]') {
      return isFinite(value.getTime()) ? value : null;
    }
    var m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(value));
    if (!m) {
      return null;
    }
    return new Date(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4] || 0),
      Number(m[5] || 0),
      Number(m[6] || 0)
    );
  }

  /* ------------------------------------------------------------ navigation */

  /**
   * Opens the standard window that owns a record, on the tab that shows it.
   *
   * A wrapper over OB.Utilities.openDirectTab, which resolves the window from the tab server-side,
   * so a caller passes a tab id and a record id and nothing else. The tab id must come from SQL --
   * UikQuery.tabFor -- never from a constant in JavaScript: c_order in this instance has six
   * header tabs, and the wrong one opens "Return to vendor" for a sales order.
   *
   * Warns and returns when there is nothing to navigate with, instead of throwing: this is called
   * from a click handler, and an exception there kills the handler for every later click too. A
   * drill-down that does nothing is a smaller failure than a dead window.
   *
   * @param {string} tabId  an AD_TAB id, resolved server-side
   * @param {string} [recordId]  the record to open; without it the tab opens in grid mode
   * @returns {void}
   */
  function nav(tabId, recordId) {
    if (!tabId) {
      console.warn('OB.UIKit.nav: no tab id; nothing to open');
      return;
    }
    if (!OB.Utilities || typeof OB.Utilities.openDirectTab !== 'function') {
      console.warn('OB.UIKit.nav: OB.Utilities.openDirectTab is unavailable; not opening ' + tabId);
      return;
    }
    try {
      OB.Utilities.openDirectTab(tabId, recordId);
    } catch (e) {
      console.warn('OB.UIKit.nav: openDirectTab failed for ' + tabId + ': ' + e.message);
    }
  }

  /* ---------------------------------------------------------------- timing */

  /**
   * Trailing-edge debounce: the wrapped function runs `ms` after the last call, never on the
   * first. The returned function carries a .cancel() that drops a pending run, which is what a
   * view's destroy hook needs so a timer cannot fire into a DOM that is already gone.
   *
   * Trailing rather than leading because the caller is a search box: the useful moment is when
   * typing stops, and a leading edge would fire a request for the first letter every time.
   *
   * @param {Function} fn  the function to defer
   * @param {number} [ms]  the quiet period; 200 by default
   * @returns {Function}
   */
  function debounce(fn, ms) {
    var wait = ms === undefined ? 200 : ms;
    var timer = null;
    var wrapped = function () {
      var args = arguments;
      var self = this;
      if (timer !== null) {
        clearTimeout(timer);
      }
      timer = setTimeout(function () {
        timer = null;
        fn.apply(self, args);
      }, wait);
    };
    wrapped.cancel = function () {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    return wrapped;
  }

  /* ------------------------------------------------------------ components */

  var STATES = { ok: 'ok', risk: 'risk', bad: 'bad', flat: 'flat' };

  /**
   * A small state pill. An unknown state degrades to the neutral one rather than throwing.
   *
   * @param {*} text
   * @param {'ok'|'risk'|'bad'|'flat'} state
   * @returns {Raw}
   */
  function badge(text, state) {
    return raw(
      '<span class="uik-badge uik-' + (STATES[state] || 'flat') + '">' + esc(text) + '</span>'
    );
  }

  /**
   * The pace rail: fill at `progress`, tick at `expected`, colour from the distance between them.
   * Not a progress bar -- a bar at 62% tells the reader nothing until they know what day it is.
   *
   * @param {number} progress  0-100, clamped
   * @param {number} expected  0-100, clamped; where the tick goes
   * @param {'ok'|'risk'|'bad'|'flat'} state
   * @returns {Raw}
   */
  function rail(progress, expected, state) {
    var p = clamp(progress, 0, 100);
    var e = clamp(expected, 0, 100);
    var aria = fill('ETUIK_RailAria', { progress: Math.round(p), expected: Math.round(e) });
    return raw(
      '<span class="uik-rail uik-' +
      (STATES[state] || 'flat') +
      '" style="--uik-p:' +
      p.toFixed(1) +
      '%;--uik-e:' +
      e.toFixed(1) +
      '%" role="img" aria-label="' +
      esc(aria === null ? Math.round(p) + '% / ' + Math.round(e) + '%' : aria) +
      '"></span>'
    );
  }

  /**
   * The score meter: ten cells for a 0.00-1.00 score, filled to `score`, with the cell holding
   * `target` outlined. Answers "will the commitment be met" without comparing two numbers.
   *
   * @param {number} score   0.00-1.00, clamped
   * @param {number} target  0.00-1.00, clamped; the outlined cell
   * @returns {Raw}
   */
  function meter(score, target) {
    var filled = Math.round(clamp(score, 0, 1) * 10);
    var mark = Math.max(1, Math.min(10, Math.ceil(clamp(target, 0, 1) * 10)));
    var shown = Number(score).toFixed(2);
    var goal = Number(target).toFixed(2);
    var aria = fill('ETUIK_MeterAria', { score: shown, target: goal });
    var cells = '';
    for (var i = 1; i <= 10; i++) {
      cells +=
        '<i class="' + (i <= filled ? 'on' : '') + (i === mark ? ' tg' : '') + '"></i>';
    }
    return raw(
      '<span class="uik-meter" role="img" aria-label="' +
      esc(aria === null ? shown + ' / ' + goal : aria) +
      '">' +
      cells +
      '</span>'
    );
  }

  /**
   * A horizontal bar chart, in HTML and CSS rather than SVG.
   *
   * SVG was rejected here deliberately. A cockpit's bar labels are real text -- a bucket name, a
   * count, a document reference -- and text inside an svg element has to be either a foreignObject
   * or hand-measured, so it cannot wrap and cannot be selected or copied. rail() already proves
   * that a bar driven by one custom property is enough, and this is the same trick applied to a
   * list: each bar carries --uik-v and paints its own fill behind ordinary, selectable text.
   *
   * The scale is shared by every bar, so the lengths are comparable: `max` when given, otherwise
   * the largest absolute value in the list. Negative values are drawn at their absolute length and
   * marked data-negative, which is what a month-over-month series needs.
   *
   * @param {Object} spec
   * @param {Object[]} spec.items  one object per bar: label, value, and optionally state and sub
   * @param {number} [spec.max]  the shared scale; the largest absolute value by default
   * @param {Function} [spec.format]  (value) => string for the printed number; String by default
   * @param {string} [spec.label]  an aria-label, which also turns the list into a labelled group
   * @returns {Raw}
   */
  function bars(spec) {
    var items = spec && spec.items ? spec.items : [];
    var show = spec && typeof spec.format === 'function' ? spec.format : String;
    var top = spec && spec.max ? Math.abs(spec.max) : 0;
    items.forEach(function (item) {
      var v = Math.abs(Number(item.value));
      if (isFinite(v) && v > top) {
        top = v;
      }
    });
    var rows = items.map(function (item) {
      var v = Number(item.value);
      var size = !isFinite(v) || top === 0 ? 0 : (Math.abs(v) / top) * 100;
      return (
        '<div class="uik-bar uik-' +
        (STATES[item.state] || 'flat') +
        '"' +
        (v < 0 ? ' data-negative="1"' : '') +
        ' style="--uik-v:' +
        size.toFixed(1) +
        '%"><span class="uik-bar-label">' +
        esc(item.label) +
        (item.sub === undefined || item.sub === null ? '' : '<em>' + esc(item.sub) + '</em>') +
        '</span><span class="uik-bar-value">' +
        esc(show(item.value)) +
        '</span></div>'
      );
    });
    var group = spec && spec.label ? ' role="group" aria-label="' + esc(spec.label) + '"' : '';
    return raw('<div class="uik-bars"' + group + '>' + rows.join('') + '</div>');
  }

  /**
   * A sparkline: one polyline over a series, no axes, no labels, no numbers.
   *
   * SVG here, unlike bars(), because a sparkline is pure geometry -- there is no text in it at
   * all, which is the one case SVG is unambiguously better at than CSS. The shape carries no
   * value a reader can read off it, so it is decorative by default: without `label` it is
   * aria-hidden, and the number it accompanies is what a screen reader announces. Pass `label`
   * only when the trend itself is the information.
   *
   * A single point, or a series where every value is equal, draws a flat line at mid height
   * instead of dividing by a zero range.
   *
   * @param {Object} spec
   * @param {number[]} spec.values  the series, oldest first; non-finite entries are dropped
   * @param {number} [spec.width]  120 by default
   * @param {number} [spec.height]  28 by default
   * @param {'ok'|'risk'|'bad'|'flat'} [spec.state]  the stroke colour
   * @param {boolean} [spec.area]  fill the area under the line
   * @param {string} [spec.label]  an aria-label; without it the graphic is hidden from a reader
   * @returns {Raw}
   */
  function spark(spec) {
    var series = spec && spec.values ? spec.values : [];
    var vals = [];
    series.forEach(function (v) {
      var n = Number(v);
      if (isFinite(n)) {
        vals.push(n);
      }
    });
    var w = spec && spec.width ? spec.width : 120;
    var h = spec && spec.height ? spec.height : 28;
    var pad = 1.5;
    var open =
      '<svg class="uik-spark uik-' +
      (STATES[spec && spec.state] || 'flat') +
      '" viewBox="0 0 ' +
      w +
      ' ' +
      h +
      '" width="' +
      w +
      '" height="' +
      h +
      '" focusable="false" ' +
      (spec && spec.label
        ? 'role="img" aria-label="' + esc(spec.label) + '"'
        : 'role="presentation" aria-hidden="true"') +
      '>';
    if (vals.length === 0) {
      return raw(open + '</svg>');
    }
    var lo = Math.min.apply(null, vals);
    var hi = Math.max.apply(null, vals);
    var span = hi - lo;
    var usable = h - pad * 2;
    var points = vals.map(function (v, i) {
      var x = vals.length === 1 ? 0 : (i / (vals.length - 1)) * w;
      var y = span === 0 ? h / 2 : h - pad - ((v - lo) / span) * usable;
      return x.toFixed(2) + ',' + y.toFixed(2);
    });
    if (vals.length === 1) {
      points.push(w.toFixed(2) + ',' + (h / 2).toFixed(2));
    }
    var line = points.join(' ');
    var body = '';
    if (spec && spec.area) {
      body +=
        '<polygon class="uik-spark-area" points="0,' +
        h.toFixed(2) +
        ' ' +
        line +
        ' ' +
        w.toFixed(2) +
        ',' +
        h.toFixed(2) +
        '"></polygon>';
    }
    body += '<polyline class="uik-spark-line" points="' + line + '"></polyline>';
    return raw(open + body + '</svg>');
  }

  /**
   * Confines n to [lo, hi].
   *
   * @param {number} n
   * @param {number} lo
   * @param {number} hi
   * @returns {number}
   */
  function clamp(n, lo, hi) {
    return Math.min(hi, Math.max(lo, n));
  }

  /* --------------------------------------------------------------- actions */

  /**
   * Registers a write. It is reached only from ctx.run(name, arg, callback) inside a view, which
   * is the whole point: the token, the in-flight guard, the optimistic snapshot and the refetch
   * all live on that path, so an app cannot POST without them by accident.
   *
   * The payload always carries csrfToken from OB.User. When the page has no token the request is
   * not sent at all and the callback receives an Error with code ETUIK_NoCsrf -- the same code
   * UikAction returns when the server rejects a token -- because KernelServlet does not check
   * CSRF itself, so a write that forgets the token is simply rejected by the handler.
   *
   * optimistic(state, arg) mutates state before the request and is repainted immediately, without
   * going through ctx.set, so it never triggers a refetch: a refetch racing an unfinished write
   * would repaint the server's old answer over the user's action. If the request fails, state is
   * restored from a JSON snapshot taken before the mutation. Two consequences, and they constrain
   * every window that writes:
   *
   *   1. state must be JSON-serializable. A Date, a function, a DOM node or a cycle does not
   *      survive the snapshot, so it cannot live in state.
   *   2. optimistic must not touch any key that params(state) reads, or the mutation -- and the
   *      rollback after it -- would change a datasource signature and provoke exactly the refetch
   *      this design exists to avoid.
   *
   * refetch names what to reload after a success: true for everything, or an alias, or a list of
   * aliases. confirm is a question shown before anything happens, as a string or as
   * (state, arg) => string.
   *
   * @param {Object} spec
   * @param {string} spec.name  the name ctx.run uses
   * @param {string} spec.action  the handler's fully qualified class name; it must extend UikAction
   * @param {Function} [spec.payload]  (state, arg) => the request body, before csrfToken
   * @param {Function} [spec.optimistic]  (state, arg) => void, applied before the request
   * @param {boolean|string|string[]} [spec.refetch]  what to reload on success
   * @param {string|Function} [spec.confirm]  a question to ask first
   * @returns {void}
   */
  function defineAction(spec) {
    ACTIONS[spec.name] = spec;
  }

  function actionError(code, message) {
    var err = new Error(message);
    err.code = code;
    return err;
  }

  /*
   * The shape UikAction.execute returns, and nothing else. Success is the handler's own keys plus
   * success:true; a rejection is success:false with error.code and error.message, where the code
   * is ETUIK_NoCsrf for a bad token and ETUIK_Failed for anything the handler threw. The message
   * is written for a user, so it is safe to render; the stack trace stayed in the server log.
   */
  function envelopeError(data, action) {
    if (!data) {
      return actionError('ETUIK_Failed', 'empty response from ' + action);
    }
    if (data.error) {
      return actionError(
        data.error.code || 'ETUIK_Failed',
        data.error.message || String(data.error)
      );
    }
    if (data.success === false) {
      return actionError('ETUIK_Failed', action + ' reported no success');
    }
    return null;
  }

  /*
   * Puts a JSON snapshot back, in place. The state object itself is never replaced, because
   * ctx.state and every handler closure already hold a reference to it; replacing it would leave
   * the app mutating an orphan.
   */
  function restoreState(view, snapshot) {
    var was = JSON.parse(snapshot);
    Object.keys(view.uikState).forEach(function (k) {
      delete view.uikState[k];
    });
    Object.keys(was).forEach(function (k) {
      view.uikState[k] = was[k];
    });
  }

  /*
   * Runs one registered action for one view. Private: ctx.run is the only door, and it returns
   * true only when a request actually left the browser -- false covers an unknown action, a
   * refused confirmation, a missing token, and the duplicate that a double click produces.
   */
  function runAction(view, name, arg, callback) {
    var done = typeof callback === 'function' ? callback : function () {};
    var action = ACTIONS[name];
    if (!action) {
      done(actionError('ETUIK_NoAction', 'unknown action ' + name));
      return false;
    }
    var key = name + ' ' + JSON.stringify(arg === undefined ? null : arg);
    if (view.uikFlight[key]) {
      return false;
    }
    if (action.confirm) {
      var ask =
        typeof action.confirm === 'function' ? action.confirm(view.uikState, arg) : action.confirm;
      if (ask && !window.confirm(String(ask))) {
        return false;
      }
    }
    var user = OB.User;
    var token = user ? user.csrfToken : null;
    if (!token) {
      done(
        actionError(
          'ETUIK_NoCsrf',
          'no CSRF token on OB.User; ' + name + ' was not sent. Reload the window.'
        )
      );
      return false;
    }
    var body = (action.payload ? action.payload(view.uikState, arg) : {}) || {};
    var wire = {};
    Object.keys(body).forEach(function (k) {
      wire[k] = body[k];
    });
    // Last, so a payload cannot overwrite the token with a field of its own.
    wire.csrfToken = token;
    var snapshot = null;
    if (action.optimistic) {
      snapshot = JSON.stringify(view.uikState);
      action.optimistic(view.uikState, arg);
      // Deliberately uikPaint and not uikSync: see the note above about the racing refetch.
      view.uikPaint();
    }
    view.uikFlight[key] = true;
    view.uikBusyDelta(1);
    var settle = function () {
      delete view.uikFlight[key];
      view.uikBusyDelta(-1);
    };
    var rollback = function (err) {
      if (snapshot !== null) {
        restoreState(view, snapshot);
      }
      view.uikPaint();
      done(err);
    };
    OB.RemoteCallManager.call(
      action.action,
      wire,
      {},
      function (response, data) {
        settle();
        var err = envelopeError(data, action.action);
        if (err) {
          rollback(err);
          return;
        }
        if (action.refetch) {
          view.uikInvalidate(action.refetch);
          view.uikLoad();
        } else {
          view.uikPaint();
        }
        done(null, data);
      },
      null,
      function () {
        settle();
        rollback(actionError('ETUIK_Failed', 'request to ' + action.action + ' failed'));
      }
    );
    return true;
  }

  /* -------------------------------------------------------------- the view */

  // focus and blur do not bubble, so a delegated listener on the root never sees them unless it
  // is registered in the capture phase. focusin and focusout do bubble and need nothing special.
  var CAPTURE = { focus: true, blur: true };

  /*
   * Normalises one entry of spec.data. A bare string is the whole-view shape it has always been;
   * the object shape is decision D6 and its four keys are frozen.
   *
   * keep is the odd one out because its default is the safe direction: when when(state) turns
   * false the alias's last value is kept, so flipping a panel closed and open again costs no
   * request. keep:false is the opt-out for a source whose stale answer would mislead.
   */
  function dataEntry(value) {
    if (typeof value === 'string') {
      return { source: value, params: null, when: null, keep: true };
    }
    return {
      source: value.source,
      params: typeof value.params === 'function' ? value.params : null,
      when: typeof value.when === 'function' ? value.when : null,
      keep: value.keep !== false
    };
  }

  /*
   * A selector that finds the focused element again after its region's innerHTML is replaced,
   * built from the element's own data-* attributes. Returns null for an element that carries none,
   * which is why every focusable control in a uikit window has a data-* identifier: without one
   * there is nothing stable to match on across a rewrite.
   */
  function focusKey(el) {
    var attrs = el.attributes;
    var parts = [];
    for (var i = 0; i < attrs.length; i++) {
      if (attrs[i].name.indexOf('data-') === 0) {
        parts.push('[' + attrs[i].name + '="' + String(attrs[i].value).replace(/"/g, '\\"') + '"]');
      }
    }
    return parts.length ? el.tagName.toLowerCase() + parts.join('') : null;
  }

  /**
   * Defines a Classic view that owns its own DOM subtree.
   *
   * Rendering is whole-region strings, and a region is written only when its string changed. That
   * is what keeps the filter bar from flickering when the user clicks a chip inside it. Caret and
   * selection survive a region rewrite, so a search box does not lose a keystroke mid-word.
   *
   * render is called as (state, data, ui). ui carries what the runtime knows and the app does not:
   * ui.first while the first load has not finished, ui.busy while any request is in flight, and
   * ui.errors keyed by data alias -- so a source that failed on a refetch is reported next to the
   * rest of a screen that is still perfectly good, instead of blanking it.
   *
   * Event handlers receive one ctx and nothing else:
   *
   *   ctx.state, ctx.data, ctx.ui        the same three objects render sees
   *   ctx.set(partial)                   merge into state, then reconcile
   *   ctx.toggle(key, id)                flip one id in a set-shaped state key
   *   ctx.run(name, arg, callback)       run a defineAction; false when it did not go out
   *   ctx.later(fn, ms)                  a timer this view owns; returns its cancel function
   *   ctx.refetch(alias)                 drop a cached alias and reload it; no alias means all
   *
   * In the on: map the first matching rule wins and the rest are skipped. That is deliberate and
   * relied upon: a specific 'click [data-row] button' registered before a general
   * 'click [data-row]' shadows it, which is how a row with its own action button works at all.
   * Changing it to run every match would silently break any app already written against it.
   *
   * @param {Object} spec
   * @param {string} spec.name  the view id, matching OBUIAPP_View_Impl.name and isc.<name>
   * @param {string} [spec.title]  label key for the tab title; falls back to the view id
   * @param {Object} spec.state  the initial state object; every key is yours, and JSON-only
   * @param {Object<string, string|Object>} [spec.data]  alias to datasource name, or to a lazy entry
   * @param {function(Object): Object<string, *>} [spec.params]  (state) => request params
   * @param {string[]} spec.regions  region names, in render order; required
   * @param {string} [spec.loading]  region that shows the first-load block; the first region by default
   * @param {string[]} [spec.keepScroll]  region names whose scrollTop survives a redraw
   * @param {function(Object, Object, Object): Object<string, string|Raw>} spec.render  (state, data, ui) => region html
   * @param {Object<string, function(Object, Event, Element): void>} [spec.on]  { 'click [data-x]': handler }
   * @param {function(Object): void} [spec.activate]  the tab became visible
   * @param {function(Object): void} [spec.deactivate]  the tab lost focus to another tab
   * @param {function(Object): void} [spec.destroy]  the tab is closing; drop anything the runtime cannot
   * @returns {Object} the SmartClient class, already registered as isc.<name>
   */
  function defineView(spec) {
    var name = spec.name;
    /*
     * No fallback. This used to default to Object.keys(spec.state.regions || {}), which was never
     * documented and, for every real spec, produced an empty array: the window then drew a root
     * div with no regions in it and rendered nothing at all, with no error in the console and
     * nothing to search for. A loud throw at definition time is the whole fix.
     */
    if (!spec.regions || !spec.regions.length) {
      throw new Error(
        'OB.UIKit.defineView(' + name + '): spec.regions is required and must not be empty'
      );
    }
    var regions = spec.regions;

    isc.ClassFactory.defineClass(name, isc.VLayout);

    isc[name].addProperties({
      // Our subtree is ours. SmartClient must not re-emit the handle contents underneath it.
      redrawOnResize: false,
      overflow: 'auto',
      width: '100%',
      height: '100%',

      isSameTab: function (viewId) {
        return viewId === name;
      },

      /**
       * A lazily fetched view arrives after its tab already exists: ViewManager opens a loading
       * tab titled with the view id, then swaps in the pane without relabelling it. This is the
       * hook core calls once the tab is ours, so it is where the title gets fixed.
       */
      setViewTabId: function (viewTabId) {
        this.viewTabId = viewTabId;
        if (this.tabTitle && OB.MainView && OB.MainView.TabSet) {
          OB.MainView.TabSet.setTabTitle(viewTabId, this.tabTitle);
        }
      },

      // Core spells it getBookMarkParams -- capital M and P. Misname it and the URL silently
      // stops carrying any state, with no error anywhere.
      getBookMarkParams: function () {
        var params = { viewId: name };
        if (spec.params) {
          isc.addProperties(params, spec.params(this.uikState));
        }
        return params;
      },

      initWidget: function () {
        // ViewManager reads tabTitle off the instance right after create(), so it has to be set
        // here -- otherwise the tab is labelled with the raw view id.
        if (!this.tabTitle) {
          this.tabTitle = spec.title ? t(spec.title) : name;
        }
        this.uikState = isc.shallowClone(spec.state);
        this.uikData = {};
        this.uikPainted = {};
        this.uikParams = null;
        this.uikUi = { first: true, busy: false, errors: {} };
        this.uikFlight = {};
        this.uikTimers = [];
        this.uikBusyCount = 0;
        this.uikDead = false;
        // openView passes bookmark params straight into create(), so a restored tab starts where
        // the user left it rather than on the default quarter.
        var self = this;
        Object.keys(spec.state).forEach(function (k) {
          if (self[k] !== undefined && typeof self[k] !== 'function') {
            self.uikState[k] = self[k];
          }
        });
        return this.Super('initWidget', arguments);
      },

      draw: function () {
        var result = this.Super('draw', arguments);
        this.uikMount();
        return result;
      },

      redraw: function () {
        var result = this.Super('redraw', arguments);
        // SmartClient may have replaced the handle contents; rebuild from state, which is cheap
        // because render is pure.
        this.uikRoot = null;
        this.uikPainted = {};
        this.uikMount();
        return result;
      },

      /**
       * Core calls this for us: OBTabSetMain sets destroyPanes:true, so closing the tab destroys
       * the pane. Timers have to die here or they fire into a DOM that no longer exists, and
       * uikDead makes every later paint a no-op, including one an in-flight request will try.
       */
      destroy: function () {
        this.uikDead = true;
        this.uikTimers.forEach(function (id) {
          clearTimeout(id);
        });
        this.uikTimers = [];
        if (spec.destroy) {
          try {
            spec.destroy(this.uikCtx());
          } catch (e) {
            console.warn('OB.UIKit: ' + name + ' destroy hook failed: ' + e.message);
          }
        }
        return this.Super('destroy', arguments);
      },

      // OBTabSetMain redirects its own tabSelected/tabDeselected to the pane when the pane has
      // them, so these are already the lifecycle hooks; core's own panes do not call Super here
      // and neither do we. They arrive with no arguments from the navbar widgets.
      tabSelected: function () {
        if (spec.activate && !this.uikDead) {
          spec.activate(this.uikCtx());
        }
      },

      tabDeselected: function () {
        if (spec.deactivate && !this.uikDead) {
          spec.deactivate(this.uikCtx());
        }
      },

      /** Creates our root element inside the SmartClient handle and paints once. */
      uikMount: function () {
        var handle = this.getHandle();
        if (!handle || this.uikDead) {
          return;
        }
        if (!this.uikRoot || !handle.contains(this.uikRoot)) {
          var root = document.createElement('div');
          root.className = 'uik uik-' + name.toLowerCase();
          handle.appendChild(root);
          root.innerHTML = regions
            .map(function (r) {
              return '<div class="uik-region uik-region-' + r + '" data-region="' + r + '"></div>';
            })
            .join('');
          this.uikRoot = root;
          this.uikBind();
        }
        if (this.uikBusyCount > 0) {
          this.uikRoot.classList.add('uik-busy');
        }
        if (this.uikParams === null) {
          this.uikLoad();
        } else {
          this.uikPaint();
        }
      },

      /** One delegated listener per event type, on our root only, so SmartClient sees nothing. */
      uikBind: function () {
        var self = this;
        var handlers = spec.on || {};
        var byType = {};
        Object.keys(handlers).forEach(function (key) {
          var space = key.indexOf(' ');
          var type = space === -1 ? key : key.slice(0, space);
          var selector = space === -1 ? null : key.slice(space + 1);
          (byType[type] = byType[type] || []).push({ selector: selector, fn: handlers[key] });
        });
        Object.keys(byType).forEach(function (type) {
          self.uikRoot.addEventListener(
            type,
            function (event) {
              var rules = byType[type];
              for (var i = 0; i < rules.length; i++) {
                var el = rules[i].selector ? event.target.closest(rules[i].selector) : event.target;
                if (el && self.uikRoot.contains(el)) {
                  // First match wins. Registration order is the priority order, so a specific
                  // rule placed before a general one shadows it. Documented in defineView.
                  rules[i].fn(self.uikCtx(), event, el);
                  return;
                }
              }
            },
            CAPTURE[type] === true
          );
        });
      },

      /** The context handed to event handlers: the only sanctioned way to change anything. */
      uikCtx: function () {
        var self = this;
        return {
          state: self.uikState,
          data: self.uikData,
          ui: self.uikUi,
          set: function (partial) {
            isc.addProperties(self.uikState, partial);
            self.uikSync();
          },
          toggle: function (key, id) {
            var bag = self.uikState[key] || {};
            if (bag[id]) {
              delete bag[id];
            } else {
              bag[id] = true;
            }
            self.uikState[key] = bag;
            self.uikSync();
          },
          run: function (action, arg, callback) {
            return self.uikDead ? false : runAction(self, action, arg, callback);
          },
          later: function (fn, ms) {
            if (self.uikDead) {
              return function () {};
            }
            var id = setTimeout(function () {
              self.uikForget(id);
              if (!self.uikDead) {
                fn();
              }
            }, ms);
            self.uikTimers.push(id);
            return function () {
              clearTimeout(id);
              self.uikForget(id);
            };
          },
          refetch: function (alias) {
            self.uikInvalidate(alias === undefined ? true : alias);
            self.uikLoad();
          }
        };
      },

      uikForget: function (id) {
        var at = this.uikTimers.indexOf(id);
        if (at !== -1) {
          this.uikTimers.splice(at, 1);
        }
      },

      /**
       * Reconciles after a state change. uikLoad decides per alias whether anything has to be
       * refetched, so this is one call and not a branch: a tab switch repaints, a filter change
       * refetches only the sources whose own params moved.
       */
      uikSync: function () {
        this.uikLoad();
      },

      /**
       * Marks the root busy while requests are outstanding. A counter, not a flag, because a
       * lazy view has several sources and an optimistic write can overlap them.
       */
      uikBusyDelta: function (delta) {
        this.uikBusyCount = Math.max(0, this.uikBusyCount + delta);
        this.uikUi.busy = this.uikBusyCount > 0;
        if (this.uikRoot) {
          if (this.uikUi.busy) {
            this.uikRoot.classList.add('uik-busy');
          } else {
            this.uikRoot.classList.remove('uik-busy');
          }
        }
      },

      /** Forgets the cached params signature of one alias, a list of them, or all of them. */
      uikInvalidate: function (which) {
        if (this.uikParams === null) {
          return;
        }
        if (which === true) {
          this.uikParams = {};
          return;
        }
        var self = this;
        var list = Array.isArray(which) ? which : [which];
        list.forEach(function (alias) {
          delete self.uikParams[alias];
        });
      },

      /**
       * Fetches only what changed.
       *
       * uikParams is a signature per alias plus one for the view, so an alias is requested when
       * its own params moved and not because some other filter did. A source whose when(state) is
       * false is not requested at all and keeps its last value, which is what makes a window with
       * six panels and three sources affordable: opening a panel costs one request the first time
       * and nothing afterwards.
       *
       * Only the first load blanks anything. After that a failure lands in ui.errors[alias] and
       * the screen that is already painted stays painted -- the previous version of this function
       * wrote a loading block into a hardcoded region on every single refetch, which erased a
       * working screen every time a filter moved.
       */
      uikLoad: function () {
        if (this.uikDead) {
          return;
        }
        var self = this;
        var state = this.uikState;
        var viewParams = spec.params ? spec.params(state) : {};
        var first = this.uikParams === null;
        var was = first ? {} : this.uikParams;
        var next = { view: JSON.stringify(viewParams) };
        var wanted = [];
        Object.keys(spec.data || {}).forEach(function (alias) {
          var entry = dataEntry(spec.data[alias]);
          if (entry.when && !entry.when(state)) {
            if (entry.keep) {
              next[alias] = was[alias];
            } else {
              delete self.uikData[alias];
              delete self.uikUi.errors[alias];
            }
            return;
          }
          var params = entry.params ? entry.params(state) : viewParams;
          var sig = JSON.stringify(params);
          next[alias] = sig;
          if (sig !== was[alias] || self.uikData[alias] === undefined) {
            wanted.push({ alias: alias, source: entry.source, params: params });
          }
        });
        this.uikParams = next;
        // These params are what getBookMarkParams publishes, so the URL has to follow them --
        // and only them: a tab or a sort that never reaches the server must not touch history.
        if (this.viewTabId && OB.Layout.HistoryManager && next.view !== was.view) {
          OB.Layout.HistoryManager.updateHistory();
        }
        if (wanted.length === 0) {
          this.uikUi.first = false;
          this.uikPaint();
          return;
        }
        if (first) {
          this.uikSetRegion(
            spec.loading || regions[0],
            '<div class="uik-loading">' + esc(t('ETUIK_Loading')) + '</div>'
          );
        }
        var pending = wanted.length;
        this.uikBusyDelta(wanted.length);
        wanted.forEach(function (job) {
          delete self.uikUi.errors[job.alias];
          fetch(job.source, job.params, function (err, data) {
            self.uikBusyDelta(-1);
            if (err) {
              self.uikUi.errors[job.alias] = err.message;
            } else {
              self.uikData[job.alias] = data;
              delete self.uikUi.errors[job.alias];
            }
            pending -= 1;
            if (pending > 0 || self.uikDead) {
              return;
            }
            var broken = Object.keys(self.uikUi.errors);
            self.uikUi.first = false;
            if (first && broken.length) {
              // Nothing is painted yet, so there is no screen to protect: show the error itself.
              self.uikFail(new Error(self.uikUi.errors[broken[0]]));
              return;
            }
            self.uikPaint();
          });
        });
      },

      uikFail: function (err) {
        this.uikSetRegion(
          regions[0],
          '<div class="uik-error"><b>' +
            esc(t('ETUIK_LoadFailed')) +
            '</b><br>' +
            esc(err.message) +
            '</div>'
        );
      },

      /** Renders every region, writes only the ones whose HTML actually changed. */
      uikPaint: function () {
        if (this.uikDead || !this.uikRoot) {
          return;
        }
        var out;
        try {
          out = spec.render(this.uikState, this.uikData, this.uikUi) || {};
        } catch (e) {
          this.uikFail(e);
          throw e;
        }
        var self = this;
        regions.forEach(function (r) {
          self.uikSetRegion(r, out[r] === undefined ? '' : out[r]);
        });
      },

      /**
       * Writes one region, preserving scroll, focus and text selection across the write.
       *
       * Replacing innerHTML destroys the focused node, so without this a window that repaints
       * while someone is typing loses the caret on every keystroke and an optimistic write moves
       * focus off the button that was just pressed. That would make a uikit screen measurably
       * worse to use than a core grid, which is why this is not optional.
       */
      uikSetRegion: function (region, markup) {
        markup = markup === null || markup === undefined ? '' : String(markup);
        if (this.uikPainted[region] === markup) {
          return;
        }
        var node = this.uikRoot.querySelector('[data-region="' + region + '"]');
        if (!node) {
          return;
        }
        var keep = (spec.keepScroll || []).indexOf(region) !== -1 ? node.scrollTop : null;
        var active = document.activeElement;
        var mark = null;
        if (active && active !== document.body && node.contains(active)) {
          mark = { key: focusKey(active), start: null, end: null };
          try {
            mark.start = active.selectionStart;
            mark.end = active.selectionEnd;
          } catch (e) {
            mark.start = null;
          }
        }
        node.innerHTML = markup;
        this.uikPainted[region] = markup;
        if (keep !== null) {
          node.scrollTop = keep;
        }
        if (mark && mark.key) {
          var again = node.querySelector(mark.key);
          if (again) {
            again.focus();
            if (mark.start !== null && typeof again.setSelectionRange === 'function') {
              try {
                again.setSelectionRange(mark.start, mark.end);
              } catch (e2) {
                // A control that reports a selection but refuses to set one; the focus is enough.
              }
            }
          }
        }
      }
    });

    return isc[name];
  }

  OB.UIKit = {
    version: VERSION,
    esc: esc,
    raw: raw,
    html: html,
    labels: labels,
    t: t,
    datasource: datasource,
    fetch: fetch,
    style: style,
    fmt: fmt,
    nav: nav,
    debounce: debounce,
    badge: badge,
    rail: rail,
    meter: meter,
    bars: bars,
    spark: spark,
    clamp: clamp,
    defineAction: defineAction,
    defineView: defineView
  };
})();
