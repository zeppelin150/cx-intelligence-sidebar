/* Guru card reader — runs inside the ZAF modal instance the sidebar creates
   via instances.create. Boots instantly from a JSON payload in the URL hash
   (mode, parent instance GUID, ticket id, normalized card); in live mode it
   refreshes the card from /cards/{id}/extended and loads comments through the
   same secure-proxy pattern as the sidebar. Actions that must run in the
   ticket-scoped instance (insert into reply, guru_used tag, recents sync)
   relay to the parent sidebar by GUID: parent listens with client.on(...).
   Pins/recents write localStorage directly — both iframes share the app's
   asset origin. Keep esc/safeGuruContent in sync with assets/app.js. */
(function () {
  var client = (typeof ZAFClient !== "undefined") ? ZAFClient.init() : null;

  var payload = {};
  try { payload = JSON.parse(decodeURIComponent(location.hash.slice(1)) || "{}"); } catch (e) {}
  var mode = payload.mode === "live" ? "live" : "demo";
  var parentGuid = payload.parent || "";
  var ticketId = payload.ticketId || "";
  var card = payload.card || { id: "", title: "Guru card", content: "" };
  var debug = !!payload.debug;   // captured at open time; a live toggle won't affect an already-open modal

  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  // Mirror of the sidebar's sanitizer (see assets/app.js safeGuruContent).
  function safeGuruContent(html) {
    var d = document.createElement("div"); d.innerHTML = String(html || "");
    Array.prototype.forEach.call(d.querySelectorAll("script,style,iframe,object,embed,link,base,meta"), function (n) { n.parentNode && n.parentNode.removeChild(n); });
    var URLISH = ["href", "xlink:href", "src", "action", "formaction", "data"];
    Array.prototype.forEach.call(d.querySelectorAll("*"), function (n) {
      Array.prototype.slice.call(n.attributes).forEach(function (a) {
        var name = a.name.toLowerCase();
        if (/^on/.test(name)) { n.removeAttribute(a.name); return; }
        if (URLISH.indexOf(name) > -1) {
          var v = String(a.value).replace(/[\u0000-\u0020\u007F-\u009F]+/g, "");
          var m = /^([a-z][a-z0-9+.\-]*):/i.exec(v);
          if (m) {
            var scheme = m[1].toLowerCase();
            var ok = scheme === "http" || scheme === "https" || scheme === "mailto" || scheme === "tel" ||
                     (scheme === "data" && /^data:image\//i.test(v));
            if (!ok) n.removeAttribute(a.name);
          }
        }
      });
    });
    return d.innerHTML;
  }
  function timeAgo(v) {
    if (!v) return "";
    if (!/\d{4}-/.test(String(v))) return String(v);
    var d = Math.floor((Date.now() - new Date(v).getTime()) / 86400000);
    if (isNaN(d) || d < 0) return "";
    return d === 0 ? "today" : d + "d ago";
  }
  function badge(c) {
    if (c.verificationState === "TRUSTED") return '<span class="gv-badge gv-ok">✓ Verified</span>';
    if (c.verificationState) return '<span class="gv-badge gv-warn">⚠ Needs verification</span>';
    return "";
  }
  function relay(evt, data) {
    try { if (client && parentGuid && client.instance) client.instance(parentGuid).trigger(evt, data || {}); } catch (e) {}
  }
  // Cold-start serialization — mirror of app.js guruDispatch. The reader fires a
  // couple of proxied calls when a card opens (/extended then /comments); electing
  // one "leader" to warm the Zendesk session avoids each one popping its own login
  // prompt. Lone steady-state calls dispatch immediately.
  var guruLeader = null;
  function guruDispatch(req) {
    if (guruLeader) {
      var after = function () { return client.request(req); };
      return guruLeader.then(after, after);
    }
    var lead = client.request(req);
    guruLeader = lead;
    var clear = function () { if (guruLeader === lead) guruLeader = null; };
    lead.then(clear, clear);
    return lead;
  }
  function guruApi(path, opts) {
    var req = { url: "https://api.getguru.com/api/v1" + path, type: (opts && opts.type) || "GET",
      headers: { Authorization: "Basic {{setting.guru_auth}}", "X-Guru-Application": "zendesk-cx-sidebar" },
      secure: true, cors: false, dataType: "json" };
    if (opts && opts.subtype) req.headers["X-Guru-ActivitySubType"] = opts.subtype;
    if (opts && opts.data) { req.data = JSON.stringify(opts.data); req.contentType = "application/json"; }
    var _m = req.type, _p = path, _sub = (opts && opts.subtype) || "";
    var _prom = guruDispatch(req);
    if (!debug) return _prom;
    return _prom.then(function (r) { guruLog(_m, _p, _sub, "ok", r, null); return r; },
                      function (e) { guruLog(_m, _p, _sub, "err", null, e); throw e; });
  }
  // Duplicate of app.js guruLog — this modal is a separate iframe/window with its own
  // guruApi, so window.__guruDebug here is a SEPARATE buffer (select this frame in the
  // DevTools context dropdown to inspect it). Same redaction guarantee. Never throws.
  function guruLog(method, path, subtype, phase, body, err) {
    try {
      if (!window.__guruDebug) window.__guruDebug = [];
      window.__guruDebug.push({ t: new Date().toISOString(), method: method, path: path, subtype: subtype || "", phase: phase,
        status: (err && err.status) || (phase === "ok" ? 200 : 0), body: (phase === "ok" ? body : null),
        error: (phase === "err" && err) ? { status: err.status, responseJSON: err.responseJSON, responseText: err.responseText, message: err.message } : null });
      while (window.__guruDebug.length > 50) window.__guruDebug.shift();
      var label = "[GURU:modal] " + method + " " + path + (subtype ? " (" + subtype + ")" : "") + "  " + (phase === "ok" ? "✓ OK" : "✗ ERR " + ((err && err.status) || ""));
      var g = window.console || {};
      (g.groupCollapsed ? g.groupCollapsed : g.log).call(g, label);
      if (phase === "ok") { g.log(JSON.stringify(body, null, 2)); }
      else { g.log("status:", (err && err.status)); g.log(err && (err.responseJSON ? JSON.stringify(err.responseJSON, null, 2) : (err.responseText || err.message || "request failed"))); }
      if (g.groupEnd) g.groupEnd();
    } catch (x) {}
  }
  function normalize(c, fallbackId) {
    c = c || {};
    var by = c.lastVerifiedBy || {};
    var colName = "";
    if (c.collection) colName = (typeof c.collection === "string") ? c.collection : (c.collection.name || c.collection.title || "");
    return { id: c.id || fallbackId || "", title: c.preferredPhrase || c.title || "Guru card", content: c.content || "",
      verificationState: String(c.verificationState || "").toUpperCase(),
      lastVerified: c.lastVerified || c.lastVerifiedDate || c.dateLastVerified || "",
      verifier: ((by.firstName || "") + " " + (by.lastName || "")).trim() || by.email ||
                (typeof c.lastVerifiedBy === "string" ? c.lastVerifiedBy : "") || c.verifier || "",
      collection: colName,
      slug: c.slug || "" };
  }

  // Pins live in shared localStorage (same asset origin as the sidebar).
  function pins() { try { return JSON.parse(localStorage.getItem("cxsidebar.guru.pins")) || []; } catch (e) { return []; } }
  function isPinned(id) { return pins().some(function (p) { return p.id === id; }); }
  function togglePin(id, title) {
    var cur = pins();
    var next = cur.filter(function (p) { return p.id !== id; });
    var nowPinned = next.length === cur.length;
    if (nowPinned) next.unshift({ id: id, title: title });
    try { localStorage.setItem("cxsidebar.guru.pins", JSON.stringify(next)); } catch (e) {}
    relay("guru.sync");
    return nowPinned;
  }

  function setHint(text, tone) {
    var h = el("m-hint"); if (!h) return;
    h.textContent = text || "";
    h.style.color = tone === "ok" ? "var(--ok)" : (tone === "err" ? "var(--danger)" : "var(--muted)");
  }
  function commentHTML(c) {
    var o = c.owner || c.user || {};
    var who = ((o.firstName || "") + " " + (o.lastName || "")).trim() || o.email || "Guru user";
    return '<div class="cmt"><div class="cmt-head"><span class="cmt-who">' + esc(who) + '</span><span class="cmt-when">' + esc(timeAgo(c.dateCreated || c.createdDate || "")) + "</span></div>" +
      '<div class="cmt-text">' + safeGuruContent(c.content) + "</div></div>";
  }

  function render() {
    el("m-title").textContent = card.title;
    var trusted = card.verificationState === "TRUSTED";
    var vAction = trusted
      ? '<button class="btn small" type="button" data-verify="0">Unverify</button>'
      : '<button class="btn small primary" type="button" data-verify="1">Verify</button>';
    var vWhen = card.lastVerified ? " · " + esc(timeAgo(card.lastVerified)) : "";
    var vWho = card.verifier ? " by " + esc(card.verifier) : "";
    var openLink = (mode === "live" && card.slug)
      ? '<a class="btn small" href="https://app.getguru.com/card/' + esc(card.slug) + '" target="_blank" rel="noopener">Open in Guru ↗</a>'
      : "";
    el("m-body").innerHTML = '<div class="guru-card">' +
      '<div class="guru-vbar"><span class="guru-vbar-state">' + (badge(card) || '<span class="gv-badge gv-warn">Verification unknown</span>') + vWhen + vWho + "</span>" + vAction + "</div>" +
      '<div class="guru-actions">' +
        '<button class="btn primary" type="button" data-insert>Insert into reply</button>' +
        '<button class="btn" type="button" data-copy>Copy</button>' + openLink +
        '<button class="btn icon guru-pin' + (isPinned(card.id) ? " pinned" : "") + '" type="button" data-pin title="Pin (saved locally to this browser)">' + (isPinned(card.id) ? "★" : "☆") + "</button></div>" +
      '<div class="guru-hint" id="m-hint"></div>' +
      '<div class="guru-content">' + safeGuruContent(card.content) + "</div>" +
      '<div class="guru-cmt"><div class="cmt-label">Card comments</div>' +
      '<div class="cmt-list" id="m-cmts"><div class="skeleton" style="width:60%"></div></div>' +
      '<textarea class="composer-input" id="m-cmt-input" placeholder="Leave a comment on this Guru card…"></textarea>' +
      '<div class="composer-row"><span class="composer-hint" id="m-cmt-hint">Posts a comment to the Guru card</span>' +
      '<button class="btn primary" type="button" data-comment>Comment</button></div></div></div>';
  }

  function loadComments() {
    var list = el("m-cmts"); if (!list) return;
    if (mode === "demo") {
      list.innerHTML = commentHTML({ owner: { firstName: "Dana", lastName: "W." }, content: "Confirmed with Eligibility — this flow is current. (sample)" });
      return;
    }
    guruApi("/cards/" + encodeURIComponent(card.id) + "/comments", { subtype: "sidebar-comments" })
      .then(function (r) {
        var arr = Array.isArray(r) ? r : ((r && r.comments) || []);
        list.innerHTML = arr.length ? arr.map(commentHTML).join("") : '<div class="empty">No comments yet.</div>';
      })
      .catch(function () { list.innerHTML = '<div class="empty">Couldn’t load comments.</div>'; });
  }

  function plainText(html) { var d = document.createElement("div"); d.innerHTML = html; return d.textContent || ""; }

  document.addEventListener("click", function (e) {
    if (!e.target || !e.target.closest) return;
    var t;
    if (e.target.closest("#m-close")) { try { client.invoke("destroy"); } catch (err) {} return; }
    if ((t = e.target.closest("[data-verify]"))) {
      var toVerify = t.getAttribute("data-verify") === "1";
      if (mode === "demo") { card.verificationState = toVerify ? "TRUSTED" : "NEEDS_VERIFICATION"; render(); loadComments(); setHint(toVerify ? "Card verified (sample)." : "Card unverified (sample).", "ok"); return; }
      t.disabled = true;
      (toVerify ? guruApi("/cards/" + encodeURIComponent(card.id) + "/verify", { type: "PUT", subtype: "sidebar-verify" })
                : guruApi("/cards/" + encodeURIComponent(card.id) + "/unverify", { type: "POST", subtype: "sidebar-verify" }))
        .then(function () { card.verificationState = toVerify ? "TRUSTED" : "NEEDS_VERIFICATION"; render(); loadComments(); setHint(toVerify ? "Card verified." : "Card marked as needing verification.", "ok"); })
        .catch(function (err) {
          t.disabled = false;
          if ((err && err.status === 403) || /403/.test(String((err && (err.status || err.responseText || err.message)) || ""))) {
            t.outerHTML = '<button class="btn small" type="button" data-flag>Flag for verification</button>';
            setHint("You’re not a verifier for this card — you can flag it for its verifier instead.", "err");
          } else setHint("Verification change failed.", "err");
        });
      return;
    }
    if ((t = e.target.closest("[data-flag]"))) {
      var note = "⚑ Verification requested from the Zendesk CX sidebar" + (ticketId ? " (ticket #" + ticketId + ")" : "") + ".";
      if (mode === "demo") { setHint("Verifier notified (sample).", "ok"); return; }
      t.disabled = true;
      guruApi("/cards/" + encodeURIComponent(card.id) + "/comments", { type: "POST", data: { content: note }, subtype: "sidebar-flag" })
        .then(function () { setHint("Flagged: a comment was posted for the card’s verifier.", "ok"); loadComments(); })
        .catch(function () { t.disabled = false; setHint("Couldn’t flag.", "err"); });
      return;
    }
    if (e.target.closest("[data-insert]")) {
      relay("guru.insert", { html: safeGuruContent(card.content) });
      setHint("Sent to the ticket reply.", "ok");
      return;
    }
    if (e.target.closest("[data-copy]")) {
      var html = safeGuruContent(card.content), plain = plainText(html);
      var done = function () { setHint("Copied card content.", "ok"); relay("guru.used"); };
      var fallback = function () {
        try { var ta = document.createElement("textarea"); ta.value = plain; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta); done(); }
        catch (err) { setHint("Copy failed in this browser.", "err"); }
      };
      try {
        if (navigator.clipboard && window.ClipboardItem) {
          navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([plain], { type: "text/plain" }) })]).then(done, function () { navigator.clipboard.writeText(plain).then(done, fallback); });
        } else if (navigator.clipboard) navigator.clipboard.writeText(plain).then(done, fallback);
        else fallback();
      } catch (err) { fallback(); }
      return;
    }
    if ((t = e.target.closest("[data-pin]"))) {
      var pinned = togglePin(card.id, card.title);
      t.classList.toggle("pinned", pinned);
      t.textContent = pinned ? "★" : "☆";
      return;
    }
    if ((t = e.target.closest("[data-comment]"))) {
      var ta2 = el("m-cmt-input"), hint = el("m-cmt-hint"), list = el("m-cmts");
      var text = (ta2.value || "").trim(); if (!text) return;
      if (mode === "demo") {
        if (list) list.insertAdjacentHTML("afterbegin", commentHTML({ owner: { firstName: "You" }, content: text }));
        ta2.value = ""; if (hint) { hint.textContent = "Comment added to the card (sample)."; hint.style.color = "var(--ok)"; } return;
      }
      t.disabled = true; t.textContent = "Posting…";
      guruApi("/cards/" + encodeURIComponent(card.id) + "/comments", { type: "POST", data: { content: text }, subtype: "sidebar-comment" })
        .then(function () {
          if (list) list.insertAdjacentHTML("afterbegin", commentHTML({ owner: { firstName: "You" }, content: text }));
          ta2.value = ""; t.disabled = false; t.textContent = "Comment";
          if (hint) { hint.textContent = "Comment posted to Guru."; hint.style.color = "var(--ok)"; }
        })
        .catch(function () { t.disabled = false; t.textContent = "Comment"; if (hint) { hint.textContent = "Failed to post."; hint.style.color = "var(--danger)"; } });
    }
  });

  // Follow the sidebar's persisted theme (shared localStorage origin).
  try { document.documentElement.setAttribute("data-theme", localStorage.getItem("cxsidebar.theme") === "dark" ? "dark" : "light"); } catch (e) {}

  render();
  if (mode === "live" && client && card.id) {
    guruApi("/cards/" + encodeURIComponent(card.id) + "/extended", { subtype: "sidebar-card-view" })
      .catch(function () { return guruApi("/cards/" + encodeURIComponent(card.id)); })
      .then(function (c) { card = normalize(c, card.id); render(); loadComments(); })
      .catch(function () { loadComments(); });
  } else {
    loadComments();
  }
})();
