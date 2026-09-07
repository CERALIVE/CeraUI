// @vitest-environment jsdom
/**
 * "Check for updates" must visibly do something.
 *
 * Live on a Rock 5B+: clicking it changed NOTHING for 11 s — `aria-busy` stayed
 * false, the label never became "Checking…", the summary stayed "System is up to
 * date" — while the device's own log proved the check ran and succeeded in 1.8 s.
 *
 * The dialog cancelled its own spinner: it latched completion on "the state is no
 * longer `checking`", and `checking` is BELOW `available` in the update state
 * machine, so a device that already knows about an update never publishes a
 * `checking` frame at all. The condition was therefore true on the very first
 * flush after the click — before the RPC had even been dispatched.
 *
 * Completion is now latched on a NEW `checked_at`, which every completed cycle
 * stamps regardless of which state it lands in.
 */

import type { UpdatePackage, UpdateState } from "@ceraui/rpc/schemas";
import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { rpc } from "$lib/rpc/client";
import { reactiveUpdateState } from "../../tests/fixtures/reactive-subscriptions.svelte";

import UpdatesDialog from "./UpdatesDialog.svelte";

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

vi.mock("$lib/rpc/client", () => ({
	rpc: {
		system: {
			startUpdate: vi.fn(async () => ({ success: true })),
			checkForUpdates: vi.fn(async () => ({ success: true })),
		},
	},
}));

vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("$lib/rpc/subscriptions.svelte", async () => {
	const { reactiveUpdateState: state } = await import(
		"../../tests/fixtures/reactive-subscriptions.svelte"
	);
	return { getUpdateState: () => state.value };
});

vi.mock("$lib/rpc/async-operation.svelte", () => ({
	osCommand: vi.fn(async (opts: { rpc: () => Promise<unknown> }) => {
		try {
			return await opts.rpc();
		} catch {
			return undefined;
		}
	}),
	getOperationPhase: () => "idle",
	confirmOperation: vi.fn(),
}));

const checkForUpdates = vi.mocked(rpc.system.checkForUpdates);

afterEach(() => {
	reactiveUpdateState.reset();
	document.body.innerHTML = "";
	vi.clearAllMocks();
});

const AVAILABLE: UpdateState = {
	kind: "available",
	identity: { version: "abc123def456", packages: ["cerastream"] },
	package_count: 1,
	download_size: "12.3 MB",
};

function checkButton(): HTMLButtonElement {
	const button = [...document.querySelectorAll("button")].find((b) =>
		/Check for updates|Checking/.test(b.textContent ?? ""),
	);
	if (!button) throw new Error("check button not rendered");
	return button as HTMLButtonElement;
}

describe("UpdatesDialog — the check reports that it is running", () => {
	it("stays busy until the device stamps a completed check", async () => {
		reactiveUpdateState.value = { kind: "idle", checked_at: 1000 };
		render(UpdatesDialog, { open: true });

		await fireEvent.click(checkButton());

		// Pre-fix this read "false" here: the dialog had already cancelled itself.
		await waitFor(() => {
			expect(checkButton().getAttribute("aria-busy")).toBe("true");
		});
		expect(checkButton().textContent).toContain("Checking");
		expect(checkForUpdates).toHaveBeenCalledTimes(1);

		reactiveUpdateState.value = { kind: "idle", checked_at: 2000 };
		flushSync();

		await waitFor(() => {
			expect(checkButton().getAttribute("aria-busy")).toBe("false");
		});
	});

	it("stays busy on a device that never publishes a `checking` frame", async () => {
		// `available` outranks `checking`, so this device's state does not change
		// at all while the check runs — the exact case the old latch mis-read.
		reactiveUpdateState.value = { ...AVAILABLE, checked_at: 1000 };
		render(UpdatesDialog, { open: true });

		await fireEvent.click(checkButton());

		await waitFor(() => {
			expect(checkButton().getAttribute("aria-busy")).toBe("true");
		});

		reactiveUpdateState.value = { ...AVAILABLE, checked_at: 2000 };
		flushSync();

		await waitFor(() => {
			expect(checkButton().getAttribute("aria-busy")).toBe("false");
		});
	});
});

describe("UpdatesDialog — a completed check leaves evidence", () => {
	it("shows when the device last checked instead of a bare 'up to date'", async () => {
		reactiveUpdateState.value = { kind: "idle", checked_at: 1_700_000_000_000 };
		const { getByTestId } = render(UpdatesDialog, { open: true });

		await waitFor(() => {
			expect(getByTestId("update-last-checked").textContent).toContain(
				"Last checked",
			);
		});
	});

	it("omits the line on a device that has never checked", async () => {
		reactiveUpdateState.value = { kind: "idle" };
		const { queryByTestId } = render(UpdatesDialog, { open: true });

		await waitFor(() => {
			expect(queryByTestId("update-last-checked")).toBeNull();
		});
	});
});

describe("UpdatesDialog — a check that fails says so, never 'up to date'", () => {
	it("renders the typed reason for an unreachable repository", async () => {
		reactiveUpdateState.value = {
			kind: "check_failed",
			reason: "refresh_failed",
			checked_at: 1000,
		};
		const { getByTestId, queryByText } = render(UpdatesDialog, { open: true });

		await waitFor(() => {
			expect(getByTestId("update-check-failed").textContent).toContain(
				"Couldn't check for updates",
			);
		});
		expect(getByTestId("update-check-failed-reason").textContent).toContain(
			"couldn't reach the package repositories",
		);
		// The lie this replaces.
		expect(queryByText("System is up to date")).toBeNull();
	});

	it("renders the typed reason for an unreadable discovery", async () => {
		reactiveUpdateState.value = {
			kind: "check_failed",
			reason: "discovery_failed",
		};
		const { getByTestId } = render(UpdatesDialog, { open: true });

		await waitFor(() => {
			expect(getByTestId("update-check-failed-reason").textContent).toContain(
				"couldn't read the result",
			);
		});
	});

	it("still offers a retry after a failed check", async () => {
		reactiveUpdateState.value = {
			kind: "check_failed",
			reason: "refresh_failed",
		};
		render(UpdatesDialog, { open: true });

		await fireEvent.click(checkButton());
		expect(checkForUpdates).toHaveBeenCalledTimes(1);
	});
});

describe("UpdatesDialog — a refused check names itself", () => {
	it("renders the device's reason instead of doing nothing", async () => {
		reactiveUpdateState.value = { kind: "idle" };
		checkForUpdates.mockResolvedValueOnce({
			success: false,
			error: "check_unavailable",
		});
		render(UpdatesDialog, { open: true });

		await fireEvent.click(checkButton());

		await waitFor(() => {
			expect(
				document.querySelector('[data-testid="update-check-refused-reason"]')
					?.textContent,
			).toContain("busy streaming or installing");
		});
		expect(checkButton().getAttribute("aria-busy")).toBe("false");
	});

	it("falls back to a generic reason when the device names none", async () => {
		reactiveUpdateState.value = { kind: "idle" };
		checkForUpdates.mockResolvedValueOnce({ success: false });
		render(UpdatesDialog, { open: true });

		await fireEvent.click(checkButton());

		await waitFor(() => {
			expect(
				document.querySelector('[data-testid="update-check-refused-reason"]')
					?.textContent,
			).toContain("without giving a reason");
		});
	});
});

describe("UpdatesDialog — a check that could not run names the network reason", () => {
	it("renders the repos-unreachable sentence, not a bare failure", async () => {
		reactiveUpdateState.value = {
			kind: "check_failed",
			reason: "repos_unreachable",
			reachability: { ipv4: "no_route", ipv6: "no_route", used: "none" },
		};
		const { getByTestId } = render(UpdatesDialog, { open: true });

		await waitFor(() => {
			expect(getByTestId("update-check-failed-reason").textContent).toContain(
				"Neither IPv4 nor IPv6 reached the package repositories",
			);
		});
	});

	it("renders the captive-portal sentence", async () => {
		reactiveUpdateState.value = {
			kind: "check_failed",
			reason: "captive_portal",
			reachability: { ipv4: "captive", ipv6: "unknown", used: "none" },
		};
		const { getByTestId } = render(UpdatesDialog, { open: true });

		await waitFor(() => {
			expect(getByTestId("update-check-failed-reason").textContent).toContain(
				"wants you to sign in first",
			);
		});
	});
});

// ── The actionable-update set ────────────────────────────────────────────────
//
// Todo 14 publishes a per-package `actionable` verdict and an `actionable_count`
// for the whole discovery, because "how many packages did apt find" and "how many
// may this device install" are different numbers. A platform-layer package ships
// with the next OS image and a kept-back package is one apt itself declined to
// upgrade — the device REFUSES both, so an Install control offered for either is
// a button whose only possible outcome is a refusal.
//
// The gate is therefore `actionable_count`, never `package_count`, and a state
// with nothing actionable renders the quiet informational band with NO action
// control anywhere: the button element is ABSENT, not disabled-and-present.

const MODEM_CLOSURE = [
	"modemmanager",
	"libmm-glib0",
	"libmbim-glib4",
	"libmbim-proxy",
	"libmbim-utils",
	"libqmi-glib5",
	"libqmi-proxy",
	"libqmi-utils",
	"libqrtr-glib0",
	"ceralive-modem-support",
] as const;

function availableWith(packages: readonly UpdatePackage[]): UpdateState {
	const actionable = packages.filter((p) => p.actionable === true);
	return {
		kind: "available",
		identity: {
			version: "actionable-set",
			packages: packages.map((p) => p.name),
		},
		package_count: packages.length,
		download_size: "9.9 MB",
		packages: [...packages],
		actionable_count: actionable.length,
	};
}

const APP = (name: string): UpdatePackage => ({
	name,
	layer: "app",
	actionable: true,
});
const PLATFORM = (name: string): UpdatePackage => ({
	name,
	layer: "platform",
	actionable: false,
});
const KEPT_BACK = (name: string): UpdatePackage => ({
	name,
	layer: "app",
	kept_back: true,
	actionable: false,
});

describe("UpdatesDialog — Install is gated on the ACTIONABLE set", () => {
	it("app-only: Install is offered and its label names the actionable count", async () => {
		reactiveUpdateState.value = availableWith([
			APP("cerastream"),
			APP("srtla-send-rs"),
		]);
		const { getByTestId, queryByTestId } = render(UpdatesDialog, {
			open: true,
		});

		await waitFor(() => {
			expect(queryByTestId("update-install")).not.toBeNull();
		});
		const install = getByTestId("update-install") as HTMLButtonElement;
		expect(install.disabled).toBe(false);
		expect(install.textContent).toContain("2");
		expect(install.textContent).toContain("Packages");
		// Nothing was withheld, so there is no informational band to render.
		expect(queryByTestId("update-platform-band")).toBeNull();
	});

	it("platform-only: the band renders and NO action control exists", async () => {
		reactiveUpdateState.value = availableWith([
			PLATFORM("gstreamer1.0-rockchip-ceralive"),
		]);
		const { getByTestId, queryByTestId } = render(UpdatesDialog, {
			open: true,
		});

		await waitFor(() => {
			expect(queryByTestId("update-platform-band")).not.toBeNull();
		});
		const band = getByTestId("update-platform-band");
		expect(band.textContent).toContain("Ships with the next OS image");
		expect(band.textContent).toContain("gstreamer1.0-rockchip-ceralive");
		// Absent, not disabled: a disabled control still claims there is something
		// here the operator could unlock.
		expect(queryByTestId("update-install")).toBeNull();
		expect(band.querySelectorAll("button").length).toBe(0);
	});

	it("kept-back-only: apt held it back, so it is informational too", async () => {
		reactiveUpdateState.value = availableWith([KEPT_BACK("ceralive-device")]);
		const { getByTestId, queryByTestId } = render(UpdatesDialog, {
			open: true,
		});

		await waitFor(() => {
			expect(queryByTestId("update-platform-band")).not.toBeNull();
		});
		expect(getByTestId("update-platform-band").textContent).toContain(
			"ceralive-device",
		);
		expect(queryByTestId("update-install")).toBeNull();
	});

	it("mixed: the count is the app members and the rest ride the band", async () => {
		reactiveUpdateState.value = availableWith([
			APP("cerastream"),
			PLATFORM("gstreamer1.0-rockchip-ceralive"),
			KEPT_BACK("ceralive-device"),
		]);
		const { getByTestId, queryByTestId } = render(UpdatesDialog, {
			open: true,
		});

		await waitFor(() => {
			expect(queryByTestId("update-install")).not.toBeNull();
		});
		const install = getByTestId("update-install");
		expect(install.textContent).toContain("1");
		expect(install.textContent).toContain("Package");
		// …and the two it may not install are named, in the band, with no action.
		const band = getByTestId("update-platform-band");
		expect(band.textContent).toContain("gstreamer1.0-rockchip-ceralive");
		expect(band.textContent).toContain("ceralive-device");
		expect(band.querySelectorAll("button").length).toBe(0);
		// The actionable list stays the app-layer one — it must not restate the
		// members the band already owns.
		const actionableList = getByTestId("update-packages").textContent ?? "";
		expect(actionableList).toContain("cerastream");
		expect(actionableList).not.toContain("gstreamer1.0-rockchip-ceralive");
	});

	it("the full ModemManager closure is actionable in full", async () => {
		reactiveUpdateState.value = availableWith(MODEM_CLOSURE.map(APP));
		const { getByTestId, queryByTestId } = render(UpdatesDialog, {
			open: true,
		});

		await waitFor(() => {
			expect(queryByTestId("update-install")).not.toBeNull();
		});
		expect(getByTestId("update-install").textContent).toContain("10");
		const listed = getByTestId("update-packages").textContent ?? "";
		for (const name of MODEM_CLOSURE) expect(listed).toContain(name);
		expect(queryByTestId("update-platform-band")).toBeNull();
	});

	it("an UPGRADABLE gstreamer plugin is platform, so it is not an install", async () => {
		reactiveUpdateState.value = availableWith([
			PLATFORM("gstreamer1.0-rockchip-ceralive"),
			APP("cerastream"),
		]);
		const { getByTestId, queryByTestId } = render(UpdatesDialog, {
			open: true,
		});

		await waitFor(() => {
			expect(queryByTestId("update-install")).not.toBeNull();
		});
		expect(getByTestId("update-install").textContent).toContain("1");
		expect(getByTestId("update-platform-band").textContent).toContain(
			"gstreamer1.0-rockchip-ceralive",
		);
	});

	it("a KEPT-BACK gstreamer plugin alone offers no button at all", async () => {
		reactiveUpdateState.value = availableWith([
			{
				name: "gstreamer1.0-rockchip-ceralive",
				layer: "platform",
				kept_back: true,
				actionable: false,
			},
		]);
		const { getByTestId, queryByTestId } = render(UpdatesDialog, {
			open: true,
		});

		await waitFor(() => {
			expect(queryByTestId("update-platform-band")).not.toBeNull();
		});
		expect(getByTestId("update-platform-band").textContent).toContain(
			"gstreamer1.0-rockchip-ceralive",
		);
		expect(queryByTestId("update-install")).toBeNull();
	});

	it("a producer that classified nothing keeps its Install button", async () => {
		// `actionable_count` is optional ONLY so a pre-classification frame parses.
		// Absence therefore means "not classified", never "zero installable" — a
		// backend that predates Todo 14 must keep the button it has always had.
		reactiveUpdateState.value = {
			kind: "available",
			identity: { version: "legacy", packages: ["cerastream"] },
			package_count: 1,
		};
		const { queryByTestId } = render(UpdatesDialog, { open: true });

		await waitFor(() => {
			expect(queryByTestId("update-install")).not.toBeNull();
		});
		expect(queryByTestId("update-platform-band")).toBeNull();
	});
});

describe("UpdatesDialog — a failed install never prints the device's raw reason", () => {
	it("resolves a known reason to keyed copy", async () => {
		reactiveUpdateState.value = { kind: "failed", reason: "repos_unreachable" };
		const { getByTestId } = render(UpdatesDialog, { open: true });

		await waitFor(() => {
			expect(getByTestId("update-failed-reason").textContent).toContain(
				"Neither IPv4 nor IPv6 reached the package repositories",
			);
		});
	});

	it("renders the generic sentence for an unknown reason and never the token", async () => {
		// The real shape: an apt stderr line. An operator with no console cannot act
		// on it, and it is exactly what `operator-copy-no-internals` keeps off screen.
		const token = "E: dpkg was interrupted, run dpkg --configure -a";
		reactiveUpdateState.value = { kind: "failed", reason: token };
		const { getByTestId } = render(UpdatesDialog, { open: true });

		await waitFor(() => {
			expect(getByTestId("update-failed-reason").textContent).toContain(
				"didn't say why",
			);
		});
		expect(document.body.textContent).not.toContain(token);
		expect(document.body.textContent).not.toContain("dpkg");
	});
});

describe("UpdatesDialog — reachability is ONE muted line", () => {
	it("names an IPv4-only answer", async () => {
		reactiveUpdateState.value = {
			kind: "idle",
			checked_at: 1000,
			reachability: { ipv4: "ok", ipv6: "no_route", used: "ipv4" },
		};
		const { getByTestId } = render(UpdatesDialog, { open: true });

		await waitFor(() => {
			expect(getByTestId("update-reachability").textContent).toContain(
				"IPv4 only",
			);
		});
	});

	it("names an IPv6-only answer", async () => {
		reactiveUpdateState.value = {
			kind: "idle",
			checked_at: 1000,
			reachability: { ipv4: "blocked", ipv6: "ok", used: "ipv6" },
		};
		const { getByTestId } = render(UpdatesDialog, { open: true });

		await waitFor(() => {
			expect(getByTestId("update-reachability").textContent).toContain(
				"IPv6 only",
			);
		});
	});

	it("names a captive portal whichever family saw it", async () => {
		reactiveUpdateState.value = {
			kind: "idle",
			checked_at: 1000,
			reachability: { ipv4: "captive", ipv6: "unknown", used: "none" },
		};
		const { getByTestId } = render(UpdatesDialog, { open: true });

		await waitFor(() => {
			expect(getByTestId("update-reachability").textContent).toContain(
				"sign-in page",
			);
		});
	});

	it("renders NOTHING when both families answered", async () => {
		// `any` is the ordinary healthy verdict; a line stating it would be noise on
		// every device that is simply fine.
		reactiveUpdateState.value = {
			kind: "idle",
			checked_at: 1000,
			reachability: { ipv4: "ok", ipv6: "ok", used: "any" },
		};
		const { queryByTestId } = render(UpdatesDialog, { open: true });

		await waitFor(() => {
			expect(queryByTestId("update-last-checked")).not.toBeNull();
		});
		expect(queryByTestId("update-reachability")).toBeNull();
	});

	it("renders nothing at all when the device published no verdict", async () => {
		reactiveUpdateState.value = { kind: "idle", checked_at: 1000 };
		const { queryByTestId } = render(UpdatesDialog, { open: true });

		await waitFor(() => {
			expect(queryByTestId("update-last-checked")).not.toBeNull();
		});
		expect(queryByTestId("update-reachability")).toBeNull();
	});
});
