/* Mock ZAF for the AHT/Guru harness.
   Loads BEFORE app.js. Reads config from ?cfg=<json>:
     { settings: {...install settings...}, fields: {"25005": 300, ...},
       startHidden: false, ticketId: 12345 }
   Exposes window.__mock for the runner: recorded requests/beacons/invokes,
   virtual clock advance, visibility + ZAF lifecycle triggers, failure injection. */
(function () {
  var cfg = { settings: {}, fields: {}, startHidden: false, ticketId: 12345 };
  try {
    var raw = new URLSearchParams(location.search).get("cfg");
    if (raw) { var p = JSON.parse(raw); Object.keys(p).forEach(function (k) { cfg[k] = p[k]; }); }
  } catch (e) {}

  // Fully virtual clock: Date.now advances ONLY via mock.advance(), so dwell
  // assertions are exact and never flake on real test-execution time.
  var realNow = Date.now.bind(Date), virtualBase = realNow(), offset = 0;
  Date.now = function () { return virtualBase + offset; };

  var hiddenFlag = !!cfg.startHidden;
  Object.defineProperty(document, "hidden", { get: function () { return hiddenFlag; }, configurable: true });

  var mock = {
    cfg: cfg, requests: [], beacons: [], invokes: [], handlers: {}, behaviors: [],
    advance: function (ms) { offset += ms; },
    setHidden: function (h) { hiddenFlag = !!h; document.dispatchEvent(new Event("visibilitychange")); },
    fire: function (evt) { (mock.handlers[evt] || []).forEach(function (cb) { try { cb(); } catch (e) {} }); },
    pagehide: function () { window.dispatchEvent(new Event("pagehide")); },
    failNext: function (matchFn, n, status) {
      var left = (n == null ? 1 : n);
      mock.behaviors.unshift({
        match: function (r) { if (left > 0 && matchFn(r)) { left--; return true; } return false; },
        respond: function (r) { r.outcome = "fail"; return Promise.reject({ status: status || 500, responseText: "injected failure" }); }
      });
    },
    respondNext: function (matchFn, value) {
      var used = false;
      mock.behaviors.unshift({
        match: function (r) { if (!used && matchFn(r)) { used = true; return true; } return false; },
        respond: function (r) { r.outcome = "ok"; return Promise.resolve(value); }
      });
    },
    delayNext: function (matchFn, ms) {
      var used = false;
      mock.behaviors.unshift({
        match: function (r) { if (!used && matchFn(r)) { used = true; return true; } return false; },
        respond: function (r) { r.outcome = "ok-delayed"; return new Promise(function (res) { setTimeout(function () { res({}); }, ms); }); }
      });
    },
    settle: function (ms) { return new Promise(function (res) { setTimeout(res, ms == null ? 80 : ms); }); }
  };

  function fixtureFor(p) {
    if (p === "ticket.id") return cfg.ticketId;
    if (p === "ticket.requester.id") return 777;
    if (p === "ticket.requester.email") return "member@example.test";
    if (p === "ticket.tags") return cfg.tags || [];
    if (p === "ticket.subject") return cfg.subject || "";
    if (p === "currentUser.email") return "agent@alma.test";
    if (p === "currentUser.role") return "agent";
    var m = /^ticket\.customField:custom_field_(\d+)$/.exec(p);
    if (m) { var v = cfg.fields[m[1]]; return v == null ? null : v; }
    return "";
  }

  var client = {
    on: function (evt, cb) { (mock.handlers[evt] = mock.handlers[evt] || []).push(cb); },
    off: function () {},
    get: function (paths) {
      var arr = Array.isArray(paths) ? paths : [paths];
      if (cfg.failFieldGet && arr.some(function (p) { return /^ticket\.customField:/.test(p); }))
        return Promise.reject({ message: "injected field get failure" });
      var out = {};
      arr.forEach(function (p) { out[p] = fixtureFor(p); });
      return Promise.resolve(out);
    },
    set: function () { return Promise.resolve({}); },
    invoke: function (name) {
      mock.invokes.push([].slice.call(arguments));
      if (name === "instances.create") return Promise.reject({ message: "modal unsupported in harness" }); // exercises the inline-overlay fallback
      return Promise.resolve({});
    },
    metadata: function () {
      if (cfg.delayMetadata) return new Promise(function (res) { setTimeout(function () { res({ settings: cfg.settings }); }, cfg.delayMetadata); });
      return Promise.resolve({ settings: cfg.settings });
    },
    context: function () { return Promise.resolve({ account: { subdomain: "almatest" }, instanceGuid: "mock-instance-guid" }); },
    request: function (req) {
      var rec = { url: req.url, type: req.type || "GET", secure: !!req.secure, at: mock.requests.length,
        data: null, outcome: "ok", t: realNow() };
      try { rec.data = req.data ? JSON.parse(req.data) : null; } catch (e) { rec.data = req.data; }
      mock.requests.push(rec);
      for (var i = 0; i < mock.behaviors.length; i++) {
        if (mock.behaviors[i].match(rec)) return mock.behaviors[i].respond(rec);
      }
      // Static fixtures from ?cfg= (url-substring → response). Behaviors above
      // still win, so failNext/respondNext keep overriding fixtures in tests.
      if (cfg.apiFixtures) {
        for (var k in cfg.apiFixtures) {
          if (rec.url && rec.url.indexOf(k) !== -1) { rec.outcome = "fixture"; return Promise.resolve(cfg.apiFixtures[k]); }
        }
      }
      return Promise.resolve({});
    }
  };

  navigator.sendBeacon = function (url, data) {
    var rec = { url: url, data: null };
    try { rec.data = JSON.parse(String(data)); } catch (e) { rec.data = String(data); }
    mock.beacons.push(rec);
    return true;
  };

  window.ZAFClient = { init: function () { return client; } };
  window.__mock = mock;
})();
