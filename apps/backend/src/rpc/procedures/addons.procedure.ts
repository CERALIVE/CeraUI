/**
 * Add-on Procedures
 *
 * The RPC surface over the add-on manager state machine (T28,
 * modules/addons/manager.ts). Read-only queries (`listAddons`,
 * `getAddonStatus`) merge the image-baked descriptors with the manager's live
 * phase + persisted state and are NOT gated. The three mutating handlers
 * (`installAddon`, `uninstallAddon`, `configureAddon`) gate on `isRealDevice()`
 * (G6) and drive the device only through the manager — never the privileged
 * helper directly.
 *
 * Every OS/disk-touching primitive is injected through {@link AddonProcedureDeps}
 * so the suite runs without a board (mirrors the manager's `AddonManagerDeps`).
 */

import { readdir } from "node:fs/promises";

import {
	type AddonDescriptor,
	AddonDescriptorSchema,
	type AddonState,
	AddonStateSchema,
} from "@ceraui/rpc/schemas";
import { os } from "@orpc/server";
import { z } from "zod";

import { logger } from "../../helpers/logger.ts";
import { readAddonDescriptor } from "../../modules/addons/descriptor-authority.ts";
import {
	ADDON_ENABLE_FAILED_ERROR,
	ADDON_MANAGER_PHASES,
	ADDON_UNAVAILABLE_ERROR,
	type AddonHardware,
	type AddonManagerPhase,
	type AddonOpResult,
	addonCompatibilityError,
	disableAddon,
	enableAddon,
	getAddonPhase,
	settleAddonState,
	settleInterruptedAddonStates,
	toAddonState,
} from "../../modules/addons/manager.ts";
import {
	withAddonMutation,
	withAddonRefusalBaseline,
} from "../../modules/addons/mutation.ts";
import {
	getLiveAddonState,
	getLiveAddonStates,
} from "../../modules/addons/state-settlement.ts";
import { removeAddonState } from "../../modules/config.ts";
import { getEffectiveHardware as getEffectiveHardwareImpl } from "../../modules/streaming/pipelines.ts";
import { isRealDevice } from "../../modules/system/kiosk.ts";
import { authMiddleware } from "../middleware/auth.middleware.ts";
import type { RPCContext } from "../types.ts";

const baseProcedure = os.$context<RPCContext>();
const authedProcedure = baseProcedure.use(authMiddleware);

/** Returned when an id has no matching image-baked descriptor on disk. */
export const ADDON_NOT_FOUND_ERROR = "addon_not_found";

/** Image-baked, read-only descriptor drop directory (one `<id>.json` per add-on). */
const ADDON_DESCRIPTOR_DIR = "/usr/share/ceralive/addons";

// Reuse the descriptor's own id pattern (G5: never re-declare the regex).
const addonIdSchema = AddonDescriptorSchema.shape.id;
const userConfigSchema = z.record(z.string(), z.unknown());

const addonManagerPhaseSchema = z.enum(
	ADDON_MANAGER_PHASES as unknown as [
		AddonManagerPhase,
		...AddonManagerPhase[],
	],
);

const addonListItemSchema = z.object({
	descriptor: AddonDescriptorSchema,
	state: AddonStateSchema,
	managerPhase: addonManagerPhaseSchema,
});

const addonOpResultSchema = z.union([
	z.object({ success: z.literal(true), phase: addonManagerPhaseSchema }),
	z.object({ success: z.literal(false), error: z.string() }),
]);

const configureResultSchema = z.union([
	z.object({ success: z.literal(true), applied: userConfigSchema }),
	z.object({ success: z.literal(false), error: z.string() }),
]);

/**
 * The injectable surface. Defaults read the image-baked descriptors off disk,
 * gate on the real device-detector, and delegate state ops to the manager +
 * config. Tests inject deterministic spies via {@link setAddonProcedureDeps}.
 */
export type AddonProcedureDeps = {
	readDescriptors: () => Promise<AddonDescriptor[]>;
	isRealDevice: () => Promise<boolean>;
	getEffectiveHardware: () => AddonHardware;
	getAddonPhase: (id: string) => AddonManagerPhase;
	getAddonState: (id: string) => AddonState | undefined;
	enableAddon: (descriptor: AddonDescriptor) => Promise<AddonOpResult>;
	disableAddon: (descriptor: AddonDescriptor) => Promise<AddonOpResult>;
	setAddonState: (id: string, state: AddonState) => void | boolean;
	removeAddonState: (id: string) => void;
};

async function readBakedDescriptors(): Promise<AddonDescriptor[]> {
	let entries: string[];
	try {
		entries = await readdir(ADDON_DESCRIPTOR_DIR);
	} catch {
		return [];
	}
	const descriptors: AddonDescriptor[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue;
		try {
			descriptors.push(
				await readAddonDescriptor(`${ADDON_DESCRIPTOR_DIR}/${entry}`),
			);
		} catch (err) {
			logger.error(`addon descriptor ${entry} failed to parse: ${err}`);
		}
	}
	return descriptors;
}

const defaultAddonProcedureDeps: AddonProcedureDeps = {
	readDescriptors: readBakedDescriptors,
	isRealDevice: () => isRealDevice(),
	getEffectiveHardware: () => getEffectiveHardwareImpl(),
	getAddonPhase: (id) => getAddonPhase(id),
	getAddonState: getLiveAddonState,
	enableAddon: (descriptor) => enableAddon(descriptor),
	disableAddon: (descriptor) => disableAddon(descriptor),
	setAddonState: (id, state) => settleAddonState(id, state),
	removeAddonState: (id) => removeAddonState(id),
};

let activeDeps: AddonProcedureDeps = defaultAddonProcedureDeps;

/** Override the injectable surface (DI for tests). */
export function setAddonProcedureDeps(deps: Partial<AddonProcedureDeps>): void {
	activeDeps = { ...defaultAddonProcedureDeps, ...deps };
}

/** Restore the real-device primitives. */
export function resetAddonProcedureDeps(): void {
	activeDeps = defaultAddonProcedureDeps;
}

export async function sendAddonSnapshot(
	emit: (state: Record<string, AddonState>) => void,
): Promise<void> {
	const deps = activeDeps;
	settleInterruptedAddonStates();
	const descriptors = await deps.readDescriptors();
	const snapshot = getLiveAddonStates();
	for (const descriptor of descriptors)
		snapshot[descriptor.id] =
			deps.getAddonState(descriptor.id) ?? toAddonState("disabled");
	emit(snapshot);
}

/** Merge a descriptor with its persisted state + live manager phase. */
function buildItem(
	descriptor: AddonDescriptor,
	deps: AddonProcedureDeps,
): z.infer<typeof addonListItemSchema> {
	const managerPhase = deps.getAddonPhase(descriptor.id);
	const state = deps.getAddonState(descriptor.id) ?? toAddonState(managerPhase);
	return { descriptor, state, managerPhase };
}

async function findDescriptor(
	id: string,
	deps: AddonProcedureDeps,
): Promise<AddonDescriptor | undefined> {
	return (await deps.readDescriptors()).find((d) => d.id === id);
}

/**
 * List every image-baked add-on merged with its live state. Read-only — NOT
 * gated on isRealDevice() so the UI renders the catalogue in emulated mode too.
 */
export const listAddonsProcedure = authedProcedure
	.output(z.object({ addons: z.array(addonListItemSchema) }))
	.handler(async () => {
		const deps = activeDeps;
		const descriptors = await deps.readDescriptors();
		return { addons: descriptors.map((d) => buildItem(d, deps)) };
	});

/**
 * Materialise + enable an add-on through the manager. Gated on isRealDevice()
 * (G6); an optional `userConfig` is pre-seeded so the manager preserves it.
 */
export const installAddonProcedure = authedProcedure
	.input(
		z.object({ id: addonIdSchema, userConfig: userConfigSchema.optional() }),
	)
	.output(addonOpResultSchema)
	.handler(async ({ input }) => {
		return withAddonMutation(input.id, async () => {
			const deps = activeDeps;
			if (!(await deps.isRealDevice())) {
				return { success: false, error: ADDON_UNAVAILABLE_ERROR };
			}
			const descriptor = await findDescriptor(input.id, deps);
			if (!descriptor) {
				return { success: false, error: ADDON_NOT_FOUND_ERROR };
			}
			// T23 — reject an incompatible install before persisting any userConfig.
			const compatError = addonCompatibilityError(
				descriptor,
				deps.getEffectiveHardware(),
				(id) => deps.getAddonState(id),
			);
			if (compatError) {
				return { success: false, error: compatError };
			}
			const { getDisruptiveActionDecision } = await import(
				"../../modules/system/disruptive-action-runtime.ts"
			);
			const admission = getDisruptiveActionDecision();
			if (!admission.allowed)
				return { success: false, error: admission.reason };
			const previousState = deps.getAddonState(input.id);
			const result = await withAddonRefusalBaseline(
				{
					id: input.id,
					state: previousState,
					...(input.userConfig !== undefined
						? { userConfig: input.userConfig }
						: {}),
				},
				() => deps.enableAddon(descriptor),
			);
			return result;
		});
	});

/**
 * Disable + remove an add-on through the manager. Gated on isRealDevice() (G6).
 */
export const uninstallAddonProcedure = authedProcedure
	.input(z.object({ id: addonIdSchema }))
	.output(addonOpResultSchema)
	.handler(async ({ input }) => {
		const deps = activeDeps;
		if (!(await deps.isRealDevice())) {
			return { success: false, error: ADDON_UNAVAILABLE_ERROR };
		}
		const descriptor = await findDescriptor(input.id, deps);
		if (!descriptor) {
			return { success: false, error: ADDON_NOT_FOUND_ERROR };
		}
		return deps.disableAddon(descriptor);
	});

/**
 * Persist an add-on's userConfig without touching its materialised payload.
 * Gated on isRealDevice() (G6); the add-on must already have persisted state.
 */
export const configureAddonProcedure = authedProcedure
	.input(z.object({ id: addonIdSchema, fields: userConfigSchema }))
	.output(configureResultSchema)
	.handler(async ({ input }) => {
		return withAddonMutation(input.id, async () => {
			const deps = activeDeps;
			if (!(await deps.isRealDevice())) {
				return { success: false, error: ADDON_UNAVAILABLE_ERROR };
			}
			const state = deps.getAddonState(input.id);
			if (!state) {
				return { success: false, error: ADDON_NOT_FOUND_ERROR };
			}
			const persisted = deps.setAddonState(input.id, {
				...state,
				userConfig: input.fields,
			});
			if (persisted === false)
				return { success: false, error: ADDON_ENABLE_FAILED_ERROR };
			return { success: true, applied: input.fields };
		});
	});

/**
 * Single add-on snapshot: descriptor (carries the disk-size impact) + live
 * state. Read-only — NOT gated. Resolves null for an unknown id.
 */
export const getAddonStatusProcedure = authedProcedure
	.input(z.object({ id: addonIdSchema }))
	.output(addonListItemSchema.nullable())
	.handler(async ({ input }) => {
		const deps = activeDeps;
		const descriptor = await findDescriptor(input.id, deps);
		if (!descriptor) return null;
		return buildItem(descriptor, deps);
	});
