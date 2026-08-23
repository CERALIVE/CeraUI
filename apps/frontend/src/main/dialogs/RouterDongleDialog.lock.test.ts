// @vitest-environment jsdom
/**
 * RouterDongleDialog — THE CREDENTIAL UNLOCK, IN OUR INTERFACE.
 *
 * Todo 10 put a five-state lock on the wire and gated the dongle's own
 * capability + control blocks behind it. This is the operator half, and four of
 * its properties are the ones a rendered test can prove and a unit test cannot:
 *
 *  · `open` — the COMMON case on this fleet — renders NO password entry. That is
 *    an ABSENCE, so it is asserted against the real DOM, and paired with a
 *    positive control (a `locked` fixture DOES render one) so the sweep cannot
 *    pass by finding nothing anywhere.
 *  · An unlock is a visible CAPABILITY EXPANSION: a control that was withheld
 *    while signed out arrives through the SAME uniform section every other
 *    reading on this dialog uses.
 *  · `locked-out` renders the WAIT and no retry — no entry, no submit, no
 *    "try again". Enumerated over every rendered control rather than by naming
 *    one testid, because a retry added later under a different name is exactly
 *    the regression this is here to stop.
 *  · The credential reaches the RPC and NOTHING ELSE. Cleared before the await,
 *    absent from the serialized DOM, absent from every web-storage surface, and
 *    absent from the URL.
 *
 * AppDialog PORTALS its content out of `render()`'s container, so every query
 * here goes through `document`/`screen` — a `container`-scoped absence sweep
 * would pass on whatever rendered.
 */
import { m } from "@ceraui/i18n/svelte";
import type {
	Modem,
	ModemLockDetail,
	ModemLockState,
	RouterAdmin,
} from "@ceraui/rpc/schemas";
import { fireEvent, render, screen } from "@testing-library/svelte";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import RouterDongleDialog from "./RouterDongleDialog.svelte";

const setCredentials = vi.hoisted(() => vi.fn());
const clearCredentials = vi.hoisted(() => vi.fn());
const verifyCredentials = vi.hoisted(() => vi.fn());

vi.mock("$lib/rpc", () => ({
	rpc: {
		modems: {
			setCredentials,
			clearCredentials,
			verifyCredentials,
			setRouterControl: vi.fn(),
			setRouterNetMode: vi.fn(),
			openRouterAdmin: vi.fn(),
		},
	},
}));

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

beforeEach(() => {
	setCredentials.mockReset();
	clearCredentials.mockReset();
	verifyCredentials.mockReset();
	localStorage.clear();
	sessionStorage.clear();
});

afterEach(() => {
	document.body.innerHTML = "";
});

/** The bench HiLink, with whichever lock the wire is currently reporting. */
function dongle(
	lock?: { state: ModemLockState; detail?: ModemLockDetail },
	admin: Partial<RouterAdmin> = {},
): Modem {
	return {
		ifname: "eth1",
		name: "Huawei E3372",
		router_admin: {
			admin_url: "http://192.168.8.1",
			reachable: true,
			model: "E3372",
			...admin,
		},
		...(lock === undefined
			? {}
			: {
					lock_state: lock.state,
					lock_detail: lock.detail ?? { credential_configured: false },
				}),
	} as unknown as Modem;
}

/** The two blocks `gateRouterAdminByLock` withholds while a lock stands. */
const SERVED_CONTROLS: Partial<RouterAdmin> = {
	controls: { mobile_data: false, roaming_autoconnect: false },
};

function open(modem: Modem) {
	return render(RouterDongleDialog, {
		props: { open: true, deviceId: "router-1", modem },
	});
}

const testid = (id: string): HTMLElement | null =>
	document.querySelector(`[data-testid="${id}"]`);

const passwordFields = (): HTMLInputElement[] =>
	Array.from(
		document.querySelectorAll<HTMLInputElement>('input[type="password"]'),
	);

/** Every interactive control currently on screen, with its accessible words. */
function controlLabels(): string[] {
	return Array.from(
		document.querySelectorAll<HTMLElement>("button, input, select, textarea"),
	).map((el) =>
		`${el.getAttribute("data-testid") ?? ""} ${el.getAttribute("aria-label") ?? ""} ${el.textContent ?? ""}`.toLowerCase(),
	);
}

describe("all five lock states render, and each one reads differently", () => {
	const STATES: readonly ModemLockState[] = [
		"open",
		"locked",
		"unlocked",
		"auth-failed",
		"locked-out",
	];

	it.each(STATES)(
		"%s renders the lock section with its own state marker",
		(state) => {
			open(dongle({ state }));
			expect(testid("dongle-lock")).not.toBeNull();
			expect(testid("dongle-lock-body")?.getAttribute("data-lock-state")).toBe(
				state,
			);
		},
	);

	it("the six reachable situations produce six DIFFERENT sentences", () => {
		const seen: string[] = [];
		for (const state of STATES) {
			open(dongle({ state }));
			seen.push(testid("dongle-lock-message")?.textContent?.trim() ?? "");
			document.body.innerHTML = "";
		}
		// The sub-reason is a sixth situation INSIDE `locked`, and it must not read
		// as an ordinary locked row.
		open(
			dongle({
				state: "locked",
				detail: {
					credential_configured: false,
					sub_reason: "unsupported-profile",
				},
			}),
		);
		seen.push(testid("dongle-lock-message")?.textContent?.trim() ?? "");

		expect(seen).toHaveLength(6);
		expect(new Set(seen).size).toBe(6);
		for (const sentence of seen) expect(sentence.length).toBeGreaterThan(0);
		// A dotted key reaching an operator is the failure this vocabulary exists
		// to prevent.
		for (const sentence of seen) {
			expect(sentence.startsWith("network.")).toBe(false);
		}
	});

	it("the THREE failure causes name three different things to do", () => {
		open(
			dongle({ state: "auth-failed", detail: { credential_configured: true } }),
		);
		const wrongPassword = testid("dongle-lock-message")?.textContent?.trim();
		document.body.innerHTML = "";

		open(
			dongle({
				state: "locked",
				detail: {
					credential_configured: false,
					sub_reason: "unsupported-profile",
				},
			}),
		);
		const unsupported = testid("dongle-lock-message")?.textContent?.trim();
		document.body.innerHTML = "";

		open(
			dongle({ state: "locked-out", detail: { credential_configured: true } }),
		);
		const lockedOut = testid("dongle-lock-message")?.textContent?.trim();

		expect(new Set([wrongPassword, unsupported, lockedOut]).size).toBe(3);
		expect(wrongPassword).toBe(
			m["network.routerCellular.lock.cause.authFailed"](),
		);
		expect(unsupported).toBe(
			m["network.routerCellular.lock.cause.unsupportedProfile"](),
		);
		expect(lockedOut).toBe(m["network.routerCellular.lock.cause.lockedOut"]());
	});

	it("a device with NO admin-auth surface renders ZERO lock nodes", () => {
		open(dongle());
		expect(testid("dongle-lock")).toBeNull();
		expect(testid("dongle-lock-body")).toBeNull();
		expect(passwordFields()).toHaveLength(0);
	});
});

describe("`open` never prompts for a password", () => {
	it("renders NO password entry, no submit, and no form", () => {
		// Most fleet devices need no password. Prompting at one is exactly the
		// dishonesty this effort removes.
		open(dongle({ state: "open" }));

		expect(testid("dongle-lock-form")).toBeNull();
		expect(testid("dongle-lock-password")).toBeNull();
		expect(testid("dongle-lock-submit")).toBeNull();
		expect(passwordFields()).toHaveLength(0);
	});

	it("…and it still says WHY, in one status line", () => {
		open(dongle({ state: "open" }));
		expect(testid("dongle-lock-message")?.textContent?.trim()).toBe(
			m["network.routerCellular.lock.state.open"](),
		);
	});

	it("POSITIVE CONTROL — a `locked` fixture DOES render one", () => {
		// Without this the absence sweep above would pass on a dialog that renders
		// no password field in any state whatsoever.
		open(dongle({ state: "locked" }));
		expect(testid("dongle-lock-password")).not.toBeNull();
		expect(passwordFields()).toHaveLength(1);
	});

	it("`unlocked` has nothing left to ask for either", () => {
		open(
			dongle({ state: "unlocked", detail: { credential_configured: true } }),
		);
		expect(passwordFields()).toHaveLength(0);
		expect(testid("dongle-lock-submit")).toBeNull();
	});

	it("an `unsupported-profile` row withholds the field although it is `locked`", () => {
		open(
			dongle({
				state: "locked",
				detail: {
					credential_configured: false,
					sub_reason: "unsupported-profile",
				},
			}),
		);
		expect(passwordFields()).toHaveLength(0);
		expect(testid("dongle-lock-submit")).toBeNull();
	});
});

describe("`locked-out` renders the wait, not a retry", () => {
	it("offers no entry and no submit", () => {
		open(
			dongle({ state: "locked-out", detail: { credential_configured: true } }),
		);

		expect(passwordFields()).toHaveLength(0);
		expect(testid("dongle-lock-form")).toBeNull();
		expect(testid("dongle-lock-submit")).toBeNull();
	});

	it("offers NO control that reads as a retry, whatever it is called", () => {
		open(
			dongle({ state: "locked-out", detail: { credential_configured: true } }),
		);

		const retryish = controlLabels().filter((label) =>
			/retry|try again|unlock|sign in|submit|lock-submit/.test(label),
		);
		expect(retryish).toEqual([]);
	});

	it("renders the device's OWN remaining window", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-22T00:00:00Z"));
		open(
			dongle({
				state: "locked-out",
				detail: {
					credential_configured: true,
					lockout_until: Date.parse("2026-08-22T00:05:00Z"),
				},
			}),
		);

		expect(testid("dongle-lock-wait")?.textContent?.trim()).toBe(
			m["network.routerCellular.lock.wait"]({ minutes: 5 }),
		);
		vi.useRealTimers();
	});

	it("says so honestly when the device named no window", () => {
		open(
			dongle({ state: "locked-out", detail: { credential_configured: true } }),
		);
		expect(testid("dongle-lock-wait")?.textContent?.trim()).toBe(
			m["network.routerCellular.lock.waitUnknown"](),
		);
	});

	it("a REMOVAL is still offered — it spends no attempt", () => {
		// Clearing performs zero device requests, so it is not a retry; during a
		// lockout it is the one useful thing an operator can do.
		open(
			dongle({ state: "locked-out", detail: { credential_configured: true } }),
		);
		expect(testid("dongle-lock-clear")).not.toBeNull();
	});
});

describe("an unlock is a visible CAPABILITY EXPANSION", () => {
	it("a withheld control arrives through the same uniform section", async () => {
		const { rerender } = open(dongle({ state: "locked" }));

		// Signed out, the device withholds `router_admin.controls` entirely.
		expect(testid("dongle-controls")).toBeNull();
		expect(testid("dongle-control-mobile_data")).toBeNull();
		const band = testid("dongle-no-controls");
		expect(band?.getAttribute("data-locked")).toBe("true");
		expect(band?.textContent?.trim()).toBe(
			m["network.routerCellular.lock.controlsWithheld"](),
		);

		// The device re-broadcasts the roster after a successful verify.
		await rerender({
			modem: dongle(
				{ state: "unlocked", detail: { credential_configured: true } },
				SERVED_CONTROLS,
			),
		});

		expect(testid("dongle-controls")).not.toBeNull();
		expect(testid("dongle-control-mobile_data")).not.toBeNull();
		expect(testid("dongle-no-controls")).toBeNull();
	});

	it("a signed-out band never claims the device has nothing settable", async () => {
		// Two DIFFERENT facts: "we have not asked" and "nothing here applies a
		// setting we could verify". Sharing one sentence sends the operator looking
		// for a hardware limitation instead of at the login above.
		const { rerender } = open(dongle({ state: "locked" }));
		expect(testid("dongle-no-controls")?.textContent?.trim()).not.toBe(
			m["network.routerCellular.control.none"](),
		);

		// A device that is signed IN and genuinely has no proven write keeps the
		// original sentence.
		await rerender({ modem: dongle({ state: "open" }) });
		const band = testid("dongle-no-controls");
		expect(band?.getAttribute("data-locked")).toBeNull();
		expect(band?.textContent?.trim()).toBe(
			m["network.routerCellular.control.none"](),
		);
	});

	it("a modem with no lock at all keeps the original band verbatim", () => {
		open(dongle());
		expect(testid("dongle-no-controls")?.textContent?.trim()).toBe(
			m["network.routerCellular.control.none"](),
		);
	});
});

describe("the credential reaches the RPC and nothing else", () => {
	const SECRET = "hunter2-dongle-secret";

	async function type(value: string): Promise<void> {
		const field = testid("dongle-lock-password") as HTMLInputElement;
		await fireEvent.input(field, { target: { value } });
	}

	it("posts to the backend, and is CLEARED before the await", async () => {
		let release: ((value: { success: boolean }) => void) | undefined;
		setCredentials.mockReturnValue(
			new Promise<{ success: boolean }>((resolve) => {
				release = resolve;
			}),
		);
		verifyCredentials.mockResolvedValue({
			success: true,
			lock_state: "unlocked",
		});

		open(dongle({ state: "locked" }));
		await type(SECRET);
		await fireEvent.click(testid("dongle-lock-submit") as HTMLElement);

		// The RPC really received it — without this the sweeps below are vacuous.
		expect(setCredentials).toHaveBeenCalledWith({
			device: "router-1",
			username: "",
			password: SECRET,
		});
		// …and the component no longer holds it, WHILE the request is still open.
		expect(
			(testid("dongle-lock-password") as HTMLInputElement | null)?.value ?? "",
		).toBe("");
		expect(document.body.innerHTML).not.toContain(SECRET);

		release?.({ success: true });
	});

	it("leaves no copy in the DOM, in web storage, or in the URL", async () => {
		setCredentials.mockResolvedValue({ success: true });
		verifyCredentials.mockResolvedValue({ success: true });

		open(dongle({ state: "locked" }));
		await type(SECRET);
		await fireEvent.click(testid("dongle-lock-submit") as HTMLElement);
		await Promise.resolve();
		await Promise.resolve();

		const surfaces = {
			html: document.body.innerHTML,
			text: document.body.textContent ?? "",
			local: JSON.stringify(localStorage),
			session: JSON.stringify(sessionStorage),
			url: window.location.href,
		};
		for (const [name, serialized] of Object.entries(surfaces)) {
			expect(`${name}:${serialized.includes(SECRET)}`).toBe(`${name}:false`);
		}
	});

	it("the field never autofills and never echoes the value back", () => {
		open(dongle({ state: "locked" }));
		const field = testid("dongle-lock-password") as HTMLInputElement;

		expect(field.getAttribute("type")).toBe("password");
		expect(field.getAttribute("autocomplete")).toBe("off");
		// A `value` ATTRIBUTE would put the secret into the serialized document; the
		// bound DOM property is what holds it while the operator types.
		expect(field.getAttribute("value")).toBeNull();
	});

	it("submit stays disabled until something has been typed", async () => {
		open(dongle({ state: "locked" }));
		const submit = testid("dongle-lock-submit") as HTMLButtonElement;
		expect(submit.disabled).toBe(true);

		await type("x");
		expect((testid("dongle-lock-submit") as HTMLButtonElement).disabled).toBe(
			false,
		);
	});

	it("a rejected credential renders `auth_failed` in the operator's own words", async () => {
		setCredentials.mockResolvedValue({ success: true });
		verifyCredentials.mockResolvedValue({
			success: false,
			error: "auth_failed",
			lock_state: "auth-failed",
		});

		open(dongle({ state: "locked" }));
		await type(SECRET);
		await fireEvent.click(testid("dongle-lock-submit") as HTMLElement);
		await screen.findByTestId("dongle-lock-outcome");

		const band = testid("dongle-lock-outcome");
		expect(band?.getAttribute("data-outcome")).toBe("refused");
		expect(band?.textContent?.trim()).toBe(
			m["network.routerCellular.lock.error.auth_failed"](),
		);
		expect(document.body.innerHTML).not.toContain(SECRET);
	});

	it("a store refusal never reaches the device — verify is not dispatched", async () => {
		setCredentials.mockResolvedValue({ success: false, error: "device_open" });

		open(dongle({ state: "locked" }));
		await type(SECRET);
		await fireEvent.click(testid("dongle-lock-submit") as HTMLElement);
		await screen.findByTestId("dongle-lock-outcome");

		expect(verifyCredentials).not.toHaveBeenCalled();
		expect(testid("dongle-lock-outcome")?.textContent?.trim()).toBe(
			m["network.routerCellular.lock.error.device_open"](),
		);
	});

	it("a thrown transport is refused as its OWN outcome, never as a device claim", async () => {
		setCredentials.mockRejectedValue(new Error("socket closed"));

		open(dongle({ state: "locked" }));
		await type(SECRET);
		await fireEvent.click(testid("dongle-lock-submit") as HTMLElement);
		await screen.findByTestId("dongle-lock-outcome");

		expect(testid("dongle-lock-outcome")?.textContent?.trim()).toBe(
			m["network.routerCellular.lock.error.generic"](),
		);
	});

	it("forgetting a stored login dispatches the clear and announces it", async () => {
		clearCredentials.mockResolvedValue({ success: true, lock_state: "locked" });

		open(
			dongle({ state: "auth-failed", detail: { credential_configured: true } }),
		);
		await fireEvent.click(testid("dongle-lock-clear") as HTMLElement);
		await screen.findByTestId("dongle-lock-outcome");

		expect(clearCredentials).toHaveBeenCalledWith({ device: "router-1" });
		const band = testid("dongle-lock-outcome");
		expect(band?.getAttribute("data-outcome")).toBe("applied");
		expect(band?.textContent?.trim()).toBe(
			m["network.routerCellular.lock.outcome.cleared"](),
		);
	});
});

describe("the vendor's own page stays available, as the SECONDARY affordance", () => {
	it("a locked dongle still offers the admin-UI button beside the login", () => {
		// The proxied page is the fallback, not the primary path — but it must not
		// disappear just because a login exists.
		open(dongle({ state: "locked" }));
		expect(testid("dongle-open-admin")).not.toBeNull();
		expect(testid("dongle-lock-form")).not.toBeNull();
	});
});
