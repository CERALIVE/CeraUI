import fs from "node:fs";
import path from "node:path";

import type { Locator, Page, WebSocketRoute } from "@playwright/test";

import { expect, test } from "../fixtures/index.js";
import { ensureAuthenticated, navigateTo, setLocale } from "../helpers/index.js";
import { openModemAdvanced } from "../helpers/modem-advanced.js";
import {
	expectContained,
	KIOSK_VIEWPORT,
	probeContainment,
	probeDialogOverflow,
	settleDestination,
} from "../helpers/modem-containment.js";

/**
 * `DESIGN.md` Pass 4 — the CONFIRMING round for the modem / cellular surfaces.
 *
 * It introduces no rule. Passes 1-3 decided what these surfaces render (§1 the
 * capability-truth matrix, §2 hierarchy, §3 operator labels), at what widths
 * (§4), and in which catalogs (§5); this walks every state class those passes
 * produced across every mandatory width and three catalogs, asserts the same
 * contract in a real browser, and writes the evidence set the pass's stop
 * condition names.
 *
 * The PNGs are EVIDENCE, never the check — nothing here passes or fails on how
 * a capture looks. Every capture is gated first by:
 *
 *   · the SHARED containment probe (`helpers/modem-containment.ts`, pass 3's,
 *     not a copy) — BP-1/BP-2 plus the LO-1 unresolved-key scan;
 *   · a per-surface scan proving no raw USB-composition or band token reached
 *     operator copy with the marked diagnostics blocks removed (OL-1/OL-2/OL-4);
 *   · for a dialog, that no card is laid out outside the dialog's own box.
 *
 * Determinism mirrors `modem-ux.visual.spec.ts`: the page socket is proxied and
 * the backend's own `status`/`config`/`netif`/`modems` echoes are dropped, so
 * the injected roster is the only truth on screen.
 */

// visual -> e2e -> tests -> frontend -> apps -> CeraUI (repo root). Repo-local
// and gitignored; tests never write above the checkout (root AGENTS.md Rule D).
const EVIDENCE_DIR = path.resolve(
	import.meta.dirname,
	"../../../../../test-results/design-pass4/34",
);

let pageWs: WebSocketRoute | null = null;

function send(payload: unknown): void {
	pageWs?.send(JSON.stringify(payload));
}

function serverConfig(extra: Record<string, unknown> = {}): void {
	send({
		config: {
			srtla_addr: "127.0.0.1",
			srtla_port: 5000,
			srt_streamid: "e2e",
			max_br: 6000,
			pipeline: "hdmi",
			modem_provisioning: true,
			...extra,
		},
	});
}

/**
 * The readiness flag rides EVERY frame as an explicit boolean, exactly as the
 * backend publishes it. The frontend status merge preserves an omitted field, so
 * a fixture that only ever raised it would leave the initializing band latched
 * over every surface captured after it.
 */
function sendModems(modems: Record<string, unknown>): void {
	send({ status: { cellular_initializing: false, modems } });
}

const MM_MODEM_ID = "pass4-mm";
const MM_MODEM_NAME = "Quectel RM520N";

function mmManaged(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		ifname: "wwan0",
		name: MM_MODEM_NAME,
		network_type: { supported: ["5g", "lte"], active: "lte" },
		config: {
			apn: "internet",
			username: "",
			password: "",
			roaming: false,
			network: "",
			autoconfig: true,
		},
		status: {
			connection: "connected",
			network_type: "lte",
			signal: 71,
			roaming: false,
			network: "Test Carrier",
		},
		no_sim: false,
		device_class: "usb",
		slot_label: "SIM 1",
		stable_key: "pci-0000:00:14.0-usb-0:2",
		usb_mode: "rndis",
		recommended_usb_mode: "mbim",
		firmware_revision: "RM520NGLAAR01A08M4G",
		cell_info: {
			tech: "nr",
			band: "ngran-78",
			cell_id: "0x1A2B3C",
			rsrp: -92,
			rsrq: -11,
			sinr: 18,
			provenance: { source: "qmi", observed_at: 1_770_000_000 },
		},
		esim: { sim_type: "esim", esim_status: "with-profiles" },
		data_usage: {
			session_bytes: 1_572_864,
			cycle_bytes: 3_221_225_472,
			cycle_day: 17,
			threshold_bytes: 10_737_418_240,
		},
		...extra,
	};
}

function routerDongle(
	availability_reason: "router_managed" | "dongle_acquiring" | "dongle_down",
	slot: number,
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		ifname: `dg${slot}h`,
		name: `Cellular dongle ${slot}`,
		network_type: { supported: [], active: null },
		device_class: "router-ethernet",
		availability_reason,
		slot_label: `Dongle ${slot}`,
		...extra,
	};
}

/** Every row class UI pass 1 taught this section to render, in one roster. */
function fullRoster(): Record<string, unknown> {
	return {
		[MM_MODEM_ID]: mmManaged(),
		"pass4-registering": mmManaged({
			ifname: "wwan1",
			name: "Fibocom FM350",
			device_class: "pcie-mhi",
			slot_label: "SIM 2",
			stable_key: "pci-0000:01:00.0",
			status: { connection: "registered", network_type: "5g", signal: 35, roaming: true },
		}),
		"pass4-locked": mmManaged({
			ifname: "wwan2",
			name: "Sierra EM9191",
			device_class: "soc-qrtr",
			slot_label: "SIM 3",
			stable_key: "pci-0000:00:14.0-usb-0:4",
			status: undefined,
			sim_lock: { required: "sim-pin", remainingAttempts: 3 },
		}),
		"pass4-dongle-up": routerDongle("router_managed", 0),
		"pass4-dongle-acquiring": routerDongle("dongle_acquiring", 1),
		"pass4-dongle-down": routerDongle("dongle_down", 2),
		"pass4-unmanaged": {
			ifname: "wwx0",
			name: "Unrecognised WWAN",
			network_type: { supported: [], active: null },
			device_class: "thunderbolt-wwan",
		},
	};
}

/** The SIM-less pair — one per class, so the shared tag is compared to itself. */
function simlessRoster(): Record<string, unknown> {
	return {
		[MM_MODEM_ID]: mmManaged({ no_sim: true, status: undefined }),
		"pass4-dongle-nosim": routerDongle("router_managed", 0, {
			router_admin: { sim: "absent", connection: "disconnected" },
		}),
	};
}

const DONGLE_NETIF: Record<string, unknown> = {
	eth0: { ip: "192.168.1.50", tp: 0, enabled: true },
	dg0h: { ip: "10.208.0.1", tp: 0, enabled: true, dongle: { slot: 0, state: "up" } },
	dg1h: { tp: 0, enabled: false, dongle: { slot: 1, state: "acquiring" } },
	dg2h: { tp: 0, enabled: false, dongle: { slot: 2, state: "down" } },
};

const cellularSection = (page: Page): Locator =>
	page.locator("section").filter({ has: page.getByTestId("modem-row") }).first();

const modemRow = (page: Page, id: string): Locator =>
	page.locator(`[data-testid="modem-row"][data-modem-id="${id}"]`);

/**
 * The engine vocabularies §3 relocates. Every one of them must be reachable in
 * a marked diagnostics block and unreachable anywhere else on the surface.
 */
const RAW_TOKENS = [
	"rndis",
	"mbim",
	"ecm-ncm",
	"hilink",
	"ngran-78",
	"eutran-",
	"router_managed",
	"dongle_acquiring",
	"dongle_down",
	"thunderbolt-wwan",
];

const DOTTED_KEY_RE =
	/\b(?:network|settings|live|hud|advanced|connection|a11y)(?:\.[a-z][a-zA-Z0-9_]*){2,}\b/;

/**
 * Operator-facing text of one surface, with every marked diagnostics subtree
 * removed. Scrubbed by SELECTOR (§3 OL-4), so the scan never has to enumerate
 * which field ids happen to carry a raw value.
 */
async function operatorText(surface: Locator): Promise<string> {
	return surface.evaluate((node) => {
		const clone = node.cloneNode(true) as HTMLElement;
		for (const el of clone.querySelectorAll('[data-testid*="diagnostic"]')) {
			el.remove();
		}
		return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
	});
}

/**
 * §2 IH-1, in the SAME vocabulary pass 1 gated it with
 * (`CellularSection.hierarchy.test.ts`): a hardware tag marks itself
 * `data-hardware-tag`, and none may precede the first state / signal / action
 * element in DOM order. Reusing pass 1's two selector sets verbatim is what
 * makes this a confirmation rather than a second, differently-worded rule.
 */
const STATE_SIGNAL_ACTION = [
	'[data-testid="modem-state-badge"]',
	'[data-testid="modem-carrier-badge"]',
	'[data-testid="modem-roaming-badge"]',
	'[data-testid="modem-signal"]',
	'[data-testid="modem-router-signal"]',
	'[data-testid="modem-router-signal-state"]',
	'[data-testid="modem-details-toggle"]',
	'[data-testid="open-modem-config-dialog"]',
	'[data-testid="open-modem-unlock-dialog"]',
	"[data-no-sim]",
].join(",");

function probeHierarchy(page: Page): Promise<string[]> {
	return page.evaluate((primarySelector) => {
		const out: string[] = [];
		for (const row of document.querySelectorAll('[data-testid="modem-row"]')) {
			const all = [...row.querySelectorAll("*")];
			const firstPrimary = all.findIndex((el) => el.matches(primarySelector));
			const firstTag = all.findIndex((el) => el.matches("[data-hardware-tag]"));
			const id = row.getAttribute("data-modem-id");
			if (firstPrimary < 0) {
				out.push(`${id}: renders no state/signal/action element at all`);
				continue;
			}
			if (firstTag >= 0 && firstTag < firstPrimary) {
				out.push(`${id}: hardware tag at DOM index ${firstTag} precedes ${firstPrimary}`);
			}
		}
		return out;
	}, STATE_SIGNAL_ACTION);
}

/**
 * No app chrome permanently owns a row action's pixels.
 *
 * This exists because the evidence PNG cannot answer the question: the mobile
 * chrome is a FIXED bottom dock, and an element screenshot of a
 * taller-than-viewport section re-composites that dock into every stitched tile,
 * so the capture shows it crossing the roster at points where nothing on screen
 * ever does. `<main>` reserves `--mobile-dock-height` for the dock, and this
 * measures that claim instead of reading it off a picture.
 *
 * Three details are load-bearing, and the first two were found by this probe
 * failing on its own defects rather than on the product's:
 *
 *   · scroll to the viewport CENTRE, not merely "into view". The header is
 *     `sticky top-0 z-40`, and Playwright's `scrollIntoViewIfNeeded` counts an
 *     element sitting UNDER it as already visible — so the first row's enabled
 *     Configure was hit-tested beneath the header and reported a header button.
 *   · a hit landing anywhere inside the SAME row is `self`. The shadcn button
 *     base carries `disabled:pointer-events-none`, so a disabled control
 *     structurally cannot answer a hit test and the fall-through lands on its
 *     own row. That proves nothing is layered ABOVE it, which is the claim; a
 *     dock or a modal scrim is not inside the row and still reddens.
 *   · `null` is a distinct verdict. `hit?.closest(...)` is truthy for `null`, so
 *     the obvious boolean form would pass vacuously off-viewport.
 */
async function probeRowReachability(page: Page): Promise<string[]> {
	const rows = page.getByTestId("modem-row");
	const count = await rows.count();
	const blocked: string[] = [];
	for (let index = 0; index < count; index++) {
		const row = rows.nth(index);
		const action = row
			.locator(
				'[data-testid="open-modem-config-dialog"],[data-testid="open-modem-unlock-dialog"]',
			)
			.first();
		if ((await action.count()) === 0) continue;
		const verdict = await row.evaluate((rowEl) => {
			const el = rowEl.querySelector<HTMLElement>(
				'[data-testid="open-modem-config-dialog"],[data-testid="open-modem-unlock-dialog"]',
			);
			if (el === null) return "self";
			el.scrollIntoView({ block: "center", behavior: "auto" });
			const rect = el.getBoundingClientRect();
			const hit = document.elementFromPoint(
				rect.left + rect.width / 2,
				rect.top + rect.height / 2,
			);
			if (hit === null) return "hit nothing";
			if (rowEl.contains(hit)) return "self";
			const owner = hit.closest("[data-testid]");
			return `occluded by ${owner?.getAttribute("data-testid") ?? hit.tagName}`;
		});
		if (verdict !== "self") {
			blocked.push(`${await row.getAttribute("data-modem-id")}: ${verdict}`);
		}
	}
	return blocked;
}

type SurfaceKind = "section" | "dialog";

type StagedSurface = {
	readonly shot: Locator;
	readonly kind: SurfaceKind;
};

type SurfaceDef = {
	readonly id: string;
	/** Whether this surface carries modem rows, which BP-2 is measured against. */
	readonly hasRows: boolean;
	readonly stage: (page: Page) => Promise<StagedSurface>;
};

async function openDialog(page: Page, advanced: boolean): Promise<StagedSurface> {
	const configure = modemRow(page, MM_MODEM_ID).getByTestId(
		"open-modem-config-dialog",
	);
	await expect(configure).toBeEnabled({ timeout: 15_000 });
	await configure.click();
	const dialog = page.getByRole("dialog", { name: MM_MODEM_NAME });
	await expect(dialog).toBeVisible({ timeout: 15_000 });
	if (advanced) {
		await openModemAdvanced(dialog);
		await expect(dialog.getByTestId("modem-usb-mode-card")).toBeVisible();
	}
	return { shot: dialog, kind: "dialog" };
}

async function stageCapabilityDialog(
	page: Page,
	claim: string | undefined,
): Promise<StagedSurface> {
	sendModems({
		[MM_MODEM_ID]: mmManaged({
			capability_modules:
				claim === undefined ? undefined : { "fcc-auto-unlock": claim, gps: claim },
		}),
	});
	await expect(modemRow(page, MM_MODEM_ID)).toBeVisible({ timeout: 15_000 });
	return openDialog(page, true);
}

const DONGLE_LOCK_ID = "pass4-dongle-lock";

type WireLockState = "open" | "locked" | "unlocked" | "auth-failed" | "locked-out";

/**
 * A locked dongle exists on no bench and in no mock scenario — every dialect
 * answers unauthenticated, so `open` is the only state hardware has ever
 * produced. The roster is injected for the same reason, and in the same shape,
 * as `modem-credential-unlock.spec.ts` injects its own.
 */
function lockDongle(
	lock: WireLockState,
	options: { controls?: boolean; lockoutUntil?: number } = {},
): Record<string, unknown> {
	return {
		ifname: "enx0c5b8f279a64",
		name: "Huawei E3372",
		network_type: { supported: [], active: null },
		device_class: "router-ethernet",
		availability_reason: "router_direct",
		slot_label: "Dongle 1",
		lock_state: lock,
		lock_detail: {
			credential_configured: lock !== "locked" && lock !== "open",
			...(options.lockoutUntil === undefined
				? {}
				: { lockout_until: options.lockoutUntil }),
		},
		router_admin: {
			admin_url: "http://192.168.8.1",
			reachable: true,
			model: "E3372",
			...(options.controls === true
				? { controls: { mobile_data: false, roaming_autoconnect: false } }
				: {}),
		},
	};
}

async function stageLock(
	page: Page,
	lock: WireLockState,
	options: { controls?: boolean; lockoutUntil?: number } = {},
): Promise<StagedSurface> {
	sendModems({ [DONGLE_LOCK_ID]: lockDongle(lock, options) });
	const row = modemRow(page, DONGLE_LOCK_ID);
	await expect(row).toBeVisible({ timeout: 15_000 });

	// A lock must not disable the one control that opens the surface carrying
	// the login — the reachability half of todo 22's contract, re-measured here
	// at every width rather than assumed from the functional spec's one.
	const configure = row.getByTestId("open-modem-config-dialog");
	await expect(configure).toBeEnabled({ timeout: 15_000 });
	await configure.click();

	const dialog = page.getByRole("dialog").first();
	await expect(dialog).toBeVisible({ timeout: 15_000 });
	await expect(dialog.getByTestId("dongle-lock-body")).toHaveAttribute(
		"data-lock-state",
		lock,
	);
	return { shot: dialog, kind: "dialog" };
}

/**
 * Every state class passes 1-3 produced on these surfaces. Ordered so the
 * section classes are captured before any dialog opens over them.
 */
const SURFACES: readonly SurfaceDef[] = [
	{
		id: "roster",
		hasRows: true,
		stage: async (page) => {
			sendModems(fullRoster());
			send({ netif: DONGLE_NETIF });
			const section = cellularSection(page);
			await expect(section).toBeVisible({ timeout: 15_000 });
			await expect(page.getByTestId("modem-row")).toHaveCount(7);
			return { shot: section, kind: "section" };
		},
	},
	{
		id: "no-sim",
		hasRows: true,
		stage: async (page) => {
			sendModems(simlessRoster());
			const section = cellularSection(page);
			await expect(section).toBeVisible({ timeout: 15_000 });
			await expect(page.getByTestId("modem-row")).toHaveCount(2);
			await expect(section.locator("[data-no-sim='true']")).toHaveCount(2);
			return { shot: section, kind: "section" };
		},
	},
	{
		id: "initializing",
		hasRows: false,
		stage: async (page) => {
			send({ status: { cellular_initializing: true, modems: {} } });
			const band = page.getByTestId("cellular-initializing");
			await expect(band).toBeVisible({ timeout: 15_000 });
			await expect(band).toHaveAttribute("role", "status");
			return { shot: band, kind: "section" };
		},
	},
	{
		id: "dialog-primary",
		hasRows: true,
		stage: async (page) => {
			sendModems({ [MM_MODEM_ID]: mmManaged() });
			await expect(modemRow(page, MM_MODEM_ID)).toBeVisible({ timeout: 15_000 });
			return openDialog(page, false);
		},
	},
	{
		id: "dialog-advanced",
		hasRows: true,
		stage: async (page) => {
			sendModems({ [MM_MODEM_ID]: mmManaged() });
			await expect(modemRow(page, MM_MODEM_ID)).toBeVisible({ timeout: 15_000 });
			return openDialog(page, true);
		},
	},
];

/** The §1 render modes, each staged from the claim that produces it. */
const CAPABILITY_SURFACES: readonly SurfaceDef[] = [
	{
		id: "capability-absent",
		hasRows: true,
		stage: async (page) => {
			const staged = await stageCapabilityDialog(page, "unavailable");
			await expect(page.getByTestId("modem-fcc-unlock")).toHaveCount(0);
			await expect(page.getByTestId("modem-gps")).toHaveCount(0);
			return staged;
		},
	},
	{
		id: "capability-unknown",
		hasRows: true,
		stage: async (page) => {
			const staged = await stageCapabilityDialog(page, "enabled");
			await expect(page.getByTestId("modem-fcc-unlock-unknown")).toBeVisible();
			await expect(page.getByTestId("modem-gps-unknown")).toBeVisible();
			return staged;
		},
	},
	{
		id: "capability-offered",
		hasRows: true,
		stage: async (page) => {
			const staged = await stageCapabilityDialog(page, "certified");
			await expect(page.getByTestId("modem-fcc-unlock")).toBeVisible();
			await expect(page.getByTestId("modem-gps")).toBeVisible();
			return staged;
		},
	},
];

/**
 * The dongle credential surface — six render classes, and every one of them
 * differs in what it OFFERS rather than only in its wording, which is why they
 * are captured apart. `clear-armed` is the newest: todo 34 gave the one
 * irreversible action here an inline confirmation, and nothing had ever
 * photographed it.
 */
const LOCK_SURFACES: readonly SurfaceDef[] = [
	{
		id: "lock-open",
		hasRows: true,
		stage: async (page) => {
			// `controls` is not decoration here. Configure is refused whenever no
			// write to this dongle was ever proven, and only a LOCK overrides that
			// — so an `open` dongle without them cannot reach its own dialog.
			const staged = await stageLock(page, "open", { controls: true });
			// The common case on this fleet, so the absence is the assertion: a
			// prompt where there is no password is the dishonesty todo 22 removed.
			await expect(page.getByTestId("dongle-lock-form")).toHaveCount(0);
			return staged;
		},
	},
	{
		id: "lock-locked",
		hasRows: true,
		stage: async (page) => {
			const staged = await stageLock(page, "locked");
			await expect(page.getByTestId("dongle-lock-password")).toBeVisible();
			await expect(page.getByTestId("dongle-no-controls")).toHaveAttribute(
				"data-locked",
				"true",
			);
			return staged;
		},
	},
	{
		id: "lock-auth-failed",
		hasRows: true,
		stage: async (page) => {
			const staged = await stageLock(page, "auth-failed");
			await expect(page.getByTestId("dongle-lock-password")).toBeVisible();
			return staged;
		},
	},
	{
		id: "lock-locked-out",
		hasRows: true,
		stage: async (page) => {
			const staged = await stageLock(page, "locked-out", {
				lockoutUntil: Date.now() + 300_000,
			});
			await expect(page.getByTestId("dongle-lock-wait")).toBeVisible();
			// A retry here spends an attempt the operator cannot get back.
			await expect(page.getByTestId("dongle-lock-submit")).toHaveCount(0);
			return staged;
		},
	},
	{
		id: "lock-unlocked",
		hasRows: true,
		stage: async (page) => {
			const staged = await stageLock(page, "unlocked", { controls: true });
			await expect(page.getByTestId("dongle-controls")).toBeVisible();
			return staged;
		},
	},
	{
		id: "lock-clear-armed",
		hasRows: true,
		stage: async (page) => {
			const staged = await stageLock(page, "unlocked", { controls: true });
			await page.getByTestId("dongle-lock-clear").click();
			await expect(page.getByTestId("dongle-lock-clear-confirm")).toBeVisible();
			await expect(page.getByTestId("dongle-lock-clear-apply")).toBeVisible();
			return staged;
		},
	},
];

/**
 * The kiosk leg and the on-disk completeness leg walk the SAME set. They were
 * two copies of one literal, which is one edit away from a capture the
 * completeness check does not know to demand.
 */
const KIOSK_SURFACES: readonly SurfaceDef[] = [
	...SURFACES,
	...CAPABILITY_SURFACES,
	...LOCK_SURFACES,
];

async function closeAnyDialog(page: Page): Promise<void> {
	if ((await page.getByRole("dialog").count()) === 0) return;
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog")).toHaveCount(0);
}

/**
 * Stage one surface at one viewport, gate it, and write its evidence PNG.
 *
 * The viewport is set BEFORE the surface is staged rather than resized under an
 * open dialog: `AppDialog` renders a centred Dialog above the desktop breakpoint
 * and a bottom Sheet below it, so a resize swaps the surface mid-capture and the
 * shot would belong to neither.
 */
async function captureSurface(
	page: Page,
	surface: SurfaceDef,
	viewport: { width: number; height: number },
	label: string,
	fileName: string,
): Promise<void> {
	await closeAnyDialog(page);
	await page.setViewportSize(viewport);
	const staged = await surface.stage(page);
	await settleDestination(page);

	const measured = await probeContainment(page);
	if (surface.hasRows) {
		expectContained(measured, label);

		const misordered = await probeHierarchy(page);
		expect(misordered, `${label}: IH-1 violated:\n${misordered.join("\n")}`).toEqual(
			[],
		);

		const blocked = await probeRowReachability(page);
		if (staged.kind === "section") {
			expect(
				blocked,
				`${label}: a row action does not own its own pixels:\n${blocked.join("\n")}`,
			).toEqual([]);
		} else {
			// The same probe against a state where occlusion is REAL and expected:
			// a modal scrim does own every row beneath it. Without this the empty
			// result above could equally mean the probe detects nothing at all.
			expect(
				blocked.length,
				`${label}: the modal scrim did not occlude the rows, so the reachability probe is vacuous`,
			).toBeGreaterThan(0);
		}
	} else {
		// BP-1 still applies; the row-scoped rules do not, so they are not
		// asserted vacuously against an empty roster.
		expect(
			measured.documentOverflowPx,
			`${label}: the document overflows horizontally by ${measured.documentOverflowPx}px. Widest offenders:\n${measured.overflowSources.join("\n")}`,
		).toBeLessThanOrEqual(1);
	}

	if (staged.kind === "dialog") {
		const escaped = await probeDialogOverflow(page);
		expect(
			escaped,
			`${label}: dialog content escapes the dialog: ${escaped.join(", ")}`,
		).toEqual([]);
	}

	const text = await operatorText(staged.shot);
	expect(text.length, `${label}: the surface rendered no text`).toBeGreaterThan(0);
	expect(
		DOTTED_KEY_RE.test(text),
		`${label}: an unresolved i18n key reached the surface: ${text.match(DOTTED_KEY_RE)?.[0]}`,
	).toBe(false);
	const lowered = text.toLowerCase();
	for (const token of RAW_TOKENS) {
		expect(lowered, `${label}: raw wire token "${token}" reached operator copy`).not.toContain(
			token,
		);
	}

	await staged.shot.screenshot({ path: path.join(EVIDENCE_DIR, fileName) });
}

/**
 * Re-enter the Network destination under `locale`.
 *
 * The reload is what applies the locale, and it re-arms the cold-start hazard
 * `ensureAuthenticated` documents: past ~5s to mount, `index.html` reveals a
 * full-screen `#js-failed` overlay that never hides again and swallows every
 * click.
 */
async function enterNetworkAs(page: Page, locale: string): Promise<void> {
	await setLocale(page, locale);
	await page.reload();
	await page
		.waitForFunction(
			() => (window as { __ceraAppMounted?: boolean }).__ceraAppMounted === true,
			undefined,
			{ timeout: 60_000 },
		)
		.catch(() => undefined);
	await page.evaluate(() => document.getElementById("js-failed")?.remove());
	await navigateTo(page, "network");
	serverConfig();
}

/** `DESIGN.md` §4 — the three mandatory verification widths. */
const BREAKPOINTS = [
	{ width: 375, height: 812 },
	{ width: 768, height: 1024 },
	{ width: 1280, height: 800 },
] as const;

/**
 * `en` is the full state-class sweep; `ar` (RTL) and `ja` (CJK) confirm the
 * catalog-sensitive half. The capability and lock renderings are driven by a
 * claim and a lock state rather than by a catalog, so they are captured once in
 * the base locale — the per-locale gate that matters for them is their own copy
 * sweep (`modem-a11y`'s ten catalogs, and `modem-lock-copy-completeness`, which
 * additionally proves the six lock sentences are DISTINCT inside every locale).
 * This pass does not duplicate either.
 */
const LOCALE_SURFACES: Record<string, readonly SurfaceDef[]> = {
	en: [...SURFACES, ...CAPABILITY_SURFACES, ...LOCK_SURFACES],
	ar: SURFACES,
	ja: SURFACES,
};

test.describe("@visual DESIGN.md pass 4 — modem surface confirmation", () => {
	test.describe.configure({ mode: "serial" });

	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(
			testInfo.project.name !== "desktop",
			"the capture drives its own viewports; run once",
		);

		pageWs = null;
		fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

		await page.routeWebSocket(/:(3002|31\d\d|6173|8090|8091)\//, (ws) => {
			pageWs = ws;
			const server = ws.connectToServer();

			ws.onMessage((m) => {
				server.send(m);
			});

			server.onMessage((m) => {
				const text = typeof m === "string" ? m : m.toString();
				try {
					const frame = JSON.parse(text) as object;
					if ("status" in frame) return;
					if ("config" in frame) return;
					if ("netif" in frame) return;
					if ("modems" in frame) return;
				} catch {
					/* non-JSON / binary frame */
				}
				ws.send(m);
			});
		});
	});

	for (const [locale, surfaces] of Object.entries(LOCALE_SURFACES)) {
		test(`every modem state class holds at 375, 768 and 1280 under ${locale}`, {
			tag: "@visual",
		}, async ({ authedPage: page }) => {
			test.setTimeout(300_000);
			await enterNetworkAs(page, locale);

			if (locale === "ar") {
				await expect
					.poll(() => page.evaluate(() => document.documentElement.dir))
					.toBe("rtl");
			}

			for (const surface of surfaces) {
				for (const viewport of BREAKPOINTS) {
					await captureSurface(
						page,
						surface,
						viewport,
						`${locale} ${surface.id} @ ${viewport.width}x${viewport.height}`,
						`${surface.id}-${locale}-${viewport.width}.png`,
					);
				}
			}
			await closeAnyDialog(page);
		});
	}

	test("every modem state class holds on the 1024x600 kiosk in touch layout", {
		tag: "@visual",
	}, async ({ page }) => {
		test.setTimeout(300_000);

		// `data-layout-mode` must be set BEFORE first paint: applying it afterwards
		// captures the pre-lift geometry (32px where the at-load path measures 44).
		await page.setViewportSize(KIOSK_VIEWPORT);
		await page.goto("/?mode=touch");
		await ensureAuthenticated(page);
		await expect(page.locator("html")).toHaveAttribute("data-layout-mode", "touch");
		await navigateTo(page, "network");
		serverConfig();

		for (const surface of KIOSK_SURFACES) {
			await captureSurface(
				page,
				surface,
				KIOSK_VIEWPORT,
				`kiosk-touch ${surface.id} @ 1024x600`,
				`${surface.id}-kiosk-touch-1024.png`,
			);
		}
		await closeAnyDialog(page);
	});

	test("the capture set the pass-4 stop condition names is complete on disk", {
		tag: "@visual",
	}, async () => {
		// The stop condition is "screenshots EXIST for …", so it is asserted as a
		// fact about the evidence directory rather than inferred from the legs
		// above having passed.
		const expected: string[] = [];
		for (const [locale, surfaces] of Object.entries(LOCALE_SURFACES)) {
			for (const surface of surfaces) {
				for (const viewport of BREAKPOINTS) {
					expected.push(`${surface.id}-${locale}-${viewport.width}.png`);
				}
			}
		}
		for (const surface of KIOSK_SURFACES) {
			expected.push(`${surface.id}-kiosk-touch-1024.png`);
		}

		const present = new Set(
			fs.existsSync(EVIDENCE_DIR) ? fs.readdirSync(EVIDENCE_DIR) : [],
		);
		const missing = expected.filter((name) => !present.has(name));
		expect(
			missing,
			`pass-4 evidence missing from ${EVIDENCE_DIR}:\n${missing.join("\n")}`,
		).toEqual([]);
	});
});
