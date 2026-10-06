<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## A DONGLE'S OWN WEB UI IS NOW REACHABLE, AND THE LINK CARRIES AN IDENTITY [EXISTS]

The Cellular row and `RouterDongleDialog` used to STATE a dongle's admin address
with an explicit note that it is not reachable from this page — correct at the
time, because the operator's browser is not on the dongle's network. The backend
now carries that page through CeraUI's own origin, so both surfaces gained an
"Open dongle admin UI" button (`open-router-admin` on the row,
`dongle-open-admin` in the dialog) and the copy that said the address was
unreachable is retired.

- **The button carries the ROW ID, never the address** (`data-device`). The bench
  twins share one factory address, so an address-keyed link would open whichever
  of the pair the kernel picked; the id resolves backend-side to an INTERFACE.
  Pinned by a test that renders both twins and asserts the rendered markup
  contains no `192.168.8.1` at all.
- **A NEW TAB, not an iframe, and that is measured.** The bench E3372 answers
  `X-Frame-Options: deny` and the ZTE `sameorigin`, so neither would render
  embedded. The proxy strips those headers from what IT serves — a dongle must
  not dictate framing policy for the device's origin — but embedding a whole
  vendor SPA inside the control plane is a separate decision that was not made.
- **THE TAB IS OPENED IN THE GESTURE, AND NEVER WITH `noopener`.** A popup
  blocker only trusts a `window.open` inside the user gesture, so it is opened
  BEFORE the RPC is awaited and navigated once the device answers (or closed
  again on a refusal, so nothing strands a blank tab). `noopener` makes
  `window.open` return `null` BY SPEC — found in a real browser, where the
  operator's own tab navigated away to the dongle and took the Network page with
  it. The opener link is severed immediately after instead, which costs nothing:
  the proxied page is served from CeraUI's OWN origin, so it is same-origin
  either way and `noopener` was never what governed it. A genuinely blocked popup
  still falls back to a same-tab navigation rather than doing nothing.
- **It lives in the row's DETAILS disclosure**, beside the admin note it acts on,
  because todo 64 made `router-admin-note` secondary and a new primary-row button
  would undo that density work. It renders for every `router-ethernet` row that
  has a `router_admin` block — INCLUDING an unreachable one, since the address is
  a routing fact and the last read may simply have been busy.
- **A refusal is rendered, never swallowed**: the row shows a `role="status"`
  band (`router-admin-open-error`) and the dialog a toast, both keyed through
  `routerAdminOpenReasonKey` so a machine token never reaches the operator.

The shared action is `main/network/router-admin-open.ts`, used by BOTH surfaces
so they cannot drift into two open behaviours for one device. Coverage:
`CellularSection.adminProxy.test.ts` (one button per dongle keyed on the id, the
no-address assertion, the mm-managed and no-`router_admin` negatives, the
gesture-ordering proof, the blocked-popup fallback, and the refusal table).
Backend half: `apps/backend/AGENTS.md` → …AND ITS OWN WEB UI IS REACHED THROUGH A
DEVICE-BOUND REVERSE PROXY.

