/* ============================================================================
   Combined home view (nav_bar) — "Across my open tickets"
   ----------------------------------------------------------------------------
   Scoped to the agent's assigned Zendesk tickets with status < solved. Two tabs:
     Asana — tasks on those tickets, grouped by the "assigned team" custom field
             (asana_team_field_gid; e.g. Sales / Credentialing / Eligibility /
             Claims / Accounting). Each task expands to its comment thread.
     Slack — threads in the configured channels (slack_channel_ids) that reference
             those ticket ids ("[Ticket #N]"), grouped by channel.
   Live via Zendesk's secure proxy ({{setting.asana_pat}} / {{setting.slack_bot_token}});
   blank settings -> clearly-labeled sample data. Asana search + Slack history are
   premium-/scope-gated; failures surface rather than reporting "nothing".
   ============================================================================ */
(function () {
  "use strict";

  var client = (typeof ZAFClient !== "undefined") ? ZAFClient.init() : null;
  var cfg = { workspace: "", projectGid: "", ticketField: "", teamField: "", channels: [], statusButtons: false };
  var SEEN_KEY = "cxsidebar.asana.seen";
  var demoTasksByGid = {};   // gid -> demo task, for Details & comments
  var liveTasksByGid = {};   // gid -> live task
  // Daily background refresh (3.10.0) — replaces the old ungated 30s badge poll.
  // The full rebuild (one task search per unsolved ticket + one comment sweep)
  // runs once per day at a per-agent slot derived from the agent's email, so a
  // fleet spreads itself across the day with no coordination and one shared PAT
  // stays inside Asana's free-tier budget. Between rebuilds the pane renders the
  // last snapshot from localStorage; freshness on demand = per-card ↻ and
  // "Refresh all". A slot missed while offline (overnight) catches up after a
  // random 0–60 min delay so simultaneous 9am logins can't stampede the token.
  var DAY_MS = 86400000, DAILY_CHECK_MS = 600000;
  var daily = { email: "", slotMs: 0, timer: null, pending: false, retryAfter: 0, ids: [] };
  var lazy = { slackLive: false, slackLoaded: false, reqLoaded: false };
  var CACHE_KEY = "cxsidebar.home.cache", LAST_KEY = "cxsidebar.home.lastRebuild";
  var commentToastTimer = null;

  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  var FRAME_H = 760; // nav_bar flyout target; Zendesk clamps to its cap, the pane scrolls within. Tune after seeing it live.
  function resize() {
    if (!client) return;
    requestAnimationFrame(function () {
      try { client.invoke("resize", { width: "100%", height: FRAME_H }); } catch (e) {}
    });
  }
  try { new ResizeObserver(resize).observe(document.body); } catch (e) {}

  function asanaApi(path, opts) {
    var req = { url: "https://app.asana.com/api/1.0" + path, type: (opts && opts.type) || "GET",
      headers: { Authorization: "Bearer {{setting.asana_pat}}" }, secure: true, cors: false, dataType: "json" };
    if (opts && opts.data) { req.data = JSON.stringify(opts.data); req.contentType = "application/json"; }
    return client.request(req);
  }
  function slackApi(method, params) {
    var form = Object.keys(params || {}).map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]); }).join("&");
    return client.request({ url: "https://slack.com/api/" + method, type: "POST",
      headers: { Authorization: "Bearer {{setting.slack_bot_token}}" }, secure: true, cors: false,
      contentType: "application/x-www-form-urlencoded", data: form, dataType: "json"
    }).then(function (r) { if (!r || r.ok !== true) throw new Error("Slack: " + ((r && r.error) || "request failed")); return r; });
  }
  function reqErr(e) {
    var d = "";
    try { var b = e && (e.responseJSON || (e.responseText ? JSON.parse(e.responseText) : null));
      if (b && b.errors && b.errors[0] && b.errors[0].message) d = " — " + b.errors[0].message; } catch (x) {}
    if (e && e.status === 402) return "HTTP 402 — Asana search needs a paid plan" + d;
    if (e && e.status === 401) return "HTTP 401 — check the token in the app settings" + d;
    if (e && e.status) return "HTTP " + e.status + d;
    return ((e && e.message) || "request failed") + d;
  }
  function badge(kind) { return kind === "completed" ? '<span class="badge ok">Completed</span>' : '<span class="badge warn">Open</span>'; }
  // Designed empty states — same .empty-state component the Guru pane uses.
  var ES_ICONS = {
    tasks: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M9 11l3 3 8-8"/><path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"/></svg>',
    chat:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7a8.5 8.5 0 1 1 16.1-3.8z"/></svg>',
    inbox: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.1z"/></svg>'
  };
  function emptyStateHTML(icon, title, sub) {
    return '<div class="card"><div class="empty-state">' + (ES_ICONS[icon] || "") +
      '<div class="es-title">' + esc(title) + "</div>" +
      (sub ? '<div class="es-sub">' + esc(sub) + "</div>" : "") + "</div></div>";
  }
  function fmtWhen(ts) {
    if (!ts) return "";
    var d = (String(ts).indexOf(".") > -1 && String(ts).length <= 18) ? new Date(parseFloat(ts) * 1000) : new Date(ts);
    if (isNaN(d.getTime())) return "";
    try { return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); } catch (e) { return ""; }
  }

  // ---- seen state (shared with the sidebar) ----
  function seenMap() { try { return JSON.parse(localStorage.getItem(SEEN_KEY) || "{}"); } catch (e) { return {}; } }
  function saveSeen(m) { try { localStorage.setItem(SEEN_KEY, JSON.stringify(m)); } catch (e) {} }
  function markSeen(gid, at) { var m = seenMap(); if (!m[gid] || at > m[gid]) { m[gid] = at; saveSeen(m); } }
  function latestCommentAt(comments) { var max = ""; comments.forEach(function (c) { if (c.created_at && c.created_at > max) max = c.created_at; }); return max; }

  // ---- daily-refresh snapshot + slot (per agent via email suffix) ----
  function cacheKey(k) { return k + "." + (daily.email || "anon"); }
  function loadCache() { try { return JSON.parse(localStorage.getItem(cacheKey(CACHE_KEY)) || "null"); } catch (e) { return null; } }
  function saveCache(groups, ticketCount) {
    try { localStorage.setItem(cacheKey(CACHE_KEY), JSON.stringify({ at: new Date().toISOString(), tickets: ticketCount, groups: groups })); } catch (e) {}
  }
  function localDay(d) { d = d || new Date(); return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); }
  function slotFor(email) {
    var h = 0, s = String(email || "");
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % DAY_MS;
  }
  // Due at the daily slot instant, OR once 24h have passed since the last
  // rebuild — whichever the open pane sees first. The elapsed rule is what
  // saves agents whose hash lands outside their shift (a 22:00 slot on an
  // 8-5 agent would otherwise never fire); their cadence anchors to their own
  // previous (jittered) rebuild time, which keeps the fleet spread out.
  function rebuildDue() {
    if (daily.retryAfter && Date.now() < daily.retryAfter) return false; // failure backoff
    var last = 0; try { last = parseInt(localStorage.getItem(cacheKey(LAST_KEY)) || "0", 10) || 0; } catch (e) {}
    if (!last) return true;                                   // never rebuilt (or legacy day-string)
    if (Date.now() - last >= DAY_MS) return true;             // 24h elapsed
    if (localDay(new Date(last)) === localDay()) return false; // already ran today
    var midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    return Date.now() >= midnight.getTime() + daily.slotMs;   // today's slot passed
  }
  function markRebuilt() { try { localStorage.setItem(cacheKey(LAST_KEY), String(Date.now())); } catch (e) {} }
  function setAsOf(text) { var e = el("home-asana-asof"); if (e) e.textContent = text || ""; }

  // ---- sub-tab nav ----
  function switchHsub(name) {
    Array.prototype.forEach.call(document.querySelectorAll("#home-subtabs .subtab"), function (b) {
      b.classList.toggle("active", b.getAttribute("data-hsub") === name);
    });
    Array.prototype.forEach.call(document.querySelectorAll(".asub"), function (p) {
      p.classList.toggle("active", p.id === "hsub-" + name);
    });
    // Live Slack panes load on first view, not at boot — a home open that never
    // visits them costs zero Slack calls (and boot can't stampede the token).
    if (client && lazy.slackLive) {
      if (name === "slack" && !lazy.slackLoaded) {
        lazy.slackLoaded = true;
        getIds().then(loadSlackLive).catch(function (e) {
          lazy.slackLoaded = false;   // unlatch so a re-click retries
          fail("home-slack-body", "Couldn't read your tickets: " + reqErr(e));
        });
      }
      if (name === "requests" && !lazy.reqLoaded) {
        lazy.reqLoaded = true;
        getIds().then(function (ids) { loadRequestsLive(ids); startRequestPoll(); }).catch(function (e) {
          lazy.reqLoaded = false;
          fail("home-req-body", "Couldn't read your tickets: " + reqErr(e));
        });
      }
    }
    resize();
  }

  // ---- grouped rendering ----
  function groupHTML(name, count, inner) {
    return '<div class="hgroup"><div class="hgroup-head"><span class="hgroup-name">' + esc(name) +
      '</span><span class="count-pill">' + count + '</span></div><div class="hgroup-body">' + inner + "</div></div>";
  }
  function taskAgePill(created_at) {
    if (!created_at) return "";
    var hours = (Date.now() - new Date(created_at).getTime()) / 3600000;
    var cls, label;
    if (hours < 48)       { cls = "task-age-green";  label = Math.round(hours) + "h"; }
    else if (hours < 72)  { cls = "task-age-yellow"; label = Math.round(hours / 24) + "d"; }
    else                  { cls = "task-age-red";    label = Math.round(hours / 24) + "d"; }
    return '<span class="task-age ' + cls + '">' + label + "</span>";
  }

  function asanaCardHTML(t) {
    var meta = [t.assignee && ("Assignee: " + esc(t.assignee)),
                t.ticket && ("Ticket #" + esc(t.ticket)),
                t.due_on && ("Due: " + esc(t.due_on))].filter(Boolean).join(" · ");
    var bell = (t.unseen > 0) ? '<span class="abell" title="' + t.unseen + ' new comment(s)">' + t.unseen + " new</span>" : "";
    var tog = t.gid
      ? '<div class="atask-toggle" role="button" tabindex="0" data-direct-gid="' + esc(t.gid) + '" aria-expanded="false">▸ Details &amp; comments</div><div class="adetail" hidden></div>'
      : "";
    var statusBar = (cfg.statusButtons && t.ticket)
      ? '<div class="asana-status-bar">' +
          '<button class="btn asana-status-btn" type="button" data-set-status="on-hold" data-ticket-id="' + esc(t.ticket) + '" title="Set ticket #' + esc(t.ticket) + ' to On-hold">On-hold</button>' +
          '<button class="btn asana-status-btn" type="button" data-set-status="pending" data-ticket-id="' + esc(t.ticket) + '" title="Set ticket #' + esc(t.ticket) + ' to Pending">Pending</button>' +
        '</div>'
      : "";
    return '<div class="card atask"' + (t.gid ? ' data-gid="' + esc(t.gid) + '"' : "") + '><div class="atask-top">' +
      '<a class="atask-name" href="' + esc(t.url) + '" target="_blank" rel="noopener">' + esc(t.name) + "</a>" +
      '<span class="atask-right">' + taskAgePill(t.created_at) + bell +
      (t.gid ? '<button class="acard-refresh" type="button" data-refresh-gid="' + esc(t.gid) + '" title="Check this task for new comments now" aria-label="Refresh this task">↻</button>' : "") +
      badge(t.completed ? "completed" : "open") + "</span></div>" +
      (meta ? '<div class="atask-meta">' + meta + "</div>" : "") + statusBar + tog + "</div>";
  }
  function renderAsanaGroups(groups) {
    var body = el("home-asana-body");
    var total = groups.reduce(function (n, g) { return n + g.tasks.length; }, 0);
    if (!total) { body.innerHTML = emptyStateHTML("tasks", "No Asana tasks on your unsolved tickets", "Tasks appear here when your tickets link to Asana work."); resize(); return; }
    body.innerHTML = groups.filter(function (g) { return g.tasks.length; }).map(function (g) {
      return groupHTML(g.team || "Unassigned team", g.tasks.length, g.tasks.map(asanaCardHTML).join(""));
    }).join("");
    resize();
  }
  function slackThreadHTML(p) {
    var meta = [p.ticket && ("Ticket #" + esc(p.ticket)),
                ((p.reply_count || 0) + " repl" + (p.reply_count === 1 ? "y" : "ies")),
                p.ts && fmtWhen(p.ts)].filter(Boolean).join(" · ");
    return '<div class="card atask"><div class="atask-top"><span class="atask-name">' + esc(p.title) + "</span>" +
      (p.permalink ? '<a class="aform-source" href="' + esc(p.permalink) + '" target="_blank" rel="noopener">Open ↗</a>' : "") + "</div>" +
      '<div class="atask-meta">' + meta + "</div>" +
      (p.text ? '<div class="adetail-note">' + esc(p.text) + "</div>" : "") + "</div>";
  }
  function renderSlackGroups(groups) {
    var body = el("home-slack-body");
    var total = groups.reduce(function (n, g) { return n + g.threads.length; }, 0);
    if (!total) { body.innerHTML = emptyStateHTML("chat", "No Slack threads reference your unsolved tickets", "Threads mentioning your ticket numbers show up here."); resize(); return; }
    body.innerHTML = groups.filter(function (g) { return g.threads.length; }).map(function (g) {
      return groupHTML(g.channel, g.threads.length, g.threads.map(slackThreadHTML).join(""));
    }).join("");
    resize();
  }
  function fail(elId, msg) { var e = el(elId); if (e) e.innerHTML = '<div class="card error"><p>' + esc(msg) + "</p></div>"; resize(); }

  // ---- Asana card detail (comments) ----
  function commentHTML(c) {
    var when = ""; if (c.created_at) { try { when = new Date(c.created_at).toLocaleString(); } catch (e) {} }
    return '<div class="cmt"><div class="cmt-head"><span class="cmt-who">' + esc((c.created_by && c.created_by.name) || "—") +
      '</span><span class="cmt-when">' + esc(when) + '</span></div><div class="cmt-text">' + esc(c.text) + "</div></div>";
  }
  function detailHTML(t, comments, gid) {
    return (t.notes ? '<div class="adetail-note">' + esc(t.notes) + "</div>" : "") +
      '<div class="cmt-label">Comments</div>' +
      '<div class="cmt-thread">' +
        '<div class="cmt-list">' + (comments.length ? comments.map(commentHTML).join("") : '<div class="empty">No comments yet.</div>') + "</div>" +
        '<div class="composer"><textarea class="composer-input" placeholder="Add a comment to this Asana task..."></textarea>' +
        '<div class="composer-row"><span class="composer-hint">Posts to Asana as the connected account</span>' +
        '<button class="btn primary composer-send" type="button" data-gid="' + esc(gid) + '">Send</button></div></div>' +
      '</div>';
  }
  function updateBadge(card, n) {
    var top = card.querySelector(".atask-right") || card.querySelector(".atask-top");
    var b = card.querySelector(".abell");
    if (n > 0) { if (!b) { b = document.createElement("span"); b.className = "abell"; top.insertBefore(b, top.querySelector(".acard-refresh") || top.querySelector(".badge")); } b.textContent = n + " new"; }
    else if (b) { b.parentNode.removeChild(b); }
  }
  function showCommentToast(totalNew) {
    var toast = el("comment-toast");
    var msg = el("comment-toast-msg");
    var close = el("comment-toast-close");
    if (!toast) return;
    if (commentToastTimer) clearTimeout(commentToastTimer);
    msg.textContent = totalNew + " new Asana comment" + (totalNew > 1 ? "s" : "") + " on your tasks";
    toast.hidden = false;
    commentToastTimer = setTimeout(function () { toast.hidden = true; }, 6000);
    close.onclick = function () { toast.hidden = true; if (commentToastTimer) clearTimeout(commentToastTimer); };
    try {
      var ac = new (window.AudioContext || window.webkitAudioContext)();
      var osc = ac.createOscillator();
      var gain = ac.createGain();
      osc.connect(gain); gain.connect(ac.destination);
      osc.type = "sine";
      osc.frequency.setValueAtTime(880, ac.currentTime);
      osc.frequency.setValueAtTime(1100, ac.currentTime + 0.1);
      gain.gain.setValueAtTime(0.25, ac.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.4);
      osc.start(ac.currentTime); osc.stop(ac.currentTime + 0.4);
    } catch (e) {}
  }

  // Comment-badge sweep for the home Asana cards — shared seen map with the
  // sidebar, so a new Asana comment surfaces as an unread badge here too.
  // No interval anymore (3.10.0): runs once after each daily rebuild, and on
  // demand per card (pass an array of card elements) or via "Refresh all".
  function refreshBadges(cardsArg) {
    var cards = cardsArg || document.querySelectorAll('#home-asana-body .atask[data-gid]');
    if (!cards.length) return;
    var seen = seenMap(); var changed = false; var totalNew = 0;
    var chain = Promise.resolve();
    Array.prototype.forEach.call(cards, function (card) {
      var gid = card.getAttribute("data-gid");
      chain = chain.then(function () {
        return asanaApi("/tasks/" + encodeURIComponent(gid) + "/stories?opt_fields=type,created_at")
          .then(function (r) {
            var comments = ((r && r.data) || []).filter(function (s) { return s.type === "comment"; });
            var newest = latestCommentAt(comments);
            if (!seen[gid]) { if (newest) { seen[gid] = newest; changed = true; } updateBadge(card, 0); return; }
            var newCount = comments.filter(function (c) { return c.created_at > seen[gid]; }).length;
            updateBadge(card, newCount);
            if (newCount > 0) totalNew += newCount;
          }).catch(function () {});
      });
    });
    chain.then(function () { if (changed) saveSeen(seen); if (totalNew > 0) showCommentToast(totalNew); resize(); });
  }
  function refreshCard(gid, btn) {
    var card = btn && btn.closest(".atask");
    if (!card) return;
    if (demoTasksByGid[gid]) { updateBadge(card, 0); return; }
    btn.disabled = true;
    refreshBadges([card]);
    setTimeout(function () { btn.disabled = false; }, 1500);
  }
  function toggleDetail(tog) {
    var box = tog.nextElementSibling;
    if (!box || !box.classList.contains("adetail")) return;
    var open = box.hidden; box.hidden = !open;
    tog.setAttribute("aria-expanded", String(open));
    tog.textContent = (open ? "▾ " : "▸ ") + "Details & comments";
    if (open && !box.getAttribute("data-loaded")) {
      var gid = tog.getAttribute("data-direct-gid");
      var demoT = demoTasksByGid[gid];
      if (demoT) {
        box.setAttribute("data-loaded", "1");
        box.innerHTML = detailHTML(demoT, demoT.comments || [], gid);
        demoT.unseen = 0; var dcard = box.closest(".atask"); if (dcard) updateBadge(dcard, 0);
        setTimeout(resize, 0); return;
      }
      box.innerHTML = '<div class="skeleton" style="width:70%"></div>';
      asanaApi("/tasks/" + encodeURIComponent(gid) + "/stories?opt_fields=type,text,created_at,created_by.name")
        .then(function (r) {
          var comments = ((r && r.data) || []).filter(function (s) { return s.type === "comment"; });
          box.setAttribute("data-loaded", "1");
          box.innerHTML = detailHTML(liveTasksByGid[gid] || {}, comments, gid);
          var card = box.closest(".atask"); if (card) updateBadge(card, 0);
          setTimeout(resize, 0);
        })
        .catch(function (e) { box.innerHTML = '<div class="empty">Failed to load details: ' + esc(reqErr(e)) + "</div>"; setTimeout(resize, 0); });
    }
    resize();
  }
  function sendComment(btn) {
    var composer = btn.closest(".composer"), ta = composer.querySelector(".composer-input"), hint = composer.querySelector(".composer-hint");
    var text = (ta.value || "").trim(); if (!text) return;
    var gid = btn.getAttribute("data-gid"), demoT = demoTasksByGid[gid];
    if (demoT) {
      var dc = { created_by: { name: "You" }, created_at: new Date().toISOString(), text: text };
      demoT.comments = demoT.comments || []; demoT.comments.push(dc);
      var dlist = composer.parentNode.querySelector(".cmt-list"); var de = dlist.querySelector(".empty"); if (de) dlist.innerHTML = "";
      dlist.insertAdjacentHTML("beforeend", commentHTML(dc)); ta.value = ""; resize(); return;
    }
    btn.disabled = true; btn.textContent = "Sending…";
    asanaApi("/tasks/" + encodeURIComponent(gid) + "/stories", { type: "POST", data: { data: { text: text } } })
      .then(function (r) {
        var s = (r && r.data) || {}; var list = composer.parentNode.querySelector(".cmt-list");
        var empty = list.querySelector(".empty"); if (empty) list.innerHTML = "";
        list.insertAdjacentHTML("beforeend", commentHTML({ created_by: s.created_by, created_at: s.created_at, text: s.text || text }));
        if (s.created_at) markSeen(gid, s.created_at);
        ta.value = ""; btn.disabled = false; btn.textContent = "Send"; resize();
      })
      .catch(function (e) { btn.disabled = false; btn.textContent = "Send"; if (hint) { hint.textContent = "Failed to post: " + reqErr(e); hint.style.color = "var(--danger)"; } });
  }

  // ---- demo data (grouped) ----
  function _dc(name, when, text) { return { created_by: { name: name }, created_at: when, text: text }; }
  function demoAsanaGroups() {
    var g = [
      { team: "Credentialing", tasks: [
        { gid: "h2001", ticket: "481", name: "Re-credential Dr. Lee with Cigna (sample)", url: "https://app.asana.com/0/0/h2001",
          completed: false, assignee: "Morgan (Cred Ops)", due_on: "2026-06-16", unseen: 1,
          notes: "Re-credentialing lapsed; confirm CAQH + panel effective date.",
          comments: [ _dc("Morgan (Cred Ops)", "2026-06-09T10:05:00Z", "Panel effective date confirmed 7/1.") ] },
        { gid: "h2002", ticket: "455", name: "Add provider to BCBS panel (sample)", url: "https://app.asana.com/0/0/h2002",
          completed: false, assignee: "Priya (Cred)", due_on: "2026-06-19", unseen: 0,
          notes: "New panel add for BCBS TX.", comments: [] }
      ] },
      { team: "Eligibility", tasks: [
        { gid: "h2003", ticket: "481", name: "Re-pull Aetna eligibility (sample)", url: "https://app.asana.com/0/0/h2003",
          completed: false, assignee: "Jordan (CX)", due_on: "2026-06-12", unseen: 2,
          notes: "Member disputes patient responsibility; confirm deductible reset.",
          comments: [ _dc("Jordan (CX)", "2026-06-08T15:30:00Z", "Pulled the latest EOB — deductible reset 6/1."),
                      _dc("Aetna Liaison", "2026-06-09T09:10:00Z", "In-network; copay $25.") ] }
      ] },
      { team: "Claims", tasks: [
        { gid: "h2004", ticket: "472", name: "Escalate duplicate charge review (sample)", url: "https://app.asana.com/0/0/h2004",
          completed: false, assignee: "Billing Triage", due_on: "2026-06-18", unseen: 1,
          notes: "Double-charged on 5/12; open a processor dispute.",
          comments: [ _dc("Processor", "2026-06-09T16:40:00Z", "Dispute #DSP-4471 opened; credit 3-5 days.") ] }
      ] },
      { team: "Accounting", tasks: [
        { gid: "h2005", ticket: "455", name: "Reissue payout for missed DOS (sample)", url: "https://app.asana.com/0/0/h2005",
          completed: false, assignee: "Sam (Accounting)", due_on: "2026-06-20", unseen: 0,
          notes: "Provider payout for 5/30 DOS was missed; reissue.", comments: [] }
      ] },
      { team: "Sales", tasks: [
        { gid: "h2006", ticket: "472", name: "Honor referral payout (sample)", url: "https://app.asana.com/0/0/h2006",
          completed: false, assignee: "Riley (Sales)", due_on: "2026-06-22", unseen: 0,
          notes: "Referral payout pending verification.", comments: [] }
      ] }
    ];
    demoTasksByGid = {};
    g.forEach(function (grp) { grp.tasks.forEach(function (t) { t.demo = true; demoTasksByGid[t.gid] = t; }); });
    return g;
  }
  function demoSlackGroups() {
    return [
      { channel: "cx commons", threads: [
        { title: ":memo: Eligibility re-pull — Aetna", ticket: "481", reply_count: 4, ts: "1717948800",
          permalink: "https://slack.com/app_redirect", text: "Member disputing responsibility — re-pulling eligibility, will confirm deductible." },
        { title: ":rotating_light: Duplicate charge escalation", ticket: "472", reply_count: 6, ts: "1717862400",
          permalink: "https://slack.com/app_redirect", text: "Processor dispute opened (#DSP-4471); credit ETA 3-5 days." }
      ] },
      { channel: "cx<>cat crossfunctional", threads: [
        { title: ":handshake: Credentialing — Dr. Lee Cigna panel", ticket: "481", reply_count: 3, ts: "1717776000",
          permalink: "https://slack.com/app_redirect", text: "Panel effective 7/1 confirmed; notifying the provider." }
      ] },
      { channel: "prod<>eng", threads: [
        { title: ":bug: Portal eligibility check timing out", ticket: "455", reply_count: 2, ts: "1717689600",
          permalink: "https://slack.com/app_redirect", text: "Repro on the eligibility endpoint; eng investigating a clearinghouse timeout." }
      ] }
    ];
  }

  // ---- live: the agent's assigned, unsolved ticket ids ----
  var zdSubdomain = "";

  function unsolvedTicketIds() {
    return client.get("currentUser.email").then(function (d) {
      var email = d["currentUser.email"];
      el("home-who").textContent = email ? "· " + email : "";
      if (!daily.email && email) { daily.email = email; daily.slotMs = slotFor(email); } // heal an init-time email miss
      var q = "type:ticket assignee:" + email + " status<solved";
      return (client.context ? client.context() : Promise.resolve(null)).then(function (c) {
        zdSubdomain = (c && (c.account && c.account.subdomain || c.subdomain)) || "";
        return client.request({ url: "/api/v2/search.json?query=" + encodeURIComponent(q), dataType: "json" });
      }).catch(function () {
        return client.request({ url: "/api/v2/search.json?query=" + encodeURIComponent(q), dataType: "json" });
      }).then(function (r) {
        var tickets = (r && r.results) || [];
        el("home-ticket-count").textContent = tickets.length;
        return tickets.map(function (t) { return String(t.id); });
      });
    });
  }

  // ---- live Asana: tasks on those tickets, grouped by the assigned-team field ----
  var TASK_FIELDS = "name,completed,assignee.name,due_on,created_at,permalink_url,notes,custom_fields.gid,custom_fields.name,custom_fields.display_value";
  function ticketMatch(id) {
    if (cfg.ticketField) {
      var ticketUrl = zdSubdomain
        ? "https://" + zdSubdomain + ".zendesk.com/agent/tickets/" + id
        : id;
      return "custom_fields." + encodeURIComponent(cfg.ticketField) + ".value=" + encodeURIComponent(ticketUrl);
    }
    return "text=" + encodeURIComponent(id);
  }
  function teamOf(t) {
    if (!cfg.teamField) return "Unassigned team";
    var f = (t.custom_fields || []).filter(function (cf) { return String(cf.gid) === String(cfg.teamField); })[0];
    return (f && f.display_value) || "Unassigned team";
  }
  function loadAsanaLive(ticketIds) {
    if (!ticketIds.length) {
      renderAsanaGroups([]);
      saveCache([], 0); markRebuilt();          // a real (empty) result — don't re-attempt all day
      setAsOf("Updated " + fmtWhen(new Date().toISOString()));
      return Promise.resolve();
    }
    var seen = {}, byTeam = {};
    var chain = Promise.resolve(); var firstErr = null; var any = false;
    ticketIds.forEach(function (id) {
      chain = chain.then(function () {
        var url = "/workspaces/" + encodeURIComponent(cfg.workspace) + "/tasks/search?" + ticketMatch(id) +
          (cfg.projectGid ? "&projects.any=" + encodeURIComponent(cfg.projectGid) : "") +
          "&completed=false&opt_fields=" + TASK_FIELDS;
        return asanaApi(url).then(function (r) {
          any = true;
          ((r && r.data) || []).forEach(function (t) {
            if (seen[t.gid]) return; seen[t.gid] = 1;
            liveTasksByGid[t.gid] = t;
            var team = teamOf(t);
            (byTeam[team] = byTeam[team] || []).push({
              gid: t.gid, ticket: id, name: t.name, url: t.permalink_url, completed: t.completed,
              assignee: t.assignee && t.assignee.name, due_on: t.due_on, created_at: t.created_at
            });
          });
        }).catch(function (e) { if (!firstErr) firstErr = e; });
      });
    });
    return chain.then(function () {
      var groups = Object.keys(byTeam).sort().map(function (team) { return { team: team, tasks: byTeam[team] }; });
      if (!groups.length && firstErr) { fail("home-asana-body", "Couldn't load Asana tasks: " + reqErr(firstErr)); return; }
      renderAsanaGroups(groups);
      if (groups.length) refreshBadges();       // one comment sweep — no interval
      if (!firstErr) {
        saveCache(groups, ticketIds.length);    // never overwrite a full snapshot with a partial one
        markRebuilt();
        daily.retryAfter = 0;
        setAsOf("Updated " + fmtWhen(new Date().toISOString()));
      } else {                                  // partial failure: retry after a 1h backoff,
        daily.retryAfter = Date.now() + 3600000; // not every 10-min check for the rest of the day
        setAsOf("Partial update — ↻ Refresh all to retry");
      }
    });
  }

  // ---- daily rebuild driver + scheduler ----
  function getIds() {
    return daily.ids.length ? Promise.resolve(daily.ids)
      : unsolvedTicketIds().then(function (ids) { daily.ids = ids; return ids; });
  }
  function doRebuild() {
    if (!client || !cfg.workspace || daily.pending) return;   // live Asana only
    daily.pending = true;
    var rb = el("home-asana-refresh"); if (rb) rb.disabled = true;
    setAsOf("Updating…");
    unsolvedTicketIds().then(function (ids) {
      daily.ids = ids;
      return loadAsanaLive(ids);
    }).catch(function (e) {
      daily.retryAfter = Date.now() + 3600000;  // don't hammer a failing backend
      fail("home-asana-body", "Couldn't read your tickets: " + reqErr(e));
      setAsOf("Update failed — ↻ Refresh all to retry");
    }).then(function () {
      daily.pending = false;
      var rb2 = el("home-asana-refresh"); if (rb2) rb2.disabled = false;
    });
  }
  function scheduleDailyRebuild(bootCatchUp) {
    if (daily.timer || daily.pending || !rebuildDue()) return; // a pending timer owns the decision
    // Boot catch-up jitters 0–60 min so a shared 9am login window can't fire
    // every agent's rebuild at once; a slot crossed while the iframe is open
    // fires promptly (slots are already spread per agent by the email hash).
    var delay = bootCatchUp ? Math.floor(Math.random() * 3600000) : 0;
    daily.timer = setTimeout(function () {
      daily.timer = null;
      if (rebuildDue()) doRebuild();
    }, delay);
  }

  // ---- live Slack: scan each channel's recent history for the ticket markers ----
  function marker(id) { return "[Ticket #" + id + "]"; }
  function loadSlackLive(ticketIds) {
    if (!cfg.channels.length) { fail("home-slack-body", "No Slack channels configured (set slack_channel_ids)."); return; }
    if (!ticketIds.length) { renderSlackGroups([]); return; }
    var wanted = ticketIds.map(marker);
    var groups = [], chain = Promise.resolve(), firstErr = null, any = false;
    cfg.channels.forEach(function (ch) {
      chain = chain.then(function () {
        return slackApi("conversations.history", { channel: ch.id, limit: 200 }).then(function (r) {
          any = true;
          var threads = ((r && r.messages) || []).filter(function (m) {
            return wanted.some(function (w) { return (m.text || "").indexOf(w) > -1; });
          }).map(function (m) {
            var hitId = ""; ticketIds.forEach(function (id) { if ((m.text || "").indexOf(marker(id)) > -1) hitId = id; });
            return { title: (m.text || "").split("\n")[0].slice(0, 80), ticket: hitId, reply_count: m.reply_count || 0,
                     ts: m.ts, text: m.text || "" };
          });
          if (threads.length) groups.push({ channel: ch.name, threads: threads });
        }).catch(function (e) { if (!firstErr) firstErr = e; });
      });
    });
    chain.then(function () {
      if (!groups.length && firstErr) { fail("home-slack-body", "Couldn't read Slack: " + (firstErr.message || reqErr(firstErr))); return; }
      renderSlackGroups(groups);
    });
  }

  // ---- Requests: open workflow/ticket requests across the channels ----------
  // Denotation shared with the ticket sidebar: resolved = ✅/☑️ reaction on the
  // message OR a thread reply starting with ✅ / "resolved" / "done" / "closed".
  var RESOLVE_REACTIONS = { white_check_mark: 1, heavy_check_mark: 1, ballot_box_with_check: 1 };
  var RESOLVE_REPLY_RE = /^\s*(?:✅|☑️?|✔️?|:white_check_mark:|:heavy_check_mark:|resolved\b|done\b|closed\b)/i;
  var reqState = { list: null, showResolved: false, replyState: {}, teamUrl: "", timer: null, ticketIds: [] };

  function msgAllText(m) {
    var parts = [m && m.text || ""];
    ((m && m.blocks) || []).forEach(function (b) {
      if (!b) return;
      if (b.text && b.text.text) parts.push(b.text.text);
      (b.fields || []).forEach(function (f) { if (f && f.text) parts.push(f.text); });
    });
    return parts.join("\n");
  }
  function reqStateOf(m) {
    var rx = (m && m.reactions) || [];
    for (var i = 0; i < rx.length; i++) if (RESOLVE_REACTIONS[rx[i].name]) return "resolved";
    return reqState.replyState[m.ts] || "open";
  }
  function reqPermalink(ch, ts) {
    return reqState.teamUrl ? reqState.teamUrl + "archives/" + ch + "/p" + String(ts).replace(".", "") : "";
  }
  function reqTicketOf(text, ticketIds) {
    for (var i = 0; i < ticketIds.length; i++) {
      if (new RegExp("\\[Ticket #" + ticketIds[i] + "\\]|ticket[^0-9a-z]{0,12}#?" + ticketIds[i] + "\\b", "i").test(text)) return ticketIds[i];
    }
    return "";
  }
  function reqRowHTML(r) {
    var stateBadge = r.state === "resolved" ? '<span class="gv-badge gv-ok">✓ resolved</span>' : '<span class="gv-badge gv-warn">open</span>';
    var link = r.permalink || reqPermalink(r.channel, r.ts);
    return '<div class="card atask"><div class="atask-top"><span class="atask-name">' + esc(String(r.text || "").split("\n")[0].slice(0, 90)) + "</span>" +
      '<span class="atask-right">' + stateBadge + "</span></div>" +
      '<div class="atask-meta">' +
        (r.ticket ? '<a href="#" class="aform-source" data-open-ticket="' + esc(r.ticket) + '">Ticket #' + esc(r.ticket) + "</a> · " : "") +
        "#" + esc(r.channelName) + " · " + (r.reply_count || 0) + " repl" + (r.reply_count === 1 ? "y" : "ies") + " · " + fmtWhen(r.ts) +
        (link ? ' · <a class="aform-source" href="' + esc(link) + '" target="_blank" rel="noopener">Open ↗</a>' : "") + "</div>" +
      (r.state === "open" ? '<div class="atask-meta" style="margin-top:5px"><button class="btn small" type="button" data-req-resolve="' + esc(r.ts) + '" data-req-ch="' + esc(r.channel) + '">Mark resolved</button></div>' : "") +
      "</div>";
  }
  function renderRequests() {
    var body = el("home-req-body"); if (!body) return;
    var list = (reqState.list || []).filter(function (r) { return reqState.showResolved || r.state === "open"; });
    body.innerHTML = list.length ? list.map(reqRowHTML).join("")
      : (reqState.list && reqState.list.length
          ? emptyStateHTML("tasks", "Nothing open — every request is resolved", "Show resolved too to review the history.")
          : emptyStateHTML("inbox", "No requests reference your unsolved tickets", "Workflow submissions mentioning your tickets land here."));
    resize();
  }
  function demoRequests() {
    var now = Date.now() / 1000;
    return [
      { ts: String(now - 5400), channel: "C-S1", channelName: "cx commons", ticket: "481", reply_count: 2, state: "open",
        text: ":zap: CX escalation intake — submitted · Ticket #481 · eligibility re-pull (sample)" },
      { ts: String(now - 9800), channel: "C-S3", channelName: "billing escalations", ticket: "472", reply_count: 0, state: "open",
        text: ":memo: Refund approval request — Ticket #472 · duplicate charge (sample)" },
      { ts: String(now - 90000), channel: "C-S1", channelName: "cx commons", ticket: "455", reply_count: 3, state: "resolved",
        text: ":zap: CX escalation intake — Ticket #455 · superbill resend (sample)" }
    ];
  }
  function loadRequestsLive(ticketIds) {
    var body = el("home-req-body"); if (!body) return;
    if (!cfg.channels.length) { fail("home-req-body", "No Slack channels configured (set slack_channel_ids)."); return; }
    if (!ticketIds.length) { reqState.list = []; renderRequests(); return; }
    reqState.ticketIds = ticketIds;
    var teamP = reqState.teamUrl ? Promise.resolve()
      : slackApi("auth.test", {}).then(function (a) { reqState.teamUrl = (a && a.url) || ""; }, function () {});
    teamP.then(function () {
      return Promise.all(cfg.channels.map(function (ch) {
        return slackApi("conversations.history", { channel: ch.id, limit: 100 }).then(function (r) {
          return (((r && r.messages) || [])).map(function (m) {
            var text = msgAllText(m);
            var tid = reqTicketOf(text, ticketIds);
            return tid ? { ts: m.ts, channel: ch.id, channelName: ch.name, ticket: tid, text: text,
              reply_count: m.reply_count || 0, reactions: m.reactions || [] } : null;
          }).filter(Boolean);
        }, function () { return []; });
      }));
    }).then(function (lists) {
      var all = [];
      lists.forEach(function (l) { l.forEach(function (r) { all.push(r); }); });
      all.sort(function (a, b) { return parseFloat(b.ts) - parseFloat(a.ts); });
      all = all.slice(0, 25);
      var toCheck = all.filter(function (r) {
        return !(r.reactions || []).some(function (x) { return RESOLVE_REACTIONS[x.name]; }) &&
               r.reply_count > 0 && reqState.replyState[r.ts] === undefined;
      }).slice(0, 8);
      return Promise.all(toCheck.map(function (r) {
        return slackApi("conversations.replies", { channel: r.channel, ts: r.ts, limit: 30 }).then(function (rr) {
          var resolved = (((rr && rr.messages) || [])).slice(1).some(function (m) { return RESOLVE_REPLY_RE.test(m.text || ""); });
          reqState.replyState[r.ts] = resolved ? "resolved" : "open";
        }, function () { reqState.replyState[r.ts] = "open"; });
      })).then(function () {
        all.forEach(function (r) { r.state = reqStateOf(r); });
        reqState.list = all;
        renderRequests();
      });
    });
  }
  function markRequestResolved(btn) {
    var ts = btn.getAttribute("data-req-resolve"), ch = btn.getAttribute("data-req-ch");
    if (!client || !cfg.channels.length) { // demo
      (reqState.list || []).forEach(function (r) { if (r.ts === ts) r.state = "resolved"; });
      renderRequests(); return;
    }
    btn.disabled = true; btn.textContent = "Resolving…";
    slackApi("chat.postMessage", { channel: ch, thread_ts: ts, text: "✅ Resolved from the CX home view" })
      .then(function () {
        reqState.replyState[ts] = "resolved";
        (reqState.list || []).forEach(function (r) { if (r.ts === ts) r.state = "resolved"; });
        renderRequests();
      })
      .catch(function () { btn.disabled = false; btn.textContent = "Mark resolved"; });
  }
  function startRequestPoll() {
    if (reqState.timer) return;
    reqState.timer = setInterval(function () {
      if (document.hidden || !reqState.ticketIds.length) return;
      var pane = el("hsub-requests");
      if (pane && pane.classList.contains("active")) loadRequestsLive(reqState.ticketIds);
    }, 45000);
  }

  // ---- channel parsing: "C123:cx commons, C456:prod<>eng" or just "C123,C456" ----
  function parseChannels(raw) {
    return String(raw || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean).map(function (s) {
      var i = s.indexOf(":");
      return i > -1 ? { id: s.slice(0, i).trim(), name: s.slice(i + 1).trim() } : { id: s, name: s };
    });
  }

  function setTicketStatusFromHome(btn) {
    var status = btn.getAttribute("data-set-status");
    var ticketId = btn.getAttribute("data-ticket-id");
    if (!status || !ticketId) return;
    if (!client) {
      btn.textContent = "Demo: " + status; setTimeout(function () { btn.textContent = status === "on-hold" ? "On-hold" : "Pending"; }, 2000);
      return;
    }
    btn.disabled = true;
    client.request({ url: "/api/v2/tickets/" + encodeURIComponent(ticketId) + ".json", type: "PUT",
      contentType: "application/json", dataType: "json",
      data: JSON.stringify({ ticket: { status: status } }) })
      .then(function () {
        btn.textContent = "✓ " + (status === "on-hold" ? "On-hold" : "Pending");
        setTimeout(function () { btn.disabled = false; btn.textContent = status === "on-hold" ? "On-hold" : "Pending"; }, 2500);
      })
      .catch(function () {
        btn.disabled = false;
        btn.textContent = "Failed";
        setTimeout(function () { btn.textContent = status === "on-hold" ? "On-hold" : "Pending"; }, 2000);
      });
  }

  document.addEventListener("click", function (e) {
    if (!e.target || !e.target.closest) return;
    var sub = e.target.closest("#home-subtabs .subtab");
    if (sub) { switchHsub(sub.getAttribute("data-hsub")); return; }
    var rres = e.target.closest("[data-req-resolve]");
    if (rres) { markRequestResolved(rres); return; }
    var rtoggle = e.target.closest("#home-req-toggle");
    if (rtoggle) {
      reqState.showResolved = !reqState.showResolved;
      rtoggle.setAttribute("aria-pressed", String(reqState.showResolved));
      rtoggle.textContent = reqState.showResolved ? "Open only" : "Show resolved too";
      renderRequests(); return;
    }
    var topen = e.target.closest("[data-open-ticket]");
    if (topen) {
      e.preventDefault();
      try { if (client) client.invoke("routeTo", "ticket", topen.getAttribute("data-open-ticket")); } catch (x) {}
      return;
    }
    var rfall = e.target.closest("#home-asana-refresh");
    if (rfall) { doRebuild(); return; }
    var rf = e.target.closest("[data-refresh-gid]");
    if (rf) { refreshCard(rf.getAttribute("data-refresh-gid"), rf); return; }
    var send = e.target.closest(".composer-send");
    if (send) { sendComment(send); return; }
    var ssb = e.target.closest(".asana-status-btn");
    if (ssb) { setTicketStatusFromHome(ssb); return; }
    var tog = e.target.closest(".atask-toggle");
    if (tog) toggleDetail(tog);
  });

  function init() {
    if (!client) {
      el("home-note").hidden = false;
      renderAsanaGroups(demoAsanaGroups());
      renderSlackGroups(demoSlackGroups());
      reqState.list = demoRequests(); renderRequests();
      return;
    }
    client.metadata().then(function (md) {
      var s = (md && md.settings) || {}; s = s.parameters || s;
      cfg.workspace = String(s.asana_workspace_gid || "").trim();
      cfg.projectGid = String(s.asana_project_gid || "").trim();
      cfg.ticketField = String(s.asana_ticket_field_gid || "").trim();
      cfg.teamField = String(s.asana_team_field_gid || "").trim();
      cfg.channels = parseChannels(s.slack_channel_ids);
      cfg.statusButtons = s.asana_status_buttons === true || s.asana_status_buttons === "true";

      var liveAsana = !!cfg.workspace, liveSlack = !!cfg.channels.length;
      if (!liveAsana && !liveSlack) { // full demo
        el("home-note").hidden = false;
        renderAsanaGroups(demoAsanaGroups());
        renderSlackGroups(demoSlackGroups());
        reqState.list = demoRequests(); renderRequests();
        return;
      }
      lazy.slackLive = liveSlack;
      // Lazy boot (3.10.0): first open renders the last snapshot — the full
      // sweep only runs cold (no cache yet) or at the agent's daily slot.
      client.get("currentUser.email").then(function (d) {
        daily.email = (d && d["currentUser.email"]) || "";
        daily.slotMs = slotFor(daily.email);
        el("home-who").textContent = daily.email ? "· " + daily.email : "";
      }).catch(function () {}).then(function () {
        if (liveAsana) {
          var snap = loadCache();
          if (snap && snap.groups) {   // an empty groups array is a real (cached) result
            renderAsanaGroups(snap.groups);
            if (snap.tickets != null) el("home-ticket-count").textContent = snap.tickets;
            setAsOf("As of " + fmtWhen(snap.at) + " · auto-refreshes daily");
            scheduleDailyRebuild(true);
          } else {
            doRebuild();  // cold start: nothing to render from yet
          }
          setInterval(function () { scheduleDailyRebuild(false); }, DAILY_CHECK_MS);
        } else {
          renderAsanaGroups(demoAsanaGroups());
        }
        if (!liveSlack) { renderSlackGroups(demoSlackGroups()); reqState.list = demoRequests(); renderRequests(); }
        // Live Slack panes load on first view (see switchHsub). If the agent
        // already clicked into one while settings were loading, that click did
        // nothing — trigger the lazy load for the pane they're looking at now.
        var activeSub = document.querySelector("#home-subtabs .subtab.active");
        if (activeSub && activeSub.getAttribute("data-hsub") !== "asana") switchHsub(activeSub.getAttribute("data-hsub"));
      });
    }).catch(function () { fail("home-asana-body", "Couldn't read the app settings."); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
