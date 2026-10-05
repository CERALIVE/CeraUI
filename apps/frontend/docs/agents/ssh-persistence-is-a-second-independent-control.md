<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## SSH PERSISTENCE IS A SECOND, INDEPENDENT CONTROL [EXISTS]

`SshDialog.svelte` carries TWO controls over one unit, and they are deliberately
not fused: the Start/Stop button answers "is SSH running right now", the
`ssh-persist-toggle` switch answers "will it come back after a reboot". Before
it, the dialog could only say "Active" about a device measured `is-active:
active` beside `is-enabled: disabled` — SSH worked, looked healthy, and would
vanish on the next reboot with nothing on screen saying so.

- **SEPARATE async-operation keys** (`ssh` and `ssh-persist`), which is the whole
  independence claim made mechanical: a pending Start/Stop can never refuse the
  persistence switch or move it, and vice versa. Do NOT share one key "so they
  cannot race" — `systemctl start` and `systemctl enable` are different verbs on
  one unit and systemd serialises them itself.
- **PESSIMISTIC, the `NetworkIngestDialog` discipline.** The switch position is
  `sshIsPersistent(getSsh())` — the device's own `ssh.enabled` — and only the
  spinner is optimistic, so an RPC that resolved `{success:true}` cannot move it.
  It stays `pending` past the resolve and the confirm `$effect` reuses
  `sshToggleConfirmed` verbatim, so the two controls cannot drift into two ideas
  of "the device agrees now".
- **`sshIsPersistent` fails to NOT-persistent on an absent status.** A device
  that has not told us must never be rendered as "your access is safe across a
  reboot".
- **`active && !enabled` renders a standing advisory band**
  (`ssh-persist-warning`, `role="status"`, amber). That is the ONLY combination
  that bands: armed-but-stopped is a legitimate operator state, and so is the
  agreeing pair. Amber and never destructive — SSH is working right now; what is
  wrong is what happens next. This band is the whole reason the silent outage is
  no longer silent, so do not gate it behind a hover, a tooltip, or a dismiss:
  the shipped kiosk touchscreen cannot hover.
- **The two axes are GROUPED** (`space-y-2` around the status card, the switch
  row and the band) so the relationship reads at a glance, while the momentary
  Start/Stop action stays the terminal full-width control.

Copy: `advanced.sshPersist{,Hint,Warning}` (10 locales). Coverage:
`SshDialog.persist.test.ts` (rendered DOM over a rune-backed `ssh` feed — the two
distinct controls, both drive-the-right-RPC directions, the never-disables-the-other
proof, the RPC-success-alone-does-not-move-it proof, and the band's render/silence
matrix) + `os-toggle-predicates.test.ts`. Rule-E proof: sharing one key reddens 1,
making the switch optimistic reddens 1, dropping the band reddens 2. Device half:
[`../backend/AGENTS.md`](../../../backend/AGENTS.md) → SSH BOOT PERSISTENCE IS A SECOND
AXIS, NOT A SIDE EFFECT.

