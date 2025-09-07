/**
 * ULTIMATE APPLE PROXY - Code.gs
 *
 * Full, restarted, completed file. Aggressive rewriting + injector + resource endpoint.
 *
 * - doGet(e) : serves index.html or proxies a resource when ?url= is present
 * - fetchUrl(url, method, formData) : called by google.script.run, returns rewritten HTML or raw JSON/XML
 * - fetchRaw(url, options) : robust UrlFetchApp wrapper with UA, headers, error handling, Cloudflare retry attempt
 * - rewriteHtml(html, baseUrl) : heavy-duty HTML/CSS/JS rewriting engine
 * - buildInterceptorScript() : "award-winning" client-side injector (fetch, XHR, Worker, MutationObserver, history messaging)
 * - rewriteCssUrls(cssText, cssBaseUrl) : CSS url/@import rewriting
 * - determineMime(contentTypeHeader) : ContentService MIME selection
 * - utilities: escapeHtmlAttr, logv, safeString
 *
 * Put index.html in the project and deploy Web App (Execute as: Me, Who has access: Anyone).
 */

/* =========================
   CONFIG
   ========================= */
var PROXY_CONFIG = {
  INLINE_SMALL_CSS: true,
  INLINE_CSS_MAX_BYTES: 40 * 1024, // 40KB
  USER_AGENT:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139 Safari/537.36 apple-proxy/ultimate',
  LOG_VERBOSE: false,
  TRY_CLOUDFLARE_RETRY: true,
  CLOUDFLARE_RETRY_HEADERS: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9'
  }
};

/* =========================
   UTILITIES
   ========================= */
function logv() {
  if (!PROXY_CONFIG.LOG_VERBOSE) return;
  try {
    var args = Array.prototype.slice.call(arguments);
    Logger.log.apply(null, args);
  } catch (e) {}
}

function escapeHtmlAttr(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function safeString(x) {
  try {
    return x === undefined ? '' : String(x);
  } catch (e) {
    return '';
  }
}

/* =========================
   ENTRYPOINT: doGet
   - resource mode when ?url= is present
   - otherwise returns frontend (index.html)
   ========================= */
function doGet(e) {
  e = e || {};
  var params = e.parameter || {};
  try {
    if (params.url) {
      // Resource proxy mode
      var url = params.url;
      var method = (params.method || 'GET').toUpperCase();
      var payload = params.payload || null;

      var fetched = fetchRaw(url, { method: method, payload: payload });
      var content = fetched.content || '';
      var headers = fetched.headers || {};
      var ctype = (headers['content-type'] || headers['Content-Type'] || '').toLowerCase();

      var mime = determineMime(ctype);

      // For textual types return text output
      if (ctype.indexOf('text/') === 0 || ctype.indexOf('json') !== -1 || ctype.indexOf('xml') !== -1 || ctype.indexOf('html') !== -1) {
        return ContentService.createTextOutput(content).setMimeType(mime);
      } else {
        // For binaries we attempt to return base64 wrapper HTML so browser can show (best-effort)
        try {
          var blob = fetched.rawBlob;
          if (blob) {
            // If fetchRaw provided a Bytes/Blob, return as blob via HtmlService — easier to debug
            var html = '<html><body><h3>Binary resource proxied</h3><p>URL: ' + escapeHtmlAttr(url) + '</p></body></html>';
            return HtmlService.createHtmlOutput(html);
          } else {
            return ContentService.createTextOutput(content).setMimeType(mime);
          }
        } catch (err) {
          return ContentService.createTextOutput(String(content)).setMimeType(mime);
        }
      }
    } else {
      // Serve the frontend UI
      return HtmlService.createHtmlOutputFromFile('index').setTitle('apple proxy');
    }
  } catch (err) {
    return HtmlService.createHtmlOutput('<pre>doGet error: ' + escapeHtmlAttr(String(err)) + '</pre>');
  }
}

/* =========================
   fetchUrl - callable via google.script.run
   - returns rewritten HTML or raw JSON/XML etc.
   ========================= */
function fetchUrl(url, method, formData) {
  method = (method || 'GET').toUpperCase();
  if (!url) return 'No URL provided';

  try {
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

    var options = { method: method };
    if (method === 'POST' && formData) {
      options.payload = formData;
    }

    var fetched = fetchRaw(url, options);
    var content = fetched.content || '';
    var headers = fetched.headers || {};
    var ctype = (headers['content-type'] || headers['Content-Type'] || '').toLowerCase();
    logv('fetchUrl:', url, 'status=', fetched.status, 'ctype=', ctype);

    // JSON or XML -> return raw
    if (ctype.indexOf('application/json') !== -1 || ctype.indexOf('+json') !== -1) return content;
    if (ctype.indexOf('application/xml') !== -1 || ctype.indexOf('text/xml') !== -1) return content;

    // Non-HTML -> return raw (images/fonts can be fetched via ?url= resource endpoint)
    if (ctype && ctype.indexOf('html') === -1) return content;

    // HTML -> rewrite aggressively
    var rewritten = rewriteHtml(content, url);
    return rewritten;
  } catch (err) {
    return '<pre>fetchUrl error: ' + escapeHtmlAttr(String(err)) + '</pre>';
  }
}

/* =========================
   fetchRaw - UrlFetchApp wrapper
   returns: { content: string, headers: object, status: number, rawBlob: Blob|null }
   - tries a Cloudflare "retry" with alternate headers optionally
   ========================= */
function fetchRaw(url, options) {
  options = options || {};
  var method = (options.method || 'GET').toUpperCase();
  var payload = options.payload || null;

  var fetchOptions = {
    muteHttpExceptions: true,
    followRedirects: true,
    method: method,
    headers: {
      'User-Agent': PROXY_CONFIG.USER_AGENT,
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  };

  if (method === 'POST' && payload) {
    fetchOptions.payload = payload;
  }

  try {
    logv('fetchRaw: ', method, url);
    var response = UrlFetchApp.fetch(url, fetchOptions);
    var headers = response.getAllHeaders ? response.getAllHeaders() : (response.getHeaders ? response.getHeaders() : {});
    var status = typeof response.getResponseCode === 'function' ? response.getResponseCode() : 200;

    // Prefer getContentText when likely textual, but guard errors
    var contentText = '';
    try {
      contentText = response.getContentText();
    } catch (e) {
      // binary fallback
      try {
        var bytes = response.getContent();
        contentText = ''; // leave empty (caller can use rawBlob)
      } catch (er) {
        contentText = '';
      }
    }

    var rawBlob = null;
    try { rawBlob = response.getBlob ? response.getBlob() : null; } catch (e) { rawBlob = null; }

    // If Cloudflare-ish error (403/503) and retry enabled, try once with alternate UA
    if (PROXY_CONFIG.TRY_CLOUDFLARE_RETRY && (status === 403 || status === 503)) {
      try {
        logv('fetchRaw: status', status, '- trying CF alternate headers');
        fetchOptions.headers = Object.assign({}, fetchOptions.headers, PROXY_CONFIG.CLOUDFLARE_RETRY_HEADERS);
        var r2 = UrlFetchApp.fetch(url, fetchOptions);
        var headers2 = r2.getAllHeaders ? r2.getAllHeaders() : (r2.getHeaders ? r2.getHeaders() : {});
        var status2 = typeof r2.getResponseCode === 'function' ? r2.getResponseCode() : status;
        var contentText2 = '';
        try { contentText2 = r2.getContentText(); } catch (e) { contentText2 = ''; }
        var rawBlob2 = null;
        try { rawBlob2 = r2.getBlob ? r2.getBlob() : null; } catch (e) { rawBlob2 = null; }
        return { content: contentText2 || contentText, headers: headers2 || headers, status: status2, rawBlob: rawBlob2 || rawBlob };
      } catch (e2) {
        logv('fetchRaw CF retry failed', e2);
      }
    }

    return { content: contentText, headers: headers, status: status, rawBlob: rawBlob };
  } catch (err) {
    logv('fetchRaw fatal', err);
    return { content: '<pre>fetchRaw error: ' + escapeHtmlAttr(String(err)) + '</pre>', headers: {}, status: 500, rawBlob: null };
  }
}

/* =========================
   rewriteHtml: main rewrite engine
   - injects interceptor script (buildInterceptorScript)
   - sets base href
   - rewrites href/src/action/src/etc.
   - rewrites CSS url() and @import (calls rewriteCssUrls)
   - rewrites inline script patterns conservatively
   ========================= */
function rewriteHtml(html, baseUrl) {
  try {
    if (!html) return '';

    var origin = baseUrl.replace(/^(https?:\/\/[^\/]+).*/, "$1");

    var pathnameBase = (function() {
      try {
        var u = new URL(baseUrl);
        var pathname = u.pathname || '/';
        if (!pathname.endsWith('/')) {
          var parts = pathname.split('/');
          parts.pop();
          pathname = parts.join('/') || '/';
        }
        return origin + pathname;
      } catch (e) {
        return origin + '/';
      }
    })();

    // 1) Inject interceptor early into <head>
    var injector = buildInterceptorScript();
    if (/<head[^>]*>/i.test(html)) {
      html = html.replace(/<head([^>]*)>/i, function(match, g1) {
        return '<head' + g1 + '>' + injector;
      });
    } else {
      html = injector + html;
    }

    // 2) Ensure base href exists and points to pathnameBase
    if (!/<base\s+href=/i.test(html)) {
      html = html.replace(/<head([^>]*)>/i, '<head$1><base href="' + escapeHtmlAttr(pathnameBase) + '">');
    } else {
      html = html.replace(/<base\s+href=["'].*?["']\s*>/i, '<base href="' + escapeHtmlAttr(pathnameBase) + '">');
    }

    // helper resolve
    function resolveUrl(raw) {
      try { return new URL(raw, pathnameBase).href; } catch (e) { return raw; }
    }

    // 3) Rewrite href (anchors and link href)
    html = html.replace(/href\s*=\s*["']([^"']*)["']/gi, function(match, href) {
      try {
        if (!href) return match;
        if (/^\s*(javascript:|mailto:|tel:|#)/i.test(href)) return match;
        var abs = resolveUrl(href);
        return 'href="?url=' + encodeURIComponent(abs) + '"';
      } catch (e) { return match; }
    });

    // 4) Rewrite form actions
    html = html.replace(/<form\b([^>]*?)\baction\s*=\s*["']([^"']*)["']/gi, function(match, attrs, action) {
      try {
        if (!action) return match;
        if (/^\s*mailto:/i.test(action)) return match;
        var abs = resolveUrl(action);
        return '<form' + attrs + 'action="?url=' + encodeURIComponent(abs) + '"';
      } catch (e) { return match; }
    });

    // 5) Rewrite script src -> absolute (we let browser fetch script URL; interceptor will handle ajax inside scripts)
    html = html.replace(/<script\b([^>]*?)\bsrc\s*=\s*["']([^"']+)["']/gi, function(match, attrs, src) {
      try {
        if (!src) return match;
        if (/^data:|^blob:/i.test(src)) return match;
        var abs = resolveUrl(src);
        return '<script' + attrs + 'src="' + escapeHtmlAttr(abs) + '"';
      } catch (e) { return match; }
    });

    // 6) Rewrite link rel stylesheets -> optionally inline small CSS or convert href to absolute
    html = html.replace(/<link\b([^>]*?)\bhref\s*=\s*["']([^"']+)["']/gi, function(match, attrs, href) {
      try {
        if (!href) return match;
        if (/^data:|^blob:/i.test(href)) return match;
        var abs = resolveUrl(href);

        // detect stylesheet
        if (/rel\s*=\s*["']?stylesheet["']?/i.test(attrs)) {
          if (PROXY_CONFIG.INLINE_SMALL_CSS) {
            try {
              var cssResp = fetchRaw(abs, { method: 'GET' });
              var ct = (cssResp.headers && (cssResp.headers['content-type'] || cssResp.headers['Content-Type'] || '')).toLowerCase();
              if (cssResp.content && cssResp.content.length < PROXY_CONFIG.INLINE_CSS_MAX_BYTES && /css/.test(ct)) {
                var cssText = cssResp.content;
                cssText = rewriteCssUrls(cssText, abs);
                return '<style>' + cssText + '</style>';
              }
            } catch (e) {
              logv('inline css failed for', abs, e);
            }
          }
          return '<link' + attrs + 'href="' + escapeHtmlAttr(abs) + '"';
        } else {
          return '<link' + attrs + 'href="' + escapeHtmlAttr(abs) + '"';
        }
      } catch (e) { return match; }
    });

    // 7) Rewrite src/data-src/poster attributes (images, media) to absolute (or let browser fetch)
    html = html.replace(/\b(?:src|data-src|poster)\s*=\s*["']([^"']+)["']/gi, function(match, val) {
      try {
        if (!val) return match;
        if (/^data:|^blob:/i.test(val)) return match;
        var abs = resolveUrl(val);
        return match.replace(val, abs);
      } catch (e) { return match; }
    });

    // 8) Rewrite iframe src to route through proxy
    html = html.replace(/<iframe\b([^>]*?)\bsrc\s*=\s*["']([^"']+)["']/gi, function(match, attrs, src) {
      try {
        if (!src) return match;
        var abs = resolveUrl(src);
        return '<iframe' + attrs + 'src="?url=' + encodeURIComponent(abs) + '"';
      } catch (e) { return match; }
    });

    // 9) CSS url(...) in inline style blocks & style attributes
    html = html.replace(/url\(\s*['"]?(?!data:|blob:|https?:\/\/)([^'")]+)['"]?\s*\)/gi, function(match, rel) {
      try {
        var abs = resolveUrl(rel);
        return 'url(' + abs + ')';
      } catch (e) { return match; }
    });

    // 10) CSS @import
    html = html.replace(/@import\s+(?:url\()?['"]?(.*?)['"]?\)?\s*;/gi, function(match, rel) {
      try {
        var abs = resolveUrl(rel);
        return '@import url("' + abs + '");';
      } catch (e) { return match; }
    });

    // 11) Meta refresh
    html = html.replace(/<meta\b([^>]*?)http-equiv\s*=\s*["']?refresh["']?([^>]*?)content\s*=\s*["']\s*\d+\s*;\s*url\s*=\s*([^"']+)["']([^>]*)>/gi, function(match, a, b, urlPart, d) {
      try {
        var rawUrl = urlPart.trim();
        var abs = resolveUrl(rawUrl);
        return match.replace(rawUrl, '?url=' + encodeURIComponent(abs));
      } catch (e) { return match; }
    });

    // 12) Inline <script> body conservative rewrites (fetch/XHR/location string literals)
    html = html.replace(/<script\b(?![^>]*\bsrc\b)([^>]*)>([\s\S]*?)<\/script>/gi, function(match, attrs, body) {
      try {
        var newBody = body;
        // fetch('rel')
        newBody = newBody.replace(/fetch\(\s*(['"])([^'"]+)\1/gi, function(m, q, u) {
          if (/^\s*(https?:|data:|blob:|\?url=)/i.test(u)) return m;
          try { return 'fetch(' + q + resolveUrl(u) + q; } catch (e) { return m; }
        });
        // $.ajax url: 'rel'
        newBody = newBody.replace(/url\s*:\s*(['"])([^'"]+)\1/gi, function(m, q, u) {
          if (/^\s*(https?:|data:|blob:|\?url=)/i.test(u)) return m;
          try { return 'url: ' + q + resolveUrl(u) + q; } catch (e) { return m; }
        });
        // XHR open(...,'rel'...)
        newBody = newBody.replace(/open\(\s*(['"])?(GET|POST|PUT|DELETE|HEAD|OPTIONS)\1\s*,\s*(['"])([^'"]+)\3/gi, function(m, a, method, q, u) {
          if (/^\s*(https?:|data:|blob:|\?url=)/i.test(u)) return m;
          try { return m.replace(u, resolveUrl(u)); } catch (e) { return m; }
        });
        // location.href = 'rel'
        newBody = newBody.replace(/location\.href\s*=\s*(['"])([^'"]+)\1/gi, function(m, q, u) {
          if (/^\s*(https?:|\?url=)/i.test(u)) return m;
          try { return 'location.href = ' + q + resolveUrl(u) + q; } catch (e) { return m; }
        });

        return '<script' + attrs + '>' + newBody + '<\/script>';
      } catch (e) { return match; }
    });

    return html;
  } catch (err) {
    return '<pre>rewriteHtml error: ' + escapeHtmlAttr(String(err)) + '</pre>';
  }
}

/* =========================
   buildInterceptorScript - "award-winning" injector string
   - Included features:
     * fetch wrapper (handles Request object)
     * XMLHttpRequest wrapper
     * Worker/SharedWorker wrapper
     * EventSource wrapper
     * MutationObserver -> rewrites dynamically added elements
     * createElement and Element.setAttribute patch
     * history.pushState/replaceState messaging
     * postMessage hooks so parent UI can capture SPA navigation and form posts
     * graceful fallbacks and debug toggle
   ========================= */
function buildInterceptorScript() {
  // Use template string for readability
  var script = `
<script>
(function(){
  'use strict';
  var __DEBUG = false;
  function dbg(){ if(__DEBUG) try{ console.log.apply(console, arguments); }catch(e){} }
  function safeAbs(u){ try{ return new URL(u, location.href).href; } catch(e){ return u; } }
  function proxyPrefix(u){ try{ return '?url=' + encodeURIComponent(safeAbs(u)); } catch(e){ return '?url=' + encodeURIComponent(u); } }
  function isDataOrBlob(u){ return /^data:|^blob:/i.test(u); }
  function shouldRewriteUrl(u){ if(!u||typeof u!=='string') return false; if(isDataOrBlob(u)) return false; if(/^\\?url=/.test(u)) return false; if(/^https?:\\/\\//i.test(u)) return true; return true; }

  var S_ORIG = Symbol('orig');

  // FETCH
  if (!window[Symbol.for('proxy_fetch_patched')]) {
    window[Symbol.for('proxy_fetch_patched')] = true;
    dbg('patch fetch');
    var _fetch = window.fetch;
    try {
      window.fetch = function(input, init){
        try {
          if (input && typeof input === 'object' && input.url) {
            var req = input;
            var newUrl = proxyPrefix(req.url);
            var rInit = {
              method: req.method,
              headers: req.headers,
              body: req.body,
              mode: req.mode,
              credentials: req.credentials,
              cache: req.cache,
              redirect: req.redirect,
              referrer: req.referrer,
              integrity: req.integrity
            };
            return _fetch.call(this, newUrl, rInit);
          }
          if (typeof input === 'string') {
            if (shouldRewriteUrl(input)) input = proxyPrefix(input);
          }
        } catch(e){ dbg('fetch wrapper error', e); }
        return _fetch.call(this, input, init);
      };
      Object.defineProperty(window.fetch, 'name', { value: 'fetch' });
    } catch(e){ dbg('failed to patch fetch', e); }
  }

  // XHR
  if (!window[Symbol.for('proxy_xhr_patched')]) {
    window[Symbol.for('proxy_xhr_patched')] = true;
    dbg('patch XHR');
    var OrigXHR = window.XMLHttpRequest;
    function ProxiedXHR(){
      var xhr = new OrigXHR();
      var origOpen = xhr.open;
      xhr.open = function(method, url){
        try { if (shouldRewriteUrl(url)) url = proxyPrefix(url); } catch(e){ dbg('xhr rewrite error', e); }
        return origOpen.apply(this, arguments);
      };
      return xhr;
    }
    try { ProxiedXHR.prototype = OrigXHR.prototype; window.XMLHttpRequest = ProxiedXHR; } catch(e){ dbg('xhr patch fail', e); }
  }

  // Worker / SharedWorker
  try {
    if (window.Worker && !window.Worker[S_ORIG]) {
      dbg('patch Worker');
      var OrigWorker = window.Worker;
      function ProxyWorker(scriptURL, opts){ var rewritten = scriptURL; try{ if(shouldRewriteUrl(scriptURL)) rewritten = proxyPrefix(scriptURL); }catch(e){} return new OrigWorker(rewritten, opts); }
      ProxyWorker.prototype = OrigWorker.prototype; ProxyWorker[S_ORIG] = OrigWorker; window.Worker = ProxyWorker;
    }
    if (window.SharedWorker && !window.SharedWorker[S_ORIG]) {
      dbg('patch SharedWorker');
      var OrigSharedWorker = window.SharedWorker;
      function ProxySharedWorker(scriptURL, name){ var rewritten = scriptURL; try{ if(shouldRewriteUrl(scriptURL)) rewritten = proxyPrefix(scriptURL); }catch(e){} return new OrigSharedWorker(rewritten, name); }
      ProxySharedWorker.prototype = OrigSharedWorker.prototype; ProxySharedWorker[S_ORIG] = OrigSharedWorker; window.SharedWorker = ProxySharedWorker;
    }
  } catch(e){ dbg('worker patch fail', e); }

  // EventSource
  try {
    if (window.EventSource && !window.EventSource[S_ORIG]) {
      dbg('patch EventSource');
      var OrigES = window.EventSource;
      function ProxyES(url, opts){ var rewritten = url; try{ if(shouldRewriteUrl(url)) rewritten = proxyPrefix(url); }catch(e){} return new OrigES(rewritten, opts); }
      ProxyES.prototype = OrigES.prototype; ProxyES[S_ORIG] = OrigES; window.EventSource = ProxyES;
    }
  } catch(e){ dbg('EventSource fail', e); }

  // createElement & setAttribute & MutationObserver
  (function(){
    dbg('patch createElement/setAttribute and observe mutations');
    var OrigCreate = Document.prototype.createElement;
    Document.prototype.createElement = function(tagName){
      var el = OrigCreate.call(this, tagName);
      var origSet = el.setAttribute;
      el.setAttribute = function(name, value){
        try { if ((name==='src'||name==='href') && value && shouldRewriteUrl(value)) value = proxyPrefix(value); } catch(e){ dbg('setAttr rewrite', e); }
        return origSet.call(this, name, value);
      };
      return el;
    };

    var origElSet = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function(name, value){
      try { if ((name==='src'||name==='href') && value && shouldRewriteUrl(value)) value = proxyPrefix(value); } catch(e){ dbg('Element.setAttr', e); }
      return origElSet.call(this, name, value);
    };

    var mo = new MutationObserver(function(records){
      records.forEach(function(rec){
        (rec.addedNodes || []).forEach(function(node){
          try {
            if (!node || !node.nodeType) return;
            if (node.nodeType === 1) {
              var tag = node.tagName.toLowerCase();
              if (tag === 'a') {
                try { var h = node.getAttribute('href'); if (h && shouldRewriteUrl(h)) node.setAttribute('href', proxyPrefix(h)); } catch(e){}
                node.addEventListener('click', function(ev){ try{ ev.preventDefault(); window.parent.postMessage({ type:'proxy:navigation', url: new URL(node.href, location.href).href }, '*'); }catch(e){} });
              }
              if (tag === 'script') { try { var s = node.getAttribute('src'); if (s && shouldRewriteUrl(s)) node.setAttribute('src', proxyPrefix(s)); } catch(e){} }
              if (tag === 'link') { try { var l = node.getAttribute('href'); if (l && shouldRewriteUrl(l)) node.setAttribute('href', proxyPrefix(l)); } catch(e){} }
              if (tag === 'iframe') { try { var f = node.getAttribute('src'); if (f && shouldRewriteUrl(f)) node.setAttribute('src', proxyPrefix(f)); } catch(e){} }
              if (tag === 'img') { try { var i = node.getAttribute('src'); if (i && shouldRewriteUrl(i)) node.setAttribute('src', proxyPrefix(i)); } catch(e){} node.addEventListener('error', function(){ try{ node.src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAQAAACEN3D/AAAAFklEQVR42mNkYGD4z0ABYBwVSFUAANAGCgQKoPYAAAAASUVORK5CYII='; }catch(e){} }, true); }
              if (tag === 'form') {
                try {
                  var act = node.getAttribute('action') || location.href;
                  if (act && shouldRewriteUrl(act)) node.setAttribute('action', proxyPrefix(act));
                  node.addEventListener('submit', function(ev){ try{ ev.preventDefault(); var fd=new FormData(node); var obj={}; fd.forEach(function(v,k){ obj[k]=v; }); window.parent.postMessage({ type:'proxy:form', url: node.action, method: (node.method||'GET').toUpperCase(), payload: obj }, '*'); }catch(e){} });
                } catch(e){}
              }
            }
          } catch(e){ dbg('mutation node error', e); }
        });
      });
    });
    try { mo.observe(document, { childList:true, subtree:true }); } catch(e){ dbg('mo observe fail', e); }
  })();

  // history + SPA messaging
  (function(){
    dbg('patch history methods');
    var origPush = history.pushState;
    var origReplace = history.replaceState;
    history.pushState = function(state, title, url){
      try { if (shouldRewriteUrl(url)) window.parent.postMessage({ type:'proxy:pushState', url: new URL(url, location.href).href }, '*'); } catch(e){}
      return origPush.apply(this, arguments);
    };
    history.replaceState = function(state, title, url){
      try { if (shouldRewriteUrl(url)) window.parent.postMessage({ type:'proxy:replaceState', url: new URL(url, location.href).href }, '*'); } catch(e){}
      return origReplace.apply(this, arguments);
    };
    window.addEventListener('popstate', function(){ try{ window.parent.postMessage({ type:'proxy:popstate', url: location.href }, '*'); } catch(e){} });
  })();

  // parent control messages
  window.addEventListener('message', function(ev){
    try {
      var d = ev.data || {};
      if (d && d.type === 'proxy:reload') location.reload();
      if (d && d.type === 'proxy:navigate' && d.url) location.assign(d.url);
    } catch(e){ dbg('parent message handler', e); }
  });

  // WebSocket: warn (can't proxy reliably)
  (function(){
    var OrigWS = window.WebSocket;
    if (OrigWS && !OrigWS[S_ORIG]) {
      Object.defineProperty(window, 'WebSocket', {
        configurable: true, enumerable: true, writable: true,
        value: function(url, protocols){ console.warn('WebSocket created, may bypass proxy or fail', url); return new OrigWS(url, protocols); }
      });
    }
  })();

  dbg('proxy injection complete');
})();
</script>
`;
  return script;
}

/* =========================
   rewriteCssUrls: convert relative CSS urls to absolute based on cssBaseUrl
   - rewrites url(...) and @import inside CSS text
   ========================= */
function rewriteCssUrls(cssText, cssBaseUrl) {
  try {
    if (!cssText) return cssText;
    var cssBase = cssBaseUrl.replace(/^(https?:\/\/[^\/]+).*/, "$1");
    try {
      var u = new URL(cssBaseUrl);
      var parts = u.pathname.split('/');
      if (!cssBaseUrl.endsWith('/')) parts.pop();
      var path = parts.join('/');
      if (!path) path = '/';
      cssBase = cssBase + path;
    } catch (e) {}

    function resolveCssUrl(rel) {
      try { return new URL(rel, cssBase).href; } catch (e) { return rel; }
    }

    cssText = cssText.replace(/url\(\s*['"]?(?!data:|blob:|https?:\/\/)([^'")]+)['"]?\s*\)/gi, function(m, rel) {
      return 'url(' + resolveCssUrl(rel) + ')';
    });

    cssText = cssText.replace(/@import\s+(?:url\()?['"]?(.*?)['"]?\)?\s*;/gi, function(m, rel) {
      var abs = resolveCssUrl(rel);
      return '@import url("' + abs + '");';
    });

    return cssText;
  } catch (e) {
    return cssText;
  }
}

/* =========================
   determineMime - map content-type header to ContentService.MimeType
   ========================= */
function determineMime(contentTypeHeader) {
  var ct = String(contentTypeHeader || '').toLowerCase();
  if (ct.indexOf('application/json') !== -1 || ct.indexOf('+json') !== -1) return ContentService.MimeType.JSON;
  if (ct.indexOf('text/html') !== -1 || ct.indexOf('html') !== -1) return ContentService.MimeType.HTML;
  if (ct.indexOf('xml') !== -1) return ContentService.MimeType.XML;
  if (ct.indexOf('text/') === 0) return ContentService.MimeType.TEXT;
  return ContentService.MimeType.TEXT;
}

/* =========================
   END OF FILE
   ========================= */
