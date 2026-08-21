import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { modemMutationAdmissionPort } from "../modules/modems/mutation-admission-port.ts";
import {
	resetLifecycleInterlock,
	tryAcquireLifecycle,
} from "../modules/streaming/lifecycle-admission.ts";

const BACKEND_ROOT = join(import.meta.dir, "..");

const MIGRATED_MODULES = [
	"modules/modems/usb-mode-identity.ts",
	"modules/modems/sim-presence.ts",
	"modules/modems/five-g-preference.ts",
	"modules/modems/physical-identity.ts",
	"modules/modems/modem-identity.ts",
	"modules/cellular/dbus-mm-enums.ts",
	"modules/cellular/shadow-divergence.ts",
	"modules/network/router-details.ts",
	"modules/network/hilink-documents.ts",
	"modules/network/router-capabilities.ts",
	"modules/network/usb-net-classifier.ts",
	"modules/network/router-signal-model.ts",
	"modules/network/router-signal.ts",
	"modules/network/vendor-xml.ts",
] as const;

const TRANSPORT_KEEP_ALLOWLIST = new Set([
	"modules/cellular/cellular-stack.ts",
	"modules/cellular/dbus-audit-transport.ts",
	"modules/cellular/dbus-backend.ts",
	"modules/cellular/dbus-mm-enums.ts",
	"modules/cellular/dbus-modem-cache.ts",
	"modules/cellular/dbus-view-fold.ts",
	"modules/cellular/shadow-divergence.ts",
	"modules/cellular/shadow-evidence.ts",
	"modules/cellular/shadow-redaction.ts",
	"modules/cellular/shadow-wiring.ts",
	"modules/cellular/shadow.ts",
	"modules/cellular/udev-monitor.ts",
	"modules/cellular/udev-provisional-cache.ts",
	"modules/modems/band-capability.ts",
	"modules/modems/band-lock.ts",
	"modules/modems/band-mmcli.ts",
	"modules/modems/band-rollback.ts",
	"modules/modems/capability-evidence.ts",
	"modules/modems/fcc-unlock.ts",
	"modules/modems/five-g-apply.ts",
	"modules/modems/five-g-preference.ts",
	"modules/modems/gps.ts",
	"modules/modems/mmcli-location.ts",
	"modules/modems/mmcli-sms.ts",
	"modules/modems/mmcli-sms.test.ts",
	"modules/modems/mmcli-ussd.ts",
	"modules/modems/mmcli.parsers.test.ts",
	"modules/modems/mmcli.ts",
	"modules/modems/modem-identity.test.ts",
	"modules/modems/modem-identity.ts",
	"modules/modems/modem-network-scan.ts",
	"modules/modems/modem-registration.ts",
	"modules/modems/modem-status.ts",
	"modules/modems/modem-update-loop.ts",
	"modules/modems/modem-wire-adapters.ts",
	"modules/modems/modem-wire-producer.ts",
	"modules/modems/modem-wire-projection.ts",
	"modules/modems/modems-state.ts",
	"modules/modems/modems.ts",
	"modules/modems/mutation-identity.ts",
	"modules/modems/physical-identity.ts",
	"modules/modems/sim-pin2.ts",
	"modules/modems/sim-autounlock.ts",
	"modules/modems/sim-presence.ts",
	"modules/modems/sms-port.ts",
	"modules/modems/state/modems-state-cache.ts",
	"modules/modems/transition-ports.ts",
	"modules/modems/usb-mode-identity.ts",
	"modules/modems/usb-mode-transition.ts",
	"modules/modems/ussd-session.ts",
	"modules/modems/ussd.ts",
	"modules/network/hilink-documents.ts",
	"modules/network/hilink-session.ts",
	"modules/network/monitor/mock-monitor.ts",
	"modules/network/monitor/monitor-manager.ts",
	"modules/network/network-ingest.ts",
	"modules/network/policy-route-check.ts",
	"modules/network/router-cellular-admin.ts",
	"modules/network/router-cellular-control.ts",
	"modules/network/router-details.ts",
	"modules/network/router-signal-model.ts",
	"modules/network/router-signal.ts",
	"modules/network/router-subnet-hygiene.ts",
	"modules/network/router-subnet-rollback.ts",
]);

function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|[^:])\/\/.*$/gm, "$1");
}

async function typeScriptFiles(directory: string): Promise<readonly string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const nested = await Promise.all(
		entries.map(async (entry) => {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) return typeScriptFiles(path);
			return entry.isFile() && path.endsWith(".ts") ? [path] : [];
		}),
	);
	return nested.flat();
}

describe("modem-control compatibility projections", () => {
	test("all fourteen frozen MIGRATE modules route through the package seam", async () => {
		for (const module of MIGRATED_MODULES) {
			const source = await Bun.file(join(BACKEND_ROOT, module)).text();
			expect(source, module).toContain("modem-control-compat.ts");
		}
	});

	test("the EXACT 1.1.0 pin imports every projection", async () => {
		// A bare version, never a range: the SMS port, usage-policy setter and
		// band catalog are STATIC imports with no runtime probe behind them, so a
		// `^`/`~` that resolved a release missing any of them fails at import
		// instead of degrading.
		const packageJson = await Bun.file(
			join(BACKEND_ROOT, "..", "package.json"),
		).json();
		expect(packageJson.dependencies["@ceralive/modem-control"]).toBe("1.1.0");
		for (const module of MIGRATED_MODULES) {
			await expect(import(join(BACKEND_ROOT, module))).resolves.toBeDefined();
		}
	});

	test("direct modem transports remain confined to the frozen KEEP boundary", async () => {
		const files = (
			await Promise.all(
				["modems", "cellular", "network"].map((area) =>
					typeScriptFiles(join(BACKEND_ROOT, "modules", area)),
				),
			)
		).flat();
		const unexpected: string[] = [];
		const transportAccess = /dbus|mmcli|qmicli|goform|hilink/;
		for (const file of files) {
			const source = stripComments(await Bun.file(file).text());
			if (!transportAccess.test(source)) continue;
			const path = relative(BACKEND_ROOT, file);
			if (!TRANSPORT_KEEP_ALLOWLIST.has(path)) unexpected.push(path);
		}
		expect(unexpected).toEqual([]);
	});

	test("a stream-active package mutation is refused in the existing vocabulary", async () => {
		resetLifecycleInterlock();
		const streaming = tryAcquireLifecycle("streaming");
		expect(streaming.admitted).toBe(true);
		const result = await modemMutationAdmissionPort.acquire({
			operationId: "set-radio-modes",
			physicalModemId: "serial:fixture",
			impact: "disruptive",
			requirement: { required: true },
		});
		expect(result).toEqual({
			status: "refused",
			reason: "admission-refused",
			detail: "streaming_active",
		});
		if (streaming.admitted) streaming.lease.release();
		resetLifecycleInterlock();
	});
});
