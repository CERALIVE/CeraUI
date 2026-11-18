# System Logs critique (impeccable `critique`, device-log-system todo 36)

Method: dual-agent (A: design review, B: detector and browser evidence), run
2026-11-18 against the integrated screens (Events, Raw logs, Boots, Storage,
Sharing, View logs) on the mock backend and a separate Vite frontend. The
design passes stop here per DESIGN.md section 9: this pass fixed every P0 and
P1, and every P2 or P3 is either fixed or recorded with an owner in
[`docs/DESIGN-FOLLOWUPS.md`](../../../../docs/DESIGN-FOLLOWUPS.md) section 5.

Contract: [system-logs-view.md](system-logs-view.md). Captures are git-ignored
under `apps/frontend/test-results/system-logs/`: `t36-before-*` (the
integrated tip before this pass), `t36-after-*` and `t36-final-*` (after it).

## Captures

| Set | Files |
|---|---|
| 1280x800 dark | `t36-{before,after}-1280x800-dark-{events,boots,raw,raw-detail,storage,storage-cleanup,downloads,share,export,clear-confirm,view-logs-action,view-logs-jump}.png` |
| 1280x800 light | the same views, `-light-` |
| 375x812 dark | the same views plus `raw-filters`, `-375x812-dark-` |
| 375x812 light | the same views plus `raw-filters`, `-375x812-light-` |
| Locales at 320 and 375 | `t36-before-loc-{es,ja,ko,zh}-{320,375}-*.png`, `t36-after-{es,ja,ko,zh}-{320,375}-*.png` (events, raw filters, raw empty, storage, cleanup, downloads, sharing, share) |
| Final window jump | `t36-final-{1280x800,375x812}-{dark,light}-view-logs-jump.png` |
| Events keyboard | `t36-{before,after}-kbd-{1280x800-dark,1280x800-light,375x812-dark}-events-arrowdown.png`: focus after ArrowDown from the first row's View raw logs; the focused row and the count of tabbable row actions are in each round's manifest |

## Scores (Assessment A, before this pass)

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 3 | The message jump's Level showed Info over debug rows (SL-1) |
| 2 | Match system / real world | 2 | Four overlapping file names; storage jargon |
| 3 | User control and freedom | 3 | Two deletions run on one tap (by contract, with result text) |
| 4 | Consistency and standards | 2 | Two time formats; two dialog backdrops; toast action off-system |
| 5 | Error prevention | 3 | Clear actions confirm; Enter never confirms |
| 6 | Recognition rather than recall | 2 | Support bundle sits under the Storage tab below 1024 px |
| 7 | Flexibility and efficiency | 2 | No list roving in Events; no shortcuts |
| 8 | Aesthetic and minimalist design | 2 | Repeated row actions; storage administration beside the reading list |
| 9 | Error recovery | 3 | Calm bands with Retry; one generic storage failure line |
| 10 | Help and documentation | 2 | Nothing says which file to send a helper |
| | **Total** | **24/40** | Acceptable |

Design specificity: the tokens, type pairing and truthful unknown states are
the product's own (Ground Control); the composition (tabs, chip row, row list,
settings column) is a stock log viewer. Deterministic scan: `impeccable detect`
returned `[]` for `main/system-logs`, `LogsDialog.svelte` and
`ViewLogsAction.svelte` (regex engine only for `.svelte`, so not a clean bill);
the in-page detector found nothing inside the System Logs dialog in any view
(a planted canary proved it scans dialog content) and one finding inside the
clear confirmation: the destructive action's contrast (SL-5). Its other 10-15
findings per page belong to the destinations behind the modal.

What works: unknown never renders as zero or as clean; the raw list reads like
an instrument (mono tabular times, shape-plus-colour severity, wrapping rows,
one roving stop); sharing states the sensitive-data risk and the bundle's
redactions before anything downloads.

## Findings

| Severity | ID | Finding | Evidence | Disposition | Status |
|---|---|---|---|---|---|
| P0 | SL-1 | A message or event jump into Raw logs misstated its own window. Level showed the operator's "Info" while the window read every level (debug rows under a checked Info); Time showed "This boot" while the window read the one boot of the message or event, so an older boot's entries could sit under "This boot". | `t36-before-1280x800-dark-view-logs-jump.png`, `t36-before-375x812-light-view-logs-jump.png`; after: `t36-final-*-view-logs-jump.png` | Fixed in the commit `fix(frontend): address System Logs critique findings`: while anchored, Level shows the window's level set (`RawView.anchor.level`) and Time shows "Selected boot" and counts under Filters (`timeShown`); Back to latest entries returns both to the operator's choices. | fixed |
| P2 | SL-2 | The two shipped download rows split Japanese and Korean words and strand endings ("ダ/ウンロード", "しま/す。", "다운로드합/니다."), unlike the Sharing rows beside them. | `t36-before-loc-ja-320-downloads.png`, `t36-before-loc-ko-375-downloads.png`; after: `t36-after-{ja,ko}-{320,375}-downloads.png` | Fixed in the same commit: the rows use the Sharing rows' line-break set and `KeepWords` (Chinese word gaps). | fixed |
| P2 | SL-3 | The helper's file is the fourth of four equal download rows, and below 1024 px it sits under the Storage tab after limits and cleanup. Assessment A rated it P1; graded P2 here because the approved shape (todo 6) and shell (todo 28) place it there, it is one tab and one scroll away under a Downloads heading, and moving it is a layout redesign this pass must not make. | `t36-before-375x812-dark-storage.png`, `t36-before-375x812-dark-downloads.png`, `t36-before-1280x800-dark-downloads.png` | Recorded as DF-23. | recorded |
| P1 | SL-4 | Events had no roving list, against contract section 7 (one list stop; Up, Down, Home and End move between rows; Tab reaches the focused row's actions). ArrowDown left focus on the first row's View raw logs, and every row's actions were in the tab sequence (114 actions across 60 rows in the mock). | `t36-before-kbd-*-events-arrowdown.png` (focused row 0, 114 tabbable actions); after: `t36-after-kbd-*-events-arrowdown.png` (focused row 1, 2 tabbable actions) | Fixed in the commit `fix(frontend): address System Logs critique findings`: a row's stop is its first action, View raw logs; Up, Down, Home and End move it between rows; Tab reaches that row's Diagnostics; only the stop row's actions are in the tab sequence, and the stop follows focus. While its request is pending, View raw logs is aria-disabled and aria-busy, never disabled, so focus stays on it, the keys still cross its row, and a repeat press does nothing (second-round review of `0ae9e4bd`: a disabled button dropped focus; red receipt `t36-r3-red-pending-e2e.log`). | fixed |
| P2 | SL-5 | The destructive confirmation action's text measures 3.07:1 (dark) and 3.84:1 (light) against 4.5:1 (shared `destructive` button variant). | `t36-before-1280x800-{dark,light}-clear-confirm.png`; detector and probe 3.1:1 / 3.9:1 | Recorded as DF-25. | recorded |
| P2 | SL-6 | Spanish "Registros sin procesar" wraps to three lines at 320 and 375 px (66 px tab strip, nothing clipped); the Spanish header boot button wraps "Todos los / arranques" at 320 px; the search placeholder ellipsizes at 375 px. | `t36-before-loc-es-320-events.png`, `t36-after-es-320-events.png`, `t36-before-375x812-dark-raw.png` | Recorded as DF-26. | recorded |
| P2 | SL-7 | Targets outside touch layout: the toast "View logs" action is 69x24 px in the system font; the default-pointer notice action is 28 px; in touch layout the retention select's option rows stay 28 px (shared select item). Touch layout lifts every other System Logs control to 44 px. | `t36-before-375x812-dark-view-logs-action.png`; Assessment B touch probe | Recorded as DF-27. | recorded |
| P2 | SL-8 | A download the browser refuses leaves its export or bundle ticket unconsumed, so Retry within 60 s reads Busy. | todo 34 integration note; `sharing-flow` refusal path | Recorded as DF-28. | recorded |
| P2 | SL-9 | In an approximate jump nothing marks the message's moment, the newer end reads "No more entries match in the stored logs." above the newest rows, and the approximate note is muted extra-small text. | `t36-before-1280x800-dark-view-logs-jump.png` | Recorded as DF-29, then fixed by todo 38: a Selected moment row and a newer-end text (DF-29). | fixed |
| P3 | SL-10 | The Japanese empty-search hint carries a stray "、" before "の". Todo 30 reported it starting a line at 320 px; the t36 before capture shows "、の" ending the line instead, away from "いずれか". | todo 30 note; `t36-before-loc-ja-320-raw-empty.png`; after: `t36-after-ja-320-raw-empty.png` | Fixed in the same commit: the Japanese copy drops the comma before の, so the phrase breaks after it. The defect is Japanese-only; the other nine locales have no such particle. | fixed |
| P3 | SL-11 | A clear confirmation opens with focus on the dialog, not Cancel (contract section 7). Enter cannot confirm, so it is safe. | measured `activeElement` in the before capture | Recorded as DF-30, then fixed by todo 38: both confirmations open on Cancel (DF-30). | fixed |
| P3 | SL-12 | Polish residuals: two time formats (Events `8:15:04 AM`, Raw `08:17:02 AM`); the Order label sits higher than Sources and Time; the phone Storage tab repeats a "Storage" heading; an expanded raw row repeats the unit; side boot rows wrap their "Boot started" prefix; a usage bar under 1 % is an empty track; "All sources" reads as placeholder grey; the checked segment is recessed in dark. | `t36-before-1280x800-dark-raw.png`, `t36-before-375x812-dark-storage.png`, `t36-before-1280x800-dark-boots.png` | Recorded as DF-31, then decided by todo 38: four items fixed, four kept with their reasons in the view contract (DF-31). | decided |
| P3 | SL-13 | The confirmation backdrop (a light wash that brightens the dark UI) differs from the view's dialogs; Save limits and Download bundle are filled lime while Follow avoids lime. | `t36-before-1280x800-dark-clear-confirm.png`, `t36-before-1280x800-dark-export.png` | Recorded as DF-32. | recorded |
| P3 | SL-14 | Two live Raw views at once would let the later Follow win. No surface mounts two today. | contract note (Raw view) | Recorded as DF-33. | recorded |
| P2 | SL-15 | A newer event in the same boot re-keyed the whole boot section (its key held the section's first event id), so the focused row's action was rebuilt and focus fell to the dialog's Close button; the stop itself followed the event. Found by the second-round review of `0ae9e4bd`. | red receipts `t36-r3-red-insert.log` (focus on `<body>`), `t36-r3-red-insert-e2e.log` (focus outside every row) | Fixed in the commit `fix(frontend): address System Logs critique findings`: a boot section's key is its boot id and run number, so it stays stable as newer events join and the focused row keeps its element, focus and stop. | fixed |
| P2 | SL-16 | A sequence-gap reload clears every Events row before the first page returns, so a focused row action is disconnected even when its event survives: focus moves to Close at 1280 px and to the boot picker at 375 px, while the stop returns to the row. Found by the third-round review of `2afd8d73`, in both themes at both widths. | third-round review proof `exact-en-1280-dark.json`, `exact-en-375-light.json`; `events-view.svelte.ts:110-116,246-250` | Recorded as DF-34, then fixed by todo 38: a re-read keeps its rows until the page replaces them (DF-34). | fixed |

No P0 or P1 finding is open.

## Carried follow-ups

| Item | Decision |
|---|---|
| Spanish tab-strip clipping at 320 px | Measured: wraps, not clipped. SL-6, recorded. |
| Japanese tab label ストレージ wrapping | Does not reproduce at the integrated tip: one line at 320 and 375 px (`t36-before-loc-ja-320-events.png`, tab measurements in the capture manifest). Closed, no change. |
| Korean Downloads ending | SL-2, fixed. |
| Default-pointer notice 28 px, Sonner action 24 px outside touch layouts | SL-7, recorded. |
| 28 px retention option rows (shared select item) | SL-7, recorded. |
| Destructive-button contrast | SL-5, recorded. |
| Initial Cancel focus in the two System Logs clear confirmations | SL-11, fixed by todo 38 in StorageCleanup (DF-30). |
| ja.json `systemLogs.raw.emptyHint` 'の' line start | SL-10, fixed. |
| Refused download leaves the ticket unconsumed (Busy for 60 s) | SL-8, recorded. |
| Two Raw views at once | SL-14, recorded. |

## Considered and not adopted

- Keyboard shortcuts, multi-row copy, and making the event row itself the
  button: new features or a recomposition, outside this pass.
- Dropping the Export confirmation: the plan requires every export to state
  that it may contain sensitive data before it downloads.
- The 1.7 px gap inside the Level control: the segments are one radio group,
  not separate controls; every segment is a 44 px target in touch layout.

## Run notes

- Assessments ran as two isolated sub-agents; A finished before any detector
  output entered the synthesis. The in-page detector ran only in headless
  pages, so no user-visible overlay exists; its live server ran in a scratch
  directory and was stopped.
- The critique snapshot was not written to `.impeccable/critique/`: this file
  is the tracked record, and a shared lane takes no untracked tool state.
- Questions skipped: the plan's todo 36 fixes the scope (every P0 and P1 fixed,
  every P2 and P3 fixed or recorded with an owner), so no direction question
  was open; 5 priority issues were listed.
- Not checked here: 768 px, the 1024x600 kiosk, Arabic RTL, screen readers and
  hardware. Todos 37 and 38 own those passes.
