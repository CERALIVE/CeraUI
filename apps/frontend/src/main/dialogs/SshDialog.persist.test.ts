// @vitest-environment jsdom
/**
 * SshDialog — the boot-persistence toggle, and its independence from Start/Stop.
 *
 * A shipped bench board was measured `is-active: active` beside
 * `is-enabled: disabled`: SSH worked, the dialog said "Active", and it would have
 * vanished on the next reboot. The dialog now carries a SECOND control for the
 * second axis, and the owner's requirement is that the two stay SEPARATE — an
 * operator must still be able to run SSH for one session without committing it
 * to boot.
 *
 * Asserted against the RENDERED DOM rather than component internals, because
 * every one of these is a claim made to an operator:
 *
 *   1. Two distinct controls exist, and neither disables or moves the other.
 *   2. The persistence switch is PESSIMISTIC — it shows `ssh.enabled` from the
 *      device, never the click, so an RPC success alone cannot move it.
 *   3. `active && !enabled` — the exact silent-outage state — renders a standing
 *      advisory band, and no other combination does.
 */
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
import {
	publishSsh,
	resetSshFeed,
} from "../../tests/helpers/ssh-feed.svelte.js";
import SshDialog from "./SshDialog.svelte";

const sshStart = vi.hoisted(() => vi.fn());
const sshStop = vi.hoisted(() => vi.fn());
const sshSetPersistent = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

type SshSnapshot = {
	user: string;
	active: boolean;
	enabled: boolean;
	user_pass?: boolean;
};

vi.mock("$lib/rpc/client", () => ({
	rpc: { system: { sshStart, sshStop, sshSetPersistent } },
}));

// The rune-backed double: the real getSsh() reads a $state, so a plain mutable
// object would leave the dialog's $derived inert and every pessimistic assertion
// below would pass vacuously.
vi.mock("$lib/rpc/subscriptions.svelte", async () => {
	const { getSshFeed: read } = await import(
		"../../tests/helpers/ssh-feed.svelte.js"
	);
	return {
		getSsh: read,
		getConfig: () => ({ ssh_pass: "hunter2" }),
	};
});

vi.mock("svelte-sonner", () => ({
	toast: { error: toastError, success: vi.fn() },
}));

vi.mock("$lib/helpers/SystemHelper", () => ({
	resetSSHPasword: vi.fn(),
}));

function publish(next: Partial<SshSnapshot>): void {
	publishSsh({
		user: "ceralive",
		active: false,
		enabled: false,
		user_pass: true,
		...next,
	});
}

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
	if (!window.HTMLElement.prototype.hasPointerCapture) {
		window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
	}
	initAsyncOperations();
});

beforeEach(() => {
	sshStart.mockReset();
	sshStop.mockReset();
	sshSetPersistent.mockReset();
	toastError.mockReset();
	sshStart.mockResolvedValue({ success: true });
	sshStop.mockResolvedValue({ success: true });
	sshSetPersistent.mockResolvedValue({ success: true });
	resetSshFeed();
	publish({});
});

afterEach(() => {
	destroyAsyncOperations();
	initAsyncOperations();
});

async function open(snapshot: Partial<SshSnapshot> = {}) {
	publish(snapshot);
	render(SshDialog, { props: { open: true } });
	await waitFor(() => {
		expect(screen.getByTestId("ssh-persist-toggle")).toBeTruthy();
	});
}

function persistToggle(): HTMLElement {
	return screen.getByTestId("ssh-persist-toggle");
}

function serviceButton(): HTMLElement {
	// The Start/Stop control is the dialog's only <button> carrying the
	// start/stop copy; matched by role so a testid rename cannot make this
	// assertion silently stop finding it.
	return screen.getByRole("button", { name: /SSH Server/i });
}

describe("two controls, two axes", () => {
	it("renders a persistence switch SEPARATE from the Start/Stop button", async () => {
		await open({ active: true, enabled: false });

		const toggle = persistToggle();
		const button = serviceButton();

		expect(toggle).toBeTruthy();
		expect(button).toBeTruthy();
		// Distinct elements, and neither contains the other.
		expect(toggle).not.toBe(button);
		expect(button.contains(toggle)).toBe(false);
		expect(toggle.contains(button)).toBe(false);
	});

	it("the persistence switch drives sshSetPersistent — never start/stop", async () => {
		await open({ active: true, enabled: false });

		await fireEvent.click(persistToggle());

		await waitFor(() => {
			expect(sshSetPersistent).toHaveBeenCalledWith({ enabled: true });
		});
		expect(sshStart).not.toHaveBeenCalled();
		expect(sshStop).not.toHaveBeenCalled();
	});

	it("turning persistence OFF disables boot arming, and still not the service", async () => {
		await open({ active: true, enabled: true });

		await fireEvent.click(persistToggle());

		await waitFor(() => {
			expect(sshSetPersistent).toHaveBeenCalledWith({ enabled: false });
		});
		expect(sshStop).not.toHaveBeenCalled();
	});

	it("the Start/Stop button drives start/stop — never sshSetPersistent", async () => {
		await open({ active: false, enabled: true });

		await fireEvent.click(serviceButton());

		await waitFor(() => {
			expect(sshStart).toHaveBeenCalled();
		});
		expect(sshSetPersistent).not.toHaveBeenCalled();
	});

	it("a pending persistence op does NOT disable the Start/Stop button", async () => {
		// Never resolves: the persistence op stays in flight for the assertion.
		sshSetPersistent.mockReturnValue(new Promise(() => {}));
		await open({ active: true, enabled: false });

		await fireEvent.click(persistToggle());

		await waitFor(() => {
			expect(persistToggle().hasAttribute("disabled")).toBe(true);
		});
		// The two controls own separate async-operation keys, so one in flight
		// must never refuse the other.
		expect(serviceButton().hasAttribute("disabled")).toBe(false);
	});
});

describe("the switch follows the DEVICE, not the click", () => {
	it("reflects ssh.enabled on arrival, in both directions", async () => {
		await open({ enabled: true });
		expect(persistToggle().getAttribute("aria-checked")).toBe("true");

		publish({ enabled: false });
		await waitFor(() => {
			expect(persistToggle().getAttribute("aria-checked")).toBe("false");
		});
	});

	it("an RPC success ALONE does not move it — the broadcast does", async () => {
		await open({ active: true, enabled: false });

		await fireEvent.click(persistToggle());
		await waitFor(() => {
			expect(sshSetPersistent).toHaveBeenCalled();
		});

		// The device has not spoken yet: the switch must still read its last
		// authoritative value.
		expect(persistToggle().getAttribute("aria-checked")).toBe("false");

		publish({ active: true, enabled: true });
		await waitFor(() => {
			expect(persistToggle().getAttribute("aria-checked")).toBe("true");
		});
	});

	it("a refused write leaves the switch where the device left it", async () => {
		sshSetPersistent.mockResolvedValue({ success: false });
		await open({ active: true, enabled: false });

		await fireEvent.click(persistToggle());
		await waitFor(() => {
			expect(sshSetPersistent).toHaveBeenCalled();
		});

		expect(persistToggle().getAttribute("aria-checked")).toBe("false");
	});
});

describe("the silent outage is made visible", () => {
	it("bands a device that is running but not armed for boot", async () => {
		await open({ active: true, enabled: false });
		const band = await screen.findByTestId("ssh-persist-warning");
		expect(band.getAttribute("role")).toBe("status");
		expect(band.textContent?.trim().length).toBeGreaterThan(0);
	});

	it("says nothing when the two axes agree, or when SSH is stopped", async () => {
		await open({ active: true, enabled: true });
		expect(screen.queryByTestId("ssh-persist-warning")).toBeNull();

		publish({ active: false, enabled: false });
		await waitFor(() => {
			expect(persistToggle().getAttribute("aria-checked")).toBe("false");
		});
		expect(screen.queryByTestId("ssh-persist-warning")).toBeNull();

		// Armed for boot but stopped right now is a legitimate operator state.
		publish({ active: false, enabled: true });
		await waitFor(() => {
			expect(persistToggle().getAttribute("aria-checked")).toBe("true");
		});
		expect(screen.queryByTestId("ssh-persist-warning")).toBeNull();
	});

	it("clears the moment the operator arms boot persistence", async () => {
		await open({ active: true, enabled: false });
		expect(screen.getByTestId("ssh-persist-warning")).toBeTruthy();

		publish({ active: true, enabled: true });
		await waitFor(() => {
			expect(screen.queryByTestId("ssh-persist-warning")).toBeNull();
		});
	});
});
