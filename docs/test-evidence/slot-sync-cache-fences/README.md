# Slot mirror cache and dispatch-fence mutation proofs

These host-only transcripts exercise `slot-sync-stale-receipt-cache.test.ts` with
Bun 1.4.2. Each mutant was applied independently, failed its corresponding runtime
test, and was restored before the final passing gates. No mutation is shipped.

| Transcript | Deliberate regression | Required observable failure |
|---|---|---|
| `mutant-M5.log` | Remove the cache's `age >= 0` condition | A backward clock step incorrectly reuses the good target instead of reading RAUC again |
| `mutant-M6.log` | Replace the cache's evidence identity key with a constant | Changed receipt target identity incorrectly reuses the cached result inside 60 seconds |
| `mutant-M4.log` | Remove the generation check after the awaited target-health read | A tick incorrectly proceeds after the phase leaves idle and returns during that read |

Production rules were already correct; the mutants provide the red-first failure
proof for the new tests rather than a fabricated production bug. Final gate
results are recorded by the execution lane separately. These are runtime fixture
proofs, not real RAUC, kernel-lock, board-load or fallback restoration qualification.
Committed transcripts normalize the checkout prefix in stack locations to
repository-relative paths and trim trailing whitespace in empty source excerpts.
The execution lane retains the raw output separately.
