import { setLocale } from "@ceraui/i18n/svelte";
import { EVENT_REGISTRY } from "@ceraui/rpc/events";
import type { DeviceEvent, EventFamily } from "@ceraui/rpc/schemas";
import {
	CircleAlert,
	CircleCheck,
	Cpu,
	Download,
	Info,
	Network,
	Radio,
	SignalHigh,
	TriangleAlert,
	Video,
} from "@lucide/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ar, en } from "../../tests/helpers/catalog";

import { EVENT_AT, event } from "./__fixtures__/events";
import { formatBootTime } from "./boot-rows";
import { type DetailPart, eventCopy, eventTime } from "./timeline-copy";

const MODEM = "platform-fc880000.usb-usb-0:1.4.1";
const NAMES = new Map([[MODEM, "Quectel EM12"]]);
const ATTEMPT = { phase: "connect", attempt: 1, maxAttempts: 1 };
const t = en.timeline;

afterEach(() => {
	setLocale("en");
	vi.useRealTimers();
});

function fill(template: string, values: Record<string, string> = {}): string {
	return template.replace(
		/\{(\w+)\}/g,
		(_, name: string) => values[name] ?? "",
	);
}

function text(parts: readonly DetailPart[] | null): string | null {
	return parts === null ? null : parts.map((part) => part.text).join("");
}

function params(parts: readonly DetailPart[] | null): string[] {
	return (parts ?? []).filter((part) => part.param).map((part) => part.text);
}

function copyOf(code: string, values: DeviceEvent["params"] = {}) {
	return eventCopy(event(1, code, values), NAMES);
}

describe("eventCopy — a detail sentence for every code", () => {
	it.each<[string, DeviceEvent["params"], string | null]>([
		["stream_started", {}, null],
		[
			"stream_stopped",
			{ cause: "operator", durationSec: 12 },
			t.stream_stopped.detail.operator,
		],
		[
			"stream_stopped",
			{ cause: "engine_loss", durationSec: 3 },
			t.stream_stopped.detail.engine_loss,
		],
		[
			"stream_stopped",
			{ cause: "reconfigure", durationSec: 0 },
			t.stream_stopped.detail.reconfigure,
		],
		["stream_stop_failed", {}, t.stream_stop_failed.detail],
		[
			"stream_start_retrying",
			{
				class: "start_timeout",
				phase: "playing-wait",
				attempt: 2,
				maxAttempts: 3,
			},
			fill(t.stream_start_retrying.detail, { attempt: "2", maxAttempts: "3" }),
		],
		[
			"stream_start_failed",
			{ class: "engine_unavailable", ...ATTEMPT },
			t.stream_start_failed.detail.engine_unavailable,
		],
		[
			"stream_start_failed",
			{
				class: "capture_source_unavailable",
				...ATTEMPT,
				captureCause: "no_signal",
			},
			t.stream_start_failed.capture.no_signal,
		],
		[
			"stream_start_failed",
			{
				class: "capture_source_unavailable",
				...ATTEMPT,
				captureCause: "secondary-unavailable",
			},
			t.stream_start_failed.capture["secondary-unavailable"],
		],
		[
			"stream_reconfigured",
			{ outcome: "streaming" },
			t.stream_reconfigured.detail.streaming,
		],
		[
			"stream_reconfigured",
			{ outcome: "idle" },
			t.stream_reconfigured.detail.idle,
		],
		[
			"stream_reconfigured",
			{ outcome: "reconciling" },
			t.stream_reconfigured.detail.reconciling,
		],
		["stream_restored", {}, t.stream_restored.detail],
		[
			"stream_restore_failed",
			{ reason: "lifecycle_busy" },
			t.stream_restore_failed.detail.lifecycle_busy,
		],
		[
			"stream_autostart_failed",
			{ reason: "config_invalid" },
			t.stream_autostart_failed.detail,
		],
		["engine_lost", { streaming: true }, t.engine_lost.detail.streaming],
		["engine_lost", { streaming: false }, t.engine_lost.detail.idle],
		["engine_recovered", { streaming: false }, null],
		[
			"link_down",
			{ iface: "wwan0", kind: "cellular", reason: "definitive_loss" },
			fill(t.link_down.detail.definitive_loss, { name: "wwan0" }),
		],
		["link_down", { iface: "wwan0", kind: "cellular" }, null],
		[
			"link_degraded",
			{
				iface: "wlan0",
				kind: "wifi",
				displayName: "Venue Wi-Fi",
				reason: "captive_portal",
			},
			fill(t.link_degraded.detail.captive_portal, { name: "Venue Wi-Fi" }),
		],
		["link_degraded", { iface: "wlan0", kind: "wifi" }, null],
		[
			"link_up",
			{ iface: "eth0", kind: "ethernet", downSec: 40 },
			fill(t.link_up.detail, { name: "eth0" }),
		],
		[
			"link_up",
			{ iface: "wlan0", kind: "wifi", displayName: "Venue Wi-Fi" },
			fill(t.link_up.detail, { name: "Venue Wi-Fi" }),
		],
		[
			"bond_all_links_down",
			{ linkCount: 3 },
			fill(t.bond_all_links_down.detail, { count: "3" }),
		],
		[
			"bond_links_recovered",
			{ linkCount: 2 },
			fill(t.bond_links_recovered.detail, { count: "2" }),
		],
		["internet_lost", {}, t.internet_lost.detail],
		["internet_restored", {}, null],
		[
			"interface_added",
			{ iface: "usb0", kind: "other" },
			fill(t.interface_added.detail, { iface: "usb0" }),
		],
		[
			"interface_removed",
			{ iface: "usb1", kind: "other" },
			fill(t.interface_removed.detail, { iface: "usb1" }),
		],
		[
			"modem_added",
			{ modemKey: MODEM, name: "EM12 #2" },
			fill(t.modem_added.detail, { name: "EM12 #2" }),
		],
		[
			"modem_removed",
			{ modemKey: MODEM, name: "EM12 #3" },
			fill(t.modem_removed.detail, { name: "EM12 #3" }),
		],
		[
			"modem_connected",
			{ modemKey: MODEM, roaming: true },
			fill(t.modem_connected.detail.roaming, { name: "Quectel EM12" }),
		],
		[
			"modem_connected",
			{ modemKey: MODEM, roaming: false, networkType: "5G" },
			fill(t.modem_connected.detail.notRoaming, { name: "Quectel EM12" }),
		],
		["modem_connected", { modemKey: "unseen", roaming: true }, null],
		[
			"modem_disconnected",
			{ modemKey: MODEM },
			fill(t.modem_disconnected.detail, { name: "Quectel EM12" }),
		],
		["modem_disconnected", { modemKey: "unseen" }, null],
		[
			"modem_registration_rejected",
			{ modemKey: MODEM, rejection: "roaming_not_allowed" },
			fill(t.modem_registration_rejected.detail, { name: "Quectel EM12" }),
		],
		[
			"modem_registration_rejected",
			{ modemKey: "unseen", rejection: "x" },
			null,
		],
		[
			"sim_inserted",
			{ modemKey: MODEM },
			fill(t.sim_inserted.detail, { name: "Quectel EM12" }),
		],
		["sim_inserted", { modemKey: "unseen" }, null],
		[
			"sim_removed",
			{ modemKey: MODEM },
			fill(t.sim_removed.detail, { name: "Quectel EM12" }),
		],
		["sim_removed", { modemKey: "unseen" }, null],
		[
			"update_packages_recovered",
			{ id: "u" },
			t.update_packages_recovered.detail,
		],
		[
			"update_slot_sync_recovered",
			{ id: "u" },
			t.update_slot_sync_recovered.detail,
		],
		["update_updates_available", { id: "u" }, null],
		[
			"update_installed",
			{ id: "u", packages: ["a", "b", "c"] },
			fill(t.update_installed.detail, { count: "3" }),
		],
		[
			"update_refused",
			{ id: "u", reason: "streaming" },
			t.update_refused.detail,
		],
		["update_download_paused", { id: "u" }, t.update_download_paused.detail],
		[
			"update_os_staged",
			{ id: "u", version: "2026.11.4" },
			fill(t.update_os_staged.detail, { version: "2026.11.4" }),
		],
		[
			"update_os_activation_requested",
			{ id: "u", version: "2026.11.5" },
			fill(t.update_os_activation_requested.detail, { version: "2026.11.5" }),
		],
		[
			"update_os_activated",
			{ id: "u", version: "2026.11.6" },
			fill(t.update_os_activated.detail, { version: "2026.11.6" }),
		],
		[
			"update_os_rollback",
			{ id: "u", version: "2026.11.7" },
			fill(t.update_os_rollback.detail, { version: "2026.11.7" }),
		],
		["update_slots_current", { id: "u" }, null],
		[
			"update_restart_recommended",
			{ id: "u", unit: "ceralive.service" },
			fill(t.update_restart_recommended.detail, { unit: "ceralive.service" }),
		],
		[
			"update_cellular_approval",
			{ id: "u", size: "412 MB" },
			fill(t.update_cellular_approval.detail, { size: "412 MB" }),
		],
		[
			"update_credentials_expiring",
			{ id: "u", days: 30 },
			fill(t.update_credentials_expiring.detail, { days: "30" }),
		],
		[
			"update_credentials_expired",
			{ id: "u" },
			t.update_credentials_expired.detail,
		],
		[
			"update_transport_unhealthy",
			{ id: "u", reasons: ["dns"] },
			t.update_transport_unhealthy.detail,
		],
		[
			"update_kernel_staged",
			{ id: "u", version: "6.1.115" },
			fill(t.update_kernel_staged.detail, { version: "6.1.115" }),
		],
		[
			"update_kernel_succeeded",
			{ id: "u", version: "6.1.116" },
			fill(t.update_kernel_succeeded.detail, { version: "6.1.116" }),
		],
		[
			"update_kernel_rolled_back",
			{ id: "u", version: "6.1.117" },
			fill(t.update_kernel_rolled_back.detail, { version: "6.1.117" }),
		],
		[
			"update_os_stage_retry",
			{ id: "u", version: "2026.12.1" },
			fill(t.update_os_stage_retry.detail, { version: "2026.12.1" }),
		],
		[
			"update_os_stage_operator",
			{ id: "u", version: "2026.12.2" },
			fill(t.update_os_stage_operator.detail, { version: "2026.12.2" }),
		],
		[
			"update_os_stage_unresolved",
			{ id: "u", version: "2026.12.3" },
			fill(t.update_os_stage_unresolved.detail, { version: "2026.12.3" }),
		],
		[
			"update_failed",
			{ stage: "download", reason: "x" },
			t.update_failed.detail.download,
		],
		[
			"update_failed",
			{ stage: "commit", reason: "x" },
			t.update_failed.detail.commit,
		],
		[
			"update_failed",
			{ stage: "sync", reason: "x" },
			t.update_failed.detail.sync,
		],
		[
			"update_failed",
			{ stage: "os-staging", reason: "x" },
			t.update_failed.detail["os-staging"],
		],
		[
			"previous_boot_unclean",
			{ bootId: "b".repeat(32), evidence: [] },
			t.previous_boot_unclean.detail,
		],
		[
			"shutdown_requested",
			{ action: "reboot", origin: "ui" },
			t.shutdown_requested.detail.reboot,
		],
		[
			"shutdown_requested",
			{ action: "poweroff", origin: "ui" },
			t.shutdown_requested.detail.poweroff,
		],
		["service_stopping", { signal: "SIGTERM" }, t.service_stopping.detail],
		[
			"power_action_refused",
			{ reason: "streaming" },
			t.power_action_refused.detail,
		],
		[
			"disk_low",
			{ freeBytes: 400 * 1024 * 1024 },
			fill(t.disk_low.detail, { free: "400 MB" }),
		],
		[
			"disk_ok",
			{ freeBytes: 1.5 * 1024 ** 3 },
			fill(t.disk_ok.detail, { free: "1.5 GB" }),
		],
		["config_reset_damaged", {}, t.config_reset_damaged.detail],
		[
			"hardware_identity_drift",
			{ detected: "rock5b", configured: "orangepi5" },
			t.hardware_identity_drift.detail,
		],
		["bootloader_update_failed", {}, t.bootloader_update_failed.detail],
		[
			"capture_source_lost",
			{ name: "HDMI" },
			fill(t.capture_source_lost.detail, { name: "HDMI" }),
		],
		["capture_source_lost", {}, null],
		[
			"capture_source_recovered",
			{ name: "HDMI 2" },
			fill(t.capture_source_recovered.detail, { name: "HDMI 2" }),
		],
		["capture_source_recovered", {}, null],
		["audio_source_lost", {}, null],
		["audio_source_recovered", {}, null],
		[
			"capture_input_lost",
			{ name: "USB Camera", activeCamera: true },
			fill(t.capture_input_lost.detail, { name: "USB Camera" }),
		],
		[
			"capture_input_returned",
			{ name: "USB Camera 2", activeCamera: false },
			fill(t.capture_input_returned.detail, { name: "USB Camera 2" }),
		],
		[
			"capture_standby_entered",
			{ durationSec: 0 },
			t.capture_standby_entered.detail,
		],
		[
			"capture_standby_exited",
			{ durationSec: 42 },
			fill(t.capture_standby_exited.detail, { duration: "42 seconds" }),
		],
		[
			"capture_standby_exited",
			{ durationSec: 180 },
			fill(t.capture_standby_exited.detail, { duration: "3 minutes" }),
		],
		[
			"capture_standby_exited",
			{ durationSec: 5400 },
			fill(t.capture_standby_exited.detail, { duration: "1.5 hours" }),
		],
		[
			"capture_standby_exited",
			{ durationSec: 60 },
			fill(t.capture_standby_exited.detail, { duration: "1 minute" }),
		],
		[
			"capture_standby_exited",
			{ durationSec: 100 },
			fill(t.capture_standby_exited.detail, { duration: "1.7 minutes" }),
		],
		[
			"capture_standby_exited",
			{ durationSec: 1200 },
			fill(t.capture_standby_exited.detail, { duration: "20 minutes" }),
		],
		[
			"capture_standby_exited",
			{ durationSec: 3600 },
			fill(t.capture_standby_exited.detail, { duration: "1 hour" }),
		],
		[
			"capture_standby_exited",
			{ durationSec: 650_000 },
			fill(t.capture_standby_exited.detail, { duration: "180.6 hours" }),
		],
	])("%s %j", (code, values, expected) => {
		const copy = copyOf(code, values);
		expect(copy.title).toBe(t[code].title);
		expect(text(copy.detail)).toBe(expected);
	});

	it("gives every registry code its own title", () => {
		for (const code of Object.keys(EVENT_REGISTRY)) {
			expect(copyOf(code).title).toBe(t[code].title);
		}
	});

	it("device_started states the image and slot only when both were recorded", () => {
		const versions = {
			board: null,
			boardModel: null,
			ceraui: null,
			engine: null,
			senderVersion: null,
			kernel: null,
			bun: null,
			previousBootId: null,
			previousShutdown: null,
		};
		const known = copyOf("device_started", {
			...versions,
			osImage: "2026.11.3-beta",
			slot: "b",
		});
		expect(text(known.detail)).toBe(
			fill(t.device_started.detail.known, {
				osImage: "2026.11.3-beta",
				slot: "b",
			}),
		);
		expect(params(known.detail)).toEqual(["2026.11.3-beta", "b"]);
		expect(
			text(
				copyOf("device_started", { ...versions, osImage: null, slot: null })
					.detail,
			),
		).toBe(t.device_started.detail.unknown);
		expect(
			copyOf("device_started", {
				...versions,
				osImage: "2026.11.3",
				slot: null,
			}).detail,
		).toBeNull();
		expect(
			copyOf("device_started", { ...versions, osImage: null, slot: "a" })
				.detail,
		).toBeNull();
	});

	it("names a modem only from what the history recorded", () => {
		const unnamed = eventCopy(
			event(1, "modem_disconnected", { modemKey: MODEM }),
		);
		expect(unnamed.detail).toBeNull();
		expect(unnamed.title).toBe(t.modem_disconnected.title);
	});
});

describe("eventCopy — data params render on their own", () => {
	it("splits a sentence into text and its data params, in reading order", () => {
		const copy = copyOf("stream_start_retrying", {
			class: "start_timeout",
			phase: "connect",
			attempt: 4,
			maxAttempts: 5,
		});
		expect(copy.detail).toEqual([
			{ text: "Attempt ", param: false },
			{ text: "4", param: true },
			{ text: " of ", param: false },
			{ text: "5", param: true },
			{ text: ".", param: false },
		]);
	});

	it("keeps a param that opens the sentence as its first part", () => {
		const copy = copyOf("link_up", { iface: "eth0", kind: "ethernet" });
		expect(copy.detail?.[0]).toEqual({ text: "eth0", param: true });
		expect(params(copy.detail)).toEqual(["eth0"]);
	});

	it("keeps a param value whole: never re-read as a placeholder, a stray NUL shown as a replacement mark", () => {
		const copy = copyOf("capture_input_lost", {
			name: "{name} \u0000 0",
			activeCamera: true,
		});
		expect(params(copy.detail)).toEqual(["{name} \uFFFD 0"]);
		expect(text(copy.detail)).toBe(
			fill(t.capture_input_lost.detail, { name: "{name} \uFFFD 0" }),
		);
	});

	it("formats numbers, sizes and durations in the active locale", () => {
		setLocale("de");
		expect(
			params(copyOf("disk_low", { freeBytes: 1.5 * 1024 ** 3 }).detail),
		).toEqual(["1,5 GB"]);
		expect(
			params(copyOf("bond_all_links_down", { linkCount: 1200 }).detail),
		).toEqual(["1.200"]);
		expect(
			params(copyOf("capture_standby_exited", { durationSec: 5400 }).detail),
		).toEqual(["1,5 Stunden"]);
		setLocale("ar");
		const arabic = copyOf("update_credentials_expiring", { id: "u", days: 7 });
		expect(params(arabic.detail)).toEqual([
			new Intl.NumberFormat("ar").format(7),
		]);
		expect(arabic.title).toBe(ar.timeline.update_credentials_expiring.title);
	});
});

describe("eventCopy — unknown and invalid records", () => {
	it("gives a code from a newer version the honest generic title, its family icon and the code only in diagnostics", () => {
		const copy = eventCopy(
			event(
				9,
				"from_the_future",
				{ secret: "token-1" },
				{ family: "network", severity: "error" },
			),
		);
		expect(copy.title).toBe(t.unknown.title);
		expect(text(copy.detail)).toBe(t.unknown.detail);
		expect(copy.glyph).toEqual({
			icon: Network,
			tone: "text-muted-foreground",
			label: t.family.network,
		});
		expect(copy.diagnostics).toEqual({ code: "from_the_future", values: [] });
		expect(
			JSON.stringify([copy.title, copy.detail, copy.glyph.label]),
		).not.toMatch(/from_the_future|token-1/);
	});

	it.each<[EventFamily, unknown]>([
		["stream", Radio],
		["network", Network],
		["cellular", SignalHigh],
		["update", Download],
		["device", Cpu],
		["capture", Video],
	])("shows the %s family icon for an unknown code", (family, icon) => {
		const copy = eventCopy(event(1, "later_code", {}, { family }));
		expect(copy.glyph.icon).toBe(icon);
		expect(copy.glyph.label).toBe(t.family[family]);
	});

	it("keeps a known code's title and drops its detail when a param has the wrong type", () => {
		const copy = copyOf("stream_stopped", { cause: 7, durationSec: "long" });
		expect(copy.title).toBe(t.stream_stopped.title);
		expect(copy.detail).toBeNull();
		expect(copy.diagnostics).toEqual({ code: "stream_stopped", values: [] });
		expect(copy.glyph.icon).toBe(TriangleAlert);
	});

	it("treats a param the registry does not declare as an invalid record, so it never renders", () => {
		const copy = copyOf("capture_source_lost", {
			name: "HDMI",
			serial: "SN-77",
		});
		expect(copy.detail).toBeNull();
		expect(copy.diagnostics).toEqual({
			code: "capture_source_lost",
			values: [],
		});
		expect(JSON.stringify(copy)).not.toContain("SN-77");
	});
});

describe("eventCopy — severity glyphs", () => {
	it.each([
		["error", CircleAlert, "text-status-error"],
		["warning", TriangleAlert, "text-status-warning"],
		["info", Info, "text-muted-foreground"],
		["success", CircleCheck, "text-status-success"],
	] as const)(
		"draws %s with its own shape, tone and name",
		(severity, icon, tone) => {
			const copy = eventCopy(event(1, "internet_lost", {}, { severity }));
			expect(copy.glyph).toEqual({
				icon,
				tone,
				label: en.systemLogs.severity[severity],
			});
		},
	);
});

describe("eventCopy — diagnostics hold the raw tokens the sentence does not show", () => {
	it.each<[string, DeviceEvent["params"], [string, string][]]>([
		[
			"stream_started",
			{ origin: "autostart", attemptId: "a1" },
			[["origin", "autostart"]],
		],
		[
			"stream_start_retrying",
			{ class: "start_timeout", phase: "hello", attempt: 1, maxAttempts: 2 },
			[
				["class", "start_timeout"],
				["phase", "hello"],
			],
		],
		[
			"stream_start_failed",
			{
				class: "engine_internal",
				phase: "start-rpc",
				attempt: 1,
				maxAttempts: 1,
			},
			[
				["class", "engine_internal"],
				["phase", "start-rpc"],
			],
		],
		[
			"stream_autostart_failed",
			{ reason: "config_invalid" },
			[["reason", "config_invalid"]],
		],
		[
			"link_down",
			{ iface: "wwan0", kind: "cellular", reason: "probe_failed" },
			[["kind", "cellular"]],
		],
		["link_degraded", { iface: "wwan0", kind: "wifi" }, [["kind", "wifi"]]],
		["link_up", { iface: "eth0", kind: "ethernet" }, [["kind", "ethernet"]]],
		["interface_added", { iface: "usb0", kind: "other" }, [["kind", "other"]]],
		[
			"interface_removed",
			{ iface: "usb0", kind: "cellular" },
			[["kind", "cellular"]],
		],
		["modem_added", { modemKey: MODEM, name: "EM12" }, [["modemKey", MODEM]]],
		["modem_removed", { modemKey: MODEM, name: "EM12" }, [["modemKey", MODEM]]],
		[
			"modem_connected",
			{ modemKey: MODEM, roaming: false },
			[["modemKey", MODEM]],
		],
		["modem_disconnected", { modemKey: MODEM }, [["modemKey", MODEM]]],
		[
			"modem_registration_rejected",
			{ modemKey: MODEM, rejection: "roaming_not_allowed" },
			[
				["modemKey", MODEM],
				["rejection", "roaming_not_allowed"],
			],
		],
		["sim_inserted", { modemKey: MODEM }, [["modemKey", MODEM]]],
		["sim_removed", { modemKey: MODEM }, [["modemKey", MODEM]]],
		[
			"update_installed",
			{ id: "u", packages: ["ceraui", "srtla"] },
			[["packages", "ceraui, srtla"]],
		],
		[
			"update_refused",
			{ id: "u", reason: "streaming" },
			[["reason", "streaming"]],
		],
		[
			"update_transport_unhealthy",
			{ id: "u", reasons: ["dns", "tls"] },
			[["reasons", "dns, tls"]],
		],
		[
			"update_failed",
			{ stage: "sync", reason: "rsync_exit_23" },
			[["reason", "rsync_exit_23"]],
		],
		[
			"previous_boot_unclean",
			{
				bootId: "b".repeat(32),
				evidence: ["no_shutdown_marker", "journal_cut"],
			},
			[["evidence", "no_shutdown_marker, journal_cut"]],
		],
		[
			"shutdown_requested",
			{ action: "reboot", origin: "remote" },
			[["origin", "remote"]],
		],
		["service_stopping", { signal: "SIGINT" }, [["signal", "SIGINT"]]],
		[
			"power_action_refused",
			{ reason: "update_running" },
			[["reason", "update_running"]],
		],
		[
			"hardware_identity_drift",
			{ detected: "rock5b", configured: "orangepi5" },
			[
				["detected", "rock5b"],
				["configured", "orangepi5"],
			],
		],
	])("%s", (code, values, expected) => {
		expect(copyOf(code, values).diagnostics).toEqual({
			code,
			values: expected,
		});
	});

	it("omits a raw param the record does not carry", () => {
		expect(copyOf("stream_started", {}).diagnostics).toBeNull();
	});

	it("has no disclosure for a code whose params the sentence fully shows", () => {
		expect(
			copyOf("stream_stopped", { cause: "operator", durationSec: 4 })
				.diagnostics,
		).toBeNull();
		expect(
			copyOf("capture_standby_exited", { durationSec: 4 }).diagnostics,
		).toBeNull();
	});
});

describe("eventTime", () => {
	it("gives the time of day for today and the date as well for an earlier day", () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(EVENT_AT + 2 * 60_000);
		const today = eventTime(EVENT_AT, "en");
		expect(today.iso).toBe(new Date(EVENT_AT).toISOString());
		expect(today.absolute).toBe(
			new Intl.DateTimeFormat("en", { timeStyle: "medium" }).format(EVENT_AT),
		);
		expect(today.relative).toBe("2 minutes ago");

		const yesterday = EVENT_AT - 24 * 60 * 60_000;
		const earlier = eventTime(yesterday, "de");
		expect(earlier.absolute).toBe(formatBootTime(yesterday, "de"));
		expect(earlier.relative).toBe(
			new Intl.RelativeTimeFormat("de", { numeric: "auto" }).format(-1, "day"),
		);
	});
});
