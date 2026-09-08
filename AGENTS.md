# Clawbot project guide

## Scope

This repository contains the reproducible source, tests, documentation, and sanitized configuration templates for the personal WeChat bookkeeping system. Git-tracked content does not contain live credentials, WeChat identities, OpenClaw transcripts, or ezBookkeeping data.

## Cross-platform public distribution

The public project must continue to support both Windows and Mac deployments. Retiring this user's Windows production instance does not authorize removing Windows installers, runtime adapters, configuration contracts, tests, or recovery workflows. Keep shared bookkeeping behavior consistent while preserving platform-specific service management. README must provide separate Windows and Mac setup entry points. Personal identities, machine paths, live credentials and migration archives stay outside Git; reusable configuration must use sanitized templates. Current Mac acceptance covers Apple Silicon Docker only; do not claim untested Intel Mac or Windows Docker support. The existing Windows route remains the native Windows deployment until separately validated.

## Mac preparation workflow

For the authorized P1–P6 preparation, follow [andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills): state uncertain assumptions, choose the smallest sufficient change, avoid unrelated refactors, and verify concrete acceptance criteria. Commit each completed checkpoint. After a rehearsal, remove only its verified, unused temporary files, containers and volumes; retain live data, recovery artifacts and acceptance records.

## Current architecture

```text
WeChat iLink -> Mac ARM64 Docker OpenClaw release -> OpenAI GPT-5.6 Sol via official Codex harness
  -> clawbot-bookkeeping -> 127.0.0.1:8888 ezBookkeeping

Browser -> ledger.66ccff-labs.com -> Cloudflare Tunnel
  -> guarded 127.0.0.1:8888 ezBookkeeping
```

- Current Mac production runtime/guard and independently deployed dashboard source is `8a9b796931a329c6140db61cbe325a75982edff5`. Windows receiver, ledger, Tunnel and isolated test are stopped and all four scheduled tasks disabled; the original Windows snapshot and installation remain retained. The nine-volume import, official model call, real WeChat history, direct expense entry, prepare/cancel, public checks and production dashboard switch passed. Real prepare-then-confirm-write acceptance also passed, with a unique matching ledger row; its later deletion was preserved, not undone. Old tests are retired and post-write off-machine recovery passed. See `docs/handoffs/2026-09-09-production-cutover.md` for current evidence; older Windows-active records are historical.
- Standalone confirmation and cancellation replies accept the reviewed Chinese phrase lists and trailing statement punctuation. The tool description is generated from the same lists. Substantive corrections and questions are not confirmations; cancellation only discards a pending proposal, never an existing transaction. After the reported unrecognized 是的 failure, the 8a9b796 phrase fix passed 37 targeted cases, 685 portable passes (one skip), and 141/141 receipt/durable tests on Windows. Real confirmation-write reacceptance passed.
- Category validation must reject invalid record/prepare parameters before consuming trusted message authority. Only an exact pre-execution blocked result may bypass the unknown-outcome reply; actual execution errors must retain conservative handling. Corrected parameters still require the original message, owner and run protections. The category-retry receipt/durable suite passed 106/106 on both Mac and Windows; subsequent real confirm-then-write acceptance passed.
- The Mac uses pinned OpenClaw 2026.8.2 plus the restricted MCP SDK adapter; it declares no native MCP server and keeps the official Codex harness unchanged. Windows retains the native MCP manifest. Preserve exact owner, account, SGD, pagination and current-message reply protections on both paths.
- Mac startup must validate the bookkeeping plugin's explicit conversation/prompt hook grants and avoid truncating its workspace rules. Durable tool execution must retain the original authority run key so execute and after-tool cannot create competing reply records for one message.
- Windows-to-Linux Codex 0.151.0 migration required six databases' 64 SQLx checksums to be verified against pinned official SQL line endings, plus exact path mapping for 68 original threads. Copies were audited before installation; original databases, sidecars and transcript files remain retained. Never clear history or disable SQLx checks to repair this issue. See `docs/codex-state-cross-platform.md`.
- iLink can omit both zero-valued status codes from a successful poll. Require the verified poll envelope when codes are absent; explicit errors, malformed data and local timeouts cannot establish accepted polling. Misclassifying valid polls made readiness fail after its two-minute connection grace and caused repeated host recovery. Mac plugin tests passed 25/25; the changed status tests also passed 5/5 on Windows. Actual post-fix polling is accepted; verify real service continuity separately.
- The local page at `127.0.0.1:18990` is served by the immutable production dashboard LaunchAgent; the business host has its own LaunchAgent. Dashboard updates must verify exact task/process ownership, retain the previous task and leave business services unchanged. Tunnel evidence expires after ten seconds and has its own short refresh interval, separate from credential checks. See `docs/mac-production-dashboard.md`.
- Mac-independent P1-P6 preparation is complete. The accepted three-hour observation ended with 181.93 continuous healthy minutes and zero gaps; do not restart the former 24-48 hour wait. Isolated-service recovery, real reboot followed by manual macOS login and lockscreen continuity passed. This does not prove unattended pre-login recovery. See `docs/mac-before-windows-checklist.md` and the dated 2026-09-08 preparation records.
- Production nine-volume encrypted backup and independent restoration have now run on real imported data. Real version updates `9f3c0e5` → `62cfd9e` → `4870258` → `8a9b796` each staged current backed-up data into nine new volumes, changed only source binding metadata, verified all preserved files and selected the new host under maintenance. Old volumes, images, original snapshots and backup keys remain retained. Current source/image recovery artifacts have a separately hash-verified Windows copy; a second key copy has verified bytes and owner-only access in a separate Windows directory. The post-write data archive on `62cfd9e` (11113 entries, ledger 16 tables, receipts 12 tables) was copied to Windows, downloaded with the separately stored key and restored into nine isolated temporary volumes; full file/database comparison passed and temporary copies were removed. The final `8a9b796` backup after real confirmation (11112 entries, ledger 16 tables, receipts 12 tables) also passed the Windows-download and separate-key isolated recovery; download copies were removed. The old isolated test has a final stopped-state seven-volume backup; its two containers, seven volumes, network and completed authorization stage were removed after ownership checks, with production unchanged. See `docs/mac-maintenance-backup.md` and `docs/mac-release-updates.md`.
- Maintenance cannot clear storage faults. Recovery candidates never acquire production labels or get promoted automatically. Use reviewed generation/update workflows, current-data backups and explicit resume; never steal operation locks, restore unknown data or roll back to frozen old volumes after new writes.
- Mac-to-Windows ZeroTier SSH and SFTP are verified with the original dedicated key and independently supplied host fingerprint. Actual addresses, accounts, credentials and operation receipts remain outside Git. Follow `docs/windows-mac-remote-access.md`; do not re-enable this retired Windows receiver while Mac is active.
- `openclaw-plugins/clawbot-bookkeeping` owns trusted-message correlation, category validation, deduplication, and local API writes.
- Its local SQLite state also carries pending confirmations, trusted tool bindings, and authoritative replies across Codex/OpenClaw instance boundaries. `ended_trusted_runs` revokes ended runs; `processed_expense_confirmations` permanently deduplicates confirmation message hashes; `receipt_store_migrations` records the one-time import of previously claimed message hashes. Preserve these records during upgrades.
- `openclaw-plugins/openclaw-weixin-stable-id` preserves Tencent message IDs and sender metadata.
- `openclaw-workspace/AGENTS.md` is the runtime prompt for the dedicated bookkeeper, not this repository guide.
- Production OpenClaw loads an immutable, hash-verified release outside this Git checkout. Development and integration work uses `127.0.0.1:18888` with separate config, secrets, storage, and SQLite.
- The Ledger Tunnel supervisor publishes only after it verifies the exact production port owner, explicit config, health JSON, and login-page fingerprint; origin degradation fails closed.
- Deterministic HTTP summaries and owner-scoped MCP history queries are live. The local MCP service and its separate token were enabled on 2026-09-07; local connection, tool discovery, an authorized public connection rejection check, and a real WeChat history query passed. See `docs/handoffs/2026-09-07-history-query-activation.md` for the verification scope.
- The dedicated bookkeeper uses `tools.profile=full` with an exact six-tool `tools.allow` list. The minimal base profile filters out the native MCP history tool before that allowlist is applied; preserve the exact allowlist when maintaining this configuration.
- Native MCP history results pass through `expense-history.mjs` and the persistent authoritative-reply path. Keep the fixed expense account, ten-row limit, validated pagination, and readable output. Preserve `trusted-inbound-freshness-v1`, its real-message history/latest-source tables, and reply source keys during upgrades; they prevent old replies and delayed proposals from taking over newer requests.
- Preserve numbered-canteen amount parsing, meal-description timing, and distinct amount/time validation replies. The Windows `1ab154f` release and its 856-test result are historical evidence in `docs/handoffs/2026-09-07-numbered-canteen-fix.md`, not the current Mac release or current cross-platform test count.

## Safety boundaries

- Never commit tokens, passwords, account IDs, sender IDs, QR data, transcripts, SQLite files, or OpenClaw state.
- An ignored root file named `testAccountInfo.txt` may exist for the isolated `18888` test account. Never read it with output-producing commands, place it in model context, stage it, commit it, or upload it. Only a non-echoing local test-login process may consume it.
- Keep production ezBookkeeping bound to `127.0.0.1:8888`, isolated test ezBookkeeping bound to `127.0.0.1:18888`, and OpenClaw Gateway bound to loopback. Never run repository tests against `8888`.
- `ledger.66ccff-labs.com` is the only public Tunnel hostname. Do not enable Cloudflare Access, expose an origin port, or change `66ccff-labs.com`/`www.66ccff-labs.com` routing.
- Registration and ineffective password recovery stay disabled server-side. API token, MCP, and trusted-proxy allowlists stay exact loopback.
- Never stop an unknown process, replace an unrecognized task/Tunnel/DNS/rule, delete an unknown account, or restore a database automatically.
- A successful WeChat reply may only be produced after the bookkeeping API confirms the write.
- One inbound message creates at most one expense; deduplicate by trusted channel plus message ID, not by message text.
- The user explicitly changed the former local-only policy on 2026-09-04. Keep the dedicated bookkeeper pinned to the official Codex harness; do not add other cloud providers or fallbacks without fresh approval.

## Checks

Run from Windows PowerShell:

```powershell
Set-Location openclaw-plugins\clawbot-bookkeeping
npm.cmd test

Set-Location ..\openclaw-weixin-stable-id
npm.cmd run build
node --test test/*.test.mjs

openclaw gateway status
openclaw channels status --probe
```

For production/test migration, immutable release publication, Tunnel installation, public checks, restart/fail-closed checks, WeChat regression, and portfolio regression, follow `docs/ledger-cloudflare-runbook.md`. The current Mac release record is `docs/handoffs/2026-09-09-production-cutover.md`; the Windows numbered-canteen, history-format and Tunnel records remain historical evidence. Record local, deployment and new real WeChat acceptance separately. Real Cloudflare authorization occurs only in a visible local terminal/browser and never through copied credentials.

Update `README.md` and `WINDOWS-HANDOFF.md` when the live architecture, service state, tools, or user workflow changes.
