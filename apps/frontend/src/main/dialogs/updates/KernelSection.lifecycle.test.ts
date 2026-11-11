// @vitest-environment jsdom
import type {
	UpdateDetails,
	UpdateOrchestratorWireState,
} from "@ceraui/rpc/schemas";
import { cleanup, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { destroyAsyncOperations } from "../../../lib/rpc/async-operation.svelte";
import { createUpdateSurface } from "../../../lib/updates/update-surface.svelte";
import {
	answer,
	CAPABLE,
	connectDevice,
	deviceDetails,
	disconnectDevice,
	dropLink,
	reject,
	restoreLink,
	SETTINGS,
} from "../../../tests/helpers/update-device";
import KernelSection from "./KernelSection.svelte";

const caps = {
	...CAPABLE,
	features: [...CAPABLE.features, "kernel-apt-stage"],
};
const previousKernel: NonNullable<UpdateDetails["kernel"]> = {
	booted: {
		package: "linux-image-7.2.0-ceralive-rk3588",
		version: "7.2.0-ceralive2",
	},
	candidate: null,
	state: "succeeded",
	version: "7.2.0-ceralive2",
	reason: null,
};
const previous: UpdateDetails = {
	...deviceDetails(),
	kernel: previousKernel,
};
const failed: UpdateDetails = {
	...previous,
	kernel: {
		...previousKernel,
		state: "failed",
		version: "7.2.0-ceralive3",
		reason: "kernel_download_failed",
	},
};
const wire: UpdateOrchestratorWireState = {
	schema: 1,
	phase: "idle",
	failure_reason: null,
	progress: null,
	cellular_override_id: null,
};
const props = {
	wire,
	ready: true,
	checking: false,
	installing: false,
	onCheck: vi.fn(),
	onInstall: vi.fn(),
};

beforeEach(connectDevice);
afterEach(() => {
	cleanup();
	destroyAsyncOperations();
	disconnectDevice();
});

async function openPrevious() {
	const surface = createUpdateSurface();
	const loading = surface.load();
	answer("system.getUpdateCapabilities", caps);
	answer("system.getUpdateSettings", SETTINGS);
	answer("system.getUpdateDetails", previous);
	await loading;
	return surface;
}

function expectFailedB() {
	expect(screen.getByTestId("update-kernel-status").textContent).toBe(
		"Kernel update failed",
	);
	expect(screen.getByTestId("update-kernel-version").textContent).toBe(
		"7.2.0-ceralive3",
	);
	expect(screen.getByTestId("update-kernel-current").textContent).toContain(
		"7.2.0-ceralive2",
	);
	expect(screen.getByTestId("update-kernel-reason").textContent).toContain(
		"download",
	);
}

it("replaces A's success with B's failure after reconciliation returns the wire to idle", async () => {
	const surface = await openPrevious();
	const view = render(KernelSection, {
		...props,
		kernel: surface.details?.kernel,
	});
	expect(screen.getByTestId("update-kernel-status").textContent).toBe(
		"Kernel updated",
	);
	const refreshing = surface.observePhase("kernel-failed");
	const pendingKernel = surface.details?.kernel;
	answer("system.getUpdateDetails", failed);
	await refreshing;
	await view.rerender({ ...props, kernel: surface.details?.kernel });
	expectFailedB();
	expect(pendingKernel?.version ?? null).toBeNull();
});

it("a rejected B details refresh cannot attach A's cached version to B's failure", async () => {
	const surface = await openPrevious();
	const refreshing = surface.observePhase("kernel-failed");
	reject("system.getUpdateDetails", "INTERNAL_ERROR");
	await refreshing;
	render(KernelSection, {
		...props,
		wire: {
			...wire,
			phase: "kernel-failed",
			failure_reason: "kernel_download_failed",
		},
		kernel: surface.details?.kernel,
	});
	expect(surface.detailsFailed).toBe(true);
	expect(screen.getByTestId("update-kernel-status").textContent).toBe(
		"Kernel update failed",
	);
	expect(screen.queryByTestId("update-kernel-version")).toBeNull();
});

it("dismiss and reopen withhold A while pending and fence its late read after B", async () => {
	const surface = await openPrevious();
	const oldRead = surface.reloadDetails();
	surface.reset();
	const opening = surface.load();
	const pendingKernel = surface.details?.kernel;
	answer("system.getUpdateCapabilities", caps);
	answer("system.getUpdateSettings", SETTINGS);
	answer("system.getUpdateDetails", failed, "newest");
	await opening;
	answer("system.getUpdateDetails", previous);
	await oldRead;
	render(KernelSection, { ...props, kernel: surface.details?.kernel });
	expectFailedB();
	expect(pendingKernel?.version ?? null).toBeNull();
});

it("same-phase reconnect withholds A until the fresh B details arrive", async () => {
	const surface = await openPrevious();
	dropLink();
	await restoreLink();
	const reread = surface.reread();
	const pendingKernel = surface.details?.kernel;
	answer("system.getUpdateCapabilities", caps);
	answer("system.getUpdateSettings", SETTINGS);
	answer("system.getUpdateDetails", failed);
	await reread;
	render(KernelSection, { ...props, kernel: surface.details?.kernel });
	expectFailedB();
	expect(pendingKernel?.version ?? null).toBeNull();
});
