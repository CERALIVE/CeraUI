<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## HOTSPOT QR SURFACE — ONE QR, AND IT IS ESCAPED [EXISTS]

`HotspotDialog` renders exactly ONE QR: the WiFi-join code carrying the live
hotspot credentials (`generateWifiQr`, gated on `isActive`). **Do not add a second
one.**

The connect-your-phone section (#67 Phase-0) that used to sit beneath it — a
device-access QR encoding `http://<gatewayIp>/` so a joined phone could open
CeraUI — is REMOVED by explicit product decision after live board QA: two QR codes
in one dialog read as noise, and the operator has to join the hotspot before the
second one is reachable anyway. The removal took its whole stack with it, all of
which had exactly one consumer: `ConnectPhoneSection.svelte` + its test, the
`connect-phone.visual.spec.ts` e2e, the `wifi.hotspotInfo` RPC (procedure, router
registration, `client.ts` binding, `HotspotInfoOutput`/`HotspotInfo` schema,
`modules/wifi/wifi-hotspot-info.ts`, and its backend test), and the five
`network.hotspot.connectPhone*` / `deviceAccessQrLabel` / `navigateManuallyNote` /
`hotspotOffPrompt` i18n keys across all 10 locales.

`generateDeviceAccessQr` is deliberately UNTOUCHED — it is a shared helper with
three other live consumers (`NetworkIngestSection`, `SourceSection`,
`CloudRemoteDialog`) and nothing to do with the hotspot.

**`generateWifiQr` escapes the four WIFI-QR reserved characters.** The payload is
`WIFI:T:<enc>;S:<ssid>;P:<password>;;`, and the de-facto standard ZXing (and every
phone camera that follows it) parses `\`, `;`, `,` and `:` as field structure — so
a hotspot name or password containing one of them must carry a backslash before it
or the scanner reads a field boundary mid-credential and joins the wrong network,
or none at all. Nothing validates the hotspot name/password against those
characters, so this is reachable by any operator who picks one. `escapeWifiQrField`
does it in ONE pass over a character class, and that is load-bearing: escaping the
four in sequence would re-escape the backslashes the earlier steps just inserted.
Coverage: `NetworkHelper.test.ts` asserts the EXACT payload string handed to the QR
encoder — including a plain-alphanumeric regression guard proving today's board
credentials are byte-unchanged.

