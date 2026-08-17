# API Rate-Limit Monitoring — CX Intelligence Sidebar

A lightweight, dependency-free framework to **measure how close the app runs to each vendor's
API rate limit**, so we can see headroom, catch throttling early, and size usage before it
becomes a production incident.

- **`api-monitor.js`** — the instrumentation module (ES5, drop-in, no deps).
- **`api-monitor.test.js`** — 18 assertions driving the real module (`node api-monitor.test.js`).
- This doc — the rate-limit reference it's built on, how to wire it in, and how to read it.

---

## 1. The core reality it's designed around

**Only Zendesk exposes a "remaining quota" response header. Asana, Slack, and Guru do not —
they only signal a breach *after the fact* with `HTTP 429 + Retry-After`.** On top of that, the
app's vendor calls go through **Zendesk's secure proxy** (`client.request({secure:true})`), which
returns a parsed body and status to the browser but generally **not** the vendor's response
headers. 

So the honest, implementable measurement strategy is:

| Signal | Availability | What the monitor does |
|---|---|---|
| **Local request count** in a rolling window | Always | Primary metric — count calls per channel, compare to the documented limit |
| **`429` status** | All vendors | Authoritative breach signal — recorded as a breach |
| **`Retry-After`** (on 429) | Documented for Asana/Slack/Zendesk; unknown for Guru | Parsed (delta-seconds **or** HTTP-date) for backoff |
| **Remaining-quota headers** | **Zendesk only**, and only if the proxy surfaces them | Used for *proactive* headroom when present; otherwise ignored |

The monitor therefore treats **client-side counting as the source of truth** and uses headers
only as a bonus where they exist.

---

## 2. Rate-limit reference (from vendor docs, 2026-07)

| Vendor | Limit that applies to our usage | Window | Breach headers | Confidence |
|---|---|---|---|---|
| **Asana** | **150/min** per token (free domain) · **1500/min** (paid). Search endpoints: **60/min**. Concurrency: **50** in-flight GET, **15** in-flight write. Plus an undocumented cost-based quota. | per minute, per auth token | `Retry-After` (seconds) on 429 — **no** remaining header | High |
| **Slack** | `chat.postMessage`: **~1 msg/sec per channel** (+ soft "several hundred/min" per workspace). `conversations.history`: **50+/min** (Tier 3) for Marketplace/internal apps — **but 1/min** for non-Marketplace apps created/installed after 2025-05-29. | per minute, per method, per workspace | `Retry-After` (seconds) on 429 — **no** remaining header | High |
| **Guru** | **None published.** No numeric limit, window, or documented 429/`Retry-After` for the public v1 API. | unknown | unknown | **Low — treat as unknown** |
| **Zendesk** | Account cap (Support + Help Center combined): Team **200** · Growth/Pro **400** · Enterprise **700** · Ent+ **2500**/min. Apps-framework `client.request`: **100/min per user per app**. Ticket updates: 30/10min/user/ticket + 100/min/account. | per minute (ticket-update per-user is per 10 min) | `X-Rate-Limit` / `X-Rate-Limit-Remaining`, `ratelimit-limit/remaining/reset`, `Retry-After` (seconds) | High |

**Sources:** Asana <https://developers.asana.com/docs/rate-limits> · Slack
<https://docs.slack.dev/apis/web-api/rate-limits/> · Zendesk
<https://developer.zendesk.com/api-reference/introduction/rate-limits/> · Guru (no official
limit page; only a retired-forum staff note).

### ⚠ Three things to resolve before trusting the numbers
1. **Slack `conversations.history` is a 50× cliff.** It's 50/min *only* if this app is
   Marketplace-approved or internal; otherwise it's **1/min** (max 15 objects/call) for apps
   created/installed after 2025-05-29. **Confirm this app's distribution class** — the config
   defaults to the optimistic 50 and flags the channel `uncertain`.
2. **Guru is unknown.** Don't set a Guru limit from a guess. The monitor reports Guru as
   `UNKNOWN-LIMIT` and only reacts to a real 429. Verify empirically or via Guru support.
3. **Asana's cost-based quota** can 429 you *independently* of the 150/1500 count and isn't
   observable via any header — the monitor can only react to it, never predict it.

---

## 3. Wiring it into the app

Load `api-monitor.js` once (it attaches `window.__apiMonitor`). Then record at each existing API
choke point. Two ways:

**A. Wrap the request promise** (cleanest — mirrors the `guruApi` instrumentation pattern):

```js
// app.js — asanaApi (~L798), slackApi (~L1783), guruApi (~L2319), guru_modal.js (~L83)
return window.__apiMonitor.watch(client.request(req), "asana", {
  onOk:  function (r) { return { status: 200 }; },
  onErr: function (e) { return { status: (e && e.status) || 0,
                                 retryAfter: e && e.responseJSON && e.responseJSON.retry_after }; }
});
```

Channel names to use: `"asana"` (create/find/comment), `"asana.search"` (dedupe/typeahead),
`"slack.chat.postMessage"`, `"slack.conversations.history"`, `"guru"`, `"zendesk"` (raw
`client.request` to the Zendesk API + custom-object reads), and the handle-time POST.

**B. Record manually** where wrapping is awkward:

```js
window.__apiMonitor.record("slack.chat.postMessage", { status: resp.ok ? 200 : 429,
                                                        retryAfter: resp.headers && resp.headers["retry-after"] });
```

> The `secure:true` proxy usually hides vendor response headers, so `onErr` mostly gets a bare
> `status`. That's fine — counting + the 429 status is the ground truth. If you ever move a call
> to the broker (server-side), pass the real `responseHeaders` through and the monitor will read
> `Retry-After` / remaining automatically.

---

## 4. Reading the measurements

Everything is on `window.__apiMonitor`:

- **`report()`** — the at-a-glance table: per channel `{ countInWindow, limit, pctOfLimit,
  status, inflight, breaches, uncertain, note }`. `status` is `OK` / `WARN` (≥80%) / `OVER` /
  `SEEN-429` / `UNKNOWN-LIMIT`.
- **`breaches()`** — every 429 with its parsed `retryAfterMs`.
- **`events()`** — the raw ring buffer (last 500 calls) for drill-down.
- **`onWarn` hook** (constructor option) — fires on every WARN/BREACH; point it at the console,
  a toast, or the handle-time collector to ship aggregates out.

Example: open DevTools on a ticket and run `window.__apiMonitor.report()` after exercising the
tabs — any channel at `WARN`/`OVER` or with `breaches > 0` is where you're hitting limits.

### Tuning
- `warnRatio` (default **0.8**) — when to flag WARN.
- Override a channel `limit` to match reality: set Asana to `1500` if on a paid domain; set
  `slack.conversations.history` to `1` if the app is confirmed non-Marketplace; raise `zendesk`
  to the plan cap if you're measuring the account-wide limit rather than the 100/min app cap.

---

## 5. What this does and doesn't do

**Does:** measure request rate per vendor/endpoint against documented limits; catch 429s and
parse Retry-After; expose live headroom; flag the uncertain limits so nobody trusts a guess.

**Doesn't:** enforce limits or throttle (it's measurement, not a rate limiter — though `onWarn`
+ `breaches()` give you what you'd need to add backoff); predict Asana's cost-based quota or any
Guru limit (undocumented); read vendor headers that the secure proxy strips.
