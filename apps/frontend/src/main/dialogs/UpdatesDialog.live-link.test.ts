// @vitest-environment jsdom
/**
 * The OPEN Updates dialog's conclusions belong to the link that witnessed them
 * (early oracle F2 and F6, 2026-10-13).
 *
 * Rendered dialog, real surface, real follower, real `RPCClient` over a
 * scripted socket on the fake clock; only the pushed orchestrator phase is a
 * settable stand-in. The session-epoch module is the real one: the test feeds
 * it the edges the subscription layer feeds it in the app.
 *
 * F2: "No newer system image has been found" must leave the screen the moment
 * the link it was witnessed on drops, and must not come back from a read that
 * fails over the new link while the phase never moved.
 * F6: a frame that moves the phase AND restores the session re-reads the
 * settings too, not only the details.
 */
import type { UpdateDetails } from "@ceraui/rpc/schemas";
import { render } from "@testing-library/svelte";
import { flushSync } from "svelte";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import { destroyAsyncOperations } from "../../lib/rpc/async-operation.svelte";
import {
	noteLinkState,
	noteSessionRestored,
} from "../../lib/rpc/session-epoch.svelte";
import {
	orchestratorAt,
	reactiveOrchestrator,
} from "../../tests/fixtures/reactive-orchestrator.svelte";
import {
	answer,
	CAPABLE,
	connectDevice,
	deviceDetails,
	disconnectDevice,
	dropLink,
	flush,
	outstanding,
	reject,
	restoreLink,
	SETTINGS,
	sentCount,
} from "../../tests/helpers/update-device";

import UpdatesDialog from "./UpdatesDialog.svelte";

vi.mock("$lib/rpc/subscriptions.svelte", async () => {
	const { reactiveOrchestrator: wire } = await import(
		"../../tests/fixtures/reactive-orchestrator.svelte"
	);
	return {
		getUpdateState: () => undefined,
		getUpdateOrchestratorState: () => wire.value,
	};
});

vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

beforeAll(() => {
	if (!window.matchMedia) {
		window.matchMedia = vi.fn().mockImplementation((query: string) => ({
			matches: true,
			media: query,
			onchange: null,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
			dispatchEvent: vi.fn(),
		}));
	}
});

const NO_NEWER = "No newer system image has been found.";
const NOT_KNOWN =
	"It is not known yet whether a newer system image is available.";

function nothingFound(at: number): UpdateDetails {
	return deviceDetails({ checkedAt: at, candidate: null });
}

function text(): string {
	return document.body.textContent ?? "";
}

async function settle(): Promise<void> {
	await flush();
	flushSync();
	await flush();
}

/** The pushed phase moves; the dialog's follower reacts to it. */
async function pushPhase(
	phase: Parameters<typeof orchestratorAt>[0],
): Promise<void> {
	reactiveOrchestrator.value = orchestratorAt(phase);
	await settle();
}

/** The device answers every details read the dialog has outstanding. */
async function answerDetails(details: UpdateDetails): Promise<void> {
	while (outstanding("system.getUpdateDetails").length > 0)
		answer("system.getUpdateDetails", details);
	await settle();
}

async function openDialog(first: UpdateDetails): Promise<void> {
	render(UpdatesDialog, { props: { open: true } });
	await settle();
	answer("system.getUpdateCapabilities", CAPABLE);
	answer("system.getUpdateSettings", SETTINGS);
	await answerDetails(first);
}

/** The dialog witnesses a check complete with nothing offered, on this link. */
async function witnessNothingNewer(): Promise<void> {
	await openDialog(nothingFound(1_000));
	await pushPhase("checking");
	await answerDetails(nothingFound(1_000));
	await pushPhase("idle");
	await answerDetails(nothingFound(2_000));
}

beforeEach(() => {
	connectDevice();
	noteLinkState("connected");
	reactiveOrchestrator.value = orchestratorAt("idle");
});

afterEach(() => {
	document.body.innerHTML = "";
	reactiveOrchestrator.reset();
	disconnectDevice();
	destroyAsyncOperations();
	noteLinkState("disconnected");
	vi.clearAllMocks();
});

describe("F2: 'No newer system image' is withdrawn with the link that witnessed it", () => {
	it("leaves the screen at the drop and stays gone after a failed read on the same phase", async () => {
		// Given the dialog saw a check complete with nothing offered.
		await witnessNothingNewer();
		expect(text()).toContain(NO_NEWER);

		// When the link drops (nothing is read; the phase does not move).
		dropLink();
		noteLinkState("disconnected");
		flushSync();

		// Then the sentence is gone at once: the socket that witnessed it is gone.
		expect(text()).not.toContain(NO_NEWER);
		expect(text()).toContain(NOT_KNOWN);

		// When the session is restored and the fresh details read FAILS while
		// the phase is still `idle`.
		await restoreLink();
		noteLinkState("connected");
		noteSessionRestored();
		await settle();
		reject("system.getUpdateDetails", "INTERNAL_ERROR");
		while (outstanding("system.getUpdateSettings").length > 0)
			answer("system.getUpdateSettings", SETTINGS);
		await settle();

		// Then nothing brings the previous link's verdict back.
		expect(
			document.querySelector('[data-testid="update-details-failed"]'),
		).not.toBeNull();
		expect(text()).not.toContain(NO_NEWER);
		expect(text()).toContain(NOT_KNOWN);
	});

	it("a read STARTED on the old link is never the new link's baseline", async () => {
		// Given the dialog opened on this link, and a read the old process
		// is answering is still on its way.
		await openDialog(nothingFound(1_000));
		await pushPhase("checking");

		// When the link changes before that answer is folded in, the old
		// process's answer lands, and then the NEW process, whose clock moved
		// while the dialog was not watching and whose memory-only candidate is
		// gone, answers the next read.
		noteLinkState("disconnected");
		noteLinkState("connected");
		await answerDetails(nothingFound(1_000));
		await pushPhase("idle");
		await answerDetails(nothingFound(2_000));

		// Then the new link's first own read is its baseline, not a verdict.
		expect(text()).not.toContain(NO_NEWER);
		expect(text()).toContain(NOT_KNOWN);
	});
});

describe("sweep: a certificate verdict is not a server rejection", () => {
	it("names a certificate the device could not use, never 'the server rejected' it", async () => {
		// Given a check whose apt probe got `credentials-invalid`, which the
		// producer also emits when curl cannot use the LOCAL client certificate.
		await openDialog({
			...nothingFound(1_000),
			transport: {
				profile: "apt",
				checkedAt: 1_000,
				status: "none",
				selected: null,
				findings: [
					{
						ifname: "eth0",
						family: 4,
						kind: "ethernet",
						healthy: false,
						captive: false,
						metered: false,
						states: ["credentials-invalid"],
					},
				],
			},
		});

		// Then the band states what that evidence carries.
		const band = document.querySelector(
			'[data-testid="update-credentials-rejected"]',
		);
		expect(band?.textContent).toContain(
			"The device's update certificate could not be used",
		);
		expect(band?.textContent).not.toContain("server rejected");
	});
});

// FIX-16-FRONT3 R5: the image's capability declaration is a conclusion about the
// image, and an OS replacement changes the image behind a dropped link.
describe("R5: a restored dialog re-reads the image capabilities", () => {
	const LEGACY = { mode: "legacy", features: [] } as const;
	const LEGACY_TITLE = "Limited update features on this system image";

	function systemSection(): Element | null {
		return document.querySelector('[data-testid="updates-system"]');
	}

	async function openOnLegacyImage(): Promise<void> {
		render(UpdatesDialog, { props: { open: true } });
		await settle();
		answer("system.getUpdateCapabilities", LEGACY);
		answer("system.getUpdateSettings", SETTINGS);
		await answerDetails(nothingFound(1_000));
		expect(text()).toContain(LEGACY_TITLE);
		expect(systemSection()).toBeNull();
	}

	async function restoreAfterReplacement(): Promise<void> {
		dropLink();
		noteLinkState("disconnected");
		await restoreLink();
		noteLinkState("connected");
		noteSessionRestored();
		await settle();
	}

	it("a restored dialog rereads image capabilities", async () => {
		await openOnLegacyImage();
		expect(sentCount("system.getUpdateCapabilities")).toBe(1);

		await restoreAfterReplacement();
		expect(sentCount("system.getUpdateCapabilities")).toBe(2);
		answer("system.getUpdateCapabilities", CAPABLE);
		answer("system.getUpdateSettings", SETTINGS);
		await answerDetails(nothingFound(2_000));

		expect(text()).not.toContain(LEGACY_TITLE);
		expect(systemSection()).not.toBeNull();
	});

	it("a failed capability read stays unknown, never legacy", async () => {
		await openOnLegacyImage();

		await restoreAfterReplacement();
		reject("system.getUpdateCapabilities", "INTERNAL_ERROR");
		answer("system.getUpdateSettings", SETTINGS);
		await answerDetails(nothingFound(2_000));

		expect(text()).not.toContain(LEGACY_TITLE);
		expect(systemSection()).toBeNull();
		expect(
			document.querySelector('[data-testid="update-details-failed"]'),
		).not.toBeNull();
	});

	it("a frame that also moves the phase rereads them too", async () => {
		await openOnLegacyImage();
		dropLink();
		noteLinkState("disconnected");
		await restoreLink();
		noteLinkState("connected");

		noteSessionRestored();
		reactiveOrchestrator.value = orchestratorAt("checking");
		await settle();

		expect(sentCount("system.getUpdateCapabilities")).toBe(2);
		answer("system.getUpdateCapabilities", CAPABLE);
		answer("system.getUpdateSettings", SETTINGS);
		await answerDetails(nothingFound(2_000));
		expect(text()).not.toContain(LEGACY_TITLE);
		expect(systemSection()).not.toBeNull();
	});
});

describe("F6: a frame that moves the phase AND restores the session", () => {
	it("re-reads the settings as well as the details", async () => {
		// Given an open dialog on a link that then dropped and came back.
		await openDialog(nothingFound(1_000));
		dropLink();
		noteLinkState("disconnected");
		await restoreLink();
		noteLinkState("connected");
		const settingsBefore = sentCount("system.getUpdateSettings");
		const detailsBefore = sentCount("system.getUpdateDetails");

		// When ONE frame carries the restored session and a new phase.
		noteSessionRestored();
		reactiveOrchestrator.value = orchestratorAt("checking");
		await settle();

		// Then the settings are read again over the restored link, and the
		// phase is forwarded once (one details read).
		expect(sentCount("system.getUpdateSettings")).toBe(settingsBefore + 1);
		expect(sentCount("system.getUpdateDetails")).toBe(detailsBefore + 1);
	});
});
