# Clawbot local patch

Base: `@tencent-weixin/openclaw-weixin` 2.4.8.

The upstream package generates a new `MessageSid` every time an inbound item is
processed. This local variant uses Tencent's `message_id` when present and keeps
the original random-ID behavior only as a fallback. That gives the bookkeeping
adapter a durable replay key while preserving separate records for distinct
messages with identical text.

The change is covered by `test/inbound-message-id.test.mjs` and is intentionally
limited to the source and compiled inbound-context mapping.
