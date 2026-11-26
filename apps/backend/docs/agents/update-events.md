# Update events [EXISTS]

`notifyUpdate` records each notice as its typed `update_<kind>` event before
checking whether the persistent notification exists or was dismissed. Hyphens
in notice kinds map to underscores in registry codes. Params retain the notice's
own identity and fields, including package and transport-reason arrays; display
strings are still formatted only for the notification. The shared emitter owns
per-boot subject deduplication, validation, redaction and output failure containment.

The runtime's `dispatch` records `update_failed` only when the reducer accepts
`DOWNLOAD_FAILED`, `COMMIT_FAILED`, `SYNC_FAILED` or `OS_STAGING_FAILED`.
Their stages are `download`, `commit`, `sync` and `os-staging`, with the original
reason. For a settled package failure with a UUID in the package state, the
event also records that UUID as `params.id` so View logs can find that
attempt. An accepted OS attempt settlement can retain its existing retry policy;
recording the failed attempt does not make that policy terminal. Ignored events,
ordinary progress and phase changes emit no failure. The legacy software-update
notification raises do not produce these events.

Capable scheduled package offers over the event id limit record only a
compact `id`. The roster needed for retirement stays in bounded private
updater state, not in Events, log exports, the journal, or support bundles.
Other update-event identities and notice text stay unchanged.
`src/tests/events-update-emits.test.ts` drives the production
notice and runtime funnels through the real emitter and JSONL store, including
shown/dismissed notices and a failure rejected after state replacement.
`src/tests/events-update-recording.test.ts` separately records each producer call
without emitter deduplication. It checks exact call counts, order and params for
all notice kinds and four failure stages, including calls before persistence.
Each funnel contains emission exceptions without interrupting notification
publication or transition persistence and publication. The guards cover only
the new emission logic; persistence errors retain their existing behavior.
The backend test preload places default event storage under its per-file temporary
root, so existing runtime fixtures never write the device store or share a ring.
Physical update execution and board journal behavior are not qualified here.
