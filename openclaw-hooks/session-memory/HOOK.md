---
name: session-memory
description: "Preserve official session memory except for the immutable Clawbot bookkeeper workspace"
metadata:
  {
    "openclaw":
      {
        "events": ["command:new", "command:reset", "session:auto-reset"],
        "requires": { "config": ["workspace.dir"] },
      },
  }
---

# Clawbot session-memory guard

This managed hook replaces the bundled hook of the same name through OpenClaw's
supported discovery precedence. It skips only events whose `context.agentId` is
exactly `bookkeeper`, keeping session excerpts out of its immutable release.
Every other event is passed unchanged to the official handler, preserving its
synchronous return value, exception, or Promise. Session reset policies and
ordinary transcript persistence are unchanged.

The Windows entry point verifies the npm-global OpenClaw installation at
`%APPDATA%/npm/node_modules/openclaw`: version `2026.8.2` and the pinned SHA-256
digests of its bundled `handler.js` and `HOOK.md` must match before import.
Verification failures produce only `CLAWBOT_SESSION_MEMORY_UPSTREAM_VERIFICATION_FAILED`.
An OpenClaw update requires reviewing the upstream changes and updating the pins.

Install these three source files together into the managed
`%USERPROFILE%/.openclaw/hooks/session-memory/` directory only through the reviewed
deployment procedure. The current `session-memory` enabled setting must stay in
place. Do not install an additional copy under a different hook name or enable
`extraDirs`; either could change hook selection. A Gateway restart and hook
inventory check are required after installation. A loader error must block
release switching because the overridden bundled hook is not a fallback.

`handler.js` is intentional: OpenClaw 2026.8.2 directory discovery does not look
for `handler.mjs`. `guard.mjs` has no import-time connection to OpenClaw, allowing
isolated tests with temporary synthetic upstream modules.
