/*
 * load-sim.js — offline load simulation for the CX Intelligence Sidebar.
 *
 * Answers "what request volume does a pilot population put on Zendesk + vendor
 * APIs?" WITHOUT sending a single request: the per-interaction call profile is
 * extracted from the app source (monitoring/load-profile.json, every entry
 * carries app.js/home.js line refs) and a seeded Monte-Carlo agent-behavior
 * model replays it on a virtual clock. Deliberately offline — deliberately
 * driving traffic at Zendesk to probe limits violates MSA §2.2 (prohibited
 * uses) even on a d3v sandbox; the compliant live measurement is passive
 * header/429 observation via monitoring/api-monitor.js during the pilot.
 *
 * Key mechanics reproduced from the app source (see load-profile.json refs):
 *   - nav_bar home iframe persists once opened; its 30s Asana badge poll has
 *     NO visibility gate → an agent's FIRST home check starts a permanent
 *     poller for the rest of the day. Later checks do not re-boot.
 *   - ticket sidebar badge poll (30s) is likewise ungated, lives as long as
 *     the ticket tab; Slack sync (30s) and home request poll (45s) ARE gated
 *     (pane active + visible) → modeled with a duty cycle.
 *   - AHT writes are single PUTs (all fields in one call) on blur/interval.
 *
 * Accounting per simulated minute:
 *   framework      per agent, ALL client.request calls/min (Zendesk client cap
 *                  100/min/agent/app) + rolling 5-min window (API cap 700/5min).
 *                  NOTE: whether proxied vendor calls count here is undocumented
 *                  (verified 2026-08-16) — this is the conservative reading.
 *   zendesk.TOTAL  account-wide Zendesk REST calls vs plan cap (Team 200 /
 *                  Growth+Prof 400 / Ent 700 / Ent+ & HighVolume 2500 per min)
 *   zendesk.ticketUpdate  account-wide vs the 100 updates/min sublimit, plus
 *                  per (agent,ticket) rolling 10 min vs 30
 *   asana.TOTAL    shared PAT: 150/min free, 1500/min paid; asana.search 60/min
 *   slack.*        per-method Slack tiers, one shared bot token (internal app:
 *                  conversations.history is Tier 3 = 50/min, NOT the 1/min
 *                  non-Marketplace tier — verified 2026-08-16)
 *   guru           no published limit — volume reported, no cap line
 *
 * Usage:
 *   node load-sim.js                          # all scenarios, defaults
 *   node load-sim.js --scenario slack --agents 70 --seeds 200
 *   node load-sim.js --asana-tier paid --zendesk-plan-cap 700 --json out.json
 *   node load-sim.js --selftest
 */
"use strict";

var fs = require("fs");
var path = require("path");

// ── seeded PRNG (mulberry32) — reproducible runs ───────────────────────────
function rng(seed) {
  var a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function expSample(r, meanSec) { return -Math.log(1 - r()) * meanSec; }
function poisson(r, lambda) {
  var L = Math.exp(-lambda), k = 0, p = 1;
  do { k++; p *= r(); } while (p > L);
  return k - 1;
}
function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

// ── behavior model (the scenario knobs) ────────────────────────────────────
var BASE_BEHAVIOR = {
  agents: 70,
  ticketsPerHour: 10,          // per agent (Poisson arrivals)
  homeChecksPerHour: 2,        // per agent (Poisson) — first check boots + starts the permanent poller
  homeDwellSec: [30, 120],     // uniform; gated home pollers only run inside dwells
  // Ticket handle time ~5 min ± spread, clamped; up to 2 ticket tabs open at
  // once (the sidebar iframe — and its pollers — live per open tab).
  handleMeanSec: 300, handleSpreadSec: 180, handleClampSec: [60, 1080],
  maxConcurrentTickets: 2,
  ticketTabLingerSec: 0,       // extra tab-open time after handling (pollers keep running)
  // Pane-visit probabilities per ticket session (Summary is the landing pane,
  // its cost is in ticket_open_boot).
  tabOpenProb: { account: 0.50, asana: 0.60, slack: 0.25, guru: 0.35 },
  slackWorkflowsProb: 0.50,    // of slack-tab visits, reach the Workflows sub-tab (starts 30s sync)
  slackChannelsProb: 0.15,     // of slack-tab visits, open the Channels sub-tab
  guruSearchesPerGuruOpen: 1.5,   // Poisson mean of debounced search terms (browse folded in)
  guruModalProb: 0.30,            // open a card reader per guru visit
  asanaCommentPostProb: 0.30,     // per asana visit
  createTaskProb: 0.05,           // per ticket session
  arrival: "steady",              // "burst" = everyone starts in a 10-min 9am window
};

var SCENARIOS = {
  core:  { slackLive: false, label: "Week 1 — core (Asana+Guru live, Slack demo)" },
  slack: { slackLive: true,  label: "Week 2+ — Slack flipped live" },
  burst: { slackLive: true, arrival: "burst", label: "Burst — all agents start 9:00-9:10, Slack live" },
};

// ── per-channel limits (verified against vendor docs 2026-08-16;
//    see the rate-limit table in the sim report for sources) ────────────────
var LIMITS = {
  "zendesk.TOTAL": "PLAN",          // set from --zendesk-plan-cap
  "zendesk": null,                  // component of TOTAL — informational
  "zendesk.ticketUpdate": 100,      // account-wide update sublimit /min
  "asana.TOTAL": "ASANA",           // 150 free / 1500 paid, shared PAT
  "asana": null,                    // component of TOTAL
  "asana.search": 60,               // shared PAT, search endpoints
  "slack.conversations.history": 50,  // Tier 3 (internal app)
  "slack.conversations.replies": 50,  // Tier 3
  "slack.chat.postMessage": 60,       // ~1/sec/channel + workspace ceiling (soft)
  "slack.auth.test": 100,             // Tier 4
  "slack.users.conversations": 50,    // Tier 3
  "slack.conversations.list": 20,     // Tier 2
  "slack.conversations.info": 50,     // Tier 3
  "slack.stars.list": 20,             // Tier 2 (uncertain)
  "slack.bookmarks.list": 50,         // Tier 3
  "slack.search.messages": 20,        // Tier 2 (user token)
  "guru": null,                       // no published limit
};

// ── engine ─────────────────────────────────────────────────────────────────
function simulateOnce(profile, behavior, seed, horizonSec, measure) {
  var r = rng(seed);
  var events = []; // {t, agent, channel, ticketKey|null}

  function emitCalls(t, agent, calls, ticketKey) {
    for (var i = 0; i < calls.length; i++) {
      var c = calls[i];
      if (c.channel.indexOf("slack") === 0 && !behavior.slackLive) continue;
      // fractional n = expected count; emit floor(n) + Bernoulli(frac)
      var n = c.n === undefined ? 1 : c.n;
      var whole = Math.floor(n);
      if (r() < n - whole) whole++;
      for (var k = 0; k < whole; k++) events.push({ t: t, agent: agent, channel: c.channel, ticketKey: ticketKey || null });
    }
  }
  function interaction(t, agent, name, ticketKey) {
    var calls = profile.interactions[name];
    if (calls) emitCalls(t, agent, calls, ticketKey);
  }
  function runPollers(scope, t0, t1, agent, ticketKey, tabsOpenAt) {
    for (var i = 0; i < profile.pollers.length; i++) {
      var p = profile.pollers[i];
      if (p.scope !== scope) continue;
      var duty = p.dutyCycle === undefined ? 1 : p.dutyCycle;
      // staggered = absolute cohort schedule (e.g. hourly refresh, agents in
      // cohorts of N, cohort k offset by k*(period/numCohorts)). Ticks fire on
      // the schedule regardless of when the agent's iframe opened, but only
      // once it exists (>= t0 — before that there are no cards to poll).
      if (p.staggered) {
        var size = p.staggered.cohortSize || 1;
        var nCohorts = Math.max(1, Math.ceil(behavior.agents / size));
        var offset = (Math.floor(agent / size) % nCohorts) * (p.periodSec / nCohorts);
        for (var st = offset; st < t1; st += p.periodSec) {
          if (st < t0) continue;
          if (duty < 1 && r() >= duty) continue;
          emitCalls(st, agent, p.calls, ticketKey);
        }
        continue;
      }
      var start = t0;
      if (p.activeWhen && p.activeWhen !== "always") {
        var tabT = (tabsOpenAt || {})[p.activeWhen];
        if (tabT === undefined) continue;
        start = tabT;
      }
      for (var tick = start + p.periodSec; tick < t1; tick += p.periodSec) {
        if (duty < 1 && r() >= duty) continue;   // gated poller tick is a no-op
        emitCalls(tick, agent, p.calls, ticketKey);
      }
    }
  }

  function runTicketSession(t0, t1, agent, ticketKey) {
    interaction(t0, agent, "ticket_open_boot", ticketKey);
    var tabsOpenAt = {};
    ["account", "asana", "slack", "guru"].forEach(function (tab) {
      if (r() >= behavior.tabOpenProb[tab]) return;
      var tt = t0 + r() * (t1 - t0) * 0.6;
      tabsOpenAt[tab + "Tab"] = tt;
      interaction(tt, agent, "switch_to_" + tab, ticketKey);
      if (tab === "slack") {
        if (r() < behavior.slackWorkflowsProb) {
          var tw = tt + 5 + r() * 30;
          tabsOpenAt.slackWfTab = tw;
          interaction(tw, agent, "slack_workflows_open", ticketKey);
        }
        if (r() < behavior.slackChannelsProb) interaction(tt + 10 + r() * 40, agent, "slack_channels_open", ticketKey);
      }
      if (tab === "guru") {
        var searches = poisson(r, behavior.guruSearchesPerGuruOpen);
        for (var s = 0; s < searches; s++) interaction(tt + 10 + r() * 60, agent, "guru_search", ticketKey);
        if (r() < behavior.guruModalProb) interaction(tt + 15 + r() * 60, agent, "open_guru_modal", ticketKey);
      }
      if (tab === "asana" && r() < behavior.asanaCommentPostProb)
        interaction(tt + 20 + r() * 90, agent, "asana_comment_post", ticketKey);
    });
    if (r() < behavior.createTaskProb) interaction(t0 + r() * (t1 - t0), agent, "create_task", ticketKey);
    // sidebar pollers run until the ticket TAB closes (handle end + linger) —
    // the iframe stays resident while the tab is open
    var tabClose = t1 + behavior.ticketTabLingerSec;
    runPollers("ticket", t0, tabClose, agent, ticketKey, tabsOpenAt);
    interaction(t1, agent, "ticket_close", ticketKey);
  }

  for (var agent = 0; agent < behavior.agents; agent++) {
    // ticket sessions
    var t = behavior.arrival === "burst" ? r() * 600 : r() * 3600 / behavior.ticketsPerHour;
    var open = [], ticketSeq = 0;
    while (t < horizonSec) {
      open = open.filter(function (e) { return e > t; });
      if (open.length >= behavior.maxConcurrentTickets) { t = Math.min.apply(null, open); continue; }
      var dur = clamp(behavior.handleMeanSec + (r() + r() + r() - 1.5) * 2 * behavior.handleSpreadSec,
                      behavior.handleClampSec[0], behavior.handleClampSec[1]);
      open.push(t + dur);
      runTicketSession(t, t + dur, agent, agent + ":" + (ticketSeq++));
      t += expSample(r, 3600 / behavior.ticketsPerHour);
    }

    // home checks — FIRST one boots the nav_bar iframe and starts the
    // permanent badge poller; later checks reuse the resident iframe.
    var th = behavior.arrival === "burst" ? r() * 600
           : expSample(r, 3600 / behavior.homeChecksPerHour);
    var firstHome = null;
    while (th < horizonSec) {
      var dwell = behavior.homeDwellSec[0] + r() * (behavior.homeDwellSec[1] - behavior.homeDwellSec[0]);
      if (firstHome === null) { firstHome = th; interaction(th, agent, "home_open", null); }
      else interaction(th, agent, "home_recheck", null);      // resident iframe: no boot; manual refreshes etc.
      runPollers("home", th, th + dwell, agent, null, {});   // gated pollers, dwell only
      th += expSample(r, 3600 / behavior.homeChecksPerHour);
    }
    if (firstHome !== null) runPollers("home_persistent", firstHome, horizonSec, agent, null, {});
  }

  // ── bucket per minute over the measurement window ───────────────────────
  var mStart = measure[0], mEnd = measure[1];
  var mins = Math.ceil((mEnd - mStart) / 60);
  var series = {};
  var fwPerAgent = [];
  for (var m = 0; m < mins; m++) fwPerAgent.push({});
  var updWindows = {}, updPeak = 0;
  var tuChannels = {};
  (profile.ticketUpdateChannels || []).forEach(function (c) { tuChannels[c] = true; });

  for (var e = 0; e < events.length; e++) {
    var ev = events[e];
    if (ev.t < mStart || ev.t >= mEnd) continue;
    var mi = Math.floor((ev.t - mStart) / 60);
    if (!series[ev.channel]) series[ev.channel] = new Array(mins).fill(0);
    series[ev.channel][mi]++;
    fwPerAgent[mi][ev.agent] = (fwPerAgent[mi][ev.agent] || 0) + 1;
    if (tuChannels[ev.channel] && ev.ticketKey) {
      var w = updWindows[ev.ticketKey] || (updWindows[ev.ticketKey] = []);
      w.push(ev.t);
      while (w.length && w[0] < ev.t - 600) w.shift();
      if (w.length > updPeak) updPeak = w.length;
    }
  }

  // synthesized account-wide rollups
  function synth(name, prefix) {
    var out = new Array(mins).fill(0), any = false;
    for (var ch in series) {
      if (ch.indexOf(prefix) !== 0 || ch === name) continue;
      any = true;
      for (var i = 0; i < mins; i++) out[i] += series[ch][i];
    }
    if (any) series[name] = out;
  }
  synth("zendesk.TOTAL", "zendesk");
  synth("asana.TOTAL", "asana");

  // per-agent framework peaks: 1-min and rolling 5-min
  var fwPeak = 0, fw5Peak = 0;
  var agentIds = {};
  for (var m2 = 0; m2 < mins; m2++) for (var a in fwPerAgent[m2]) agentIds[a] = true;
  for (var a2 in agentIds) {
    var run = 0, buf = [];
    for (var m3 = 0; m3 < mins; m3++) {
      var v = fwPerAgent[m3][a2] || 0;
      if (v > fwPeak) fwPeak = v;
      buf.push(v); run += v;
      if (buf.length > 5) run -= buf.shift();
      if (run > fw5Peak) fw5Peak = run;
    }
  }

  return { series: series, minutes: mins, frameworkPeakPerAgentMin: fwPeak,
           frameworkPeakPerAgent5Min: fw5Peak, ticketUpdatePeakPer10Min: updPeak };
}

// ── aggregation across seeds ───────────────────────────────────────────────
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[clamp(Math.floor(p * sorted.length), 0, sorted.length - 1)];
}

function runScenario(profile, scenarioKey, opts) {
  var scen = SCENARIOS[scenarioKey];
  var behavior = Object.assign({}, BASE_BEHAVIOR, scen, opts.behaviorOverride || {});
  behavior.agents = opts.agents || behavior.agents;
  var seeds = opts.seeds || 100;
  // 2.5h horizon: the persistent home pollers ramp up as agents do their first
  // home check, so measure the LAST hour (steady state). Burst measures the
  // first hour to catch the spike.
  var horizon = 9000;
  var measure = behavior.arrival === "burst" ? [0, 3600] : [horizon - 3600, horizon];

  var peaks = {}, totals = {}, fwPeaks = [], fw5Peaks = [], updPeaks = [];
  var sampleSeries = null;

  for (var s = 0; s < seeds; s++) {
    var out = simulateOnce(profile, behavior, 1000 + s * 7919, horizon, measure);
    if (s === 0) sampleSeries = out.series;
    fwPeaks.push(out.frameworkPeakPerAgentMin);
    fw5Peaks.push(out.frameworkPeakPerAgent5Min);
    updPeaks.push(out.ticketUpdatePeakPer10Min);
    for (var ch in out.series) {
      var arr = out.series[ch], pk = 0, tot = 0;
      for (var i = 0; i < arr.length; i++) { if (arr[i] > pk) pk = arr[i]; tot += arr[i]; }
      (peaks[ch] || (peaks[ch] = [])).push(pk);
      (totals[ch] || (totals[ch] = [])).push(tot);
    }
  }
  fwPeaks.sort(function (a, b) { return a - b; });
  fw5Peaks.sort(function (a, b) { return a - b; });
  updPeaks.sort(function (a, b) { return a - b; });

  var channels = {};
  for (var ch2 in peaks) {
    peaks[ch2].sort(function (a, b) { return a - b; });
    var totMean = totals[ch2].reduce(function (x, y) { return x + y; }, 0) / totals[ch2].length;
    var limit = limitFor(ch2, opts);
    var p95 = percentile(peaks[ch2], 0.95), max = peaks[ch2][peaks[ch2].length - 1];
    channels[ch2] = {
      peakPerMin: { p50: percentile(peaks[ch2], 0.50), p95: p95, max: max },
      meanPerMin: Math.round(totMean / 60 * 10) / 10,
      totalPerHourMean: Math.round(totMean),
      limitPerMin: limit,
      pctOfLimitP95: limit ? Math.round(p95 / limit * 100) : null,
      status: limit ? (p95 >= limit ? "OVER" : p95 >= limit * 0.8 ? "WARN" : "OK") : "NO-LIMIT",
    };
  }

  return {
    scenario: scenarioKey, label: scen.label, agents: behavior.agents, seeds: seeds,
    behavior: behavior, channels: channels,
    frameworkPerAgent: {
      perMin: { p50: percentile(fwPeaks, 0.5), p95: percentile(fwPeaks, 0.95), max: fwPeaks[fwPeaks.length - 1], limit: 100 },
      per5Min: { p50: percentile(fw5Peaks, 0.5), p95: percentile(fw5Peaks, 0.95), max: fw5Peaks[fw5Peaks.length - 1], limit: 700 },
    },
    ticketUpdatesPer10Min: { p95: percentile(updPeaks, 0.95), max: updPeaks[updPeaks.length - 1], limit: 30 },
    sampleSeries: sampleSeries,
  };
}

function limitFor(channel, opts) {
  var l = LIMITS[channel];
  if (l === "PLAN") return opts.zendeskPlanCap;
  if (l === "ASANA") return opts.asanaTier === "paid" ? 1500 : 150;
  return l === undefined ? null : l;
}

// ── self-test ──────────────────────────────────────────────────────────────
function selftest() {
  var fails = [];
  function check(name, ok) { if (!ok) fails.push(name); console.log((ok ? "  ok  " : "  FAIL") + " " + name); }
  function sum(arr) { return (arr || []).reduce(function (x, y) { return x + y; }, 0); }

  var prof = {
    interactions: {
      ticket_open_boot: [{ channel: "zendesk", n: 3 }],
      ticket_close: [{ channel: "zendesk.ticketUpdate", n: 1 }],
      home_open: [{ channel: "asana.search", n: 4 }],
    },
    pollers: [
      { name: "tp", periodSec: 30, scope: "ticket", activeWhen: "always", calls: [{ channel: "guru", n: 1 }] },
      { name: "hp", periodSec: 30, scope: "home_persistent", activeWhen: "always", calls: [{ channel: "asana", n: 1 }] },
    ],
    ticketUpdateChannels: ["zendesk.ticketUpdate"],
  };
  var b = Object.assign({}, BASE_BEHAVIOR, { agents: 1, ticketsPerHour: 1, homeChecksPerHour: 4, slackLive: true,
    tabOpenProb: { account: 0, asana: 0, slack: 0, guru: 0 }, createTaskProb: 0,
    handleMeanSec: 300, handleSpreadSec: 0, handleClampSec: [300, 300] });

  var a1 = simulateOnce(prof, b, 42, 3600, [0, 3600]);
  var a2 = simulateOnce(prof, b, 42, 3600, [0, 3600]);
  check("deterministic: same seed → identical series", JSON.stringify(a1.series) === JSON.stringify(a2.series));

  check("zero agents → zero calls", Object.keys(simulateOnce(prof, Object.assign({}, b, { agents: 0 }), 1, 3600, [0, 3600]).series).length === 0);

  var boots = sum(a1.series.zendesk) / 3;
  check("poller math: 9 ticks per 300s session", sum(a1.series.guru) === boots * 9);

  check("home boots once despite ~4 checks/hr", sum(a1.series["asana.search"]) === 4);

  // persistent poller: ticks from first home open to horizon (≈(3600-first)/30)
  var hp = sum(a1.series.asana);
  check("persistent home poller ran a lot (got " + hp + " ticks)", hp > 60);

  check("zendesk.TOTAL = zendesk + ticketUpdate", sum(a1.series["zendesk.TOTAL"]) === sum(a1.series.zendesk) + sum(a1.series["zendesk.ticketUpdate"]));

  check("5-min framework peak >= 1-min peak", a1.frameworkPeakPerAgent5Min >= a1.frameworkPeakPerAgentMin);

  var s1 = simulateOnce({ interactions: { ticket_open_boot: [{ channel: "slack.conversations.history", n: 1 }] }, pollers: [], ticketUpdateChannels: [] },
    Object.assign({}, b, { slackLive: false }), 42, 3600, [0, 3600]);
  check("slackLive=false suppresses slack channels", !s1.series["slack.conversations.history"]);

  // staggered hourly poller: 20 agents in cohorts of 10 → 2 cohorts at offsets
  // 0 and 1800 over a 2h horizon. Cohort 0's t=0 tick predates every agent's
  // first home open (no iframe yet → skipped), so expected = cohort0 x 1 tick
  // (t=3600) + cohort1 x 2 ticks (1800, 5400) = 30 calls in <=3 spike minutes.
  var sprof = { interactions: { home_open: [{ channel: "zendesk", n: 1 }] },
    pollers: [{ name: "sh", periodSec: 3600, scope: "home_persistent", staggered: { cohortSize: 10 }, calls: [{ channel: "asana", n: 1 }] }],
    ticketUpdateChannels: [] };
  var sb = Object.assign({}, b, { agents: 20, ticketsPerHour: 0.0001, homeChecksPerHour: 60 });
  var st = simulateOnce(sprof, sb, 7, 7200, [0, 7200]);
  var stTot = sum(st.series.asana), stMins = (st.series.asana || []).filter(function (v) { return v > 0; }).length;
  check("staggered: 30 calls in <=3 spike minutes (got " + stTot + " in " + stMins + ")", stTot >= 28 && stTot <= 30 && stMins <= 3);

  console.log(fails.length ? "\nSELFTEST FAILED: " + fails.join(", ") : "\nselftest: all green");
  process.exit(fails.length ? 1 : 0);
}

// ── CLI ────────────────────────────────────────────────────────────────────
function pad(v, w) { v = String(v); while (v.length < w) v += " "; return v; }

function main() {
  var args = process.argv.slice(2);
  function flag(name, dflt) { var i = args.indexOf("--" + name); return i >= 0 ? args[i + 1] : dflt; }
  if (args.indexOf("--selftest") >= 0) return selftest();

  var profile = JSON.parse(fs.readFileSync(flag("profile", path.join(__dirname, "load-profile.json")), "utf8"));
  var opts = {
    agents: parseInt(flag("agents", "70"), 10),
    seeds: parseInt(flag("seeds", "100"), 10),
    asanaTier: flag("asana-tier", "free"),
    zendeskPlanCap: parseInt(flag("zendesk-plan-cap", "700"), 10),
  };

  var which = flag("scenario", "all");
  var keys = which === "all" ? Object.keys(SCENARIOS) : [which];
  var results = { profileNote: profile.assumptionsNote || "", params: opts, scenarios: {} };

  keys.forEach(function (k) {
    var res = runScenario(profile, k, opts);
    results.scenarios[k] = res;
    console.log("\n=== " + res.label + " — " + res.agents + " agents, " + res.seeds + " seeds ===");
    console.log(pad("channel", 30) + pad("mean/min", 10) + pad("pk p50", 8) + pad("pk p95", 8) + pad("pk max", 8) + pad("cap/min", 9) + pad("p95 %", 7) + "status");
    Object.keys(res.channels).sort().forEach(function (ch) {
      var c = res.channels[ch];
      console.log(pad(ch, 30) + pad(c.meanPerMin, 10) + pad(c.peakPerMin.p50, 8) + pad(c.peakPerMin.p95, 8) + pad(c.peakPerMin.max, 8) +
        pad(c.limitPerMin === null ? "—" : c.limitPerMin, 9) + pad(c.pctOfLimitP95 === null ? "—" : c.pctOfLimitP95 + "%", 7) + c.status);
    });
    var f = res.frameworkPerAgent;
    console.log("per-agent framework: 1-min peak p95 " + f.perMin.p95 + "/" + f.perMin.limit +
      " · 5-min peak p95 " + f.per5Min.p95 + "/" + f.per5Min.limit +
      " · ticket-updates/10min max " + res.ticketUpdatesPer10Min.max + "/" + res.ticketUpdatesPer10Min.limit);
  });

  var jsonOut = flag("json", null);
  if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify(results, null, 2));
    console.log("\nwrote " + jsonOut);
  }
}

main();
