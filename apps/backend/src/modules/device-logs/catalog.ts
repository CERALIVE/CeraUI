import { LOG_SOURCES, type LogSource } from "@ceraui/rpc/schemas";
import { SENDER_LOG_PREFIX } from "../streaming/constants.ts";

const APP_UNIT = "ceralive.service";

export const SOURCE_UNITS: Readonly<Record<LogSource, readonly string[]>> = {
	app: [APP_UNIT],
	engine: ["cerastream.service"],
	bonding: ["srtla-send.service", "srtla.service"],
	network: [
		"NetworkManager.service",
		"wpa_supplicant.service",
		"ceralive-share.service",
		"ceralive-ingest-firewall.service",
		"ceralive-rtmp-gateway.service",
	],
	cellular: [
		"ModemManager.service",
		"ceralive-fcc-reconcile.service",
		"ceralive-dongle-netns-retire.service",
	],
	updates: [
		"rauc.service",
		"ceralive-software-update.service",
		"ceralive-slot-sync.service",
		"ceralive-healthcheck.service",
		"ceralive-rauc-activate.service",
		"ceralive-rauc-arm@now.service",
		"ceralive-rauc-arm@arm.service",
		"ceralive-os-stage-guard.service",
		"ceralive-dpkg-recover.service",
		"apt-daily.service",
		"apt-daily-upgrade.service",
		"ceralive-rauc-arm@.service",
	],
	device: [
		"kiosk.service",
		"ssh.service",
		"systemd-journald.service",
		"ceralive-addon-reconciler.service",
		"ceralive-boot-script-sync.service",
		"ceralive-ci-uart-bootstrap.service",
		"ceralive-cpu-governor.service",
		"ceralive-fan-curve.service",
		"ceralive-fan-kickstart.service",
		"ceralive-hdmirx-edid.service",
		"ceralive-led-status.service",
		"ceralive-partlabel-guard.service",
		"ceralive-portal@.service",
		"ceralive-provision.service",
		"ceralive-ssh-firstboot.service",
		"ceralive-tls-firstboot.service",
		"ceralive-typec-policy.service",
		"ceralive-typec-recheck.service",
		"cert-rotation-expiry.service",
		"cert-rotation.service",
		"rauc-hawkbit-updater.service",
		"ceralive-journal-gc.service",
		"ceralive-machine-id.service",
		"pipewire.service",
		"wireplumber.service",
	],
	kernel: [],
};

// Candidate units can overlap even though each entry has only one source.
export const JOURNAL_SOURCE_UNITS = {
	...SOURCE_UNITS,
	bonding: [APP_UNIT, ...SOURCE_UNITS.bonding],
} satisfies Readonly<Record<LogSource, readonly string[]>>;

export function sourceOfUnit(unit: string, message = ""): LogSource | null {
	if (unit === APP_UNIT && message.startsWith(SENDER_LOG_PREFIX))
		return "bonding";
	return (
		LOG_SOURCES.find((source) => SOURCE_UNITS[source].includes(unit)) ?? null
	);
}
