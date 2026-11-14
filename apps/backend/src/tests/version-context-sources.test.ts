import { expect, spyOn, test } from "bun:test";
import { once } from "node:events";
import { release } from "node:os";
import {
	clearRecentLogLines,
	getRecentLogLines,
	logger,
} from "../helpers/logger.ts";
import { getMockState, updateMockState } from "../mocks/mock-service.ts";
import {
	currentBootId,
	normalizeBootId,
} from "../modules/device-logs/boot-id.ts";
import {
	getRevisions,
	initRevisions,
	setEngineVersionProbe,
} from "../modules/system/revisions.ts";
import {
	collectVersionContext,
	defaultVersionContextDeps,
	logBootRecord,
} from "../modules/system/version-context.ts";
import { deps } from "./helpers/version-context-fixtures.ts";
import { versionSourceHarness } from "./helpers/version-context-sources.ts";

test("initRevisions publishes every completed running source before resolving", async () => {
	await using source = await versionSourceHarness();
	await source.write(source.paths.version, "2026.11.4\n");
	await source.write(source.paths.build, "next-build\n");
	await source.write(source.paths.sender, "sender-initialized\n");
	source.setEngine("engine-initialized");
	for (const key of Object.keys(getRevisions())) delete getRevisions()[key];

	await initRevisions();
	expect(getRevisions().srtla).toBe("sender-initialized");
	expect(getRevisions()).toMatchObject({
		ceralive: "2026.11.4 (next-build)",
		cerastream: "engine-initialized",
		kernel: release(),
		bun: Bun.version,
	});
});

test("initRevisions stays pending until the engine source completes", async () => {
	const snapshot = { ...getRevisions() };
	const legacy = Bun.file("/etc/ceralive_img_version");
	const text = spyOn(legacy, "text").mockResolvedValue("2026.10.9");
	const files = spyOn(Bun, "file").mockReturnValue(legacy);
	const started = Promise.withResolvers<void>();
	const engine = Promise.withResolvers<string>();
	setEngineVersionProbe(() => {
		started.resolve();
		return engine.promise;
	});
	delete getRevisions().cerastream;
	let settled = false;
	const initializing = initRevisions({
		readVersionStamp: async () => "2026.11.3",
		readBuildStamp: async () => "running-build",
	}).then(() => {
		settled = true;
	});
	try {
		await started.promise;
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(settled).toBe(false);
		engine.resolve("completed-engine");
		await initializing;
		expect(getRevisions().cerastream).toBe("completed-engine");
	} finally {
		engine.resolve("completed-engine");
		await initializing;
		files.mockRestore();
		text.mockRestore();
		setEngineVersionProbe(null);
		for (const key of Object.keys(getRevisions())) delete getRevisions()[key];
		Object.assign(getRevisions(), snapshot);
	}
});

test("default adapters resolve the actual kernel, revisions, OS, model and executable stdout", async () => {
	await using source = await versionSourceHarness();
	expect(source.initialized).toMatchObject({
		ceralive: "2026.11.3 (running-build)",
		cerastream: "engine-before",
		srtla: "sender-before",
		kernel: release(),
		bun: Bun.version,
	});
	const kernelId = (
		await Bun.file("/proc/sys/kernel/random/boot_id").text()
	).trim();
	const expectedBootId = kernelId.replaceAll("-", "").toLowerCase();
	expect(currentBootId()).toBe(expectedBootId);
	expect(await collectVersionContext()).toEqual({
		bootId: expectedBootId,
		ceraui: "2026.11.3 (running-build)",
		osImage: "2026.11.50",
		slot: "B",
		board: "board",
		boardModel: "Model one",
		engine: "engine-before",
		senderVersion: "sender-before",
		kernel: release(),
		bun: Bun.version,
	});
});

test("collection refreshes the real revisions owner after engine and sender upgrades", async () => {
	await using source = await versionSourceHarness();
	expect((await collectVersionContext()).engine).toBe("engine-before");
	source.setEngine("engine-after");
	await source.write(source.paths.sender, "sender-after\n");
	const next = await collectVersionContext();
	expect(next.engine).toBe("engine-after");
	expect(next.senderVersion).toBe("sender-after");
	expect(source.probes()).toBe(3);
});

test("an unreachable real engine clears the prior context version", async () => {
	await using source = await versionSourceHarness();
	await collectVersionContext();
	source.setEngine(undefined);
	expect((await collectVersionContext()).engine).toBeNull();
});

test("collection waits for the real asynchronous version probe", async () => {
	await using source = await versionSourceHarness();
	let releaseProbe: (value: string) => void = () => {};
	const probe = new Promise<string>((resolve) => {
		releaseProbe = resolve;
	});
	setEngineVersionProbe(() => probe);
	let settled = false;
	const collecting = collectVersionContext({
		...deps(),
		revisions: defaultVersionContextDeps.revisions,
	}).then((context) => {
		settled = true;
		return context;
	});
	try {
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(settled).toBe(false);
	} finally {
		releaseProbe("deferred-engine");
	}
	expect((await collecting).engine).toBe("deferred-engine");
});

test("the real mock gate skips live component and hardware probes", async () => {
	await using source = await versionSourceHarness();
	const initialized = getMockState().initialized;
	const commands = source.commands();
	process.env.NODE_ENV = "development";
	updateMockState({ initialized: true });
	try {
		const context = await collectVersionContext();
		expect(context.slot).toBe("A");
		expect(context.engine).toBeNull();
		expect(context.senderVersion).toBeNull();
		expect(source.probes()).toBe(1);
		expect(source.commands()).toBe(commands);
	} finally {
		updateMockState({ initialized });
	}
});

test("boot recording collects once and emits exactly one serialized startup record", async () => {
	await using source = await versionSourceHarness();
	const ring = logger.transports.find(
		(item) => item.constructor.name === "Stream",
	);
	if (!ring) throw new Error("missing logger ring");
	const logged = once(ring, "logged", { signal: AbortSignal.timeout(2000) });
	clearRecentLogLines();
	await logBootRecord();
	await logged;
	const records = getRecentLogLines()
		.map((line) => JSON.parse(line))
		.filter((entry) => entry.msg === "device started");
	expect(records).toHaveLength(1);
	expect(records[0].meta.versions.engine).toBe("engine-before");
	expect(records[0].meta.versions.senderVersion).toBe("sender-before");
	expect(source.probes()).toBe(2);
});

test.each([undefined, "malformed", "", " \n", "unreadable"])(
	"default validated OS reader falls back for %j",
	async (value) => {
		await using source = await versionSourceHarness();
		await source.write(source.paths.os, value);
		expect((await collectVersionContext()).osImage).toBe("2026.10.9");
	},
);

test.each([undefined, "", " \n", "unreadable"])(
	"default legacy OS reader reports null for %j",
	async (value) => {
		await using source = await versionSourceHarness();
		await source.write(source.paths.os, undefined);
		await source.write(source.paths.legacy, value);
		expect((await collectVersionContext()).osImage).toBeNull();
	},
);

test("default legacy OS reader trims a readable fallback", async () => {
	await using source = await versionSourceHarness();
	await source.write(source.paths.os, undefined);
	await source.write(source.paths.legacy, " 2026.9.1 \n");
	expect((await collectVersionContext()).osImage).toBe("2026.9.1");
});

test.each([undefined, "", " \n", "unreadable"])(
	"default model reader reports null for %j",
	async (value) => {
		await using source = await versionSourceHarness();
		await source.write(source.paths.model, value);
		expect((await collectVersionContext()).boardModel).toBeNull();
	},
);

test.each([undefined, "", " \n", "unreadable", "not JSON", "null"])(
	"default RAUC adapter reports unknown identity for %j",
	async (value) => {
		await using source = await versionSourceHarness();
		await source.write(source.paths.rauc, value);
		const context = await collectVersionContext();
		expect(context.slot).toBeNull();
		expect(context.board).toBeNull();
	},
);

test("default sources observe OS, slot and model changes between collections", async () => {
	await using source = await versionSourceHarness();
	await collectVersionContext();
	await source.write(source.paths.os, "2026.11.51\n");
	await source.write(source.paths.rauc, '{"booted":"A","compatible":"x"}');
	await source.write(source.paths.model, "Second\0 model\0");
	expect(await collectVersionContext()).toMatchObject({
		osImage: "2026.11.51",
		slot: "A",
		board: "x",
		boardModel: "Second model",
	});
});

test.each([undefined, "", " \n", "unreadable"])(
	"unreadable live sender is unknown: %j",
	async (value) => {
		await using source = await versionSourceHarness();
		await source.write(source.paths.sender, value);
		expect((await collectVersionContext()).senderVersion).toBeNull();
	},
);

test("boot ID character classes reject x rather than admitting non-hex IDs", () => {
	expect(normalizeBootId("x6d8d1808694489b8c3a3fb4795cab24")).toBeUndefined();
});

test.each([..."0123456789abcdef"])(
	"boot IDs admit every hexadecimal digit: %s",
	(character) => {
		expect(normalizeBootId(character.repeat(32))).toBe(character.repeat(32));
	},
);

test.each([..."ghijklmnopqrstuvwxyz_! \n\0"])(
	"boot IDs reject non-hexadecimal characters: %j",
	(character) => {
		expect(
			normalizeBootId(`${character}6d8d1808694489b8c3a3fb4795cab24`),
		).toBeUndefined();
	},
);
