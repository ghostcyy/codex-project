/* html-ppt :: edit-mode.js
 * Lightweight inline text editor for non-coders.
 * Zero dependencies. ~4 KB unminified.
 *
 * Usage: include AFTER runtime.js
 *   <script src="../assets/edit-mode.js"></script>
 *
 * Features:
 *   E            toggle Edit Mode on/off
 *   Ctrl+S       save (download edited deck as standalone .html)
 *   Toolbar      Bold / Italic / Underline / Undo / 💾 Download
 *
 * How it works:
 *   - In Edit Mode, all text nodes inside slides become contenteditable.
 *   - Arrow/Space keys are blocked while editing so typing doesn't navigate.
 *   - Edits are saved to localStorage keyed per file+slide, restored on load.
 *   - Download exports a clean .html with edits baked in and toolbar stripped.
 */
(function () {
  'use strict';

  /* ─────────────────────────────────────────────
   * Constants & state
   * ───────────────────────────────────────────── */
  var STORAGE_KEY_PREFIX = 'html-ppt-edits:' + location.pathname + ':';

  // Tags whose subtrees must never become editable
  // NOTE: CODE is intentionally NOT here — inline <code> inside slides should be editable.
  // We handle <pre><code> (fenced blocks) separately inside walk().
  var SKIP_TAGS = ['SCRIPT','STYLE','CANVAS','SVG','VIDEO','AUDIO',
                   'INPUT','TEXTAREA','SELECT','IFRAME','NOSCRIPT','PRE'];

  // Roles / classes that belong to the deck chrome, not slide content
  var SKIP_IDS   = ['ppt-edit-toolbar','ppt-edit-toast'];
  var SKIP_CLASSES = ['notes-overlay','overview','progress-bar','ppt-edit-toolbar'];
  var PREFERRED_EDITABLE_CLASS_RE = /(?:^|[-_])(tag|badge|pill|label|alert|chip|marker|eyebrow|kicker)(?:$|[-_])/i;

  var editMode = false;
  var editableEls = [];             // currently active contenteditable elements
  var toolbar = null;               // floating toolbar DOM node
  var lastRange = null;             // last valid text selection inside an editable

  /* ─────────────────────────────────────────────
   * Wait for DOM ready
   * ───────────────────────────────────────────── */
  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  ready(function () {
    var deck = document.querySelector('.deck');
    if (!deck) return;              // not a deck page — bail out silently

    var isPreviewMode = /[?&]preview=\d+/.test(location.search);

    var slides = Array.from(deck.querySelectorAll('.slide'));
    if (!slides.length) return;

    /* ─────────────────────────────────────────
     * Restore saved edits on load
     * Each entry is keyed by child-index path (e.g. "2/0/1") relative to slide
     * ───────────────────────────────────────── */
    slides.forEach(function (slide, i) {
      _restoreSlide(slide, i);
    });

    // In presenter preview iframes we still want restored edits,
    // but we do not mount the editor UI or key handlers.
    if (isPreviewMode) return;

    /* ─────────────────────────────────────────
     * Build the floating toolbar
     * ───────────────────────────────────────── */
    toolbar = document.createElement('div');
    toolbar.id = 'ppt-edit-toolbar';
    toolbar.setAttribute('aria-label', 'Edit toolbar');
    toolbar.innerHTML =
      '<span class="ppt-edit-badge">✏️ Edit Mode</span>' +

      // ── Format ────────────────────────────────────────────────
      '<button data-cmd="bold"        title="Bold (Ctrl+B)"><b>B</b></button>' +
      '<button data-cmd="italic"      title="Italic (Ctrl+I)"><i>I</i></button>' +
      '<button data-cmd="underline"   title="Underline (Ctrl+U)"><u>U</u></button>' +
      '<button data-cmd="strikeThrough" title="Strikethrough"><s>S</s></button>' +
      '<span class="ppt-edit-sep"></span>' +

      // ── Font size ─────────────────────────────────────────────
      '<label class="ppt-edit-label" title="Font size">字号</label>' +
      '<select id="ppt-edit-fontsize" title="Font size">' +
        '<option value="">—</option>' +
        '<option value="1">Tiny</option>' +
        '<option value="2">Small</option>' +
        '<option value="3">Normal</option>' +
        '<option value="4">Large</option>' +
        '<option value="5">XL</option>' +
        '<option value="6">XXL</option>' +
        '<option value="7">Huge</option>' +
      '</select>' +
      '<span class="ppt-edit-sep"></span>' +

      // ── Color ─────────────────────────────────────────────────
      '<label class="ppt-edit-label" title="Text color">色</label>' +
      '<input type="color" id="ppt-edit-color" value="#000000" title="Text color">' +
      '<span class="ppt-edit-sep"></span>' +

      // ── Clear inline styles ──────────────────────────────────
      '<button id="ppt-edit-clear-style" title="清除手动设置的固定样式，恢复主题默认样式">↺ 恢复样式</button>' +
      '<span class="ppt-edit-sep"></span>' +

      // ── Undo / redo ───────────────────────────────────────────
      '<button data-cmd="undo" title="Undo (Ctrl+Z)">↩</button>' +
      '<button data-cmd="redo" title="Redo (Ctrl+Y)">↪</button>' +
      '<span class="ppt-edit-sep"></span>' +

      // ── Actions ───────────────────────────────────────────────
      '<button id="ppt-edit-save" title="Download edited deck (Ctrl+S)">💾 Download</button>' +
      '<button id="ppt-edit-exit" title="Exit edit mode (E)">✕ Done</button>';

    _injectStyles();
    document.body.appendChild(toolbar);

    document.addEventListener('selectionchange', _rememberSelection);
    document.addEventListener('keyup', _rememberSelection, true);
    document.addEventListener('mouseup', _rememberSelection, true);
    document.addEventListener('focusin', _rememberSelection, true);

    /* Toolbar — execCommand buttons */
    toolbar.querySelectorAll('[data-cmd]').forEach(function (btn) {
      btn.addEventListener('mousedown', function (e) {
        e.preventDefault();                       // don't blur active editable
        _restoreLastSelection();
        document.execCommand(btn.dataset.cmd, false, null);
      });
    });

    /* Toolbar — font size selector */
    var fontSizeEl = document.getElementById('ppt-edit-fontsize');
    fontSizeEl.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    fontSizeEl.addEventListener('change', function () {
      var val = fontSizeEl.value;
      if (!val) return;
      _restoreLastSelection();
      // styleWithCSS makes execCommand emit <span style="font-size:…"> instead of <font size>
      document.execCommand('styleWithCSS', false, true);
      document.execCommand('fontSize', false, val);
      document.execCommand('styleWithCSS', false, false);
      fontSizeEl.value = '';          // reset to placeholder
    });

    /* Toolbar — color picker
     * Update the displayed swatch to match the current selection on focus events,
     * and apply foreColor when the user commits a new color choice. */
    var colorEl = document.getElementById('ppt-edit-color');
    colorEl.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    colorEl.addEventListener('input', function () {
      // 'input' fires on every move inside the native color picker
      _restoreLastSelection();
      document.execCommand('styleWithCSS', false, true);
      document.execCommand('foreColor', false, colorEl.value);
      document.execCommand('styleWithCSS', false, false);
    });
    /* Sync swatch to current caret color when an editable gains focus */
    document.addEventListener('focus', function (e) {
      if (e.target && e.target.getAttribute('contenteditable') === 'true') {
        var color = document.queryCommandValue('foreColor');
        if (color && color !== 'false') {
          // color is returned as "rgb(r, g, b)" — convert to hex
          var m = color.match(/(\d+),\s*(\d+),\s*(\d+)/);
          if (m) {
            colorEl.value = '#' +
              ('0' + parseInt(m[1]).toString(16)).slice(-2) +
              ('0' + parseInt(m[2]).toString(16)).slice(-2) +
              ('0' + parseInt(m[3]).toString(16)).slice(-2);
          }
        }
      }
    }, true);

    document.getElementById('ppt-edit-save').addEventListener('click', _downloadDeck);
    document.getElementById('ppt-edit-clear-style').addEventListener('mousedown', function (e) {
      e.preventDefault();
      _clearSelectedInlineStyles();
    });
    document.getElementById('ppt-edit-exit').addEventListener('click', function () {
      _setEditMode(false);
    });

    /* ─────────────────────────────────────────
     * Keyboard integration
     * Hook into the capture phase so we intercept BEFORE runtime.js
     * ───────────────────────────────────────── */
    document.addEventListener('keydown', _onKeyDown, true);

    /* ─────────────────────────────────────────
     * Public toggle triggered by runtime.js 'E' key
     * (runtime.js has no 'E' binding, so we add it here)
     * ───────────────────────────────────────── */
    // Already handled via _onKeyDown above; no extra wiring needed.
  });

  /* ─────────────────────────────────────────────
   * Key handler (capture phase)
   * ───────────────────────────────────────────── */
  function _onKeyDown(e) {
    // Ctrl+S → download (in and out of edit mode)
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      e.stopPropagation();
      _downloadDeck();
      return;
    }

    // Esc → exit current edit mode immediately
    if (editMode && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      _setEditMode(false);
      return;
    }

    // E key (no modifiers) → toggle edit mode
    if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'e' || e.key === 'E')) {
      // Only toggle if focus is not already inside a contenteditable
      if (!_isFocusedInEditable()) {
        e.preventDefault();
        e.stopPropagation();
        _setEditMode(!editMode);
        return;
      }
    }

    // While in edit mode, swallow navigation keys so typing doesn't flip slides
    if (editMode && _isFocusedInEditable()) {
      var nav = ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown',' ','PageUp','PageDown','Home','End','Backspace'];
      if (nav.indexOf(e.key) !== -1 && !e.ctrlKey && !e.metaKey) {
        e.stopPropagation();   // block runtime.js from seeing it
      }
    }
  }

  function _isFocusedInEditable() {
    var el = document.activeElement;
    return el && el.getAttribute('contenteditable') === 'true';
  }

  function _rememberSelection() {
    if (!editMode) return;
    var selection = window.getSelection();
    if (!selection || !selection.rangeCount) return;
    var editable = _findEditableRoot(selection.anchorNode) ||
      _findEditableRoot(selection.focusNode) ||
      _findEditableRoot(selection.getRangeAt(0).commonAncestorContainer) ||
      _findEditableRoot(document.activeElement);
    if (!editable) return;
    lastRange = selection.getRangeAt(0).cloneRange();
  }

  function _restoreLastSelection() {
    if (!lastRange) return false;
    var selection = window.getSelection();
    if (!selection) return false;
    try {
      selection.removeAllRanges();
      selection.addRange(lastRange.cloneRange());
      return true;
    } catch (err) {
      return false;
    }
  }

  function _findEditableRoot(node) {
    var el = node;
    if (!el) return null;
    if (el.nodeType !== 1) el = el.parentElement;
    while (el) {
      if (el.getAttribute && el.getAttribute('contenteditable') === 'true') return el;
      el = el.parentElement;
    }
    return null;
  }

  function _stripInlineAttrs(node) {
    if (!node || node.nodeType !== 1) return;
    node.removeAttribute('style');
    node.removeAttribute('color');
    node.removeAttribute('face');
    node.removeAttribute('size');
  }

  function _unwrapNode(node) {
    if (!node || !node.parentNode) return;
    while (node.firstChild) node.parentNode.insertBefore(node.firstChild, node);
    node.parentNode.removeChild(node);
  }

  function _isSelectionWrapper(node) {
    if (!node || node.nodeType !== 1) return false;
    return node.tagName === 'FONT' || node.hasAttribute('style') ||
      node.hasAttribute('color') || node.hasAttribute('face') || node.hasAttribute('size');
  }

  function _selectionIntersectsNode(selection, node) {
    if (!selection || !selection.rangeCount || !node) return false;
    try { return selection.containsNode(node, true); }
    catch (err) {}
    var range = selection.getRangeAt(0);
    try {
      var nodeRange = document.createRange();
      nodeRange.selectNodeContents(node);
      return range.compareBoundaryPoints(Range.END_TO_START, nodeRange) < 0 &&
             range.compareBoundaryPoints(Range.START_TO_END, nodeRange) > 0;
    } catch (err2) {
      return false;
    }
  }

  function _cleanupStyleWrappers(root) {
    if (!root) return;
    Array.from(root.querySelectorAll('span,font')).forEach(function (node) {
      var attrs = Array.from(node.attributes || []).map(function (a) { return a.name; });
      var keep = attrs.filter(function (name) {
        return name !== 'style' && name !== 'color' && name !== 'face' && name !== 'size';
      });
      if (!keep.length) _unwrapNode(node);
    });
  }

  function _clearSelectedInlineStyles() {
    var selection = window.getSelection();
    var editable = selection && selection.rangeCount ?
      (_findEditableRoot(selection.anchorNode) ||
       _findEditableRoot(selection.focusNode) ||
       _findEditableRoot(selection.getRangeAt(0).commonAncestorContainer) ||
       _findEditableRoot(document.activeElement)) :
      null;

    if (!editable) {
      _restoreLastSelection();
      selection = window.getSelection();
      editable = selection && selection.rangeCount ?
        (_findEditableRoot(selection.anchorNode) ||
         _findEditableRoot(selection.focusNode) ||
         _findEditableRoot(selection.getRangeAt(0).commonAncestorContainer) ||
         _findEditableRoot(document.activeElement)) :
        null;
    }
    if (!selection || !selection.rangeCount || !editable) return;

    var targets = [];
    if (_isSelectionWrapper(editable)) targets.push(editable);
    if (selection.isCollapsed) {
      var current = selection.anchorNode && (selection.anchorNode.nodeType === 1 ? selection.anchorNode : selection.anchorNode.parentElement);
      while (current) {
        if (_isSelectionWrapper(current)) targets.push(current);
        if (current === editable) break;
        current = current.parentElement;
      }
    } else {
      Array.from(editable.querySelectorAll('*')).forEach(function (node) {
        if (_isSelectionWrapper(node) && _selectionIntersectsNode(selection, node)) {
          targets.push(node);
        }
      });
    }

    if (!targets.length) {
      _toast('当前选中的内容没有手动样式可恢复');
      return;
    }

    Array.from(new Set(targets)).forEach(function (node) {
      _stripInlineAttrs(node);
    });
    _cleanupStyleWrappers(editable);

    var slideIdx = parseInt(editable.getAttribute('data-edit-slide'), 10);
    var path = editable.getAttribute('data-edit-path');
    if (!isNaN(slideIdx) && path) _saveEl(editable, slideIdx, path);

    _toast('已恢复为主题默认样式');
  }

  /* ─────────────────────────────────────────────
   * Edit mode toggle
   * ───────────────────────────────────────────── */
  function _setEditMode(on) {
    editMode = on;
    var deck = document.querySelector('.deck');
    if (!deck) return;
    var slides = Array.from(deck.querySelectorAll('.slide'));

    if (on) {
      /* Walk the DOM tree of every slide and make text-bearing elements editable.
       * This covers h1-h6, p, li, span, div, b, strong, em, td, etc. — anything
       * that directly contains non-whitespace text nodes. */
      editableEls = [];
      slides.forEach(function (slide, slideIdx) {
        _findTextBearingEls(slide).forEach(function (el) {
          var path = _pathOf(el, slide);
          el.setAttribute('contenteditable', 'true');
          el.setAttribute('data-edit-path', path);
          el.setAttribute('data-edit-slide', slideIdx);
          el.setAttribute('spellcheck', 'true');
          el.classList.add('ppt-editable');

          /* Auto-save on every keystroke (debounced 400 ms) */
          el._pptSaveTimer = null;
          el.addEventListener('input', function () {
            clearTimeout(el._pptSaveTimer);
            el._pptSaveTimer = setTimeout(function () {
              _saveEl(el, slideIdx, path);
            }, 400);
          }, { once: false });

          editableEls.push(el);
        });
      });

      toolbar.classList.add('ppt-edit-toolbar--active');
      document.body.classList.add('ppt-edit-mode');
      _toast('Edit Mode ON — click any text to edit · E or ✕ to exit');

    } else {
      /* Disable contenteditable */
      editableEls.forEach(function (el) {
        clearTimeout(el._pptSaveTimer);
        var slideIdx = parseInt(el.getAttribute('data-edit-slide'), 10);
        var path = el.getAttribute('data-edit-path');
        _saveEl(el, slideIdx, path);         // final save on exit
        el.removeAttribute('contenteditable');
        el.removeAttribute('data-edit-path');
        el.removeAttribute('data-edit-slide');
        el.removeAttribute('spellcheck');
        el.classList.remove('ppt-editable');
      });
      editableEls = [];
      lastRange = null;
      toolbar.classList.remove('ppt-edit-toolbar--active');
      document.body.classList.remove('ppt-edit-mode');
      _toast('Edit Mode OFF — edits saved ✓');
    }
  }

  /* ─────────────────────────────────────────────
   * DOM tree walker
   * Finds every element that directly owns at least one non-empty text node.
   * Does NOT recurse into children of matched elements (they'd conflict).
   * Also skips chrome, controls, and non-text media elements.
   * ───────────────────────────────────────────── */
  function _findTextBearingEls(root) {
    var results = [];

    function walk(el) {
      // Skip chrome and media
      if (SKIP_TAGS.indexOf(el.tagName) !== -1) return;
      // Skip <code> that lives inside <pre> (= fenced code blocks, don't edit)
      if (el.tagName === 'CODE' && el.closest('pre')) return;
      if (el.id && SKIP_IDS.indexOf(el.id) !== -1) return;
      if (SKIP_CLASSES.some(function (c) { return el.classList.contains(c); })) return;
      // Skip elements that already have a contenteditable ancestor
      if (el.closest('[contenteditable="true"]')) return;

      // Check for direct non-whitespace text node children
      var hasDirectText = false;
      for (var i = 0; i < el.childNodes.length; i++) {
        var node = el.childNodes[i];
        if (node.nodeType === 3 /* TEXT_NODE */ && node.textContent.trim()) {
          hasDirectText = true;
          break;
        }
      }

      if (hasDirectText && (_isPreferredEditableTextElement(el) || !_hasPreferredEditableTextDescendant(el))) {
        results.push(el);
        // Don't recurse — el itself will be contenteditable, covering its children
        return;
      }

      // Recurse into child elements
      for (var j = 0; j < el.children.length; j++) {
        walk(el.children[j]);
      }
    }

    for (var k = 0; k < root.children.length; k++) {
      walk(root.children[k]);
    }
    return results;
  }

  function _isPreferredEditableTextElement(el) {
    if (!el || !el.classList) return false;
    for (var i = 0; i < el.classList.length; i++) {
      if (PREFERRED_EDITABLE_CLASS_RE.test(el.classList[i])) return true;
    }
    return false;
  }

  function _hasPreferredEditableTextDescendant(el) {
    if (!el || !el.children) return false;
    for (var i = 0; i < el.children.length; i++) {
      var child = el.children[i];
      if (_isPreferredEditableTextElement(child)) return true;
      if (_hasPreferredEditableTextDescendant(child)) return true;
    }
    return false;
  }

  /* ─────────────────────────────────────────────
   * Persistence helpers
   * Key: child-index path relative to slide root, e.g. "1/0/2"
   * This is tag-agnostic and works for div/span/b/strong/any element.
   * ───────────────────────────────────────────── */

  /** Return e.g. "1/0/2" = el is children[1].children[0].children[2] of slide */
  function _pathOf(el, slide) {
    var parts = [];
    var node = el;
    while (node && node !== slide) {
      var parent = node.parentElement;
      if (!parent) break;
      parts.unshift(Array.prototype.indexOf.call(parent.children, node));
      node = parent;
    }
    return parts.join('/');
  }

  function _saveEl(el, slideIdx, path) {
    var key = STORAGE_KEY_PREFIX + slideIdx;
    var slide = el && el.closest ? el.closest('.slide') : null;
    if (!slide) return;
    try { localStorage.setItem(key, _serializeSlide(slide)); } catch (err) {}
  }

  function _restoreSlide(slide, slideIdx) {
    var saved = _loadSlide(slideIdx);
    if (!saved) return;
    if (saved.type === 'html') {
      slide.innerHTML = saved.html;
      return;
    }
    if (saved.type === 'map') {
      Object.keys(saved.map).forEach(function (path) {
        var el = _elByPath(slide, path);
        if (el) el.innerHTML = saved.map[path];
      });
    }
  }

  /** Resolve a path string back to an element within slide */
  function _elByPath(slide, path) {
    var parts = path.split('/').map(Number);
    var el = slide;
    for (var i = 0; i < parts.length; i++) {
      if (!el || !el.children[parts[i]]) return null;
      el = el.children[parts[i]];
    }
    return el === slide ? null : el;
  }

  function _serializeSlide(slide) {
    var clone = slide.cloneNode(true);
    clone.querySelectorAll('[contenteditable]').forEach(function (el) {
      el.removeAttribute('contenteditable');
      el.removeAttribute('data-edit-path');
      el.removeAttribute('data-edit-slide');
      el.removeAttribute('spellcheck');
      el.classList.remove('ppt-editable');
    });
    clone.querySelectorAll('.ppt-editable').forEach(function (el) {
      el.classList.remove('ppt-editable');
    });
    return clone.innerHTML;
  }

  function _loadSlide(slideIdx) {
    try {
      var raw = localStorage.getItem(STORAGE_KEY_PREFIX + slideIdx);
      if (!raw) return null;
      var trimmed = raw.trim();
      if (trimmed && trimmed.charAt(0) === '<') {
        return { type: 'html', html: raw };
      }
      var parsed = JSON.parse(raw);
      var changed = false;
      var normalized = {};
      Object.keys(parsed).sort(function (a, b) {
        return b.split('/').length - a.split('/').length;
      }).forEach(function (path) {
        var shadowed = Object.keys(normalized).some(function (savedPath) {
          return savedPath.indexOf(path + '/') === 0;
        });
        if (shadowed) {
          changed = true;
          return;
        }
        normalized[path] = parsed[path];
      });
      if (changed) {
        try { localStorage.setItem(STORAGE_KEY_PREFIX + slideIdx, JSON.stringify(normalized)); } catch (writeErr) {}
      }
      return { type: 'map', map: normalized };
    } catch (err) { return null; }
  }

  /* ─────────────────────────────────────────────
   * Download / Export
   * Produces a clean, standalone .html with all edits baked in.
   * Strips the edit toolbar from the exported file.
   * ───────────────────────────────────────────── */
  function _downloadDeck() {
    /* Clone the full HTML */
    var clone = document.documentElement.cloneNode(true);

    /* Remove the edit toolbar from the clone */
    var tb = clone.querySelector('#ppt-edit-toolbar');
    if (tb) tb.remove();

    /* Strip contenteditable, edit classes, data-edit-* attrs */
    clone.querySelectorAll('[contenteditable]').forEach(function (el) {
      el.removeAttribute('contenteditable');
      el.removeAttribute('data-edit-path');
      el.removeAttribute('data-edit-slide');
      el.removeAttribute('spellcheck');
      el.classList.remove('ppt-editable');
    });
    /* Remove edit-mode body class */
    clone.querySelector('body') && clone.querySelector('body').classList.remove('ppt-edit-mode');

    /* Remove the <script> tag for edit-mode.js itself */
    clone.querySelectorAll('script').forEach(function (s) {
      if ((s.src || s.getAttribute('src') || '').indexOf('edit-mode') !== -1) s.remove();
    });

    var html = '<!DOCTYPE html>\n' + clone.outerHTML;
    var blob = new Blob([html], { type: 'text/html' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    var filename = (document.title || 'deck').replace(/[^a-z0-9\-_\u4e00-\u9fff]/gi, '-') + '-edited.html';
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    _toast('Downloaded: ' + filename);
  }

  /* ─────────────────────────────────────────────
   * Toast notification
   * ───────────────────────────────────────────── */
  function _toast(msg) {
    var existing = document.getElementById('ppt-edit-toast');
    if (existing) existing.remove();
    var t = document.createElement('div');
    t.id = 'ppt-edit-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    // Trigger fade-in next frame
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { t.classList.add('ppt-edit-toast--show'); });
    });
    setTimeout(function () {
      t.classList.remove('ppt-edit-toast--show');
      setTimeout(function () { if (t.parentNode) t.remove(); }, 400);
    }, 2800);
  }

  /* ─────────────────────────────────────────────
   * Inject styles (self-contained, no external CSS needed)
   * ───────────────────────────────────────────── */
  function _injectStyles() {
    var style = document.createElement('style');
    style.id = 'ppt-edit-styles';
    style.textContent = [
      /* ── Toolbar (hidden by default) ─────────── */
      '#ppt-edit-toolbar {',
      '  position: fixed;',
      '  top: 14px; left: 50%; transform: translateX(-50%) translateY(-80px);',
      '  display: flex; align-items: center; gap: 4px;',
      '  background: rgba(15, 16, 20, 0.9);',
      '  backdrop-filter: blur(12px);',
      '  border: 1px solid rgba(255,255,255,0.12);',
      '  border-radius: 999px;',
      '  padding: 6px 12px;',
      '  box-shadow: 0 8px 32px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.04);',
      '  z-index: 9999;',
      '  transition: transform 0.3s cubic-bezier(0.4,0,0.2,1), opacity 0.3s;',
      '  opacity: 0; pointer-events: none; user-select: none;',
      '}',
      '#ppt-edit-toolbar.ppt-edit-toolbar--active {',
      '  transform: translateX(-50%) translateY(0);',
      '  opacity: 1; pointer-events: auto;',
      '}',

      /* ── Badge ───────────────────────────────── */
      '#ppt-edit-toolbar .ppt-edit-badge {',
      '  font-size: 11px; font-weight: 700; letter-spacing: 0.08em;',
      '  color: #fbbf24; margin-right: 8px; white-space: nowrap;',
      '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;',
      '}',

      /* ── Toolbar buttons ─────────────────────── */
      '#ppt-edit-toolbar button {',
      '  background: rgba(255,255,255,0.06);',
      '  border: 1px solid rgba(255,255,255,0.1);',
      '  color: #e2e8f0;',
      '  border-radius: 6px;',
      '  padding: 4px 10px;',
      '  font-size: 13px; font-weight: 600;',
      '  cursor: pointer; line-height: 1.4;',
      '  font-family: inherit;',
      '  transition: background 0.15s, border-color 0.15s;',
      '}',
      '#ppt-edit-toolbar button:hover {',
      '  background: rgba(251,191,36,0.15);',
      '  border-color: rgba(251,191,36,0.4);',
      '  color: #fbbf24;',
      '}',
      '#ppt-edit-toolbar button:active { transform: translateY(1px); }',

      /* Save button accent */
      '#ppt-edit-save {',
      '  background: rgba(59,130,246,0.15) !important;',
      '  border-color: rgba(59,130,246,0.4) !important;',
      '  color: #93c5fd !important;',
      '}',
      '#ppt-edit-save:hover {',
      '  background: rgba(59,130,246,0.3) !important;',
      '  color: #bfdbfe !important;',
      '}',

      /* Exit button */
      '#ppt-edit-exit {',
      '  background: rgba(248,113,113,0.1) !important;',
      '  border-color: rgba(248,113,113,0.3) !important;',
      '  color: #fca5a5 !important;',
      '}',
      '#ppt-edit-exit:hover {',
      '  background: rgba(248,113,113,0.25) !important;',
      '}',

      /* Separator */
      '#ppt-edit-toolbar .ppt-edit-sep {',
      '  width: 1px; height: 18px;',
      '  background: rgba(255,255,255,0.12);',
      '  margin: 0 4px;',
      '}',

      /* ── Label ───────────────────────────────── */
      '#ppt-edit-toolbar .ppt-edit-label {',
      '  font-size: 11px; font-weight: 600; color: #8b9ab3;',
      '  margin: 0 2px 0 6px; white-space: nowrap; cursor: default;',
      '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;',
      '}',

      /* ── Font-size select ────────────────────── */
      '#ppt-edit-fontsize {',
      '  background: rgba(255,255,255,0.08);',
      '  border: 1px solid rgba(255,255,255,0.12);',
      '  color: #e2e8f0;',
      '  border-radius: 6px;',
      '  padding: 3px 6px;',
      '  font-size: 12px; font-weight: 500;',
      '  cursor: pointer;',
      '  font-family: inherit;',
      '  outline: none;',
      '  max-width: 80px;',
      '}',
      '#ppt-edit-fontsize:hover {',
      '  border-color: rgba(251,191,36,0.4);',
      '  background: rgba(251,191,36,0.1);',
      '}',
      '#ppt-edit-fontsize option {',
      '  background: #1c1e26; color: #e2e8f0;',
      '}',

      /* ── Color picker ────────────────────────── */
      '#ppt-edit-color {',
      '  width: 28px; height: 24px;',
      '  border: 1px solid rgba(255,255,255,0.15);',
      '  border-radius: 6px;',
      '  padding: 2px;',
      '  background: rgba(255,255,255,0.06);',
      '  cursor: pointer;',
      '  vertical-align: middle;',
      '  outline: none;',
      '}',
      '#ppt-edit-color:hover {',
      '  border-color: rgba(251,191,36,0.5);',
      '}',

      /* ── Editable element highlight ──────────── */
      '.ppt-editable {',
      '  outline: none !important;',
      '  border-radius: 4px;',
      '  position: relative;',
      '  transition: box-shadow 0.15s;',
      '}',
      '.ppt-edit-mode .ppt-editable {',
      '  box-shadow: 0 0 0 2px rgba(251,191,36,0.25);',
      '  cursor: text;',
      '}',
      '.ppt-edit-mode .ppt-editable:hover {',
      '  box-shadow: 0 0 0 2px rgba(251,191,36,0.55);',
      '}',
      '.ppt-edit-mode .ppt-editable:focus {',
      '  box-shadow: 0 0 0 2px #fbbf24, 0 0 0 4px rgba(251,191,36,0.2);',
      '}',

      /* ── Toast ───────────────────────────────── */
      '#ppt-edit-toast {',
      '  position: fixed; bottom: 28px; left: 50%; transform: translateX(-50%) translateY(8px);',
      '  background: rgba(15,16,20,0.92);',
      '  backdrop-filter: blur(10px);',
      '  border: 1px solid rgba(255,255,255,0.1);',
      '  color: #e2e8f0;',
      '  font-size: 13px; font-weight: 500;',
      '  padding: 8px 20px; border-radius: 999px;',
      '  pointer-events: none; z-index: 9998;',
      '  opacity: 0; transition: opacity 0.3s, transform 0.3s;',
      '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;',
      '}',
      '#ppt-edit-toast.ppt-edit-toast--show {',
      '  opacity: 1; transform: translateX(-50%) translateY(0);',
      '}'
    ].join('\n');
    document.head.appendChild(style);
  }

})();
