/*
 * api-monitor.js — API rate-limit monitoring for the CX Intelligence Sidebar.
 *
 * Measures how close the app runs to each vendor's API rate limit. Because only
 * Zendesk exposes remaining-quota response headers (and the app's vendor calls go
 * through Zendesk's secure proxy, which does not surface vendor headers to the
 * browser), the ground truth for Asana / Slack / Guru is: count requests in a
 * rolling window locally, and treat 429 + Retry-After as the authoritative breach
 * signal. Limits below are from each vendor's official docs (see the .md doc).
 *
 * ES5, no dependencies. Drop into the app and call monitor.record(...) at each API
 * choke point (asanaApi / slackApi / guruApi / client.request), or wrap a promise
 * with monitor.watch(promise, channel). Metrics are exposed on window.__apiMonitor.
 */
(function () {
  "use strict";

  // limit=null means "no documented limit — react to 429 only".
  // windowMs is the rolling window the limit applies over.
  var DEFAULT_CONFIG = {
    warnRatio: 0.8,            // flag WARN when count/limit >= this
    maxEvents: 500,           // ring-buffer cap for raw events
    channels: {
      "asana": {
        limit: 150, windowMs: 60000, headers: false,
        scope: "per auth token, free domain (paid = 1500/min — override if paid)",
        cite: "https://developers.asana.com/docs/rate-limits"
      },
      "asana.search": {
        limit: 60, windowMs: 60000, headers: false,
        scope: "per token, search/typeahead endpoints only",
        cite: "https://developers.asana.com/docs/rate-limits"
      },
      "slack.chat.postMessage": {
        limit: 60, windowMs: 60000, headers: false, soft: true,
        scope: "~1 msg/sec per channel; workspace 'several hundred/min' (soft, undocumented ceiling)",
        cite: "https://docs.slack.dev/reference/methods/chat.postMessage/"
      },
      "slack.conversations.history": {
        limit: 50, windowMs: 60000, headers: false, uncertain: true,
        scope: "Tier 3 (50+/min) for Marketplace-approved/internal apps — BUT 1/min for non-Marketplace apps created/installed after 2025-05-29. CONFIRM this app's distribution class; wrong assumption = 50x error.",
        cite: "https://docs.slack.dev/apis/web-api/rate-limits/"
      },
      "guru": {
        limit: null, windowMs: 60000, headers: false, uncertain: true,
        scope: "UNKNOWN — Guru publishes no numeric rate limit and no documented 429/Retry-After. Measure request rate; react to 429 if it ever appears; back off with jitter.",
        cite: "https://developer.getguru.com/docs/getting-started"
      },
      "zendesk": {
        limit: 100, windowMs: 60000, headers: true,
        scope: "Apps-framework client.request: 100/min per user per app + 700 per 5 min per user per app (account-wide plan cap is separate: Team 200 / Growth+Prof 400 / Enterprise 700 / Ent+ 2500 per min).",
        cite: "https://developer.zendesk.com/api-reference/introduction/rate-limits/"
      },
      "zendesk.search": {
        limit: null, windowMs: 60000, headers: true, uncertain: true,
        scope: "search.json has a DEDICATED budget surfaced via the Zendesk-RateLimit-search-index response header (no published number) + 1000-results-per-query cap. This app fans out ~4 searches per ticket boot — record search.json calls here AND under 'zendesk', and alert on that header.",
        cite: "https://developer.zendesk.com/api-reference/ticketing/ticket-management/search/"
      }
    }
  };

  // Case-insensitive header lookup (Zendesk casing varies across APIs).
  function header(headers, name) {
    if (!headers) return null;
    name = String(name).toLowerCase();
    for (var k in headers) {
      if (headers.hasOwnProperty(k) && String(k).toLowerCase() === name) return headers[k];
    }
    return null;
  }

  // Retry-After per RFC 9110: integer delta-seconds OR an HTTP-date. Returns ms to wait, or null.
  function parseRetryAfter(value, nowMs) {
    if (value === null || value === undefined || value === "") return null;
    var s = String(value).trim();
    if (/^\d+$/.test(s)) return parseInt(s, 10) * 1000;      // delta-seconds
    var t = Date.parse(s);                                   // HTTP-date
    if (!isNaN(t)) { var d = t - nowMs; return d > 0 ? d : 0; }
    return null;
  }

  function createMonitor(config, opts) {
    config = config || DEFAULT_CONFIG;
    opts = opts || {};
    var now = opts.now || function () { return Date.now(); };   // injectable clock (testable)
    var onWarn = opts.onWarn || function () {};                 // hook: called on WARN/BREACH

    var hits = {};        // channel -> [timestamps]
    var inflight = {};    // channel -> current in-flight count
    var breaches = [];    // { t, channel, retryAfterMs, status }
    var events = [];      // raw ring buffer

    function cfg(channel) { return config.channels[channel] || null; }

    function prune(channel, windowMs, t) {
      var arr = hits[channel] || (hits[channel] = []);
      var cutoff = t - windowMs;
      while (arr.length && arr[0] < cutoff) arr.shift();
      return arr;
    }

    // Record one completed API call.
    // meta: { status, responseHeaders, retryAfter }
    function record(channel, meta) {
      meta = meta || {};
      var t = now();
      var c = cfg(channel);
      var windowMs = (c && c.windowMs) || 60000;
      var arr = prune(channel, windowMs, t);
      arr.push(t);

      var ev = { t: t, channel: channel, status: meta.status || 0, inWindow: arr.length };
      var limit = c ? c.limit : null;

      // Prefer a real remaining-quota header when the vendor supplies one (Zendesk).
      var remaining = null, hdrLimit = null;
      if (meta.responseHeaders) {
        var r = header(meta.responseHeaders, "x-rate-limit-remaining");
        if (r === null) r = header(meta.responseHeaders, "ratelimit-remaining");
        var l = header(meta.responseHeaders, "x-rate-limit");
        if (l === null) l = header(meta.responseHeaders, "ratelimit-limit");
        if (r !== null) remaining = parseInt(r, 10);
        if (l !== null) hdrLimit = parseInt(l, 10);
      }
      ev.remainingHeader = remaining;

      // 429 breach — authoritative signal for all vendors.
      if (meta.status === 429) {
        var ra = parseRetryAfter(meta.retryAfter != null ? meta.retryAfter
                  : header(meta.responseHeaders, "retry-after"), t);
        var b = { t: t, channel: channel, status: 429, retryAfterMs: ra };
        breaches.push(b);
        ev.breach = true; ev.retryAfterMs = ra;
        onWarn({ level: "BREACH", channel: channel, retryAfterMs: ra, count: arr.length, limit: limit });
      } else if (limit) {
        // proactive: header remaining if present, else local count
        var ratio = (remaining !== null && hdrLimit) ? (1 - remaining / hdrLimit) : (arr.length / limit);
        if (ratio >= config.warnRatio) {
          ev.warn = true;
          onWarn({ level: "WARN", channel: channel, count: arr.length, limit: limit,
                   remaining: remaining, ratio: Math.round(ratio * 100) / 100 });
        }
      }

      events.push(ev);
      while (events.length > (config.maxEvents || 500)) events.shift();
      return ev;
    }

    // Optional in-flight tracking (Asana concurrency caps: GET 50 / write 15).
    function begin(channel) { inflight[channel] = (inflight[channel] || 0) + 1; return inflight[channel]; }
    function end(channel) { if (inflight[channel]) inflight[channel]--; }

    // Wrap a request promise so success + 429 are recorded automatically.
    // resolveMeta(response)/rejectMeta(error) extract { status, responseHeaders, retryAfter }.
    function watch(promise, channel, extract) {
      extract = extract || {};
      begin(channel);
      return promise.then(function (res) {
        end(channel);
        record(channel, extract.onOk ? extract.onOk(res) : { status: 200 });
        return res;
      }, function (err) {
        end(channel);
        var meta = extract.onErr ? extract.onErr(err)
                 : { status: (err && err.status) || 0,
                     retryAfter: err && (err.retryAfter || (err.responseHeaders ? header(err.responseHeaders, "retry-after") : null)) };
        record(channel, meta);
        throw err;
      });
    }

    // Current usage snapshot.
    function report() {
      var t = now(), out = {};
      for (var ch in config.channels) {
        if (!config.channels.hasOwnProperty(ch)) continue;
        var c = config.channels[ch];
        var arr = prune(ch, c.windowMs, t);
        var count = arr.length;
        var pct = c.limit ? Math.round((count / c.limit) * 100) : null;
        var chBreaches = 0;
        for (var i = 0; i < breaches.length; i++) if (breaches[i].channel === ch) chBreaches++;
        out[ch] = {
          countInWindow: count,
          limit: c.limit,
          windowSec: c.windowMs / 1000,
          pctOfLimit: pct,
          status: c.limit ? (count >= c.limit ? "OVER" : (pct >= config.warnRatio * 100 ? "WARN" : "OK"))
                          : (chBreaches ? "SEEN-429" : "UNKNOWN-LIMIT"),
          inflight: inflight[ch] || 0,
          breaches: chBreaches,
          uncertain: !!c.uncertain,
          note: c.scope
        };
      }
      return out;
    }

    return {
      record: record, watch: watch, begin: begin, end: end,
      report: report, parseRetryAfter: parseRetryAfter,
      events: function () { return events.slice(); },
      breaches: function () { return breaches.slice(); },
      config: config
    };
  }

  var monitor = createMonitor(DEFAULT_CONFIG);

  if (typeof window !== "undefined") window.__apiMonitor = monitor;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { createMonitor: createMonitor, DEFAULT_CONFIG: DEFAULT_CONFIG, monitor: monitor, parseRetryAfter: parseRetryAfter };
  }
})();
