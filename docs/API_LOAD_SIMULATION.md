# API Load Simulation â€” 70-Agent Pilot Profile

**Date:** 2026-08-16 Â· **App:** 3.9.0 (`v2.9.2/cx-client-data-sidebar-v2.9.0`) Â· **Method:** offline Monte-Carlo replay of the app's real per-interaction call profile â€” **zero requests sent to any live instance.**

## Why simulate instead of hitting the dev sandbox

Deliberately driving traffic at Zendesk to probe rate limits â€” sandbox included â€” falls under the Main Services Agreement Â§2.2 prohibited uses ("attempt to bypass or break any â€¦ rate limiting mechanism", "interfere with â€¦ performance of the Services"); Zendesk is multi-tenant and publishes no load-test approval channel. The compliant live measurement is **passive**: wire `monitoring/api-monitor.js` into the call chokepoints during the pilot and read `x-rate-limit-*` headers + 429s from real traffic. (Gotcha for that instrumentation: ZAF `client.request` auto-retries 429s â€” set `autoRetry:false` to observe raw breaches.)

## How it works

- `monitoring/load-profile.json` â€” every network call each interaction fires, extracted from the 3.9 source with file:line refs (boot sequence, tab switches, pollers, AHT flushes), then adversarially re-verified against the code.
- `monitoring/load-sim.js` â€” seeded Monte-Carlo engine (deterministic per seed; selftest built in). Models: Poisson ticket arrivals (10/hr/agent, â‰¤2 concurrent ticket tabs), home checks (2/hr/agent), pane-visit probabilities, debounced searches, poller lifetimes **matching the real gating semantics** â€” which is where the story is.
- Limits verified against vendor docs 2026-08-16 (they correct two assumptions in THREAT_MODEL.md â€” see table).

```bash
node monitoring/load-sim.js --seeds 200 --json monitoring/load-sim-results.json
```

Scenario knobs: `--agents`, `--scenario core|slack|burst`, `--asana-tier free|paid`, `--zendesk-plan-cap 200|400|700|2500`, `--profile <variant.json>`.

## The structural finding: two ungated pollers dominate everything

1. **Home badge poll** (`home.js:198â€“219`): 1 Asana `stories` GET per task card every 30 s, **no `document.hidden` gate, no pane gate, never cleared** (contrast `home.js:543`, where the sibling 45 s poll *does* gate â€” the omission is real, not stylistic). The nav_bar iframe persists once opened â€” so an agent's *first* home check of the day starts a permanent ~10 req/min drain (at 5 cards) that runs until logout. "Checking home twice an hour" costs almost nothing per check; the *first* check costs everything thereafter.
2. **Sidebar badge poll** (`app.js:1442â€“1512`): same pattern per open ticket tab once the Asana pane has shown a task; ZAF keeps deactivated sidebars resident.

Side-effect found during verification: on detecting new Asana comments, the sidebar poll **force-reopens the ticket** (`client.set('ticket.status','open')`, `app.js:1477â€“1479`) â€” a state-changing write fired from an ungated background timer on a possibly-backgrounded ticket. Gate it with the poller.

Everything else (boots, tab loads, AHT writes, Guru, Slack sync) is well-behaved: cached per session, debounced, or properly gated.

## Results â€” 70 agents, steady-state hour, 200 seeds

Assumptions marked in the profile: 8 unsolved tickets/agent, 5 home task cards, 60 % of tickets have ~1.8 linked tasks, 3 Slack channels. A half-sized "light" variant confirms every OVER below stays OVER.

| Channel (shared bucket) | mean/min | peak p95 | cap/min | p95 % of cap | status |
|---|---|---|---|---|---|
| **Asana total (one PAT)** | **762** | **813** | **150 free / 1500 paid** | **542 % / 54 %** | **OVER free Â· OK paid** |
| Asana search endpoints | 19 | 38 | 60 | 63 % | OK (OVER in 9 am burst: p95 133) |
| Slack `conversations.history` (bot token) | 19 | 49 | 50 (Tier 3, internal app) | **98 %** | **WARN Â· OVER in burst (p95 116)** |
| Zendesk account (all REST incl. AHT) | 146 | 278 | 700 Ent (200 Team) | 40 % (139 % on Team) | OK on Ent Â· **OVER on Team-tier cap** |
| Zendesk ticket-update sublimit | 22 | 42 | 100 | 42 % | OK |
| Guru (no published limit) | 29 | 60 | â€” | â€” | report-only |
| Per-agent framework (1-min / 5-min) | â€” | 57 / 155 | 100 / 700 | 57 % / 22 % | OK |
| AHT updates per agent+ticket / 10 min | â€” | max 5 | 30 | 17 % | OK â€” AHT design is safe |

**The AHT telemetry everyone worried about is nowhere near its caps.** The badge pollers are the problem.

## The fix, quantified

Gating both Asana pollers exactly like `slackSyncTick` already is (`!document.hidden` + pane-active) â€” run `--profile monitoring/load-profile-gated.json`:

| Channel | ungated | gated | result |
|---|---|---|---|
| Asana total mean/min | 762 | **65** | 12Ã— reduction â€” free tier survives (p95 125/150, WARN), paid trivial |
| Per-agent framework 5-min p95 | 155 | 111 | headroom improves |

Slack `history` stays cap-riding after the Asana fix (it's already gated; the load is boots + sweeps): mitigations are dropping the home boot's double sweep of the same channels (6â†’3 calls), stretching the 30 s sync to 60â€“90 s, and keeping scoped channels â‰¤2. Structural reality: one bot token Ã· 70 agents = 0.7 calls/agent/min on every Tier-3 method.

### Alternative considered: hourly home pollers, staggered

Modeled 2026-08-16 (`load-profile-hourly-c10.json` / `-c1.json`): both home pollers (Asana badges + Slack requests) fire once per hour instead of every 30/45 s, staggered across agents. The mean collapses either way (Asana 762 â†’ 83/min), but **cohort granularity decides whether the peaks survive** â€” rate caps are per-minute windows, and a cohort's calls land in the same minute bucket:

| Design | Asana mean/min | Asana peak p95 (free cap 150) | Slack history p95 (cap 50) |
|---|---|---|---|
| As shipped (30 s, ungated) | 761 | 812 â€” **542 % OVER** | 49 â€” 98 % WARN |
| Hourly, cohorts of 10 | 83 | 160 â€” **107 % still OVER** | 68 â€” **136 % OVER, worse than today** |
| Hourly, per-agent stagger (70 slots â‰ˆ 51 s apart) | 83 | 128 â€” 85 % WARN | 47 â€” 94 % WARN |
| Visibility-gating (30 s kept) | 65 | 125 â€” 83 % WARN | 49 â€” 98 % WARN |

Cohorts of 10 fail because 10 agents Ã— 5 stories = 50 Asana calls (plus 30 Slack) hit one minute together, stacked on the ~110/min baseline peak â€” and today's Slack home poll is dwell-gated and diffuse, so replacing it with synchronized unconditional bursts is a regression. Per-agent stagger fixes both and lands statistically equal to visibility-gating. Implementation note: no coordination needed â€” each iframe picks a random offset in [0, 1h) at boot (`setTimeout(jitter)` then hourly `setInterval`), which is per-agent stagger by construction. Trade-off vs gating: hourly polling makes badges/comment toasts up to an hour stale (and should retire the poll's force-reopen side effect); pair it with an immediate refresh when the home pane becomes visible to keep perceived freshness. Morning-burst boot fan-outs are unaffected by either design (Asana search still breaches in the 9 am burst â€” stagger logins or lazy-load the home pane).

### Heavy fleet: 15 open Asana tasks per agent, and PAT sharding

Re-run 2026-08-16 with 15 home cards + ~1.9 linked tasks per ticket (`load-profile-t15-*.json`). At this shape the poller cost scales with task count and the picture hardens â€” as-shipped hits **2,171/min mean, 1.45Ã— over even the paid 1,500/min cap**, and per-agent framework p95 reaches 78/100. Asana allocates limits **per authorization token** (verified), so splitting agents across N PATs gives N independent buckets. Asana p95 peak vs the per-PAT cap:

| Design (15 tasks/agent) | 1 PAT (70 ag) | 3 PATs (24 ag each) | 4 PATs (18 ag each) |
|---|---|---|---|
| As shipped (30 s ungated) | 2,272 â€” over **paid** | 797 â€” 5.3Ã— free / 53 % paid | 602 â€” 4Ã— free / 40 % paid |
| Hourly, per-agent stagger | 212 â€” 141 % free | **97 â€” 65 % free âœ“** | **80 â€” 53 % free âœ“** |
| Visibility-gated 30 s | 298 â€” 199 % free | 144 â€” 96 % free (WARN) | 128 â€” 85 % free (WARN) |

**Hourly-staggered polling + 3â€“4 PAT shards fits the free Asana tier with headroom; sharding alone cannot save the as-shipped poller on free (still 4â€“5Ã— over per shard).**

**Single-PAT constraint (decided 2026-08-16):** with one shared PAT, the Asana domain tier decides. **Paid (1,500/min): the daily-spread design fits everywhere** â€” steady p95 201 (13 %), worst-case 9 am burst 427 max (28 %). **Free (150/min): daily-spread + gated sidebar fits steady state at 80 % p95, but** (a) the synchronized-morning burst still breaks it (p95 382, 255 % â€” driven by home-boot sweeps of 15 stories + 8 searches per agent compressed into 10 min, not by pollers; `asana.search` also breaches at 227 %), and (b) the growth ceiling is ~85â€“90 agents (90 agents â†’ 97 % p95). The free-tier-safe completion is the same lazy-load move the daily design implies anyway: don't fire the 15-story + 8-search sweep on home first-open â€” render from cache and let the daily slot / manual refresh populate â€” which also removes the home double-sweep driving the Slack burst breach. The durable single-PAT endgame remains the modified-since sweep (one list call per update, cost independent of task and agent count).

**Daily-update variant (proposed 2026-08-16):** background home update once per day per agent â€” groups of ~20 every 2 h â€” plus manual per-task refresh (modeled at ~3 refreshes per home visit; `load-profile-t15-daily-*.json`, Zendesk plan cap 2,500). The background cost collapses to ~2/min fleet-wide and manual refreshes are noise (~7/min). Two findings: (1) firing a group of 20 synchronized puts 20 Ã— 15 = 300 calls in one minute â€” p95 456, 3Ã— the free cap in the spike minute (fine on paid); spreading agents within the slot (equivalently: each agent at a fixed personal time daily) removes it entirely. (2) With the home poller nearly free, the **ungated sidebar 30 s poll becomes the dominant term** (~66/min) and alone keeps a single free PAT over cap (p95 201, 134 %). Daily-spread + gated sidebar = **p95 120, 80 % of free on ONE PAT** â€” no sharding needed; 3 PATs drops it to 40 % for comfort. Zendesk at the 2,500/min plan cap: the sidebar's entire account-wide footprint is ~145/min mean / ~278 p95 â‰ˆ 11 % â€” a non-issue, with the caveat that the binding Zendesk caps are the ones that don't scale with plan (100 ticket-updates/min account sublimit at 41 %, per-agent 100/min + 700/5 min app caps at â‰¤ 57 %/18 %), and the 2,500 bucket is shared with every other integration the org runs. Mechanics: one `asana_pat` secure setting per app install, so sharding = multiple private-app copies each restricted to an agent group (and/or one install per Zendesk account if agents genuinely work in two accounts), each carrying its own PAT from its own Asana service user. Costs to weigh: N app copies must deploy in lockstep (the wrong-cwd footgun Ã—N), N PATs to rotate, task/comment attribution varies by shard's service user, and PAT sharding does nothing for the per-agent ZAF framework cap (per user per app) or for Slack (whose per-method buckets are per bot token â€” the same sharding trick applies there if ever needed). Two structural alternatives before committing: (a) per-agent Asana OAuth would give every agent an independent bucket â€” verify whether ZAF OAuth settings mint per-user or per-install tokens; (b) replace per-task `stories` polling with one project-scoped list call per sweep (`GET /projects/{id}/tasks?opt_fields=modified_at` â€” non-search bucket) and fetch stories only for changed tasks â€” cost becomes independent of task count and the sharding question mostly dissolves.

## Rate-limit corrections vs THREAT_MODEL.md (verified 2026-08-16)

- **Slack 1/min `conversations.history` cliff does NOT apply to us** â€” it targets commercially-distributed non-Marketplace apps; "Internal customer-built applications are not impacted" (Slack changelog 2025-05-29 + 2025-06-03). Internal app â‡’ Tier 3 (50/min). This resolves the pilot plan's week-2 gate.
- **Zendesk has a second per-agent cap the model missed:** 700 requests per 5 min per user per app (â‰ˆ140/min sustained), alongside the 100/min client cap. Sim tracks both.
- Ticket updates also have an **account-wide 100 updates/min sublimit** (300 with High Volume) â€” sim tracks it (42 % used).
- Whether proxied vendor calls count against the 100/min framework cap is **undocumented** â€” the sim takes the conservative reading (they do). Pilot telemetry should settle it.
- Trial/sandbox accounts have **no published rate limit**; read `x-rate-limit` headers on the dev sandbox empirically (passive, compliant).
- Asana limits are per **token**: one shared PAT = one 150-or-1500/min bucket + one 60/min search bucket for the whole fleet. Whether the workspace is on a paid Asana plan is a 10Ã— variable â€” confirm before the pilot.
- Guru publishes no numeric limits (verified absence); monitor 429s empirically.
- **Zendesk Search has its own budget** the monitoring doc missed: `search.json` responses carry a dedicated `Zendesk-RateLimit-search-index` header (plus a 1,000-results-per-query cap). This app leans on search hard â€” 4 calls per ticket boot + 1 per home boot â‰ˆ **47/min fleet-wide** inside the general Zendesk numbers above. Watch that header specifically in the pilot (channel added to `api-monitor.js`). The Export Search 100/min/account cap doesn't apply (we never call export).

## The tier-fit configuration (final, 2026-08-16)

Constraint set: **one Asana PAT at free-tier caps, one Slack bot token at published method tiers, self-imposed Guru budget, Zendesk non-scaling caps** â€” despite being on Enterprise (Zendesk 2,500/min plan). Config (`load-profile-t15-tierfit.json`), at 15 tasks/agent:

1. Home background update: **once per day per agent, individually spread** (never grouped) â€” the daily slot does the full rebuild (8 searches + 15 stories); manual per-card refresh for freshness.
2. **Sidebar 30 s badge poll gated** on visibility + pane-active (and the force-reopen retired).
3. **Lazy home boot**: first open renders cached â€” no 15-story sweep, no 8-search rebuild, single Slack sweep.
4. Slack economies: **2 scoped channels**, sync tick 30 s â†’ **60 s**, home double-sweep collapsed.

Result @70 agents, 200 seeds â€” **steady state all green**: Asana 119/150 p95 (79 %), search 39/60 (65 %), Slack history 32/50 (64 %, next-highest method 28 %), Guru 59 p95 (no cap â€” proposed self-budget: alert at 60/min fleet, back off on any 429), Zendesk 11 % of plan / updates 40 % / framework 49 & 102 of 100 & 700 / per-ticket 5 of 30. Worst-case 9 am burst: everything fits except Slack history p95 55/50 (110 %) â€” lazy-load the home Slack tabs too (defer to first view, matching the Asana treatment) or accept the brief self-healing brush (429 + Retry-After + ZAF auto-retry); real logins spread over > 10 min don't hit it at all. Growth headroom at these caps: ~90 agents (Asana p95 â†’ ~145) before the modified-since sweep redesign is needed.

## Verification

The profile, the engine, and the results were adversarially verified (3 independent agents, 2026-08-16):

- **Code check â€” confirmed with corrections.** Both ungated pollers, the nav_bar persistence, the home boot fan-out, and the single-PUT AHT design verified against source with line refs. Corrections applied: production boot is 10â€“12 Zendesk GETs depending on org/triage config (profile's 11.2 expectation is exact); `slackSyncTick`'s sweep and thread-refresh are alternatives, not additive (sim slightly over-counts Slack sync â€” conservative); `DEMO_MODE` is hardcoded `true` in this source copy and must be flipped for any live build.
- **Math check â€” sound.** All six steady-state channel means re-derived analytically from the profile, blind to the engine: agreement within Â±6 % on every channel (threshold Â±20 %). The headline is analytically real: 70 agents Ã— 2 ticks/min Ã— 5 stories = **700/min from the home poller alone**, independent of ticket volume. The residual ~5 % is realized-vs-offered session throughput under the 2-concurrent-tabs cap, uniform across channels.

## Recommendations, in order

1. **Gate both Asana badge pollers** (visibility + pane-active, mirroring `slackSyncTick`) before the pilot. This is the difference between "free Asana tier melts in hour one" and "comfortable."
2. **Confirm the Asana workspace tier**; if free, the gated fix is mandatory, not optional.
3. Collapse the home boot's duplicate Slack sweep; consider 60 s Slack sync.
4. Wire `api-monitor.js` (with `autoRetry:false` on instrumented calls) â€” the pilot's numbers, not this sim, are the source of truth.
5. Re-run this sim when behavior assumptions get real data (`--profile` variants make sensitivity one command).
