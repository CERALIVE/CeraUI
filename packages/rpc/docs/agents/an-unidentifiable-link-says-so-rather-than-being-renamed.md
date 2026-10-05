<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## AN UNIDENTIFIABLE LINK SAYS SO, RATHER THAN BEING RENAMED

`bondLinkIdentityStateSchema` (`resolved | unmappable`) is the wire vocabulary
for "could the writer resolve which PHYSICAL device this bonded link is". It
lives here rather than in the backend for the usual reason: the backend produces
it and the operator surface renders it, and a second spelling of "unknown" is how
a device that cannot be identified comes to look like one that simply has no
telemetry yet.

Two shape decisions carry weight:

- **`identity_state` is emitted ONLY as `'unmappable'`.** `resolved` is proven by
  the `link_id` beside it, and a legacy-`conn_id`-rung row makes no claim in
  either direction — so absence means "nothing is being asserted here", never
  "identified". Emitting `resolved` on every row would put a second, redundant
  source of truth next to `link_id` for them to disagree on.
- **It is a SIBLING of `link_id`, never a value of it.** The retired backend
  fallback minted `lnk_<ifname>` for exactly this case: an id-shaped string keyed
  on an interface name, which two same-model dongles swap on a replug. A state is
  the honest answer; a plausible id is not.

