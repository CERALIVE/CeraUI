import type { Locator, Page } from "@playwright/test";
import type { UpdateOrchestratorPhase } from "@ceraui/rpc/schemas";

import { expect, test } from "../fixtures/index.js";
import { runAxe } from "../helpers/axe.js";
import { ensureAuthenticated, evidencePath, navigateTo } from "../helpers/index.js";
import {
	CAPABLE_CAPABILITIES,
	capableDetails,
	installUpdateWire,
	KERNEL_CAPABILITIES,
	kernelDetails,
	orchestratorState,
} from "../helpers/update-wire.js";

const COPY = {
	en: {
		title: "Kernel",
		dialog: "Software Updates",
		install: "Install kernel now",
		staged: "Applies on the next idle restart",
		unknown: "The kernel update status could not be established.",
		generic: "The device could not confirm the kernel update. Open Settings → System Logs for details.",
		bootFailed: "The new kernel did not pass its boot health check.",
		phases: ["Downloading kernel", "Preparing kernel", "Kernel ready", "Kernel updated", "Verifying new kernel", "Previous kernel restored", "Kernel update failed"],
	},
	es: {
		title: "Kernel",
		dialog: "Actualizaciones de software",
		install: "Instalar kernel ahora",
		staged: "Se aplica en el próximo reinicio con el dispositivo inactivo",
		unknown: "No se pudo determinar el estado de la actualización del kernel.",
		generic: "El dispositivo no pudo confirmar la actualización del kernel. Consulta Ajustes → Registros del sistema para más detalles.",
		bootFailed: "El nuevo kernel no pasó la comprobación de estado al arrancar.",
		phases: ["Descargando kernel", "Preparando kernel", "Kernel listo", "Kernel actualizado", "Verificando el nuevo kernel", "Kernel anterior restaurado", "Actualización del kernel fallida"],
	},
} as const;

const STATES: readonly {
	readonly phase: UpdateOrchestratorPhase;
	readonly state: string | null;
	readonly busy: boolean;
}[] = [
	{ phase: "kernel-downloading", state: null, busy: true },
	{ phase: "kernel-staging", state: "staging", busy: true },
	{ phase: "kernel-staged", state: "staged", busy: true },
	// A socket can skip verifying; this must update the already-open staged dialog.
	{ phase: "kernel-succeeded", state: "succeeded", busy: false },
	{ phase: "kernel-verifying", state: "activated", busy: true },
	{ phase: "kernel-rolled-back", state: "rolled_back", busy: false },
	{ phase: "kernel-failed", state: "failed", busy: false },
];

async function openUpdates(page: Page, dialogName: string = COPY.en.dialog): Promise<Locator> {
	await navigateTo(page, "settings");
	await page.getByTestId("settings-entry-updates").click();
	const dialog = page.getByRole("dialog", { name: dialogName, exact: true });
	await expect(dialog).toBeVisible();
	await expect(dialog.getByTestId("update-details-loading")).toHaveCount(0);
	return dialog;
}

async function frameSection(page: Page, section: Locator): Promise<void> {
	await section.evaluate((element) => element.scrollIntoView({ block: "center" }));
	await page.evaluate(async () => {
		await document.fonts.ready;
		await Promise.all(
			document.getAnimations()
				.filter((animation) => animation.effect?.getComputedTiming().iterations !== Number.POSITIVE_INFINITY)
				.map((animation) => animation.finished.catch(() => undefined)),
		);
	});
	await expect(section).toBeInViewport({ ratio: 1 });
	expect(await section.evaluate((node) =>
		[...node.querySelectorAll("*"), node]
			.filter((element) => element instanceof HTMLElement && element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 1)
			.map((element) => element.getAttribute("data-testid") ?? element.tagName),
	)).toEqual([]);
}

for (const lang of ["en", "es"] as const) {
	for (const theme of ["light", "dark"] as const) {
		test(`kernel states ${lang} ${theme} @visual`, async ({ page }, testInfo) => {
			// Given the real frontend with only kernel RPC facts supplied by the wire fake.
			const copy = COPY[lang];
			const wire = await installUpdateWire(page, {
				fakes: {
					"system.getUpdateCapabilities": KERNEL_CAPABILITIES,
					"system.getUpdateDetails": kernelDetails(),
					"system.checkUpdatesNow": { success: true },
				},
			});
			await page.addInitScript(({ lang, theme }) => {
				localStorage.setItem("locale", JSON.stringify({ code: lang }));
				localStorage.setItem("theme", JSON.stringify(theme));
				localStorage.setItem("mode-watcher-mode", theme);
			}, { lang, theme });
			await page.goto(testInfo.project.name === "mobile" ? "/?mode=touch" : "/");
			await ensureAuthenticated(page);
			const dialog = await openUpdates(page, copy.dialog);
			const section = dialog.getByTestId("updates-kernel");
			await expect(section.getByRole("heading", { name: copy.title, exact: true })).toBeVisible();
			const install = section.getByRole("button", { name: copy.install, exact: true });
			const check = section.getByTestId("update-kernel-check");
			await expect(install).toBeEnabled();
			await expect(section.getByTestId("update-kernel-current")).toContainText("7.2.0-ceralive1");
			await expect(section.getByTestId("update-kernel-candidate")).toContainText("7.2.0-ceralive2");

			for (const [index, state] of STATES.entries()) {
				// When a new RPC state arrives, the same open section must re-render.
				wire.fake("system.getUpdateDetails", kernelDetails({
					state: state.state ?? "succeeded",
					version: state.state === null ? "7.2.0-ceralive1" : "7.2.0-ceralive2",
					candidate: state.state === null ? kernelDetails().kernel?.candidate ?? null : null,
					reason: state.phase === "kernel-rolled-back" || state.state === null ? "kernel_boot_failed" : null,
					booted: {
						package: "linux-image-7.2.0-ceralive-rk3588",
						version: state.phase === "kernel-succeeded" ? "7.2.0-ceralive2" : "7.2.0-ceralive1",
					},
				}));
				wire.setOrchestrator(orchestratorState(state.phase,
					state.phase === "kernel-downloading" || state.phase === "kernel-staging"
						? { percent: 42, etaSeconds: 90 } : undefined));
				// Then both the visible words and the real action affordances agree.
				await expect(section.getByTestId("update-kernel-status")).toHaveText(copy.phases[index] ?? "");
				await expect(section).toHaveAttribute("data-phase", state.phase);
				await expect(section.getByTestId("update-kernel-version")).toHaveText("7.2.0-ceralive2");
				await expect(section.getByTestId("update-kernel-current")).toContainText(
					state.phase === "kernel-succeeded" ? "7.2.0-ceralive2" : "7.2.0-ceralive1",
				);
				await frameSection(page, section);
				await expect(install).toBeDisabled();
				if (state.busy) await expect(check).toBeDisabled();
				else await expect(check).toBeEnabled();
				if (state.phase === "kernel-downloading" || state.phase === "kernel-staging") {
					await expect(section.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "42");
					await expect(section.getByTestId("update-kernel-reason")).toHaveCount(0);
				} else await expect(section.getByRole("progressbar")).toHaveCount(0);
				if (state.phase === "kernel-staged") {
					await expect(section.getByTestId("update-kernel-restart")).toHaveText(copy.staged);
				} else await expect(section.getByTestId("update-kernel-restart")).toHaveCount(0);
				if (state.phase === "kernel-rolled-back") {
					await expect(section.getByTestId("update-kernel-reason")).toHaveText(copy.bootFailed);
					await expect(section.getByTestId("update-kernel-current")).toContainText("7.2.0-ceralive1");
				}
				if (state.phase === "kernel-staged" || state.phase === "kernel-rolled-back") {
					await expect(install).toBeInViewport({ ratio: 1 });
					await expect(check).toBeInViewport({ ratio: 1 });
					expect(await runAxe(page, { include: ['[data-testid="updates-kernel"]'] })).toEqual([]);
					const viewport = testInfo.project.name === "mobile" ? "390x844" : "1280x800";
					const name = state.phase === "kernel-staged" ? "staged" : "rolled-back";
					await page.screenshot({
						path: evidencePath(`task-5-kernel-only-release-${name}-${viewport}-${theme}-${lang}.png`),
						scale: "css",
					});
					if (state.phase === "kernel-rolled-back") {
						await check.click();
						await expect.poll(() => wire.calls("system.checkUpdatesNow")).toEqual([undefined]);
					}
				}
			}
			await expect(dialog.getByTestId("update-activity")).toHaveCount(0);
		});
	}
}

test("kernel capability absence hides the item despite retained RPC details @visual", async ({ page }) => {
	// Given stale kernel facts on a device that has no kernel capability.
	const wire = await installUpdateWire(page, { fakes: {
		"system.getUpdateCapabilities": CAPABLE_CAPABILITIES,
		"system.getUpdateDetails": kernelDetails({ state: "staged", version: "7.2.0-ceralive2" }),
	} });
	await page.goto("/");
	await ensureAuthenticated(page);
	let dialog = await openUpdates(page);
	// When opened, then there is no kernel row or action.
	await expect(dialog.getByTestId("updates-kernel")).toHaveCount(0);
	expect(wire.calls("system.installUpdatesNow")).toEqual([]);
	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();
	wire.fake("system.getUpdateCapabilities", { mode: "legacy", features: ["kernel-apt-stage"] });
	dialog = await openUpdates(page);
	await expect(dialog.getByTestId("updates-kernel")).toHaveCount(0);
});

for (const lang of ["en", "es"] as const) {
	test(`unknown RPC kernel state and reason remain safe ${lang} @visual`, async ({ page }) => {
		// Given a future state/reason, neither is a localized or trusted outcome.
		await installUpdateWire(page, { fakes: {
			"system.getUpdateCapabilities": KERNEL_CAPABILITIES,
			"system.getUpdateDetails": kernelDetails({ state: "future_kernel_phase", reason: "<b>future_reason</b>" }),
		} });
		await page.addInitScript((lang) => localStorage.setItem("locale", JSON.stringify({ code: lang })), lang);
		await page.goto("/");
		await ensureAuthenticated(page);
		// When opened, then unknown stays explicit and no raw token/markup is rendered.
		const dialog = await openUpdates(page, COPY[lang].dialog);
		const section = dialog.getByTestId("updates-kernel");
		await expect(section.getByTestId("update-kernel-status")).toHaveText(COPY[lang].unknown);
		await expect(section.getByTestId("update-kernel-reason")).toHaveText(COPY[lang].generic);
		await expect(section).not.toContainText("future_kernel_phase");
		await expect(section).not.toContainText("future_reason");
		await expect(section.getByTestId("update-kernel-install")).toBeDisabled();
	});
}

test("kernel install uses its own scoped RPC and refusal feedback @visual", async ({ page }) => {
	// Given an offered kernel and a device-side refusal at admission.
	const wire = await installUpdateWire(page, { fakes: {
		"system.getUpdateCapabilities": KERNEL_CAPABILITIES,
		"system.getUpdateDetails": kernelDetails(),
		"system.installUpdatesNow": { success: false, error: "not_available" },
	} });
	await page.goto("/");
	await ensureAuthenticated(page);
	const dialog = await openUpdates(page);
	const install = dialog.getByTestId("update-kernel-install");
	await expect(install).toBeEnabled();
	// When the reachable button is clicked, then exactly the kernel scope is sent.
	await install.click();
	await expect.poll(() => wire.calls("system.installUpdatesNow")).toEqual([{ scope: "kernel" }]);
	expect(wire.calls("system.startUpdate")).toEqual([]);
	const refusal = dialog.getByTestId("update-action-refused");
	await expect(refusal).toHaveAttribute("data-action", "kernel");
	await expect(refusal.getByTestId("update-action-label")).toHaveText(COPY.en.install);
	await expect(install).toBeEnabled();
});

test("missing kernel details and status remain unknown on a capable image @visual", async ({ page }) => {
	// Given capability alone, with neither a kernel summary nor a status hydrate.
	await installUpdateWire(page, { orchestrator: null, fakes: {
		"system.getUpdateCapabilities": KERNEL_CAPABILITIES,
		"system.getUpdateDetails": capableDetails(),
	} });
	await page.goto("/");
	await ensureAuthenticated(page);
	// When opened, then unknown facts do not blank the dialog or enable install.
	const dialog = await openUpdates(page);
	const section = dialog.getByTestId("updates-kernel");
	await expect(section.getByTestId("update-kernel-status")).toHaveText(COPY.en.unknown);
	await expect(section.getByTestId("update-kernel-install")).toBeDisabled();
	await expect(section.getByTestId("update-kernel-version")).toHaveCount(0);
});
