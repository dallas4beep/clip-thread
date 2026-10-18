/*!
 * Clipthread Video Wall embed — zero dependencies, ~8 KB minified.
 *
 *   <div data-clipthread-wall="customer-stories"></div>
 *   <script src="https://YOUR_APP/embed.js" async></script>
 *
 * Or a single tag (the wall renders right after the script):
 *   <script src="https://YOUR_APP/embed.js" data-wall="customer-stories" data-layout="carousel" async></script>
 *
 * Options (data-* attributes on the container or the script tag):
 *   data-layout       grid | carousel                 (default grid)
 *   data-limit        1..60                           (default 12)
 *   data-columns      min card width in px for grid   (default 260)
 *   data-captions     on | off  (captions shown by default)
 *   data-title        override heading; "none" hides it
 *   data-primary-color, data-background-color, data-text-color, data-radius, data-font-family
 *   data-api          API origin (defaults to the origin embed.js was loaded from)
 *
 * JS API: window.ClipthreadWall.mount(element, { wall: "slug", layout: "grid", ... })
 */
(function () {
  "use strict";
  if (window.ClipthreadWall && window.ClipthreadWall.__loaded) return;

  var script = document.currentScript;
  var DEFAULT_API = script && script.src ? new URL(script.src, location.href).origin : location.origin;

  var CSS =
    ":host{all:initial;display:block;font-family:var(--ct-font);color:var(--ct-text);}" +
    "*,*::before,*::after{box-sizing:border-box;}" +
    ".wall{background:var(--ct-bg);padding:8px 0;}" +
    ".title{font-size:1.5rem;font-weight:700;margin:0 0 16px;line-height:1.2;}" +
    ".grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(min(var(--ct-col),100%),1fr));}" +
    ".carousel{position:relative;}" +
    ".track{display:flex;gap:16px;overflow-x:auto;scroll-snap-type:x mandatory;scroll-behavior:smooth;padding-bottom:6px;scrollbar-width:thin;}" +
    ".track>.card{flex:0 0 min(300px,80%);scroll-snap-align:start;}" +
    ".nav{position:absolute;top:calc(50% - 40px);width:40px;height:40px;border-radius:50%;border:0;background:rgba(255,255,255,.92);color:#111;box-shadow:0 2px 10px rgba(0,0,0,.2);cursor:pointer;font-size:20px;line-height:40px;display:grid;place-items:center;}" +
    ".nav:disabled{opacity:0;pointer-events:none;}.prev{left:-8px;}.next{right:-8px;}" +
    ".card{display:flex;flex-direction:column;background:var(--ct-card);border-radius:var(--ct-radius);overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08),0 1px 2px rgba(0,0,0,.04);border:1px solid rgba(127,127,127,.15);text-align:left;font:inherit;color:inherit;padding:0;cursor:pointer;transition:transform .15s,box-shadow .15s;}" +
    ".card:hover{transform:translateY(-2px);box-shadow:0 8px 24px rgba(0,0,0,.12);}" +
    ".card:focus-visible{outline:3px solid var(--ct-primary);outline-offset:2px;}" +
    ".thumb{position:relative;aspect-ratio:16/9;background:#111 center/cover no-repeat;}" +
    ".play{position:absolute;inset:0;margin:auto;width:56px;height:56px;border-radius:50%;background:var(--ct-primary);display:grid;place-items:center;box-shadow:0 4px 14px rgba(0,0,0,.3);}" +
    ".play::after{content:'';margin-left:4px;border-style:solid;border-width:10px 0 10px 16px;border-color:transparent transparent transparent #fff;}" +
    ".dur{position:absolute;right:8px;bottom:8px;background:rgba(0,0,0,.72);color:#fff;font-size:12px;padding:2px 6px;border-radius:4px;}" +
    ".body{padding:12px 14px 14px;display:flex;flex-direction:column;gap:6px;}" +
    ".quote{margin:0;font-size:.92rem;line-height:1.45;opacity:.85;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;}" +
    ".who{font-weight:600;font-size:.95rem;}.aff{font-size:.85rem;opacity:.65;}" +
    ".empty,.error{padding:24px;text-align:center;opacity:.7;}" +
    ".modal{position:fixed;inset:0;z-index:2147483646;background:rgba(10,10,15,.85);display:flex;align-items:center;justify-content:center;padding:16px;animation:fade .15s;}" +
    "@keyframes fade{from{opacity:0}to{opacity:1}}" +
    ".dialog{position:relative;width:min(1000px,100%);}" +
    ".dialog video{width:100%;max-height:80vh;border-radius:var(--ct-radius);background:#000;display:block;}" +
    ".close{position:absolute;top:-44px;right:0;width:36px;height:36px;border:0;border-radius:50%;background:rgba(255,255,255,.15);color:#fff;font-size:20px;cursor:pointer;}" +
    ".close:focus-visible{outline:3px solid #fff;}" +
    ".caption{color:#fff;margin-top:10px;font-size:.95rem;}" +
    "@media (prefers-reduced-motion:reduce){.card,.track{transition:none;scroll-behavior:auto;}.modal{animation:none;}}";

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k) || attrs[k] == null) continue;
        if (k === "className") node.className = attrs[k];
        else if (k === "text") node.textContent = attrs[k];
        else if (k.slice(0, 2) === "on") node.addEventListener(k.slice(2), attrs[k]);
        else node.setAttribute(k, attrs[k]);
      }
    }
    (children || []).forEach(function (c) {
      if (c) node.appendChild(c);
    });
    return node;
  }

  function fmt(s) {
    s = Math.round(s || 0);
    return Math.floor(s / 60) + ":" + ("0" + (s % 60)).slice(-2);
  }

  function readOptions(node, base) {
    var d = node.dataset || {};
    var o = base || {};
    var map = {
      wall: d.clipthreadWall || d.wall,
      layout: d.layout,
      limit: d.limit,
      columns: d.columns,
      captions: d.captions,
      title: d.title,
      api: d.api,
      primaryColor: d.primaryColor,
      backgroundColor: d.backgroundColor,
      textColor: d.textColor,
      radius: d.radius,
      fontFamily: d.fontFamily,
    };
    for (var k in map) if (map[k] != null && map[k] !== "") o[k] = map[k];
    return o;
  }

  // Captions: fetch the VTT and attach as a blob: URL. A cross-origin <track>
  // would require CORS on the video itself; a blob URL is always same-origin.
  var vttCache = {};
  function loadCaptions(url) {
    if (!vttCache[url]) {
      vttCache[url] = fetch(url)
        .then(function (r) {
          if (!r.ok) throw new Error("captions " + r.status);
          return r.text();
        })
        .then(function (text) {
          return URL.createObjectURL(new Blob([text], { type: "text/vtt" }));
        })
        .catch(function () {
          delete vttCache[url];
          return null;
        });
    }
    return vttCache[url];
  }

  function Wall(host, opts) {
    this.host = host;
    this.opts = opts;
    this.api = (opts.api || DEFAULT_API).replace(/\/$/, "");
    this.root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
    this.lastFocus = null;
    this.onKey = this.onKey.bind(this);
  }

  Wall.prototype.applyTheme = function (b) {
    var o = this.opts;
    var s = this.host.style;
    s.setProperty("--ct-primary", o.primaryColor || b.primaryColor || "#4f46e5");
    s.setProperty("--ct-bg", o.backgroundColor || b.backgroundColor || "transparent");
    s.setProperty("--ct-card", o.backgroundColor || b.backgroundColor || "#fff");
    s.setProperty("--ct-text", o.textColor || b.textColor || "#0f172a");
    s.setProperty("--ct-radius", (o.radius != null ? o.radius : b.radius != null ? b.radius : 14) + "px");
    s.setProperty("--ct-font", o.fontFamily || b.fontFamily || "system-ui, -apple-system, Segoe UI, Roboto, sans-serif");
    s.setProperty("--ct-col", (parseInt(o.columns, 10) || 260) + "px");
  };

  Wall.prototype.load = function () {
    var self = this;
    var limit = Math.min(Math.max(parseInt(this.opts.limit, 10) || 12, 1), 60);
    var url = this.api + "/api/public/walls/" + encodeURIComponent(this.opts.wall) + "?limit=" + limit;
    this.root.innerHTML = "";
    this.root.appendChild(el("style", { text: CSS }));
    var container = el("div", { className: "wall", part: "wall" });
    this.root.appendChild(container);
    return fetch(url, { credentials: "omit" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        self.data = data;
        self.applyTheme((data.wall && data.wall.branding) || {});
        self.render(container, data);
        self.host.dispatchEvent(new CustomEvent("clipthread:loaded", { detail: { count: data.videos.length } }));
      })
      .catch(function (err) {
        self.applyTheme({});
        container.appendChild(el("div", { className: "error", text: "Videos could not be loaded." }));
        if (window.console) console.warn("[clipthread] " + err.message);
      });
  };

  Wall.prototype.card = function (v) {
    var self = this;
    var thumb = el("div", { className: "thumb", part: "thumb" }, [
      el("span", { className: "play", "aria-hidden": "true" }),
      v.durationSeconds ? el("span", { className: "dur", text: fmt(v.durationSeconds) }) : null,
    ]);
    if (v.posterUrl) thumb.style.backgroundImage = 'url("' + v.posterUrl.replace(/"/g, "%22") + '")';
    var label = "Play video" + (v.name ? " from " + v.name : "");
    return el("button", { type: "button", className: "card", part: "card", "aria-label": label, onclick: function (e) { self.open(v, e.currentTarget); } }, [
      thumb,
      el("div", { className: "body" }, [
        v.excerpt ? el("p", { className: "quote", text: "“" + v.excerpt + "”" }) : null,
        v.name ? el("span", { className: "who", text: v.name }) : null,
        v.affiliation ? el("span", { className: "aff", text: v.affiliation }) : null,
      ]),
    ]);
  };

  Wall.prototype.render = function (container, data) {
    var self = this;
    var title = this.opts.title || (data.wall && data.wall.title);
    if (title && title !== "none") container.appendChild(el("h2", { className: "title", part: "title", text: title }));
    if (!data.videos.length) {
      container.appendChild(el("div", { className: "empty", text: "No videos yet." }));
      return;
    }
    var cards = data.videos.map(function (v) {
      return self.card(v);
    });

    if (this.opts.layout === "carousel") {
      var track = el("div", { className: "track", role: "list" }, cards);
      var prev = el("button", { type: "button", className: "nav prev", "aria-label": "Previous", text: "‹" });
      var next = el("button", { type: "button", className: "nav next", "aria-label": "Next", text: "›" });
      var step = function (dir) {
        track.scrollBy({ left: dir * track.clientWidth * 0.9 });
      };
      var sync = function () {
        prev.disabled = track.scrollLeft <= 4;
        next.disabled = track.scrollLeft + track.clientWidth >= track.scrollWidth - 4;
      };
      prev.addEventListener("click", function () { step(-1); });
      next.addEventListener("click", function () { step(1); });
      track.addEventListener("scroll", sync, { passive: true });
      container.appendChild(el("div", { className: "carousel" }, [track, prev, next]));
      requestAnimationFrame(sync);
      if (window.ResizeObserver) new ResizeObserver(sync).observe(track);
    } else {
      container.appendChild(el("div", { className: "grid", role: "list" }, cards));
    }
  };

  Wall.prototype.open = function (v, trigger) {
    var self = this;
    this.close();
    this.lastFocus = trigger || null;
    var video = el("video", { controls: "", playsinline: "", autoplay: "", preload: "auto", src: v.videoUrl, poster: v.posterUrl });
    var closeBtn = el("button", { type: "button", className: "close", "aria-label": "Close video", text: "×", onclick: function () { self.close(); } });
    var caption = v.name ? el("div", { className: "caption", text: v.name + (v.affiliation ? " · " + v.affiliation : "") }) : null;
    var modal = el("div", {
      className: "modal",
      part: "modal",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": v.name ? "Video from " + v.name : "Video",
      onclick: function (e) { if (e.target === modal) self.close(); },
    }, [el("div", { className: "dialog" }, [closeBtn, video, caption])]);

    if (v.captionsUrl) {
      loadCaptions(v.captionsUrl).then(function (blobUrl) {
        if (!blobUrl || !video.isConnected) return;
        var track = el("track", { kind: "captions", src: blobUrl, srclang: (v.language || "en").slice(0, 2), label: "Captions" });
        if (self.opts.captions !== "off") track.setAttribute("default", "");
        video.appendChild(track);
        if (self.opts.captions !== "off" && video.textTracks[0]) video.textTracks[0].mode = "showing";
      });
    }

    this.modal = modal;
    this.prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    this.root.appendChild(modal);
    document.addEventListener("keydown", this.onKey, true);
    closeBtn.focus();
    var p = video.play();
    if (p && p.catch) p.catch(function () {}); // autoplay may be blocked; controls remain
  };

  Wall.prototype.onKey = function (e) {
    if (!this.modal) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      this.close();
    } else if (e.key === "Tab") {
      // Minimal focus trap: keep focus on close button / video.
      var focusables = this.modal.querySelectorAll("button, video");
      var first = focusables[0];
      var last = focusables[focusables.length - 1];
      var active = this.root.activeElement || document.activeElement;
      if (e.shiftKey && active === first) { last.focus(); e.preventDefault(); }
      else if (!e.shiftKey && active === last) { first.focus(); e.preventDefault(); }
    }
  };

  Wall.prototype.close = function () {
    if (!this.modal) return;
    var v = this.modal.querySelector("video");
    if (v) {
      v.pause();
      v.removeAttribute("src");
      v.load();
    }
    this.modal.remove();
    this.modal = null;
    document.documentElement.style.overflow = this.prevOverflow || "";
    document.removeEventListener("keydown", this.onKey, true);
    if (this.lastFocus && this.lastFocus.focus) this.lastFocus.focus();
  };

  function mount(host, options) {
    if (!host || host.__clipthread) return host && host.__clipthread;
    var opts = readOptions(host, Object.assign({}, options || {}));
    if (!opts.wall) {
      if (window.console) console.warn("[clipthread] missing data-clipthread-wall on", host);
      return null;
    }
    var wall = new Wall(host, opts);
    host.__clipthread = wall;
    // Lazy-load when scrolled near the viewport.
    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(function (entries) {
        if (entries.some(function (e) { return e.isIntersecting; })) {
          io.disconnect();
          wall.load();
        }
      }, { rootMargin: "400px" });
      io.observe(host);
    } else {
      wall.load();
    }
    return wall;
  }

  function autoMount() {
    var nodes = document.querySelectorAll("[data-clipthread-wall]");
    for (var i = 0; i < nodes.length; i++) mount(nodes[i]);
    // Single-tag usage: <script data-wall="slug">
    if (script && script.dataset.wall && !script.__clipthreadMounted) {
      script.__clipthreadMounted = true;
      var host = document.createElement("div");
      script.parentNode.insertBefore(host, script.nextSibling);
      mount(host, readOptions(script, {}));
    }
  }

  window.ClipthreadWall = { mount: mount, __loaded: true };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", autoMount);
  else autoMount();
})();
