# Supply-Chain Audit â€” CX Intelligence Sidebar 3.9.0

**Date:** 2026-08-16 Â· **Target:** `v2.9.2/cx-client-data-sidebar-v2.9.0` (manifest 3.9.0) plus everything that touches its deploy pipeline.
**Scanners:** npm audit (GitHub Advisory DB), retire.js 5.4.3. **Snyk:** skipped â€” CLI not installed and no `SNYK_TOKEN` present; npm audit covers the same advisory feed for npm trees. Raw scan JSON preserved in the session scratchpad (`scans/`).

## Verdict

**The shipped app has no third-party code to attack.** The production bundle is hand-written vanilla JS â€” no npm dependencies, no vendored libraries (verified by signature/banner/minified-blob scan + retire.js clean), no CDN scripts except the mandatory Zendesk ZAF SDK. The real supply-chain surface is the **deploy tool (zcli)** and **dev-side tooling**, which is where all findings live.

## Findings

| # | Severity | Component | Finding | Action |
|---|----------|-----------|---------|--------|
| 1 | High | `@zendesk/zcli` 1.0.0-beta.53 (deploy path) | `adm-zip` <0.6.0 â€” crafted ZIP triggers 4 GB alloc (GHSA-xcpc-8h2w-3j85). **No upstream fix**; pinned by `@zendesk/zcli-apps`, which packages/uploads our app zip. Exploitation needs a malicious zip input; our zips are self-built â†’ DoS-only, low practical risk. | Monitor `@zendesk/zcli` releases; re-audit before each deploy. Never run `zcli apps:*` against zips from outside the repo. |
| 2 | Moderate | `@zendesk/zcli` (deploy path) | `uuid` <11.1.1 buffer bounds (GHSA-w5hq-g745-h8pq); vulnerable path (caller-supplied buf) unlikely exercised by zcli. | Same monitoring as #1. |
| 3 | High | `tmp/brief-docx` (doc tooling only) | `nanoid` 4.0.0â€“5.1.15 infinite loop on negative size (GHSA-28wg-ghj8-5hjv). Local doc-build only, never deployed. | `npm audit fix` in `tmp/brief-docx` (non-breaking). |
| 4 | High (fixable) | `asana-broker` (future service) | pip-audit of the broker's **actual venv** (`tmp/venv-asana` â€” the env `broker-live.out` shows running): **7 known vulns in 2 packages** â€” `cryptography` 48.0.0 (PYSEC-2026-3552/3553/3554, GHSA-537c-gmf6-5ccf; fixed 48.0.1+) and `starlette` 1.2.1 (PYSEC-2026-248/249; fixed 1.3.0+). Deps are floor-pinned with no lockfile, so fresh installs resolve differently than the vulnerable env in use. | `pip install -U cryptography starlette` in the venv now; add `requirements.lock` (pip-compile) + pip-audit in CI before the broker ever deploys. |
| 5 | Accepted platform risk | All three bundle HTML files + broker static pages | ZAF SDK loaded from `static.zdassets.com/.../2.0/zaf_sdk.min.js` â€” major-version pin, minor/patch float, **no SRI hash**. This is Zendesk's required pattern; Zendesk's CDN can change the executed code at any time. | Accept (platform trust already assumed); note in THREAT_MODEL. |
| 6 | Track | Bundle data input | `assets/asana_form_config.json` ships in the bundle and is *generated from a live Asana endpoint response* (`tools/gen_form_config.py`). Third-party **data**, not code, entering the package. | Diff-review the file on every regeneration (it already carries org form content). |

retire.js: **0 findings** across the 3.9 bundle, `harness/`, root `assets/` (stale v2.10), and `asana-broker/` â€” expected for hand-written code; retire only recognizes known libraries, so this proves "no known-vulnerable library versions," not "no bugs."

## Trust-boundary inventory (what runs where)

| Component | Kind | Third-party code | Notes |
|-----------|------|------------------|-------|
| 3.9 bundle (`v2.9.2/â€¦`) | **Production** (Zendesk-hosted iframe) | ZAF SDK only | domainWhitelist: app.asana.com, slack.com, api.getguru.com. 4 secure params injected server-side by Zendesk proxy â€” tokens never reach the browser. No oauth block. |
| `@zendesk/zcli` (global npm) | **Deploy tool** | ~277 packages | Runs on this workstation *with Zendesk credentials* at deploy time. Beta release train. Biggest real attack surface in the chain. |
| `asana-broker/` | Future standalone service | fastapi/uvicorn/httpx/pyjwt/dotenv (unpinned) | Different trust boundary if ever activated: app HTML/JS would be served from `broker.internal.alma` instead of Zendesk-hosted upload. |
| `claims-handoff-gas/` | Google Apps Script | none by design | Platform trust = Google. |
| `harness/`, `monitoring/`, `tools/` | Dev-side | none (one repro page loads live ZAF SDK) | Never packaged (`.zcliignore`). |
| `tmp/brief-docx` | Doc tooling | `docx` 9.7.1 + 21 transitives (locked) | Never touches deploy. |

Additional vectors worth naming (not scan-detectable â€” each re-verified 2026-08-16):

- **npm lifecycle scripts**: `npm config get ignore-scripts` is `false` on this workstation, so every install (including audit-time lockfile regeneration) executes package scripts. Set `ignore-scripts=true` for audit work.
- **zcli supersession**: 1.0.0-beta.53 is superseded by stable **1.1.4** (2026-07-20) â€” but 1.1.4 still pins `adm-zip` 0.5.10 and `uuid` ^8.3.2, so upgrading does **not** clear findings #1â€“2. The global npm root is shared with unrelated packages (`@anthropic-ai/claude-code`, `@google/gemini-cli`, `pptxgenjs`) on the same PATH bin dir.
- **`asana_form_config.json` provenance**: regenerated from an **unauthenticated** `app.asana.com` form-details endpoint (`tools/gen_form_config.py`) â€” third-party-controlled help text and URLs (which the app linkifies) enter the bundle on every regen. Diff-review is mandatory, not advisory.
- **Three deployable configs, not two**: root â†’ app <legacy-app-id>; `v2.9.2/â€¦` â†’ <sandbox-app-id>; **`tmp/zendesk-upload/â€¦` â†’ also <sandbox-app-id>** (stale unpacked bundle). A zcli push from the wrong cwd ships a stale fork to the sandbox app. The root copy also has **no `.zcliignore`** (safe today only because no settings.yml/.env exists there).
- **Dormant broker egress**: `app.js` contains raw `fetch()` calls to `ASANA_BROKER_BASE` (empty â†’ inert in 3.9). If the broker is ever wired, those bypass the ZAF secure proxy and `domainWhitelist` â€” a different egress class needing its own review.
- **Stale root `translations/en.json`** still describes the old read-only HIPAA-broker app â€” cosmetic, but fix on next root sync.

**Scope disclosure**: `cx_sidebar_v3/` (stale fork; carries its own external endpoint `alma.lightdash.cloud` â€” not present in 3.9), the ~20 historical zips in `tmp/`, and `monitoring/` (dependency-free, post-dates the scan) were not file-by-file scanned. The 3.9 bundle â€” the thing that deploys â€” was.

## Snyk note

To add Snyk on top of npm audit: `npm i -g snyk && snyk auth && snyk test` in `tmp/brief-docx` and against the zcli lockfile copy (scratchpad `zcli-audit/`). Both scanners draw primarily on the same public advisory databases; the marginal value here is Snyk's proprietary DB entries for the zcli tree.
