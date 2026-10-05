<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## LOCAL DEV: CONTROL-CHANNEL OVERRIDE

For local dev, set `CERALIVE_CONTROL_HUB_URL=ws://localhost:<hub-port>` and
`PASETO_PUBLIC_KEY=<raw-base64 32-byte Ed25519 public key>` in `.env.development`
to point the device-control channel at any WS hub. No source changes are needed —
both vars are read from `process.env` at runtime (`modules/remote/control-endpoint.ts`
resolves the hub URL; `modules/pairing/device-token.ts` reads the raw-base64 key).
Both are unset by default, so the control channel stays gated until provisioned.
`PASETO_PUBLIC_KEY` here is the raw-base64 encoding (node:crypto), never a PASERK
`k4.public.…` string.

