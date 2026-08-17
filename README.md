# CX Intelligence Sidebar

A Zendesk-hosted ZAF v2 app that gives support agents a single sidebar for the systems around a ticket: **Asana** (linked tasks, comments, task creation with dedupe), **Slack** (ticket threads, channels, workflow requests), **Guru** (suggested cards, search/browse, AI answers, reader), a **local-only ticket digest** (Summary landing pane — computed entirely in the iframe, zero new egress), and **per-feature handle-time telemetry** (AHT) written to ticket fields for Explore reporting.

**Version: 3.10.0** — the "tier-fit" build: engineered so a 70-agent fleet at ~15 open Asana tasks/agent fits inside every vendor's conservative rate tier at once (single free-tier Asana PAT: 79% p95; Slack Tier-3 bot token: 64%; Zendesk plan cap: 11%). See `docs/API_LOAD_SIMULATION.md` for the full simulation and `docs/pilot-load-readout.html` for the visual readout.

## Repo layout

| Path | What it is |
|---|---|
| `app/` | The deployable ZAF app: `manifest.json`, `assets/` (app.js = ticket sidebar, home.js = nav-bar home view, guru_modal.js = reader), `translations/`, `.zcliignore` |
| `harness/` | Browser test harnesses — no live credentials required. `runner.html`: 24 adversarial scenarios for AHT/Guru/Slack (sidebar). `home-runner.html`: 7 scenarios proving the home view's API budget (daily refresh, lazy boot, zero-call warm boot). `mock-zaf.js` mocks the ZAF client with a virtual clock + request recording. `slack-live.html`: optional live-Slack sandbox (tokens passed via URL fragment at runtime). |
| `monitoring/` | `api-monitor.js` — drop-in rate-limit monitor for the pilot (18-assertion test suite). `load-sim.js` + `load-profile*.json` — the offline Monte-Carlo load simulator and the per-interaction call profiles extracted from source (variants: as-shipped, gated, hourly-staggered, daily, tier-fit). `load-sim-results*.json` — seeded results. |
| `docs/` | `API_LOAD_SIMULATION.md` (the 70-agent load study + verified vendor rate limits), `SUPPLY_CHAIN_AUDIT.md`, `pilot-load-readout.html` (self-contained visual readout — open in any browser) |

## Quickstart

Run the test suites headless (Chrome required):

```bash
chrome --headless --allow-file-access-from-files --virtual-time-budget=120000 --dump-dom harness/runner.html | grep 'id="status"'
```

```bash
chrome --headless --allow-file-access-from-files --virtual-time-budget=14000000 --dump-dom harness/home-runner.html | grep 'id="status"'
```

Expected: `Done: 24/24 passed` and `Done: 7/7 passed`.

Run the load simulation (Node ≥ 18):

```bash
node monitoring/load-sim.js --seeds 200 --profile monitoring/load-profile-t15-tierfit.json
```

## Deploying

1. **Flip `DEMO_MODE` to `false`** at the top of `app/assets/app.js` (it ships `true` so the app renders labeled sample data with no settings).
2. From `app/`: `zcli apps:create` (first time) or add a local `zcli.apps.config.json` with your `app_id` and run `zcli apps:update`. Account-specific config is deliberately **not** in this repo — see below.
3. Install settings: every parameter is defined with helpText in `app/manifest.json`. The four credentials (`asana_pat`, `slack_bot_token`, `slack_search_token`, `guru_auth`) are `secure: true` — injected server-side by Zendesk's proxy, never visible in the browser.
4. Rate-budget guidance (from the load study): keep `slack_channel_ids` to ~2 channels; the Slack app must be an **internal** (org-created) app — internal apps keep Tier-3 limits.
5. Wire `monitoring/api-monitor.js` into the API chokepoints for the pilot (`asanaApi`, `slackApi`, `guruApi`, `client.request`) and set `autoRetry: false` on instrumented calls so 429s are observable — client-side counting is the pilot's source of truth.

## What is deliberately excluded

Account-specific and identity-carrying files are kept out of this repo by design (and by `.gitignore`): `zcli.apps.config.json` (app ids), `settings.yml` (local-dev field GIDs), any `.env`. Doc copies here refer to `<sandbox-app-id>` / "the dev sandbox" where the private originals name real accounts. The one org reference that remains is a public help-center article URL inside `app/assets/asana_form_config.json` (form help text the app renders).

## The 3.10.0 rate-limit design, in one paragraph

Older builds polled Asana every 30 seconds from two ungated timers — ~2,200 req/min fleet-wide on one shared PAT. 3.10.0 replaces that with: a **once-daily background rebuild** per agent at a personal time slot (spread by email hash; jittered catch-up; 24h-elapsed fallback for after-hours slots), a **cached snapshot** rendered instantly on open (zero calls), **per-card ↻ / Refresh-all** for on-demand freshness, a **foreground gate** on the sidebar's badge poll, **lazy-loading** Slack panes, and a 60s Slack sync. The behavior is enforced by `harness/home-runner.html` — cold boot fires exactly one search per unsolved ticket plus one comment sweep; a warm boot fires **zero** requests.
