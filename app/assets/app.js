/* ============================================================================
   CX Client Data Sidebar — front end (Zendesk-hosted; Option B)
   ----------------------------------------------------------------------------
   Two data sources, both via ZAF — the browser only ever talks to Zendesk:
     1. Proxied Zendesk API → retained profile/ops features (org, role, phone,
        last seen, profile age, contacts/mo, tags, sentiment, CSAT, latest tickets).
     2. A Zendesk custom object → client context that the resolver wrote at ticket
        creation (eligibility/claims/invoices for clients; credentialing/claims/
        eligibility for providers). No broker, no warehouse credential in the browser.
   ============================================================================ */
(function () {
  "use strict";

  // Option B: at ticket creation the resolver writes the minimum-necessary client
  // context to a Zendesk custom object (keyed by requester email). The app reads it
  // via ZAF — no broker, no warehouse credential in the browser.
  // CONFIRM against your custom object: the object key, that records are keyed by
  // external_id = requester email, and the field holding the context JSON.
  // ⚠️ DEMO MODE: render the app + live ticket details only; the client-context
  // section is stubbed so no custom object is needed. SET TO false FOR PRODUCTION
  // (then the app reads the real client_context custom object).
  var DEMO_MODE = true;
  var CTX_OBJECT_KEY = "client_context";
  var CTX_PAYLOAD_FIELD = "payload";
  // Force-refresh: tagging the ticket with this nudges the resolver (via a Zendesk
  // trigger) to re-pull from Lightdash and rewrite the record. CONFIRM the tag name
  // matches the trigger you set up.
  var REFRESH_TAG = "refresh_client_context";
  var REFRESH_POLL_MS = 2000, REFRESH_MAX_TRIES = 12; // poll up to ~24s

  // Asana flow (sidebar pane). DEMO_MODE renders sample tasks; production POSTs
  // {ticket_id} to the Asana broker's /v1/asana/ticket-tasks (see README/main.py),
  // which holds the single Asana credential and returns the tasks linked to the ticket.
  var ASANA_BROKER_BASE = ""; // e.g. "https://broker.internal.alma" — wired in production
  var asanaState = { loadedVariant: null };

  // Live Asana with NO broker ("direct" mode): set the app's install settings
  // (asana_pat [secure] + asana_workspace_gid [+ optional asana_ticket_field_gid])
  // and the pane talks to Asana through Zendesk's secure proxy — the PAT is
  // substituted server-side ({{setting.asana_pat}}), never visible in the browser.
  // With no settings, the pane falls back to the demo sample tasks.
  var asanaCfg = { workspace: "", ticketField: "", projectGid: "", dedupeDays: 0, statusButtons: false };
  // Slack pane: direct mode posts through Zendesk's secure proxy with
  // {{setting.slack_bot_token}}; with no channel configured it runs on demo data.
  var slackCfg = { channel: "" };
  var settingsReady = Promise.resolve(null);

  // asana_form_config.json lives next to this script (assets/, /static/, …) so the
  // same file works in the Zendesk-hosted app, the broker page, and the dev preview.
  var SCRIPT_BASE = (function () {
    try { return document.currentScript.src.replace(/[^\/]*$/, ""); } catch (e) { return ""; }
  })();

  var client = (typeof ZAFClient !== "undefined") ? ZAFClient.init() : null;

  var state = { ticketId: null, requesterId: null, email: null, tags: [], context: null, refreshing: false, demoVariant: null, zdSubdomain: null };
  var guruModalOpen = false;  // while the Guru pop-out is open, keep the iframe tall enough to read in

  // ── tiny utils ────────────────────────────────────────────────────────
  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function val(v) { return (v == null || v === "") ? "—" : esc(v); }
  function setText(id, t) { var e = el(id); if (e) e.textContent = (t == null || t === "") ? "—" : t; }

  function resize() {
    if (!client) return;
    var h = Math.min(document.documentElement.scrollHeight, 2000);
    if (guruModalOpen) h = Math.max(h, 620); // give the Guru reader room
    try { client.invoke("resize", { width: "100%", height: h }); } catch (e) {}
  }
  try { new ResizeObserver(resize).observe(document.body); window.addEventListener("load", resize); } catch (e) {}

  // ── formatting (ported from the original app) ─────────────────────────
  var fmt = {
    pad: function (n) { return String(n).padStart(2, "0"); },
    initials: function (name) {
      if (!name) return "··";
      var p = String(name).trim().split(/\s+/);
      return ((p[0] && p[0][0]) || "") + ((p[1] && p[1][0]) || "");
    },
    phone: function (p) {
      if (!p) return "—";
      var d = String(p).replace(/\D+/g, "");
      return d.length === 10 ? "(" + d.slice(0, 3) + ") " + d.slice(3, 6) + "-" + d.slice(6) : p;
    },
    date: function (iso) {
      if (!iso) return "—";
      var d = new Date(iso);
      return isNaN(d.getTime()) ? "—" : d.getFullYear() + "-" + fmt.pad(d.getMonth() + 1) + "-" + fmt.pad(d.getDate());
    },
    ageFrom: function (iso) {
      if (!iso) return "—";
      var start = new Date(iso).getTime();
      if (!isFinite(start)) return "—";
      var days = Math.floor((Date.now() - start) / 86400000);
      if (days < 1) return "<1 day";
      if (days < 30) return days + " day" + (days === 1 ? "" : "s");
      var months = Math.floor(days / 30);
      if (months < 12) return months + " mo";
      var years = Math.floor(months / 12), rem = months % 12;
      return years + "y" + (rem ? " " + rem + "m" : "");
    },
    monthStartISO: function () { var d = new Date(); return d.getFullYear() + "-" + fmt.pad(d.getMonth() + 1) + "-01"; },
    csatPercent: function (good, bad) { var t = good + bad; return t ? Math.round((good / t) * 100) + "%" : "—"; }
  };

  function badgeClass(status) {
    var s = (status || "").toLowerCase();
    if (/(active|paid|credentialed|approved|complete|covered|in.?network)/.test(s)) return "ok";
    if (/(pending|in.?review|in.?progress|submitted|open|needs.?review)/.test(s)) return "warn";
    if (/(denied|expired|past.?due|inactive|termed|void|error|out.?of.?network)/.test(s)) return "danger";
    return "neutral";
  }
  function badge(status) { return '<span class="badge ' + badgeClass(status) + '">' + val(status) + "</span>"; }

  // Inline stroke glyphs (currentColor) for list rows, chips and empty states —
  // monochrome + theme-aware where emoji would render as platform color bitmaps.
  var ICONS = {
    collection: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 5.5 8 3l5.5 2.5L8 8 2.5 5.5Z"/><path d="M2.5 8.5 8 11l5.5-2.5"/><path d="M2.5 11.5 8 14l5.5-2.5"/></svg>',
    folder: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 4.5c0-.55.45-1 1-1h3l1.5 1.5H13c.55 0 1 .45 1 1v6c0 .55-.45 1-1 1H3c-.55 0-1-.45-1-1v-7.5Z"/></svg>',
    doc: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 2h5l3 3v9H4V2Z"/><path d="M9 2v3h3"/></svg>',
    search: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/></svg>',
    clock: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/></svg>',
    spark: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.5 9.6 6l4.4 2-4.4 2L8 14.5 6.4 10 2 8l4.4-2L8 1.5Z"/></svg>',
    hash: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M6.5 2 5 14M11 2 9.5 14M2.5 5.5h11M2 10.5h11"/></svg>',
    bolt: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M8.5 2 3.5 9h3l-1 5 5-7h-3l1-5Z"/></svg>'
  };
  function icon(name) { return ICONS[name] || ""; }
  function emptyStateHTML(iconName, title, sub) {
    return '<div class="card"><div class="empty-state">' + icon(iconName) +
      '<div class="es-title">' + esc(title) + "</div>" +
      (sub ? '<div class="es-sub">' + esc(sub) + "</div>" : "") + "</div></div>";
  }

  // ── ZAF API layer (proxied; same as original) ─────────────────────────
  function req(path, opts) { return client.request(Object.assign({ url: path }, opts || {})); }
  function getContext() {
    return client.get(["ticket.id", "ticket.requester.id", "ticket.requester.email", "ticket.tags", "currentUser.role"]).then(function (d) {
      return { ticketId: d["ticket.id"] || null, requesterId: d["ticket.requester.id"] || null, email: d["ticket.requester.email"] || null, tags: d["ticket.tags"] || [], role: d["currentUser.role"] || null };
    });
  }
  function getUser(id) { return id ? req("/api/v2/users/" + id + ".json").then(function (r) { return r.user || null; }) : Promise.resolve(null); }
  function getOrg(id) { return id ? req("/api/v2/organizations/" + id + ".json").then(function (r) { return r.organization || null; }) : Promise.resolve(null); }
  function recentTickets(id, limit) {
    if (!id) return Promise.resolve([]);
    return req("/api/v2/users/" + id + "/tickets/requested.json?sort_by=created_at&sort_order=desc&per_page=" + (limit || 3)).then(function (r) { return r.tickets || []; });
  }
  function contactsThisMonth(email) {
    var q = encodeURIComponent('type:ticket requester:"' + (email || "") + '" created>' + fmt.monthStartISO());
    return req("/api/v2/search.json?query=" + q + "&per_page=1").then(function (r) { return (r && typeof r.count === "number") ? r.count : 0; });
  }
  function csatLastN(id, n) {
    var size = Math.max((n || 6) * 5, 25);
    return req("/api/v2/users/" + id + "/tickets/requested.json?sort_by=created_at&sort_order=desc&per_page=" + size).then(function (r) {
      var rated = (r.tickets || []).filter(function (t) { return t.satisfaction_rating && t.satisfaction_rating.score; }).slice(0, n || 6);
      return tally(rated);
    });
  }
  function csatLast30(id) {
    var since = new Date(Date.now() - 30 * 86400000);
    var iso = since.getFullYear() + "-" + fmt.pad(since.getMonth() + 1) + "-" + fmt.pad(since.getDate());
    var q = encodeURIComponent("type:ticket requester_id:" + id + " created>" + iso);
    return req("/api/v2/search.json?query=" + q + "&per_page=100").then(function (r) {
      return tally((r.results || []).filter(function (t) { return t.satisfaction_rating && t.satisfaction_rating.score; }));
    });
  }
  function tally(rated) {
    var good = rated.filter(function (t) { return String(t.satisfaction_rating.score).toLowerCase() === "good"; }).length;
    var bad = rated.filter(function (t) { return String(t.satisfaction_rating.score).toLowerCase() === "bad"; }).length;
    return { good: good, bad: bad, sample: rated.length };
  }
  function openUser(id) { if (client && id) client.invoke("routeTo", "user", id); }
  function openTicket(id) { if (client && id) client.invoke("routeTo", "ticket", id); }

  // ── retained profile / ops rendering ──────────────────────────────────
  function renderBasics(user, email, role) {
    var name = (user && user.name) || email || "(no name)";
    setText("pf-name", name);
    setText("pf-email", email || (user && user.email) || "");
    el("pf-avatar").textContent = (fmt.initials(name).toUpperCase() || "··");
    setText("m-role", (user && user.role) || role || "—");
    setText("m-phone", fmt.phone(user && (user.phone || user.primary_phone)));
    setText("m-lastseen", fmt.date(user && user.last_login_at));
    setText("m-age", fmt.ageFrom(user && user.created_at));
    renderTags(user && user.tags);
  }
  function renderTags(tags) {
    var w = el("m-tags");
    if (!tags || !tags.length) { w.textContent = "—"; return; }
    w.innerHTML = tags.map(function (t) { return '<span class="chip">' + esc(t) + "</span>"; }).join("");
  }
  function renderSentiment(tickets) {
    var last3 = (tickets || []).slice(0, 3), label = "—";
    if (last3.length) {
      var opened = last3.filter(function (t) { return /new|open|pending|hold/i.test(t.status); }).length;
      var solved = last3.filter(function (t) { return /solved|closed/i.test(t.status); }).length;
      label = solved >= 2 ? "Mostly resolved" : opened >= 2 ? "Multiple open" : "Mixed";
    }
    setText("m-sentiment", label);
  }
  function renderCSAT(id, t) { var e = el(id); if (!e) return; e.textContent = fmt.csatPercent(t.good, t.bad); e.title = "Good: " + t.good + "  Bad: " + t.bad + "  (sample " + t.sample + ")"; }
  function renderTickets(tickets) {
    var host = el("tickets");
    if (!tickets || !tickets.length) { host.innerHTML = '<div class="empty">No recent tickets.</div>'; return; }
    host.innerHTML = tickets.map(function (t) {
      var s = (t.status || "").toLowerCase();
      return '<div class="ticket" data-id="' + t.id + '"><div><div class="subject">' + esc(t.subject || "(no subject)") +
        '</div><div class="meta">#' + t.id + " · " + new Date(t.created_at).toLocaleDateString() + '</div></div><div>' + badge(s) + "</div></div>";
    }).join("");
    Array.prototype.forEach.call(host.querySelectorAll(".ticket"), function (e) {
      e.addEventListener("click", function () { openTicket(Number(e.dataset.id)); });
    });
  }

  function loadProfile(ctx) {
    return getUser(ctx.requesterId).then(function (user) {
      renderBasics(user, ctx.email, ctx.role);
      var orgId = user && user.organization_id;
      getOrg(orgId).then(function (o) { setText("m-org", o && o.name); }).catch(function () { setText("m-org", "—"); });
      recentTickets(ctx.requesterId, 3).then(function (ts) { renderTickets(ts); renderSentiment(ts); }).catch(function () { el("tickets").innerHTML = '<div class="empty">Unavailable.</div>'; });
      contactsThisMonth(ctx.email).then(function (c) { setText("m-contacts", String(c)); }).catch(function () { setText("m-contacts", "—"); });
      csatLastN(ctx.requesterId, 6).then(function (t) { renderCSAT("m-csat6", t); }).catch(function () {});
      csatLast30(ctx.requesterId).then(function (t) { renderCSAT("m-csat30", t); }).catch(function () {});
    }).catch(function (e) { renderBasics(null, ctx.email, ctx.role); });
  }

  // ── Summary card (local ticket digest) ─────────────────────────────────
  // What the ticket is about, the interaction so far, contact history, and the
  // ticket's Asana/Guru signals — all computed inside this iframe from data the
  // agent's Zendesk session already holds (ticket show + comments + requester
  // ticket counts). The digest itself is never posted anywhere. The Guru rows
  // reuse the exact search signals the Guru tab already sends (reason code /
  // tags / subject per install opt-ins); conversation text is used only for
  // the LOCAL topic/entity detection and never leaves the sidebar.
  var sumState = { key: null, sampled: false };

  function getTicketShow(tid) {
    return req("/api/v2/tickets/" + encodeURIComponent(tid) + ".json")
      .then(function (r) { return (r && r.ticket) || null; }).catch(function () { return null; });
  }
  function getConversation(tid) {
    return req("/api/v2/tickets/" + encodeURIComponent(tid) + "/comments.json?include=users&per_page=100")
      .then(function (r) {
        var users = {};
        ((r && r.users) || []).forEach(function (u) { users[u.id] = u; });
        return { comments: (r && r.comments) || [], users: users, truncated: !!(r && r.next_page) };
      }).catch(function () { return { comments: [], users: {}, truncated: false }; });
  }
  function countTickets(rid, extra) {
    if (!rid) return Promise.resolve(null);
    var q = encodeURIComponent("type:ticket requester_id:" + rid + (extra || ""));
    return req("/api/v2/search.json?query=" + q + "&per_page=1")
      .then(function (r) { return (r && typeof r.count === "number") ? r.count : null; })
      .catch(function () { return null; });
  }

  // ── Zendesk intelligent triage (Copilot / Advanced AI add-on) ─────────
  // When the add-on is on, Zendesk's ML writes Intent (being renamed Topic),
  // Sentiment and Language predictions onto the ticket as ordinary fields.
  // Reading them is plain Zendesk-session data — no new egress. Copilot's
  // generative pieces (the Summarize button, auto-assist) have no public API
  // and stay in Zendesk's own context panel. Field IDs come from the optional
  // triage_field_map install setting, else auto-discovery by field title.
  var triageCfg = { map: {} };
  var triageState = { p: null };
  function parseTriageMap(raw) {
    var out = {};
    String(raw || "").split(",").forEach(function (pair) {
      var kv = pair.split(":");
      var k = (kv[0] || "").trim().toLowerCase(), v = (kv[1] || "").trim();
      if (!/^\d+$/.test(v)) return;
      if (k === "intent" || k === "topic") out.intent = v;
      else if (k === "sentiment") out.sentiment = v;
      else if (k === "language") out.language = v;
    });
    return out;
  }
  function triageFieldIds() {
    if (triageState.p) return triageState.p;
    triageState.p = settingsReady.then(function () {
      var m = triageCfg.map || {};
      if (m.intent || m.sentiment || m.language) return m;
      // Auto-detect: triage fields are account-level, titled Intent/Topic,
      // Sentiment, Language (their "… confidence" twins are skipped).
      return req("/api/v2/ticket_fields.json?page[size]=100").then(function (r) {
        var out = {};
        ((r && r.ticket_fields) || []).forEach(function (f) {
          if (!f || !f.id || f.active === false) return;
          var t = String(f.title || "").trim().toLowerCase();
          if (t === "intent" || t === "topic") out.intent = out.intent || String(f.id);
          else if (t === "sentiment") out.sentiment = out.sentiment || String(f.id);
          else if (t === "language") out.language = out.language || String(f.id);
        });
        return out;
      }).catch(function () { return {}; });
    });
    return triageState.p;
  }
  function triageValues() {
    return triageFieldIds().then(function (map) {
      var keys = Object.keys(map);
      if (!keys.length || !client) return null;
      var paths = keys.map(function (k) { return "ticket.customField:custom_field_" + map[k]; });
      return client.get(paths).then(function (d) {
        var out = null;
        keys.forEach(function (k, i) {
          var v = d && d[paths[i]];
          if (v != null && v !== "") { out = out || {}; out[k] = String(v); }
        });
        return out;
      }).catch(function () { return null; });
    });
  }
  // Taxonomy values arrive as tags ("billing__dispute_charge", "very_negative");
  // show the leaf, humanized.
  function triagePretty(v) {
    var seg = String(v || "").trim().split(/::|__/).pop().replace(/_+/g, " ").trim();
    return seg ? seg.charAt(0).toUpperCase() + seg.slice(1) : String(v || "");
  }
  function triageSentClass(v) {
    if (/neg/i.test(v)) return " sum-ai-neg";
    if (/pos/i.test(v)) return " sum-ai-pos";
    return "";
  }

  // Topic detection: keyword → chip, aligned with the CX reason-code families.
  var SUM_TOPICS = [
    { label: "Eligibility / benefits", re: /\beligib|benefit|coverage|copay|co-pay|coinsurance|deductible|in[- ]network|out[- ]of[- ]network|\bOON\b/i },
    { label: "Claims / billing", re: /\bclaims?\b|\bEOB\b|denial|denied|billed|billing|superbill|reimburs/i },
    { label: "Invoices / payments", re: /\binvoice|payment|refund|charge|balance|autopay|credit card/i },
    { label: "Scheduling", re: /\bappointment|session|reschedul|cancell?ation|availability/i },
    { label: "Credentialing", re: /\bcredential|\bCAQH\b|\bpanel\b|\bNPI\b|\broster\b|attestation/i },
    { label: "Portal / access", re: /\blog[- ]?in\b|password|portal|locked out|\b2fa\b|\bmfa\b/i },
    { label: "Insurance change", re: /\bnew insurance|switch(ed)? (insurance|plans?)|open enrollment|\bCOBRA\b/i }
  ];
  // Payer names for entity chips — seeded with the common set; the client
  // context payload (eligibility/claims) adds this requester's actual payers.
  var SUM_PAYERS = ["Aetna", "Cigna", "UnitedHealthcare", "United Healthcare", "UHC", "Optum",
    "Anthem", "BCBS", "Blue Cross", "Blue Shield", "Kaiser", "Humana", "Oscar", "Oxford",
    "Medicare", "Medicaid", "Tricare", "Magellan", "Carelon"];

  // Strip quoted replies, signatures and greetings so the gist is the ask itself.
  function sumClean(body) {
    var lines = String(body || "").split(/\r?\n/), keep = [];
    for (var i = 0; i < lines.length; i++) {
      var L = lines[i];
      if (/^\s*>/.test(L)) continue;
      if (/^\s*On .{8,90} wrote:\s*$/.test(L)) break;
      if (/^\s*(--\s*$|__|Sent from my|Get Outlook)/i.test(L)) break;
      if (/^\s*(thanks|thank you|best|regards|warmly|sincerely|cheers)[,!. ]*$/i.test(L)) break;
      keep.push(L);
    }
    return keep.join(" ").replace(/\s+/g, " ").trim();
  }
  function sumGist(text, max) {
    max = max || 210;
    var t = sumClean(text).replace(/^\s*(hi|hello|hey|good (morning|afternoon|evening))\b[^.!?]{0,40}?[,.!—-]\s*/i, "");
    if (t.length <= max) return t;
    var cut = t.slice(0, max);
    var stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
    return stop > 60 ? cut.slice(0, stop + 1) : cut.replace(/\s+\S*$/, "") + "…";
  }

  function buildDigest(ticket, convo, ctx) {
    var users = convo.users || {};
    function isRequester(c) {
      if (ctx.requesterId && c.author_id === ctx.requesterId) return true;
      var u = users[c.author_id];
      return !!(u && u.role === "end-user");
    }
    var all = (convo.comments || []).slice().sort(function (a, b) {
      return new Date(a.created_at || 0) - new Date(b.created_at || 0);
    });
    var pub = all.filter(function (c) { return c.public !== false; });
    var fromClient = pub.filter(isRequester);
    var fromTeam = pub.filter(function (c) { return !isRequester(c); });
    var firstClient = fromClient[0] || pub[0] || null;
    var last = pub[pub.length - 1] || null;
    var attach = 0;
    all.forEach(function (c) { attach += (c.attachments || []).length; });

    var scanSubject = (ticket && ticket.subject) || "";
    var scanBody = fromClient.map(function (c) { return c.plain_body || c.body || ""; }).join("\n");
    var scanAll = scanSubject + "\n" + scanBody;

    var topics = [];
    SUM_TOPICS.forEach(function (t) {
      var score = (t.re.test(scanSubject) ? 2 : 0) + (t.re.test(scanBody) ? 1 : 0);
      if (score) topics.push({ label: t.label, score: score });
    });
    topics.sort(function (a, b) { return b.score - a.score; });

    // Entity chips: reference/claim ids, amounts, payers, dates of service.
    var ents = [], seen = {};
    function addEnt(v) { var k = String(v).toLowerCase(); if (!seen[k] && ents.length < 6) { seen[k] = 1; ents.push(String(v)); } }
    (scanAll.match(/\b[A-Z]{2,5}-?\d{3,}(?:-\d{2,})*\b/g) || []).slice(0, 3).forEach(addEnt);
    (scanAll.match(/\$\s?\d[\d,]*(?:\.\d{2})?/g) || []).slice(0, 2).forEach(addEnt);
    var payers = SUM_PAYERS.slice();
    var cx = state.context || {};
    [].concat(cx.eligibility || [], cx.claims || []).forEach(function (r) { if (r && r.payer) payers.push(String(r.payer)); });
    var seenPayer = {};
    payers.forEach(function (p) {
      var k = p.toLowerCase(); if (seenPayer[k]) return; seenPayer[k] = 1;
      var safe = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp("\\b" + safe + "\\b", "i").test(scanAll)) addEnt(p);
    });
    (scanAll.match(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g) || []).slice(0, 2).forEach(addEnt);

    return {
      ticket: ticket,
      gist: firstClient ? sumGist(firstClient.plain_body || firstClient.body) : "",
      topics: topics.slice(0, 2).map(function (t) { return t.label; }),
      entities: ents,
      counts: { client: fromClient.length, team: fromTeam.length, notes: all.length - pub.length, attach: attach, truncated: !!convo.truncated },
      last: last ? { client: isRequester(last), who: isRequester(last) ? "client" : (((users[last.author_id] || {}).name || "agent").split(" ")[0]), at: last.created_at } : null,
      waiting: last ? (isRequester(last) ? "us" : "client") : null
    };
  }

  // Demo conversation (per variant) so the card renders with no API/credentials —
  // same convention as the demo Asana tasks / Guru cards, clearly marked sample.
  function demoConvo(variant) {
    function c(author, pub, daysAgo, text) {
      return { author_id: author, public: pub, created_at: new Date(Date.now() - daysAgo * 86400000).toISOString(), plain_body: text, attachments: [] };
    }
    var reqId = 777001, agentId = 777002;
    var users = {};
    users[reqId] = { id: reqId, name: variant === "provider" ? "Dr. Sample Provider" : "Sample Client", role: "end-user" };
    users[agentId] = { id: agentId, name: "Jordan (CX)", role: "agent" };
    var comments = variant === "provider"
      ? [c(reqId, true, 4, "Hi team, following up on my Cigna Behavioral credentialing — CAQH attestation was refreshed last week and I still show out-of-network in the portal. Can you confirm my panel effective date?"),
         c(agentId, true, 3, "Thanks for flagging! Checking with Credentialing Ops on the attestation and the panel effective date now."),
         c(agentId, false, 3, "Internal: Asana task open with Cred Ops — waiting on the payer liaison."),
         c(reqId, true, 1, "Any update? A client with Cigna wants to book for the 15th.")]
      : [c(reqId, true, 3, "Hi, my last EOB shows a $60 copay for claim CLM-2026-0142 but my plan says $25 for in-network sessions. Cigna told me to check with you. Date of service was 5/28. Can you help me sort this out?"),
         c(agentId, true, 2, "Happy to help — pulling your eligibility record and the claim now. You should see an update within 1 business day."),
         c(agentId, false, 2, "Internal: eligibility shows $25 copay tier — likely a payer adjudication error; re-pull the EOB."),
         c(reqId, true, 1, "Thank you! Also confirming my deductible was already met this year.")];
    return {
      comments: comments, users: users, truncated: false, sample: true, requesterId: reqId,
      ticketStub: {
        subject: variant === "provider" ? "Credentialing status — Cigna Behavioral panel" : "Copay billed higher than plan — claim CLM-2026-0142",
        status: "open", created_at: comments[0].created_at, via: { channel: "email" }
      },
      statsStub: { total: 4, open: 2 }
    };
  }

  // Asana signal: linked tasks for THIS ticket, via whichever mode the Asana
  // pane itself would use (direct search / demo sample / broker seam).
  function summaryAsana(tid) {
    return settingsReady.then(function () {
      if (asanaCfg.workspace) {
        if (!tid) return null;
        var ticketUrl = state.zdSubdomain ? "https://" + state.zdSubdomain + ".zendesk.com/agent/tickets/" + tid : null;
        var match = asanaCfg.ticketField
          ? "custom_fields." + encodeURIComponent(asanaCfg.ticketField) + ".value=" + encodeURIComponent(ticketUrl || tid)
          : "text=" + encodeURIComponent(tid);
        return asanaApi("/workspaces/" + encodeURIComponent(asanaCfg.workspace) + "/tasks/search?" + match +
          (asanaCfg.projectGid ? "&projects.any=" + encodeURIComponent(asanaCfg.projectGid) : "") +
          "&opt_fields=name,completed")
          .then(function (r) { return ((r && r.data) || []).map(function (t) { return { name: t.name, completed: !!t.completed }; }); })
          .catch(function () { return null; });
      }
      if (DEMO_MODE) {
        return demoAsanaTasks(tid, currentVariant()).map(function (t) { return { name: t.name, completed: !!t.completed }; });
      }
      if (!ASANA_BROKER_BASE || !tid) return null;
      return fetch(ASANA_BROKER_BASE + "/v1/asana/ticket-tasks", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket_id: String(tid) })
      }).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
        .then(function (j) { return (j.tasks || []).map(function (t) { return { name: t.name, completed: !!t.completed }; }); })
        .catch(function () { return null; });
    });
  }

  // Guru signal: top matched cards, reusing the Suggested tab's exact signals
  // (reason code, then tags/subject per the existing install opt-ins). No new
  // egress: nothing conversation-derived is ever sent.
  function summaryGuru() {
    return settingsReady.then(function () {
      if (guruMode() === "demo") {
        return GURU_DEMO_CARDS.slice(0, 3).map(function (c, i) {
          var d = normalizeGuruCard(c); d.why = i === 0 ? "reason code" : "ticket tags"; return d;
        });
      }
      return guruReasonCode().then(function (reason) {
        var queries = [];
        if (reason) queries.push({ term: reason, why: "reason code" });
        var tagTerm = guruCfg.suggestTags ? (state.tags || []).slice(0, 5).join(" ").trim() : "";
        if (tagTerm) queries.push({ term: tagTerm, why: "ticket tags" });
        var subjP = (guruCfg.suggestSubject && client)
          ? client.get("ticket.subject").then(function (d) { return String((d && d["ticket.subject"]) || "").trim(); }).catch(function () { return ""; })
          : Promise.resolve("");
        return subjP.then(function (subject) {
          if (subject) queries.push({ term: subject, why: "subject" });
          if (!queries.length) return [];
          return Promise.all(queries.slice(0, 2).map(function (q) {
            return guruApi("/search/query?searchTerms=" + encodeURIComponent(q.term) + "&maxResults=3", { subtype: "sidebar-summary" })
              .then(function (r) { return { why: q.why, cards: guruHits(r) }; })
              .catch(function () { return { why: q.why, cards: [] }; });
          })).then(function (groups) {
            var seenIds = {}, rows = [];
            groups.forEach(function (g) {
              g.cards.forEach(function (c) { if (!seenIds[c.id]) { seenIds[c.id] = 1; c.why = g.why; rows.push(c); } });
            });
            return rows.slice(0, 3);
          });
        });
      });
    });
  }

  function sumChip(label, cls) { return '<span class="chip' + (cls ? " " + cls : "") + '">' + esc(label) + "</span>"; }
  function sumKV(k, vHTML) { return '<div class="kv"><div class="k">' + esc(k) + '</div><div class="v">' + vHTML + "</div></div>"; }

  function renderSummary(d, hist, sampled, ai) {
    var host = el("summary-body"); if (!host) return;
    var t = d.ticket || {};
    // Intelligent-triage chips lead when present; the local keyword topics
    // only fill in when there's no ML intent to show. Entities always render.
    var aiChips = "";
    if (ai && ai.intent) aiChips += '<span class="chip sum-ai" title="Zendesk intelligent triage — intent/topic prediction">✦ ' + esc(triagePretty(ai.intent)) + "</span>";
    if (ai && ai.sentiment) aiChips += '<span class="chip sum-ai' + triageSentClass(ai.sentiment) + '" title="Zendesk intelligent triage — customer sentiment">✦ ' + esc(triagePretty(ai.sentiment)) + "</span>";
    if (ai && ai.language && !/^en(glish)?([-_].*)?$/i.test(ai.language.trim())) aiChips += '<span class="chip sum-ai" title="Zendesk intelligent triage — detected language">✦ ' + esc(triagePretty(ai.language)) + "</span>";
    var topicChips = (ai && ai.intent) ? [] : d.topics.map(function (x) { return sumChip(x, "sum-topic"); });
    var chips = aiChips + topicChips
      .concat(d.entities.map(function (x) { return sumChip(x); })).join("");
    var waitHTML = d.waiting === "client"
      ? '<span class="badge neutral">Client reply</span>'
      : d.waiting === "us" ? '<span class="badge warn">Our reply</span>' : "—";
    var msgs = d.counts.client + " client · " + d.counts.team + " team" +
      (d.counts.notes ? " · " + d.counts.notes + " note" + (d.counts.notes === 1 ? "" : "s") : "");
    var lastHTML = d.last ? esc((d.last.client ? "Client" : d.last.who) + " · " + fmt.date(d.last.at)) : "—";
    var histBits = [];
    if (hist && hist.total != null) histBits.push(hist.total + " ticket" + (hist.total === 1 ? "" : "s") + " all-time");
    if (hist && hist.open != null) histBits.push(hist.open + " open now");

    host.innerHTML =
      (d.gist ? '<div class="sum-gist">' + esc(d.gist) + "</div>" : '<div class="empty">No public messages on this ticket yet.</div>') +
      (chips ? '<div class="chips sum-chips">' + chips + "</div>" : "") +
      '<div class="kv-grid sum-grid">' +
        sumKV("Status", t.status ? badge(t.status) : "—") +
        sumKV("Channel", esc((t.via && t.via.channel) || "—")) +
        sumKV("Opened", t.created_at ? esc(fmt.ageFrom(t.created_at) + " ago") : "—") +
        sumKV("Messages", esc(msgs)) +
        sumKV("Last message", lastHTML) +
        sumKV("Waiting on", waitHTML) +
      "</div>" +
      (histBits.length ? '<div class="sum-hist">' + esc(histBits.join(" · ")) +
        ' <button class="sum-link" type="button" data-sum-nav="asana:other">Check Asana history →</button></div>' : "") +
      '<div class="sum-block" id="sum-asana"><div class="sum-block-head">Asana · this ticket</div><div class="skeleton" style="width:55%"></div></div>' +
      '<div class="sum-block" id="sum-guru"><div class="sum-block-head">Likely Guru cards</div><div class="skeleton" style="width:65%"></div></div>' +
      '<div class="sum-cap">' + (sampled ? "Sample conversation (demo). " : "") +
        (d.counts.truncated ? "Digest covers the first 100 messages. " : "") +
        "Digest computed in this sidebar — nothing new leaves Zendesk." +
        (aiChips ? " ✦ chips are Zendesk AI (intelligent triage) predictions." : "") + "</div>";
    resize();
  }

  function renderSummaryAsana(tasks) {
    var box = el("sum-asana"); if (!box) return;
    var head = '<div class="sum-block-head">Asana · this ticket</div>';
    if (tasks === null) { box.innerHTML = head + '<div class="empty">Not connected.</div>'; resize(); return; }
    if (!tasks.length) {
      box.innerHTML = head + '<div class="empty">No linked tasks. <button class="sum-link" type="button" data-sum-nav="asana:request">Create one →</button></div>';
      resize(); return;
    }
    var open = tasks.filter(function (t) { return !t.completed; }).length;
    var rows = tasks.slice(0, 2).map(function (t) {
      return '<div class="sum-row"><span class="sum-dot ' + (t.completed ? "done" : "open") + '"></span>' +
        '<span class="sum-row-name">' + esc(t.name) + "</span></div>";
    }).join("");
    box.innerHTML = head.replace("</div>", ' <span class="count-pill">' + tasks.length + "</span></div>") + rows +
      '<button class="sum-link" type="button" data-sum-nav="asana:linked">' +
      open + " open · " + (tasks.length - open) + " done — open tab →</button>";
    resize();
  }

  function renderSummaryGuru(cards) {
    var box = el("sum-guru"); if (!box) return;
    var head = '<div class="sum-block-head">Likely Guru cards</div>';
    box.innerHTML = head + (cards && cards.length
      ? guruRowsHTML(cards, "", "", "spark") +
        '<button class="sum-link" type="button" data-sum-nav="guru">More in the Guru tab →</button>'
      : '<div class="empty">No signals to match yet — <button class="sum-link" type="button" data-sum-nav="guru">search Guru →</button></div>');
    resize();
  }

  function loadSummary(ctx) {
    var host = el("summary-body"); if (!host) return;
    var key = String(ctx.ticketId || "") + "|" + (state.demoVariant || "");
    sumState.key = key;
    Promise.all([
      ctx.ticketId ? getTicketShow(ctx.ticketId) : Promise.resolve(null),
      ctx.ticketId ? getConversation(ctx.ticketId) : Promise.resolve({ comments: [], users: {}, truncated: false }),
      countTickets(ctx.requesterId),
      countTickets(ctx.requesterId, " status<solved"),
      triageValues()
    ]).then(function (res) {
      if (sumState.key !== key) return; // a newer load superseded this one
      var ticket = res[0], convo = res[1], total = res[2], open = res[3], ai = res[4];
      var sampled = false;
      if ((!convo.comments || !convo.comments.length) && DEMO_MODE) {
        convo = demoConvo(currentVariant());
        sampled = true;
        if (!ticket) ticket = convo.ticketStub;
        if (total == null) total = convo.statsStub.total;
        if (open == null) open = convo.statsStub.open;
        ctx = { ticketId: ctx.ticketId, requesterId: convo.requesterId, email: ctx.email };
      }
      renderSummary(buildDigest(ticket, convo, ctx), { total: total, open: open }, sampled, ai);
      summaryAsana(ctx.ticketId).then(renderSummaryAsana).catch(function () { renderSummaryAsana(null); });
      summaryGuru().then(renderSummaryGuru).catch(function () { renderSummaryGuru([]); });
    });
  }

  // ── client context rendering (from the custom object) ─────────────────
  function field(k, v) { return '<div class="f"><span class="fk">' + esc(k) + '</span><span class="fv">' + val(v) + "</span></div>"; }

  function eligibilityRec(e, withClient) {
    return '<div class="rec"><div class="rec-top"><div><div class="rec-title">' + val(e.payer) + " · " + val(e.plan) +
      '</div>' + (withClient ? '<div class="rec-client">' + val(e.client_label) + "</div>" : "") +
      '<div class="rec-sub">Checked ' + val(e.checked_at) + "</div></div>" + badge(e.status) + "</div>" +
      '<div class="rec-grid">' + field("Copay", e.copay) + field("Coinsurance", e.coinsurance) + field("Deductible", e.deductible_met) + "</div></div>";
  }
  function claimRec(c, withClient) {
    return '<div class="rec"><div class="rec-top"><div><div class="rec-title">' + val(c.claim_id) +
      '</div>' + (withClient ? '<div class="rec-client">' + val(c.client_label) + "</div>" : "") +
      '<div class="rec-sub">' + val(c.payer) + " · DOS " + val(c.date_of_service) + "</div></div>" + badge(c.status) + "</div>" +
      '<div class="rec-grid">' + field("Billed", c.billed_amount) + field("Allowed", c.allowed_amount) + field("Patient resp.", c.patient_responsibility) + "</div></div>";
  }
  function invoiceRec(i) {
    return '<div class="rec"><div class="rec-top"><div><div class="rec-title">' + val(i.invoice_id) +
      '</div><div class="rec-sub">Issued ' + val(i.issued_date) + " · Due " + val(i.due_date) + "</div></div>" + badge(i.status) + "</div>" +
      '<div class="rec-grid">' + field("Amount", i.amount) + field("Balance", i.balance) + "</div></div>";
  }
  function credRec(c) {
    return '<div class="rec"><div class="rec-top"><div><div class="rec-title">' + val(c.payer) +
      '</div><div class="rec-sub">' + val(c.network) + "</div></div>" + badge(c.status) + "</div>" +
      '<div class="rec-grid">' + field("Effective", c.effective_date) + field("Expires", c.expires_date) + "</div></div>";
  }

  function chevron() {
    return '<button class="chevron" type="button" aria-label="Toggle section" aria-expanded="true">' +
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg></button>';
  }
  function listCard(title, items, render, emptyMsg, withClient, key) {
    var n = (items && items.length) || 0;
    var body = n ? items.map(function (x) { return render(x, withClient); }).join("") : '<div class="empty">' + esc(emptyMsg) + "</div>";
    return '<div class="card collapsible" data-collapse-key="' + esc(key) + '"><div class="section-head"><h2>' + esc(title) +
      '</h2><div class="head-right"><span class="count-pill">' + n + "</span>" + chevron() + "</div></div>" +
      '<div class="collapse-body">' + body + "</div></div>";
  }
  function collapsibleCard(title, bodyId, key) {
    return '<div class="card collapsible" data-collapse-key="' + esc(key) + '"><div class="section-head"><h2>' + esc(title) +
      '</h2><div class="head-right"><span class="count-pill" id="' + bodyId + '-count">0</span>' + chevron() + "</div></div>" +
      '<div class="collapse-body" id="' + bodyId + '"></div></div>';
  }

  function clientHTML(d) {
    return listCard("Eligibility checks", d.eligibility, eligibilityRec, "No eligibility checks on file.", false, "eligibility") +
      listCard("Claims", d.claims, claimRec, "No claims on file.", false, "claims") +
      listCard("Invoices", d.invoices, invoiceRec, "No invoices on file.", false, "invoices");
  }

  function onboardingBadge(status) {
    var s = (status || "").toLowerCase();
    var cls = s === "onboarded" ? "ok" : s === "onboarding" ? "warn" : s === "offboarded" ? "danger" : "neutral";
    return '<span class="badge ' + cls + '">' + val(status) + "</span>";
  }
  function onboardingCard(o) {
    o = o || {};
    return '<div class="card"><div class="section-head"><h2>Onboarding</h2></div>' +
      '<div class="rec-top"><div class="rec-title">Provider status</div>' + onboardingBadge(o.status) + "</div>" +
      (o.since ? '<div class="rec-sub">Since ' + val(o.since) + "</div>" : "") + "</div>";
  }
  function clientSearchCard(d) {
    var n = (d.clients && d.clients.length) || 0;
    var opts = (d.clients || []).map(function (c) { return '<option value="' + esc(c.label) + '">' + esc(c.client_id) + "</option>"; }).join("");
    return '<div class="card"><div class="section-head"><h2>Client lookup</h2><span class="count-pill">' + n + "</span></div>" +
      '<div class="search-row">' +
      '<input class="search-input" id="client-search" list="client-list" placeholder="Search client name or ID…" autocomplete="off" />' +
      '<datalist id="client-list">' + opts + "</datalist>" +
      '<button class="btn primary" id="client-load" type="button">Load</button></div>' +
      '<div class="search-hint" id="client-hint">Search a client to load their eligibility, claims &amp; invoices.</div></div>';
  }

  function providerHTML(d) {
    return listCard("Credentialing", d.credentialing, credRec, "No credentialing records on file.", false, "credentialing") +
      onboardingCard(d.onboarding) +
      clientSearchCard(d) +
      collapsibleCard("Eligibility checks", "prov-elig", "eligibility") +
      collapsibleCard("Claims", "prov-claims", "claims") +
      collapsibleCard("Invoices", "prov-invoices", "invoices");
  }

  function setClientHint(msg) { var h = el("client-hint"); if (h) h.textContent = msg; }

  function wireClientSearch(d) {
    var btn = el("client-load"), input = el("client-search");
    function go() {
      var ref = ((input && input.value) || "").trim();
      if (!ref) return;
      var clients = d.clients || [];
      var match = clients.filter(function (c) { return c.client_id === ref || (c.label || "").toLowerCase() === ref.toLowerCase(); })[0] ||
        clients.filter(function (c) { return (c.label || "").toLowerCase().indexOf(ref.toLowerCase()) > -1; })[0];
      if (!match) { setClientHint("No client matches “" + ref + "”."); return; }
      loadProviderClient(d, match.client_id, match.label);
    }
    if (btn) btn.addEventListener("click", go);
    if (input) input.addEventListener("keydown", function (e) { if (e.key === "Enter") go(); });
  }

  function fillBody(id, items, render, emptyMsg) {
    var body = el(id); if (!body) return;
    body.innerHTML = items.length ? items.map(function (x) { return render(x); }).join("") : '<div class="empty">' + esc(emptyMsg) + "</div>";
    var c = el(id + "-count"); if (c) c.textContent = items.length;
  }
  function renderProviderClientDetail(detail) {
    if (!detail) {
      ["prov-elig", "prov-claims", "prov-invoices"].forEach(function (id) {
        var b = el(id); if (b) b.innerHTML = '<div class="empty">Search a client above to load this.</div>';
        var c = el(id + "-count"); if (c) c.textContent = "0";
      });
      applyCollapsed(); resize(); return;
    }
    fillBody("prov-elig", detail.eligibility || [], function (e) { return eligibilityRec(e, false); }, "No eligibility checks.");
    fillBody("prov-claims", detail.claims || [], function (c) { return claimRec(c, false); }, "No claims.");
    fillBody("prov-invoices", detail.invoices || [], invoiceRec, "No invoices.");
    applyCollapsed(); resize();
  }

  // Load one client's detail (chart 2). DEMO simulates; real mode nudges the resolver
  // with the chosen client_id (a load_client_<id> tag → trigger) and polls selected_client.
  function loadProviderClient(d, clientId, label) {
    setClientHint("Loading " + label + "…");
    ["prov-elig", "prov-claims", "prov-invoices"].forEach(function (id) {
      var b = el(id); if (b) b.innerHTML = '<div class="skeleton" style="width:80%"></div><div class="skeleton" style="width:55%;margin-top:8px"></div>';
      var c = el(id + "-count"); if (c) c.textContent = "·";
    });
    if (DEMO_MODE) {
      setTimeout(function () { setClientHint("Showing " + label); renderProviderClientDetail(demoClientDetail(clientId, label)); }, 1200);
      return;
    }
    client.request({
      url: "/api/v2/tickets/" + state.ticketId + ".json",
      type: "PUT", contentType: "application/json",
      data: JSON.stringify({ ticket: { additional_tags: ["load_client_" + clientId] } })
    }).then(function () { pollClientDetail(clientId, label, 0); })
      .catch(function () { setClientHint("Couldn’t load " + label + "."); });
  }
  function pollClientDetail(clientId, label, tries) {
    readContextRecord(state.email).then(function (payload) {
      var sc = payload && payload.selected_client;
      if (sc && sc.client_id === clientId) { state.context = payload; setClientHint("Showing " + label); renderProviderClientDetail(sc); return; }
      if (tries < REFRESH_MAX_TRIES) { setTimeout(function () { pollClientDetail(clientId, label, tries + 1); }, REFRESH_POLL_MS); }
      else { setClientHint("Couldn’t load " + label + " (timed out)."); }
    }).catch(function () {
      if (tries < REFRESH_MAX_TRIES) { setTimeout(function () { pollClientDetail(clientId, label, tries + 1); }, REFRESH_POLL_MS); }
      else { setClientHint("Couldn’t load " + label + "."); }
    });
  }

  function renderContext(d) {
    state.context = d;
    spinRefresh(false);
    var t = d.requester_type === "provider" ? "provider" : "client";
    var badgeEl = el("pf-type");
    badgeEl.hidden = false; badgeEl.textContent = t === "provider" ? "Provider" : "Client"; badgeEl.className = "type-badge " + t;

    el("sample-note").hidden = JSON.stringify(d).indexOf("(sample)") === -1;

    var shell = el("context-shell");
    el("context-error").hidden = true; shell.hidden = false;
    shell.innerHTML = t === "provider" ? providerHTML(d) : clientHTML(d);

    if (t === "provider") {
      wireClientSearch(d);
      renderProviderClientDetail(d.selected_client || null);
    }
    applyCollapsed();
    renderFreshness(d.freshness);
    resize();
  }

  function renderFreshness(f) {
    var e = el("freshness");
    if (!f) { e.hidden = true; e.textContent = ""; return; }
    var when = f.as_of ? new Date(f.as_of).toLocaleString() : "";
    e.hidden = false;
    e.className = "stamp" + (f.stale ? " stale" : "");
    e.textContent = f.stale ? "Showing last known data (as of " + when + ")" : "As of " + when;
  }

  function spinRefresh(on) { var b = el("btn-refresh"); if (b) b.classList.toggle("spinning", on); }

  // Lightdash/Metabase-style reload: blank each card body to shimmering skeleton bars.
  function showCardSkeletons() {
    Array.prototype.forEach.call(document.querySelectorAll("#context-shell .collapse-body"), function (body) {
      body.innerHTML = '<div class="skeleton" style="width:82%"></div>' +
        '<div class="skeleton" style="width:55%;margin-top:8px"></div>' +
        '<div class="skeleton" style="width:70%;margin-top:8px"></div>';
    });
    Array.prototype.forEach.call(document.querySelectorAll("#context-shell .count-pill"), function (c) { c.textContent = "·"; });
  }

  function refreshDone() {
    state.refreshing = false; spinRefresh(false);
    renderFreshness(state.context && state.context.freshness);
  }

  // Force-refresh: nudge the resolver (via a ticket tag → Zendesk trigger) to re-pull
  // from Lightdash, then poll the record until generated_at changes. The browser never
  // calls Lightdash — it only tags the ticket and re-reads Zendesk.
  function forceRefresh() {
    if (state.refreshing) return;
    state.refreshing = true;
    spinRefresh(true);
    loadSummary({ ticketId: state.ticketId, requesterId: state.requesterId, email: state.email });
    var fr = el("freshness"); if (fr) { fr.hidden = false; fr.className = "stamp"; fr.textContent = "Refreshing…"; }
    showCardSkeletons();
    if (DEMO_MODE) {
      setTimeout(function () { state.refreshing = false; spinRefresh(false); renderContext(demoPayload()); }, 1400);
      return;
    }
    var before = (state.context && state.context.generated_at) || "";
    nudgeResolver(state.ticketId)
      .then(function () { pollForUpdate(state.email, before, 0); })
      .catch(function () { refreshDone(); });
  }

  function nudgeResolver(ticketId) {
    return client.request({
      url: "/api/v2/tickets/" + ticketId + ".json",
      type: "PUT", contentType: "application/json",
      data: JSON.stringify({ ticket: { additional_tags: [REFRESH_TAG] } })
    });
  }

  function pollForUpdate(email, before, tries) {
    readContextRecord(email).then(function (payload) {
      if (payload && payload.generated_at && payload.generated_at !== before) {
        state.refreshing = false; spinRefresh(false); renderContext(payload); return;
      }
      if (tries < REFRESH_MAX_TRIES) { setTimeout(function () { pollForUpdate(email, before, tries + 1); }, REFRESH_POLL_MS); }
      else { refreshDone(); }
    }).catch(function () {
      if (tries < REFRESH_MAX_TRIES) { setTimeout(function () { pollForUpdate(email, before, tries + 1); }, REFRESH_POLL_MS); }
      else { refreshDone(); }
    });
  }

  function showContextError(msg) {
    el("context-shell").hidden = true;
    el("freshness").hidden = true;
    el("context-error-msg").textContent = msg || "Couldn’t load client context.";
    el("context-error").hidden = false;
    resize();
  }

  function loadContext(ctx) {
    if (DEMO_MODE) { renderContext(demoPayload()); return Promise.resolve(); }
    el("context-shell").hidden = false;
    el("context-error").hidden = true;
    if (!ctx || !ctx.email) { showContextError("No requester email on this ticket."); return Promise.resolve(); }
    return readContextRecord(ctx.email).then(function (payload) {
      if (!payload) { showContextError("No client context on file for this requester yet."); return; }
      renderContext(payload); // payload is the same JSON shape the UI already renders
    }).catch(function () { showContextError(); });
  }

  // Read the client-context record the resolver wrote for this requester. The browser
  // only talks to Zendesk (where the agent is already authenticated), never a warehouse.
  // CONFIRM the exact lookup against your custom object API (key, keying, field name).
  function readContextRecord(email) {
    var path = "/api/v2/custom_objects/" + CTX_OBJECT_KEY +
      "/records?filter[external_id]=" + encodeURIComponent(email);
    return client.request({ url: path, dataType: "json" }).then(function (r) {
      var rec = r && r.custom_object_records && r.custom_object_records[0];
      if (!rec) return null;
      var raw = rec.custom_object_fields ? rec.custom_object_fields[CTX_PAYLOAD_FIELD] : null;
      if (!raw) return null;
      return (typeof raw === "string") ? JSON.parse(raw) : raw;
    });
  }

  function isProviderTag() { return (state.tags || []).some(function (t) { return /provider/i.test(t); }); }
  function currentVariant() { return state.demoVariant || (isProviderTag() ? "provider" : "client"); }

  // Demo payload: provider or client (the demo toggle, or the ticket's end_user_* tag).
  // DEMO_MODE only; all values are clearly marked "(sample)".
  function demoPayload() {
    var now = new Date().toISOString();
    if (currentVariant() === "provider") {
      return {
        requester_type: "provider",
        generated_at: now,
        freshness: { source: "demo", as_of: now, stale: false },
        credentialing: [
          { payer: "Optum / UnitedHealthcare (sample)", network: "Commercial", status: "credentialed", effective_date: "2024-02-01", expires_date: "2026-02-01" },
          { payer: "Aetna (sample)", network: "Commercial", status: "credentialed", effective_date: "2024-01-15", expires_date: "2026-01-15" },
          { payer: "Cigna (sample)", network: "Behavioral", status: "in_progress", effective_date: null, expires_date: null },
          { payer: "Anthem BCBS — NY (sample)", network: "Commercial", status: "credentialed", effective_date: "2023-11-01", expires_date: "2025-11-01" },
          { payer: "BCBS Massachusetts (sample)", network: "Commercial", status: "credentialed", effective_date: "2024-03-10", expires_date: "2026-03-10" },
          { payer: "BCBS Texas (sample)", network: "Commercial", status: "expired", effective_date: "2022-04-01", expires_date: "2024-04-01" },
          { payer: "Medicare (sample)", network: "Part B", status: "not_started", effective_date: null, expires_date: null }
        ],
        onboarding: { status: "onboarding", since: "2026-04-18" },
        clients: [
          { client_id: "ph_c1", label: "Sample Client A" },
          { client_id: "ph_c2", label: "Sample Client B" },
          { client_id: "ph_c3", label: "Sample Client C" }
        ],
        selected_client: null
      };
    }
    return {
      requester_type: "client",
      generated_at: now,
      freshness: { source: "demo", as_of: now, stale: false },
      eligibility: [
        { check_id: "ELG-7741", payer: "Aetna (sample)", plan: "PPO", status: "active",
          copay: "$25", coinsurance: "20%", deductible_met: "$650 / $1,500", checked_at: "2026-05-22" }
      ],
      claims: [
        { claim_id: "CLM-44120", date_of_service: "2026-05-12", payer: "Aetna (sample)", status: "paid",
          billed_amount: "$180.00", allowed_amount: "$120.00", patient_responsibility: "$25.00" }
      ],
      invoices: [
        { invoice_id: "INV-3061", issued_date: "2026-05-22", due_date: "2026-06-06",
          amount: "$25.00", balance: "$25.00", status: "open" }
      ],
      credentialing: [], clients: []
    };
  }

  // Demo: the per-client detail a provider sees after searching a client (chart 2).
  function demoClientDetail(clientId, label) {
    return {
      client_id: clientId, label: label,
      eligibility: [
        { check_id: "ELG-" + clientId, payer: "Aetna (sample)", plan: "PPO", status: "active", copay: "$25",
          coinsurance: "20%", deductible_met: "$400 / $1,500", checked_at: "2026-05-20", client_id: clientId, client_label: label }
      ],
      claims: [
        { claim_id: "CLM-" + clientId + "-1", date_of_service: "2026-05-12", payer: "Aetna (sample)", status: "paid",
          billed_amount: "$180.00", allowed_amount: "$120.00", patient_responsibility: "$25.00", client_id: clientId, client_label: label },
        { claim_id: "CLM-" + clientId + "-2", date_of_service: "2026-04-28", payer: "Aetna (sample)", status: "in_review",
          billed_amount: "$180.00", allowed_amount: "—", patient_responsibility: "—", client_id: clientId, client_label: label }
      ],
      invoices: [
        { invoice_id: "INV-" + clientId, issued_date: "2026-05-15", due_date: "2026-05-30", amount: "$25.00", balance: "$0.00", status: "paid" }
      ]
    };
  }

  // ── Asana flow pane ───────────────────────────────────────────────────
  // Tabs swap the existing client-context view for the Asana tasks linked to this
  // ticket. The browser never holds the Asana credential: in production the broker
  // (which owns the PAT/Service Account) answers /v1/asana/ticket-tasks. In DEMO_MODE
  // we render sample tasks so the pane is fully exercisable with no backend.
  function asanaActive() { var p = el("pane-asana"); return !!(p && p.classList.contains("active")); }

  function switchTab(pane) {
    Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (t) {
      t.classList.toggle("active", t.getAttribute("data-pane") === pane);
    });
    Array.prototype.forEach.call(document.querySelectorAll(".pane"), function (p) {
      p.classList.toggle("active", p.id === "pane-" + pane);
    });
    if (pane === "asana") {
      if (asanaState.loadedVariant !== currentVariant()) loadAsana();
      if (asubState.active === "request") initAForm();
      else if (asubState.active === "other") initDedupe();
    }
    if (pane === "slack") {
      loadSlack();
      if (ssubState.active === "channels") loadSlackChannels();
      else if (ssubState.active === "workflows") { loadSlackWorkflows(); loadSlackRequests(); startSlackSync(); }
    }
    if (pane === "guru") initGuru();
    ahtSwitch();
    resize();
  }

  // Sub-navigation inside the Asana pane: Linked tasks | New request | Other requests.
  var asubState = { active: "linked" };
  function switchAsub(name) {
    asubState.active = name;
    Array.prototype.forEach.call(document.querySelectorAll("#asana-subtabs .subtab"), function (b) {
      b.classList.toggle("active", b.getAttribute("data-asub") === name);
    });
    Array.prototype.forEach.call(document.querySelectorAll("#pane-asana .asub"), function (p) {
      p.classList.toggle("active", p.id === "asub-" + name);
    });
    if (name === "request") initAForm();
    else if (name === "other") initDedupe();
    ahtSwitch();
    resize();
  }

  function toggleSubs(tog) {
    var subsEl = tog.nextElementSibling;
    if (!subsEl || !subsEl.classList.contains("subs")) return;
    var open = subsEl.classList.toggle("open");
    tog.setAttribute("aria-expanded", String(open));
    var n = tog.getAttribute("data-count");
    tog.textContent = (open ? "▾ " : "▸ ") + n + " subtask" + (n === "1" ? "" : "s");
    resize();
  }

  // Each subtask is its own Asana task with its own comment thread, so it gets its
  // own unread emblem + expandable comments (parent comments never include them).
  function renderSubtask(s, parentGid, idx) {
    var meta = [s.assignee && esc(s.assignee), s.due_on && ("Due " + esc(s.due_on))].filter(Boolean).join(" · ");
    var hasC = s.comments && s.comments.length;
    var bell = (s.unseen > 0) ? '<span class="abell" title="' + s.unseen + ' new comment(s)">' + s.unseen + "</span>" : "";
    var tog = hasC
      ? '<div class="sub-cmt-toggle" role="button" tabindex="0" aria-expanded="false" data-sub-gid="' + esc(parentGid) +
          '" data-sub-idx="' + idx + '">▸ ' + s.comments.length + " comment" + (s.comments.length === 1 ? "" : "s") +
          '</div><div class="sub-cmt" hidden></div>'
      : "";
    return '<div class="sub"><div class="sub-row"><span class="sub-name">' + esc(s.name) + "</span>" +
      '<span class="atask-right">' + bell + badge(s.completed ? "completed" : "open") + "</span></div>" +
      (meta ? '<div class="sub-meta">' + meta + "</div>" : "") + tog + "</div>";
  }

  function renderAsanaTask(t) {
    var subs = t.subtasks || [];
    var meta = [t.assignee && ("Assignee: " + esc(t.assignee)),
                (t.projects && t.projects.length) && ("In: " + esc(t.projects.join(", "))),
                t.due_on && ("Due: " + esc(t.due_on))].filter(Boolean).join(" · ");
    // Live (direct) and demo tasks both expand to their submission + comment thread.
    var detailTog = (t.direct || t.demo)
      ? '<div class="atask-toggle" role="button" tabindex="0" aria-expanded="false" data-direct-gid="' + esc(t.gid) +
          '">▸ Details &amp; comments</div><div class="adetail" hidden></div>'
      : "";
    var subsTog = subs.length
      ? '<div class="atask-toggle" role="button" tabindex="0" aria-expanded="false" data-count="' + subs.length +
          '">▸ ' + subs.length + " subtask" + (subs.length === 1 ? "" : "s") + "</div>" +
        '<div class="subs">' + subs.map(function (s, i) { return renderSubtask(s, t.gid, i); }).join("") + "</div>"
      : "";
    var bell = (t.unseen > 0) ? '<span class="abell" title="' + t.unseen + ' new comment(s)">' + t.unseen + " new</span>" : "";
    var statusBar = asanaCfg.statusButtons
      ? '<div class="asana-status-bar">' +
          '<button class="btn asana-status-btn" type="button" data-set-status="on-hold" title="Set ticket to On-hold">On-hold</button>' +
          '<button class="btn asana-status-btn" type="button" data-set-status="pending" title="Set ticket to Pending">Pending</button>' +
        '</div>'
      : "";
    return '<div class="card atask"' + (t.gid ? ' data-gid="' + esc(t.gid) + '"' : "") + '><div class="atask-top">' +
      '<a class="atask-name" href="' + esc(t.url) + '" target="_blank" rel="noopener">' + esc(t.name) + "</a>" +
      '<span class="atask-right">' + bell + badge(t.completed ? "completed" : "open") + "</span></div>" +
      (meta ? '<div class="atask-meta">' + meta + "</div>" : "") + statusBar + detailTog + subsTog + "</div>";
  }

  function renderAsana(tasks, tid) {
    var body = el("asana-body");
    el("asana-count").textContent = (tasks && tasks.length) || 0;
    if (!tasks || !tasks.length) {
      body.innerHTML = '<div class="card"><div class="empty">No Asana tasks linked to ticket ' +
        (tid ? "#" + esc(tid) : "this conversation") + ".</div></div>";
      resize(); return;
    }
    body.innerHTML = tasks.map(renderAsanaTask).join("");
    resize();
  }

  function asanaError(msg) {
    el("asana-body").innerHTML = '<div class="card error"><p>' + esc(msg || "Couldn’t load Asana tasks.") + "</p></div>";
    resize();
  }

  function loadAsana() {
    // Broker-hosted page: the live AsanaTasks widget (asana.js) owns this pane.
    if (window.AsanaTasks) return;
    var body = el("asana-body");
    var variant = currentVariant();
    var tid = state.ticketId;
    asanaState.loadedVariant = variant;
    el("asana-ticket-id").textContent = tid ? "#" + tid : "—";
    body.innerHTML = '<div class="card"><div class="skeleton" style="width:70%"></div>' +
      '<div class="skeleton" style="width:50%;margin-top:8px"></div></div>';

    settingsReady.then(function () {
      // Direct mode: install settings hold the workspace + secure PAT.
      if (asanaCfg.workspace) { loadAsanaDirect(tid); return; }

      if (DEMO_MODE) {
        setTimeout(function () {
          var tasks = demoAsanaTasks(tid, variant);
          demoTasksByGid = {};
          tasks.forEach(function (t) { t.demo = true; demoTasksByGid[t.gid] = t; });
          renderAsana(tasks, tid);
        }, 600);
        return;
      }
      // PRODUCTION SEAM: the broker (server-side hosted, owns the Asana credential)
      // answers this. The agent is identified by the broker session, never the client.
      if (!tid) { asanaError("No ticket in context."); return; }
      fetch(ASANA_BROKER_BASE + "/v1/asana/ticket-tasks", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket_id: String(tid) })
      }).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
        .then(function (j) { renderAsana(j.tasks || [], tid); })
        .catch(function (e) { asanaError("Failed to load tasks: " + e.message); });
    });
  }

  // Demo Asana tasks linked to the ticket (client vs provider). Clearly marked "(sample)".
  // Tasks created from the Request pane in demo mode are prepended so the round trip
  // (submit form -> see the task) works with no credentials.
  function demoAsanaTasks(ticketId, variant) {
    var tid = ticketId || "—";
    if (demoCreatedTasks.length) return demoCreatedTasks.concat(demoBaseTasks(tid, variant));
    return demoBaseTasks(tid, variant);
  }
  // Sample comment for the demo threads (shaped like an Asana story so the live
  // comment renderer can display it unchanged).
  function _dc(name, when, text) { return { created_by: { name: name }, created_at: when, text: text }; }

  function demoBaseTasks(tid, variant) {
    if (variant === "provider") {
      return [
        { gid: "1201", name: "Credentialing follow-up — Cigna Behavioral — Ticket #" + tid + " (sample)",
          url: "https://app.asana.com/0/0/1201", completed: false, assignee: "Morgan (Cred Ops)",
          due_on: "2026-06-15", projects: ["CX ⇄ Credentialing"], modified_at: "2026-06-08",
          notes: "Provider re-credentialing with Cigna Behavioral. Confirm CAQH attestation and panel effective date before closing.",
          unseen: 1,
          comments: [
            _dc("Morgan (Cred Ops)", "2026-06-07T16:20:00Z", "Submitted the re-attestation to Cigna; expecting a 5-7 day turnaround."),
            _dc("Cigna Liaison", "2026-06-09T10:05:00Z", "Panel effective date confirmed for 7/1 — please notify the provider.")
          ],
          subtasks: [
            { name: "Request updated CAQH attestation", completed: true, assignee: "Morgan (Cred Ops)", due_on: "2026-06-05",
              unseen: 0, comments: [ _dc("Morgan (Cred Ops)", "2026-06-05T12:00:00Z", "CAQH attestation refreshed and re-shared.") ] },
            { name: "Confirm panel effective date with payer", completed: false, assignee: "Morgan (Cred Ops)", due_on: "2026-06-14",
              unseen: 1, comments: [ _dc("Cigna Liaison", "2026-06-09T10:06:00Z", "Effective 7/1 — confirmation letter to follow.") ] }
          ] },
        { gid: "1202", name: "Add Sample Client C to roster — Ticket #" + tid + " (sample)",
          url: "https://app.asana.com/0/0/1202", completed: false, assignee: "Riley (Onboarding)",
          projects: ["Provider Onboarding"], modified_at: "2026-06-07",
          notes: "Roster the provider for Sample Client C; verify NPI and send the welcome packet.",
          unseen: 0,
          comments: [ _dc("Riley (Onboarding)", "2026-06-06T09:30:00Z", "NPI verified against NPPES; welcome packet queued.") ],
          subtasks: [
            { name: "Verify NPI on file", completed: true, assignee: "Riley (Onboarding)", unseen: 0, comments: [] },
            { name: "Send welcome packet", completed: false, assignee: "Riley (Onboarding)", due_on: "2026-06-13", unseen: 0, comments: [] }
          ] },
        { gid: "1203", name: "Resolve expired BCBS TX contract — Ticket #" + tid + " (sample)",
          url: "https://app.asana.com/0/0/1203", completed: true, assignee: "Morgan (Cred Ops)",
          projects: ["CX ⇄ Credentialing"], modified_at: "2026-06-02",
          notes: "BCBS TX contract had lapsed; re-executed and effective dates updated.",
          unseen: 0,
          comments: [ _dc("Morgan (Cred Ops)", "2026-06-02T14:00:00Z", "Contract re-executed; closing this out.") ],
          subtasks: [] }
      ];
    }
    return [
      { gid: "1101", name: "Verify Aetna eligibility — Ticket #" + tid + " (sample)",
        url: "https://app.asana.com/0/0/1101", completed: false, assignee: "Jordan (CX)",
        due_on: "2026-06-12", projects: ["CX ⇄ Billing Ops"], modified_at: "2026-06-08",
        notes: "Member disputes patient responsibility. Re-pull Aetna eligibility and confirm the deductible reset before re-billing.",
        unseen: 1,
        comments: [
          _dc("Jordan (CX)", "2026-06-08T15:30:00Z", "Pulled the latest EOB — deductible looks reset as of 6/1."),
          _dc("Aetna Liaison", "2026-06-09T09:10:00Z", "Confirmed in-network; copay is $25, deductible met.")
        ],
        subtasks: [
          { name: "Pull latest EOB from clearinghouse", completed: true, assignee: "Jordan (CX)",
            unseen: 0, comments: [ _dc("Jordan (CX)", "2026-06-08T14:00:00Z", "EOB attached in Asana.") ] },
          { name: "Confirm deductible reset with payer", completed: false, assignee: "Jordan (CX)", due_on: "2026-06-11",
            unseen: 1, comments: [ _dc("Aetna Liaison", "2026-06-09T09:12:00Z", "Deductible reset confirmed — ref #44120.") ] }
        ] },
      { gid: "1102", name: "Resend superbill to member — Ticket #" + tid + " (sample)",
        url: "https://app.asana.com/0/0/1102", completed: true, assignee: "Sam (Billing)",
        projects: ["CX ⇄ Billing Ops"], modified_at: "2026-06-06",
        notes: "Member requested a superbill for out-of-network reimbursement. Re-sent to the email on file.",
        unseen: 0,
        comments: [ _dc("Sam (Billing)", "2026-06-06T11:00:00Z", "Superbill re-sent to the member's email on file.") ],
        subtasks: [] },
      { gid: "1103", name: "Escalate duplicate charge review — Ticket #" + tid + " (sample)",
        url: "https://app.asana.com/0/0/1103", completed: false, assignee: "Billing Triage",
        due_on: "2026-06-18", projects: ["Finance / Disputes"], modified_at: "2026-06-07",
        notes: "Member was charged twice for the 5/12 session. Open a dispute with the processor and notify the member of the credit ETA.",
        unseen: 2,
        comments: [
          _dc("Billing Triage", "2026-06-07T13:15:00Z", "Confirmed the duplicate on the 5/12 DOS; opening a processor dispute."),
          _dc("Processor", "2026-06-09T16:40:00Z", "Dispute #DSP-4471 opened; provisional credit in 3-5 business days."),
          _dc("Billing Triage", "2026-06-10T08:05:00Z", "Member notified of the credit ETA.")
        ],
        subtasks: [
          { name: "Gather card statement screenshot", completed: false, assignee: "Billing Triage", unseen: 0, comments: [] },
          { name: "Open dispute with processor", completed: false, assignee: "Billing Triage", due_on: "2026-06-20",
            unseen: 1, comments: [ _dc("Processor", "2026-06-09T16:41:00Z", "Dispute #DSP-4471 acknowledged.") ] },
          { name: "Notify member of credit ETA", completed: false, assignee: "Billing Triage", unseen: 0, comments: [] }
        ] }
    ];
  }

  // ── Live Asana, no broker ("direct" mode) ─────────────────────────────
  // client.request({secure:true}) goes through Zendesk's proxy, which substitutes
  // {{setting.asana_pat}} server-side; app.asana.com must be in domainWhitelist.
  function asanaApi(path, opts) {
    var req = {
      url: "https://app.asana.com/api/1.0" + path,
      type: (opts && opts.type) || "GET",
      headers: { Authorization: "Bearer {{setting.asana_pat}}" },
      secure: true, cors: false, dataType: "json"
    };
    if (opts && opts.data) { req.data = JSON.stringify(opts.data); req.contentType = "application/json"; }
    return client.request(req);
  }
  function reqErr(e) {
    var detail = "";
    try {
      var body = e && (e.responseJSON || (e.responseText ? JSON.parse(e.responseText) : null));
      if (body && body.errors && body.errors[0] && body.errors[0].message) {
        detail = " — Asana says: " + body.errors[0].message;
      }
    } catch (x) {}
    if (e && e.status === 402) return "HTTP 402 — the Asana search API needs a paid Asana plan" + detail;
    if (e && e.status === 401) return "HTTP 401 — Asana rejected the token. In the app settings, re-paste the full PAT (starts with a digit + slash, e.g. 2/…): no spaces or line breaks, and no 'Bearer' prefix" + detail;
    if (e && e.status === 404) return "HTTP 404 — check the workspace GID in the app settings (the numeric GID, not the workspace name)" + detail;
    if (e && e.status) return "HTTP " + e.status + detail;
    return ((e && e.message) || "request failed") + detail;
  }

  var DIRECT_TASK_FIELDS = "name,completed,assignee.name,due_on,projects.name,permalink_url," +
    "num_subtasks,notes,created_at,custom_fields.name,custom_fields.display_value";
  var directTasks = {}; // gid -> raw task, for the expand view

  function loadAsanaDirect(tid) {
    var note = el("asana-sample-note"); if (note) note.hidden = true;
    if (!tid) { asanaError("No ticket in context."); return; }
    var ticketUrl = state.zdSubdomain
      ? "https://" + state.zdSubdomain + ".zendesk.com/agent/tickets/" + tid
      : null;
    var match = asanaCfg.ticketField
      ? "custom_fields." + encodeURIComponent(asanaCfg.ticketField) + ".value=" + encodeURIComponent(ticketUrl || tid)
      : "text=" + encodeURIComponent(tid);
    asanaApi("/workspaces/" + encodeURIComponent(asanaCfg.workspace) + "/tasks/search?" +
             match + (asanaCfg.projectGid ? "&projects.any=" + encodeURIComponent(asanaCfg.projectGid) : "") +
             "&opt_fields=" + DIRECT_TASK_FIELDS)
      .then(function (r) {
        var raw = (r && r.data) || [];
        directTasks = {};
        raw.forEach(function (t) { directTasks[t.gid] = t; });
        renderAsana(raw.map(function (t) {
          return { gid: t.gid, name: t.name, url: t.permalink_url, completed: t.completed,
                   assignee: t.assignee && t.assignee.name, due_on: t.due_on,
                   projects: (t.projects || []).map(function (p) { return p.name; }),
                   subtasks: [], direct: true };
        }), tid);
        if (raw.length) startDirectBadgePoll();
      })
      .catch(function (e) { asanaError("Failed to load Asana tasks: " + reqErr(e)); });
  }

  function directCommentHTML(c) {
    var when = "";
    if (c.created_at) { try { when = new Date(c.created_at).toLocaleString(); } catch (e) {} }
    return '<div class="cmt"><div class="cmt-head"><span class="cmt-who">' +
      esc((c.created_by && c.created_by.name) || "—") + '</span><span class="cmt-when">' + esc(when) +
      '</span></div><div class="cmt-text">' + esc(c.text) + "</div></div>";
  }

  function directDetailHTML(t, comments, gid) {
    var fields = (t.custom_fields || []).map(function (f) {
      var v = (f.display_value == null || f.display_value === "") ? "—" : f.display_value;
      return '<div class="kv"><div class="k">' + esc(f.name) + '</div><div class="v">' + esc(v) + "</div></div>";
    }).join("");
    return (t.notes ? '<div class="adetail-note">' + esc(t.notes) + "</div>" : "") +
      (fields ? '<div class="kv-grid">' + fields + "</div>" : "") +
      '<div class="cmt-label">Comments</div>' +
      '<div class="cmt-thread">' +
        '<div class="cmt-list">' + (comments.length ? comments.map(directCommentHTML).join("") : '<div class="empty">No comments yet.</div>') + "</div>" +
        '<div class="composer"><textarea class="composer-input" placeholder="Add a comment to this Asana task..."></textarea>' +
        '<div class="composer-row"><span class="composer-hint">Posts to Asana as the connected account</span>' +
        '<button class="btn primary composer-send" type="button" data-gid="' + esc(gid) + '">Send</button></div></div>' +
      '</div>';
  }

  function toggleDirectDetail(tog) {
    var box = tog.nextElementSibling;
    if (!box || !box.classList.contains("adetail")) return;
    var open = box.hidden;
    box.hidden = !open;
    tog.setAttribute("aria-expanded", String(open));
    tog.textContent = (open ? "▾ " : "▸ ") + "Details & comments";
    if (open && !box.getAttribute("data-loaded")) {
      var gid = tog.getAttribute("data-direct-gid");
      var demoT = demoTasksByGid[gid];
      if (demoT) { // demo: render the in-memory submission + comments, mark seen
        box.setAttribute("data-loaded", "1");
        box.innerHTML = directDetailHTML(demoT, demoT.comments || [], gid);
        demoT.unseen = 0;
        var dcard = box.closest(".atask"); if (dcard) updateBadge(dcard, 0);
        resize(); return;
      }
      box.innerHTML = '<div class="skeleton" style="width:70%"></div>';
      asanaApi("/tasks/" + encodeURIComponent(gid) + "/stories?opt_fields=type,text,created_at,created_by.name")
        .then(function (r) {
          var comments = ((r && r.data) || []).filter(function (s) { return s.type === "comment"; });
          box.setAttribute("data-loaded", "1");
          box.innerHTML = directDetailHTML(directTasks[gid] || {}, comments, gid);
          var newest = latestCommentAt(comments);
          if (newest) markSeen(gid, newest);
          var card = box.closest(".atask");
          if (card) updateBadge(card, 0);
          resize();
        })
        .catch(function (e) { box.innerHTML = '<div class="empty">Failed to load details: ' + esc(reqErr(e)) + "</div>"; resize(); });
    }
    resize();
  }

  // Subtask comments: each subtask is its own Asana task with its own thread —
  // expand it inline (the parent task's comments never include subtask comments).
  function toggleSubComments(tog) {
    var box = tog.nextElementSibling;
    if (!box || !box.classList.contains("sub-cmt")) return;
    var open = box.hidden;
    box.hidden = !open;
    tog.setAttribute("aria-expanded", String(open));
    var gid = tog.getAttribute("data-sub-gid"), idx = parseInt(tog.getAttribute("data-sub-idx"), 10);
    var task = demoTasksByGid[gid];
    var sub = task && task.subtasks && task.subtasks[idx];
    var n = (sub && sub.comments) ? sub.comments.length : 0;
    tog.textContent = (open ? "▾ " : "▸ ") + n + " comment" + (n === 1 ? "" : "s");
    if (open && !box.getAttribute("data-loaded")) {
      box.setAttribute("data-loaded", "1");
      var list = ((sub && sub.comments) || []).map(directCommentHTML).join("") || '<div class="empty">No comments.</div>';
      box.innerHTML = '<div class="cmt-thread"><div class="cmt-list">' + list + "</div></div>";
      if (sub) sub.unseen = 0;
      var bell = tog.parentNode.querySelector(".sub-row .abell"); if (bell) bell.parentNode.removeChild(bell);
    }
    resize();
  }

  function sendDirectComment(btn) {
    var composer = btn.closest(".composer");
    var ta = composer.querySelector(".composer-input");
    var hint = composer.querySelector(".composer-hint");
    var text = (ta.value || "").trim();
    if (!text) return;
    var dgid = btn.getAttribute("data-gid");
    var demoT = demoTasksByGid[dgid];
    if (demoT) { // demo: append the comment locally (no backend)
      var dc = { created_by: { name: "You" }, created_at: new Date().toISOString(), text: text };
      demoT.comments = demoT.comments || []; demoT.comments.push(dc);
      var dlist = composer.parentNode.querySelector(".cmt-list");
      var dempty = dlist.querySelector(".empty"); if (dempty) dlist.innerHTML = "";
      dlist.insertAdjacentHTML("beforeend", directCommentHTML(dc));
      ta.value = ""; resize(); return;
    }
    btn.disabled = true; btn.textContent = "Sending…";
    if (hint) { hint.textContent = "Posts to Asana as the connected account"; hint.style.color = ""; }
    asanaApi("/tasks/" + encodeURIComponent(btn.getAttribute("data-gid")) + "/stories",
             { type: "POST", data: { data: { text: text } } })
      .then(function (r) {
        var s = (r && r.data) || {};
        var list = composer.parentNode.querySelector(".cmt-list");
        var empty = list.querySelector(".empty"); if (empty) list.innerHTML = "";
        list.insertAdjacentHTML("beforeend", directCommentHTML({
          created_by: s.created_by, created_at: s.created_at, text: s.text || text
        }));
        if (s.created_at) markSeen(btn.getAttribute("data-gid"), s.created_at);
        ta.value = ""; btn.disabled = false; btn.textContent = "Send"; resize();
      })
      .catch(function (e) {
        btn.disabled = false; btn.textContent = "Send";
        if (hint) { hint.textContent = "Failed to post: " + reqErr(e); hint.style.color = "var(--danger)"; }
      });
  }

  // ── unread-comment badges (direct mode) ───────────────────────────────
  // No server in this build, so "seen" state lives per-browser in localStorage:
  // a task's badge counts comments newer than the agent's last-seen mark; opening
  // Details (or posting) moves the mark. First sight of a task sets the baseline
  // silently so a fresh install doesn't light up every old comment.
  var SEEN_KEY = "cxsidebar.asana.seen";
  var DIRECT_POLL_MS = 30000;
  var directPollTimer = null;

  function seenMap() { try { return JSON.parse(localStorage.getItem(SEEN_KEY) || "{}"); } catch (e) { return {}; } }
  function saveSeen(m) { try { localStorage.setItem(SEEN_KEY, JSON.stringify(m)); } catch (e) {} }
  function markSeen(gid, at) {
    var m = seenMap();
    if (!m[gid] || at > m[gid]) { m[gid] = at; saveSeen(m); }
  }
  function latestCommentAt(comments) {
    var max = "";
    comments.forEach(function (c) { if (c.created_at && c.created_at > max) max = c.created_at; });
    return max;
  }

  function updateBadge(card, n) {
    var top = card.querySelector(".atask-right") || card.querySelector(".atask-top");
    var b = card.querySelector(".abell");
    if (n > 0) {
      if (!b) {
        b = document.createElement("span");
        b.className = "abell";
        top.insertBefore(b, top.querySelector(".badge"));
      }
      b.textContent = n + " new";
      b.title = n + " new comment(s) — open Details & comments to mark them seen";
    } else if (b) {
      b.parentNode.removeChild(b);
    }
  }

  var commentToastTimer = null;
  function showCommentToast(totalNew) {
    var toast = el("comment-toast");
    var msg = el("comment-toast-msg");
    var link = el("comment-toast-link");
    var close = el("comment-toast-close");
    if (!toast) return;
    if (commentToastTimer) clearTimeout(commentToastTimer);
    msg.textContent = totalNew + " new Asana comment" + (totalNew > 1 ? "s" : "") + " on your tasks";
    toast.hidden = false;
    resize();
    commentToastTimer = setTimeout(function () { toast.hidden = true; resize(); }, 6000);
    close.onclick = function () { toast.hidden = true; if (commentToastTimer) clearTimeout(commentToastTimer); resize(); };
    link.onclick = function () {
      toast.hidden = true; if (commentToastTimer) clearTimeout(commentToastTimer);
      var asanaTab = document.querySelector('.tab[data-pane="asana"]');
      if (asanaTab) asanaTab.click();
      resize();
    };
  }

  function refreshDirectBadges() {
    // Foreground-only (3.10.0): same gate slackSyncTick uses. ZAF keeps
    // deactivated sidebars resident, so without this every open ticket tab
    // keeps polling Asana in the background against the one shared PAT.
    if (document.hidden || aht.deactivated) return;
    if (!asanaCfg.workspace) return;
    var cards = document.querySelectorAll('#asana-body .atask[data-gid]');
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
            if (!seen[gid]) {
              if (newest) { seen[gid] = newest; changed = true; }
              updateBadge(card, 0);
              return;
            }
            var newCount = comments.filter(function (c) { return c.created_at > seen[gid]; }).length;
            updateBadge(card, newCount);
            if (newCount > 0) {
              totalNew += newCount;
              if (client) {
                var taskName = (card.querySelector(".atask-name") || {}).textContent || "Asana task";
                client.invoke("notify", newCount + " new comment" + (newCount > 1 ? "s" : "") + " on: " + taskName, "notice");
              }
            }
          }).catch(function () {});
      });
    });
    chain.then(function () {
      if (changed) saveSeen(seen);
      if (totalNew > 0) {
        showCommentToast(totalNew);
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
      resize();
    });
  }

  function setTicketStatusFromAsana(status) {
    if (!client || !status) return;
    if (DEMO_MODE) {
      client.invoke("notify", "Demo: ticket status would be set to " + status, "notice");
      return;
    }
    client.set("ticket.status", status).catch(function () {
      client.invoke("notify", "Could not set ticket status to " + status, "error");
    });
  }

  function startDirectBadgePoll() {
    if (directPollTimer) clearInterval(directPollTimer);
    refreshDirectBadges();
    directPollTimer = setInterval(refreshDirectBadges, DIRECT_POLL_MS);
  }

  // ── Asana request form (config-driven; "Request" pane) ────────────────
  // A native rebuild of the team's Asana form. assets/asana_form_config.json holds
  // every question (ids straight from the live form), the branch rules, and the
  // mapping sections the team edits: zendesk_prefill (what auto-fills from the
  // ticket) and asana_custom_fields (which Asana custom-field GID each answer
  // lands in). Submit compiles name + a Q&A description (exactly like an Asana
  // form submission) + custom field values, then creates the task:
  //   broker page  -> POST /v1/asana/create-task   (broker owns the credential)
  //   direct mode  -> POST app.asana.com /tasks via Zendesk's secure proxy
  //   demo         -> a clearly-labeled sample task, kept in the tasks pane
  var aform = { cfg: null, index: {}, loaded: false, submitting: false, ctx: null, dedupeAck: false, checking: false };
  var dedupe = { lastMatches: [] };
  var demoCreatedTasks = []; // demo submissions, surfaced in the Asana tasks pane
  var demoTasksByGid = {};   // gid -> demo task, for the Details & comments / subtask expansion

  function aformMode() {
    if (window.AsanaTasks) return "broker";
    if (asanaCfg.workspace) return "direct";
    return "demo";
  }
  function aformProjectGid() {
    return asanaCfg.projectGid || (aform.cfg && aform.cfg.form.project_gid) || "";
  }

  function aformWalk(questions, fn) {
    (questions || []).forEach(function (q) {
      fn(q);
      (q.branches || []).forEach(function (b) { aformWalk(b.fields, fn); });
    });
  }

  function aformControlHTML(q) {
    var t = q.type;
    if (t === "textarea") return '<textarea class="aform-input" data-q="' + esc(q.id) + '" rows="3"></textarea>';
    if (t === "select") {
      return '<select class="aform-input aform-select" data-q="' + esc(q.id) + '">' +
        '<option value="">Select…</option>' +
        (q.options || []).map(function (o) { return '<option value="' + esc(o.id) + '">' + esc(o.label) + "</option>"; }).join("") +
        "</select>";
    }
    if (t === "multiselect") {
      return '<div class="aform-checks" data-q="' + esc(q.id) + '">' +
        (q.options || []).map(function (o) {
          return '<label class="aform-check"><input type="checkbox" value="' + esc(o.id) + '"> ' + esc(o.label) + "</label>";
        }).join("") + "</div>";
    }
    if (t === "date") return '<input class="aform-input" data-q="' + esc(q.id) + '" type="date">';
    if (t === "attachment") {
      return '<div class="aform-attach">Attachments can’t be uploaded from the sidebar — add them in Asana after the task is created (the link appears on the confirmation).</div>';
    }
    var itype = (t === "email") ? "email" : "text";
    return '<input class="aform-input" data-q="' + esc(q.id) + '" type="' + itype + '">';
  }

  function aformQuestionHTML(q) {
    if (q.type === "heading") return '<div class="aform-heading">' + esc(q.label) + "</div>";
    var help = q.help ? '<div class="aform-help">' + esc(q.help) + "</div>" : "";
    var html = '<div class="aform-q" data-qid="' + esc(q.id) + '" data-type="' + esc(q.type) + '"' +
      (q.required ? ' data-required="1"' : "") + ">" +
      '<label class="aform-label">' + esc(q.label) + (q.required ? ' <span class="aform-req">*</span>' : "") + "</label>" +
      help + aformControlHTML(q) + '<div class="aform-err" hidden></div></div>';
    (q.branches || []).forEach(function (b) {
      html += '<div class="aform-branch" data-parent="' + esc(q.id) + '" data-when="' + esc(b.when) + '" hidden>' +
        b.fields.map(aformQuestionHTML).join("") + "</div>";
    });
    return html;
  }

  // Prefill context: the tokens zendesk_prefill sources can reference. Values the
  // stub/demo can't supply degrade to "" (the agent just types them).
  function aformContext() {
    if (aform.ctx) return Promise.resolve(aform.ctx);
    var base = {
      "ticket.id": state.ticketId || "", "ticket.subject": "", "ticket.url": "",
      "requester.email": state.email || "", "requester.name": "", "requester.first": "",
      "agent.email": "", "agent.name": "", "agent.first": ""
    };
    if (!client) {
      base["agent.email"] = "agent@helloalma.com"; base["agent.name"] = "Alma Agent"; base["agent.first"] = "Alma";
      base["ticket.url"] = "https://demo.zendesk.com/agent/tickets/" + (state.ticketId || "");
      aform.ctx = base; return Promise.resolve(base);
    }
    return client.get(["ticket.id", "ticket.subject", "ticket.requester.name", "ticket.requester.email",
                       "currentUser.name", "currentUser.email"]).then(function (d) {
      base["ticket.id"] = d["ticket.id"] || state.ticketId || "";
      base["ticket.subject"] = d["ticket.subject"] || "";
      base["requester.email"] = d["ticket.requester.email"] || state.email || "";
      base["requester.name"] = d["ticket.requester.name"] || "";
      base["requester.first"] = String(base["requester.name"]).trim().split(/\s+/)[0] || "";
      base["agent.email"] = d["currentUser.email"] || "";
      base["agent.name"] = d["currentUser.name"] || "";
      base["agent.first"] = String(base["agent.name"]).trim().split(/\s+/)[0] || "";
      return (client.context ? client.context() : Promise.resolve(null)).then(function (c) {
        var sub = c && (c.account && c.account.subdomain || c.subdomain);
        if (sub) state.zdSubdomain = sub;
        base["ticket.url"] = sub ? "https://" + sub + ".zendesk.com/agent/tickets/" + base["ticket.id"]
                                 : "https://demo.zendesk.com/agent/tickets/" + base["ticket.id"];
        return base;
      }).catch(function () {
        base["ticket.url"] = "https://demo.zendesk.com/agent/tickets/" + base["ticket.id"];
        return base;
      });
    }).catch(function () { return base; }).then(function (ctx) { aform.ctx = ctx; return ctx; });
  }

  function aformResolveSource(src, ctx) {
    src = String(src || "").trim();
    if (!src) return Promise.resolve("");
    if (src.indexOf("template:") === 0) {
      var tpl = src.slice(9);
      var fieldIds = [];
      tpl.replace(/\{field:(\d+)\}/g, function (_, id) { fieldIds.push(id); return _; });
      return Promise.all(fieldIds.map(function (id) { return aformTicketField(id); })).then(function (vals) {
        var fv = {}; fieldIds.forEach(function (id, i) { fv[id] = vals[i]; });
        return tpl.replace(/\{([^}]+)\}/g, function (_, tok) {
          if (tok.indexOf("field:") === 0) return fv[tok.slice(6)] || "";
          return ctx[tok] != null ? ctx[tok] : "";
        });
      });
    }
    if (src.indexOf("field:") === 0) return aformTicketField(src.slice(6));
    return Promise.resolve(ctx[src] != null ? String(ctx[src]) : "");
  }
  function aformTicketField(zdFieldId) {
    if (!client) return Promise.resolve("");
    var key = "ticket.customField:custom_field_" + zdFieldId;
    return client.get(key).then(function (d) {
      var v = d && d[key];
      return v == null ? "" : String(v);
    }).catch(function () { return ""; });
  }

  function aformPrefill(host, ctx) {
    var map = (aform.cfg && aform.cfg.zendesk_prefill) || {};
    Object.keys(map).forEach(function (qid) {
      var src = map[qid] && map[qid].source;
      if (!src) return;
      var node = host.querySelector('[data-q="' + qid + '"]');
      if (!node || node.classList.contains("aform-checks") || node.tagName === "SELECT") return; // prefill is for text-ish fields
      aformResolveSource(src, ctx).then(function (v) {
        if (v && !node.value) { node.value = v; node.classList.add("aform-prefilled"); }
      });
    });
  }

  function initAForm(force) {
    var host = el("aform-body");
    if (!host || (aform.loaded && !force)) return;
    aform.loaded = true;
    setText("aform-ticket-id", state.ticketId ? "#" + state.ticketId : "—");
    host.innerHTML = '<div class="card"><div class="skeleton" style="width:70%"></div>' +
      '<div class="skeleton" style="width:45%;margin-top:8px"></div></div>';
    fetch(SCRIPT_BASE + "asana_form_config.json", { credentials: "same-origin", cache: "no-cache" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (cfg) {
        aform.cfg = cfg;
        aform.index = {};
        aformWalk(cfg.questions, function (q) { aform.index[q.id] = q; });
        var src = el("aform-source");
        if (src && cfg.form.source_url) { src.href = cfg.form.source_url; src.hidden = false; }
        settingsReady.then(function () {
          // On the broker page the shell sets this note from /healthz; leave it alone.
          var note = el("aform-sample-note");
          if (note && aformMode() !== "broker") note.hidden = aformMode() !== "demo";
          host.innerHTML = '<form class="card aform" id="aform-form" novalidate>' +
            cfg.questions.map(aformQuestionHTML).join("") +
            '<div class="aform-actions"><span class="aform-status" id="aform-status"></span>' +
            '<button class="btn primary" id="aform-submit" type="submit">Create Asana task</button></div></form>';
          aformContext().then(function (ctx) { aformPrefill(host, ctx); resize(); });
          var form = el("aform-form");
          form.addEventListener("change", onAFormChange);
          form.addEventListener("submit", function (e) { e.preventDefault(); submitAForm(); });
          resize();
        });
      })
      .catch(function (e) {
        aform.loaded = false;
        host.innerHTML = '<div class="card error"><p>Couldn’t load the form config (' + esc(e.message) +
          '). Check asana_form_config.json.</p></div>';
        resize();
      });
  }

  // Branch rules: a child block is visible while its parent dropdown holds the
  // mapped option. Hidden blocks keep their values but are excluded from collection.
  function onAFormChange(e) {
    var t = e.target;
    if (t.tagName !== "SELECT" || !t.hasAttribute("data-q")) return;
    var qid = t.getAttribute("data-q");
    var form = el("aform-form");
    Array.prototype.forEach.call(form.querySelectorAll('.aform-branch[data-parent="' + qid + '"]'), function (b) {
      b.hidden = b.getAttribute("data-when") !== t.value;
    });
    resize();
  }

  function aformVisible(node) { return !node.closest(".aform-branch[hidden]"); }

  // Collect the answers of every *visible* question: {qid: {q, text, optionIds, labels}}
  function collectAForm() {
    var form = el("aform-form");
    var answers = {};
    Array.prototype.forEach.call(form.querySelectorAll(".aform-q"), function (wrap) {
      if (!aformVisible(wrap)) return;
      var qid = wrap.getAttribute("data-qid");
      var q = aform.index[qid];
      if (!q || q.type === "heading" || q.type === "attachment") return;
      var a = { q: q, text: "", optionIds: [], labels: [] };
      if (q.type === "select") {
        var sel = wrap.querySelector("select");
        if (sel && sel.value) {
          var opt = (q.options || []).filter(function (o) { return o.id === sel.value; })[0];
          a.optionIds = [sel.value]; a.labels = [opt ? opt.label : sel.value]; a.text = a.labels[0];
        }
      } else if (q.type === "multiselect") {
        Array.prototype.forEach.call(wrap.querySelectorAll("input:checked"), function (cb) {
          var opt = (q.options || []).filter(function (o) { return o.id === cb.value; })[0];
          a.optionIds.push(cb.value); a.labels.push(opt ? opt.label : cb.value);
        });
        a.text = a.labels.join(", ");
      } else {
        var input = wrap.querySelector("input,textarea");
        a.text = ((input && input.value) || "").trim();
      }
      answers[qid] = a;
    });
    return answers;
  }

  function validateAForm(answers) {
    var form = el("aform-form"), firstBad = null;
    Array.prototype.forEach.call(form.querySelectorAll(".aform-q"), function (wrap) {
      var err = wrap.querySelector(".aform-err");
      wrap.classList.remove("aform-invalid"); if (err) err.hidden = true;
      // Attachments can't be filled from the sidebar (collectAForm skips them), so a
      // required attachment would be permanently unsatisfiable — don't gate submit on it.
      if (!aformVisible(wrap) || !wrap.hasAttribute("data-required") || wrap.getAttribute("data-type") === "attachment") return;
      var a = answers[wrap.getAttribute("data-qid")];
      if (a && a.text) return;
      wrap.classList.add("aform-invalid");
      if (err) { err.textContent = "This answer is required."; err.hidden = false; }
      if (!firstBad) firstBad = wrap;
    });
    if (firstBad) firstBad.scrollIntoView({ behavior: "smooth", block: "center" });
    return !firstBad;
  }

  // Compile the submission: task name, an Asana-form-style Q&A description, and the
  // custom-field write list (only the questions mapped to a GID in the config).
  function buildAFormPayload(answers, ctx) {
    var cfg = aform.cfg;
    var nameAns = answers[cfg.form.task_name_question];
    var name = (nameAns && nameAns.text) || ("CX Support Request — Ticket #" + (state.ticketId || "?"));
    var lines = ["Submitted from Zendesk ticket #" + (state.ticketId || "—") +
                 (ctx["ticket.url"] ? " (" + ctx["ticket.url"] + ")" : "") +
                 (ctx["agent.email"] ? " by " + ctx["agent.email"] : "") + " via the CX sidebar.", ""];
    aformWalk(cfg.questions, function (q) {
      var a = answers[q.id];
      if (!a || !a.text) return;
      lines.push(q.label.replace(/\s+/g, " ").trim());
      lines.push(a.text);
      lines.push("");
    });
    var custom = [];
    var enumMap = cfg.enum_value_map || {};
    Object.keys(answers).forEach(function (qid) {
      var a = answers[qid];
      var m = cfg.asana_custom_fields && cfg.asana_custom_fields[qid];
      if (!m || !m.gid || !a.text) return;
      custom.push({
        gid: String(m.gid), label: a.q.label, kind: a.q.type, value: a.text,
        names: a.labels, enum_gids: a.optionIds.map(function (oid) { return enumMap[oid] || ""; })
      });
    });
    var tf = cfg.form.ticket_id_custom_field_gid;
    if (tf && state.ticketId) {
      custom.push({ gid: String(tf), label: "Zendesk ticket ID", kind: "ticket_id",
                    value: String(state.ticketId), names: [], enum_gids: [] });
    }
    return { ticket_id: String(state.ticketId || ""), name: name, notes: lines.join("\n"),
             submitter_email: ctx["agent.email"] || "", project_gid: aformProjectGid(),
             custom_fields: custom };
  }

  // Direct mode: resolve the payload's custom fields against the project's actual
  // field definitions (names -> enum option gids), then create the task. Fields the
  // project doesn't have are skipped — their values are already in the description.
  function aformResolveCustomFields(payload, defs) {
    var out = {}, skipped = [];
    payload.custom_fields.forEach(function (f) {
      var def = defs[f.gid];
      if (!def) { skipped.push(f.label + " — field " + f.gid + " is not on the project"); return; }
      var st = def.resource_subtype;
      if (st === "text") { out[f.gid] = f.value; return; }
      if (st === "number") {
        var n = parseFloat(String(f.value).replace(/[^0-9.\-]/g, ""));
        if (isNaN(n)) skipped.push(f.label + " — “" + f.value + "” is not a number"); else out[f.gid] = n;
        return;
      }
      if (st === "date") { out[f.gid] = { date: f.value }; return; }
      if (st === "enum" || st === "multi_enum") {
        var opts = def.enum_options || [];
        var resolved = [];
        (f.names.length ? f.names : [f.value]).forEach(function (nm, i) {
          var explicit = f.enum_gids[i];
          var hit = explicit ? opts.filter(function (o) { return o.gid === explicit; })[0]
                             : opts.filter(function (o) {
                                 return String(o.name).trim().toLowerCase() === String(nm).trim().toLowerCase();
                               })[0];
          if (hit) resolved.push(hit.gid);
          else skipped.push(f.label + " — no enum option named “" + nm + "” (add it to enum_value_map)");
        });
        if (resolved.length) out[f.gid] = (st === "enum") ? resolved[0] : resolved;
        return;
      }
      skipped.push(f.label + " — unsupported field type " + st);
    });
    return { fields: out, skipped: skipped };
  }

  function createTaskDirect(payload) {
    var proj = aformProjectGid();
    return asanaApi("/projects/" + encodeURIComponent(proj) +
                    "/custom_field_settings?limit=100&opt_fields=custom_field.gid,custom_field.name," +
                    "custom_field.resource_subtype,custom_field.enum_options.gid,custom_field.enum_options.name")
      .then(function (r) {
        var defs = {};
        ((r && r.data) || []).forEach(function (s) {
          var cf = s.custom_field || {}; if (cf.gid) defs[cf.gid] = cf;
        });
        return aformResolveCustomFields(payload, defs);
      })
      .catch(function () { return { fields: null, skipped: ["Custom fields skipped — couldn’t read the project’s field definitions"] }; })
      .then(function (res) {
        var body = { name: payload.name, notes: payload.notes, projects: [proj] };
        if (res.fields && Object.keys(res.fields).length) body.custom_fields = res.fields;
        return asanaApi("/tasks?opt_fields=name,permalink_url", { type: "POST", data: { data: body } })
          .catch(function (e) {
            // If Asana rejects the custom-field values, retry once without them: the
            // answers are all in the description, so the task still lands.
            if (!body.custom_fields || !e || (e.status !== 400 && e.status !== 403)) throw e;
            delete body.custom_fields;
            res.skipped.push("All custom fields skipped — Asana rejected the values (" + reqErr(e) + ")");
            return asanaApi("/tasks?opt_fields=name,permalink_url", { type: "POST", data: { data: body } });
          })
          .then(function (r2) {
            var t = (r2 && r2.data) || {};
            // set_count = fields actually written (0 if the retry stripped them).
            var setCount = body.custom_fields ? Object.keys(body.custom_fields).length : 0;
            return { task: { gid: t.gid, name: t.name || payload.name, url: t.permalink_url },
                     skipped: res.skipped, set_count: setCount, requested_count: payload.custom_fields.length, demo: false };
          });
      });
  }

  function createTaskDemo(payload) {
    return new Promise(function (resolve) {
      setTimeout(function () {
        var gid = "demo-" + Date.now();
        var url = "https://app.asana.com/0/" + (aformProjectGid() || "0") + "/" + gid;
        demoCreatedTasks.unshift({
          gid: gid, name: payload.name + " (sample)", url: url, completed: false,
          assignee: "Unassigned", due_on: null, projects: ["CX Support Board (sample)"],
          modified_at: new Date().toISOString(), subtasks: []
        });
        asanaState.loadedVariant = null; // tasks pane re-renders with the new task
        resolve({ task: { gid: gid, name: payload.name, url: url },
                  skipped: payload.custom_fields.length
                    ? ["Demo mode — " + payload.custom_fields.length + " mapped custom field(s) not validated against Asana"] : [],
                  demo: true });
      }, 700);
    });
  }

  function createTaskBroker(payload) {
    return fetch("/v1/asana/create-task", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error((j && j.detail) || ("HTTP " + r.status));
        return j;
      });
    });
  }

  function submitAForm() {
    if (aform.submitting || aform.checking) return;
    var answers = collectAForm();
    if (!validateAForm(answers)) { resize(); return; }
    var f = cfgForm();
    var clientId = (answers[f.client_id_question] && answers[f.client_id_question].text) || "";
    var providerId = (answers[f.provider_id_question] && answers[f.provider_id_question].text) || "";
    // Dedupe gate: unless already acknowledged, check Asana for recent matching
    // requests first and surface a confirm toast. A failed search never blocks submit.
    if (!aform.dedupeAck && (meaningfulId(clientId) || meaningfulId(providerId))) {
      var gbtn = el("aform-submit");
      aform.checking = true;
      if (gbtn) { gbtn.disabled = true; gbtn.textContent = "Checking for duplicates…"; }
      dedupeSearch(clientId, providerId).then(function (matches) {
        aform.checking = false;
        if (gbtn) { gbtn.disabled = false; gbtn.textContent = "Create Asana task"; }
        if (matches && matches.length) { showDedupeToast(matches); return; }
        doSubmitAForm(answers);
      }).catch(function () {
        aform.checking = false;
        if (gbtn) { gbtn.disabled = false; gbtn.textContent = "Create Asana task"; }
        doSubmitAForm(answers); // fail open: a broken duplicate check must not block real work
      });
      return;
    }
    doSubmitAForm(answers);
  }

  function doSubmitAForm(answers) {
    if (aform.submitting) return;
    hideDedupeToast(); // clear any stale duplicate-warning toast before creating
    var btn = el("aform-submit"), status = el("aform-status");
    aform.submitting = true; if (btn) { btn.disabled = true; btn.textContent = "Creating…"; }
    if (status) { status.textContent = ""; status.classList.remove("aform-status-err"); }
    aformContext().then(function (ctx) {
      var payload = buildAFormPayload(answers, ctx);
      var mode = aformMode();
      var p = mode === "broker" ? createTaskBroker(payload)
            : mode === "direct" ? createTaskDirect(payload)
            : createTaskDemo(payload);
      return p.then(function (res) { renderAFormSuccess(res, payload); });
    }).catch(function (e) {
      if (status) {
        status.textContent = "Failed to create the task: " + (reqErr ? reqErr(e) : (e && e.message) || "error");
        status.classList.add("aform-status-err");
      }
    }).then(function () {
      aform.submitting = false; aform.dedupeAck = false;
      if (btn) { btn.disabled = false; btn.textContent = "Create Asana task"; }
      resize();
    });
  }

  function renderAFormSuccess(res, payload) {
    var host = el("aform-body");
    var t = res.task || {};
    var skipped = res.skipped || [];
    // Prefer the explicit count the broker/direct path reports; fall back to the old
    // arithmetic only for an older broker that doesn't send set_count.
    var requested = payload.custom_fields.length;
    var setCount = res.demo ? 0
      : (typeof res.set_count === "number" ? res.set_count
         : Math.max(requested - skipped.length, 0));
    host.innerHTML = '<div class="card aform-done">' +
      '<div class="aform-done-icon">✓</div>' +
      '<div class="aform-done-title">Task created' + (res.demo ? " (sample)" : "") + "</div>" +
      '<div class="aform-done-name">' + esc(t.name || payload.name) + "</div>" +
      (t.url ? '<a class="btn primary" href="' + esc(t.url) + '" target="_blank" rel="noopener">Open in Asana ↗</a>' : "") +
      '<div class="aform-done-meta">' + (payload.custom_fields.length
        ? esc(Math.max(setCount, 0) + " of " + payload.custom_fields.length + " mapped custom fields set") : "No custom fields mapped yet") + "</div>" +
      (skipped.length ? '<div class="aform-skips">' + skipped.map(function (s) {
        return '<div class="aform-skip">⚠ ' + esc(s) + "</div>"; }).join("") + "</div>" : "") +
      '<div class="aform-done-actions">' +
        '<button class="btn" id="aform-again" type="button">New request</button>' +
        '<button class="btn" id="aform-view-tasks" type="button">View Asana tasks</button>' +
      "</div></div>";
    var again = el("aform-again");
    if (again) again.addEventListener("click", function () { initAForm(true); });
    var view = el("aform-view-tasks");
    if (view) view.addEventListener("click", function () {
      switchAsub("linked");
      asanaState.loadedVariant = null;
      if (window.AsanaTasks && window.__asanaReload) window.__asanaReload();
      else loadAsana();
    });
    resize();
  }

  // ── Dedupe gate / "Other requests" sub-tab ────────────────────────────
  // Before a request is created, and on demand from the Other-requests sub-tab,
  // search Asana for recent tasks (last N days; default 14, overridable by the
  // asana_dedupe_days setting or form.dedupe_window_days) whose client/provider ID
  // matches — so associates can spot existing requests and avoid duplicates.
  // Matching prefers the Asana custom field mapped to the client/provider ID
  // question (if a gid is configured); otherwise full-text search of the ID (which
  // is always written into the task description).
  var DEDUPE_DAYS_DEFAULT = 14;
  var DEDUPE_FIELDS = "name,permalink_url,completed,assignee.name,created_at,modified_at,due_on";
  function cfgForm() { return (aform.cfg && aform.cfg.form) || {}; }
  function dedupeWindowDays() {
    return asanaCfg.dedupeDays || Number(cfgForm().dedupe_window_days) || DEDUPE_DAYS_DEFAULT;
  }
  function dedupeWindowISO() {
    return new Date(Date.now() - dedupeWindowDays() * 86400000).toISOString();
  }
  // "n/a", "none", "-" etc. aren't real ids — never gate or search on them.
  function meaningfulId(v) {
    v = String(v == null ? "" : v).trim();
    if (!v) return "";
    if (/^(n\/?a|none|null|na|nil|-|–|—|tbd|unknown)$/i.test(v)) return "";
    return v;
  }
  function dedupeFieldGid(qid) {
    var m = qid && aform.cfg && aform.cfg.asana_custom_fields && aform.cfg.asana_custom_fields[qid];
    return (m && m.gid) ? String(m.gid) : "";
  }
  function fmtAgo(iso) {
    var t = Date.parse(iso); if (isNaN(t)) return "";
    var days = Math.floor((Date.now() - t) / 86400000);
    if (days <= 0) return "today";
    if (days === 1) return "yesterday";
    return days + " days ago";
  }

  // Load the form config once if the agent opens Other-requests before New request.
  function ensureFormCfg() {
    if (aform.cfg) return Promise.resolve(aform.cfg);
    return fetch(SCRIPT_BASE + "asana_form_config.json", { credentials: "same-origin", cache: "no-cache" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (cfg) {
        aform.cfg = cfg; aform.index = {};
        aformWalk(cfg.questions, function (q) { aform.index[q.id] = q; });
        return cfg;
      }).catch(function () { return null; });
  }

  function dedupeSearchDirect(id, qid) {
    var proj = aformProjectGid();
    var cf = dedupeFieldGid(qid);
    var match = cf ? ("custom_fields." + encodeURIComponent(cf) + ".value=" + encodeURIComponent(id))
                   : ("text=" + encodeURIComponent(id));
    var url = "/workspaces/" + encodeURIComponent(asanaCfg.workspace) + "/tasks/search?" + match +
      (proj ? "&projects.any=" + encodeURIComponent(proj) : "") +
      "&completed=false&modified_at.after=" + encodeURIComponent(dedupeWindowISO()) +
      "&sort_by=modified_at&opt_fields=" + DEDUPE_FIELDS;
    return asanaApi(url).then(function (r) { return (r && r.data) || []; });
  }

  function dedupeJobs(clientId, providerId) {
    var f = cfgForm(), jobs = [];
    if (meaningfulId(clientId)) jobs.push({ id: meaningfulId(clientId), qid: f.client_id_question, kind: "client" });
    if (meaningfulId(providerId)) jobs.push({ id: meaningfulId(providerId), qid: f.provider_id_question, kind: "provider" });
    return jobs;
  }

  function dedupeDemo(jobs) {
    var now = Date.now();
    return jobs.map(function (j, i) {
      return { gid: "dedupe-demo-" + i, name: "Existing " + j.kind + " request — " + j.id + " (sample)",
               permalink_url: "https://app.asana.com/0/0/dedupe" + i, completed: false,
               assignee: { name: "CX Triage (sample)" },
               modified_at: new Date(now - (i + 2) * 86400000).toISOString(), _match: j.kind };
    });
  }

  function dedupeSearch(clientId, providerId) {
    var jobs = dedupeJobs(clientId, providerId);
    if (!jobs.length) return Promise.resolve([]);
    var mode = aformMode();
    if (mode === "demo") return Promise.resolve(dedupeDemo(jobs));
    if (mode === "broker") {
      return fetch("/v1/asana/search-requests", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: meaningfulId(clientId), provider_id: meaningfulId(providerId), days: dedupeWindowDays() })
      }).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
        .then(function (j) { return (j.tasks || []).filter(function (t) { return !t.completed; }); });
    }
    // direct: one search per id; merge + de-dupe by gid; open tasks only
    return Promise.all(jobs.map(function (j) {
      return dedupeSearchDirect(j.id, j.qid).then(function (tasks) {
        tasks.forEach(function (t) { if (!t._match) t._match = j.kind; });
        return { tasks: tasks, err: null };
      }).catch(function (e) { return { tasks: [], err: e }; });
    })).then(function (results) {
      var seen = {}, out = [], firstErr = null;
      results.forEach(function (r) {
        if (r.err && !firstErr) firstErr = r.err;
        r.tasks.forEach(function (t) {
          if (t && t.gid && !t.completed && !seen[t.gid]) { seen[t.gid] = 1; out.push(t); }
        });
      });
      // Surface a failed search instead of masquerading as "no duplicates" — a false
      // negative would defeat the dedupe. (The submit gate still fails open via .catch.)
      if (!out.length && firstErr) throw firstErr;
      return out;
    });
  }

  function dedupeCardHTML(t) {
    var when = t.modified_at || t.created_at;
    var meta = [t.assignee && t.assignee.name && ("Assignee: " + esc(t.assignee.name)),
                when && ("Updated " + esc(fmtAgo(when))),
                t._match && ("matches " + esc(t._match) + " ID")].filter(Boolean).join(" · ");
    return '<div class="card atask"><div class="atask-top">' +
      '<a class="atask-name" href="' + esc(t.permalink_url || t.url) + '" target="_blank" rel="noopener">' + esc(t.name) + "</a>" +
      badge(t.completed ? "completed" : "open") + "</div>" +
      (meta ? '<div class="atask-meta">' + meta + "</div>" : "") + "</div>";
  }

  function renderDedupe(tasks) {
    var body = el("dedupe-body"), count = el("dedupe-count");
    if (count) count.textContent = (tasks && tasks.length) || 0;
    if (!body) return;
    if (!tasks || !tasks.length) {
      body.innerHTML = '<div class="card"><div class="empty">No open requests in the last ' + dedupeWindowDays() +
        " days for this client or provider.</div></div>";
      resize(); return;
    }
    body.innerHTML = tasks.map(dedupeCardHTML).join("");
    resize();
  }

  // Current value typed into a form question (used to prefill the dedupe inputs).
  function dedupeFieldValue(qid) {
    if (!qid) return "";
    var node = document.querySelector('#aform-form [data-q="' + qid + '"]');
    return node ? String(node.value || "").trim() : "";
  }

  function runDedupe() {
    var ci = el("dedupe-client"), pi = el("dedupe-provider"), body = el("dedupe-body");
    var clientId = ci ? ci.value : "", providerId = pi ? pi.value : "";
    if (!meaningfulId(clientId) && !meaningfulId(providerId)) { renderDedupe([]); return; }
    if (body) body.innerHTML = '<div class="card"><div class="skeleton" style="width:70%"></div>' +
      '<div class="skeleton" style="width:45%;margin-top:8px"></div></div>';
    resize();
    dedupeSearch(clientId, providerId)
      .then(function (tasks) { dedupe.lastMatches = tasks; renderDedupe(tasks); })
      .catch(function (e) {
        if (body) body.innerHTML = '<div class="card error"><p>Search failed: ' +
          esc(reqErr ? reqErr(e) : (e && e.message) || "error") + "</p></div>";
        resize();
      });
  }

  function initDedupe() {
    ensureFormCfg().then(function () {
      var hint = el("dedupe-hint");
      if (hint) hint.textContent = "Open Asana requests from the last " + dedupeWindowDays() +
        " days that match the client or provider ID.";
      var f = cfgForm(), ci = el("dedupe-client"), pi = el("dedupe-provider");
      var cVal = dedupeFieldValue(f.client_id_question), pVal = dedupeFieldValue(f.provider_id_question);
      if (ci && !meaningfulId(ci.value) && meaningfulId(cVal)) ci.value = cVal;
      if (pi && !meaningfulId(pi.value) && meaningfulId(pVal)) pi.value = pVal;
      if ((ci && meaningfulId(ci.value)) || (pi && meaningfulId(pi.value))) runDedupe();
      else renderDedupe([]);
    });
  }

  function showDedupeToast(matches) {
    dedupe.lastMatches = matches || [];
    var t = el("dedupe-toast"), msg = el("dedupe-toast-msg");
    if (!t) return;
    var n = dedupe.lastMatches.length;
    if (msg) msg.textContent = "This client/provider already has " + n + " open request" + (n === 1 ? "" : "s") +
      " from the last " + dedupeWindowDays() + " days. Submit a new one anyway?";
    t.hidden = false;
    resize();
  }
  function hideDedupeToast() { var t = el("dedupe-toast"); if (t) t.hidden = true; resize(); }

  // ── Slack pane (post to the team channel + follow the thread) ─────────
  // The "workflow": a small compose card posts a structured request into ONE
  // configured channel; every post for this ticket is listed below it, and each
  // expands to its reply thread with a composer (replies land in the Slack thread).
  //   broker page -> /v1/slack/* endpoints (broker owns the bot token)
  //   direct mode -> slack.com Web API via Zendesk's secure proxy
  //   demo        -> seeded sample posts, kept in-memory
  var slackState = { mode: null, loadedTicket: null, demo: null };

  function slackMode() {
    if (window.AsanaTasks) return "broker";
    if (slackCfg.channel) return "direct";
    return "demo";
  }
  function slackMarker(tid) { return "[Ticket #" + (tid || "—") + "]"; }
  function slackWhen(ts) {
    var d = new Date(parseFloat(ts) * 1000);
    return isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  // Direct mode. Slack's Web API wants form-encoding; the bot token is substituted
  // server-side by Zendesk ({{setting.slack_bot_token}}), never visible here.
  function slackApi(method, params) {
    var body = Object.keys(params || {}).map(function (k) {
      return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]);
    }).join("&");
    return client.request({
      url: "https://slack.com/api/" + method, type: "POST",
      headers: { Authorization: "Bearer {{setting.slack_bot_token}}" },
      secure: true, cors: false, dataType: "json",
      contentType: "application/x-www-form-urlencoded", data: body
    }).then(function (r) {
      if (!r || r.ok !== true) throw new Error("Slack: " + ((r && r.error) || "request failed"));
      return r;
    });
  }
  function slackBrokerApi(path, body) {
    return fetch(path, {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error((j && j.detail) || ("HTTP " + r.status));
        return j;
      });
    });
  }

  function slackDemoStore(tid) {
    if (slackState.demo) return slackState.demo;
    var now = Date.now() / 1000;
    slackState.demo = {
      posts: [
        { ts: String(now - 86400 * 2), text: ":rotating_light: *Duplicate charge escalation* — Urgent · " + slackMarker(tid) +
            "\nMember charged twice for the 5/12 session; processor dispute DSP-4471 opened. (sample)",
          reply_count: 2, replies: [
            { ts: String(now - 86000), author: "Dana (Finance) (sample)", text: "Looking at this now — confirming both charges hit the same card." },
            { ts: String(now - 82000), author: "Dana (Finance) (sample)", text: "Credit approved, ETA 3-5 business days." }
          ] },
        { ts: String(now - 86400), text: ":memo: *Superbill resend* — Normal · " + slackMarker(tid) +
            "\nMember can’t find the 5/12 superbill; please resend. (sample)",
          reply_count: 1, replies: [
            { ts: String(now - 50000), author: "Sam (Billing) (sample)", text: "Re-sent to the email on file ✓" }
          ] }
      ]
    };
    return slackState.demo;
  }

  // Render Slack mrkdwn faithfully in the sidebar (Slack shows *bold*, :emoji:
  // and <url|label> formatted; showing the raw codes here reads as a bug).
  // esc() runs FIRST — the transforms below only operate on escaped text and
  // only emit fixed tags, so message content can't inject markup.
  var SLACK_EMOJI = { memo: "📝", rotating_light: "🚨", zap: "⚡", white_check_mark: "✅",
    warning: "⚠️", bell: "🔔", mega: "📣", pushpin: "📌", eyes: "👀", tada: "🎉",
    red_circle: "🔴", large_green_circle: "🟢", point_right: "👉", flag: "⚑" };
  function slackMrkdwn(text) {
    var h = esc(text);
    h = h.replace(/&lt;(https?:.+?)\|(.+?)&gt;/g, function (m, u, l) {
      return '<a href="' + u + '" target="_blank" rel="noopener">' + l + "</a>";
    });
    h = h.replace(/&lt;(https?:[^\s]+?)&gt;/g, function (m, u) {
      return '<a href="' + u + '" target="_blank" rel="noopener">' + u + "</a>";
    });
    h = h.replace(/\*([^*\n]{1,200}?)\*/g, "<strong>$1</strong>");
    h = h.replace(/:([a-z0-9_+\-]+):/g, function (m, code) { return SLACK_EMOJI[code] || m; });
    return h;
  }

  function slackPostHTML(p) {
    var first = String(p.text || "").split("\n")[0];
    var rest = String(p.text || "").split("\n").slice(1).join("\n");
    var n = p.reply_count || 0;
    return '<div class="card spost" data-ts="' + esc(p.ts) + '">' +
      '<div class="spost-top"><div class="spost-title">' + slackMrkdwn(first) + "</div></div>" +
      (rest ? '<div class="spost-text">' + slackMrkdwn(rest) + "</div>" : "") +
      '<div class="spost-meta">' + esc(slackWhen(p.ts)) + " · " + n + " repl" + (n === 1 ? "y" : "ies") +
      (p.permalink ? ' · <a href="' + esc(p.permalink) + '" target="_blank" rel="noopener">Open in Slack ↗</a>' : "") + "</div>" +
      '<div class="atask-toggle" role="button" tabindex="0" data-slack-ts="' + esc(p.ts) + '" aria-expanded="false">▸ Thread</div>' +
      '<div class="sthread" hidden></div></div>';
  }

  function renderSlack(posts) {
    var host = el("slack-list");
    if (!host) return;
    var cnt = el("slack-count"); if (cnt) cnt.textContent = posts.length;
    host.innerHTML = posts.length ? posts.map(slackPostHTML).join("")
      : '<div class="card"><div class="empty">No posts for this ticket yet — use the composer above.</div></div>';
    resize();
  }

  function loadSlack(force) {
    var host = el("slack-body");
    if (!host) return;
    settingsReady.then(function () {
      var mode = slackMode();
      var tid = state.ticketId;
      // On the broker page the shell sets this note from /healthz; leave it alone.
      var note = el("slack-sample-note");
      if (note && mode !== "broker") note.hidden = mode !== "demo";
      if (slackState.loadedTicket === tid && slackState.mode === mode && !force) return;
      slackState.loadedTicket = tid; slackState.mode = mode;
      host.innerHTML =
        '<div class="card scompose">' +
          '<div class="section-head"><h2>Post to the team channel</h2></div>' +
          '<input class="aform-input" id="slack-title" type="text" placeholder="Title (e.g. LIV — duplicate charge escalation)">' +
          '<div class="scompose-row"><label class="scompose-lbl">Urgency</label>' +
            '<select class="aform-input aform-select" id="slack-urgency">' +
              '<option value="Normal">Normal</option><option value="Urgent">Urgent</option></select></div>' +
          '<textarea class="composer-input" id="slack-text" placeholder="What do you need from the team? The ticket link is attached automatically."></textarea>' +
          '<div class="composer-row"><span class="composer-hint" id="slack-hint">Posts include ' + esc(slackMarker(tid)) + " so the thread stays linked to this ticket</span>" +
            '<button class="btn primary" id="slack-post" type="button">Post</button></div>' +
        "</div>" +
        '<div class="section-head asana-head"><h2>Posts for ticket <span>' + (tid ? "#" + esc(tid) : "—") + "</span></h2>" +
          '<span class="count-pill" id="slack-count">0</span></div>' +
        '<div id="slack-list"><div class="card"><div class="skeleton" style="width:70%"></div></div></div>';
      var btn = el("slack-post");
      if (btn) btn.addEventListener("click", submitSlackPost);
      refreshSlackPosts();
      resize();
    });
  }

  function refreshSlackPosts() {
    var tid = state.ticketId, mode = slackState.mode;
    if (mode === "demo") { renderSlack(slackDemoStore(tid).posts); return; }
    if (mode === "broker") {
      slackBrokerApi("/v1/slack/posts", { ticket_id: String(tid || "") })
        .then(function (j) { renderSlack(j.posts || []); })
        .catch(function (e) { slackError(e.message); });
      return;
    }
    var marker = slackMarker(tid), collected = [];
    // Follow the cursor (bounded) so a busy shared channel doesn't push this ticket's
    // posts out of a single 100-message window and wrongly show "no posts".
    function page(cursor, pagesLeft) {
      var params = { channel: slackCfg.channel, limit: 200 };
      if (cursor) params.cursor = cursor;
      return slackApi("conversations.history", params).then(function (r) {
        ((r && r.messages) || []).forEach(function (m) {
          if (String(m.text || "").indexOf(marker) > -1) {
            collected.push({ ts: m.ts, text: m.text, reply_count: m.reply_count || 0 });
          }
        });
        var next = r && r.response_metadata && r.response_metadata.next_cursor;
        if (next && pagesLeft > 1) return page(next, pagesLeft - 1);
        renderSlack(collected);
      });
    }
    page(null, 10).catch(function (e) { slackError(e.message); });
  }
  function slackError(msg) {
    var host = el("slack-list") || el("slack-body");
    host.innerHTML = '<div class="card error"><p>' + esc(msg || "Slack request failed.") + "</p></div>";
    resize();
  }

  function buildSlackText(tid, title, urgency, text, ctx) {
    var icon = urgency === "Urgent" ? ":rotating_light:" : ":memo:";
    return icon + " *" + title + "* — " + urgency + " · " + slackMarker(tid) + "\n" + text +
      (ctx && ctx["ticket.url"] ? "\n→ " + ctx["ticket.url"] : "");
  }

  function submitSlackPost() {
    var title = (el("slack-title").value || "").trim();
    var urgency = el("slack-urgency").value || "Normal";
    var text = (el("slack-text").value || "").trim();
    var hint = el("slack-hint"), btn = el("slack-post");
    if (!title || !text) {
      if (hint) { hint.textContent = "Add a title and a message before posting."; hint.style.color = "var(--danger)"; }
      return;
    }
    btn.disabled = true; btn.textContent = "Posting…";
    if (hint) hint.style.color = "";
    aformContext().then(function (ctx) {
      var tid = state.ticketId, mode = slackState.mode;
      if (mode === "demo") {
        var store = slackDemoStore(tid);
        store.posts.unshift({ ts: String(Date.now() / 1000),
          text: buildSlackText(tid, title, urgency, text, ctx) + " (sample)", reply_count: 0, replies: [] });
        return null;
      }
      if (mode === "broker") {
        return slackBrokerApi("/v1/slack/post",
          { ticket_id: String(tid || ""), title: title, urgency: urgency, text: text, ticket_url: ctx["ticket.url"] || "" });
      }
      return slackApi("chat.postMessage", { channel: slackCfg.channel, text: buildSlackText(tid, title, urgency, text, ctx), unfurl_links: "false" });
    }).then(function () {
      el("slack-title").value = ""; el("slack-text").value = "";
      if (hint) { hint.textContent = "Posted ✓"; hint.style.color = "var(--ok)"; }
      refreshSlackPosts();
    }).catch(function (e) {
      if (hint) { hint.textContent = "Failed to post: " + ((e && e.message) || "error"); hint.style.color = "var(--danger)"; }
    }).then(function () { btn.disabled = false; btn.textContent = "Post"; resize(); });
  }

  function slackReplyHTML(r) {
    // Format from the raw ts in the agent's own timezone; the server-formatted `when`
    // (broker host tz) is only a fallback so a thread and its parent never disagree.
    return '<div class="cmt"><div class="cmt-head"><span class="cmt-who">' + esc(r.author || "—") +
      '</span><span class="cmt-when">' + esc(slackWhen(r.ts) || r.when || "") + "</span></div>" +
      '<div class="cmt-text">' + slackMrkdwn(r.text) + "</div></div>";
  }
  function slackThreadHTML(replies, ts, ch) {
    return '<div class="cmt-label">Thread replies</div>' +
      '<div class="cmt-thread">' +
        '<div class="cmt-list">' + (replies.length ? replies.map(slackReplyHTML).join("") : '<div class="empty">No replies yet.</div>') + "</div>" +
        '<div class="composer"><textarea class="composer-input" placeholder="Reply in the Slack thread..."></textarea>' +
        '<div class="composer-row"><span class="composer-hint">Posts into this thread in Slack</span>' +
        '<button class="btn primary slack-reply-send" type="button" data-ts="' + esc(ts) + '"' + (ch ? ' data-ch="' + esc(ch) + '"' : "") + '>Send</button></div></div>' +
      '</div>';
  }

  // Demo threads can belong to the Post store or to a sample request row.
  function slackDemoThread(ts) {
    var post = slackDemoStore(state.ticketId).posts.filter(function (x) { return x.ts === ts; })[0];
    if (post) return post;
    return (slackReq.demo || []).filter(function (x) { return x.ts === ts; })[0] || null;
  }

  // Load (or reload) a thread into its box. Shared by the expand toggle and
  // the 30s sync; marks the thread seen and clears its unread bell.
  function loadSlackThreadInto(tog, box) {
    var ts = tog.getAttribute("data-slack-ts");
    var ch = tog.getAttribute("data-slack-ch") || slackCfg.channel;
    if (!box.getAttribute("data-loaded")) box.innerHTML = '<div class="skeleton" style="width:70%"></div>';
    var mode = slackMode();
    var p;
    if (mode === "demo") {
      var t = slackDemoThread(ts);
      p = Promise.resolve((t && t.replies) || []);
    } else if (mode === "broker") {
      p = slackBrokerApi("/v1/slack/thread", { ts: ts }).then(function (j) { return j.replies || []; });
    } else {
      p = slackApi("conversations.replies", { channel: ch, ts: ts }).then(function (r) {
        return ((r && r.messages) || []).slice(1).map(function (m) {
          return { ts: m.ts, author: m.username || m.user || "Slack user", text: m.text };
        });
      });
    }
    return p.then(function (replies) {
      box.setAttribute("data-loaded", "1");
      box.innerHTML = slackThreadHTML(replies, ts, ch);
      slackMarkSeen(ts, replies.length ? replies[replies.length - 1].ts : ts);
      var card = tog.closest(".spost");
      var bell = card && card.querySelector(".abell");
      if (bell && bell.parentNode) bell.parentNode.removeChild(bell);
      resize();
    }).catch(function (e) {
      box.innerHTML = '<div class="empty">Failed to load the thread: ' + esc((e && e.message) || "error") + "</div>";
      resize();
    });
  }

  function toggleSlackThread(tog) {
    var box = tog.nextElementSibling;
    if (!box || !box.classList.contains("sthread")) return;
    var open = box.hidden;
    box.hidden = !open;
    tog.setAttribute("aria-expanded", String(open));
    tog.textContent = (open ? "▾ " : "▸ ") + "Thread";
    if (open && !box.getAttribute("data-loaded")) loadSlackThreadInto(tog, box);
    resize();
  }

  function sendSlackReply(btn) {
    var composer = btn.closest(".composer");
    var ta = composer.querySelector(".composer-input");
    var hint = composer.querySelector(".composer-hint");
    var text = (ta.value || "").trim();
    if (!text) return;
    var ts = btn.getAttribute("data-ts");
    var ch = btn.getAttribute("data-ch") || slackCfg.channel;
    btn.disabled = true; btn.textContent = "Sending…";
    aformContext().then(function (ctx) {
      var mode = slackMode();
      var attributed = ctx["agent.email"] ? text + "\n_— " + ctx["agent.email"] + " via Zendesk_" : text;
      if (mode === "demo") {
        var t = slackDemoThread(ts);
        var reply = { ts: String(Date.now() / 1000), author: (ctx["agent.email"] || "You") + " (sample)", text: text };
        if (t) { t.replies = t.replies || []; t.replies.push(reply); t.reply_count = t.replies.length; }
        return reply;
      }
      if (mode === "broker") {
        return slackBrokerApi("/v1/slack/reply", { ts: ts, text: text }).then(function (j) { return j.reply; });
      }
      return slackApi("chat.postMessage", { channel: ch, thread_ts: ts, text: attributed })
        .then(function (r) { slackMarkSeen(ts, r.ts || ""); return { ts: r.ts, author: ctx["agent.email"] || "You", text: text }; });
    }).then(function (reply) {
      var list = composer.parentNode.querySelector(".cmt-list");
      if (list && reply) {
        var empty = list.querySelector(".empty"); if (empty) list.innerHTML = "";
        list.insertAdjacentHTML("beforeend", slackReplyHTML(reply));
      }
      ta.value = "";
      if (hint) { hint.textContent = "Posts into this thread in Slack"; hint.style.color = ""; }
    }).catch(function (e) {
      if (hint) { hint.textContent = "Failed: " + ((e && e.message) || "error"); hint.style.color = "var(--danger)"; }
    }).then(function () { btn.disabled = false; btn.textContent = "Send"; resize(); });
  }

  // ── Slack directory + workflows (Channels | Workflows sub-tabs) ────────
  // Channels: the workspace directory (conversations.list) with per-agent
  // favorites; real Slack stars merge in when the token can read them
  // (stars:read is a user-token scope — bot tokens silently degrade).
  // Workflows: link triggers from the slack_workflow_links setting plus any
  // workflow links bookmarked in the posting/home channels (bookmarks.list).
  // Reads only — no ticket data leaves Zendesk; Launch opens Slack itself.
  var ssubState = { active: "post" };
  var slackDir = { channels: null, chLoaded: null, wfLoaded: null, team: "", starred: null };

  function switchSsub(name) {
    ssubState.active = name;
    Array.prototype.forEach.call(document.querySelectorAll("#slack-subtabs .subtab"), function (b) {
      b.classList.toggle("active", b.getAttribute("data-ssub") === name);
    });
    Array.prototype.forEach.call(document.querySelectorAll("#pane-slack .ssub"), function (p) {
      p.classList.toggle("active", p.id === "ssub-" + name);
    });
    if (name === "channels") loadSlackChannels();
    else if (name === "workflows") { loadSlackWorkflows(); loadSlackRequests(); startSlackSync(); }
    ahtSwitch();
    resize();
  }

  // Per-agent channel favorites — same local-pin pattern (and storage shape)
  // as Guru pins; Slack's API has no favorites write for channels.
  function slackPins() { return guruLS("cxsidebar.slack.pins"); }
  function slackIsPinned(id) { return slackPins().some(function (p) { return p.id === id; }); }
  function slackTogglePin(id, name) {
    var pins = slackPins();
    var next = pins.filter(function (p) { return p.id !== id; });
    var nowPinned = next.length === pins.length;
    if (nowPinned) next.unshift({ id: id, name: name });
    guruSaveLS("cxsidebar.slack.pins", next);
    return nowPinned;
  }
  function slackPinBtnHTML(id, name) {
    var pinned = slackIsPinned(id);
    return '<button class="btn icon guru-pin' + (pinned ? " pinned" : "") + '" type="button" data-slack-pin="' + esc(id) + '" data-slack-name="' + esc(name) + '" title="' + (pinned ? "Remove favorite" : "Favorite (saved locally to this browser)") + '">' + (pinned ? "★" : "☆") + "</button>";
  }
  function slackChanName(id) {
    var hit = (slackDir.channels || []).filter(function (c) { return c.id === id; })[0];
    return hit ? "#" + hit.name : "channel";
  }

  // Relevance-scoped directory. A workspace can hold thousands of channels, so
  // the default view is only the bounded set that matters for this install:
  // favorites (local pins + real Slack stars) ∪ channels the token is a member
  // of (users.conversations — the bot lives where the team works) ∪ configured
  // channels (posting + home list). The FULL directory is reachable only via
  // explicit search: Slack has no server-side name-query API, so search pages
  // conversations.list with a cursor (bounded) and filters client-side.
  var SLACK_DIR_PAGES = 3; // × 200 channels per search sweep

  function loadSlackChannels(force) {
    var host = el("slack-channels-body"); if (!host) return;
    Promise.resolve(settingsReady).then(function () {
      var mode = slackMode();
      if (slackDir.chLoaded === mode && !force) { renderSlackChannels(); return; }
      if (mode === "demo") {
        slackDir.team = ""; slackDir.starred = null;
        slackDir.channels = [
          { id: "C-SAMPLE-1", name: "cx-commons", topic: "Team-wide CX room — questions and wins (sample)", member: true },
          { id: "C-SAMPLE-2", name: "cx-cat-crossfunctional", topic: "CX ↔ CAT escalations (sample)", member: true },
          { id: "C-SAMPLE-3", name: "billing-escalations", topic: "Urgent member billing issues (sample)", member: true },
          { id: "C-SAMPLE-4", name: "prod-eng-bridge", topic: "Bug reports triaged Tue/Thu (sample)", member: false }
        ];
        slackDir.chLoaded = mode; renderSlackChannels(); return;
      }
      if (mode === "broker") {
        host.innerHTML = emptyStateHTML("hash", "Channel browsing needs direct mode", "The broker path doesn’t expose the channel directory.");
        resize(); return;
      }
      host.innerHTML = '<div class="card"><div class="skeleton" style="width:70%"></div><div class="skeleton" style="width:45%;margin-top:8px"></div></div>'; resize();
      slackApi("auth.test", {})
        .then(function (a) { slackDir.team = (a && a.team_id) || ""; }, function () {})
        .then(function () { return slackApi("users.conversations", { types: "public_channel,private_channel", exclude_archived: "true", limit: 200 }); })
        .then(function (r) {
          var byId = {};
          slackDir.channels = ((r && r.channels) || []).map(function (c) {
            byId[c.id] = 1;
            return { id: c.id, name: c.name || c.id, topic: (c.topic && c.topic.value) || (c.purpose && c.purpose.value) || "", member: true };
          });
          slackDir.chLoaded = mode;
          // Real starred channels (user tokens only) — merge quietly if readable.
          return slackApi("stars.list", { limit: 100 }).then(function (s) {
            var ids = {};
            (((s && s.items) || [])).forEach(function (it) { if (it && it.type === "channel" && it.channel) ids[it.channel] = 1; });
            slackDir.starred = ids;
          }, function () { slackDir.starred = null; }).then(function () {
            // Pull metadata for relevant channels outside the membership set:
            // stars + local pins + configured (bounded, failures tolerated).
            var want = [];
            Object.keys(slackDir.starred || {}).forEach(function (id) { want.push(id); });
            slackPins().forEach(function (p) { want.push(p.id); });
            [slackCfg.channel].concat(slackCfg.homeChannels || []).forEach(function (id) { if (id) want.push(id); });
            want = want.filter(function (id, i) { return byId[id] !== 1 && want.indexOf(id) === i; }).slice(0, 12);
            return Promise.all(want.map(function (id) {
              return slackApi("conversations.info", { channel: id }).then(function (r2) {
                var c = (r2 && r2.channel) || {};
                if (c.id) slackDir.channels.push({ id: c.id, name: c.name || c.id,
                  topic: (c.topic && c.topic.value) || (c.purpose && c.purpose.value) || "", member: !!c.is_member });
              }, function () {});
            }));
          });
        })
        .then(function () { renderSlackChannels(); })
        .catch(function (e) {
          var msg = String((e && e.message) || "");
          host.innerHTML = msg.indexOf("missing_scope") > -1
            ? emptyStateHTML("hash", "The token can’t list channels", "Add channels:read (and groups:read for private channels) to the Slack app, then reinstall it.")
            : '<div class="card error"><p>' + esc(msg || "Couldn’t load channels.") + "</p></div>";
          resize();
        });
    });
  }

  function slackChannelRowHTML(c) {
    var pinned = slackIsPinned(c.id), starred = (slackDir.starred || {})[c.id];
    var live = slackMode() === "direct" && slackDir.team;
    var meta = [];
    if (c.id === slackCfg.channel) meta.push('<span class="gv-badge gv-ok">posting channel</span>');
    if (starred) meta.push('<span class="gv-badge gv-warn">★ starred in Slack</span>');
    if (c.member) meta.push('<span class="guru-row-col">' + (slackMode() === "demo" ? "bot in channel" : "member") + "</span>");
    if (c.topic) meta.push('<span class="guru-row-col">' + esc(c.topic) + "</span>");
    var inner = '<span class="guru-row-nav"><span class="guru-row-ic">' + icon("hash") + '</span><span class="guru-row-title">' + esc(c.name) + "</span>" +
      (live ? '<span class="guru-row-drill">↗</span>' : "") + "</span>" +
      (meta.length ? '<span class="guru-row-meta">' + meta.join("") + "</span>" : "");
    var main = live
      ? '<a class="guru-row-main guru-row-link" href="https://app.slack.com/client/' + esc(slackDir.team) + "/" + esc(c.id) + '" target="_blank" rel="noopener" style="display:block">' + inner + "</a>"
      : '<div class="guru-row-main guru-row-static">' + inner + "</div>";
    return '<div class="guru-row">' + main + slackPinBtnHTML(c.id, c.name) + "</div>";
  }

  function renderSlackChannels() {
    var host = el("slack-channels-body"); if (!host) return;
    var term = ((el("slack-ch-search") || {}).value || "").trim().toLowerCase();
    if (term.length >= 2) { renderSlackChSearch(term); return; }
    var chans = (slackDir.channels || []).slice();
    var cnt = el("slack-ch-count"); if (cnt) cnt.textContent = chans.length;
    if (!chans.length) { host.innerHTML = emptyStateHTML("hash", "No relevant channels yet", "Favorite, configure or invite the bot to channels — or search the directory above."); resize(); return; }
    var pinned = {}; slackPins().forEach(function (p) { pinned[p.id] = 1; });
    var starred = slackDir.starred || {};
    function rank(c) { return (pinned[c.id] || starred[c.id] ? 2 : 0) + (c.member ? 1 : 0); }
    chans.sort(function (a, b) { return (rank(b) - rank(a)) || String(a.name).localeCompare(String(b.name)); });
    host.innerHTML = chans.map(slackChannelRowHTML).join("") +
      (slackMode() === "direct" ? '<div class="dedupe-hint" style="margin-top:6px">Showing favorites, memberships and configured channels — search to reach the full directory.</div>' : "");
    resize();
  }

  // Directory search: cursor-paged conversations.list, cached per session,
  // filtered client-side. Sequence-tokened like Guru search.
  function slackDirPages() {
    if (slackDir.dirP) return slackDir.dirP;
    var all = [];
    function page(cursor, left) {
      var params = { types: "public_channel,private_channel", exclude_archived: "true", limit: 200 };
      if (cursor) params.cursor = cursor;
      return slackApi("conversations.list", params).then(function (r) {
        ((r && r.channels) || []).forEach(function (c) {
          all.push({ id: c.id, name: c.name || c.id, topic: (c.topic && c.topic.value) || (c.purpose && c.purpose.value) || "", member: !!c.is_member });
        });
        var next = r && r.response_metadata && r.response_metadata.next_cursor;
        if (next && left > 1) return page(next, left - 1);
        return all;
      });
    }
    slackDir.dirP = page(null, SLACK_DIR_PAGES).catch(function (e) { slackDir.dirP = null; throw e; });
    return slackDir.dirP;
  }
  function renderSlackChSearch(term) {
    var host = el("slack-channels-body"); if (!host) return;
    var seq = slackDir.searchSeq = (slackDir.searchSeq || 0) + 1;
    function show(list) {
      if (seq !== slackDir.searchSeq) return;
      var hits = list.filter(function (c) {
        return c.name.toLowerCase().indexOf(term) > -1 || (c.topic || "").toLowerCase().indexOf(term) > -1;
      }).slice(0, 30);
      var cnt = el("slack-ch-count"); if (cnt) cnt.textContent = hits.length;
      host.innerHTML = hits.length
        ? '<div class="cmt-label">Directory results</div>' + hits.map(slackChannelRowHTML).join("")
        : emptyStateHTML("search", "No channels matched", "The sweep covers the first " + (SLACK_DIR_PAGES * 200) + " directory entries.");
      resize();
    }
    if (slackMode() !== "direct") { show(slackDir.channels || []); return; }
    host.innerHTML = '<div class="card"><div class="skeleton" style="width:60%"></div></div>'; resize();
    slackDirPages().then(show, function (e) {
      if (seq !== slackDir.searchSeq) return;
      host.innerHTML = '<div class="card error"><p>' + esc((e && e.message) || "Directory search failed.") + "</p></div>"; resize();
    });
  }

  // "Label|https://slack.com/shortcuts/…" entries, comma- or newline-separated.
  function parseWorkflowLinks(raw) {
    return String(raw || "").split(/[\n,]+/).map(function (s) {
      var t = s.trim(); if (!t) return null;
      var i = t.indexOf("|");
      var label = i > -1 ? t.slice(0, i).trim() : "";
      var url = (i > -1 ? t.slice(i + 1) : t).trim();
      if (!/^https:\/\//i.test(url)) return null;
      return { name: label || url.replace(/^https:\/\//i, "").slice(0, 40), url: url, src: "app settings" };
    }).filter(Boolean);
  }
  var SLACK_WF_URL = /slack\.com\/(shortcuts|workflows?)\//i;

  function loadSlackWorkflows(force) {
    var host = el("slack-wf-body"); if (!host) return;
    Promise.resolve(settingsReady).then(function () {
      var mode = slackMode();
      if (slackDir.wfLoaded === mode && !force) return;
      var configured = (slackCfg.workflows || []).slice();
      if (mode !== "direct") {
        slackDir.wfLoaded = mode;
        if (!configured.length && mode === "demo") {
          renderSlackWorkflows([
            { name: "CX escalation intake (sample)", url: "", src: "sample form workflow" },
            { name: "Bug report to Engineering (sample)", url: "", src: "sample form workflow" },
            { name: "Refund approval request (sample)", url: "", src: "sample form workflow" }
          ]);
        } else renderSlackWorkflows(configured);
        return;
      }
      host.innerHTML = '<div class="card"><div class="skeleton" style="width:70%"></div><div class="skeleton" style="width:45%;margin-top:8px"></div></div>'; resize();
      // Discover workflow links bookmarked in the channels that are relevant to
      // THIS agent/install — posting + home config + local favorites + real
      // stars (when already known) — never a full-workspace sweep.
      var chIds = [slackCfg.channel].concat(slackCfg.homeChannels || [])
        .concat(slackPins().map(function (p) { return p.id; }))
        .concat(Object.keys(slackDir.starred || {}));
      chIds = chIds.filter(function (v, i) { return v && chIds.indexOf(v) === i; }).slice(0, 10);
      Promise.all(chIds.map(function (cid) {
        return slackApi("bookmarks.list", { channel_id: cid }).then(function (r) {
          return (((r && r.bookmarks) || [])).filter(function (b) { return b && b.link && SLACK_WF_URL.test(b.link); })
            .map(function (b) { return { name: b.title || "Workflow", url: b.link, src: slackChanName(cid) + " bookmark" }; });
        }, function () { return []; });
      })).then(function (lists) {
        var seen = {}; configured.forEach(function (w) { seen[w.url] = 1; });
        lists.forEach(function (l) { l.forEach(function (w) { if (!seen[w.url]) { seen[w.url] = 1; configured.push(w); } }); });
        slackDir.wfLoaded = mode;
        renderSlackWorkflows(configured);
      });
    });
  }

  function renderSlackWorkflows(wfs) {
    var host = el("slack-wf-body"); if (!host) return;
    var cnt = el("slack-wf-count"); if (cnt) cnt.textContent = wfs.length;
    if (!wfs.length) {
      host.innerHTML = emptyStateHTML("bolt", "No workflows yet", "Add ‘Label|link’ entries to the Slack workflows setting, or bookmark a workflow link in the posting channel.");
      resize(); return;
    }
    host.innerHTML = wfs.map(function (w) {
      var launch = w.url
        ? '<a class="btn small primary srow-open" href="' + esc(w.url) + '" target="_blank" rel="noopener">Launch</a>'
        : '<button class="btn small srow-open" type="button" disabled title="Demo — set the Slack workflows setting to go live">Launch</button>';
      return '<div class="guru-row"><div class="guru-row-main guru-row-static">' +
        '<span class="guru-row-nav"><span class="guru-row-ic">' + icon("bolt") + '</span><span class="guru-row-title">' + esc(w.name) + "</span></span>" +
        '<span class="guru-row-meta"><span class="guru-row-col">' + esc(w.src) + "</span></span></div>" + launch + "</div>";
    }).join("") + '<div class="dedupe-hint" style="margin-top:8px">Launch opens the workflow in Slack — form workflows collect the details there and post to their channel.</div>';
    resize();
  }

  // ── Ticket-scoped Slack requests ───────────────────────────────────────
  // The Asana pattern applied to Slack: scan the scoped channels for messages
  // that reference THIS ticket (marker or a "ticket … #N" phrase, blocks
  // included — workflow submissions often carry the id in a form field, not
  // the fallback text) and show them with an open/resolved state.
  //
  // Open/resolved denotation (Slack-native, no extra scopes):
  //   resolved ⇢ a ✅/☑️ reaction on the request message, OR a thread reply
  //   that starts with ✅ / "resolved" / "done" / "closed". Anyone in Slack
  //   closes with one reaction; agents close from here with Mark resolved
  //   (posts the ✅ reply via the bot). Everything else counts as open.
  var RESOLVE_REACTIONS = { white_check_mark: 1, heavy_check_mark: 1, ballot_box_with_check: 1 };
  var RESOLVE_REPLY_RE = /^\s*(?:✅|☑️?|✔️?|:white_check_mark:|:heavy_check_mark:|resolved\b|done\b|closed\b)/i;
  var SEEN_SLACK_KEY = "cxsidebar.slack.seen";

  function slackSeenMap() { try { return JSON.parse(localStorage.getItem(SEEN_SLACK_KEY) || "{}"); } catch (e) { return {}; } }
  function slackMarkSeen(ts, at) {
    var m = slackSeenMap();
    if (!m[ts] || String(at) > String(m[ts])) { m[ts] = at; try { localStorage.setItem(SEEN_SLACK_KEY, JSON.stringify(m)); } catch (e) {} }
  }

  // All human-visible text of a message: fallback text + header/section blocks
  // (plain_text and mrkdwn, incl. section fields where form values land).
  function slackMsgText(m) {
    var parts = [m && m.text || ""];
    ((m && m.blocks) || []).forEach(function (b) {
      if (!b) return;
      if (b.text && b.text.text) parts.push(b.text.text);
      (b.fields || []).forEach(function (f) { if (f && f.text) parts.push(f.text); });
      (b.elements || []).forEach(function (e2) {
        if (e2 && e2.text && e2.text.text) parts.push(e2.text.text);
        else if (e2 && typeof e2.text === "string") parts.push(e2.text);
      });
    });
    return parts.join("\n");
  }
  function slackTicketRe(tid) {
    return new RegExp("\\[Ticket #" + tid + "\\]|ticket[^0-9a-z]{0,12}#?" + tid + "\\b", "i");
  }
  function slackMsgState(m) {
    var rx = (m && m.reactions) || [];
    for (var i = 0; i < rx.length; i++) if (RESOLVE_REACTIONS[rx[i].name]) return "resolved";
    if (slackReq.replyState[m.ts]) return slackReq.replyState[m.ts];
    return "open";
  }
  function slackPermalink(ch, ts) {
    if (!slackDir.teamUrl) return "";
    return slackDir.teamUrl + "archives/" + ch + "/p" + String(ts).replace(".", "");
  }

  var slackReq = { list: null, loadedKey: null, replyState: {}, timer: null, searchSeq: 0 };

  function slackDemoRequests(tid) {
    if (slackReq.demo) return slackReq.demo;
    var now = Date.now() / 1000;
    slackReq.demo = [
      { ts: String(now - 3600), channel: "C-SAMPLE-1", channelName: "cx-commons", state: "open", reply_count: 2, latest_reply: String(now - 600),
        text: ":zap: *CX escalation intake* — submitted\nTicket: #" + tid + " · Urgency: High · Member double-charged (sample)",
        replies: [ { ts: String(now - 1800), author: "Billing Triage (sample)", text: "Looking now — pulling the processor log." },
                   { ts: String(now - 600), author: "Billing Triage (sample)", text: "Confirmed duplicate; drafting the refund." } ] },
      { ts: String(now - 86400), channel: "C-SAMPLE-3", channelName: "billing-escalations", state: "open", reply_count: 0, latest_reply: "",
        text: ":memo: *Refund approval request* — submitted\nTicket: #" + tid + " · $25 duplicate charge (sample)", replies: [] },
      { ts: String(now - 172800), channel: "C-SAMPLE-1", channelName: "cx-commons", state: "resolved", reply_count: 3, latest_reply: String(now - 86000),
        text: ":zap: *CX escalation intake* — submitted\nTicket: #" + tid + " · EOB re-pull (sample)",
        replies: [ { ts: String(now - 86000), author: "CX Ops (sample)", text: "✅ resolved — EOB re-pulled and shared." } ] }
    ];
    return slackReq.demo;
  }

  function slackRequestRowHTML(r) {
    var seen = slackSeenMap();
    var unread = r.reply_count > 0 && r.latest_reply && (!seen[r.ts] || String(r.latest_reply) > String(seen[r.ts]));
    var stateBadge = r.state === "resolved"
      ? '<span class="gv-badge gv-ok">✓ resolved</span>'
      : '<span class="gv-badge gv-warn">open</span>';
    var bell = unread ? '<span class="abell" title="New replies since you last looked">new</span>' : "";
    var link = r.permalink || slackPermalink(r.channel, r.ts);
    var resolveBtn = r.state === "open"
      ? '<button class="btn small" type="button" data-slack-resolve="' + esc(r.ts) + '" data-slack-ch="' + esc(r.channel) + '">Mark resolved</button>'
      : "";
    var lines = String(r.text || "").split("\n");
    var firstLine = "";
    while (lines.length && !firstLine) firstLine = (lines.shift() || "").trim();
    return '<div class="card spost" data-ts="' + esc(r.ts) + '">' +
      '<div class="spost-top"><div class="spost-title">' + (firstLine ? slackMrkdwn(firstLine) : "Workflow request") + "</div></div>" +
      '<div class="spost-text">' + slackMrkdwn(lines.join("\n")) + "</div>" +
      '<div class="spost-meta">' + stateBadge + " " + bell + " · #" + esc(r.channelName || r.channel) + " · " + esc(slackWhen(r.ts)) +
        " · " + (r.reply_count || 0) + " repl" + (r.reply_count === 1 ? "y" : "ies") +
        (link ? ' · <a href="' + esc(link) + '" target="_blank" rel="noopener">Open in Slack ↗</a>' : "") + "</div>" +
      '<div class="spost-meta" style="margin-top:6px">' + resolveBtn + "</div>" +
      '<div class="atask-toggle" role="button" tabindex="0" data-slack-ts="' + esc(r.ts) + '" data-slack-ch="' + esc(r.channel) + '" aria-expanded="false">▸ Thread</div>' +
      '<div class="sthread" hidden></div></div>';
  }

  function renderSlackRequests() {
    var host = el("slack-req-body"); if (!host) return;
    var list = slackReq.list || [];
    var cnt = el("slack-req-count"); if (cnt) cnt.textContent = list.filter(function (r) { return r.state === "open"; }).length + " open";
    host.innerHTML = list.length
      ? list.map(slackRequestRowHTML).join("")
      : emptyStateHTML("bolt", "No requests reference this ticket", "Workflow submissions and posts that mention the ticket number show up here.");
    resize();
  }

  function loadSlackRequests(force) {
    var host = el("slack-req-body"); if (!host) return;
    Promise.resolve(settingsReady).then(function () {
      var mode = slackMode(), tid = state.ticketId;
      setText("slack-req-ticket", tid || "—");
      var key = mode + "|" + tid;
      if (slackReq.loadedKey === key && !force) { renderSlackRequests(); return; }
      if (mode === "demo") {
        slackReq.list = slackDemoRequests(tid);
        slackReq.loadedKey = key; renderSlackRequests(); return;
      }
      if (mode === "broker") { host.innerHTML = emptyStateHTML("bolt", "Requests need direct mode", "The broker path doesn’t expose channel history here."); resize(); return; }
      if (!force) { host.innerHTML = '<div class="card"><div class="skeleton" style="width:70%"></div><div class="skeleton" style="width:45%;margin-top:8px"></div></div>'; resize(); }
      var re = slackTicketRe(tid);
      var chIds = [slackCfg.channel].concat(slackCfg.homeChannels || [])
        .concat(slackPins().map(function (p) { return p.id; }))
        .concat(Object.keys(slackDir.starred || {}));
      chIds = chIds.filter(function (v, i) { return v && chIds.indexOf(v) === i; }).slice(0, 10);
      var teamP = slackDir.teamUrl ? Promise.resolve() : slackApi("auth.test", {}).then(function (a) {
        slackDir.team = (a && a.team_id) || slackDir.team; slackDir.teamUrl = (a && a.url) || "";
      }, function () {});
      teamP.then(function () {
        return Promise.all(chIds.map(function (cid) {
          return slackApi("conversations.history", { channel: cid, limit: 100 }).then(function (r) {
            return (((r && r.messages) || [])).filter(function (m) { return re.test(slackMsgText(m)); })
              .map(function (m) { return { ts: m.ts, channel: cid, channelName: slackChanName(cid).replace(/^#/, ""),
                text: slackMsgText(m), reply_count: m.reply_count || 0, latest_reply: m.latest_reply || "",
                reactions: m.reactions || [] }; });
          }, function () { return []; });
        }));
      }).then(function (lists) {
        var all = [];
        lists.forEach(function (l) { l.forEach(function (r) { all.push(r); }); });
        all.sort(function (a, b) { return parseFloat(b.ts) - parseFloat(a.ts); });
        all = all.slice(0, 15);
        // Reply-based resolution: only consulted when no ✅ reaction and the
        // thread has replies (bounded; cached per session in replyState).
        var toCheck = all.filter(function (r) {
          return !(r.reactions || []).some(function (x) { return RESOLVE_REACTIONS[x.name]; }) &&
                 r.reply_count > 0 && slackReq.replyState[r.ts] === undefined;
        }).slice(0, 8);
        return Promise.all(toCheck.map(function (r) {
          return slackApi("conversations.replies", { channel: r.channel, ts: r.ts, limit: 30 }).then(function (rr) {
            var resolved = (((rr && rr.messages) || [])).slice(1).some(function (m) { return RESOLVE_REPLY_RE.test(m.text || ""); });
            slackReq.replyState[r.ts] = resolved ? "resolved" : "open";
          }, function () { slackReq.replyState[r.ts] = "open"; });
        })).then(function () {
          all.forEach(function (r) { r.state = slackMsgState(r); });
          slackReq.list = all;
          slackReq.loadedKey = key;
          renderSlackRequests();
        });
      });
    });
  }

  function slackMarkResolved(btn) {
    var ts = btn.getAttribute("data-slack-resolve"), ch = btn.getAttribute("data-slack-ch");
    if (slackMode() === "demo") {
      (slackReq.list || []).forEach(function (r) { if (r.ts === ts) r.state = "resolved"; });
      renderSlackRequests(); return;
    }
    btn.disabled = true; btn.textContent = "Resolving…";
    slackApi("chat.postMessage", { channel: ch, thread_ts: ts,
      text: "✅ Resolved from the CX sidebar" + (state.ticketId ? " (ticket #" + state.ticketId + ")" : "") })
      .then(function () {
        slackReq.replyState[ts] = "resolved";
        (slackReq.list || []).forEach(function (r) { if (r.ts === ts) r.state = "resolved"; });
        renderSlackRequests();
      })
      .catch(function () { btn.disabled = false; btn.textContent = "Mark resolved"; });
  }

  // Keyword search over past requests. Preferred: search.messages via the
  // optional slack_search_token (user token, search:read — bot tokens can't
  // search). Any failure falls back to scanning the scoped channels' recent
  // history client-side, so the feature degrades instead of disappearing.
  function slackSearchApi(query) {
    return client.request({
      url: "https://slack.com/api/search.messages", type: "POST",
      headers: { Authorization: "Bearer {{setting.slack_search_token}}" },
      secure: true, cors: false, dataType: "json",
      contentType: "application/x-www-form-urlencoded",
      data: "query=" + encodeURIComponent(query) + "&count=20"
    }).then(function (r) {
      if (!r || r.ok !== true) throw new Error("Slack: " + ((r && r.error) || "search failed"));
      return r;
    });
  }
  function doSlackReqSearch() {
    var input = el("slack-req-search"), host = el("slack-req-body");
    if (!input || !host) return;
    var term = (input.value || "").trim();
    if (term.length < 2) { renderSlackRequests(); return; }
    var seq = ++slackReq.searchSeq;
    if (slackMode() !== "direct") {
      var q = term.toLowerCase();
      var hits = (slackReq.list || slackDemoRequests(state.ticketId)).filter(function (r) {
        return String(r.text || "").toLowerCase().indexOf(q) > -1;
      });
      host.innerHTML = hits.length ? '<div class="cmt-label">Search results</div>' + hits.map(slackRequestRowHTML).join("")
        : emptyStateHTML("search", "No requests matched", "Demo search covers the sample requests.");
      resize(); return;
    }
    host.innerHTML = '<div class="card"><div class="skeleton" style="width:60%"></div></div>'; resize();
    var chIds = [slackCfg.channel].concat(slackCfg.homeChannels || [])
      .concat(slackPins().map(function (p) { return p.id; }))
      .concat(Object.keys(slackDir.starred || {}));
    chIds = chIds.filter(function (v, i) { return v && chIds.indexOf(v) === i; }).slice(0, 10);
    var inScope = {}; chIds.forEach(function (c) { inScope[c] = 1; });
    function show(rows, label) {
      if (seq !== slackReq.searchSeq) return;
      host.innerHTML = rows.length
        ? '<div class="cmt-label">' + label + "</div>" + rows.map(slackRequestRowHTML).join("")
        : emptyStateHTML("search", "No messages matched", "The search covers the channels this install is scoped to.");
      resize();
    }
    slackSearchApi(term).then(function (r) {
      var rows = (((r.messages || {}).matches) || []).filter(function (m) {
        return m.channel && inScope[m.channel.id];
      }).slice(0, 15).map(function (m) {
        return { ts: m.ts, channel: m.channel.id, channelName: (m.channel.name || m.channel.id),
          text: m.text || "", reply_count: 0, latest_reply: "", reactions: [], state: "", permalink: m.permalink || "" };
      });
      rows.forEach(function (r2) { r2.state = slackReq.replyState[r2.ts] || ""; });
      show(rows, "Search results");
    }, function () {
      // Fallback sweep: recent history of the scoped channels, client-filtered.
      var q = term.toLowerCase();
      Promise.all(chIds.map(function (cid) {
        return slackApi("conversations.history", { channel: cid, limit: 100 }).then(function (r) {
          return (((r && r.messages) || [])).filter(function (m) {
            return slackMsgText(m).toLowerCase().indexOf(q) > -1;
          }).map(function (m) { return { ts: m.ts, channel: cid, channelName: slackChanName(cid).replace(/^#/, ""),
            text: slackMsgText(m), reply_count: m.reply_count || 0, latest_reply: m.latest_reply || "",
            reactions: m.reactions || [], state: "" }; });
        }, function () { return []; });
      })).then(function (lists) {
        var rows = [];
        lists.forEach(function (l) { l.forEach(function (r) { rows.push(r); }); });
        rows.sort(function (a, b) { return parseFloat(b.ts) - parseFloat(a.ts); });
        rows.forEach(function (r2) { r2.state = slackMsgState(r2); });
        show(rows.slice(0, 15), "Recent matches (history sweep)");
      });
    });
  }

  // Short-delay sync: refresh the request list + any expanded thread while the
  // Slack pane is actually being looked at (visible tab + active pane). 60s —
  // one shared bot token serves the whole fleet, so the cadence stays modest.
  function slackSyncTick() {
    if (document.hidden) return;
    var pane = el("pane-slack");
    if (!pane || !pane.classList.contains("active")) return;
    if (slackMode() !== "direct") return;
    var searching = ((el("slack-req-search") || {}).value || "").trim().length >= 2;
    // Re-rendering the list would collapse an expanded thread — the thread
    // loop below still refreshes those; the list catches up next quiet tick.
    var hasOpenThread = document.querySelector('#slack-req-body .atask-toggle[aria-expanded="true"]');
    if (!searching && !hasOpenThread) loadSlackRequests(true);
    Array.prototype.forEach.call(document.querySelectorAll('#pane-slack .atask-toggle[aria-expanded="true"][data-slack-ts]'), function (tog) {
      var box = tog.nextElementSibling;
      if (!box || !box.classList.contains("sthread")) return;
      // Never clobber a half-typed reply with a refresh.
      var draft = box.querySelector(".composer-input");
      if (draft && (draft.value || "").trim()) return;
      loadSlackThreadInto(tog, box);
    });
  }
  function startSlackSync() {
    if (slackReq.timer) return;
    slackReq.timer = setInterval(slackSyncTick, 60000);
  }

  // ── Per-feature handle-time (AHT v2) ──────────────────────────────────
  // Times the feature the agent is actually looking at on THIS ticket, so
  // Explore can report time-per-feature per ticket (aht_field_map → numeric
  // custom fields) and an optional collector receives per-flush deltas
  // (aht_endpoint). Correctness rules this implementation is built around:
  //
  //  • The clock runs only while the browser tab is visible AND this app
  //    instance is the foreground ticket. ZAF keeps deactivated sidebars
  //    resident and document.hidden reflects the whole browser tab, so the
  //    two states are tracked as separate flags — a visibilitychange can
  //    never un-pause a backgrounded ticket.
  //  • Dwell accumulates in milliseconds; rounding happens once at flush, so
  //    rapid tab flips neither double-bill nor vanish.
  //  • Field values are written as (boot baseline + session seconds): the
  //    baseline is the mapped fields' values read via ZAF at start, so a
  //    reopened ticket or a second agent adds to prior time instead of
  //    clobbering it. (Two truly simultaneous sessions still race on the
  //    shared baseline — the warehouse delta stream is the source of truth
  //    for overlap.)
  //  • Nothing is marked done until the network call resolves: field writes
  //    advance a per-feature written-seconds watermark and warehouse posts a
  //    posted-seconds watermark only on success, so any failure is retried
  //    on the next flush automatically. Flushes are serialized on a promise
  //    chain so an earlier slow PUT can't land after (and undo) a later one.
  //  • Flushing is event-driven (pane switch away is NOT a flush — but hide,
  //    deactivate, pagehide and app.willDestroy are) plus a 5-minute safety
  //    interval, keeping ticket audit noise far below a per-minute PUT.
  //  • aht_field_map entries are validated (known feature keys, digit-only
  //    field ids); bad entries are skipped with a console warning instead of
  //    poisoning the whole custom_fields PUT with a NaN id.
  var AHT_FLUSH_MS = 300000;
  // "summary" is the landing pane (member info + ticket digest); "context" is
  // the Account pane — the key predates the rename so existing installs'
  // aht_field_map entries keep working.
  var AHT_FEATURES = ["summary", "context", "asana_tasks", "asana_create", "asana_search", "slack", "guru"];
  var aht = {
    map: {}, mapErrors: [], endpoint: "", agent: "", bootId: "",
    dwellMs: {},           // feature → ms accumulated this session
    baseline: {},          // feature → seconds already on the ticket's fields at boot
    baselineReady: false,
    writtenSec: {},        // feature → session seconds confirmed written to ticket fields
    postedSec: {},         // feature → session seconds ACKed by the warehouse
    sentSec: {},           // feature → session seconds carried by any ISSUED warehouse POST
                           //   (ACKed or still in flight) — the beacon must never re-send
                           //   these; rolled back to postedSec when a POST fails in-frame
    seq: 0,                // flush sequence number (part of the idempotency key)
    active: null, sinceMs: 0,
    // deactivated starts TRUE: ZAF doesn't replay app.deactivated to late
    // listeners, so an instance backgrounded during boot would otherwise
    // bill forever. ZAF fires app.activated on load of the active ticket,
    // and any interaction with the iframe is proof of activity (fallback).
    hidden: false, deactivated: true,
    started: false, settingsLoaded: false,
    chain: Promise.resolve()
  };

  function ahtRunning() { return aht.started && !aht.hidden && !aht.deactivated; }

  function ahtFeature() {
    if (typeof guruZafModal !== "undefined" && guruZafModal.open) return "guru"; // centered ZAF reader is open
    var ov = el("guru-overlay");
    if (ov && !ov.hidden) return "guru"; // the pop-out covers whatever pane is under it
    var pane = (document.querySelector(".pane.active") || {}).id || "";
    pane = pane.replace(/^pane-/, "") || "summary"; // fallback = the landing pane
    if (pane === "asana") return "asana_" + (asubState.active === "request" ? "create" : (asubState.active === "other" ? "search" : "tasks"));
    return pane;
  }
  function ahtAccumulate() {
    var now = Date.now();
    if (ahtRunning() && aht.active) {
      var dt = now - aht.sinceMs;
      if (dt > 0) aht.dwellMs[aht.active] = (aht.dwellMs[aht.active] || 0) + dt;
    }
    aht.sinceMs = now;
  }
  function ahtSessionSec(f) { return Math.round((aht.dwellMs[f] || 0) / 1000); }
  function ahtDebug() {
    var dwell = {};
    Object.keys(aht.dwellMs).forEach(function (f) { dwell[f] = ahtSessionSec(f); });
    window.__aht = { dwell: dwell, active: aht.active, running: ahtRunning(),
      mapped: Object.keys(aht.map), mapErrors: aht.mapErrors, baseline: aht.baseline,
      written: aht.writtenSec, posted: aht.postedSec, sent: aht.sentSec };
  }
  function ahtSwitch() { if (!aht.started) return; ahtAccumulate(); aht.active = ahtFeature(); ahtDebug(); }
  function ahtSetHidden(h) { if (!aht.started || aht.hidden === h) return; ahtAccumulate(); aht.hidden = h; if (h) flushAht("hide"); ahtDebug(); }
  function ahtSetDeactivated(d) { if (!aht.started || aht.deactivated === d) return; ahtAccumulate(); aht.deactivated = d; if (d) flushAht("deactivate"); ahtDebug(); }

  // Baseline: read the mapped fields' current values through ZAF (no REST
  // call, no ticket audit event) so this session adds instead of overwriting.
  // If the read fails twice, field writes stay OFF for this session — writing
  // session-only values would destroy the ticket's accumulated totals, which
  // is worse than skipping one session (warehouse deltas still flow).
  function ahtLoadBaseline(attempt) {
    var keys = Object.keys(aht.map);
    if (!client || !keys.length) { aht.baselineReady = true; return Promise.resolve(); }
    var paths = keys.map(function (f) { return "ticket.customField:custom_field_" + aht.map[f]; });
    return client.get(paths).then(function (d) {
      keys.forEach(function (f, i) {
        var n = parseInt(d && d[paths[i]], 10);
        aht.baseline[f] = (isNaN(n) || n < 0) ? 0 : n;
      });
      aht.baselineReady = true; ahtDebug();
    }).catch(function () {
      if (!attempt) return new Promise(function (res) { setTimeout(res, 2000); }).then(function () { return ahtLoadBaseline(1); });
      try { console.warn("[AHT] couldn't read existing field values — field writes disabled this session to avoid clobbering prior totals"); } catch (e) {}
    });
  }

  function parseAhtMap(raw) {
    var m = {}, errs = [];
    String(raw || "").split(",").forEach(function (p) {
      if (!p.trim()) return;
      var i = p.indexOf(":");
      if (i < 0) { errs.push("'" + p.trim() + "' has no ':'"); return; }
      var k = p.slice(0, i).trim(), v = p.slice(i + 1).trim();
      if (AHT_FEATURES.indexOf(k) < 0) { errs.push("'" + k + "' is not a feature key (use " + AHT_FEATURES.join("/") + ")"); return; }
      if (!/^\d+$/.test(v)) { errs.push("'" + k + ":" + v + "' — field id must be digits only"); return; }
      if (m[k]) errs.push("'" + k + "' mapped twice; keeping " + v);
      m[k] = v;
    });
    if (errs.length) { try { console.warn("[AHT] aht_field_map problems (entries skipped): " + errs.join("; ")); } catch (e) {} }
    return { map: m, errors: errs };
  }

  function ahtWarehousePayload(deltas, reason) {
    aht.seq += 1;
    return { ticket_id: state.ticketId, agent: aht.agent, at: new Date().toISOString(),
      seq: aht.seq, idempotency_key: (state.ticketId || "t") + ":" + aht.bootId + ":" + aht.seq,
      seconds: deltas, reason: reason };
  }

  // One serialized write pass. Watermarks advance only on confirmed success,
  // so failed writes are re-attempted with fresh totals on the next flush.
  function ahtWrite(reason) {
    var jobs = [];
    if (client && state.ticketId && aht.settingsLoaded && aht.baselineReady) {
      var fields = [];
      Object.keys(aht.map).forEach(function (f) {
        var sess = ahtSessionSec(f);
        if (sess > (aht.writtenSec[f] || 0)) fields.push({ id: Number(aht.map[f]), value: (aht.baseline[f] || 0) + sess, feature: f, sess: sess });
      });
      if (fields.length) {
        jobs.push(client.request({ url: "/api/v2/tickets/" + encodeURIComponent(state.ticketId) + ".json", type: "PUT",
          contentType: "application/json",
          data: JSON.stringify({ ticket: { custom_fields: fields.map(function (x) { return { id: x.id, value: x.value }; }) } }) })
          .then(function () {
            fields.forEach(function (x) { if (x.sess > (aht.writtenSec[x.feature] || 0)) aht.writtenSec[x.feature] = x.sess; });
            ahtDebug();
          })
          .catch(function () {})); // watermark untouched → retried next flush
      }
    }
    if (client && aht.endpoint) {
      var deltas = {}, marks = {};
      AHT_FEATURES.forEach(function (f) {
        var sess = ahtSessionSec(f), d = sess - (aht.postedSec[f] || 0);
        if (d > 0) { deltas[f] = d; marks[f] = sess; }
      });
      if (Object.keys(deltas).length) {
        // Record what this POST carries at ISSUE time so the pagehide beacon
        // never re-sends seconds already on the wire (an in-flight POST at
        // teardown would otherwise be double-delivered under a fresh key).
        Object.keys(marks).forEach(function (f) { if (marks[f] > (aht.sentSec[f] || 0)) aht.sentSec[f] = marks[f]; });
        jobs.push(client.request({ url: aht.endpoint, type: "POST", secure: true, contentType: "application/json",
          data: JSON.stringify(ahtWarehousePayload(deltas, reason)) })
          .then(function () {
            Object.keys(marks).forEach(function (f) { if (marks[f] > (aht.postedSec[f] || 0)) aht.postedSec[f] = marks[f]; });
            ahtDebug();
          })
          .catch(function () {
            // ACK watermark untouched → the chain re-sends this delta next
            // flush; roll the issue watermark back so a later beacon can
            // also carry it (the failure arrived in-frame, so nothing is on
            // the wire anymore).
            Object.keys(marks).forEach(function (f) { aht.sentSec[f] = aht.postedSec[f] || 0; });
          }));
      }
    }
    return Promise.all(jobs);
  }
  function flushAht(reason) {
    ahtAccumulate(); ahtDebug();
    if (!client) return aht.chain;
    aht.chain = aht.chain.then(function () { return ahtWrite(reason || "interval"); }).catch(function () {});
    return aht.chain;
  }

  function startAht() {
    if (aht.started) return;
    aht.started = true;
    aht.bootId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    aht.hidden = !!document.hidden;   // a background-tab boot starts paused
    aht.active = ahtFeature();
    aht.sinceMs = Date.now();
    document.addEventListener("visibilitychange", function () { ahtSetHidden(!!document.hidden); });
    window.addEventListener("pagehide", function () {
      ahtAccumulate();
      // Final best-effort delivery: the proxied requests may not survive
      // unload, so the warehouse leg also goes out as a beacon (text/plain
      // to avoid a CORS preflight; the payload carries no secrets). The
      // idempotency key makes the beacon + flush pair collapsible downstream.
      if (aht.endpoint && navigator.sendBeacon) {
        var deltas = {}, marks = {};
        AHT_FEATURES.forEach(function (f) {
          var s = ahtSessionSec(f);
          // Exclude anything ACKed OR already issued (possibly in flight):
          // during teardown an in-flight POST's .then can never run, so the
          // ACK watermark alone would double-deliver those seconds.
          var base = Math.max(aht.postedSec[f] || 0, aht.sentSec[f] || 0);
          var d = s - base;
          if (d > 0) { deltas[f] = d; marks[f] = s; }
        });
        if (Object.keys(deltas).length) {
          try {
            if (navigator.sendBeacon(aht.endpoint, JSON.stringify(ahtWarehousePayload(deltas, "pagehide")))) {
              Object.keys(marks).forEach(function (f) {
                if (marks[f] > (aht.postedSec[f] || 0)) aht.postedSec[f] = marks[f];
                if (marks[f] > (aht.sentSec[f] || 0)) aht.sentSec[f] = marks[f];
              });
            }
          } catch (e) {}
        }
      }
      flushAht("pagehide");
    });
    if (client && client.on) {
      try {
        client.on("app.deactivated", function () { ahtSetDeactivated(true); });
        client.on("app.activated", function () { ahtSetDeactivated(false); });
        client.on("app.willDestroy", function () { flushAht("destroy"); });
      } catch (e) {}
      try { client.get("currentUser.email").then(function (d) { aht.agent = (d && d["currentUser.email"]) || ""; }).catch(function () {}); } catch (e) {}
    }
    // Interaction is proof of activity — covers any surface where ZAF doesn't
    // fire app.activated on load (the clock starts pessimistically paused).
    ["click", "keydown"].forEach(function (evt) {
      document.addEventListener(evt, function () { if (aht.deactivated) ahtSetDeactivated(false); }, true);
    });
    setInterval(function () { flushAht("interval"); }, AHT_FLUSH_MS);
    ahtDebug();
  }

  // ── Guru pane v2 (knowledge sidebar) ──────────────────────────────────
  // Four sub-views: Suggested (cards matched from the ticket's reason code +
  // tags, subject opt-in), Search (debounced, collection filter), Browse
  // (collections → folders → cards) and Recents (+ locally pinned cards).
  // Cards open in the pop-out reader: verification state + verify/unverify,
  // insert-into-reply / copy-with-formatting, and comments (list + post).
  // All Guru calls ride Zendesk's secure proxy (Authorization: Basic
  // {{setting.guru_auth}}); with no reason-code field configured the whole
  // pane runs on sample data. The only free text sent to Guru: agent search
  // terms, card comments, and — only when guru_suggest_subject is enabled —
  // the ticket subject.
  var guruCfg = { reasonField: "", suggestSubject: false, suggestTags: false, defaultCollection: "", aiAnswers: true, agentId: "", debug: false };
  var guruState = { loaded: false, card: null, tagged: false, watching: false, view: "suggested",
    collections: null, collectionsP: null, crumbs: [], searchTimer: null };

  function guruMode() { return guruCfg.reasonField ? "live" : "demo"; }
  // Cold-start serialization for the Guru tab. On first open the tab fans out
  // several secure-proxy requests at once (the AI answer + up to 3 suggested
  // searches + collections); when the agent's Zendesk session needs re-auth,
  // EACH in-flight proxied request pops its own login prompt — the "log in 5-6
  // times when I open Guru" friction. Elect a single "leader" request to warm
  // the session; any request that begins while a leader is in flight waits for
  // it to settle, then dispatches. The leader clears on settle, so a lone
  // steady-state call dispatches immediately (no added latency) and a later
  // re-auth burst is coalesced the same way. Applies to every Guru call because
  // they all funnel through here.
  var guruLeader = null;
  function guruDispatch(req) {
    if (guruLeader) {
      var after = function () { return client.request(req); };
      return guruLeader.then(after, after); // wait for the warm-up, ok or error
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
    var _prom = guruDispatch(req);                  // cold-start serialization (see guruDispatch)
    if (!guruCfg.debug) return _prom;               // off: raw promise, zero overhead
    return _prom.then(function (r) {
      guruLog(_m, _p, _sub, "ok", r, null);
      return r;                                     // pass the parsed body straight through
    }, function (e) {
      guruLog(_m, _p, _sub, "err", null, e);
      throw e;                                       // re-throw the SAME ZAF error so callers' .catch is unaffected
    });
  }
  // Debug-only. Receives ONLY method/path/subtype + response body (ok) or ZAF error (err).
  // NEVER receives req, req.headers (the Authorization: Basic {{setting.guru_auth}} value),
  // or req.data — so no credential and no request payload can be logged. Never throws.
  function guruLog(method, path, subtype, phase, body, err) {
    try {
      if (!window.__guruDebug) window.__guruDebug = [];
      window.__guruDebug.push({
        t: new Date().toISOString(), method: method, path: path, subtype: subtype || "", phase: phase,
        status: (err && err.status) || (phase === "ok" ? 200 : 0),
        body: (phase === "ok" ? body : null),
        error: (phase === "err" && err) ? { status: err.status, responseJSON: err.responseJSON, responseText: err.responseText, message: err.message } : null
      });
      while (window.__guruDebug.length > 50) window.__guruDebug.shift();
      var label = "[GURU] " + method + " " + path + (subtype ? " (" + subtype + ")" : "") + "  " + (phase === "ok" ? "✓ OK" : "✗ ERR " + ((err && err.status) || ""));
      var g = window.console || {};
      (g.groupCollapsed ? g.groupCollapsed : g.log).call(g, label);
      if (phase === "ok") { g.log(JSON.stringify(body, null, 2)); }
      else { g.log("status:", (err && err.status)); g.log(err && (err.responseJSON ? JSON.stringify(err.responseJSON, null, 2) : (err.responseText || err.message || "request failed"))); }
      if (g.groupEnd) g.groupEnd();
    } catch (x) { /* logging must never break the request flow */ }
  }
  // Guru card bodies are trusted internal HTML, but strip scripts/handlers
  // defensively. URL-bearing attributes (href, xlink:href, src, ...) are
  // scheme-checked after stripping the control chars/whitespace browsers
  // strip before resolving a URL — a bare /^javascript:/ test misses
  // "\tjavascript:" and never sees xlink:href at all.
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

  function guruReasonCode() {
    if (guruMode() === "demo") return Promise.resolve("ELIGIBILITY_DISPUTE");
    if (!client || !guruCfg.reasonField) return Promise.resolve("");
    var key = "ticket.customField:custom_field_" + guruCfg.reasonField;
    return client.get(key).then(function (d) { return (d && d[key] != null) ? String(d[key]) : ""; }).catch(function () { return ""; });
  }
  // Demo knowledge base (used whenever guru_reason_field is blank).
  var GURU_DEMO_CARDS = [
    { id: "guru-demo-1", title: "Handling ELIGIBILITY_DISPUTE requests (sample)", verificationState: "TRUSTED",
      collection: "CX Playbooks", collectionId: "col-cx", lastVerified: "12d ago", verifier: "Dana W.",
      content: "<p>This is a <strong>sample Guru card</strong> matched to the ticket's reason code.</p>" +
        "<h3>Steps</h3><ol><li>Confirm the member's eligibility in the portal.</li>" +
        "<li>Re-pull the EOB if the deductible looks off.</li>" +
        "<li>Escalate to the Eligibility team if unresolved within 1 business day.</li></ol>" +
        "<p>Open a cross-functional request from the <em>Asana &rsaquo; Create</em> tab if another team needs to act.</p>" },
    { id: "guru-demo-2", title: "Re-pulling an EOB when the deductible looks off (sample)", verificationState: "TRUSTED",
      collection: "CX Playbooks", collectionId: "col-cx", lastVerified: "30d ago", verifier: "Priya S.",
      content: "<p>When the member's EOB shows an unexpected deductible, re-pull it from the payer portal before assuming a claims error.</p>" +
        "<ol><li>Portal → Claims → Re-request EOB.</li><li>Compare plan year and network tier.</li><li>If the numbers still disagree, open a Claims review.</li></ol>" },
    { id: "guru-demo-3", title: "Escalating to the Claims team (sample)", verificationState: "NEEDS_VERIFICATION",
      collection: "Ops", collectionId: "col-ops", lastVerified: "95d ago", verifier: "",
      content: "<p>Claims escalations go through the <em>Asana &rsaquo; Create</em> form with the <strong>Claims</strong> team selected. Include the claim ID and the member-facing summary.</p>" }
  ];
  var GURU_DEMO_TREE = {
    collections: [{ id: "col-cx", name: "CX Playbooks" }, { id: "col-ops", name: "Ops" }],
    folders: { "col-cx": [{ id: "fol-elig", title: "Eligibility" }, { id: "fol-claims", title: "Claims" }], "col-ops": [{ id: "fol-esc", title: "Escalations" }] },
    items: { "fol-elig": ["guru-demo-1", "guru-demo-2"], "fol-claims": ["guru-demo-2"], "fol-esc": ["guru-demo-3"] }
  };
  function demoGuruCardById(id) {
    for (var i = 0; i < GURU_DEMO_CARDS.length; i++) if (GURU_DEMO_CARDS[i].id === id) return GURU_DEMO_CARDS[i];
    return GURU_DEMO_CARDS[0];
  }

  // Tolerant mapping of the varying Guru card shapes (search hit, /cards,
  // /cards/{id}/extended, demo) into one render-ready object.
  function normalizeGuruCard(c, fallbackId) {
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
      collectionId: (c.collection && typeof c.collection === "object" && c.collection.id) || c.collectionId || "",
      slug: c.slug || "" };
  }
  function guruHits(r) {
    var arr = (r && (r.cards || r.results)) || (Array.isArray(r) ? r : []);
    return arr.map(function (h) { return normalizeGuruCard(h.card || h, h && h.id); }).filter(function (c) { return c.id; });
  }
  function guruTimeAgoDays(v) {
    if (!v) return "";
    if (!/\d{4}-/.test(String(v))) return String(v); // demo strings pass through
    var d = Math.floor((Date.now() - new Date(v).getTime()) / 86400000);
    if (isNaN(d) || d < 0) return "";
    return d === 0 ? "today" : d + "d ago";
  }
  function guruVerifiedBadge(c) {
    if (c.verificationState === "TRUSTED") return '<span class="gv-badge gv-ok">✓ Verified</span>';
    if (c.verificationState) return '<span class="gv-badge gv-warn">⚠ Needs verification</span>';
    return "";
  }

  // Recents + pins are per-agent, local to this browser — Guru's public API
  // has no favorites write, so pins deliberately stay local.
  function guruLS(key) { try { return JSON.parse(localStorage.getItem(key)) || []; } catch (e) { return []; } }
  function guruSaveLS(key, arr) { try { localStorage.setItem(key, JSON.stringify(arr)); } catch (e) {} }
  function guruRecents() { return guruLS("cxsidebar.guru.recents"); }
  function guruPins() { return guruLS("cxsidebar.guru.pins"); }
  function guruIsPinned(id) { return guruPins().some(function (p) { return p.id === id; }); }
  function guruRemember(card) {
    var rec = guruRecents().filter(function (r) { return r.id !== card.id; });
    rec.unshift({ id: card.id, title: card.title, ts: Date.now() });
    guruSaveLS("cxsidebar.guru.recents", rec.slice(0, 20));
  }
  function guruTogglePin(id, title) {
    var pins = guruPins();
    var next = pins.filter(function (p) { return p.id !== id; });
    var nowPinned = next.length === pins.length; // nothing removed → add it
    if (nowPinned) next.unshift({ id: id, title: title });
    guruSaveLS("cxsidebar.guru.pins", next);
    return nowPinned;
  }
  function guruPinBtnHTML(id, title) {
    var pinned = guruIsPinned(id);
    return '<button class="btn icon guru-pin' + (pinned ? " pinned" : "") + '" type="button" data-guru-pin="' + esc(id) + '" data-guru-title="' + esc(title) + '" title="' + (pinned ? "Unpin" : "Pin (saved locally to this browser)") + '">' + (pinned ? "★" : "☆") + "</button>";
  }

  function guruRowHTML(c, why) {
    return '<div class="guru-row">' +
      '<button class="guru-row-main" type="button" data-guru-open="' + esc(c.id) + '" data-guru-title="' + esc(c.title) + '">' +
        '<span class="guru-row-title">' + esc(c.title) + "</span>" +
        '<span class="guru-row-meta">' + guruVerifiedBadge(c) +
          (c.collection ? '<span class="guru-row-col">' + esc(c.collection) + "</span>" : "") +
          (why ? '<span class="guru-row-why">' + esc(why) + "</span>" : "") + "</span>" +
      "</button>" + guruPinBtnHTML(c.id, c.title) + "</div>";
  }
  function guruRowsHTML(cards, emptyTitle, emptySub, emptyIcon) {
    return cards.length ? cards.map(function (c) { return guruRowHTML(c, c.why); }).join("")
      : emptyStateHTML(emptyIcon || "doc", emptyTitle, emptySub || "");
  }

  // The pop-out reader: trust bar + compose-assist actions + content + comments.
  function guruCardHTML(card) {
    var trusted = card.verificationState === "TRUSTED";
    var vAction = trusted
      ? '<button class="btn small" type="button" data-guru-verify="0" data-card="' + esc(card.id) + '">Unverify</button>'
      : '<button class="btn small primary" type="button" data-guru-verify="1" data-card="' + esc(card.id) + '">Verify</button>';
    var vWhen = card.lastVerified ? " · " + esc(guruTimeAgoDays(card.lastVerified)) : "";
    var vWho = card.verifier ? " by " + esc(card.verifier) : "";
    // Deep link into the Guru web app — only when the API gave us a slug (live).
    var openLink = (guruMode() === "live" && card.slug)
      ? '<a class="btn small" href="https://app.getguru.com/card/' + esc(card.slug) + '" target="_blank" rel="noopener">Open in Guru ↗</a>'
      : "";
    return '<div class="guru-card">' +
      '<div class="guru-vbar"><span class="guru-vbar-state">' + (guruVerifiedBadge(card) || '<span class="gv-badge gv-warn">Verification unknown</span>') + vWhen + vWho + "</span>" + vAction + "</div>" +
      '<div class="guru-actions">' +
        '<button class="btn primary" type="button" data-guru-insert="' + esc(card.id) + '">Insert into reply</button>' +
        '<button class="btn" type="button" data-guru-copy="' + esc(card.id) + '">Copy</button>' +
        openLink + guruPinBtnHTML(card.id, card.title) + "</div>" +
      '<div class="guru-hint" id="guru-action-hint"></div>' +
      '<div class="guru-content">' + safeGuruContent(card.content) + "</div>" +
      '<div class="guru-cmt"><div class="cmt-label">Card comments</div>' +
      '<div class="cmt-list" id="guru-cmt-list"><div class="skeleton" style="width:60%"></div></div>' +
      '<textarea class="composer-input guru-cmt-input" placeholder="Leave a comment on this Guru card…"></textarea>' +
      '<div class="composer-row"><span class="composer-hint">Posts a comment to the Guru card</span>' +
      '<button class="btn primary guru-cmt-send" type="button" data-card="' + esc(card.id) + '">Comment</button></div></div></div>';
  }

  // "guru_used" ticket tag for Zendesk analytics — fired once when the card is shown live.
  function tagGuruUsed() {
    if (guruState.tagged || !client || guruMode() !== "live" || !state.ticketId) return;
    guruState.tagged = true;
    try {
      client.request({ url: "/api/v2/tickets/" + state.ticketId + ".json", type: "PUT", contentType: "application/json",
        data: JSON.stringify({ ticket: { additional_tags: ["guru_used"] } }) });
    } catch (e) {}
  }

  function initGuru(force) {
    if (guruState.loaded && !force) return;
    guruState.loaded = true;
    // Settings decide demo vs live — never latch a mode before they resolve
    // (a fast first click on the Guru tab would otherwise show sample data
    // in a live-configured install for the rest of the session).
    Promise.resolve(settingsReady).then(function () {
      var note = el("guru-sample-note"); if (note) note.hidden = guruMode() !== "demo";
      loadGuruSuggested();
      // Collections are only needed by Browse and the Search filter — load them
      // lazily there (see switchGsub) so they aren't part of the Guru tab's
      // cold-start request burst (fewer concurrent proxy calls = fewer re-auth
      // prompts). loadGuruCollections caches, so the lazy call is a one-time fetch.
      // Re-resolve suggestions when the reason-code field changes on the ticket.
      if (!guruState.watching && client && client.on && guruMode() === "live") {
        guruState.watching = true;
        try { client.on("ticket.custom_field_" + guruCfg.reasonField + ".changed", function () { loadGuruSuggested(true); }); } catch (e) {}
      }
    });
  }

  function switchGsub(name) {
    guruState.view = name;
    Array.prototype.forEach.call(document.querySelectorAll("#guru-subtabs .subtab"), function (b) {
      b.classList.toggle("active", b.getAttribute("data-gsub") === name);
    });
    Array.prototype.forEach.call(document.querySelectorAll("#pane-guru .gsub"), function (p) {
      p.classList.toggle("active", p.id === "gsub-" + name);
    });
    if (name === "browse") initGuruBrowse();
    else if (name === "recents") renderGuruRecents();
    else if (name === "search") { loadGuruCollections(); var si = el("guru-search-input"); if (si) { try { si.focus(); } catch (e) {} } }
    resize();
  }

  // ── Ask Guru AI (POST /v1/answers) ────────────────────────────────────
  // A synthesized answer with cited source cards, seeded from the ticket's
  // reason code (the same value we already send to Guru search — no new data
  // category egresses; the ticket subject is only appended when the existing
  // guru_suggest_subject opt-in is on). Degrades quietly: if the org has no
  // Guru AI (401/403/404), the panel retires itself and the card suggestions
  // below carry the view. Response shape confirmed against Guru's OpenAPI
  // spec: Answer = { answer: string, sources: Document[] }; each Document is a
  // discriminated union on documentType (GURU card | SOURCE | WEB | MCP), all
  // carrying id/title/url/verificationState. Only GURU docs are openable cards
  // — the rest render as links. Parser stays tolerant for endpoint variants.
  function guruHumanize(code) { return String(code || "").replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase(); }
  function guruAnswerQuestion(reason, subject) {
    var r = guruHumanize(reason);
    var base = r ? ("How do I handle: " + r + "?") : "";
    if (subject) base = (base ? base + " " : "") + "(ticket: " + subject + ")";
    return base.trim();
  }

  function guruAnswerParse(r) {
    r = r || {};
    var a = r.answer;
    var obj = (a && typeof a === "object") ? a : r;
    var text = (typeof a === "string" && a) ||
      obj.answer || obj.text || obj.markdown || obj.html || obj.content || obj.response || obj.body || "";
    if (typeof text !== "string") text = "";
    var rawSources = obj.sources || obj.sourceRecords || obj.records || obj.references || obj.cards || r.sources || r.sourceRecords || [];
    if (!Array.isArray(rawSources)) rawSources = [];
    var sources = rawSources.map(function (s) {
      s = s || {};
      var card = s.card || s;
      var dt = String(s.documentType || card.documentType || "").toUpperCase();
      var id = card.id || s.cardId || s.externalId || s.factId || "";
      // Every source Document carries an id, so "has id" can't distinguish a
      // Guru card from a WEB/SOURCE citation — use documentType. Only GURU(_ATTACHMENT)
      // docs are openable cards; WEB/SOURCE/MCP render as external links.
      var isCard = dt ? (dt === "GURU" || dt === "GURU_ATTACHMENT") : (!!id && !(s.url || card.url));
      return {
        id: isCard ? id : "",
        title: card.title || card.preferredPhrase || s.title || s.name || "Source",
        url: s.url || card.url || card.slug || "",
        verificationState: String(card.verificationState || s.verificationState || "").toUpperCase()
      };
    }).filter(function (s) { return s.id || s.url; });
    return { text: text, sources: sources };
  }

  // Trusted-internal answer HTML → sanitize; plain/markdown → escape + light
  // paragraph/bullet formatting (never inject unescaped model text).
  function guruAnswerHTML(text) {
    if (/<[a-z][\s\S]*>/i.test(text)) return safeGuruContent(text);
    var blocks = esc(text).split(/\n{2,}/);
    return blocks.map(function (b) {
      var lines = b.split(/\n/);
      var bullets = lines.filter(function (l) { return /^\s*[-*•]\s+/.test(l); });
      if (bullets.length && bullets.length === lines.length) {
        return "<ul>" + lines.map(function (l) { return "<li>" + l.replace(/^\s*[-*•]\s+/, "") + "</li>"; }).join("") + "</ul>";
      }
      return "<p>" + b.replace(/\n/g, "<br>") + "</p>";
    }).join("");
  }

  function guruSourceRowHTML(s) {
    if (s.id) {
      return '<div class="guru-row">' +
        '<button class="guru-row-main" type="button" data-guru-open="' + esc(s.id) + '" data-guru-title="' + esc(s.title) + '">' +
          '<span class="guru-row-title">' + esc(s.title) + "</span>" +
          (s.verificationState ? '<span class="guru-row-meta">' + guruVerifiedBadge(s) + "</span>" : "") +
        "</button>" + guruPinBtnHTML(s.id, s.title) + "</div>";
    }
    return '<div class="guru-row"><a class="guru-row-main guru-row-link" href="' + esc(s.url) + '" target="_blank" rel="noopener"><span class="guru-row-title">' + esc(s.title) + " ↗</span></a></div>";
  }

  function renderGuruAnswer(text, sources) {
    var body = el("guru-answer-body"); if (!body) return;
    var srcHTML = (sources && sources.length)
      ? '<div class="guru-answer-sources"><div class="cmt-label">Sources</div>' + sources.map(guruSourceRowHTML).join("") + "</div>"
      : "";
    body.innerHTML = '<div class="guru-answer"><div class="guru-ai-badge">✦ Guru AI</div>' +
      '<div class="guru-answer-text">' + guruAnswerHTML(text || "No answer text returned.") + "</div>" + srcHTML + "</div>";
    resize();
  }

  function guruDemoAnswer() {
    return {
      text: "<p>For an <strong>eligibility dispute</strong>, confirm the member's active coverage in the portal first, then re-pull the EOB if the deductible looks wrong. Escalate to the Eligibility team only when it's unresolved within one business day.</p><p><em>Sample AI answer — connect Guru to see live answers.</em></p>",
      sources: [normalizeGuruCard(GURU_DEMO_CARDS[0]), normalizeGuruCard(GURU_DEMO_CARDS[1])]
    };
  }

  function loadGuruAnswer(question) {
    var panel = el("guru-ask"), body = el("guru-answer-body"); if (!panel || !body) return;
    var q = (question || "").trim();
    guruState.lastQuestion = q;
    if (!q) { body.innerHTML = ""; resize(); return; }
    body.innerHTML = '<div class="guru-answer"><div class="guru-ai-badge">✦ Guru AI</div><div class="guru-answer-text"><div class="skeleton" style="width:85%"></div><div class="skeleton" style="width:65%;margin-top:6px"></div></div></div>';
    resize();
    if (guruMode() === "demo") { var d = guruDemoAnswer(); renderGuruAnswer(d.text, d.sources); return; }
    var seq = guruState.answerSeq = (guruState.answerSeq || 0) + 1;
    var reqBody = { question: q };
    if (guruCfg.agentId) reqBody.agentId = guruCfg.agentId;
    guruApi("/answers", { type: "POST", data: reqBody, subtype: "sidebar-ask" })
      .then(function (r) {
        if (seq !== guruState.answerSeq) return;
        var parsed = guruAnswerParse(r);
        if (!parsed.text && !parsed.sources.length) {
          body.innerHTML = '<div class="guru-answer"><div class="empty">No answer from Guru AI — try rephrasing, or use the cards below.</div></div>'; resize(); return;
        }
        renderGuruAnswer(parsed.text, parsed.sources);
      })
      .catch(function (e) {
        if (seq !== guruState.answerSeq) return;
        var st = e && (e.status || (e.responseJSON && e.responseJSON.status));
        if (st === 401 || st === 403 || st === 404 || st === 501) { // Guru AI not enabled/permitted → retire the panel
          guruState.aiDisabled = true; panel.hidden = true; resize(); return;
        }
        body.innerHTML = '<div class="guru-answer error"><p>Couldn’t reach Guru AI: ' + esc(reqErr ? reqErr(e) : (e && e.message)) + '</p><button class="btn small guru-ask-retry" type="button">Retry</button></div>'; resize();
      });
  }

  // Show/seed the Ask panel and auto-answer once per (reason+subject) so a
  // reason-code change re-answers but a plain re-render doesn't.
  function maybeRunGuruAnswer(reason, subject) {
    var panel = el("guru-ask"); if (!panel) return;
    var showAsk = guruMode() === "demo" || (guruCfg.aiAnswers && !guruState.aiDisabled);
    panel.hidden = !showAsk;
    if (!showAsk) return;
    var subj = guruCfg.suggestSubject ? (subject || "") : "";
    var effReason = reason || (guruMode() === "demo" ? "ELIGIBILITY_DISPUTE" : "");
    if (!effReason && !subj) return; // nothing to seed; manual Ask still works
    var q = guruAnswerQuestion(effReason, subj);
    var input = el("guru-ask-input");
    if (input && !(input.value || "").trim()) input.value = q;
    var key = guruMode() + "|" + effReason + "|" + subj;
    if (key !== guruState.answeredKey) {
      guruState.answeredKey = key;
      loadGuruAnswer((input && input.value) || q);
    }
  }

  // 1) Suggested — an AI answer (above) plus contextual card suggestions from
  // ticket-signal-driven searches: reason code first (the original card
  // seam), then ticket tags, then the subject when guru_suggest_subject is
  // on. (Guru's public API has no suggest endpoint; the GQL tag-query seam
  // still applies once a reason-code → Guru Tag ID mapping exists.)
  function loadGuruSuggested(force) {
    var host = el("guru-suggested-body"); if (!host) return;
    host.innerHTML = '<div class="card"><div class="skeleton" style="width:70%"></div><div class="skeleton" style="width:50%;margin-top:8px"></div></div>';
    guruReasonCode().then(function (reason) {
      setText("guru-reason", reason || "—");
      if (guruMode() === "demo") {
        maybeRunGuruAnswer(reason, "");
        var rows = GURU_DEMO_CARDS.map(function (c, i) { var d = normalizeGuruCard(c); d.why = i === 0 ? "reason code" : "ticket tags"; return d; });
        host.innerHTML = guruRowsHTML(rows, "No sample cards", "", "spark"); resize(); return;
      }
      var queries = [];
      if (reason) queries.push({ term: reason, why: "reason code" });
      // Tags are a NEW egress vs the prior version (which only ever sent the
      // reason code), so they're opt-in like the subject.
      var tagTerm = guruCfg.suggestTags ? (state.tags || []).slice(0, 5).join(" ").trim() : "";
      if (tagTerm) queries.push({ term: tagTerm, why: "ticket tags" });
      var subjectP = (guruCfg.suggestSubject && client)
        ? client.get("ticket.subject").then(function (d) { return String((d && d["ticket.subject"]) || "").trim(); }).catch(function () { return ""; })
        : Promise.resolve("");
      subjectP.then(function (subject) {
        maybeRunGuruAnswer(reason, subject);
        if (subject) queries.push({ term: subject, why: "subject" });
        if (!queries.length) { host.innerHTML = emptyStateHTML("spark", "Nothing to suggest from yet", "No reason code or tags on this ticket — try Search."); resize(); return; }
        Promise.all(queries.map(function (q) {
          return guruApi("/search/query?searchTerms=" + encodeURIComponent(q.term) + "&maxResults=5", { subtype: "sidebar-suggest" })
            .then(function (r) { return { why: q.why, cards: guruHits(r) }; })
            .catch(function () { return { why: q.why, cards: [] }; });
        })).then(function (groups) {
          var seen = {}, rows = [];
          groups.forEach(function (g) { g.cards.forEach(function (c) { if (!seen[c.id]) { seen[c.id] = 1; c.why = g.why; rows.push(c); } }); });
          if (guruCfg.defaultCollection) rows.sort(function (a, b) {
            return (b.collectionId === guruCfg.defaultCollection ? 1 : 0) - (a.collectionId === guruCfg.defaultCollection ? 1 : 0);
          });
          host.innerHTML = guruRowsHTML(rows.slice(0, 8), "No matching Guru cards", "Try Search or Browse.", "spark");
          resize();
        });
      });
    });
  }

  // Shared collections cache (search filter dropdown + browse root). Only a
  // successful non-empty fetch is cached — a transient failure would
  // otherwise break Browse and the collection filter for the whole session.
  function loadGuruCollections() {
    if (guruState.collectionsP) return guruState.collectionsP;
    var p = (guruMode() === "demo"
      ? Promise.resolve(GURU_DEMO_TREE.collections)
      : guruApi("/collections", { subtype: "sidebar-browse" }).then(function (r) {
          var arr = Array.isArray(r) ? r : ((r && r.collections) || []);
          return arr.map(function (c) { return { id: c.id, name: c.name || c.title || "Collection" }; }).filter(function (c) { return c.id; });
        }).catch(function () { return null; })
    ).then(function (cols) {
      if (!cols || !cols.length) { guruState.collectionsP = null; return []; } // don't cache failures
      guruState.collections = cols;
      var sel = el("guru-collection-filter");
      if (sel) {
        sel.innerHTML = '<option value="">All collections</option>' + cols.map(function (c) {
          return '<option value="' + esc(c.id) + '"' + (c.id === guruCfg.defaultCollection ? " selected" : "") + ">" + esc(c.name) + "</option>";
        }).join("");
      }
      return cols;
    });
    guruState.collectionsP = p;
    return p;
  }

  // 2) Search — debounced from wireButtons; collection filter applied client-side.
  function doGuruSearch() {
    var input = el("guru-search-input"), host = el("guru-search-body");
    if (!input || !host) return;
    var term = (input.value || "").trim();
    var colId = (el("guru-collection-filter") || {}).value || "";
    if (term.length < 2) { host.innerHTML = emptyStateHTML("search", "Search the knowledge base", "Cards match on title and content."); resize(); return; }
    if (guruMode() === "demo") {
      var q = term.toLowerCase();
      var hits = GURU_DEMO_CARDS.filter(function (c) {
        return (!colId || c.collectionId === colId) && (c.title.toLowerCase().indexOf(q) > -1 || c.content.toLowerCase().indexOf(q) > -1);
      }).map(function (c) { return normalizeGuruCard(c); });
      host.innerHTML = guruRowsHTML(hits, "No cards matched", "Try different terms.", "search"); resize(); return;
    }
    host.innerHTML = '<div class="card"><div class="skeleton" style="width:60%"></div></div>'; resize();
    // Sequence token: a slow response for an earlier term must not overwrite
    // the results of a later one.
    var seq = guruState.searchSeq = (guruState.searchSeq || 0) + 1;
    guruApi("/search/query?searchTerms=" + encodeURIComponent(term) + "&maxResults=20", { subtype: "sidebar-search" })
      .then(function (r) {
        if (seq !== guruState.searchSeq) return;
        var cards = guruHits(r);
        if (colId) cards = cards.filter(function (c) { return c.collectionId === colId; });
        host.innerHTML = guruRowsHTML(cards, "No cards matched" + (colId ? " in this collection" : ""), "Try different terms or clear the filter.", "search");
        resize();
      })
      .catch(function (e) { if (seq !== guruState.searchSeq) return; host.innerHTML = '<div class="card error"><p>Search failed: ' + esc(reqErr ? reqErr(e) : (e && e.message)) + "</p></div>"; resize(); });
  }

  // 3) Browse — collections → folders → cards, with breadcrumbs.
  function renderGuruCrumbs() {
    var host = el("guru-crumbs"); if (!host) return;
    host.innerHTML = guruState.crumbs.map(function (c, i) {
      var last = i === guruState.crumbs.length - 1;
      return (i ? '<span class="guru-crumb-sep">›</span>' : "") +
        '<button class="guru-crumb" type="button" data-guru-crumb="' + i + '"' + (last ? " disabled" : "") + ">" + esc(c.label) + "</button>";
    }).join("");
  }
  function initGuruBrowse() {
    if (!guruState.crumbs.length) guruBrowseRoot();
    else renderGuruCrumbs();
  }
  function guruBrowseRoot() {
    guruState.crumbs = [{ kind: "root", label: "Collections" }];
    renderGuruCrumbs();
    var host = el("guru-browse-body"); if (!host) return;
    host.innerHTML = '<div class="card"><div class="skeleton" style="width:60%"></div></div>';
    loadGuruCollections().then(function (cols) {
      host.innerHTML = cols.length ? cols.map(function (c) {
        return '<div class="guru-row"><button class="guru-row-main" type="button" data-guru-col="' + esc(c.id) + '" data-guru-title="' + esc(c.name) + '">' +
          '<span class="guru-row-nav"><span class="guru-row-ic">' + icon("collection") + '</span><span class="guru-row-title">' + esc(c.name) + '</span><span class="guru-row-drill">›</span></span></button></div>';
      }).join("") : emptyStateHTML("collection", "No collections visible", "The connected Guru account can’t see any collections.");
      resize();
    });
  }
  function guruBrowseCollection(id, name, fromCrumb) {
    if (!fromCrumb) guruState.crumbs = [{ kind: "root", label: "Collections" }, { kind: "collection", id: id, label: name }];
    renderGuruCrumbs();
    var host = el("guru-browse-body"); if (!host) return;
    host.innerHTML = '<div class="card"><div class="skeleton" style="width:60%"></div></div>'; resize();
    var p = (guruMode() === "demo")
      ? Promise.resolve(GURU_DEMO_TREE.folders[id] || [])
      : guruApi("/folders?collection=" + encodeURIComponent(id), { subtype: "sidebar-browse" }).then(function (r) {
          var arr = Array.isArray(r) ? r : ((r && r.folders) || []);
          return arr.map(function (f) { return { id: f.id, title: f.title || f.name || "Folder" }; }).filter(function (f) { return f.id; });
        });
    p.then(function (folders) {
      host.innerHTML = folders.length ? folders.map(function (f) {
        return '<div class="guru-row"><button class="guru-row-main" type="button" data-guru-folder="' + esc(f.id) + '" data-guru-title="' + esc(f.title) + '">' +
          '<span class="guru-row-nav"><span class="guru-row-ic">' + icon("folder") + '</span><span class="guru-row-title">' + esc(f.title) + '</span><span class="guru-row-drill">›</span></span></button></div>';
      }).join("") : emptyStateHTML("folder", "No folders in this collection");
      resize();
    }).catch(function (e) { host.innerHTML = '<div class="card error"><p>Couldn’t load folders: ' + esc(reqErr ? reqErr(e) : (e && e.message)) + "</p></div>"; resize(); });
  }
  function guruBrowseFolder(id, title, fromCrumb) {
    if (!fromCrumb) guruState.crumbs = guruState.crumbs.concat([{ kind: "folder", id: id, label: title }]);
    renderGuruCrumbs();
    var host = el("guru-browse-body"); if (!host) return;
    host.innerHTML = '<div class="card"><div class="skeleton" style="width:60%"></div></div>'; resize();
    var p = (guruMode() === "demo")
      ? Promise.resolve(GURU_DEMO_TREE.items[id] ? GURU_DEMO_TREE.items[id].map(function (cid) { return demoGuruCardById(cid); }) : [])
      : guruApi("/folders/" + encodeURIComponent(id) + "/items", { subtype: "sidebar-browse" }).then(function (r) {
          return Array.isArray(r) ? r : ((r && r.items) || []);
        });
    p.then(function (items) {
      var out = [];
      items.forEach(function (it) {
        var type = String(it.type || it.itemType || (it.card || it.preferredPhrase || it.content ? "card" : "folder")).toLowerCase();
        if (type === "folder" || type === "section") {
          var f = it.folder || it;
          var ft = f.title || f.name || "Folder";
          out.push('<div class="guru-row"><button class="guru-row-main" type="button" data-guru-folder="' + esc(f.id) + '" data-guru-title="' + esc(ft) + '">' +
            '<span class="guru-row-nav"><span class="guru-row-ic">' + icon("folder") + '</span><span class="guru-row-title">' + esc(ft) + '</span><span class="guru-row-drill">›</span></span></button></div>');
        } else {
          var c = normalizeGuruCard(it.card || it);
          if (c.id) out.push(guruRowHTML(c));
        }
      });
      host.innerHTML = out.length ? out.join("") : emptyStateHTML("folder", "This folder is empty");
      resize();
    }).catch(function (e) { host.innerHTML = '<div class="card error"><p>Couldn’t load folder: ' + esc(reqErr ? reqErr(e) : (e && e.message)) + "</p></div>"; resize(); });
  }
  function guruCrumbTo(i) {
    var c = guruState.crumbs[i]; if (!c) return;
    guruState.crumbs = guruState.crumbs.slice(0, i + 1);
    if (c.kind === "root") guruBrowseRoot();
    else if (c.kind === "collection") guruBrowseCollection(c.id, c.label, true);
    else guruBrowseFolder(c.id, c.label, true);
  }

  // 4) Recents + pins (local to this browser).
  function renderGuruRecents() {
    var host = el("guru-recents-body"); if (!host) return;
    var pins = guruPins(), rec = guruRecents();
    var html = "";
    if (pins.length) html += '<div class="cmt-label">Pinned (this browser)</div>' +
      pins.map(function (p) { return guruRowHTML({ id: p.id, title: p.title, verificationState: "", collection: "" }); }).join("");
    html += '<div class="cmt-label">Recently opened</div>';
    html += rec.length ? rec.map(function (r) { return guruRowHTML({ id: r.id, title: r.title, verificationState: "", collection: "" }); }).join("")
      : emptyStateHTML("clock", "Nothing opened yet", "Cards you open show up here.");
    host.innerHTML = html;
    resize();
  }

  // ── card reader ───────────────────────────────────────────────────────
  // Preferred surface: a ZAF "modal" location instance — a real centered
  // dialog over the whole Agent Workspace (assets/guru_modal.html), not
  // boxed into the 320px sidebar. Falls back to the in-iframe overlay when
  // instances.create isn't available (harness, very old agent UIs).
  var guruZafModal = { open: false };
  function guruOpenCard(cardId, title) {
    var payload = { mode: guruMode(), parent: state.instanceGuid || "", ticketId: state.ticketId || "", card: null, debug: !!guruCfg.debug };
    if (guruMode() === "demo") payload.card = normalizeGuruCard(demoGuruCardById(cardId));
    else payload.card = { id: cardId, title: title || "Guru card", content: "", verificationState: "", lastVerified: "", verifier: "", collection: "" };
    guruState.card = payload.card;
    var opened = (client && client.invoke)
      ? client.invoke("instances.create", {
          location: "modal",
          url: "assets/guru_modal.html#" + encodeURIComponent(JSON.stringify(payload)),
          size: { width: "680px", height: "640px" }
        })
      : Promise.reject(new Error("no client"));
    opened.then(function (data) {
      guruZafModal.open = true; ahtSwitch();      // reader time bills to 'guru'
      guruRemember(payload.card); tagGuruUsed();
      try {
        var inst = data && data["instances.create"] && data["instances.create"][0];
        if (inst && inst.instanceGuid && client.instance) {
          client.instance(inst.instanceGuid).on("modal.close", function () { guruZafModal.open = false; ahtSwitch(); });
        }
      } catch (e) {}
    }).catch(function () { guruOpenCardInline(cardId, title); });
  }

  // ── card reader (in-iframe pop-out fallback) ──────────────────────────
  function guruShowOverlay(title) {
    el("guru-overlay-title").textContent = title || "Guru";
    el("guru-overlay").hidden = false; el("guru-chip").hidden = true;
    guruModalOpen = true; ahtSwitch(); resize();
  }
  function guruOpenCardInline(cardId, title) {
    guruShowOverlay(title || "Loading…");
    var body = el("guru-overlay-body");
    body.innerHTML = '<div class="skeleton" style="width:70%"></div><div class="skeleton" style="width:50%;margin-top:8px"></div>';
    if (guruMode() === "demo") {
      guruState.card = normalizeGuruCard(demoGuruCardById(cardId));
      renderGuruReader(); guruRemember(guruState.card); tagGuruUsed(); loadGuruComments(cardId);
      return;
    }
    guruApi("/cards/" + encodeURIComponent(cardId) + "/extended", { subtype: "sidebar-card-view" })
      .catch(function () { return guruApi("/cards/" + encodeURIComponent(cardId)); })
      .then(function (c) {
        guruState.card = normalizeGuruCard(c, cardId);
        renderGuruReader(); guruRemember(guruState.card); tagGuruUsed(); loadGuruComments(guruState.card.id);
      })
      .catch(function (e) { body.innerHTML = '<div class="card error"><p>Couldn’t load the card: ' + esc(reqErr ? reqErr(e) : (e && e.message)) + "</p></div>"; resize(); });
  }
  function renderGuruReader() {
    el("guru-overlay-title").textContent = guruState.card.title;
    el("guru-overlay-body").innerHTML = guruCardHTML(guruState.card);
    resize();
  }
  function setGuruHint(text, tone) {
    var h = el("guru-action-hint"); if (!h) return;
    h.textContent = text || "";
    h.style.color = tone === "ok" ? "var(--ok)" : (tone === "err" ? "var(--danger)" : "var(--muted)");
  }

  function guruCommentHTML(c) {
    var o = c.owner || c.user || {};
    var who = ((o.firstName || "") + " " + (o.lastName || "")).trim() || o.email || "Guru user";
    var when = guruTimeAgoDays(c.dateCreated || c.createdDate || "");
    return '<div class="cmt"><div class="cmt-head"><span class="cmt-who">' + esc(who) + '</span><span class="cmt-when">' + esc(when) + "</span></div>" +
      '<div class="cmt-text">' + safeGuruContent(c.content) + "</div></div>";
  }
  function loadGuruComments(cardId) {
    var list = el("guru-cmt-list"); if (!list) return;
    if (guruMode() === "demo") {
      list.innerHTML = guruCommentHTML({ owner: { firstName: "Dana", lastName: "W." }, content: "Confirmed with Eligibility — this flow is current. (sample)" });
      resize(); return;
    }
    guruApi("/cards/" + encodeURIComponent(cardId) + "/comments", { subtype: "sidebar-comments" })
      .then(function (r) {
        var arr = Array.isArray(r) ? r : ((r && r.comments) || []);
        list.innerHTML = arr.length ? arr.map(guruCommentHTML).join("") : '<div class="empty">No comments yet.</div>';
        resize();
      })
      .catch(function () { list.innerHTML = '<div class="empty">Couldn’t load comments.</div>'; resize(); });
  }

  function sendGuruComment(btn) {
    var wrap = btn.closest(".guru-cmt"), ta = wrap.querySelector(".guru-cmt-input"), hint = wrap.querySelector(".composer-hint");
    var text = (ta.value || "").trim(); if (!text) return;
    var cardId = btn.getAttribute("data-card");
    var list = el("guru-cmt-list");
    if (guruMode() === "demo") {
      if (list) list.insertAdjacentHTML("afterbegin", guruCommentHTML({ owner: { firstName: "You" }, content: text }));
      ta.value = ""; if (hint) { hint.textContent = "Comment added to the card (sample)."; hint.style.color = "var(--ok)"; } resize(); return;
    }
    btn.disabled = true; btn.textContent = "Posting…";
    guruApi("/cards/" + encodeURIComponent(cardId) + "/comments", { type: "POST", data: { content: text }, subtype: "sidebar-comment" })
      .then(function () {
        if (list) list.insertAdjacentHTML("afterbegin", guruCommentHTML({ owner: { firstName: "You" }, content: text }));
        ta.value = ""; btn.disabled = false; btn.textContent = "Comment";
        if (hint) { hint.textContent = "Comment posted to Guru."; hint.style.color = "var(--ok)"; }
        resize();
      })
      .catch(function (e) { btn.disabled = false; btn.textContent = "Comment"; if (hint) { hint.textContent = "Failed to post: " + (reqErr ? reqErr(e) : (e && e.message)); hint.style.color = "var(--danger)"; } });
  }

  // Trust workflow: verify / unverify from the reader; on 403 (not a
  // verifier) offer the comment-as-nudge fallback — the public API has no
  // request-verification endpoint.
  function guruVerify(btn) {
    var cardId = btn.getAttribute("data-card"), toVerify = btn.getAttribute("data-guru-verify") === "1";
    if (guruMode() === "demo") {
      guruState.card.verificationState = toVerify ? "TRUSTED" : "NEEDS_VERIFICATION";
      renderGuruReader(); setGuruHint(toVerify ? "Card verified (sample)." : "Card unverified (sample).", "ok");
      loadGuruComments(cardId); return;
    }
    btn.disabled = true;
    (toVerify ? guruApi("/cards/" + encodeURIComponent(cardId) + "/verify", { type: "PUT", subtype: "sidebar-verify" })
              : guruApi("/cards/" + encodeURIComponent(cardId) + "/unverify", { type: "POST", subtype: "sidebar-verify" }))
      .then(function () {
        guruState.card.verificationState = toVerify ? "TRUSTED" : "NEEDS_VERIFICATION";
        renderGuruReader(); setGuruHint(toVerify ? "Card verified." : "Card marked as needing verification.", "ok");
        loadGuruComments(cardId);
      })
      .catch(function (e) {
        btn.disabled = false;
        if ((e && e.status === 403) || /403/.test(String((e && (e.status || e.responseText || e.message)) || ""))) {
          btn.outerHTML = '<button class="btn small" type="button" data-guru-flag="' + esc(cardId) + '">Flag for verification</button>';
          setGuruHint("You’re not a verifier for this card — you can flag it for its verifier instead.", "err");
        } else {
          setGuruHint("Verification change failed: " + (reqErr ? reqErr(e) : (e && e.message)), "err");
        }
      });
  }
  function guruFlagVerification(btn) {
    var cardId = btn.getAttribute("data-guru-flag");
    var note = "⚑ Verification requested from the Zendesk CX sidebar" + (state.ticketId ? " (ticket #" + state.ticketId + ")" : "") + ".";
    if (guruMode() === "demo") { setGuruHint("Verifier notified (sample).", "ok"); return; }
    btn.disabled = true;
    guruApi("/cards/" + encodeURIComponent(cardId) + "/comments", { type: "POST", data: { content: note }, subtype: "sidebar-flag" })
      .then(function () { setGuruHint("Flagged: a comment was posted for the card’s verifier.", "ok"); loadGuruComments(cardId); })
      .catch(function (e) { btn.disabled = false; setGuruHint("Couldn’t flag: " + (reqErr ? reqErr(e) : (e && e.message)), "err"); });
  }

  // Compose assist: insert the sanitized card body into the ticket reply, or
  // copy it (rich + plain flavors) for pasting anywhere.
  function guruInsertCard() {
    var card = guruState.card; if (!card) return;
    if (!client) { setGuruHint("Editor unavailable outside Zendesk — use Copy.", "err"); return; }
    client.invoke("ticket.editor.insert", safeGuruContent(card.content))
      .then(function () { setGuruHint("Inserted into the ticket reply.", "ok"); tagGuruUsed(); })
      .catch(function () { setGuruHint("Couldn’t insert — use Copy instead.", "err"); });
  }
  function guruPlainText(html) { var d = document.createElement("div"); d.innerHTML = html; return d.textContent || ""; }
  function guruCopyCard() {
    var card = guruState.card; if (!card) return;
    var html = safeGuruContent(card.content), plain = guruPlainText(html);
    var done = function () { setGuruHint("Copied card content.", "ok"); tagGuruUsed(); };
    var fallback = function () {
      try {
        var ta = document.createElement("textarea"); ta.value = plain; document.body.appendChild(ta); ta.select();
        document.execCommand("copy"); document.body.removeChild(ta); done();
      } catch (e) { setGuruHint("Copy failed in this browser.", "err"); }
    };
    try {
      if (navigator.clipboard && window.ClipboardItem) {
        navigator.clipboard.write([new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([plain], { type: "text/plain" })
        })]).then(done, function () { navigator.clipboard.writeText(plain).then(done, fallback); });
      } else if (navigator.clipboard) {
        navigator.clipboard.writeText(plain).then(done, fallback);
      } else fallback();
    } catch (e) { fallback(); }
  }
  function guruTogglePinBtn(btn) {
    var id = btn.getAttribute("data-guru-pin"), title = btn.getAttribute("data-guru-title") || "Guru card";
    var pinned = guruTogglePin(id, title);
    btn.classList.toggle("pinned", pinned);
    btn.textContent = pinned ? "★" : "☆";
    btn.title = pinned ? "Unpin" : "Pin (saved locally to this browser)";
    if (guruState.view === "recents") renderGuruRecents();
  }

  // overlay chrome: minimize to chip / reopen / close (all AHT-aware — time
  // in the reader bills to 'guru' whatever pane sits underneath)
  function guruReopen() {
    if (!guruState.card) { switchTab("guru"); return; }
    el("guru-chip").hidden = true;
    guruOpenCard(guruState.card.id, guruState.card.title); // modal-first; falls back inline
  }
  function guruMinimize() {
    el("guru-overlay").hidden = true;
    el("guru-chip-title").textContent = guruState.card ? guruState.card.title : "Guru card";
    el("guru-chip").hidden = false;
    guruModalOpen = false; ahtSwitch(); resize();
  }
  function guruClose() {
    el("guru-overlay").hidden = true; el("guru-chip").hidden = true;
    guruModalOpen = false; ahtSwitch(); resize();
  }

  // ── theme ─────────────────────────────────────────────────────────────
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme === "dark" ? "dark" : "light");
    try { localStorage.setItem("cxsidebar.theme", theme); } catch (e) {}
  }
  function readTheme() { try { var v = localStorage.getItem("cxsidebar.theme"); return v === "dark" ? "dark" : "light"; } catch (e) { return "light"; } }
  function toggleTheme() { applyTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark"); }

  // ── per-field visibility (install parameters; default ON unless false) ─
  var VIS_MAP = {
    show_summary: "card-summary",
    show_profile_age: "row-age",
    show_contacts_month: "row-contacts",
    show_sentiment: "row-sentiment",
    show_user_tags: "row-tags",
    show_csat6: "row-csat6",
    show_csat30: "row-csat30",
    show_latest_tickets: "card-tickets"
  };
  var FALSY = ["false", "0", "off", "no", "disabled", ""];
  function isFalse(v) {
    if (v === false || v === 0 || v === null) return true;
    if (typeof v === "string") return FALSY.indexOf(v.trim().toLowerCase()) > -1;
    return false;
  }
  function applyVisibility(settings) {
    var s = settings || {};
    Object.keys(VIS_MAP).forEach(function (k) {
      var node = el(VIS_MAP[k]);
      if (node) node.style.display = isFalse(s[k]) ? "none" : ""; // default ON
    });
  }
  function metadataWithRetry() {
    // One retry after a beat — a transient metadata failure would otherwise
    // silently disable settings (and all AHT field mapping) for the session.
    return client.metadata().catch(function () {
      return new Promise(function (res) { setTimeout(res, 1500); }).then(function () { return client.metadata(); });
    });
  }
  function loadVisibility() {
    if (!client || !client.metadata) { applyVisibility(null); aht.settingsLoaded = true; aht.baselineReady = true; return Promise.resolve(null); }
    return metadataWithRetry().then(function (md) {
      var s = (md && md.settings) || {};
      s = s.parameters || s; // tolerate either settings shape
      asanaCfg.workspace = String(s.asana_workspace_gid || "").trim();
      asanaCfg.ticketField = String(s.asana_ticket_field_gid || "").trim();
      asanaCfg.projectGid = String(s.asana_project_gid || "").trim();
      asanaCfg.dedupeDays = parseInt(s.asana_dedupe_days, 10) || 0;
      asanaCfg.statusButtons = s.asana_status_buttons === true || s.asana_status_buttons === "true";
      slackCfg.channel = String(s.slack_channel_id || "").trim();
      slackCfg.workflows = parseWorkflowLinks(s.slack_workflow_links);
      // Home-view channel ids ("C123:label, C456") double as bookmark-discovery
      // targets for the Workflows sub-tab.
      slackCfg.homeChannels = String(s.slack_channel_ids || "").split(",").map(function (t) {
        return t.split(":")[0].trim();
      }).filter(Boolean);
      guruCfg.reasonField = String(s.guru_reason_field || "").trim();
      guruCfg.suggestSubject = s.guru_suggest_subject === true || s.guru_suggest_subject === "true";
      guruCfg.suggestTags = s.guru_suggest_tags === true || s.guru_suggest_tags === "true";
      guruCfg.aiAnswers = !(s.guru_ai_answers === false || s.guru_ai_answers === "false"); // default ON
      guruCfg.agentId = String(s.guru_agent_id || "").trim();
      guruCfg.defaultCollection = String(s.guru_default_collection || "").trim();
      guruCfg.debug = s.guru_debug === true || s.guru_debug === "true";
      triageCfg.map = parseTriageMap(s.triage_field_map);
      var pm = parseAhtMap(s.aht_field_map);
      aht.map = pm.map; aht.mapErrors = pm.errors;
      aht.endpoint = String(s.aht_endpoint || "").trim();
      aht.settingsLoaded = true;
      ahtLoadBaseline();
      applyVisibility(s);
      return s;
    }).catch(function () { applyVisibility(null); aht.settingsLoaded = true; aht.baselineReady = true; return null; });
  }

  // ── collapsible sections (chevron per card; state persisted) ───────────
  function collapsedSet() {
    try { return new Set(JSON.parse(localStorage.getItem("cxsidebar.collapsed") || "[]")); } catch (e) { return new Set(); }
  }
  function saveCollapsed(set) {
    try {
      var arr = []; set.forEach(function (v) { arr.push(v); }); // Set → Array (slice.call doesn't work on Sets)
      localStorage.setItem("cxsidebar.collapsed", JSON.stringify(arr));
    } catch (e) {}
  }
  function applyCollapsed() {
    var set = collapsedSet();
    Array.prototype.forEach.call(document.querySelectorAll(".collapsible"), function (card) {
      var collapsed = set.has(card.getAttribute("data-collapse-key"));
      card.classList.toggle("collapsed", collapsed);
      var ch = card.querySelector(".chevron");
      if (ch) ch.setAttribute("aria-expanded", String(!collapsed));
    });
  }
  function onChevron(btn) {
    var card = btn.closest(".collapsible");
    if (!card) return;
    var key = card.getAttribute("data-collapse-key");
    var collapsed = !card.classList.contains("collapsed");
    card.classList.toggle("collapsed", collapsed);
    btn.setAttribute("aria-expanded", String(!collapsed));
    var set = collapsedSet();
    if (collapsed) set.add(key); else set.delete(key);
    saveCollapsed(set);
    resize();
  }
  document.addEventListener("click", function (e) {
    if (!e.target || !e.target.closest) return;
    var ch = e.target.closest(".chevron");
    if (ch) { onChevron(ch); return; }
    var tab = e.target.closest(".tab");
    if (tab) { switchTab(tab.getAttribute("data-pane")); return; }
    // Summary card cross-links: "asana", "asana:linked", "guru", … Switch the
    // top-level tab first, then the sub-view so the pane's lazy loaders run.
    var snav = e.target.closest("[data-sum-nav]");
    if (snav) {
      var sp = String(snav.getAttribute("data-sum-nav") || "").split(":");
      switchTab(sp[0]);
      if (sp[1]) {
        if (sp[0] === "asana") switchAsub(sp[1]);
        else if (sp[0] === "guru") switchGsub(sp[1]);
        else if (sp[0] === "slack") switchSsub(sp[1]);
      }
      return;
    }
    var sub = e.target.closest(".subtab");
    if (sub) {
      if (sub.closest("#guru-subtabs")) switchGsub(sub.getAttribute("data-gsub"));
      else if (sub.closest("#slack-subtabs")) switchSsub(sub.getAttribute("data-ssub"));
      else switchAsub(sub.getAttribute("data-asub"));
      return;
    }
    var sres = e.target.closest("[data-slack-resolve]");
    if (sres) { slackMarkResolved(sres); return; }
    var spin = e.target.closest("[data-slack-pin]");
    if (spin) {
      var spinned = slackTogglePin(spin.getAttribute("data-slack-pin"), spin.getAttribute("data-slack-name") || "");
      spin.classList.toggle("pinned", spinned);
      spin.textContent = spinned ? "★" : "☆";
      spin.title = spinned ? "Remove favorite" : "Favorite (saved locally to this browser)";
      return;
    }
    var sreply = e.target.closest(".slack-reply-send");
    if (sreply) { sendSlackReply(sreply); return; }
    var send = e.target.closest(".composer-send");
    if (send) { sendDirectComment(send); return; }
    var gsend = e.target.closest(".guru-cmt-send");
    if (gsend) { sendGuruComment(gsend); return; }
    var gretry = e.target.closest(".guru-ask-retry");
    if (gretry) { loadGuruAnswer(guruState.lastQuestion || ((el("guru-ask-input") || {}).value) || ""); return; }
    var gpin = e.target.closest("[data-guru-pin]");
    if (gpin) { guruTogglePinBtn(gpin); return; }
    var gopen = e.target.closest("[data-guru-open]");
    if (gopen) { guruOpenCard(gopen.getAttribute("data-guru-open"), gopen.getAttribute("data-guru-title") || ""); return; }
    var gins = e.target.closest("[data-guru-insert]");
    if (gins) { guruInsertCard(); return; }
    var gcopy = e.target.closest("[data-guru-copy]");
    if (gcopy) { guruCopyCard(); return; }
    var gver = e.target.closest("[data-guru-verify]");
    if (gver) { guruVerify(gver); return; }
    var gflag = e.target.closest("[data-guru-flag]");
    if (gflag) { guruFlagVerification(gflag); return; }
    var gcol = e.target.closest("[data-guru-col]");
    if (gcol) { guruBrowseCollection(gcol.getAttribute("data-guru-col"), gcol.getAttribute("data-guru-title") || "Collection"); return; }
    var gfold = e.target.closest("[data-guru-folder]");
    if (gfold) { guruBrowseFolder(gfold.getAttribute("data-guru-folder"), gfold.getAttribute("data-guru-title") || "Folder"); return; }
    var gcrumb = e.target.closest("[data-guru-crumb]");
    if (gcrumb && !gcrumb.disabled) { guruCrumbTo(parseInt(gcrumb.getAttribute("data-guru-crumb"), 10)); return; }
    var sct = e.target.closest(".sub-cmt-toggle");
    if (sct) { toggleSubComments(sct); return; }
    var ssb = e.target.closest(".asana-status-btn");
    if (ssb) { setTicketStatusFromAsana(ssb.getAttribute("data-set-status")); return; }
    var tog = e.target.closest(".atask-toggle");
    if (tog) {
      if (tog.hasAttribute("data-slack-ts")) toggleSlackThread(tog);
      else if (tog.hasAttribute("data-direct-gid")) toggleDirectDetail(tog);
      else toggleSubs(tog);
    }
  });

  // ── init ──────────────────────────────────────────────────────────────
  function wireButtons() {
    var bt = el("btn-theme"); if (bt) bt.addEventListener("click", toggleTheme);
    var bo = el("btn-open"); if (bo) bo.addEventListener("click", function () { openUser(state.requesterId); });
    var br = el("btn-retry"); if (br) br.addEventListener("click", function () { loadContext(state); });
    var brf = el("btn-refresh"); if (brf) brf.addEventListener("click", forceRefresh);
    // Dedupe: Other-requests search button + the duplicate-warning toast actions.
    var ds = el("dedupe-search"); if (ds) ds.addEventListener("click", runDedupe);
    var dtg = el("dedupe-toast-go"); if (dtg) dtg.addEventListener("click", function () {
      aform.dedupeAck = true; hideDedupeToast(); submitAForm();
    });
    var dtc = el("dedupe-toast-cancel"); if (dtc) dtc.addEventListener("click", hideDedupeToast);
    var dtr = el("dedupe-toast-review"); if (dtr) dtr.addEventListener("click", function () {
      hideDedupeToast();
      var f = cfgForm(), ci = el("dedupe-client"), pi = el("dedupe-provider");
      if (ci && !meaningfulId(ci.value)) ci.value = dedupeFieldValue(f.client_id_question);
      if (pi && !meaningfulId(pi.value)) pi.value = dedupeFieldValue(f.provider_id_question);
      switchAsub("other");
      if (dedupe.lastMatches && dedupe.lastMatches.length) renderDedupe(dedupe.lastMatches);
    });
    // Guru: reader controls, chip reopen, suggestions refresh, debounced search
    var gmin = el("guru-min"); if (gmin) gmin.addEventListener("click", guruMinimize);
    var gclose = el("guru-close"); if (gclose) gclose.addEventListener("click", guruClose);
    var gchip = el("guru-chip"); if (gchip) gchip.addEventListener("click", guruReopen);
    var grf = el("guru-refresh"); if (grf) grf.addEventListener("click", function () { loadGuruSuggested(true); });
    var gab = el("guru-ask-btn"); if (gab) gab.addEventListener("click", function () { var i = el("guru-ask-input"); loadGuruAnswer(i ? i.value : ""); });
    var gai = el("guru-ask-input"); if (gai) gai.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); loadGuruAnswer(gai.value); } });
    var gsi = el("guru-search-input");
    if (gsi) {
      gsi.addEventListener("input", function () {
        if (guruState.searchTimer) clearTimeout(guruState.searchTimer);
        guruState.searchTimer = setTimeout(doGuruSearch, 300);
      });
      gsi.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); if (guruState.searchTimer) clearTimeout(guruState.searchTimer); doGuruSearch(); }
      });
    }
    var gcf = el("guru-collection-filter"); if (gcf) gcf.addEventListener("change", doGuruSearch);
    // Slack channel directory search (debounced; empty query → relevant view)
    var scs = el("slack-ch-search");
    if (scs) {
      scs.addEventListener("input", function () {
        if (slackDir.searchTimer) clearTimeout(slackDir.searchTimer);
        slackDir.searchTimer = setTimeout(renderSlackChannels, 300);
      });
      scs.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); if (slackDir.searchTimer) clearTimeout(slackDir.searchTimer); renderSlackChannels(); }
      });
    }
    // Slack request keyword search (debounced; empty query → ticket requests)
    var srs = el("slack-req-search");
    if (srs) {
      srs.addEventListener("input", function () {
        if (slackReq.searchTimer) clearTimeout(slackReq.searchTimer);
        slackReq.searchTimer = setTimeout(doSlackReqSearch, 350);
      });
      srs.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); if (slackReq.searchTimer) clearTimeout(slackReq.searchTimer); doSlackReqSearch(); }
      });
    }
    // Relays from the Guru reader modal (a separate ZAF instance): actions
    // that need the ticket-scoped instance land here by parent GUID.
    if (client && client.on) {
      try {
        client.on("guru.insert", function (d) {
          client.invoke("ticket.editor.insert", (d && d.html) || "").catch(function () {});
          tagGuruUsed();
        });
        client.on("guru.used", function () { tagGuruUsed(); });
        client.on("guru.sync", function () { if (guruState.view === "recents") renderGuruRecents(); });
      } catch (e) {}
    }
  }

  // Demo-only: a Client/Provider toggle so reviewers can see both variants from any
  // ticket. Hidden entirely when DEMO_MODE is false (production reads the variant from data).
  function updateDemoToggleActive() {
    var t = el("demo-toggle"); if (!t) return;
    Array.prototype.forEach.call(t.querySelectorAll(".demo-seg"), function (b) {
      b.classList.toggle("active", b.getAttribute("data-variant") === state.demoVariant);
    });
  }
  function setupDemoToggle() {
    var t = el("demo-toggle"); if (!t) return;
    t.hidden = false;
    updateDemoToggleActive();
    Array.prototype.forEach.call(t.querySelectorAll(".demo-seg"), function (b) {
      b.addEventListener("click", function () {
        state.demoVariant = b.getAttribute("data-variant");
        updateDemoToggleActive();
        loadContext(state);
        loadSummary({ ticketId: state.ticketId, requesterId: state.requesterId, email: state.email });
        // The Asana pane is variant-specific too: reload now if visible, else mark stale.
        asanaState.loadedVariant = null;
        if (asanaActive()) loadAsana();
      });
    });
  }

  function init() {
    applyTheme(readTheme());
    wireButtons();
    settingsReady = loadVisibility().then(function (s) {
      if (client && client.context) {
        return client.context().then(function (c) {
          var sub = c && (c.account && c.account.subdomain || c.subdomain);
          if (sub) state.zdSubdomain = sub;
          if (c && c.instanceGuid) state.instanceGuid = c.instanceGuid; // for modal → sidebar relays
        }).catch(function () {}).then(function () { return s; });
      }
      return s;
    });
    applyCollapsed();   // static cards (profile, tickets)
    startAht();         // per-feature handle-time (tracks in demo too; writes only when mapped + live)
    if (!DEMO_MODE) { var asn = el("asana-sample-note"); if (asn) asn.hidden = true; }
    if (!client) { bootError("Zendesk app framework unavailable."); return; }
    getContext().then(function (ctx) {
      state.ticketId = ctx.ticketId; state.requesterId = ctx.requesterId; state.email = ctx.email; state.tags = ctx.tags || [];
      if (DEMO_MODE) { state.demoVariant = isProviderTag() ? "provider" : "client"; setupDemoToggle(); }
      if (!ctx.ticketId) { setText("pf-name", "No ticket in context"); return; }
      loadContext(ctx);            // client context from the custom object (parallel)
      loadProfile(ctx);            // retained Zendesk features
      loadSummary(ctx);            // local ticket digest (Summary card)
    }).catch(function () { bootError(); });
  }

  // Boot-level failure (no ZAF client / no ticket context): the Account pane's
  // error card is hidden behind a non-default tab since the Summary pane became
  // the landing view, so surface the failure on the landing pane too.
  function bootError(msg) {
    showContextError(msg); // keep the Account-pane card + its retry
    setText("pf-name", "Couldn’t load this ticket");
    var host = el("summary-body");
    if (host) {
      host.innerHTML = '<p class="sum-boot-error">' + esc(msg || "Couldn’t load ticket context.") +
        '</p><button class="btn primary" id="btn-sum-retry" type="button">Retry</button>';
      var b = el("btn-sum-retry");
      if (b) b.addEventListener("click", function () { try { location.reload(); } catch (e) {} });
    }
    resize();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
