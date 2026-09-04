# Secure Ledger Tunnel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkboxes (`- [ ]`) for tracking.

**Goal:** Publish the existing ezBookkeeping web UI at `https://ledger.66ccff-labs.com` through a fail-closed Cloudflare Tunnel while isolating production, test, and development state and preserving the existing portfolio routes.

**Architecture:** The production ezBookkeeping instance remains local-only at `127.0.0.1:8888`; a separately configured test instance uses `127.0.0.1:18888` and its own SQLite database. A guarded `cloudflared` process starts only after it proves that port `8888` belongs to the expected ezBookkeeping executable and that both the health endpoint and login-page fingerprint are valid. OpenClaw loads a hash-verified release under `D:\Clawbot\releases`, never the Git checkout. Cloudflare publishes only the exact `ledger` hostname and applies hostname-scoped HTTPS, cache, header, and WAF rules; a Free-plan login rate rule is allowed only after proving that the same path is unused by the portfolio.

**Tech Stack:** Windows PowerShell 5.1, Node.js 24 test runner, ezBookkeeping 1.6.1, OpenClaw 2026.8.2, Windows Task Scheduler, locally managed Cloudflare Tunnel, Cloudflare Rules/WAF.

---

## Fixed safety invariants

- The production application binds only to `127.0.0.1:8888`; the test application binds only to `127.0.0.1:18888` and has separate config, storage, logs, secret key, API token, and SQLite data.
- Production registration and password recovery stay disabled. API tokens, MCP, and trusted proxies accept only loopback-originated requests.
- No script kills a process merely because it owns a port. A process may be stopped only when its PID, executable path, command line/config path, and expected scheduled task all match.
- Tunnel startup fails closed unless the exact port owner, `/healthz.json` response, and ezBookkeeping login-page fingerprint all pass.
- Cloudflare credentials, tunnel UUID files, local account data, tokens, OpenClaw config/state, SQLite files, logs, and transaction data remain outside Git and OneDrive.
- Production configuration and database are backed up after the exact scheduled task is stopped and before mutation. The backup must pass SHA-256 comparison, SQLite header validation, `PRAGMA quick_check`, and a redacted active-user count check.
- OpenClaw configuration is backed up and dry-run validated before switching to an immutable release. Failure restores the configuration backup; database rollback is never automatic.
- `66ccff-labs.com` and `www.66ccff-labs.com` retain their current DNS and routing. No zone-wide Always Use HTTPS, HSTS, cache, redirect, or security rule is introduced.
- Interactive Cloudflare authorization happens only in a visible local terminal/browser. Scripts never request, echo, persist in command history, or commit credentials.
- Nothing is merged into `main` or pushed to a remote as part of this plan.

## Task 1: Separate production and test runtimes, then migrate production safely

**Files:**

- Modify: `openclaw-plugins/clawbot-bookkeeping/adapter.mjs`
- Modify: `openclaw-plugins/clawbot-bookkeeping/index.ts`
- Modify: `openclaw-plugins/clawbot-bookkeeping/mcp-connection.mjs`
- Modify: `openclaw-plugins/clawbot-bookkeeping/openclaw.plugin.json`
- Modify: `config/expense-categories.json`
- Modify: `openclaw-plugins/clawbot-bookkeeping/test/*.test.mjs`
- Modify: `scripts/configure-ezbookkeeping-mcp.ps1`
- Modify: `scripts/initialize-test-ledger.ps1`
- Modify: `scripts/install-ezbookkeeping-task.ps1`
- Create: `config/ezbookkeeping-production.example.ini`
- Create: `config/ezbookkeeping-test.example.ini`
- Create: `scripts/ledger-runtime-common.ps1`
- Create: `scripts/verify-ledger-sqlite.mjs`
- Create: `scripts/migrate-ledger-production.ps1`
- Create: `scripts/install-ledger-test-instance.ps1`
- Create: `openclaw-plugins/clawbot-bookkeeping/test/ledger-runtime-scripts.test.mjs`

### Step 1: Write failing endpoint and isolation tests

- [ ] Add source-level assertions that every production default is exactly `http://127.0.0.1:8888`, never `8180`, `0.0.0.0`, `localhost`, or a public hostname.
- [ ] Add script tests proving that test initialization accepts only `http://127.0.0.1:18888`, revalidates the expected test executable/config/port owner before reading a token, requires an independent ready marker, rejects the production token path, disables redirects, bounds every request, sanitizes errors, and performs no token read or HTTP request under `-WhatIf`.
- [ ] Add script tests proving that the production migration refuses a non-loopback address, an unknown port owner, a mismatched executable/config path, an unhealthy response, a database with failed `quick_check`, an active-user count other than one, or any `EBK_*`/`EBKCFP_*` environment override for a migrated key.
- [ ] Add script tests proving that no failure path stops an unknown PID and that the original INI is restored atomically when a post-edit validation fails.
- [ ] Run:

  ```powershell
  Set-Location openclaw-plugins\clawbot-bookkeeping
  node --test test\ledger-runtime-scripts.test.mjs
  ```

  Expected: the new tests fail because the endpoint migration and runtime scripts do not exist yet.

### Step 2: Implement exact production defaults and an isolated test initializer

- [ ] Change all production plugin defaults, manifest examples, MCP URLs, and test expectations from port `8180` to `8888`. Remove the endpoint from the category catalog so its historical `imported_verified` provenance is not falsely reassigned to a new runtime.
- [ ] Keep the configured URL override but validate that production bookkeeping and MCP URLs are exact loopback HTTP URLs on port `8888`; reject public, wildcard, hostname-alias, and test-port targets rather than silently falling back.
- [ ] Update `initialize-test-ledger.ps1` to use only port `18888`, a `%USERPROFILE%\.openclaw\secrets\ezbookkeeping-test-token.txt` token path, and a marker owned by the separately provisioned test instance.
- [ ] Preserve `SupportsShouldProcess`; evaluate `ShouldProcess` before reading the token or issuing HTTP requests.
- [ ] Run the focused test again and require all cases to pass.

### Step 3: Add redacted SQLite verification and sanitized INI templates

- [ ] Implement `verify-ledger-sqlite.mjs` as read-only/query-only verification that opens the named local database without extensions, checks the SQLite header, runs `PRAGMA quick_check`, verifies the fixed `user` table's `deleted` and `disabled` columns, and returns only status plus enabled, undeleted user count. Add a backup mode using Node 24's `node:sqlite` backup API so a WAL-enabled production database is copied consistently. It must never print raw exceptions, usernames, password hashes, tokens, transaction rows, or database paths.
- [ ] Add tests using generated temporary SQLite fixtures for valid one-user, zero-user, two-user, disabled-user, corrupt, non-SQLite, missing-table, and bounded-lock-wait cases.
- [ ] Add production and test INI examples with sanitized local placeholders and the exact required settings:

  ```ini
  [server]
  protocol = http
  http_addr = 127.0.0.1
  http_port = 8888
  domain = ledger.66ccff-labs.com
  root_url = https://ledger.66ccff-labs.com/

  [mcp]
  mcp_allowed_remote_ips = 127.0.0.1

  [security]
  trusted_proxy_ips = 127.0.0.1
  enable_api_token = true
  api_token_allowed_remote_ips = 127.0.0.1
  token_expired_time = 604800
  token_min_refresh_interval = 86400
  max_failures_per_ip_per_minute = 5
  max_failures_per_user_per_minute = 5

  [auth]
  enable_internal_auth = true
  enable_oauth2_auth = false
  enable_two_factor = true
  enable_forget_password = false

  [user]
  enable_register = false
  ```

  The test template uses port `18888`, independent absolute data directories, and a non-production secret placeholder.

### Step 4: Implement guarded migration and test-instance installation

- [ ] Put reusable strict INI parsing, atomic replacement, file hashing, ACL checking, scheduled-task action validation, listener ownership, health checking, and sanitized status output in `ledger-runtime-common.ps1`.
- [ ] Make `migrate-ledger-production.ps1` accept the default config only after recognizing the verified root task whose current action is exactly `D:\Clawbot\ezbookkeeping\ezbookkeeping.exe server run` with working directory `D:\Clawbot\ezbookkeeping`; require that exact executable pair to own port `8180`, and reject ambiguity.
- [ ] Reject `EBK_CONF_PATH` and every process/user/machine `EBK_*` or `EBKCFP_*` override that can supersede a migrated INI key; do not report the environment-variable value.
- [ ] Have migration preflight OpenClaw config by key names only and reject any static MCP token fallback before touching production.
- [ ] Immediately before stopping, revalidate PID, creation time, executable, complete command/config, and port ownership to prevent PID-reuse races. Stop only the verified production task/process, persist and verify the exact scheduled-task definition plus a timestamped configuration/database backup outside the repository, compare the configuration source/backup hashes, make a consistent SQLite backup through `node:sqlite` rather than raw-copying a possible WAL database, hash and verify that backup, and require exactly one enabled, undeleted user.
- [ ] Atomically set the required production INI keys while preserving all unrelated values, including the current `enable_mcp` choice.
- [ ] Replace only the recognized legacy task action with an exact explicit-config action equivalent to `ezbookkeeping.exe --conf-path D:\Clawbot\ezbookkeeping\conf\ezbookkeeping.ini server run`; never force-replace a mismatched task. Restart it and require only `127.0.0.1:8888` to listen with the expected executable, a successful health JSON response, and the ezBookkeeping page fingerprint. Restore the task definition, INI backup, and original service state on failure.
- [ ] Make `install-ledger-test-instance.ps1` allowlist-copy only immutable program assets into a new or validly marked `D:\Clawbot\ezbookkeeping-test`; reject an unmarked/non-empty directory or mismatched task. Create owner-only config/secrets, a unique marker, independent SQLite/storage/log locations, and an exact hidden scheduled-task action using port `18888`.
- [ ] Bootstrap only through a visible local prompt using `Read-Host -AsSecureString` and the loopback registration API—never a password command-line argument—then force `enable_register=false` before the test instance can be marked ready. Any failure must restore registration disabled, stop only the recognized test task, and omit the ready marker. Never copy production account, token, secret key, database, or raw application output.
- [ ] Run focused script tests and both plugin suites:

  ```powershell
  Set-Location openclaw-plugins\clawbot-bookkeeping
  npm.cmd test
  Set-Location ..\openclaw-weixin-stable-id
  npm.cmd run build
  node --test test\inbound-message-id.test.mjs
  ```

  Expected: all tests pass and `git status --short` contains only intended source, test, config, and plan files.

### Step 5: Commit the completed runtime boundary

- [ ] Review staged paths and run a secret/data scan before committing.
- [ ] Commit:

  ```powershell
  git add docs\superpowers\plans\2026-09-05-secure-ledger-tunnel.md config scripts openclaw-plugins\clawbot-bookkeeping
  git commit -m "feat(ledger): isolate production and test runtimes"
  ```

## Task 2: Publish a verified production OpenClaw release

**Files:**

- Create: `scripts/publish-openclaw-release.ps1`
- Create: `scripts/verify-openclaw-release.ps1`
- Create: `openclaw-plugins/clawbot-bookkeeping/test/openclaw-release-scripts.test.mjs`

### Step 1: Write failing release and rollback tests

- [ ] Add PowerShell-shim tests proving that release publication copies only an explicit source allowlist, excludes source tests, source `node_modules`, `.git`, logs, databases, secrets, and state, and aborts on any unsupported source file. Runtime dependencies must instead be installed from committed lockfiles into staging and included in verification.
- [ ] Prove every release file is hashed in a manifest and that verification fails on a missing, added, or modified file.
- [ ] Prove `openclaw config patch --dry-run` happens before a live patch, only the two known development plugin paths and the bookkeeper workspace are replaced, unrelated plugin paths/config remain unchanged, and failure restores a hash-verified config backup.
- [ ] Prove restart happens only after release and config verification, and an invalid release leaves the running Gateway untouched.
- [ ] Run:

  ```powershell
  Set-Location openclaw-plugins\clawbot-bookkeeping
  node --test test\openclaw-release-scripts.test.mjs
  ```

  Expected: failure because the release scripts do not exist.

### Step 2: Implement immutable release publication

- [ ] Build the stable-ID plugin first, then copy the bookkeeping plugin, compiled stable-ID plugin, and bookkeeper workspace to a sibling staging directory under `D:\Clawbot\releases`.
- [ ] Derive the release name from the current full Git commit and refuse a dirty source tree both before and after the build, so generated tracked output can never silently diverge from the commit.
- [ ] Use an explicit source file allowlist and reject SQLite, token, credential, identity, transcript, log, cache, source dependency, and VCS artifacts. Include both plugin lockfiles; install locked runtime dependencies in staging with lifecycle scripts disabled, omit bookkeeping's OpenClaw peer, and validate that all non-host imports resolve from the isolated release.
- [ ] Generate `release-manifest.json` containing only relative paths, byte lengths, and SHA-256 hashes; atomically rename staging only after verification. Existing release directories are immutable and must never be overwritten.
- [ ] Implement `verify-openclaw-release.ps1` to reject missing, extra, changed, reparse-point, or out-of-root files.

### Step 3: Switch OpenClaw with backup and rollback

- [ ] Back up `%USERPROFILE%\.openclaw\openclaw.json` outside the repository and verify its hash before changing it.
- [ ] Create an owner-only minimal temporary patch outside the repository containing only the complete substituted plugin-path array, bookkeeper workspace, and `http://127.0.0.1:8888` base URL. It must not serialize any existing token, owner identity, channel state, or unrelated config; delete it after use.
- [ ] Run `openclaw config patch --dry-run --file` before the live patch. Validate the result and prove neither plugin load paths nor the bookkeeper workspace points into the Git checkout.
- [ ] Restart only OpenClaw Gateway, then require Gateway health, channel probe, bookkeeping plugin load, stable-ID plugin load, official Codex harness pinning, and the unchanged owner allowlist.
- [ ] On any post-patch failure, restore the verified OpenClaw config backup and return the Gateway to its prior state.

### Step 4: Verify and commit

- [ ] Run release tests, the complete bookkeeping test suite, the stable-ID build/tests, and a repository secret/data scan.
- [ ] Commit:

  ```powershell
  git add scripts\publish-openclaw-release.ps1 scripts\verify-openclaw-release.ps1 openclaw-plugins\clawbot-bookkeeping\test\openclaw-release-scripts.test.mjs
  git commit -m "feat(openclaw): publish isolated bookkeeping releases"
  ```

## Task 3: Add a fail-closed tunnel supervisor and exact Windows task

**Files:**

- Create: `config/cloudflared-ledger.example.yml`
- Create: `scripts/ledger-tunnel-supervisor.ps1`
- Create: `scripts/install-ledger-tunnel-task.ps1`
- Create: `scripts/test-ledger-local.ps1`
- Create: `openclaw-plugins/clawbot-bookkeeping/test/ledger-tunnel-scripts.test.mjs`

### Step 1: Write failing safety tests

- [ ] Test that no `cloudflared` process starts when port `8888` is absent, wildcard-bound, multiply owned, owned by the wrong executable/config, unhealthy, or serving a non-ezBookkeeping page.
- [ ] Test that a healthy exact owner starts `cloudflared` with a local config file and without a tunnel token in the process command line.
- [ ] Test continuous supervision: loss of listener, owner mismatch, failed health, or changed fingerprint terminates only the child PID started by this supervisor after verifying its executable path.
- [ ] Test that an unknown pre-existing `cloudflared` process is never terminated or adopted.
- [ ] Test that logs contain only timestamps, event codes, PIDs, and exit status—never URLs with queries, headers, cookies, bodies, usernames, tokens, account data, or transaction data—and rotate to a bounded size.
- [ ] Test installer `-WhatIf` has no side effects and that it rejects a task action, tunnel config, credential ACL, or executable path that differs from the expected values.
- [ ] Run:

  ```powershell
  Set-Location openclaw-plugins\clawbot-bookkeeping
  node --test test\ledger-tunnel-scripts.test.mjs
  ```

  Expected: failure because the scripts do not exist.

### Step 2: Implement exact local tunnel configuration and validation

- [ ] Add a sanitized locally managed tunnel example with an exact `ledger.66ccff-labs.com` ingress to `http://127.0.0.1:8888` followed by an `http_status:404` catch-all. It contains no real UUID, account, zone, certificate, credential path, or token.
- [ ] Make the installer require a real config and tunnel credential JSON outside the repository/OneDrive, owner/SYSTEM-only ACL, an exact `cloudflared.exe` path, `cloudflared tunnel ingress validate`, and an exact rule match for the ledger hostname.
- [ ] Refuse to install over an existing Cloudflare service or scheduled task unless its exact action/config has been recognized; report the conflict without stopping, deleting, or replacing it.

### Step 3: Implement health-gated supervision

- [ ] Reuse the strict port-owner and health checks from `ledger-runtime-common.ps1`.
- [ ] Require exact `127.0.0.1:8888`, expected ezBookkeeping executable, expected production config in the process command line, successful `/healthz.json`, and login-page fingerprint before spawning `cloudflared`.
- [ ] Start `cloudflared tunnel --config <local-config> run` as a tracked child without shell interpolation or credential arguments.
- [ ] Revalidate at a short fixed interval. On failure, confirm the tracked PID and executable path, stop only that child, record a sanitized reason, and retry only after the origin becomes valid again.
- [ ] Install a hidden least-privilege scheduled task with restart-on-failure. The tunnel supervisor must never stop, restart, or reconfigure ezBookkeeping.
- [ ] Implement `test-ledger-local.ps1` to report only pass/fail evidence for listener address, owner, health, page fingerprint, server registration/password-recovery settings, API/MCP/trusted-proxy loopback restrictions, test isolation, release verification, and tunnel child/task identity.

### Step 4: Verify and commit

- [ ] Run tunnel tests, all previous automated suites, PowerShell syntax checks, `-WhatIf` checks, and the secret/data scan.
- [ ] Commit:

  ```powershell
  git add config\cloudflared-ledger.example.yml scripts\ledger-tunnel-supervisor.ps1 scripts\install-ledger-tunnel-task.ps1 scripts\test-ledger-local.ps1 openclaw-plugins\clawbot-bookkeeping\test\ledger-tunnel-scripts.test.mjs
  git commit -m "feat(ledger): supervise Cloudflare Tunnel fail closed"
  ```

## Task 4: Encode Cloudflare controls, acceptance tests, operations, and live deployment

**Files:**

- Create: `config/cloudflare-ledger-rules.example.json`
- Create: `scripts/test-ledger-public.ps1`
- Create: `scripts/test-ledger-public.mjs`
- Create: `scripts/test-ledger-restart.ps1`
- Create: `openclaw-plugins/clawbot-bookkeeping/test/ledger-public-scripts.test.mjs`
- Create: `docs/ledger-cloudflare-runbook.md`
- Modify: `.gitignore`
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `WINDOWS-HANDOFF.md`
- Modify: `docs/bookkeeping-deployment-brief.md`

### Step 1: Write failing rule-scope and acceptance tests

- [ ] Add static tests requiring exact-host scoping for the Single Redirect, Cache Rule, Response Header Transform Rule, registration/TRACE WAF rule, DNS route, and tunnel ingress. Reject wildcard hosts, zone-wide Always Use HTTPS/HSTS, Access, public origin addresses, and changes to apex/www.
- [ ] Encode the required public checks: HTTP redirects to the same ledger path/query on HTTPS; HTTPS serves the ezBookkeeping login; no Cloudflare Access page appears; registration POST and TRACE are blocked; responses are not cached; security headers are present; credentialed public API/MCP attempts are rejected without printing credentials.
- [ ] Add portfolio snapshots that record DNS targets, redirect locations, status, selected headers, and stable page fingerprints before deployment and compare them afterward.
- [ ] Test that the Free-plan rate-limiting procedure refuses activation unless direct probes prove both apex and www do not serve `/api/authorize.json` and the sole Rate Limiting slot is available. A paid-plan rule must include the exact ledger host; Method is included only when the account plan supports it.
- [ ] Run:

  ```powershell
  Set-Location openclaw-plugins\clawbot-bookkeeping
  node --test test\ledger-public-scripts.test.mjs
  ```

  Expected: failure because the rules and acceptance scripts do not exist.

### Step 2: Implement sanitized rules and read-only acceptance scripts

- [ ] Add a credential-free rules manifest documenting exact expressions and expected account-plan capabilities:
  - Single Redirect: exact `ledger` HTTP requests to the corresponding HTTPS URL with path/query preserved.
  - Cache Rule: `http.host eq "ledger.66ccff-labs.com"` with cache eligibility bypassed.
  - Response Header Transform: exact host, setting `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow, noarchive`, and a host-only HSTS value after HTTPS validation.
  - WAF: exact host and either TRACE or POST `/api/register.json`, action Block.
  - Login rate limit: exact host/path/method when supported; Free fallback path-only `5 requests / 10 seconds / IP`, Block for 10 seconds, only after collision and slot checks.
- [ ] Implement public/restart tests with bounded timeouts, redacted results, no response-body persistence, and no false success on DNS/TLS/HTTP errors.
- [ ] Credential-boundary tests read local API/MCP tokens only in memory, never echo or log them, send them only over validated HTTPS to the exact ledger hostname, and require rejection.
- [ ] Restart tests cycle only exact recognized scheduled tasks, re-run local/public checks, and confirm the tunnel remains fail-closed while origin health is absent.

### Step 3: Document the exact runbook and current architecture

- [ ] Document prerequisites, local directories, backup/restore, test bootstrap, production migration, release publication, visible Cloudflare login, tunnel creation, exact dashboard/API rules, DNS cutover last, health monitoring, update procedure, incident fail-close, and rollback.
- [ ] Mark account/plan/rule-slot facts as deployment-time evidence, not assumptions. Document the Free-plan rate-limit host limitation and prohibit activation if portfolio path collision cannot be disproved.
- [ ] Update the repository guide, README, Windows handoff, and deployment brief from port `8180`/development checkout to the verified `8888` production, `18888` test, release, and tunnel architecture. Keep historical material clearly labeled rather than rewriting evidence.
- [ ] Add narrow ignore rules for local Cloudflare credential/config artifacts while retaining the stronger rule that all real tunnel material lives outside this repository.
- [ ] Include the complete acceptance matrix and evidence locations, while explicitly excluding credentials, identities, databases, transactions, response bodies, and logs from Git.

### Step 4: Verify and commit the implementation before touching live state

- [ ] Run all Node tests, both plugin builds, PowerShell syntax checks, all `-WhatIf` paths, source endpoint scans, secret/data scans, and `git diff --check`.
- [ ] Commit:

  ```powershell
  git add .gitignore AGENTS.md README.md WINDOWS-HANDOFF.md config\cloudflare-ledger-rules.example.json scripts\test-ledger-public.ps1 scripts\test-ledger-public.mjs scripts\test-ledger-restart.ps1 docs\ledger-cloudflare-runbook.md docs\bookkeeping-deployment-brief.md openclaw-plugins\clawbot-bookkeeping\test\ledger-public-scripts.test.mjs
  git commit -m "feat(ledger): add secure tunnel operations"
  ```

### Step 5: Deploy local production and test state

- [ ] Capture a redacted pre-deployment snapshot: branch/HEAD, task identities/actions, listeners/owners, ezBookkeeping health, OpenClaw health/channels/plugin source paths, ledger NXDOMAIN, and apex/www DNS/redirect/fingerprint.
- [ ] Install the independent test instance, bootstrap only its local test account/token, disable registration, and verify create/query/delete against the test database. Confirm production database hash/count and API-visible data are unchanged.
- [ ] Run the production migration. Record the backup directory, hashes, SQLite checks, one-user count, exact new listener/owner, health, page fingerprint, and absence of port `8180`—without recording data or identity.
- [ ] Publish and verify the independent OpenClaw release, apply the dry-run-validated configuration switch, restart Gateway, and prove no production plugin/workspace path resolves into the Git checkout.
- [ ] Verify production local API create/query/delete with an explicit disposable acceptance record, then delete that record and prove the initial aggregate/account invariants are restored. Never log the record content.
- [ ] Send one fresh WeChat expense through the real trusted channel, confirm exactly one API write and authoritative reply, query it through the supported history path, then clean up only the known acceptance record. This step requires the user to send the message but does not require sharing any identity or credential.

### Step 6: Authorize Cloudflare visibly and deploy ledger-only controls

- [ ] Install the official `cloudflared.exe` only after verifying its source/version/signature. If interactive authorization is required, open a visible terminal for `cloudflared tunnel login`; the user completes it locally and no credential is copied into chat.
- [ ] Inspect existing tunnel, DNS, SSL, redirect, page/worker route, cache, transform, WAF, rate-limit, Access, and rule-slot state. Stop on conflicts rather than replacing unknown resources.
- [ ] Create/reuse the exact locally managed tunnel, move only its run credential and config to the protected local service directory, validate ingress, and run a foreground health-gated test without DNS.
- [ ] Add the ledger-only redirect, cache bypass, response headers, registration/TRACE WAF rule, and supported login rate rule. Do not enable Cloudflare Access.
- [ ] Confirm Universal SSL/HTTPS and rules first; create the exact `ledger.66ccff-labs.com` DNS route last.
- [ ] Install and start the guarded tunnel task, then prove the public hostname reaches ezBookkeeping while the origin remains loopback-only.

### Step 7: Run the complete final acceptance matrix

- [ ] Automated: all repository tests/builds, PowerShell syntax/WhatIf, endpoint scans, secret/data scan, release-manifest verification, and clean `git diff --check`.
- [ ] Local: exact `8888`/`18888` owners, separate DB hashes/paths, production config restrictions, local health/login, API/MCP loopback boundary, release-only OpenClaw paths, Gateway/channel/plugin health.
- [ ] Public: DNS, HTTP→HTTPS path/query, TLS, login page, no Access, registration/TRACE block, login rate behavior, no cache, headers/HSTS, public API/MCP token rejection, no origin port exposure.
- [ ] Restart/fail-close: reboot-equivalent task restarts, origin-stop prevents tunnel publication, wrong-owner simulation never starts tunnel, recovery restores service, no unknown process is stopped.
- [ ] WeChat: fresh trusted message produces exactly one expense and one authoritative reply after API success; duplicate delivery does not create a second expense; history query remains correct; acceptance data is removed deliberately.
- [ ] Portfolio: apex and www DNS, HTTP redirects, HTTPS status/TLS, route/page fingerprints, and existing deployment remain unchanged from the pre-deployment snapshot.
- [ ] Evidence: save only redacted pass/fail summaries and hashes under the local deployment evidence directory outside Git. Run `git status --short`, `git log --oneline c59da14..HEAD`, and confirm there was no push or merge.

### Step 8: Stop only at proved completion

- [ ] If any check lacks real evidence, report it as incomplete and continue remediation; do not call the deployment complete.
- [ ] When every matrix row passes, provide the user the branch/commit list, redacted backup and release locations, public URL, verified safeguards, and any manual maintenance cadence. Keep the branch unmerged and unpushed pending explicit confirmation.
