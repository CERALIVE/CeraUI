import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { logger } from "../helpers/logger.ts";
import * as nm from "../modules/network/network-manager.ts";
import * as concurrent from "../modules/wifi/wifi-concurrent-interface.ts";
import { settlePending } from "../modules/wifi/wifi-hotspot-monitor.ts";
import { wifiRadioIdentity } from "../modules/wifi/wifi-radio-identity.ts";
import { hybridFixture } from "./helpers/wifi-hybrid-start.ts";

afterEach(() => {
	concurrent.resetConcurrentInterfaceDepsForTest();
	mock.restore();
});

for (const path of ["created Start", "borrowed Start", "borrowed release"]) {
	for (const outcome of [
		"restore-fails",
		"read-missing",
		"read-empty",
		"foreign-no",
		"foreign-yes",
	]) {
		test(`${path} compensating autoconnect diagnostics: ${outcome}`, async () => {
			const f = await hybridFixture(false, path !== "created Start");
			if (path === "created Start") {
				f.target.objects.delete("clap-wlan0");
				await concurrent.observeConcurrentInterfacesAtFirstDiscovery(
					[...f.target.objects.keys()],
					wifiRadioIdentity.state.rows,
				);
			}
			try {
				const release = path === "borrowed release";
				if (release) {
					expect(await f.start()).toEqual({ success: true });
					settlePending("wlan0", true);
				}
				const previous = release ? "no" : "yes";
				const written = release ? "yes" : "no";
				const metadata = {
					ifname: "clap-wlan0",
					previousAutoconnect: previous,
					writtenAutoconnect: written,
					reason: "identity-lost",
				};
				const warnings: unknown[][] = [];
				const errors: unknown[][] = [];
				spyOn(logger, "warn").mockImplementation((...args: unknown[]) => {
					warnings.push(args);
					return logger;
				});
				spyOn(logger, "error").mockImplementation((...args: unknown[]) => {
					errors.push(args);
					return logger;
				});
				const read = spyOn(nm, "nmDeviceProp").getMockImplementation();
				if (!read) throw new Error("Missing isolated device reader");
				let replaced = false;
				const compensationWrites: string[][] = [];
				spyOn(nm, "nmDeviceProp").mockImplementation(
					async (name, fields, mode) => {
						if (replaced && fields === "GENERAL.AUTOCONNECT") {
							if (outcome === "read-missing") return undefined;
							if (outcome === "read-empty") return [""];
						}
						return read(name, fields, mode);
					},
				);
				concurrent.setConcurrentInterfaceDepsForTest(
					async (command, args) => {
						if (command === "nmcli") {
							if (!replaced && args.at(-1) === written) {
								const leg = f.target.objects.get("clap-wlan0");
								if (!leg) throw new Error("Missing fixture leg");
								f.target.objects.set("clap-wlan0", {
									...leg,
									ifindex: 99,
									wdev: "0x99",
								});
								f.target.externalAutoconnect(
									outcome === "foreign-no" ? "no" : "yes",
								);
								replaced = true;
							} else if (replaced && args.at(-1) === previous) {
								compensationWrites.push([command, ...args]);
								if (outcome === "restore-fails")
									throw new Error("SYNTHETIC_COMPENSATION_SECRET");
							}
						}
						return f.target.run(command, args);
					},
					async () => true,
				);
				f.effects.length = 0;
				const result = release ? await f.stop() : await f.start();
				expect(result).toEqual(
					release
						? { success: true }
						: {
								success: false,
								error: "activation-failed",
								reason: "hybrid-channel-not-permitted",
							},
				);
				if (!release) expect(f.effects).toEqual([]);
				const unreadable =
					outcome === "read-missing" || outcome === "read-empty";
				expect(replaced).toBe(true);
				expect(compensationWrites).toEqual(
					unreadable
						? []
						: [
								[
									"nmcli",
									"device",
									"set",
									"clap-wlan0",
									"autoconnect",
									previous,
								],
							],
				);
				expect(f.target.autoconnect()).toBe(
					unreadable || outcome === "restore-fails" ? written : previous,
				);
				expect(
					warnings.filter(
						([message]) =>
							message === "Wi-Fi hybrid autoconnect compensating restore",
					),
				).toEqual(
					unreadable
						? []
						: [["Wi-Fi hybrid autoconnect compensating restore", metadata]],
				);
				expect(errors).toEqual(
					outcome === "restore-fails"
						? [
								[
									"Wi-Fi hybrid autoconnect compensating restore failed",
									metadata,
								],
							]
						: unreadable
							? [
									[
										"Wi-Fi hybrid autoconnect compensation read unavailable",
										metadata,
									],
								]
							: [],
				);
				expect(JSON.stringify([...warnings, ...errors])).not.toContain(
					"SYNTHETIC_COMPENSATION_SECRET",
				);
				expect(f.target.objects.get("clap-wlan0")?.wdev).toBe("0x99");
				expect(f.target.objects.get("clap-sentinel")?.wdev).toBe("0x8");
				expect(f.target.calls.filter((args) => args.at(-1) === "del")).toEqual(
					[],
				);
				expect(f.row.conn).toBe("station-uuid");
			} finally {
				await f.restore();
			}
		});
	}
}
