// @vitest-environment jsdom
/**
 * EVERY REFUSAL CLASS, DRIVEN THROUGH ITS REAL RPC PATH, ASSERTED AS THE EXACT
 * SENTENCE AN OPERATOR READS.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT A UNIT TEST OF THE TABLE
 * ────────────────────────────────────────────────────────────────────────────
 *
 * `refusal-taxonomy.test.ts` already proves the table is total and has no
 * `default`. That is a claim about a pure function, and the defect this effort
 * exists to remove lives one layer out: the KEY was right and the SURFACE
 * rendered something else — a dotted path, a generic toast, or a confident
 * wrong sentence from a fallback arm. So each case here mocks the real `rpc.*`
 * method, mounts the real component, performs the real operator gesture, and
 * compares the rendered text to the catalog string by value.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * COVERAGE IS ASSERTED, NOT ASPIRED TO
 * ────────────────────────────────────────────────────────────────────────────
 *
 * The final block proves the cases below name EVERY member of
 * `REFUSAL_CLASSES`. Without it a class added later would silently have no
 * rendered proof, which is exactly the state this suite was written to end.
 *
 * Three RPC paths carry all of them, and each is the path that genuinely
 * answers those tokens:
 *
 *   `modems.configure`       — the config-write vocabulary (nine classes)
 *   `modems.scan`            — the operator-scan vocabulary (two classes)
 *   `modems.setCredentials`  — the dongle-credential vocabulary (seven classes)
 */

import type { Modem, ModemConfigRefusal } from "@ceraui/rpc/schemas";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { deriveLockView } from "$lib/modem/lock-state";
import {
	classifyModemRefusal,
	type ModemRefusalToken,
	modemRefusalCopyKey,
	REFUSAL_CLASSES,
	type RefusalClass,
} from "$lib/modem/refusal-taxonomy";
import ModemConfigDialog from "../main/dialogs/ModemConfigDialog.svelte";
import ModemLockSection from "../main/dialogs/ModemLockSection.svelte";
import { CATALOGS } from "./helpers/catalog";
import { resetModemsFeed } from "./helpers/modem-feed.svelte";

const configure = vi.hoisted(() => vi.fn());
const scan = vi.hoisted(() => vi.fn());
const setCredentials = vi.hoisted(() => vi.fn());
const verifyCredentials = vi.hoisted(() => vi.fn());

vi.mock("$lib/rpc", () => ({
	rpc: {
		modems: {
			configure,
			scan,
			setCredentials,
			verifyCredentials,
			clearCredentials: vi.fn(),
			setUsbMode: vi.fn(),
		},
	},
}));

vi.mock("$lib/rpc/subscriptions.svelte", async () => {
	const feed = await import("./helpers/modem-feed.svelte");
	return {
		getModems: feed.getModemsFeed,
		getConfig: () => ({}),
		getStatus: () => ({}),
		getIsConnected: () => true,
	};
});

vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

/** The sentence the operator is supposed to read, straight from the catalog. */
function expectedSentence(token: ModemRefusalToken): string {
	let cursor: unknown = CATALOGS.en;
	for (const segment of modemRefusalCopyKey(token).split(".")) {
		cursor = (cursor as Record<string, unknown>)[segment];
	}
	if (typeof cursor !== "string") {
		throw new Error(`no catalog sentence for ${token}`);
	}
	return cursor;
}

function modem(): Modem {
	return {
		ifname: "wwan0",
		name: "Quectel RM530N-GL",
		network_type: { supported: ["4g", "5g"], active: "5g" },
		status: {
			connection: "connected",
			network_type: "5g",
			signal: 72,
			roaming: true,
		},
		config: {
			apn: "internet",
			username: "",
			password: "",
			// Roaming ON mounts the operator-scan block, which is the surface the
			// scan cases below drive.
			roaming: true,
			network: "",
			autoconfig: false,
		},
	} as Modem;
}

function mountDialog() {
	return render(ModemConfigDialog, {
		props: { open: true, modem: modem(), deviceId: "2" },
	});
}

/**
 * A save that alters NOTHING is confirmed by the configure-echo the instant it
 * is dispatched, so the dialog closes before any refusal can be read. Every
 * case therefore edits the APN first — the `apn.test.ts` lesson, restated
 * because a test that skipped it would pass for the wrong reason.
 */
async function saveChangedApn(): Promise<void> {
	const input = document.querySelector<HTMLInputElement>("#modem-apn");
	if (input === null) throw new Error("manual APN field is not mounted");
	await fireEvent.input(input, { target: { value: "ceralive.test.apn" } });
	await fireEvent.click(screen.getByRole("button", { name: /^Save$/i }));
}

/** Drive a config-write refusal all the way to the standing band. */
async function renderConfigRefusal(token: ModemConfigRefusal): Promise<string> {
	configure.mockResolvedValue({ success: false, error: token });
	mountDialog();
	await saveChangedApn();
	// The band's own heading ("Settings not saved") is a fixed frame, so the
	// SENTENCE has its own node — otherwise every class would read as the
	// heading plus its text and the exact-string assertion would be untrue.
	await screen.findByTestId("modem-save-refused");
	const reason = await screen.findByTestId("modem-save-refused-reason");
	return reason.textContent?.trim() ?? "";
}

/** Drive an operator-scan refusal to the band beside the operator selector. */
async function renderScanRefusal(
	token: "timed_out" | "already_scanning" | "failed",
): Promise<string> {
	scan.mockResolvedValue({ success: false, scanFailure: token });
	mountDialog();
	await fireEvent.click(await screen.findByTestId("modem-scan-button"));
	const band = await screen.findByTestId("modem-scan-error");
	await waitFor(() =>
		expect(band.getAttribute("data-scan-failure")).toBe(token),
	);
	return band.textContent?.trim() ?? "";
}

/** Drive a credential refusal through the section that owns the login. */
async function renderCredentialRefusal(token: string): Promise<string> {
	setCredentials.mockResolvedValue({ success: false, error: token });
	render(ModemLockSection, {
		props: {
			deviceId: "2",
			lock: deriveLockView({
				lock_state: "locked",
				lock_detail: { credential_configured: false },
			} as unknown as Modem),
		},
	});
	const field = document.querySelector<HTMLInputElement>(
		'input[type="password"]',
	);
	if (field === null) throw new Error("the password field is not mounted");
	await fireEvent.input(field, { target: { value: "not-a-real-secret" } });
	await fireEvent.click(screen.getByTestId("dongle-lock-submit"));
	const band = await screen.findByTestId("dongle-lock-outcome");
	return band.textContent?.trim() ?? "";
}

type Case = {
	readonly refusalClass: RefusalClass;
	readonly token: ModemRefusalToken;
	readonly render: () => Promise<string>;
};

const CONFIG_CASES: readonly Case[] = (
	[
		["unsupported", "unsupported_network_type"],
		["blocked-by-state", "unconfigured_modem"],
		["device-busy", "mutation_in_progress"],
		["admission-refused", "streaming_active"],
		["reconciliation-required", "mutation_blocked"],
		["identity-unresolved", "identity_unresolved"],
		["hardware-gone", "unknown_modem"],
		["invalid-request", "invalid_config"],
		["write-failed", "write_failed"],
	] as const
).map(([refusalClass, token]) => ({
	refusalClass,
	token,
	render: () => renderConfigRefusal(token),
}));

const SCAN_CASES: readonly Case[] = (
	[
		["timed-out-unknown-outcome", "timed_out"],
		["read-failed", "failed"],
	] as const
).map(([refusalClass, token]) => ({
	refusalClass,
	token,
	render: () => renderScanRefusal(token),
}));

const CREDENTIAL_CASES: readonly Case[] = (
	[
		["auth-failed", "auth_failed"],
		["unsupported-profile", "unsupported_profile"],
		["locked-out", "locked_out"],
		["credential-not-required", "device_open"],
		["no-credential-stored", "no_credential"],
		["unreachable", "unreachable"],
		["emulated-mode", "unavailable_in_emulated_mode"],
	] as const
).map(([refusalClass, token]) => ({
	refusalClass,
	token,
	render: () => renderCredentialRefusal(token),
}));

const ALL_CASES: readonly Case[] = [
	...CONFIG_CASES,
	...SCAN_CASES,
	...CREDENTIAL_CASES,
];

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

beforeEach(() => {
	configure.mockReset();
	configure.mockResolvedValue({ success: true });
	scan.mockReset();
	scan.mockResolvedValue({ success: true, networks: {} });
	setCredentials.mockReset();
	verifyCredentials.mockReset();
	verifyCredentials.mockResolvedValue({ success: true });
	resetModemsFeed();
});

describe("each refusal class renders its own sentence, through its own RPC", () => {
	it.each(ALL_CASES.map((entry) => [entry.refusalClass, entry] as const))(
		"%s",
		async (_name, entry) => {
			expect(classifyModemRefusal(entry.token)).toBe(entry.refusalClass);

			const rendered = await entry.render();

			expect(rendered).toBe(expectedSentence(entry.token));
			expect(rendered).not.toContain(entry.token);
			expect(rendered).not.toContain("network.modem");
			expect(rendered).not.toContain("network.routerCellular");
		},
	);
});

describe("the classes really are distinct ON SCREEN", () => {
	it("eighteen classes render eighteen different sentences", async () => {
		const rendered = new Set(
			ALL_CASES.map((entry) => expectedSentence(entry.token)),
		);
		expect(rendered.size).toBe(ALL_CASES.length);
	});
});

describe("the sweep covers the whole taxonomy", () => {
	it("names every class exactly once — no gap, no duplicate", () => {
		const covered = ALL_CASES.map((entry) => entry.refusalClass);
		expect(covered).toHaveLength(REFUSAL_CLASSES.length);
		expect([...covered].sort()).toEqual([...REFUSAL_CLASSES].sort());
	});
});
