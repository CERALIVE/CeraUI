// @vitest-environment jsdom
/**
 * ModemCapabilitiesDialog — the Settings surface the GPS copy pointed at.
 *
 * Before this dialog existed, `config.modem_capabilities` was default-absent with
 * no RPC and no UI, so the band-lock and GPS controls in ModemConfigDialog told
 * operators to "turn this on in settings" and pointed at nothing — a full
 * `#settings` sweep on the board found zero matching testids
 * (`.omo/evidence/task-49-full-stack-board-validation.md`).
 *
 * Three properties are asserted against the RENDERED DOM rather than the
 * component's internals, because each is a claim made to an operator:
 *
 *   1. CT-1 — a module this build does not ship renders ZERO nodes. Not a
 *      disabled switch, which would imply a capability being withheld.
 *   2. The switch is PESSIMISTIC: it moves to what the device says it persisted
 *      (`applied`), never to what was clicked.
 *   3. A `module_not_implemented` refusal renders the calm inline band and does
 *      NOT toast — a device fact is not an operation failure.
 */
import { m } from "@ceraui/i18n/svelte";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import {
	destroyAsyncOperations,
	initAsyncOperations,
} from "$lib/rpc/async-operation.svelte";
import ModemCapabilitiesDialog from "./ModemCapabilitiesDialog.svelte";

const getCapabilities = vi.hoisted(() => vi.fn());
const setCapabilities = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock("$lib/rpc/client", () => ({
	rpc: { modems: { getCapabilities, setCapabilities } },
}));

vi.mock("svelte-sonner", () => ({
	toast: { error: toastError, success: vi.fn() },
}));

const ALL_OFF = {
	"band-lock": false,
	sms: false,
	"five-g-pref": false,
	"fcc-auto-unlock": false,
	gps: false,
	ussd: false,
	esim: false,
};

const IMPLEMENTED = ["five-g-pref", "band-lock", "gps", "ussd"];

function readGates(): Record<string, boolean> {
	return { ...ALL_OFF };
}

// AppDialog picks Dialog vs Sheet via `new MediaQuery(...)` → window.matchMedia,
// absent in jsdom. Stub it to the desktop (Dialog) branch.
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
	initAsyncOperations();
});

beforeEach(() => {
	getCapabilities.mockReset();
	setCapabilities.mockReset();
	toastError.mockReset();
	getCapabilities.mockResolvedValue({
		gates: readGates(),
		implemented: [...IMPLEMENTED],
	});
});

afterEach(() => {
	destroyAsyncOperations();
	initAsyncOperations();
});

async function open() {
	render(ModemCapabilitiesDialog, { props: { open: true } });
	await waitFor(() => {
		expect(getCapabilities).toHaveBeenCalled();
	});
}

describe("CT-1 — only the modules this build ships get a row", () => {
	it("renders a row for every implemented module", async () => {
		await open();
		for (const module of IMPLEMENTED) {
			await waitFor(() => {
				expect(
					screen.getByTestId(`modem-capability-row-${module}`),
				).toBeTruthy();
			});
		}
	});

	it("renders ZERO nodes for a module this build does not implement", async () => {
		await open();
		await waitFor(() => {
			expect(screen.getByTestId("modem-capability-row-gps")).toBeTruthy();
		});
		expect(screen.queryByTestId("modem-capability-row-esim")).toBeNull();
		expect(screen.queryByTestId("modem-capability-row-sms")).toBeNull();
		expect(screen.queryByTestId("modem-capability-toggle-esim")).toBeNull();
	});

	it("orders rows by the shared module list, not by the device's arrival order", async () => {
		getCapabilities.mockResolvedValue({
			gates: readGates(),
			// Deliberately reversed on the wire.
			implemented: ["ussd", "gps", "band-lock", "five-g-pref"],
		});
		await open();
		await waitFor(() => {
			expect(screen.getByTestId("modem-capability-row-ussd")).toBeTruthy();
		});
		const rendered = screen
			.getAllByTestId(/^modem-capability-row-/)
			.map((el) => el.getAttribute("data-module"));
		expect(rendered).toEqual(["band-lock", "five-g-pref", "gps", "ussd"]);
	});

	it("a build that ships nothing says so, instead of rendering an empty frame", async () => {
		getCapabilities.mockResolvedValue({
			gates: readGates(),
			implemented: [],
		});
		await open();
		await waitFor(() => {
			expect(screen.getByTestId("modem-capabilities-empty")).toBeTruthy();
		});
		expect(screen.queryByTestId("modem-capability-row-gps")).toBeNull();
	});
});

describe("the switch follows the DEVICE, not the click", () => {
	it("starts off for a device nobody has configured", async () => {
		await open();
		const toggle = await screen.findByTestId("modem-capability-toggle-gps");
		expect(toggle.getAttribute("aria-checked")).toBe("false");
	});

	it("moves only once the device reports what it persisted", async () => {
		setCapabilities.mockResolvedValue({
			success: true,
			applied: { ...ALL_OFF, gps: true },
		});
		await open();
		const toggle = await screen.findByTestId("modem-capability-toggle-gps");
		await fireEvent.click(toggle);
		await waitFor(() => {
			expect(setCapabilities).toHaveBeenCalledWith({
				module: "gps",
				enabled: true,
			});
		});
		await waitFor(() => {
			expect(
				screen
					.getByTestId("modem-capability-toggle-gps")
					.getAttribute("aria-checked"),
			).toBe("true");
		});
	});

	it("a device that persisted something ELSE is what the switch shows", async () => {
		// The device clamped the write: the operator asked for `gps`, the device
		// reports `gps` off and `band-lock` on. The UI must render device truth.
		setCapabilities.mockResolvedValue({
			success: true,
			applied: { ...ALL_OFF, "band-lock": true },
		});
		await open();
		const toggle = await screen.findByTestId("modem-capability-toggle-gps");
		await fireEvent.click(toggle);
		await waitFor(() => {
			expect(
				screen
					.getByTestId("modem-capability-toggle-band-lock")
					.getAttribute("aria-checked"),
			).toBe("true");
		});
		expect(
			screen
				.getByTestId("modem-capability-toggle-gps")
				.getAttribute("aria-checked"),
		).toBe("false");
	});
});

describe("a refusal is a device FACT, not an operation failure", () => {
	it("renders the calm band and never toasts", async () => {
		setCapabilities.mockResolvedValue({
			success: false,
			error: "module_not_implemented",
		});
		await open();
		const toggle = await screen.findByTestId("modem-capability-toggle-gps");
		await fireEvent.click(toggle);
		await waitFor(() => {
			expect(screen.getByTestId("modem-capabilities-refused")).toBeTruthy();
		});
		expect(toastError).not.toHaveBeenCalled();
	});

	it("the refused switch stays where it was", async () => {
		setCapabilities.mockResolvedValue({
			success: false,
			error: "module_not_implemented",
		});
		await open();
		const toggle = await screen.findByTestId("modem-capability-toggle-gps");
		await fireEvent.click(toggle);
		await waitFor(() => {
			expect(screen.getByTestId("modem-capabilities-refused")).toBeTruthy();
		});
		expect(
			screen
				.getByTestId("modem-capability-toggle-gps")
				.getAttribute("aria-checked"),
		).toBe("false");
	});

	it("the band is a status region, not an alert", async () => {
		setCapabilities.mockResolvedValue({
			success: false,
			error: "module_not_implemented",
		});
		await open();
		await fireEvent.click(
			await screen.findByTestId("modem-capability-toggle-gps"),
		);
		await waitFor(() => {
			expect(
				screen.getByTestId("modem-capabilities-refused").getAttribute("role"),
			).toBe("status");
		});
	});
});

describe("an unreadable device says so", () => {
	it("renders the read-failure band and no rows", async () => {
		getCapabilities.mockRejectedValue(new Error("socket closed"));
		await open();
		await waitFor(() => {
			expect(screen.getByTestId("modem-capabilities-load-failed")).toBeTruthy();
		});
		expect(screen.queryByTestId("modem-capability-row-gps")).toBeNull();
		// A failed READ must not claim the build ships nothing — that is a
		// different fact, with a different fix.
		expect(screen.queryByTestId("modem-capabilities-empty")).toBeNull();
	});
});

describe("the surface never implies the gate is a capability", () => {
	it("states that each modem is still checked on its own", async () => {
		await open();
		await waitFor(() => {
			expect(screen.getByTestId("modem-capabilities-honesty")).toBeTruthy();
		});
		expect(screen.getByTestId("modem-capabilities-honesty").textContent).toBe(
			m["settings.modemCapabilities.honesty"](),
		);
	});

	it("renders no honesty note when there is nothing to be honest about", async () => {
		getCapabilities.mockResolvedValue({
			gates: readGates(),
			implemented: [],
		});
		await open();
		await waitFor(() => {
			expect(screen.getByTestId("modem-capabilities-empty")).toBeTruthy();
		});
		expect(screen.queryByTestId("modem-capabilities-honesty")).toBeNull();
	});
});
