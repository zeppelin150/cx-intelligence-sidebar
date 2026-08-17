// Drives the REAL api-monitor module with an injectable clock. No test framework.
var mod = require("./api-monitor.js");
var createMonitor = mod.createMonitor, DEFAULT_CONFIG = mod.DEFAULT_CONFIG;

var pass = 0, fail = 0;
function ok(name, cond) { (cond ? (pass++, console.log("  PASS " + name)) : (fail++, console.log("  FAIL " + name))); }

// controllable clock
var clock = 1000000;
var warns = [];
var mon = createMonitor(DEFAULT_CONFIG, { now: function () { return clock; }, onWarn: function (w) { warns.push(w); } });

console.log("1) rolling-window count + %-of-limit (Asana 150/min)");
for (var i = 0; i < 120; i++) mon.record("asana", { status: 200 });
var rep = mon.report();
ok("counts 120 asana calls in window", rep.asana.countInWindow === 120);
ok("computes 80% of 150 limit", rep.asana.pctOfLimit === 80);
ok("status flips to WARN at >=80%", rep.asana.status === "WARN");
ok("WARN hook fired", warns.some(function (w) { return w.level === "WARN" && w.channel === "asana"; }));

console.log("2) window pruning — advance clock 61s, counts reset");
clock += 61000;
rep = mon.report();
ok("asana window emptied after 61s", rep.asana.countInWindow === 0 && rep.asana.status === "OK");

console.log("3) 429 breach + Retry-After capture (Slack)");
mon.record("slack.chat.postMessage", { status: 429, retryAfter: "30" });
var br = mon.breaches();
ok("breach recorded", br.length === 1 && br[0].channel === "slack.chat.postMessage");
ok("Retry-After 30s parsed to 30000ms", br[0].retryAfterMs === 30000);
ok("BREACH hook fired", warns.some(function (w) { return w.level === "BREACH"; }));

console.log("4) Retry-After parsing — seconds vs HTTP-date");
ok("integer seconds", mon.parseRetryAfter("93", clock) === 93000);
var future = new Date(clock + 45000).toUTCString();
var d = mon.parseRetryAfter(future, clock);
ok("HTTP-date -> ~45s", d >= 44000 && d <= 46000);
ok("garbage -> null", mon.parseRetryAfter("nonsense", clock) === null);

console.log("5) Guru has no documented limit — status UNKNOWN-LIMIT, not a false breach");
mon.record("guru", { status: 200 });
rep = mon.report();
ok("guru limit is null", rep.guru.limit === null);
ok("guru status UNKNOWN-LIMIT", rep.guru.status === "UNKNOWN-LIMIT");
ok("guru flagged uncertain", rep.guru.uncertain === true);

console.log("6) Zendesk remaining-quota HEADER drives WARN before local count would");
// one call, but header says only 5 of 100 remain -> proactive WARN
mon.record("zendesk", { status: 200, responseHeaders: { "X-Rate-Limit": "100", "X-Rate-Limit-Remaining": "5" } });
ok("zendesk WARN from header (5/100 remaining)", warns.some(function (w) { return w.level === "WARN" && w.channel === "zendesk"; }));

console.log("7) conversations.history carries the 1/min-vs-50/min uncertainty note");
rep = mon.report();
ok("history flagged uncertain", rep["slack.conversations.history"].uncertain === true);
ok("note mentions the non-Marketplace cliff", /non-Marketplace/.test(rep["slack.conversations.history"].note));

console.log("8) watch() auto-records from a resolved promise");
var p = Promise.resolve({ ok: true });
mon.watch(p, "asana", { onOk: function () { return { status: 200 }; } }).then(function () {
  var r = mon.report();
  ok("watch recorded one asana call", r.asana.countInWindow >= 1);

  console.log("\n--- sample report() output ---");
  console.log(JSON.stringify(mon.report(), null, 2));
  console.log("\n" + (fail === 0 ? "ALL " + pass + " ASSERTIONS PASSED" : pass + " passed, " + fail + " FAILED"));
  process.exit(fail === 0 ? 0 : 1);
});
