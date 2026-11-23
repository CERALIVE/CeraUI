import { afterEach, expect, mock, test } from "bun:test";
import * as concurrent from "../modules/wifi/wifi-concurrent-interface.ts";
import { ensureConcurrentApInterface } from "../modules/wifi/wifi-concurrent-interface-creation.ts";
import orangeIw from "./fixtures/wifi/iw-6.9-orange-created-leg.json";
import { iwCreationReceipt } from "./helpers/iw-creation-receipt.ts";
import { targetFixture } from "./helpers/wifi-hybrid-target.ts";

afterEach(() => {
	concurrent.resetConcurrentInterfaceDepsForTest();
	mock.restore();
});

async function coldOrangeFixture(failByName = false) {
	// The netlink creation receipt, NM interaction and radio lifetime are modeled.
	const fixture = await targetFixture({ existing: false });
	const reads: string[][] = [];
	concurrent.setConcurrentInterfaceDepsForTest(
		async (command, args) => {
			const query = args.join(" ");
			if (command === "iw" && query === "wdev 0x6 info") {
				reads.push(args);
				throw Object.assign(new Error("iw exited nonzero"), {
					code: orangeIw.byWdev.exitCode,
					stdout: orangeIw.byWdev.stdout,
				});
			}
			const output = await fixture.run(command, args);
			if (command === "iw" && args.includes("add")) {
				const leg = fixture.objects.get("clap-wlan0");
				if (!leg) throw new Error("Missing modeled creation");
				Object.assign(leg, { ifindex: 8, wdev: "0x6" });
				return iwCreationReceipt("clap-wlan0", 8, "0x6");
			}
			if (command === "iw" && query === "dev clap-wlan0 info") {
				reads.push(args);
				if (failByName)
					throw Object.assign(new Error("Modeled read failure"), { code: 1 });
				if (orangeIw.byName.exitCode === 0) return orangeIw.byName.stdout;
			}
			return output;
		},
		async () => true,
	);
	return { fixture, reads };
}

test("Orange Pi iw 6.9 identifies the new leg throughout cold selection", async () => {
	const { fixture, reads } = await coldOrangeFixture();
	const refused = mock(() => {});
	expect(
		await concurrent.selectConcurrentApInterface(
			"wlan0",
			undefined,
			true,
			refused,
		),
	).toEqual({ ifname: "clap-wlan0", created: true, type: "managed" });
	expect(refused).not.toHaveBeenCalled();
	expect(reads.length).toBeGreaterThan(1);
	expect(reads.every((args) => args.join(" ") === "dev clap-wlan0 info")).toBe(
		true,
	);
	expect(fixture.objects.get("wlan0")?.wdev).toBe("0x1");
});

test("an initial nonzero iw exit is classified separately from an identity mismatch", async () => {
	const { fixture } = await coldOrangeFixture(true);
	const refused = mock((_reason: string) => {});
	expect(
		await ensureConcurrentApInterface("wlan0", undefined, undefined, refused),
	).toBeUndefined();
	expect(refused.mock.calls).toEqual([["created-identity-query-failed"]]);
	expect(fixture.calls).toContainEqual(["iw", "wdev", "0x6", "del"]);
	expect(fixture.objects.get("wlan0")?.wdev).toBe("0x1");
});
