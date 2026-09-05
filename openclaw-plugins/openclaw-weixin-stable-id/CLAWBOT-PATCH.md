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
real platform redelivery. As of 2026-09-05, same-message-ID platform replay
acceptance still lacks a real trigger and evidence; see the
[active handoff](../../docs/handoffs/2026-09-05-secure-ledger-tunnel-gpt6-handoff.md).

The bundled READMEs retain upstream usage reference. Clawbot production deploys
this variant through the [immutable release runbook](../../docs/ledger-cloudflare-runbook.md);
installing the unmodified upstream npm package does not deploy this patch.
