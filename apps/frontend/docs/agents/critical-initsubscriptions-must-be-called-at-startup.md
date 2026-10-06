<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## CRITICAL: initSubscriptions() must be called at startup

`lib/rpc/subscriptions.svelte.ts` exports `initSubscriptions()` — this registers the `onMessage` and `onConnectionChange` handlers that feed all non-deprecated getters (`getConfig`, `getModems`, `getWifi`, `getIsStreaming`, etc.). It is called in `main.ts` before mount. **Any store or component that reads from `subscriptions.svelte` getters depends on this call being present.** If you remove or move it, the HUD, all destination views, and the disconnected banner will show stale/empty data.

