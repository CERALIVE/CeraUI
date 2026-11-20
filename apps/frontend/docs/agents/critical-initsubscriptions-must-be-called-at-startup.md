<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## CRITICAL: initSubscriptions() must be called at startup

`lib/rpc/subscriptions.svelte.ts` exports `initSubscriptions()` — this registers the `onMessage` and `onConnectionChange` handlers that feed all non-deprecated getters (`getConfig`, `getModems`, `getWifi`, `getIsStreaming`, etc.). It is called in `main.ts` before mount. **Any store or component that reads from `subscriptions.svelte` getters depends on this call being present.** If you remove or move it, the HUD, all destination views, and the disconnected banner will show stale/empty data.

## Device log follow [EXISTS]

The same message handler parses `LOG_FOLLOW_EVENT` with the shared
`logFollowMessageSchema` and delivers it to `setLogFollowListener`. Invalid
frames are ignored silently. The listener may be replaced or removed; no
message is retained or replayed, and reset detaches it. A throwing listener is
reported without breaking later delivery. `TypedRPC.logs` imports every input
and output from `@ceraui/rpc/schemas`. The viewer owns `followStop` when it
unsubscribes; socket close also stops the backend follower. Coverage:
`lib/rpc/subscriptions-log-follow.test.ts`.

