import { type VersionContext, versionContextSchema } from "@ceraui/rpc/schemas";
import { z } from "zod";
import { execFileP } from "../../helpers/exec.ts";
import { logger } from "../../helpers/logger.ts";
import { shouldUseMocks } from "../../mocks/mock-service.ts";
import { MOCK_DEVICE_STATS } from "../../mocks/providers/device-stats.ts";
import { currentBootId } from "../device-logs/boot-id.ts";
import { defaultDeviceDetectionDeps } from "./device-detection.ts";
import {
	ENGINE_UNREACHABLE_REVISION,
	getRevisions,
	refreshEngineRevision,
	refreshSenderRevision,
} from "./revisions.ts";
import { readBootedOsReleaseVersion } from "./update-orchestrator/os-manifest.ts";

export type VersionContextDeps = {
	readonly bootId: () => string | undefined;
	readonly revisions: () =>
		| Readonly<Record<string, string>>
		| Promise<Readonly<Record<string, string>>>;
	readonly mocks: () => boolean;
	readonly readOsImage: () => Promise<string | undefined>;
	readonly readLegacyOsImage: () => Promise<string>;
	readonly readRauc: () => Promise<string>;
	readonly readBoardModel: () => Promise<string>;
};

export const defaultVersionContextDeps: VersionContextDeps = {
	bootId: currentBootId,
	revisions: async () => {
		if (!shouldUseMocks()) {
			await Promise.all([refreshEngineRevision(), refreshSenderRevision()]);
		}
		return getRevisions();
	},
	mocks: shouldUseMocks,
	readOsImage: readBootedOsReleaseVersion,
	readLegacyOsImage: () => Bun.file("/etc/ceralive_img_version").text(),
	readRauc: async () =>
		(await execFileP("rauc", ["status", "--output-format=json"])).stdout,
	readBoardModel: defaultDeviceDetectionDeps.readDeviceTreeModel,
};

const raucIdentitySchema = z.object({
	booted: z.string().trim().min(1).nullable().catch(null),
	compatible: z.string().trim().min(1).nullable().catch(null),
});

async function readOrNull<T>(read: () => Promise<T>): Promise<T | null> {
	try {
		return await read();
	} catch {
		// Each optional source can fail independently without erasing other facts.
		return null;
	}
}

export async function collectVersionContext(
	overrides: Partial<VersionContextDeps> = {},
): Promise<VersionContext> {
	const deps = { ...defaultVersionContextDeps, ...overrides };
	const revisions = await deps.revisions();
	const identity = {
		bootId: deps.bootId(),
		ceraui: revisions.ceralive ?? "unknown revision",
	};
	if (deps.mocks()) {
		return versionContextSchema.parse({
			...identity,
			osImage: null,
			slot: MOCK_DEVICE_STATS.raucSlot,
			board: null,
			boardModel: null,
			engine: null,
			senderVersion: null,
			kernel: null,
			bun: null,
		});
	}
	const [osImage, rauc, boardModel] = await Promise.all([
		readOrNull(deps.readOsImage).then(
			(version) => version ?? readOrNull(deps.readLegacyOsImage),
		),
		readOrNull(async () =>
			raucIdentitySchema.parse(JSON.parse(await deps.readRauc())),
		),
		readOrNull(deps.readBoardModel),
	]);
	return versionContextSchema.parse({
		...identity,
		osImage: osImage?.trim() || null,
		slot: rauc?.booted ?? null,
		board: rauc?.compatible ?? null,
		boardModel: boardModel?.replace(/\0/g, "").trim() || null,
		engine:
			revisions.cerastream === ENGINE_UNREACHABLE_REVISION
				? null
				: (revisions.cerastream ?? null),
		senderVersion:
			revisions.srtla === "unknown revision" ? null : (revisions.srtla ?? null),
		kernel: revisions.kernel ?? null,
		bun: revisions.bun ?? null,
	});
}

export async function logBootRecord(): Promise<void> {
	const versions = await collectVersionContext();
	logger.info("device started", { module: "boot", versions });
}
