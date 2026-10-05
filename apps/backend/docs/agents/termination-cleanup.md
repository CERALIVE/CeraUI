<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## TERMINATION CLEANUP [EXISTS]

`helpers/shutdown.ts` owns the process-level `SIGTERM`/`SIGINT` lifecycle. The first
signal latches shutdown and runs the existing sequential order — SRT ingest, dmesg
watchers, then streaming processes. Each cleanup is settled independently and any
failure is logged before the next step runs; `exit(0)` is still attempted after all
three steps. Later signals remain ignored. The direct regression coverage lives in
`src/main.test.ts` under `termination shutdown lifecycle`.

