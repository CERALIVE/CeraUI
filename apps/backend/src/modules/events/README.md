# Event persistence (EXISTS)

`store.ts` owns two independent JSONL rings on the data partition. Events retain
eight files of at most 512 KiB each; boot records retain two files of at most
128 KiB each. `clearEvents` unlinks the ring epoch and syncs its directory
before removing any event generation. If either step fails, it returns false
and leaves every generation in place. Once the epoch is invalidated, it
attempts every event generation and reports any removal failure. `eventsBytes`
counts event generation files only. Boot versions remain available after event
cleanup.

`epoch.ts` exports `eventsEpoch`, which names the event ring with a UUID kept
in `events.epoch` (the file name `store.ts` exports for its clear), written
with mode 0600 and `fdatasync` when it is missing or fails the wire schema. A
clear removes it first, so a clear cut short never keeps the old name for a
changed ring, and the next read names a new one. It returns undefined when the
file cannot be read or written, never a new value per read.

The directory resolves from `CERALIVE_EVENTS_DIR`, then
`CERALIVE_DATA_DIR/ceralive/events`, then the shared development detector's
temporary `ceralive-dev/events` directory, otherwise `/data/ceralive/events`.
Directories are created with mode 0700. Each append repairs the current file to
0600, including before rotation, and opens the new file with mode 0600.

`appendEvent(event, { sync, baseDir?, fs?, warn? })` writes a complete version-1
line in one synchronous append operation. `sync: true` calls `fdatasync` after
the append; boot appends always sync. Generation moves use atomic rename.
Unlike a configuration snapshot, JSONL is append-only: there is no temporary
replacement of the whole active file. A crash can tear the last line. Readers
ignore unterminated, malformed, invalid and unknown-version records, and the
next append inspects only the final byte and separates a torn tail from its
new record. The ring is intended for
the single backend writer; rotation is not a multi-process transaction.

All operations read disk rather than retaining an authoritative memory cache.
Writers and readers use the shared wire schemas, with the boot schema's journal
boot-ID constraint also applied to events. Invalid records are rejected before
directory creation, rotation or writes. Rejection returns void and emits one
constant, bounded warning without record content; the emitter remains responsible
for its own registry validation. Persisted bytes use the parsed record, so future
codes and the wire's family/severity defaults round-trip consistently. Sequence
numbers remain safe integers (including negative values), timestamps remain finite
numbers, and codes remain strings as specified by the wire schema.
Oversized new records are rejected before any write or rotation; oversized
existing files are skipped by readers and refuse further appends. I/O failures
produce one warning per operation and return an empty result, false for clear,
or void for appends.

The byte caps include the JSONL newline and all params or version strings.
There is no separate params-size, character-count, line-length or record-count
limit. Packing density determines how many records fit; a full ring evicts a
whole oldest generation when the active file rotates. Oversized generations
containing valid JSON are skipped quietly like corrupt records; append refusal
leaves the files unchanged and emits one warning stating the size failure.

`EventStoreDeps` supplies a base directory, synchronous filesystem operations and
a warning sink for deterministic fault injection. Timestamps belong to the
producer; the store neither reads a clock nor changes supplied timestamps.
`src/tests/events-store*.test.ts` cover bounds, permissions, corrupt data,
restart recovery and failures at the persistence boundary.
