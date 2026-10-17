import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runDisruptiveSysextStep } from "./disruptive-sysext-step.ts";

export type ArtifactPublication = {
	readonly commit: () => Promise<void>;
	readonly rollback: () => Promise<void>;
};

export async function publishPreparedArtifact(
	tmp: string,
	dest: string,
): Promise<ArtifactPublication> {
	await mkdir(dirname(dest), { recursive: true });
	const privateDir = await mkdtemp(join(dirname(tmp), ".addon-publication-"));
	const backup = join(privateDir, "prior");
	const publicationTmp = `${dest}.${randomUUID()}.tmp`;
	let hadPrior = false;
	try {
		try {
			await copyFile(dest, backup, constants.COPYFILE_EXCL);
			hadPrior = true;
		} catch (error) {
			if (
				!(error instanceof Error && "code" in error && error.code === "ENOENT")
			)
				throw error;
		}
		await copyFile(tmp, publicationTmp, constants.COPYFILE_EXCL);
		await runDisruptiveSysextStep("publish-artifact", () =>
			rename(publicationTmp, dest),
		);
	} catch (error) {
		await rm(publicationTmp, { force: true });
		await rm(privateDir, { recursive: true, force: true });
		throw error;
	}
	let settled = false;
	return {
		commit: async () => {
			if (settled) return;
			await rm(tmp, { force: true });
			await rm(privateDir, { recursive: true, force: true });
			settled = true;
		},
		rollback: async () => {
			if (settled) return;
			if (hadPrior) {
				await copyFile(backup, publicationTmp, constants.COPYFILE_EXCL);
				await rename(publicationTmp, dest);
			} else await rm(dest, { force: true });
			await rm(privateDir, { recursive: true, force: true });
			settled = true;
		},
	};
}

export async function cachePreparedArtifact(
	tmp: string,
	dest: string,
): Promise<ArtifactPublication> {
	const signature = await publishPreparedArtifact(`${tmp}.sig`, `${dest}.sig`);
	try {
		const raw = await publishPreparedArtifact(tmp, dest);
		return {
			commit: async () => {
				await raw.commit();
				await signature.commit();
			},
			rollback: async () => {
				await raw.rollback();
				await signature.rollback();
			},
		};
	} catch (error) {
		await signature.rollback();
		throw error;
	}
}
