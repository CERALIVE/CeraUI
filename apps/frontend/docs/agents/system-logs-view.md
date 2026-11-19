# System Logs view: planning-time design intent and code map

Planning-time design intent (sections 1 to 6) and a code map (section 7) for the full-viewport
System Logs view opened from Settings -> System Logs. Backend contracts:
[device-logs.md](../../../backend/docs/agents/device-logs.md) and
[device-events.md](../../../backend/docs/agents/device-events.md); event
feed: [event-timeline-feed.md](event-timeline-feed.md). It
works inside the incumbent visual world: `PRODUCT.md` and
`.impeccable.md` (Ground Control: graphite, phosphor lime for the live signal,
amber and coral states) and the checkable rules in `DESIGN.md` sections 1-8.
It is an Operate surface: familiar controls, brand only through tokens, type and
density. It is not a redesign.

## Job, outcome and direction

> Design intent recorded at planning time. It is not a description of the shipped
> behaviour; see the Code map and system-logs-critique.md.

- **Who arrives.** The operator in the field, under time pressure, on a phone
  (375 px), a tablet, a laptop or the 1024x600 touch kiosk, usually right after a
  message told them to check the logs. Second: the helper (community or
  CeraLive engineer) who receives a file from them.
- **Job.** Answer "what just happened?" in plain language, then open the raw
  entries behind it; hand a helper one file that states what was running.
- **Information priorities.** (1) What happened, newest first, with its
  severity. (2) When, and in which boot, with that boot's system image and slot.
  (3) The raw entries around that moment.
- **Primary action per region.** Events: none; the view is a reading instrument
  and each row's "View raw logs" is a quiet ghost action. Raw logs: Follow, the
  most prominent control of the tab, deliberately an `outline` button: a filled
  lime button reads as going live. Storage: Save limits (`default` variant, the
  same Save vocabulary as every `AppDialog` footer), disabled until a limit or Detail changes (`main/system-logs/StorageLimits.svelte:149-170`). Destructive actions are `outline` triggers; only their confirmation
  button uses the `destructive` variant.
- **Signature move.** The boot separator. In Events each boot group has a sticky
  heading with its start time and the system image, slot and end mark that are
  recorded (`main/system-logs/EventsTab.svelte:213-241`); Raw logs separates rows
  by date and clock rows instead (`lib/device-logs/raw-rows.ts:120-147`). A boot loop reads as a run of short segments
  with unclean marks, which is what the operator must see first.
- **Left out on purpose.** Stat tiles or counts above the lists, charts of error
  rates, a description line under the title, text search on Events (it has
  family and problem filters), per-row badges without a state behind them,
  icons on the family filter chips, any lime accent outside the live stream
  pill, glass or blurred panels, coloured side stripes on rows or bands.
- **Owner decisions honored.** One full-viewport dialog, never a fourth
  destination or a hash route; Events is the default tab; Detail Full keeps
  debug entries and Detail Reduced sets the production journal console level to
  info, unless `LOG_LEVEL` overrides it (`apps/backend/src/helpers/logger.ts:706-714`); retention can only tighten the device's
  own limit; "Delete older log files" reports which boots remain instead of
  promising they are gone; the two legacy downloads keep their actions and their
  rendering changed (critique SL-2);
  temperature events are out of scope.
- **Assumptions (not confirmed by the owner).** Below 1024 px the boot picker
  lives only behind the header button and the Storage tab does not repeat it;
  the clock-not-synced marker uses only backwards-running times as evidence
  (see Open decisions).

## 1. Structure

> Design intent recorded at planning time. It is not a description of the shipped
> behaviour; see the Code map and system-logs-critique.md.

- **Entry.** Settings -> System Logs opens `F/main/dialogs/LogsDialog.svelte`
  (same file, same lazy import, same `open` prop), now a thin shell in the
  `DeviceHealthDialog.svelte` pattern rendering `F/main/system-logs/SystemLogsView.svelte`.
  (`F/` = `apps/frontend/src/`.)
- **Surface.** `AppDialog` with an additive `fullscreen` prop: the centered
  Dialog primitive at every width, `fixed inset-0`, no `max-h-[85svh]`, no
  rounded corners, body without its own padding so the view owns layout.
  Existing dialogs are unchanged. The side-column switch uses `WIDE_DESKTOP_QUERY`
  (1024 px) from `$lib/layout`, not `DESKTOP_CHROME_QUERY`, so an 800x480 kiosk
  gets the tabbed layout.
- **Header (one row at >= 768 px).** Title "System Logs" (existing key
  `settings.index.logs`, unchanged), then the header aside at the inline end:
  the stream-state pill, and below 1024 px the boot button; then the existing
  close button pinned at the inline end (`data-testid="app-dialog-close"`,
  name from `dialogs.close`, 44 px hit area through `data-touch-target="hit-area"`).
  The aside is an additive optional `AppDialog` header snippet rendered after
  the title element, outside it, so the dialog's accessible name stays exactly
  "System Logs". No description line: `settings.index.logsDesc` stays the
  Settings entry's description, unchanged.
- **Stream-state pill.** Reads the HUD state (`getHudState()`,
  `main/system-logs/StreamStatePill.svelte:22-23`): Live reuses the HUD live indicator styling (other lime uses:
  critique SL-13), Idle and Offline are
  neutral pills; copy is the existing `hud.live`, `hud.idle`, `hud.offline`.
  Offline wins over Live, so a dropped connection never looks live.
- **Tabs.** `F/lib/components/ui/tabs`: Events (default) | Raw logs, plus
  Storage below 1024 px. Each tab panel owns its scroll.
- **Side column (>= 1024 px).** 320 px at the inline end, its own scroll, three
  regions in this order with a heading each: Boots (the boot picker), Storage,
  Downloads. Regions are separated by whitespace and a neutral 1 px rule, not
  boxed.
- **Below 1024 px.** The Storage tab holds the Storage and Downloads regions;
  the boot picker is the header button showing the selected boot, opening a
  nested `AppDialog` (sheet on phones) listing boots; choosing one closes it.
- **Downloads region.** First group: the two legacy rows (wrapping changed, critique SL-2; icon
  tile, title, description, outline Download button, inline amber retry band;
  testids `log-row-device`, `log-row-system`, `log-download-device`,
  `log-download-system`, `log-download-error`, `log-download-retry`; copy
  `advanced.ceraliveLog`, `advanced.ceraliveLogTooltip`, `advanced.systemLog`,
  `advanced.systemLogTooltip`, `advanced.download`, `advanced.downloading`,
  `advanced.downloadFailed`, `advanced.retryDownload`). Second group, after a
  neutral rule, same row anatomy: Export this view, Support bundle; one line
  under it says files are saved by the browser. Export this view saves the
  Raw tab's filters and time window; an exact anchor pages its whole boot, so
  there it saves the 10 minutes around the anchored entry with the window's
  levels, and the confirmation says so (`lib/device-logs/raw-paging.svelte.ts`).
  The Downloads region renders
  immediately; the Sharing group renders only once the viewer check is ready (`main/system-logs/SystemLogsView.svelte:172-174`).
- **Older backend.** If the log procedures are missing, the tabs and the Storage
  region are replaced by one calm notice ("not available on this device
  version"); Downloads still renders.
- **Deep links.** The "View logs" action next to log-pointing messages uses the
  key `notifications.viewLogs` in the boot-time `notifications` namespace (not in
  this inventory) and opens this view on Raw logs at the message's moment: a
  toast at its arrival, and a refusal band at the moment the device answered.
  The device replays its standing notices to every connection it opens, so a
  standing notice opens at the exact entry of the timeline event it emitted
  (an update notice named `update:<kind>:<id>` emits `update_<kind>` with that
  id), else around its arrival when it arrived live, else at the newest
  entries with no anchor (`lib/device-logs/view-logs.ts`,
  `lib/device-logs/raw-anchor.ts`). The low-disk banner keeps
  `settings.deviceStats.lowDiskAction` and opens Storage.
- **Primitives.** `AppDialog`, `Button`, `Tabs`, `Select` (single and multiple),
  `Input`, `Toggle` (single-choice groups), `Skeleton`,
  `simple-alert-dialog.svelte` (confirmations), Lucide icons only. The Events
  Diagnostics disclosure is a `Button` with a hidden region
  (`main/system-logs/EventRow.svelte:103`). No edits under
  `F/lib/components/ui/`.

Layout: System Logs view - a long reading list must share one viewport with
filters, a boot list, storage controls and downloads, down to 1024x600 and 375
px -> full-viewport work surface: fixed header, fixed tab strip, fixed filter
bar, one scrolling list per tab panel, optional 320 px side column; scroll
owner: the active tab panel's list region (and the side column on its own),
never the dialog body or the page; anti-patterns: page scroll behind the
dialog, a scroller nested inside a row, horizontal scroll for long log lines,
a filter bar that scrolls away with the list.

## 2. States per region

> Design intent recorded at planning time. It is not a description of the shipped
> behaviour; see the Code map and system-logs-critique.md.

Every state is a rendered, testable node; none is a toast alone. Copy keys are
in section 4.

| State | Region | What renders | Announced (design intent, not measured) |
|---|---|---|---|
| Loading | Events, Raw logs, Boots, Storage, bundle preview | Skeleton placeholders (the bundle preview uses plain skeleton blocks and status text, `main/system-logs/BundleDialog.svelte:101-107`) | status role (section 7 map) |
| Empty | Events | Title "No events recorded yet" plus a sentence naming what will appear (stream, links, modems, updates, restarts, capture) | no |
| Empty | Raw logs | "No entries match" plus a hint that teaches the filter (fewer sources, wider level, longer time, shorter text) and a Show everything action resetting to defaults | no |
| Empty (filtered) | Events | "No events match these filters" plus Show all events | no |
| Error with recovery | regions using `RecoveryBand` (section 7 map) | Inline band in the existing amber recovery style (`border-status-warning/30 bg-status-warning/10`, `role="alert"`) naming the problem; which regions render `RecoveryBand` and its Retry: section 7 map | alert |
| Busy | Raw logs, Sharing | "Another view is reading logs" (Raw, `BUSY`) or "Another export is running" (Sharing) | alert |
| Bundle refused | Sharing | The device refused to prepare the bundle (`READ_FAILED`, which includes the fail-closed collision of a held secret with a structured value): the failure band, then under it "Use Export this view instead." and an Export this view button that opens the export confirmation (`main/system-logs/BundleDialog.svelte:132-145`, `lib/device-logs/sharing-flow.svelte.ts`) | alert (the band); the button is described by the line |
| Expired position | Raw logs | `CURSOR_UNAVAILABLE` or `FILTER_CHANGED`: "This position is no longer stored" with Start from newest; rows already shown stay, paging toward the lost side is disabled | alert |
| Keep searching | Raw logs | `hasMore: null`: a Keep searching button and a line saying only part of the stored logs was checked; never an end marker (the normal state for a time-bounded view once its entries are shown) | no |
| End of results | Raw logs, Events | Raw logs shows an end marker at an exhausted, available edge after the first load when rows are present. The display-limit notice takes precedence at the bottom. Approximate-window markers name the time window. Events shows an end row when events are present and no older page or paging error remains. | no |
| Row cap reached | Raw logs | `ROW_CAP` is 2000 journal entries, excluding marker rows. Only entries beyond the cap are dropped and stop older paging | no |
| Browsing older history | Events | Load older rolls the 300-event window toward older results while the server has more. Live pushes leave that window in place. Start from newest returns to the live edge | no |
| Follow unavailable | Raw logs | Follow present, disabled, with an adjacent reason element (`data-testid` ending `-reason`) when the time is not This boot, the order is not Newest first, or the tab is in anchor mode (DESIGN.md CT-2). Follow displays while connected and is aria-disabled while its request is busy | no |
| Following | Raw logs | Follow becomes Pause; a state label "Following" in `--status-info` with a `motion-safe` pulse dot; static dot plus label under reduced motion or e-ink | polite |
| New entries held | Raw logs | While scrolled away from the top, incoming entries wait (cap 500) behind a "New entries: {count}" button at the top of the list; selecting it merges them and scrolls to the top | polite, throttled |
| Paused | Raw logs | Label "Paused", Resume action; checkpoint and resume code: `lib/device-logs/raw-follow-session.svelte.ts:62-88`; backend catch-up limit: [device-logs.md](../../../backend/docs/agents/device-logs.md) | polite |
| Gap marker | Raw logs | A full-width separator row (neutral 1 px rules either side of centered text) stating what was skipped and why: catch-up exceeded, position removed by cleanup, or entries dropped by the device | polite |
| Dropped marker | Raw logs | `dropped > 0` in a follow batch: one separator row "Entries skipped while following: {count}". journald's suppressed-messages record (`marker: 'suppressed'`) is a separate marker row (`lib/device-logs/raw-rows.ts:90-105`, `main/system-logs/RawLogRow.svelte:59-68`) | polite (as a gap) |
| Follower stopped | Raw logs | Label "Stopped" with its reason (reader ended, device restarted, logs cleared) and a Follow action; `ended: 'cleared'` also resets the list | polite |
| Disconnected | Raw logs, Events, header pill | The socket dropped: follow state "Disconnected", a notice that entries may be out of date, rows dimmed to `text-muted-foreground`, the pill shows Offline, no pulse anywhere; stale, never fresh-looking. Raw logs shows Disconnected only when a follow was active, and on reconnect offers Resume (`lib/device-logs/raw-follow-session.svelte.ts:91-100`, `main/system-logs/RawFollowControl.svelte:28-56`); Events reloads its first page on reconnect (`events-view.svelte.ts:150-156`) | polite |
| Anchor | Raw logs | Opened from an event or a "View logs" action: the matching row has a tonal highlight (`bg-status-info/10`, no outline or stripe); an exact match receives focus and an approximate one leaves focus on the selected tab (`main/system-logs/SystemLogsView.svelte:132-136`, `main/system-logs/RawLogList.svelte:79-89`); "approximate" is stated when no exact entry matched; a Back to latest entries action leaves anchor mode | no |
| Unknown event code | Events | A record from a newer version: the family icon, the title "Event recorded by a newer version", one honest detail sentence, View raw logs, and the raw code only inside a collapsed Diagnostics disclosure (`data-testid` containing `diagnostic`, DESIGN.md OL-3..OL-5). A known code with invalid params shows its title with no detail | no |
| Logs removed for a boot | Boots, Events, Raw logs | Boot rows keep the boot with a "Logs removed" label (never hidden); View raw logs on such a boot shows "Raw logs for this boot were removed"; a Raw query with `BOOT_UNAVAILABLE` shows "Logs for this boot were removed" with Show this boot | alert (Raw only) |
| Clock-not-synced marker | Raw logs, Events | Where two adjacent records of the same boot (journal order for raw, `seq` order for events) run backwards in time, a separator row says the device clock changed there and earlier times may be wrong. Times are never corrected or re-sorted | no |
| Not available on this device version | whole view | One calm notice in place of tabs and Storage; Downloads still works | no |
| Limits unknown | Storage | `ceiling: null`: both limit selects present, disabled, with a reason element; Detail stays editable | no |
| Usage not reported | Storage | `journalBytes: null`: "not reported by this device" text, no bar, never 0 | no |
| Update in progress | Storage | `UPDATE_IN_PROGRESS` on Clear all: the refusal and what to do, data left as shown | alert |
| Saved, target not met | Storage | After Save: when `targetMet` is false, a line saying the limit is not met yet and the device removes more as it rotates files | polite |

## 3. Row anatomy

> Design intent recorded at planning time. It is not a description of the shipped
> behaviour; see the Code map and system-logs-critique.md.

**Event row** (Events tab), a list item in a two-column grid:

- Column 1: the severity glyph (section 5), 16 px, with its accessible name.
  Unknown codes show the family icon instead (stream `Radio`, network `Network`,
  cellular `SignalHigh`, update `Download`, device `Cpu`, capture `Video`).
- Column 2, line 1: title (`text-sm font-semibold`, `text-foreground`) at the
  inline start; time at the inline end: absolute (locale time, plus the date
  when not today) and relative ("2 minutes ago", `formatRelativeTime`; the last
  few seconds read as the locale's word for now, `eventTime` in
  `lib/device-logs/timeline-copy.ts`, DESIGN-FOLLOWUPS DF-37) in
  `text-xs text-muted-foreground tabular-nums`, inside `<time datetime>`.
  Below 768 px the time moves under the title.
- Line 2: one detail sentence (`text-sm text-muted-foreground`), data params in
  `<bdi>`. Omitted when the code has no detail or its params fail the registry.
- Line 3 (only when present): "Similar events folded in: {count}" and the
  View raw logs ghost action (`size="sm"`, hit-area overlay in touch mode).
- Spacing: the finding-row rhythm (`px-4 py-3`), rows separated by neutral 1 px
  rules; no card per row, no nested cards.

**Boot separator** (signature move), a heading row (`h3`) sticky at the top of
the list while its boot's rows show, when the boot record has them (otherwise a fallback line):
"Boot started {time}", the system image, slot and shutdown mark (glyph plus
  text, section 5) (`main/system-logs/EventsTab.svelte:213-241`), and a
"Changed" tag when the system image or slot differs from the previous boot.
Surface: the next step of the surface ramp (`bg-muted`), neutral rules above
and below. Focus-ring visibility under the sticky heading is not measured.

**Raw entry row** (Raw logs tab), one list item:

- From a 40rem container width (`@min-[40rem]`,
  `main/system-logs/RawLogRow.svelte:86,100`), one grid line: level glyph (16 px) | time (locale time
  of day with seconds, `font-mono text-xs tabular-nums`) | unit (`text-xs
  text-muted-foreground`, max about 14ch, truncates; full value in the expanded
  row) | message (`font-mono text-xs`).
- Below 40rem, two lines: glyph, time and unit on line 1; message full width on
  line 2.
- The message wraps (`overflow-wrap: anywhere` for paths and hex runs); there is
  never horizontal scroll. Unit and message carry `dir="ltr"` inside RTL chrome.
- Info messages use `text-foreground`; debug messages use
  `text-muted-foreground` (the "dimmer" step).
- A date separator row (formatted date, neutral rules) appears at the top and
  wherever the local date changes between adjacent rows.
- The whole row is a button that expands it: full message, full unit, a
  "shortened" note when `truncated` is true, and Copy. Rows keep one box per
  state; expansion grows height only.
- Marker rows (gap, dropped, suppressed, clock, end) are separator rows (the cap
  message is plain centered text, `RawLogList.svelte:133-136`) with
  centered `text-xs text-muted-foreground` text between neutral rules; never a
  coloured bar.

**Boot picker row**: shutdown mark glyph plus text label, start time, system
image and slot when known ("Versions not recorded for this boot" otherwise),
"Logs removed" when `logsAvailable` is false, "Changed" tag; the selected boot
carries a check glyph and a tonal wash, never an accent outline. "All boots"
is the first row.

**Storage**: usage as a decorative meter (`main/system-logs/StorageUsage.svelte:29-33,50-52`) plus text only when both used and limit are
known (otherwise text only, never a bar or a zero); the on-disk line when the
directory total exceeds the journal's own count; oldest entry; event history
size; "Recent volume by source" as a compact table (Source | Entries | Size,
with a neutral proportional bar in the Size cell, labelled as a sample); the
limits form (Keep for, Maximum size, Detail with each option's one-line
consequence, Save limits); then the four actions, destructive ones last.

## 4. Copy inventory

> Design intent recorded at planning time. It is not a description of the shipped
> behaviour; see the Code map and system-logs-critique.md.

Rules for this copy:

- Two new lazy namespaces only: systemLogs (screen chrome, raw tab, storage,
  sharing) and timeline (event titles and detail sentences). The namespace is
  timeline, not events, because the backend i18n-key gate treats any
  backend string literal that starts with a namespace name and a dot as a
  message key, and the event store file is events.jsonl. Neither is named
  logs.
- The live mode is called "Follow", never "Go live" (that phrase belongs to the
  Live destination's stream start). The deep-link action is "View logs" and
  never contains "System Logs" (existing e2e locators match that name by
  substring).
- Whole sentences only, no concatenation of translated fragments; interpolate
  only data params ({name}, {iface}, {version}, {count}, sizes and times
  formatted by the frontend). Counts use the "Label: {count}" form unless
  packages/i18n/docs/PLURAL-GRAMMAR.md is followed.
- {name} on link rows is the link's display name when present, else its
  interface name. Every data param renders inside a bdi element.
- Event titles are past-tense records, not instructions. Codes, params and enum
  values are owned by EVENT_REGISTRY in packages/rpc/src/schemas/events.schema.ts;
  where the registry names something differently, it wins and the sentence
  shape here is kept. Enum values are used verbatim as key segments (hyphens
  included). A code uses either one detail key or one detail key per variant
  (detail.operator, detail.engine_loss), never both; a code without a matching sentence shows its title alone.
- Spanish is es-419 with tú. UI copy uses "registros" for logs, "partición"
  for a system slot (`systemLogs.boots.slot` is "Partición {slot}") and
  "transmisión" for the stream (`timeline.family.stream` is "Transmisión").
- Existing keys reused unchanged are listed in section 1; none is edited.

### Screen chrome, boots and shared labels

| Key | English | Used for |
|---|---|---|
| `systemLogs.tabs.label` | Log views | Accessible name of the tab list |
| `systemLogs.tabs.events` | Events | Tab |
| `systemLogs.tabs.raw` | Raw logs | Tab |
| `systemLogs.tabs.storage` | Storage | Tab, below 1024 px only |
| `systemLogs.unavailable.title` | Not available on this device version | Older backend notice |
| `systemLogs.unavailable.body` | This device's software doesn't include the log viewer yet. The downloads below still work. | Older backend notice |
| `systemLogs.action.retry` | Retry | Region recovery bands (shell and chunk recovery use `errorBoundary.retry`) |
| `systemLogs.loading.entries` | Loading entries… | Hidden status during Raw skeleton |
| `systemLogs.loading.events` | Loading events… | Hidden status during Events skeleton |
| `systemLogs.level.error` | Error | Raw level glyph name |
| `systemLogs.level.warning` | Warning | Raw level glyph name |
| `systemLogs.level.info` | Info | Raw level glyph name |
| `systemLogs.level.debug` | Debug | Raw level glyph name |
| `systemLogs.severity.error` | Error | Event severity glyph name |
| `systemLogs.severity.warning` | Warning | Event severity glyph name |
| `systemLogs.severity.info` | Information | Event severity glyph name |
| `systemLogs.severity.success` | Success | Event severity glyph name |
| `systemLogs.source.app` | CeraLive app | Source filter and volume table |
| `systemLogs.source.engine` | Streaming engine | Source filter and volume table |
| `systemLogs.source.bonding` | Bonding sender | Source filter and volume table |
| `systemLogs.source.network` | Network | Source filter and volume table |
| `systemLogs.source.cellular` | Cellular modems | Source filter and volume table |
| `systemLogs.source.updates` | Updates | Source filter and volume table |
| `systemLogs.source.device` | Device services | Source filter and volume table |
| `systemLogs.source.kernel` | Kernel | Source filter and volume table |
| `systemLogs.source.other` | Other sources | Volume row for a null source |
| `systemLogs.boots.heading` | Boots | Side-column region heading and boot sheet title |
| `systemLogs.boots.open` | Choose a boot | Accessible name of the header boot button |
| `systemLogs.boots.all` | All boots | First picker row; header button label |
| `systemLogs.boots.current` | This boot | Header button label for the running boot |
| `systemLogs.boots.started` | Boot started {time} | Picker row, header button, Events boot separator |
| `systemLogs.boots.systemImage` | System image {version} | Picker row and separator |
| `systemLogs.boots.slot` | Slot {slot} | Picker row and separator |
| `systemLogs.boots.versionsUnknown` | Versions not recorded for this boot | Picker row and separator |
| `systemLogs.boots.mark.current` | Running now | Shutdown mark |
| `systemLogs.boots.mark.clean` | Shut down cleanly | Shutdown mark |
| `systemLogs.boots.mark.unclean` | Ended unexpectedly | Shutdown mark |
| `systemLogs.boots.mark.unknown` | End not determined | Shutdown mark (never styled as clean) |
| `systemLogs.boots.logsRemoved` | Logs removed | Boot whose raw logs are gone |
| `systemLogs.boots.changed` | Changed | Tag when system image or slot changed |
| `systemLogs.boots.changedDescription` | The system image or slot differs from the previous boot. | Tag's accessible description |
| `systemLogs.boots.empty` | No earlier boots are stored on this device. | Picker with only the current boot |
| `systemLogs.boots.loadFailed` | Couldn't read the list of boots. | Recovery band |

### Events tab

| Key | English | Used for |
|---|---|---|
| `systemLogs.events.filter` | Filter | Button that unfolds the filters on narrow or short screens |
| `systemLogs.events.families` | Event types | Group label of the family chips |
| `systemLogs.events.problemsOnly` | Problems only | Toggle |
| `systemLogs.events.loadOlder` | Load older events | Paging button |
| `systemLogs.events.noOlder` | No older events are stored. | End row |
| `systemLogs.events.viewRaw` | View raw logs | Row action |
| `systemLogs.events.folded` | Similar events folded in: {count} | Row line 3 when suppressed is set |
| `systemLogs.events.emptyTitle` | No events recorded yet | Empty state |
| `systemLogs.events.emptyBody` | Stream starts and stops, link and modem changes, updates, restarts and capture problems appear here as they happen. | Empty state |
| `systemLogs.events.emptyFiltered` | No events match these filters. | Filtered empty state |
| `systemLogs.events.showAll` | Show all events | Filtered empty action |
| `systemLogs.events.loadFailed` | Couldn't read the event history. | Recovery band |
| `systemLogs.events.rawRemoved` | Raw logs for this boot were removed. | View raw logs on a removed boot |
| `systemLogs.events.diagnostics` | Diagnostics | Collapsed disclosure on unknown or invalid records |
| `systemLogs.events.diagnosticsCode` | Event code: {code} | Inside the disclosure only |

### Raw logs tab

| Key | English | Used for |
|---|---|---|
| `systemLogs.raw.filters` | Filters | Button that unfolds Source, Time and Order |
| `systemLogs.raw.filtersActive` | Filters: {count} | Same button when filters differ from the defaults |
| `systemLogs.raw.sourceLabel` | Sources | Source select label |
| `systemLogs.raw.sourceAll` | All sources | Source select, none chosen |
| `systemLogs.raw.sourceCount` | Sources: {count} | Source select, some chosen |
| `systemLogs.raw.levelLabel` | Level | Level control label |
| `systemLogs.raw.levelErrors` | Errors | Level position: error |
| `systemLogs.raw.levelWarnings` | Warnings | Level position: error and warning |
| `systemLogs.raw.levelInfo` | Info | Level position: error, warning, info (default) |
| `systemLogs.raw.levelEverything` | Everything | Level position: all four |
| `systemLogs.raw.timeLabel` | Time | Time select label |
| `systemLogs.raw.timeThisBoot` | This boot | Time option (default) |
| `systemLogs.raw.timeLast15m` | Last 15 minutes | Time option |
| `systemLogs.raw.timeLastHour` | Last hour | Time option |
| `systemLogs.raw.timeLast24h` | Last 24 hours | Time option |
| `systemLogs.raw.timeAll` | All stored | Time option |
| `systemLogs.raw.timeBoot` | Selected boot | Time select when the boot picker chose a boot, and in anchor mode |
| `systemLogs.raw.searchLabel` | Search messages | Search input accessible name |
| `systemLogs.raw.searchClear` | Clear search | Search clear button |
| `systemLogs.raw.orderLabel` | Order | Order control label |
| `systemLogs.raw.orderNewest` | Newest first | Order option (default) |
| `systemLogs.raw.orderOldest` | Oldest first | Order option |
| `systemLogs.raw.loadMore` | Load more | hasMore: true |
| `systemLogs.raw.keepSearching` | Keep searching | hasMore: null |
| `systemLogs.raw.keepSearchingHint` | Only part of the stored logs was checked. Keep searching to check further. | hasMore: null |
| `systemLogs.raw.end` | No more entries match in the stored logs. | Visible end marker at the bottom of an unanchored list or at the older edge of an exact window |
| `systemLogs.raw.endNewer` | No newer entries match in the stored logs. | Visible end marker at the newer edge of an exact window |
| `systemLogs.raw.endNewerWindow` | No additional entries match on the newer side of this time window. | Visible end marker at the newer edge of an approximate window |
| `systemLogs.raw.endOlderWindow` | No additional entries match on the older side of this time window. | Visible end marker at the older edge of an approximate window |
| `systemLogs.raw.capReached` | Display limit reached: {count} entries. Narrow the filters to reach entries further away. | Row cap |
| `systemLogs.raw.emptyTitle` | No entries match | Empty state |
| `systemLogs.raw.emptyHint` | Try fewer sources, a wider level, a longer time range or shorter search text. Search finds the typed text anywhere in a message; case doesn't matter. | Empty state |
| `systemLogs.raw.resetFilters` | Show everything | Empty state action (back to defaults) |
| `systemLogs.raw.copy` | Copy | Expanded row |
| `systemLogs.raw.copied` | Copied | Expanded row, after copy |
| `systemLogs.raw.copyFailed` | Couldn't copy. Select the text and copy it manually. | Expanded row |
| `systemLogs.raw.truncated` | This entry was shortened before it was shown here. | Expanded row when truncated |
| `systemLogs.anchor.match` | Entry closest to the selected moment | Accessible description of the highlighted row |
| `systemLogs.anchor.approximate` | No entry matches exactly; showing entries from around the same time. | Anchor mode with approximate: true |
| `systemLogs.anchor.empty` | No raw entries remain around this time. | Anchor mode, both pages empty |
| `systemLogs.anchor.leave` | Back to latest entries | Leaves anchor mode |
| `systemLogs.anchor.moment` | Selected moment: {time} | Separator row at the moment of an approximate window |
| `systemLogs.error.expiredTitle` | This position is no longer stored | CURSOR_UNAVAILABLE, FILTER_CHANGED |
| `systemLogs.error.expiredBody` | Log cleanup or a filter change removed the place this list was reading from. | Same |
| `systemLogs.error.startFromNewest` | Start from newest | Expired Raw position or return to the live edge of Events |
| `systemLogs.error.bootRemoved` | Logs for this boot were removed. | BOOT_UNAVAILABLE |
| `systemLogs.error.showCurrentBoot` | Show this boot | Same, action |
| `systemLogs.error.busy` | Another view is reading logs. Try again in a moment. | BUSY |
| `systemLogs.error.readFailed` | Couldn't read the logs. | JOURNAL_UNAVAILABLE, READ_FAILED, RECORD_TOO_LARGE |
| `systemLogs.marker.suppressed` | The device dropped entries here because too many were written at once. | marker: 'suppressed' and gap suppressed |
| `systemLogs.marker.dropped` | Entries skipped while following: {count} | dropped > 0 |
| `systemLogs.marker.catchupExceeded` | Too many entries arrived at once, so some were skipped. | Gap catchup_exceeded |
| `systemLogs.marker.cursorUnavailable` | Log cleanup removed the follow position, so some entries may be missing. | Gap cursor_unavailable |
| `systemLogs.marker.clockChanged` | The device clock changed here. Times recorded before this point may be wrong. | Clock-not-synced marker |
| `systemLogs.follow.start` | Follow | Follow button |
| `systemLogs.follow.pause` | Pause | Follow button while following |
| `systemLogs.follow.resume` | Resume | After pause, stop or reconnect |
| `systemLogs.follow.following` | Following | State label |
| `systemLogs.follow.paused` | Paused | State label |
| `systemLogs.follow.stopped` | Stopped | State label |
| `systemLogs.follow.disconnected` | Disconnected | State label |
| `systemLogs.follow.disconnectedBody` | The connection to the device was lost. The entries shown may be out of date. | Disconnected notice |
| `systemLogs.follow.endedReader` | Following stopped because the log reader ended. | ended: 'follower_exit' |
| `systemLogs.follow.endedBoot` | Following stopped because the device restarted. | ended: 'boot_changed' |
| `systemLogs.follow.endedCleared` | Following stopped because the logs were cleared. | ended: 'cleared' |
| `systemLogs.follow.unavailable` | Follow works with This boot and Newest first. | Disabled reason |
| `systemLogs.follow.unavailableAnchor` | Go back to the latest entries to follow. | Disabled reason in anchor mode |
| `systemLogs.follow.newEntries` | New entries: {count} | Held-entries button |
| `systemLogs.announce.following` | Following new log entries. | Live region |
| `systemLogs.announce.paused` | Following paused. | Live region |
| `systemLogs.announce.resumed` | Following resumed. | Live region |
| `systemLogs.announce.stopped` | Following stopped. | Live region |
| `systemLogs.announce.gap` | Some log entries were skipped. | Live region |
| `systemLogs.announce.disconnected` | Connection lost. Log entries may be out of date. | Live region |
| `systemLogs.announce.newEntries` | New log entries: {count} | Live region, at most every 5 s |

### Storage

| Key | English | Used for |
|---|---|---|
| `systemLogs.storage.heading` | Storage | Region heading |
| `systemLogs.storage.used` | Logs use {used} of {limit} | Usage text beside the bar |
| `systemLogs.storage.usedNoLimit` | Logs use {used} | Usage when the limit is unknown |
| `systemLogs.storage.notReported` | Space used by logs is not reported by this device. | journalBytes: null |
| `systemLogs.storage.onDisk` | On disk: {total}. The difference is journal data from an earlier device identity, which this screen does not manage. | Directory total exceeds journal count |
| `systemLogs.storage.oldest` | Oldest stored entry: {date} | Oldest entry |
| `systemLogs.storage.oldestUnknown` | Oldest stored entry: not reported | Oldest entry unknown |
| `systemLogs.storage.events` | Event history: {size} | Events store size |
| `systemLogs.storage.lastCleared` | Last cleared: {time} | When lastClearedAt is set |
| `systemLogs.storage.volumeHeading` | Recent volume by source | Volume table caption |
| `systemLogs.storage.volumeSample` | Entries sampled: {count} | Labels the table as a sample |
| `systemLogs.storage.volumeSource` | Source | Volume table header |
| `systemLogs.storage.volumeEntries` | Entries | Volume table header |
| `systemLogs.storage.volumeSize` | Size | Volume table header |
| `systemLogs.storage.limitsHeading` | Limits | Limits form heading |
| `systemLogs.storage.keepForLabel` | Keep logs for | Select label |
| `systemLogs.storage.keepForDevice` | Device limit: {value} | Select option null |
| `systemLogs.storage.keepForDays` | Days: {count} | Select options 3, 7, 14 and the ceiling |
| `systemLogs.storage.maxSizeLabel` | Maximum size | Select label (sizes are formatted data) |
| `systemLogs.storage.maxSizeDevice` | Device limit: {value} | Select option null |
| `systemLogs.storage.limitsUnknown` | This device did not report its log limit, so limits can't be changed here. | Reason element when ceiling is null |
| `systemLogs.storage.detailLabel` | Detail | Detail control label |
| `systemLogs.storage.detailFull` | Full detail | Detail debug (default) |
| `systemLogs.storage.detailFullHint` | Keeps debug entries. Uses more space and is best for troubleshooting. | Consequence line |
| `systemLogs.storage.detailReduced` | Reduced | Detail info |
| `systemLogs.storage.detailReducedHint` | Keeps info and above for the CeraLive app, including the bonding sender. Its debug entries are not stored, so history lasts longer. | Consequence line |
| `systemLogs.storage.save` | Save limits | Explicit save |
| `systemLogs.storage.saved` | Limits saved. | After save |
| `systemLogs.storage.targetNotMet` | The new limit is not met yet. The device removes more as it rotates log files. | targetMet: false |
| `systemLogs.storage.maintenanceFailed` | The cleanup after saving didn't finish. The limits are saved. | lastMaintenance.ok: false |
| `systemLogs.storage.deleteOlder` | Delete older log files | Action |
| `systemLogs.storage.deleteOlderHint` | Removes log files the device has already closed. Some earlier boots may remain. | Action description |
| `systemLogs.storage.deleteOlderResult` | Boots stored: {before} before, {after} now. | Result of deleteOlderFiles |
| `systemLogs.storage.deleteLegacy` | Delete leftover debug files ({size}) | Rendered only when legacyDebugBytes > 0 |
| `systemLogs.storage.clearAll` | Clear all logs | Destructive trigger |
| `systemLogs.storage.clearAllTitle` | Clear all logs? | Confirmation title |
| `systemLogs.storage.clearAllBody` | This removes the stored raw logs of every component, including this boot. The event history is kept. Journal data from an earlier device identity is not removed. This can't be undone, and it is not a secure erase. | Confirmation body |
| `systemLogs.storage.clearAllConfirm` | Clear all logs | Confirmation button (destructive) |
| `systemLogs.storage.clearEvents` | Clear event history | Destructive trigger |
| `systemLogs.storage.clearEventsTitle` | Clear event history? | Confirmation title |
| `systemLogs.storage.clearEventsBody` | This removes every stored event. Raw logs are kept. This can't be undone. | Confirmation body |
| `systemLogs.storage.clearEventsConfirm` | Clear event history | Confirmation button (destructive) |
| `systemLogs.storage.updateInProgress` | An update is in progress, so logs can't be cleared now. Try again after the update finishes. | UPDATE_IN_PROGRESS |
| `systemLogs.storage.loadFailed` | Couldn't read log storage. | Recovery band |
| `systemLogs.storage.actionFailed` | Couldn't complete this action. | Recovery band after a failed action |

### Sharing

| Key | English | Used for |
|---|---|---|
| `systemLogs.sharing.heading` | Downloads | Region heading |
| `systemLogs.sharing.export` | Export this view | Row title and button |
| `systemLogs.sharing.exportHint` | Saves the entries that match the Raw logs filters as a text file. | Row description |
| `systemLogs.sharing.exportHintMoment` | Saves the entries that match the Raw logs filters from the 10 minutes around the selected moment as a text file. | Export confirmation while an exact anchor is open |
| `systemLogs.sharing.exportSensitive` | This file may contain sensitive data such as network names and addresses. Review it before sharing. | Shown before the export download starts |
| `systemLogs.sharing.exportDownload` | Download export | Confirmation button |
| `systemLogs.sharing.bundle` | Support bundle | Row title and nested dialog title |
| `systemLogs.sharing.bundleHint` | One file for a helper: versions, events, recent logs and settings, with known secrets removed. | Row description |
| `systemLogs.sharing.bundlePreparing` | Preparing the preview… | Bundle dialog loading status |
| `systemLogs.sharing.bundleSectionVersions` | Versions | Manifest row |
| `systemLogs.sharing.bundleSectionEvents` | Events | Manifest row |
| `systemLogs.sharing.bundleSectionJournal` | Raw logs | Manifest row |
| `systemLogs.sharing.bundleSectionSettings` | Settings | Manifest row |
| `systemLogs.sharing.bundleEntries` | Entries | Manifest table header |
| `systemLogs.sharing.bundleRedactions` | Removed values | Manifest table header |
| `systemLogs.sharing.bundleRunning` | Running now | Version block heading (exportedBy) |
| `systemLogs.sharing.bundleBoots` | Boots covered: {count} | Manifest summary |
| `systemLogs.sharing.bundleSensitive` | Secrets known to the device and common identifiers are removed, but the file may still contain personal data. Review it before sharing. | Shown before Download is enabled |
| `systemLogs.sharing.bundleDownload` | Download bundle | Bundle dialog primary |
| `systemLogs.sharing.bundleFailed` | Couldn't prepare the support bundle. | Recovery band |
| `systemLogs.sharing.bundleUseExport` | Use Export this view instead. | Under the band of a bundle the device refused to prepare |
| `systemLogs.sharing.busy` | Another export is running. Try again when it finishes. | BUSY |
| `systemLogs.sharing.failed` | Couldn't create the file. | Recovery band |
| `systemLogs.sharing.browserSaves` | Files are saved by the browser you are using. | Line under the group |
| `systemLogs.versions.systemImage` | System image | Version block |
| `systemLogs.versions.slot` | Slot | Version block |
| `systemLogs.versions.board` | Board | Version block |
| `systemLogs.versions.boardModel` | Board model | Version block |
| `systemLogs.versions.ceraui` | CeraUI | Version block |
| `systemLogs.versions.engine` | Streaming engine | Version block |
| `systemLogs.versions.sender` | Bonding sender | Version block (senderVersion) |
| `systemLogs.versions.kernel` | Kernel | Version block |
| `systemLogs.versions.bun` | Runtime | Version block (bun) |
| `systemLogs.versions.notReported` | Not reported | Any null version field |

### Timeline: families and unknown records

| Key | English | Used for |
|---|---|---|
| `timeline.family.stream` | Stream | Family chip |
| `timeline.family.network` | Network links | Family chip |
| `timeline.family.cellular` | Cellular | Family chip |
| `timeline.family.update` | Updates | Family chip |
| `timeline.family.device` | Device | Family chip |
| `timeline.family.capture` | Capture sources | Family chip |
| `timeline.unknown.title` | Event recorded by a newer version | Unknown code title |
| `timeline.unknown.detail` | This version of the screen can't describe it. The raw logs around this time show what happened. | Unknown code detail |

### Timeline: stream

| Key | English |
|---|---|
| `timeline.stream_started.title` | Stream started |
| `timeline.stream_stopped.title` | Stream stopped |
| `timeline.stream_stopped.detail.operator` | Stopped from the controls. |
| `timeline.stream_stopped.detail.engine_loss` | Stopped because the streaming engine was lost. |
| `timeline.stream_stopped.detail.reconfigure` | Stopped to apply new settings. |
| `timeline.stream_stop_failed.title` | Stream stop not confirmed |
| `timeline.stream_stop_failed.detail` | The streaming engine did not confirm the stop. |
| `timeline.stream_start_retrying.title` | Stream start retried |
| `timeline.stream_start_retrying.detail` | Attempt {attempt} of {maxAttempts}. |
| `timeline.stream_start_failed.title` | Stream didn't start |
| `timeline.stream_start_failed.detail.engine_unavailable` | The streaming engine was not available. |
| `timeline.stream_start_failed.detail.engine_restarting` | The streaming engine was restarting. |
| `timeline.stream_start_failed.detail.protocol_incompatible` | The streaming engine's version does not match this software. |
| `timeline.stream_start_failed.detail.start_invalid` | The stream settings or the device were not valid for a start. |
| `timeline.stream_start_failed.detail.engine_internal` | The streaming engine reported an internal error. |
| `timeline.stream_start_failed.detail.start_timeout` | The streaming engine did not confirm the stream in time. |
| `timeline.stream_start_failed.detail.audio_source_unavailable` | The selected audio input was not available. |
| `timeline.stream_start_failed.detail.modem_transition_active` | A modem was switching USB mode. |
| `timeline.stream_start_failed.detail.recovery_pending` | The device was still finishing modem recovery. |
| `timeline.stream_start_failed.detail.mutation_blocked` | A modem change could not be undone, so its state was unknown. |
| `timeline.stream_start_failed.detail.capture_source_unavailable` | The video input could not be used. |
| `timeline.stream_start_failed.detail.update_in_progress` | An update was being installed. |
| `timeline.stream_start_failed.capture.negotiation_failed` | The video input's signal format could not be captured. |
| `timeline.stream_start_failed.capture.no_signal` | The video input carried no signal. |
| `timeline.stream_start_failed.capture.device_busy` | The video input was busy. |
| `timeline.stream_start_failed.capture.composition-unsupported` | This device cannot combine two inputs. |
| `timeline.stream_start_failed.capture.secondary-unavailable` | The second input was not available. |
| `timeline.stream_reconfigured.title` | Stream settings changed |
| `timeline.stream_reconfigured.detail.streaming` | The stream continued with the new settings. |
| `timeline.stream_reconfigured.detail.idle` | The stream stopped while the new settings were applied. |
| `timeline.stream_reconfigured.detail.reconciling` | The device was checking the stream state after the change. |
| `timeline.stream_restored.title` | Stream restored |
| `timeline.stream_restored.detail` | The stream that was live before the restart was started again. |
| `timeline.stream_restore_failed.title` | Stream not restored |
| `timeline.stream_restore_failed.detail.runtime_state_unknown` | The device could not tell whether the stream was still running. |
| `timeline.stream_restore_failed.detail.lifecycle_busy` | Another stream action was in progress. |
| `timeline.stream_restore_failed.detail.config_invalid` | The saved stream settings were not valid. |
| `timeline.stream_restore_failed.detail.start_failed` | The stream start failed. |
| `timeline.stream_restore_failed.detail.start_busy` | A stream start was already in progress. |
| `timeline.stream_restore_failed.detail.start_cancelled` | The start was cancelled. |
| `timeline.stream_autostart_failed.title` | Automatic start failed |
| `timeline.stream_autostart_failed.detail` | The stream set to start with the device did not start. |
| `timeline.engine_lost.title` | Streaming engine lost |
| `timeline.engine_lost.detail.streaming` | It was lost during a stream. |
| `timeline.engine_lost.detail.idle` | No stream was running. |
| `timeline.engine_recovered.title` | Streaming engine recovered |

The capture-cause sentences sit under capture. rather than detail. because
detail.capture_source_unavailable is itself a key; the frontend uses the
cause sentence when captureCause is present and the class sentence otherwise.

### Timeline: network links

| Key | English |
|---|---|
| `timeline.link_down.title` | Link went down |
| `timeline.link_down.detail.probe_failed` | {name} stopped answering internet checks. |
| `timeline.link_down.detail.captive_portal` | {name} is behind a sign-in page. |
| `timeline.link_down.detail.passive_congestion` | {name} was too congested to carry the stream. |
| `timeline.link_down.detail.definitive_loss` | {name} lost its connection. |
| `timeline.link_degraded.title` | Link degraded |
| `timeline.link_degraded.detail.probe_failed` | Internet checks on {name} started failing. |
| `timeline.link_degraded.detail.captive_portal` | {name} reached a sign-in page instead of the internet. |
| `timeline.link_degraded.detail.passive_congestion` | {name} became slow or started losing packets. |
| `timeline.link_degraded.detail.definitive_loss` | {name} is losing its connection. |
| `timeline.link_up.title` | Link came back |
| `timeline.link_up.detail` | {name} is carrying traffic again. |
| `timeline.bond_all_links_down.title` | All bonded links went down |
| `timeline.bond_all_links_down.detail` | Links in the bond: {count}. |
| `timeline.bond_links_recovered.title` | Bonded links recovered |
| `timeline.bond_links_recovered.detail` | Links carrying traffic: {count}. |
| `timeline.internet_lost.title` | Internet access lost |
| `timeline.internet_lost.detail` | No network path reached the internet. |
| `timeline.internet_restored.title` | Internet access restored |
| `timeline.interface_added.title` | Network interface appeared |
| `timeline.interface_added.detail` | Interface: {iface} |
| `timeline.interface_removed.title` | Network interface disappeared |
| `timeline.interface_removed.detail` | Interface: {iface} |

### Timeline: cellular

| Key | English |
|---|---|
| `timeline.modem_added.title` | Modem added |
| `timeline.modem_added.detail` | Modem: {name} |
| `timeline.modem_removed.title` | Modem removed |
| `timeline.modem_removed.detail` | Modem: {name} |
| `timeline.modem_connected.title` | Modem connected |
| `timeline.modem_connected.detail.roaming` | {name} connected while roaming. |
| `timeline.modem_connected.detail.notRoaming` | Modem: {name} |
| `timeline.modem_disconnected.title` | Modem disconnected |
| `timeline.modem_disconnected.detail` | Modem: {name} |
| `timeline.modem_registration_rejected.title` | Modem registration rejected |
| `timeline.modem_registration_rejected.detail` | The mobile network refused {name}. |
| `timeline.sim_inserted.title` | SIM inserted |
| `timeline.sim_inserted.detail` | Modem: {name} |
| `timeline.sim_removed.title` | SIM removed |
| `timeline.sim_removed.detail` | Modem: {name} |

### Timeline: updates

Codes are update_ followed by the notice kind, with the kind's hyphens
turned into underscores, plus update_failed.

| Key | English |
|---|---|
| `timeline.update_packages_recovered.title` | Package update recovered |
| `timeline.update_packages_recovered.detail` | An interrupted package update was recovered. |
| `timeline.update_slot_sync_recovered.title` | Slot sync recovered |
| `timeline.update_slot_sync_recovered.detail` | An interrupted slot synchronization completed later. |
| `timeline.update_updates_available.title` | Updates became available |
| `timeline.update_installed.title` | Updates installed |
| `timeline.update_installed.detail` | Packages installed: {count}. |
| `timeline.update_refused.title` | Update refused |
| `timeline.update_refused.detail` | The reason is in the raw logs around this time. |
| `timeline.update_download_paused.title` | Update put on hold |
| `timeline.update_download_paused.detail` | The download was put on hold for a stream start. |
| `timeline.update_os_staged.title` | System image staged |
| `timeline.update_os_staged.detail` | System version {version}. It applies after the next clean restart. |
| `timeline.update_os_activation_requested.title` | System image activation requested |
| `timeline.update_os_activation_requested.detail` | System version {version}. Activation is confirmed only after a restart. |
| `timeline.update_os_activated.title` | System image activated |
| `timeline.update_os_activated.detail` | System version {version} is active. |
| `timeline.update_os_rollback.title` | System image rolled back |
| `timeline.update_os_rollback.detail` | The device returned from system version {version}. |
| `timeline.update_slots_current.title` | System slots up to date |
| `timeline.update_restart_recommended.title` | Service restart recommended |
| `timeline.update_restart_recommended.detail` | Service: {unit} |
| `timeline.update_cellular_approval.title` | Cellular download needed approval |
| `timeline.update_cellular_approval.detail` | Download size: {size} |
| `timeline.update_credentials_expiring.title` | Update credentials expiring |
| `timeline.update_credentials_expiring.detail` | Days left: {days} |
| `timeline.update_credentials_expired.title` | Update credentials expired |
| `timeline.update_credentials_expired.detail` | Package updates can't download until the credentials are renewed. |
| `timeline.update_transport_unhealthy.title` | Update connection unhealthy |
| `timeline.update_transport_unhealthy.detail` | The device found no healthy connection to the update server. |
| `timeline.update_kernel_staged.title` | Kernel update staged |
| `timeline.update_kernel_staged.detail` | Kernel version: {version} |
| `timeline.update_kernel_succeeded.title` | Kernel updated |
| `timeline.update_kernel_succeeded.detail` | Kernel version: {version} |
| `timeline.update_kernel_rolled_back.title` | Kernel update rolled back |
| `timeline.update_kernel_rolled_back.detail` | Kernel version: {version} |
| `timeline.update_os_stage_retry.title` | System image staging failed |
| `timeline.update_os_stage_retry.detail` | System version {version} could not be staged. The device retries automatically. |
| `timeline.update_os_stage_operator.title` | System image staging paused |
| `timeline.update_os_stage_operator.detail` | System version {version} could not be staged. Automatic retries are paused. |
| `timeline.update_os_stage_unresolved.title` | System image staging unresolved |
| `timeline.update_os_stage_unresolved.detail` | Staging system version {version} ended in a state the device could not verify. |
| `timeline.update_failed.title` | Update failed |
| `timeline.update_failed.detail.download` | The download failed. |
| `timeline.update_failed.detail.commit` | Installing the packages failed. |
| `timeline.update_failed.detail.sync` | Copying the update to the other system slot failed. |
| `timeline.update_failed.detail.os-staging` | Preparing the system image failed. |

### Timeline: device

| Key | English |
|---|---|
| `timeline.device_started.title` | Device started |
| `timeline.device_started.detail.known` | System image {osImage} on slot {slot}. |
| `timeline.device_started.detail.unknown` | The system image and slot were not recorded. |
| `timeline.previous_boot_unclean.title` | Previous boot ended unexpectedly |
| `timeline.previous_boot_unclean.detail` | The previous boot ended without a clean shutdown. |
| `timeline.shutdown_requested.title` | Restart or power-off requested |
| `timeline.shutdown_requested.detail.reboot` | A restart was requested. |
| `timeline.shutdown_requested.detail.poweroff` | A power-off was requested. |
| `timeline.service_stopping.title` | CeraLive service stopping |
| `timeline.service_stopping.detail` | The service received a stop request. |
| `timeline.power_action_refused.title` | Restart or power-off refused |
| `timeline.power_action_refused.detail` | The reason is in the raw logs around this time. |
| `timeline.disk_low.title` | Disk space low |
| `timeline.disk_low.detail` | Free on the data partition: {free} |
| `timeline.disk_ok.title` | Disk space recovered |
| `timeline.disk_ok.detail` | Free on the data partition: {free} |
| `timeline.config_reset_damaged.title` | Damaged settings reset |
| `timeline.config_reset_damaged.detail` | The saved settings could not be read, so the device went back to defaults. |
| `timeline.hardware_identity_drift.title` | Hardware differs from settings |
| `timeline.hardware_identity_drift.detail` | The detected hardware differs from the hardware in the saved settings. |
| `timeline.bootloader_update_failed.title` | Bootloader update failed |
| `timeline.bootloader_update_failed.detail` | The device could not update its bootloader. |

### Timeline: capture sources

| Key | English |
|---|---|
| `timeline.capture_source_lost.title` | Video source lost |
| `timeline.capture_source_lost.detail` | Source: {name} |
| `timeline.capture_source_recovered.title` | Video source recovered |
| `timeline.capture_source_recovered.detail` | Source: {name} |
| `timeline.audio_source_lost.title` | Audio source lost |
| `timeline.audio_source_recovered.title` | Audio source recovered |
| `timeline.capture_input_lost.title` | Capture input lost |
| `timeline.capture_input_lost.detail` | Input: {name} |
| `timeline.capture_input_returned.title` | Capture input returned |
| `timeline.capture_input_returned.detail` | Input: {name} |
| `timeline.capture_standby_entered.title` | Black standby started |
| `timeline.capture_standby_entered.detail` | The stream stayed connected and sent a black picture while waiting for a camera to return. |
| `timeline.capture_standby_exited.title` | Black standby ended |
| `timeline.capture_standby_exited.detail` | Standby lasted: {duration} |

Raw tokens that these sentences do not show (refusal reasons, transport
reasons, hardware kinds, service signals, shutdown evidence) appear only in
the row's collapsed Diagnostics disclosure, never as a title or detail.

## 5. Severity encoding

> Design intent recorded at planning time. It is not a description of the shipped
> behaviour; see the Code map and system-logs-critique.md.

Severity is always shape plus colour plus an accessible name, never colour
alone. Glyphs follow `NOTIFICATION_ICONS` in
`F/main/notifications/notification-presentation.ts`, so a warning is a triangle
everywhere in the app.

| Severity | Where | Glyph (Lucide) | Glyph colour | Text colour |
|---|---|---|---|---|
| error | raw and events | `CircleAlert` | `--status-error` (`text-status-error`) | `text-foreground` |
| warning | raw and events | `TriangleAlert` | `--status-warning` | `text-foreground` |
| info | raw and events | `Info` | `text-muted-foreground` | `text-foreground` |
| debug | raw only | `CircleDashed` | `text-muted-foreground` | `text-muted-foreground` (the dimmer step) |
| success | events only | `CircleCheck` | `--status-success` | `text-foreground` |

- The status colours sit on the glyph only (non-text, 3:1). Text stays
  `text-foreground` or `text-muted-foreground`, because DESIGN.md section 14
  measured the status-pill text tones below 4.5:1 for error (both themes) and
  neutral (dark).
- The lime `--status-live` token is not used for any severity, state, marker,
  bar or selection in this view. The header pill's Live state uses it; Save and
  Download bundle use the default primary button (critique SL-13).
- Following uses `--status-info`; Paused, Stopped and Disconnected are neutral
  (`--status-neutral` glyph, foreground text).
- Shutdown marks: current `CircleDot` in `--status-info`, clean `Check` in
  `text-muted-foreground`, unclean `TriangleAlert` in `--status-warning`, unknown
  `CircleHelp` in `--status-neutral`, each with its text label and a distinct
  `data-state` (`current`, `clean`, `unclean`, `unknown`); unknown is never
  styled or announced as clean (DESIGN.md CT-3).
- Recovery and refusal bands use the existing amber band
  (`border-status-warning/30 bg-status-warning/10`) with foreground body text.
- In e-ink mode the status tokens are greyscale, so shape and text carry the
  whole meaning; the pulse is frozen like every other e-ink animation.

## 6. Breakpoints

> Design intent recorded at planning time. It is not a description of the shipped
> behaviour; see the Code map and system-logs-critique.md.

Rendered layout, overflow, touch geometry and RTL at these
widths are not measured in this lane.

| Width | Header | Tabs and side column | Filter bars | Rows | Boot picker |
|---|---|---|---|---|---|
| 375 (phone) | Title and close on row 1; pill and boot button wrap to a second header line | Events, Raw logs, Storage tabs at full width; no side column | Raw: row 1 Level (full width, labels may wrap to two lines inside equal segments; a segment is never narrower than its longest word, so a long translation such as French "Avertissements" widens its own segment instead of running under the next; under touch every segment is at least 44 x 44 px, so short CJK labels do not shrink the target); row 2 Search (fills), Filters button, Follow. Source, Time and Order fold into the in-flow Filters panel. Events: Filter button unfolds family chips and Problems only | Events: time under the title. Raw: two-line rows | Header button, nested sheet |
| 768 (tablet) | One row: title, pill, boot button, close | Three tabs; no side column | Raw: Level, Search, Follow on row 1; Source, Time, Order inline on row 2 (panel at least 720 px wide and viewport taller than 600 px); Events: chips and toggle inline, wrapping | One-line raw rows; event time at the inline end | Header button, nested centered dialog or sheet per `AppDialog` |
| 1024x600 (kiosk, touch) | One row: title, pill, close (no boot button) | Events, Raw logs; 320 px side column with Boots, Storage, Downloads, scrolling on its own | Panel is about 704 px and the viewport is 600 px tall, so both tabs use the folded bars: Raw is one row (Level, Search, Filters, Follow); Events folds its chips behind Filter. Budget: header about 56 px, tabs 44, bar about 60, leaving about 440 px of list | One-line raw rows | First side-column region |
| 1280 (desktop) | One row: title, pill, close | Events, Raw logs; side column | Raw: two rows, everything inline; Events: chips inline | Full density, one-line rows | First side-column region |

- Every width: zero horizontal overflow in Events, Raw logs and Storage, in
  `en`, `ar` and `de` (DESIGN.md BP-1..BP-3, LO-5); state, severity and action
  elements are never clipped; long units truncate with the full value in the
  expanded row.
- Design rule: the view spans the whole viewport; while it is open the page
  drops its stable scrollbar gutter (`app.css`,
  `html:has([data-app-dialog-fullscreen])`). Below 640 px each tab grows from
  its label's width (`SystemLogsView.svelte:171`, `max-sm:flex-auto`).
- Measured (`tests/e2e/system-logs-responsive.spec.ts`): in Chromium against
  the mock backend, the desktop and mobile projects each run the 12 EN, AR and
  DE cases at 375x812, 768x1024, 1280x800, and touch 1024x600. The dialog width
  matched the viewport width in those cases. The audit
  checked horizontal overflow and the bounds of visible state, severity, and
  action elements in those cases and at 320x720 and 375x812 in all ten
  locales. At the tested widths of 375 px or above, the audited tab labels used
  at most two lines. The Spanish Raw logs label used three unclipped lines at
  320 px (DESIGN-FOLLOWUPS DF-26). The 12 principal cases reported no critical
  or serious scoped axe violations in Events, Raw logs, or Storage. The
  separate color compositor checked the applicable AA text-contrast ratios for
  audited text using computed colors. It does not model CSS opacity. The narrow
  matrix and open select portals use the compositor alone.
- The other bullets in this section, "Every width" included, are design rules:
  the 800x480 kiosk and the widths between the measured ones are not measured.
- An 800x480 kiosk follows the 768 column with the folded bars, since it is
  below 1024 px wide and at most 600 px tall.
- Touch layout (`[data-layout-mode='touch']`): every interactive element reaches
  `--touch-target-min` through the existing touch layer, the
  `data-touch-target="hit-area"` overlay or, for the select options in
  `StorageLimits.svelte` and `RawLogsFilterBar.svelte`, a local
  `min-h-(--touch-target-min)` class, with at least 8 px between neighbours;
  disabled controls keep their full size (DESIGN.md TT-1..TT-5). Never a
  hard-coded 44px. The spec measures the gap only between distinct controls:
  members of one radiogroup, listbox, Raw list or boot picker, nested hit
  areas, and targets scrolled partly out of view are not paired
  (`tests/e2e/helpers/system-logs-audit.ts`, spacing check).
- RTL (`ar`): logical properties only; the close button sits at the inline end;
  the side column sits at the inline end; chevrons mirror (`rtl:-scale-x-100`);
  raw unit and message keep `dir="ltr"`; data params in `<bdi>`.
- CJK (`ja`, `ko`, `zh`): system fallback fonts render (no tofu); at 320 and
  375 px the spec finds no `Intl.Segmenter` word of two or more characters
  holding a CJK character split across lines within one rendered text node
  (`tests/e2e/helpers/system-logs-audit.ts`, CJK check).

## 7. Code map [EXISTS]

Pointers only. Behaviour is owned by the code and tests below and by
[system-logs-critique.md](system-logs-critique.md) and
[DESIGN-FOLLOWUPS.md](../../../../docs/DESIGN-FOLLOWUPS.md). Paths are under
`apps/frontend/src/` unless they start with `apps/` or `docs/`. The component,
module, test and fixture lists are generated from the directory listing of
`main/system-logs/` and `lib/device-logs/` (subfolders included): files under
`__fixtures__/` are test fixtures and are listed separately; `*.test.ts` files
are tests; every other `.svelte` and `.ts` file is production code. Related
tests under `tests/` are the files there whose text names either folder.

Paging keeps focus on the next action at that end or transfers it to the list
when the action disappears. See DF-39 and `system-logs.spec.ts` below for the
mock-backend flows and keyboard coverage on desktop and mobile.

Start from newest keeps its button focusable during the Events reload. If the
button still owns focus when the reload finishes, focus moves to the first
event action, Retry on failure, or the first visible filter when empty.

After an Events gap refresh, a pending View raw logs reply can open Raw logs
only if its event is still shown. A failed refresh retires the pending action
and returns any focused row action to the filter bar.

`RawView` exposes the tab's operator actions. `RawPaging` owns query
generations, continuations and head replay. `RawFollowSession` owns the
socket listener, subscription and resume checkpoint. `RawRowWindow` owns
the held boundary and caps, and `RawFeedback` owns recovery state and
live-region announcements.

### Components

| Source | Props |
|---| --- |
| `main/system-logs/BootButton.svelte` | no props |
| `main/system-logs/BootPicker.svelte:30` | props |
| `main/system-logs/BundleDialog.svelte:25` | props |
| `main/system-logs/EventRow.svelte:38` | props |
| `main/system-logs/EventsBootHeading.svelte:11` | props |
| `main/system-logs/EventsFilters.svelte:11` | props |
| `main/system-logs/EventsLoadFailure.svelte:11` | props |
| `main/system-logs/EventsPanel.svelte:16` | props |
| `main/system-logs/EventsTab.svelte:37` | props |
| `main/system-logs/ExportDialog.svelte:16` | props |
| `main/system-logs/KeepWords.svelte:14` | props |
| `main/system-logs/LegacyLogDownloads.svelte:21` | props |
| `main/system-logs/ParamText.svelte:8` | props |
| `main/system-logs/RawFollowControl.svelte:17` | props |
| `main/system-logs/RawLogList.svelte:22` | props |
| `main/system-logs/RawLogRow.svelte:35` | props |
| `main/system-logs/RawLogsFilterBar.svelte:23` | props |
| `main/system-logs/RawLogsPanel.svelte:23` | props |
| `main/system-logs/RawLogsTab.svelte:27` | props |
| `main/system-logs/RecoveryBand.svelte:19` | props |
| `main/system-logs/SegmentedChoice.svelte:27` | props |
| `main/system-logs/SharingSection.svelte:21` | props |
| `main/system-logs/ShutdownMark.svelte:21` | props |
| `main/system-logs/StorageCleanup.svelte:37` | props |
| `main/system-logs/StorageLimits.svelte:34` | props |
| `main/system-logs/StorageSection.svelte:20` | props |
| `main/system-logs/StorageUsage.svelte:17` | props |
| `main/system-logs/StreamStatePill.svelte` | no props |
| `main/system-logs/SystemLogsView.svelte:65` | props |

### Modules

| Source |
|---|
| `main/system-logs/log-downloads.svelte.ts` |
| `lib/device-logs/boot-list.svelte.ts` |
| `lib/device-logs/boot-rows.ts` |
| `lib/device-logs/boot-selection.svelte.ts` |
| `lib/device-logs/cjk-words.ts` |
| `lib/device-logs/events-view.svelte.ts` |
| `lib/device-logs/events-window.ts` |
| `lib/device-logs/history-bus.ts` |
| `lib/device-logs/log-pointer-keys.ts` |
| `lib/device-logs/param-parts.ts` |
| `lib/device-logs/raw-anchor.ts` |
| `lib/device-logs/raw-feedback.svelte.ts` |
| `lib/device-logs/raw-filter.ts` |
| `lib/device-logs/raw-follow-session.svelte.ts` |
| `lib/device-logs/raw-paging.svelte.ts` |
| `lib/device-logs/raw-row-window.svelte.ts` |
| `lib/device-logs/raw-rows.ts` |
| `lib/device-logs/raw-view-rpc.ts` |
| `lib/device-logs/raw-view.svelte.ts` |
| `lib/device-logs/sharing-flow.svelte.ts` |
| `lib/device-logs/sharing.ts` |
| `lib/device-logs/shell-layout.ts` |
| `lib/device-logs/storage-limits.ts` |
| `lib/device-logs/storage-messages.ts` |
| `lib/device-logs/storage-outcome.ts` |
| `lib/device-logs/storage-readout.ts` |
| `lib/device-logs/stream-pill.ts` |
| `lib/device-logs/timeline-copy.ts` |
| `lib/device-logs/timeline-details.ts` |
| `lib/device-logs/timeline-groups.ts` |
| `lib/device-logs/view-logs-secondary.ts` |
| `lib/device-logs/view-logs.ts` |
| `lib/device-logs/viewer-availability.ts` |

### Tests

| Test file |
|---|
| `main/system-logs/BootButton.test.ts` |
| `main/system-logs/BootPicker.test.ts` |
| `main/system-logs/EventsPanel.test.ts` |
| `main/system-logs/EventsTab.history.test.ts` |
| `main/system-logs/EventsTab.test.ts` |
| `main/system-logs/KeepWords.test.ts` |
| `main/system-logs/LegacyLogDownloads.test.ts` |
| `main/system-logs/ParamText.test.ts` |
| `main/system-logs/RawLogRow.test.ts` |
| `main/system-logs/RawLogsPanel.test.ts` |
| `main/system-logs/RawLogsTab.test.ts` |
| `main/system-logs/SegmentedChoice.test.ts` |
| `main/system-logs/SharingSection.test.ts` |
| `main/system-logs/StorageCleanup.test.ts` |
| `main/system-logs/StorageSection.test.ts` |
| `main/system-logs/StreamStatePill.reactive.test.ts` |
| `main/system-logs/StreamStatePill.test.ts` |
| `main/system-logs/SystemLogsView.boots.test.ts` |
| `main/system-logs/SystemLogsView.deep-link.test.ts` |
| `main/system-logs/SystemLogsView.events.test.ts` |
| `main/system-logs/SystemLogsView.raw.test.ts` |
| `main/system-logs/SystemLogsView.sharing.test.ts` |
| `main/system-logs/SystemLogsView.test.ts` |
| `lib/device-logs/boot-list.test.ts` |
| `lib/device-logs/boot-rows.test.ts` |
| `lib/device-logs/boot-selection.test.ts` |
| `lib/device-logs/events-view.test.ts` |
| `lib/device-logs/history-bus.test.ts` |
| `lib/device-logs/param-parts.test.ts` |
| `lib/device-logs/raw-anchor.test.ts` |
| `lib/device-logs/raw-filter.test.ts` |
| `lib/device-logs/raw-follow-session.test.ts` |
| `lib/device-logs/raw-rows.test.ts` |
| `lib/device-logs/raw-view.order.test.ts` |
| `lib/device-logs/raw-view.test.ts` |
| `lib/device-logs/sharing-flow.test.ts` |
| `lib/device-logs/sharing-view.test.ts` |
| `lib/device-logs/sharing.test.ts` |
| `lib/device-logs/shell-layout.test.ts` |
| `lib/device-logs/storage-limits.test.ts` |
| `lib/device-logs/storage-messages.test.ts` |
| `lib/device-logs/storage-outcome.test.ts` |
| `lib/device-logs/storage-readout.test.ts` |
| `lib/device-logs/stream-pill.test.ts` |
| `lib/device-logs/timeline-copy.test.ts` |
| `lib/device-logs/timeline-groups.test.ts` |
| `lib/device-logs/view-logs.test.ts` |
| `lib/device-logs/viewer-availability.test.ts` |
| `tests/live-config-change-view-logs.test.ts` |
| `tests/live-start-failed-reason.test.ts` |
| `tests/log-pointer-keys.test.ts` |
| `tests/persistent-notice-surface.test.ts` |
| `tests/view-logs-notice-moment.test.ts` |
| `tests/vite-federation-excluded-namespace.test.ts` |

Related browser specs and their entry points:

| Repository path |
|---|
| `apps/frontend/tests/e2e/helpers/system-logs-audit.ts` |
| `apps/frontend/tests/e2e/helpers/system-logs-paint.ts` |
| `apps/frontend/tests/e2e/logs-dialog.spec.ts` |
| `apps/frontend/tests/e2e/pages/system-logs.ts` |
| `apps/frontend/tests/e2e/system-logs-keyboard.spec.ts` |
| `apps/frontend/tests/e2e/system-logs-responsive.spec.ts` |
| `apps/frontend/tests/e2e/system-logs.spec.ts` |
| `apps/frontend/tests/e2e/view-logs-action.spec.ts` |
| `apps/frontend/tests/e2e/visual/system-logs.visual.spec.ts` |
| `apps/frontend/tests/e2e/visual/view-logs-layout.visual.spec.ts` |

### Test fixtures (excluded from the lists above)

| Fixture file |
|---|
| `main/system-logs/__fixtures__/FakeEventsTab.svelte` |
| `main/system-logs/__fixtures__/FakeRawLogsTab.svelte` |
| `main/system-logs/__fixtures__/hud-feed.svelte.ts` |
| `main/system-logs/__fixtures__/log-storage.ts` |
| `lib/device-logs/__fixtures__/boots.ts` |
| `lib/device-logs/__fixtures__/events.ts` |
| `lib/device-logs/__fixtures__/sharing.ts` |

### RecoveryBand call sites

`main/system-logs/StorageCleanup.svelte:197`, `main/system-logs/StorageLimits.svelte:183`, `main/system-logs/StorageSection.svelte:61`.

### role="status" elements

`main/system-logs/BootPicker.svelte:165`, `main/system-logs/BundleDialog.svelte:101`, `main/system-logs/EventsPanel.svelte:43`, `main/system-logs/EventsTab.svelte:201`, `main/system-logs/ExportDialog.svelte:51`, `main/system-logs/RawLogList.svelte:241`, `main/system-logs/RawLogRow.svelte:136`, `main/system-logs/RawLogsPanel.svelte:98`, `main/system-logs/RawLogsTab.svelte:137`, `main/system-logs/StorageCleanup.svelte:191`, `main/system-logs/StorageLimits.svelte:173`, `main/system-logs/StorageSection.svelte:68`, `main/system-logs/SystemLogsView.svelte:222`.

### Limits and constants

| Name | Value | Source |
|---| --- |---|
| PAGE | 100 | `lib/device-logs/events-view.svelte.ts:45` |
| EVENT_ROW_CAP | 300 | `lib/device-logs/events-window.ts:4` |
| PAGE_LIMIT | 100 | `lib/device-logs/raw-filter.ts:57` |
| SEARCH_MAX_BYTES | 256 | `lib/device-logs/raw-filter.ts:58` |
| ROW_CAP | 2000 | `lib/device-logs/raw-rows.ts:9` |
| SEARCH_DEBOUNCE_MS | 300 | `lib/device-logs/raw-view.svelte.ts:22` |
| HELD_CAP | 500 | `lib/device-logs/raw-row-window.svelte.ts:13` |
| NEW_ENTRIES_EVERY_MS | 5000 | `lib/device-logs/raw-feedback.svelte.ts:23` |
| MOMENT_EXPORT_HALF_MS | 300000 | `lib/device-logs/raw-paging.svelte.ts:51` |

Backend and wire limits: [device-logs.md](../../../backend/docs/agents/device-logs.md),
[device-events.md](../../../backend/docs/agents/device-events.md).

### Keyboard and focus code

| Code | Source |
|---| --- |
| Events list key map (ArrowDown, ArrowUp, Home, End) | `main/system-logs/EventsTab.svelte:40-43` |
| Events row action lookup | `main/system-logs/EventsTab.svelte:105` |
| Events row keydown hook | `main/system-logs/EventsTab.svelte:231` |
| Events scroller scroll padding | `main/system-logs/EventsTab.svelte:190` |
| Events paging focus handoff | `main/system-logs/EventsTab.svelte:144` |
| Events focus recovery on row reset | `main/system-logs/EventsTab.svelte:78` |
| Start from newest focus handoff | `main/system-logs/EventsTab.svelte:109` |
| View raw logs pending (aria-disabled) | `main/system-logs/EventRow.svelte:90` |
| Event row tab stop | `main/system-logs/EventRow.svelte:95` |
| Raw list focus on a row | `main/system-logs/RawLogList.svelte:116` |
| Raw paging focus handoff | `main/system-logs/RawLogList.svelte:109` |
| Boot picker option focus | `main/system-logs/BootPicker.svelte:58` |
| Segmented choice focus | `main/system-logs/SegmentedChoice.svelte:50` |
| Selected tab focus | `main/system-logs/SystemLogsView.svelte:135` |
| Storage heading focus | `main/system-logs/SystemLogsView.svelte:144` |
| Cancel focus for clear confirmations | `main/system-logs/StorageCleanup.svelte:64` |
| RecoveryBand Retry button | `main/system-logs/RecoveryBand.svelte:35` |

### Recorded follow-ups

| Id | Record |
|---| --- |
| SL-2 | `apps/frontend/docs/agents/system-logs-critique.md:62` |
| SL-7 | `apps/frontend/docs/agents/system-logs-critique.md:67` |
| SL-11 | `apps/frontend/docs/agents/system-logs-critique.md:71` |
| SL-13 | `apps/frontend/docs/agents/system-logs-critique.md:73` |
| DF-27 | `docs/DESIGN-FOLLOWUPS.md:493` |
| DF-30 | `docs/DESIGN-FOLLOWUPS.md:548` |
| DF-34 | `docs/DESIGN-FOLLOWUPS.md:596` |
| DF-39 | `docs/DESIGN-FOLLOWUPS.md:689` |

### Not measured

Physical journal timing and volume, hardware e-ink output, and assistive
technology speech. Browser coverage is in the related specs above.

## Open decisions

- **Critique residuals.** The todo 36 critique and the owner of every finding it
  did not fix are in [system-logs-critique.md](system-logs-critique.md).
- **Polish (todo 38).** Four DF-31 items stay as they are:
  - Two time formats. Raw rows use a fixed two-digit hour (`RawLogList.svelte:47`)
    in a mono tabular column (`RawLogRow.svelte:102`), so times line up down the
    list. Events shows a relative time next to a localized clock for events dated
    today, or a localized date and time for older events (`timeline-copy.ts:168-174`).
  - The Storage heading under the Storage tab on phones. It names the Storage
    region (`SystemLogsView.svelte:138`) and is where a Storage request puts focus
    (`:139`, `:126`).
  - The unit in an expanded raw row. The row's unit truncates (`RawLogRow.svelte:105`);
    the expanded detail shows it whole and wrapped (`:127`).
  - "Boot started" may wrap in the side column. Keep the full localized timestamp and
    allow prettier line wrapping (`BootPicker.svelte:123`).

- **Clock evidence.** The clock-not-synced marker uses only backwards-running
  times between adjacent records of one boot. It never guesses from forward
  jumps, which a quiet period can also produce. A backend flag for systemd's
  own "time changed" record would be stronger and needs a wire change first.
- **Settings entry description.** `settings.index.logsDesc` ("Download device
  and system logs for diagnostics") under-describes the new view. Changing it
  changes an existing message, so it stays as it is until the owner decides.
- **Registry-owned variants.** `stream_reconfigured` and `update_failed` pick
  their detail variant from the recorded `outcome` and `stage` values;
  `engine_lost` and `modem_connected` pick it from a boolean (`streaming`:
  streaming or idle; `roaming`: roaming or notRoaming)
  (`lib/device-logs/timeline-details.ts:84,154,90,116`; `packages/rpc/src/schemas/events.schema.ts:65,162`).
- **Long lists (decided).** The Raw logs list uses `@tanstack/svelte-virtual`
  (`main/system-logs/RawLogList.svelte:3`). Chunk output and type-check effects are not measured in this lane.
- **List order (decided).** One list holds every Raw logs row in journal order;
  entries held while reading away are a boundary inside it, never a second
  list. Nothing sorts rows by time or by cursor text:
  - The first page that lists an entry after a head read (first query, Keep
    searching from the head, reset, filter change) replaces the list. Follow is
    detached for the whole read, so the page is the newest run and nothing
    arrives meanwhile. A dropped marker leaves then, on a reset or at the
    entry cap. When the held cap (`HELD_CAP`) cuts held rows, each cut entry
    and the count of each cut dropped marker are added to one held overflow
    count, and the other cut markers stay at the boundary
    (`lib/device-logs/raw-row-window.svelte.ts:92-103`). Show held rows adds that
    count back as one dropped marker
    (`lib/device-logs/raw-row-window.svelte.ts:69-86`, tested in
    `lib/device-logs/raw-view.order.test.ts:1365`).
  - Every other page extends its own edge with entries not listed yet; a
    Follow batch goes on top.
  - While following, Keep searching reads on with Follow detached until a page
    lists an entry or stops moving. If Follow attaches while a search is still
    empty, the bottom edge reads from the head again.
  - After a head read, Follow resumes from the page's newest entry only if that
    entry was not listed before, so it never rewinds into entries it dropped.
  - With no position (no entry listed, no checkpoint), Follow starts once to
    learn the device head, stops, reads the head again, then starts after the
    page's newest entry or that head. A null head means the boot has no record
    yet, and that first follow stays: it reads the boot from its start. A
    failed read leaves no position, so the next Follow learns the head again.
    Follow and Pause are disabled while a head read runs.
  - Accepted limits: a dropped marker marks the run of the batch it came with,
    not the exact gap, because the wire carries only a count; after a replay
    whose page is shorter than the listed run, older rows leave the view until
    the next Load more.
- **One Follow owner (decided).** A socket has one follow (a new start stops
  the socket's older one) and the app has one follow listener. Only the view
  that made the latest start stops the device follow or clears the listener;
  `dispose` runs once, and a disposed view never starts Follow again. A stale
  view's dispose, Pause or late start reply therefore leaves a newer view's
  Follow running. Messages that arrive before the start reply wait for its
  subscription ID. The start announcement precedes replay, so a queued end
  leaves Stopped as the live-region announcement. The app mounts one Raw logs
  view at a time. If two were mounted, the later start would win and the earlier
  view would not be told.
