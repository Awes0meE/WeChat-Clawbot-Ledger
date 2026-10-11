# Clawbot local patch

Base: `@tencent-weixin/openclaw-weixin` 2.4.8.

Local package: `@clawbot/openclaw-weixin-stable-id` `2.4.8-clawbot.1`.
The declared minimum host is OpenClaw `2026.5.12`; the verified Clawbot host is
`2026.8.2`. The retained upstream runtime guard still uses `2026.3.22` and skips
unknown or unavailable host versions; the declared installation minimum is a
separate metadata constraint.

The local inbound-context mapping preserves two trusted provider fields:

- `MessageSid` uses Tencent's `message_id` when present. Only when Tencent omits
  that field does it fall back to the original generated random ID. A provider
  ID gives the bookkeeping adapter a durable replay key while keeping distinct
  messages with identical text separate; the random fallback cannot establish
  stable identity across repeated deliveries.
- `SenderId` copies `from_user_id`, allowing OpenClaw to populate trusted sender
  context for downstream owner checks. This mapping does not itself authorize
  bookkeeping access.

These mappings are maintained in the source and compiled inbound context.
`test/inbound-message-id.test.mjs` covers stable IDs, distinct same-text messages,
and the missing-ID fallback with synthetic fixtures. Those tests do not prove
real platform redelivery. Same-message-ID platform replay still lacks a real
trigger and evidence; see the
[current acceptance boundaries](../../docs/mac-before-windows-checklist.md).

For a single current image, the media metadata also carries its provider message
ID. `withWeixinInboundContext` wraps authorized inbound dispatch in
`AsyncLocalStorage`, preserving the exact account, sender, message and attachment
through the model-input hook even when the text body is empty. The bookkeeping
plugin matches that context against its durable inbound record and validates the
controlled file path, type, size and hash. Model arguments cannot select the
attachment or grant authority. Multi-image or quoted historical-image messages
do not obtain a single-current-image binding. Both source and compiled files
carry this bridge; framework upgrades must recheck the actual asynchronous path.
The pinned Mac harness passed isolated image acceptance and the adapter's 26
tests at the first image release; Windows native media execution remains
unverified. See the [image design](../../docs/superpowers/specs/2026-10-01-image-bookkeeping-design.md)
and [release record](../../docs/handoffs/2026-10-01-image-bookkeeping.md).

Inbound sender authorization runs before local slash commands and media
downloads. The framework pairing store remains authoritative, with the legacy
account owner used only when that store is empty; an empty store without an
owner denies access. This prevents unpaired senders from using `/echo`, changing
account-wide debug state with `/toggle-debug`, or triggering attachment downloads.
Authorized messages keep their original body, stable identity, media mapping and
`CommandAuthorized` flag. `test/slash-command-authorization.test.mjs` exercises
these boundaries and both supported owner sources with synthetic Node fixtures;
host state and network services are replaced in memory.

The bundled READMEs retain upstream usage reference. Clawbot production deploys
this variant through the [immutable release runbook](../../docs/ledger-cloudflare-runbook.md);
installing the unmodified upstream npm package does not deploy this patch.
