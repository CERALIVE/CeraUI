// @vitest-environment jsdom
import type { UpdateCapabilities, UpdateDetails } from "@ceraui/rpc/schemas";
import { afterEach, beforeEach, expect, it } from "vitest";

import {
	answer,
	CAPABLE,
	connectDevice,
	deviceDetails,
	disconnectDevice,
	FakeWebSocket,
	flush,
	reject,
	SETTINGS,
	sentCount,
} from "../../tests/helpers/update-device";
import { destroyAsyncOperations } from "../rpc/async-operation.svelte";
import { createUpdateSurface } from "./update-surface.svelte";

const capabilities: UpdateCapabilities = {
	...CAPABLE,
	features: [...CAPABLE.features, "kernel-apt-stage"],
};
const offered: UpdateDetails = {
	...deviceDetails(),
	kernel: {
		booted: {
			package: "linux-image-7.2.0-ceralive-rk3588",
			version: "7.2.0-ceralive1",
		},
		candidate: {
			package: "linux-image-7.2.0-ceralive-rk3588",
			version: "7.2.0-ceralive2",
			sizeBytes: 50_000_000,
		},
		state: null,
		version: null,
		reason: null,
	},
};

beforeEach(connectDevice);
afterEach(() => {
	destroyAsyncOperations();
	disconnectDevice();
});

async function open(caps = capabilities) {
	const surface = createUpdateSurface();
	const loading = surface.load();
	answer("system.getUpdateCapabilities", caps);
	answer("system.getUpdateSettings", SETTINGS);
	answer("system.getUpdateDetails", offered);
	await loading;
	return surface;
}

it("sends exactly one kernel-scoped install through the shared pending action", async () => {
	// Given a capable device with an offered kernel.
	const surface = await open();
	// When two clicks arrive before the first request settles.
	const first = surface.installKernel();
	const second = surface.installKernel();
	await flush();
	// Then only one exact scoped request is pending, never a legacy/unscoped call.
	expect(
		FakeWebSocket.log
			.filter((call) => call.path === "system.installUpdatesNow")
			.map((call) => call.input),
	).toEqual([{ scope: "kernel" }]);
	expect(sentCount("system.startUpdate")).toBe(0);
	expect(surface.pending("kernel")).toBe(true);
	answer("system.installUpdatesNow", { success: true });
	await flush();
	answer("system.getUpdateDetails", offered);
	await Promise.all([first, second]);
	expect(surface.pending("kernel")).toBe(false);
	expect(surface.bands).toEqual([]);
});

it.each([
	CAPABLE,
	{ mode: "legacy", features: ["kernel-apt-stage"] },
] satisfies UpdateCapabilities[])(
	"does not send a kernel action without a capable kernel declaration (%j)",
	async (caps) => {
		// Given otherwise valid kernel details but no capable feature declaration.
		const surface = await open(caps);
		// When a stale or programmatic action is invoked.
		const action = surface.installKernel();
		await flush();
		// Then the capability gate sends nothing.
		expect(sentCount("system.installUpdatesNow")).toBe(0);
		await action;
	},
);

it("a closed dialog cannot dispatch using its previous capability read", async () => {
	// Given a capable dialog whose session has ended.
	const surface = await open();
	surface.reset();
	// When an old callback runs, then it cannot dispatch on stale permission.
	const action = surface.installKernel();
	await flush();
	expect(sentCount("system.installUpdatesNow")).toBe(0);
	await action;
});

it("does not let unrelated OS evidence settle an uncertain kernel request", async () => {
	// Given a kernel request whose handler failed without establishing its outcome.
	const surface = await open();
	const install = surface.installKernel();
	await flush();
	reject("system.installUpdatesNow", "INTERNAL_ERROR");
	await flush();
	answer("system.getUpdateDetails", offered);
	await install;
	expect(surface.unconfirmed).toBe("kernel");
	// When an unrelated OS stage is reported, then the kernel outcome stays unknown.
	const osRead = surface.observePhase("os-staged");
	answer("system.getUpdateDetails", {
		...offered,
		os: { ...offered.os, staged: { version: "2026.10.76", stagedAt: 5_000 } },
	});
	await osRead;
	expect(surface.unconfirmed).toBe("kernel");
	// The kernel's own later phase settles it without claiming install success.
	const kernelRead = surface.observePhase("kernel-staging");
	answer("system.getUpdateDetails", offered);
	await kernelRead;
	expect(surface.unconfirmed).toBeUndefined();
	expect(surface.bands).toEqual([]);
});

it("reconciles a lost kernel result from a changed retained state on a fresh read", async () => {
	// Given a handler error and unchanged post-action details.
	const surface = await open();
	const install = surface.installKernel();
	await flush();
	reject("system.installUpdatesNow", "INTERNAL_ERROR");
	await flush();
	answer("system.getUpdateDetails", offered);
	await install;
	expect(surface.unconfirmed).toBe("kernel");
	// When a new details read reports the kernel staged at the same public phase.
	const refresh = surface.reloadDetails();
	answer("system.getUpdateDetails", {
		...offered,
		kernel: { ...offered.kernel, state: "staged", version: "7.2.0-ceralive2" },
	});
	await refresh;
	// Then the device record settles only this action.
	expect(surface.unconfirmed).toBeUndefined();
	expect(surface.bands).toEqual([]);
});

it("does not call a kernel stage Not started after its phase preceded a negative reply", async () => {
	// Given a kernel request still on the wire.
	const surface = await open();
	const install = surface.installKernel();
	await flush();
	// When the device publishes its start before replying negatively.
	const refresh = surface.observePhase("kernel-staging");
	answer("system.getUpdateDetails", offered);
	await refresh;
	answer("system.installUpdatesNow", {
		success: false,
		error: "not_available",
	});
	await flush();
	answer("system.getUpdateDetails", offered);
	await install;
	// Then no refusal contradicts the observed start.
	expect(surface.refusal).toBeUndefined();
	expect(surface.unconfirmed).toBeUndefined();
});
