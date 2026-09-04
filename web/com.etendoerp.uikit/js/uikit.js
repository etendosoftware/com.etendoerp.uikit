/*
 * com.etendoerp.uikit runtime.
 *
 * One job: let a module own a rectangle of the DOM inside an Etendo Classic tab, and render it
 * from state with plain strings, without learning SmartClient. Everything here is in service of
 * OB.UIKit.defineView; the rest of the surface exists because defineView needs it.
 *
 * The contract this file implements is documented in docs/ — L0 for the shape, L5 for the API.
 * If the two disagree, gate G8 fails the build, so change both or neither.
 */
(function () {
  'use strict';

  if (typeof OB === 'undefined') {
    window.OB = {};
  }
  if (OB.UIKit) {
    return;
  }

  var VERSION = '0.1.0';
  var DATASOURCES = {};
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
    return raw(
      '<span class="uik-rail uik-' +
      (STATES[state] || 'flat') +
      '" style="--uik-p:' +
      p.toFixed(1) +
      '%;--uik-e:' +
      e.toFixed(1) +
      '%" role="img" aria-label="' +
      Math.round(p) +
      '% avanzado, ' +
      Math.round(e) +
      '% esperado"></span>'
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
    var cells = '';
    for (var i = 1; i <= 10; i++) {
      cells +=
        '<i class="' + (i <= filled ? 'on' : '') + (i === mark ? ' tg' : '') + '"></i>';
    }
    return raw(
      '<span class="uik-meter" role="img" aria-label="score ' +
      score.toFixed(2) +
      ' de ' +
      target.toFixed(2) +
      '">' +
      cells +
      '</span>'
    );
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

  /* -------------------------------------------------------------- the view */

  /**
   * Defines a Classic view that owns its own DOM subtree.
   *
   * Rendering is whole-region strings, and a region is written only when its string changed. That
   * is what keeps the filter bar from flickering when the user clicks a chip inside it.
   *
   * @param {Object} spec
   * @param {string} spec.name  the view id, matching OBUIAPP_View_Impl.name and isc.<name>
   * @param {string} [spec.title]  label key for the tab title; falls back to the view id
   * @param {Object} spec.state  the initial state object; every key is yours
   * @param {Object<string, string>} [spec.data]  { alias: 'DatasourceName' }, fetched before the first render
   * @param {function(Object): Object<string, *>} [spec.params]  (state) => request params; a change to these refetches
   * @param {string[]} [spec.regions]  region names, in render order
   * @param {string[]} [spec.keepScroll]  region names whose scrollTop survives a redraw
   * @param {function(Object, Object): Object<string, string|Raw>} spec.render  (state, data) => { region: html }
   * @param {Object<string, function(Object, Event, Element): void>} [spec.on]  { 'click [data-x]': handler }
   * @returns {Object} the SmartClient class, already registered as isc.<name>
   */
  function defineView(spec) {
    var name = spec.name;
    var regions = spec.regions || Object.keys(spec.state.regions || {});

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

      /** Creates our root element inside the SmartClient handle and paints once. */
      uikMount: function () {
        var handle = this.getHandle();
        if (!handle) {
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
          self.uikRoot.addEventListener(type, function (event) {
            var rules = byType[type];
            for (var i = 0; i < rules.length; i++) {
              var el = rules[i].selector
                ? event.target.closest(rules[i].selector)
                : event.target;
              if (el && self.uikRoot.contains(el)) {
                rules[i].fn(self.uikCtx(), event, el);
                return;
              }
            }
          });
        });
      },

      /** The context handed to event handlers: the only sanctioned way to change state. */
      uikCtx: function () {
        var self = this;
        return {
          state: self.uikState,
          data: self.uikData,
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
          }
        };
      },

      /** Refetches when the datasource params changed; otherwise just repaints. */
      uikSync: function () {
        var next = JSON.stringify(spec.params ? spec.params(this.uikState) : {});
        if (next !== this.uikParams) {
          this.uikLoad();
        } else {
          this.uikPaint();
        }
      },

      uikLoad: function () {
        var self = this;
        var params = spec.params ? spec.params(this.uikState) : {};
        var aliases = Object.keys(spec.data || {});
        this.uikParams = JSON.stringify(params);
        // These params are what getBookMarkParams publishes, so the URL has to follow them.
        if (this.viewTabId && OB.Layout.HistoryManager) {
          OB.Layout.HistoryManager.updateHistory();
        }
        if (aliases.length === 0) {
          this.uikPaint();
          return;
        }
        this.uikSetRegion('rail', '<div class="uik-loading">' + esc(t('ETUIK_Loading')) + '</div>');
        var pending = aliases.length;
        var failed = null;
        aliases.forEach(function (alias) {
          fetch(spec.data[alias], params, function (err, data) {
            if (err) {
              failed = failed || err;
            } else {
              self.uikData[alias] = data;
            }
            if (--pending === 0) {
              if (failed) {
                self.uikFail(failed);
              } else {
                self.uikPaint();
              }
            }
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
        if (!this.uikRoot) {
          return;
        }
        var out;
        try {
          out = spec.render(this.uikState, this.uikData) || {};
        } catch (e) {
          this.uikFail(e);
          throw e;
        }
        var self = this;
        regions.forEach(function (r) {
          self.uikSetRegion(r, out[r] === undefined ? '' : out[r]);
        });
      },

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
        node.innerHTML = markup;
        this.uikPainted[region] = markup;
        if (keep !== null) {
          node.scrollTop = keep;
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
    badge: badge,
    rail: rail,
    meter: meter,
    clamp: clamp,
    defineView: defineView
  };
})();
