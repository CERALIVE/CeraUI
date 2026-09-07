# Frontend setup-cost measurements

## Measurement contract

Base: `ca5b0b20ab0b78698461dafa866b2bffa5505127` (current `origin/main`
when fetched on 2026-09-07). Runtime: Bun 1.4.2; Vitest 5.0.0.

Measure the full frontend command, including catalog generation and hardware
preflight, twice for each candidate. Preserve file/test counts and failures as
well as wall time and Vitest phase durations. Run candidates sequentially, not
against each other on the same host. Optimizer, setup-lightening, isolation and
filesystem-cache changes require at least 20% lower mean wall time than baseline
and three green parity runs before adoption. Registration deduplication instead
requires a proven reduction in redundant registrations and green parity.

The inherited experiments were preserved separately and are not adopted. The
current setup eagerly imports the catalog for every isolated component file;
the storage setup registers no messages. The previous profile locates the cost
in eager namespace imports, not in test assertions or the retained 50 ms teardown.

## Results

| Configuration | Run | Wall seconds | Vitest seconds | Files / tests | Phase shares (setup / transform / import / tests / environment) | Exit |
|---|---:|---:|---:|---:|---|---:|
| Current main | 1 | 656.451 | 649.25 | 375 / 6,234 | 84 / 8 / 4 / 3 / 2 % | 0 |
| Current main | 2 | 669.204 | 661.09 | 375 / 6,234 | 84 / 8 / 4 / 3 / 2 % | 0 |

Baseline mean wall time: **662.827 seconds**. Adoption threshold: **530.262
seconds or less** (20% faster), plus three green runs at identical counts.
Vitest's phase percentages are rounded, aggregate worker-time shares; they may
sum to 101% and are not elapsed wall-time slices. No runner setting is adopted yet.
