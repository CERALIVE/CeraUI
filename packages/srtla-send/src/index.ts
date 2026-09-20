/**
 * `@ceraui/srtla-send` — sender args builder + telemetry reader for
 * `srtla-send-rs`, absorbed from the retired npm sender binding (plan
 * upstream-rebase-hard-fork, D13). Private workspace package; never published.
 *
 * The `./control` subpath is deliberately NOT re-exported here: it is the legacy
 * control dialect awaiting the todo-41 rewrite and is excluded from this
 * package's build. Import it explicitly from `@ceraui/srtla-send/control` if you
 * must touch it before then.
 */
export * from "./sender/index";
export type { TelemetryUpdate } from "./telemetry/index";
export * from "./telemetry/index";
export { senderTelemetryPath } from "./telemetry/index";
