import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddonDescriptorSchema } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";
import { UplinkShaperApplier } from "../modules/network/uplink-shaper/applier.ts";
import * as sharing from "../modules/network/uplink-sharing.ts";
import * as steering from "../modules/network/uplink-steering/state-builder.ts";
import * as lifecycle from "../modules/streaming/stream-lifecycle-status.ts";
import * as detection from "../modules/system/device-detection.ts";
import {
	installAddonProcedure,
	resetAddonProcedureDeps,
	setAddonProcedureDeps,
} from "../rpc/procedures/addons.procedure.ts";
import type { RPCContext } from "../rpc/types.ts";

let root: string;
const restores: (() => void)[] = [];
const openSync = fs.openSync;
const readDir = fsp.readdir;
const bunFile = Bun.file;
beforeEach(() => {
	root = fs.mkdtempSync(join(tmpdir(), "metadata-effects-"));
	fs.mkdirSync(join(root, "run/ceralive"), { recursive: true });
	fs.mkdirSync(join(root, "usr/share/ceralive/addons"), { recursive: true });
	const open = spyOn(fs, "openSync").mockImplementation((path, flags, mode) =>
		openSync(path === "/" ? root : path, flags, mode),
	);
	const files = spyOn(Bun, "file").mockImplementation((path, options) => {
		if (typeof path === "string")
			return bunFile(
				path.startsWith("/run/ceralive/") ||
					path.startsWith("/usr/share/ceralive/addons/")
					? join(root, path)
					: path,
				options,
			);
		if (typeof path === "number") return bunFile(path, options);
		if (path instanceof URL) return bunFile(path, options);
		return bunFile(path, options);
	});
	const directory = spyOn(fsp, "readdir").mockImplementation(
		new Proxy(readDir, {
			apply(target, receiver, args) {
				const mapped =
					args[0] === "/usr/share/ceralive/addons"
						? [join(root, args[0]), ...args.slice(1)]
						: args;
				return Reflect.apply(target, receiver, mapped);
			},
		}),
	);
	restores.push(
		() => open.mockRestore(),
		() => files.mockRestore(),
		() => directory.mockRestore(),
	);
});
afterEach(() => {
	resetAddonProcedureDeps();
	for (const restore of restores.splice(0)) restore();
	fs.rmSync(root, { recursive: true, force: true });
});

test("ambiguous ownership permits zero shaper teardown commands, including retry", async () => {
	// Given a contradictory stored root and empty current sharing topology.
	fs.writeFileSync(
		join(root, "run/ceralive/uplink-shaper-roots.json"),
		'{"eth0":{"kind":"fq_codel","handle":"0:"},"eth0":{"kind":"noqueue","handle":"0:"}}',
	);
	let commands = 0;
	const real = spyOn(detection, "isRealDevice").mockResolvedValue(true);
	const desired = spyOn(steering, "readDesiredSteeringState").mockResolvedValue(
		{ clientZones: [], uplinks: [], routes: [] },
	);
	const effects = spyOn(sharing, "applyTrafficControl").mockImplementation(
		async () => {
			commands++;
			return "";
		},
	);
	const live = spyOn(lifecycle, "getStreamLifecycleState").mockReturnValue(
		"streaming",
	);
	restores.push(
		() => real.mockRestore(),
		() => desired.mockRestore(),
		() => effects.mockRestore(),
		() => live.mockRestore(),
	);
	const runtime = await import(
		`../modules/network/uplink-shaper/runtime.ts?authority=${encodeURIComponent(root)}`
	);
	// When production apply observes the file twice after a refusal.
	await runtime.initUplinkShaper();
	await runtime.tickUplinkShaper();
	// Then neither last-wins roots nor a cached loaded flag authorize tc.
	expect(commands).toBe(0);
});

test("ambiguous baked descriptor grants zero add-on install effects", async () => {
	// Given a descriptor whose real compatibility requirement is contradictory.
	const fixturePath = new URL(
		"../../tests/fixtures/addons/test-addon-a.json",
		import.meta.url,
	).pathname;
	const fixture = AddonDescriptorSchema.parse(
		JSON.parse(fs.readFileSync(fixturePath, "utf8")),
	);
	const id: string = fixture.id;
	const bytes = `${JSON.stringify(fixture).slice(0, -1)},"compatibleHardware":["generic"]}`;
	fs.writeFileSync(join(root, "usr/share/ceralive/addons/record.json"), bytes);
	let grants = 0;
	setAddonProcedureDeps({
		isRealDevice: async () => true,
		getEffectiveHardware: () => "generic",
		getAddonState: () => undefined,
		enableAddon: async () => {
			grants++;
			return { success: true, phase: "enabled" };
		},
	});
	// The RPC context is a transport fixture; the descriptor reader remains real.
	const context = {
		isAuthenticated: () => true,
		markActive: () => {},
	} as RPCContext;
	// When the real installer RPC resolves its default descriptor reader.
	await call(installAddonProcedure, { id }, { context });
	// Then contradictory metadata is not an install capability.
	expect(grants).toBe(0);
	expect(
		fs.readFileSync(
			join(root, "usr/share/ceralive/addons/record.json"),
			"utf8",
		),
	).toBe(bytes);
});

test("a failed ownership read is not cached as loaded teardown authority", async () => {
	// Given an unreadable ownership file on every read.
	let commands = 0;
	const applier = new UplinkShaperApplier({
		readRecordedRoots: async () => {
			throw new Error("unreadable");
		},
		readRoot: async () => ({ kind: "fq_codel", handle: "0:" }),
		readBacklog: async () => 0,
		runTc: async () => {
			commands++;
		},
	});
	const request = {
		mode: "idle",
		uplinks: [{ ifname: "eth0", mark: 1, capBps: 1_000_000 }],
	} as const;
	await expect(applier.apply(request)).rejects.toThrow();
	// When the same production applier is asked to apply again.
	await expect(applier.apply(request)).rejects.toThrow();
	// Then no default inventory or plan can act on unproven ownership.
	expect(commands).toBe(0);
});
