/**
 * The per-code half of the Events copy: which detail sentence each registry code
 * gets from its parsed params, and which declared params are raw tokens that
 * only the row's Diagnostics disclosure shows.
 */
import { formatBytes } from "@ceraui/i18n/formatters";
import type { EventCode, EventParams } from "@ceraui/rpc/events";

export interface Sentence {
	readonly key: string;
	readonly values?: Readonly<Record<string, string>>;
}

export type Names = ReadonlyMap<string, string>;
export type Detail<C extends EventCode> = (
	params: EventParams<C>,
	locale: string,
	names: Names,
) => Sentence | null;

const number = (value: number, locale: string) =>
	new Intl.NumberFormat(locale).format(value);

function duration(seconds: number, locale: string): string {
	const [value, unit] =
		seconds < 60
			? [seconds, "second"]
			: seconds < 3600
				? [seconds / 60, "minute"]
				: [seconds / 3600, "hour"];
	return new Intl.NumberFormat(locale, {
		style: "unit",
		unit,
		unitDisplay: "long",
		maximumFractionDigits: 1,
	}).format(value);
}

const plain = (code: EventCode): Sentence => ({
	key: `timeline.${code}.detail`,
});
const variant = (code: EventCode, name: string): Sentence => ({
	key: `timeline.${code}.detail.${name}`,
});
const withValues = (
	code: EventCode,
	values: Readonly<Record<string, string>>,
): Sentence => ({ key: `timeline.${code}.detail`, values });

function link(code: "link_down" | "link_degraded") {
	return (params: EventParams<typeof code>): Sentence | null =>
		params.reason === undefined
			? null
			: {
					...variant(code, params.reason),
					values: { name: params.displayName ?? params.iface },
				};
}

function named(code: EventCode) {
	return (params: { readonly modemKey: string }, _: string, names: Names) => {
		const name = names.get(params.modemKey);
		return name === undefined ? null : withValues(code, { name });
	};
}

const version = (code: EventCode) => (params: { readonly version: string }) =>
	withValues(code, { version: params.version });

export const DETAILS: { readonly [C in EventCode]: Detail<C> | null } = {
	stream_started: null,
	stream_stopped: (params) => variant("stream_stopped", params.cause),
	stream_stop_failed: () => plain("stream_stop_failed"),
	stream_start_retrying: (params, locale) =>
		withValues("stream_start_retrying", {
			attempt: number(params.attempt, locale),
			maxAttempts: number(params.maxAttempts, locale),
		}),
	stream_start_failed: (params) =>
		params.captureCause === undefined
			? variant("stream_start_failed", params.class)
			: { key: `timeline.stream_start_failed.capture.${params.captureCause}` },
	stream_reconfigured: (params) =>
		variant("stream_reconfigured", params.outcome),
	stream_restored: () => plain("stream_restored"),
	stream_restore_failed: (params) =>
		variant("stream_restore_failed", params.reason),
	stream_autostart_failed: () => plain("stream_autostart_failed"),
	engine_lost: (params) =>
		variant("engine_lost", params.streaming ? "streaming" : "idle"),
	engine_recovered: null,
	link_down: link("link_down"),
	link_degraded: link("link_degraded"),
	link_up: (params) =>
		withValues("link_up", { name: params.displayName ?? params.iface }),
	bond_all_links_down: (params, locale) =>
		withValues("bond_all_links_down", {
			count: number(params.linkCount, locale),
		}),
	bond_links_recovered: (params, locale) =>
		withValues("bond_links_recovered", {
			count: number(params.linkCount, locale),
		}),
	internet_lost: () => plain("internet_lost"),
	internet_restored: null,
	interface_added: (params) =>
		withValues("interface_added", { iface: params.iface }),
	interface_removed: (params) =>
		withValues("interface_removed", { iface: params.iface }),
	modem_added: (params) => withValues("modem_added", { name: params.name }),
	modem_removed: (params) => withValues("modem_removed", { name: params.name }),
	modem_connected: (params, _, names) => {
		const name = names.get(params.modemKey);
		if (name === undefined) return null;
		return {
			...variant("modem_connected", params.roaming ? "roaming" : "notRoaming"),
			values: { name },
		};
	},
	modem_disconnected: named("modem_disconnected"),
	modem_registration_rejected: named("modem_registration_rejected"),
	sim_inserted: named("sim_inserted"),
	sim_removed: named("sim_removed"),
	update_packages_recovered: () => plain("update_packages_recovered"),
	update_slot_sync_recovered: () => plain("update_slot_sync_recovered"),
	update_updates_available: null,
	update_installed: (params, locale) =>
		withValues("update_installed", {
			count: number(params.packages.length, locale),
		}),
	update_refused: () => plain("update_refused"),
	update_download_paused: () => plain("update_download_paused"),
	update_os_staged: version("update_os_staged"),
	update_os_activation_requested: version("update_os_activation_requested"),
	update_os_activated: version("update_os_activated"),
	update_os_rollback: version("update_os_rollback"),
	update_slots_current: null,
	update_restart_recommended: (params) =>
		withValues("update_restart_recommended", { unit: params.unit }),
	update_cellular_approval: (params) =>
		withValues("update_cellular_approval", { size: params.size }),
	update_credentials_expiring: (params, locale) =>
		withValues("update_credentials_expiring", {
			days: number(params.days, locale),
		}),
	update_credentials_expired: () => plain("update_credentials_expired"),
	update_transport_unhealthy: () => plain("update_transport_unhealthy"),
	update_kernel_staged: version("update_kernel_staged"),
	update_kernel_succeeded: version("update_kernel_succeeded"),
	update_kernel_rolled_back: version("update_kernel_rolled_back"),
	update_os_stage_retry: version("update_os_stage_retry"),
	update_os_stage_operator: version("update_os_stage_operator"),
	update_os_stage_unresolved: version("update_os_stage_unresolved"),
	update_failed: (params) => variant("update_failed", params.stage),
	// One recorded value of the two would make either sentence false.
	device_started: ({ osImage, slot }) =>
		osImage !== null && slot !== null
			? { ...variant("device_started", "known"), values: { osImage, slot } }
			: osImage === null && slot === null
				? variant("device_started", "unknown")
				: null,
	previous_boot_unclean: () => plain("previous_boot_unclean"),
	shutdown_requested: (params) => variant("shutdown_requested", params.action),
	service_stopping: () => plain("service_stopping"),
	power_action_refused: () => plain("power_action_refused"),
	disk_low: (params, locale) =>
		withValues("disk_low", { free: formatBytes(locale)(params.freeBytes) }),
	disk_ok: (params, locale) =>
		withValues("disk_ok", { free: formatBytes(locale)(params.freeBytes) }),
	config_reset_damaged: () => plain("config_reset_damaged"),
	hardware_identity_drift: () => plain("hardware_identity_drift"),
	bootloader_update_failed: () => plain("bootloader_update_failed"),
	capture_source_lost: (params) =>
		params.name === undefined
			? null
			: withValues("capture_source_lost", { name: params.name }),
	capture_source_recovered: (params) =>
		params.name === undefined
			? null
			: withValues("capture_source_recovered", { name: params.name }),
	audio_source_lost: null,
	audio_source_recovered: null,
	capture_input_lost: (params) =>
		withValues("capture_input_lost", { name: params.name }),
	capture_input_returned: (params) =>
		withValues("capture_input_returned", { name: params.name }),
	capture_standby_entered: () => plain("capture_standby_entered"),
	capture_standby_exited: (params, locale) =>
		withValues("capture_standby_exited", {
			duration: duration(params.durationSec, locale),
		}),
};

const MODEM = ["modemKey"] as const;
const KIND = ["kind"] as const;
/** Registry-declared params whose raw values only the Diagnostics disclosure shows. */
export const DIAGNOSTIC_PARAMS: {
	readonly [C in EventCode]?: readonly string[];
} = {
	stream_started: ["origin"],
	stream_start_retrying: ["class", "phase"],
	stream_start_failed: ["class", "phase"],
	stream_autostart_failed: ["reason"],
	link_down: KIND,
	link_degraded: KIND,
	link_up: KIND,
	interface_added: KIND,
	interface_removed: KIND,
	modem_added: MODEM,
	modem_removed: MODEM,
	modem_connected: MODEM,
	modem_disconnected: MODEM,
	modem_registration_rejected: ["modemKey", "rejection"],
	sim_inserted: MODEM,
	sim_removed: MODEM,
	update_installed: ["packages"],
	update_refused: ["reason"],
	update_transport_unhealthy: ["reasons"],
	update_failed: ["reason"],
	previous_boot_unclean: ["evidence"],
	shutdown_requested: ["origin"],
	service_stopping: ["signal"],
	power_action_refused: ["reason"],
	hardware_identity_drift: ["detected", "configured"],
};
