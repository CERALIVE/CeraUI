import { expect, spyOn, test } from "bun:test";
import type { UpdateProgress } from "@ceraui/rpc";
import { withDeviceType } from "../modules/system/device-detection.ts";
import * as transaction from "../modules/system/software-update-process.ts";
import { aptEntryHarness } from "./helpers/apt-transport-entry-harness.ts";
import { sample } from "./helpers/apt-transport-fixture.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";

useSessionOwnerForFile();

const { t, install } = aptEntryHarness();
const preparing = { total: 0, downloading: 0, unpacking: 0, setting_up: 0 };
const downloading = { total: 1, downloading: 1, unpacking: 0, setting_up: 0 };
const installingAt = (percent: number) => ({
	total: 1,
	downloading: 0,
	unpacking: 0,
	setting_up: 1,
	percent,
});

// The board's timeline: an in-process pinned download (about 7 s on the Rock),
// then the unit, whose own download stage is a cache hit, then dpkg.
test("a pinned update names each phase from the start of its download", async () => {
	await withDeviceType("real", async () => {
		const { h, run } = await install([sample("eth0", "ethernet", 6)]);
		await using _h = h;
		const running = () =>
			h.frames.flatMap((frame) =>
				typeof frame.updating === "object" &&
				frame.updating &&
				frame.updating.result === undefined
					? [frame.updating]
					: [],
			);
		const seen: { moment: string; shown: UpdateProgress | undefined }[] = [];
		t.download = async () => {
			seen.push({ moment: "pinned download", shown: running().at(-1) });
			return {
				exitCode: 0,
				stdout:
					"Get:1 https://apt.invalid trixie/main arm64 cerastream 2 [48 MB]\n",
				stderr: "",
			};
		};
		spyOn(transaction, "runDetachedAptAll").mockImplementation(
			async (_args, _verdict, handlers) => {
				handlers.onStdout("Reading package lists...\n");
				handlers.onDrained?.();
				seen.push({ moment: "unit cache hit", shown: running().at(-1) });
				handlers.onStatus?.(
					"pmstatus:dpkg-exec:0.0000:Running dpkg\npmstatus:cerastream:40.0000:Unpacking cerastream\n",
				);
				handlers.onDrained?.();
				seen.push({ moment: "dpkg", shown: running().at(-1) });
				handlers.onStatus?.(
					"pmstatus:cerastream:35.0000:Processing triggers for man-db\n",
				);
				handlers.onDrained?.();
				seen.push({ moment: "estimate dips", shown: running().at(-1) });
				handlers.onStderr(
					"E: Sub-process /usr/bin/dpkg returned an error code (1)\n",
				);
				return 100;
			},
		);
		expect(running().at(-1)).toEqual(preparing);

		await run();
		await h.settled();

		expect(seen).toEqual([
			{ moment: "pinned download", shown: downloading },
			{ moment: "unit cache hit", shown: downloading },
			{ moment: "dpkg", shown: installingAt(40) },
			{ moment: "estimate dips", shown: installingAt(40) },
		]);
		expect(running().some((frame) => (frame.percent ?? 0) >= 100)).toBe(false);
		expect(h.frames.at(-1)?.update_state?.kind).toBe("failed");
	});
});
