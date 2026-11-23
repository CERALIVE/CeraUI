import { spyOn } from "bun:test";
import * as concurrent from "../../modules/wifi/wifi-concurrent-interface.ts";
import { wifiRadioIdentity } from "../../modules/wifi/wifi-radio-identity.ts";
import { targetFixture } from "./wifi-hybrid-target.ts";

/** Add the current card/station/phy evidence around the legacy per-test target driver. */
export async function limitedHybridFixture() {
	const kernel = await targetFixture({
		parentIfindex: 3,
		permanentMac: null,
		existing: true,
		associateRow: false,
	});
	const parent = kernel.objects.get("wlan0");
	if (!parent) throw new Error("Missing limited fixture parent");
	const phy = parent.phy;
	let connected = false;
	let creationScenario = false;
	const select = concurrent.selectConcurrentApInterface;
	spyOn(concurrent, "selectConcurrentApInterface").mockImplementation(
		(parent, admitted, createMissing, onRefusal, limitedRestore) =>
			creationScenario
				? concurrent.ensureConcurrentApInterface(
						parent,
						admitted,
						undefined,
						undefined,
						limitedRestore,
					)
				: select(parent, admitted, createMissing, onRefusal, limitedRestore),
	);
	const install = concurrent.setConcurrentInterfaceDepsForTest;
	spyOn(concurrent, "setConcurrentInterfaceDepsForTest").mockImplementation(
		(targetRun, waiter) => {
			if (!targetRun) {
				install(targetRun, waiter);
				return;
			}
			creationScenario = true;
			install(async (command, args) => {
				const targetRead =
					command === "iw" &&
					args.at(-1) === "info" &&
					(args[1] === "clap-wlan0" || args[0] === "wdev");
				const mutation =
					command === "iw" && (args.includes("add") || args.at(-1) === "del");
				if (!targetRead && !mutation) return kernel.run(command, args);
				let output: string;
				try {
					output = await targetRun(command, args);
				} catch (error) {
					if (!(error instanceof Error)) throw error;
					if (targetRead) kernel.objects.delete("clap-wlan0");
					throw error;
				}
				if (args.includes("add")) {
					kernel.objects.set("clap-wlan0", {
						ifindex: 7,
						wdev: "0x7",
						type: "managed",
						phy,
					});
				} else if (args.at(-1) === "del") {
					kernel.objects.delete("clap-wlan0");
				} else {
					const ifindex = /^\s*ifindex\s+(\d+)/m.exec(output)?.[1];
					const wdev = /^\s*wdev\s+(0x[0-9a-f]+)/m.exec(output)?.[1];
					const type = /^\s*type\s+(.+)/m.exec(output)?.[1];
					if (ifindex && wdev && type)
						kernel.objects.set("clap-wlan0", {
							ifindex: Number(ifindex),
							wdev,
							type,
							phy,
						});
					if (connected) output = output.replace(/type managed/, "type AP");
					if (!/^\s*wiphy\s/m.test(output)) output += "\n wiphy 0\n";
					if (!/^\s*channel\s/m.test(output))
						output += "\n channel 1 (2412 MHz)\n";
				}
				return output;
			}, waiter);
		},
	);
	return {
		calls: kernel.calls,
		observeParent: kernel.observeParent,
		permanent: kernel.permanent,
		roam: () => kernel.station("new-station"),
		replaceParent: () => {
			kernel.objects.set("wlan0", { ...parent, ifindex: 34, wdev: "0x34" });
		},
		replaceLeg: () => {
			const current = kernel.objects.get("clap-wlan0");
			if (!current) throw new Error("Missing AP leg");
			kernel.objects.set("clap-wlan0", {
				...current,
				ifindex: 29,
				wdev: "0x29",
			});
		},
		cold: async () => {
			kernel.objects.delete("clap-wlan0");
			concurrent.resetConcurrentInterfaceDepsForTest();
			install(
				kernel.run,
				async () => true,
				async () => "fixture-boot",
			);
			await kernel.observeParent();
			await concurrent.observeConcurrentInterfacesAtFirstDiscovery(
				[...kernel.objects.keys()],
				wifiRadioIdentity.state.rows,
			);
		},
		created: () => {
			kernel.objects.set("clap-wlan0", {
				ifindex: 7,
				wdev: "0x7",
				type: "managed",
				phy,
			});
		},
		connected: (uuid: string) => {
			connected = true;
			const target = kernel.objects.get("clap-wlan0");
			if (target) target.type = "AP";
			kernel.state("100 (connected)");
			kernel.active(uuid);
		},
		disconnected: () => {
			connected = false;
			const target = kernel.objects.get("clap-wlan0");
			if (target) target.type = "managed";
			kernel.state("30 (disconnected)");
			kernel.active("");
		},
	};
}
