/**
 * `@ceraui/srtla-send` — sender args builder + telemetry reader for the
 * `srtla` sender, absorbed from the retired npm sender binding (plan
 * upstream-rebase-hard-fork, D13). Private workspace package; never published.
 *
 * The `./control` subpath speaks the hard-forked sender's own JSON-RPC dialect
 * (`get_capabilities` / `get_stats` / topic `subscribe`), NOT the retired
 * binding's `hello` + `subscribe-events`. It is re-exported here alongside the
 * other two surfaces; `@ceraui/srtla-send/control` remains the narrower import.
 */
export * from "./control/index";
export * from "./sender/index";
export type { TelemetryUpdate } from "./telemetry/index";
export * from "./telemetry/index";
export { senderTelemetryPath } from "./telemetry/index";
