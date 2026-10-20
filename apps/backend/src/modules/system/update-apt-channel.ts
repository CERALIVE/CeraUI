import { writeFileAtomicSync } from "../../helpers/config-loader.ts";
import { pendingPackageSuccess } from "./update-orchestrator/pending-success-fence.ts";
import {
	readStoredStateFile,
	STORED_STATE_LIMITS,
} from "./update-orchestrator/stored-state-file.ts";

export const CERALIVE_SOURCES_FILE = "/etc/apt/sources.list.d/ceralive.sources";
let sourcesPath = CERALIVE_SOURCES_FILE;

export function setCeraliveSourcesFileForTest(file: string | null): void {
	sourcesPath = file ?? CERALIVE_SOURCES_FILE;
}

export function buildCeraliveSources(
	channel: "stable" | "beta",
	arch: string,
): string {
	if (arch !== "arm64" && arch !== "amd64")
		throw new Error("unsupported apt architecture");
	const stanza = (name: "stable" | "beta") =>
		`Types: deb\nURIs: https://apt.ceralive.tv/dists/${name}/binary-${arch}/\nSuites: ./\nSigned-By: /usr/share/keyrings/ceralive-archive-keyring.gpg\n`;
	return channel === "stable"
		? stanza("stable")
		: `${stanza("stable")}\n${stanza("beta")}`;
}

export async function reconcileAptChannel(
	mode: "legacy" | "capable",
	channel: "stable" | "beta",
	file = sourcesPath,
	arch: string = process.arch === "arm64" ? "arm64" : "amd64",
): Promise<boolean> {
	if (pendingPackageSuccess.pending) return false;
	if (mode !== "capable") return false;
	const desired = buildCeraliveSources(channel, arch);
	const current = await readStoredStateFile(file, STORED_STATE_LIMITS.settings);
	if (current === desired) return false;
	if (pendingPackageSuccess.pending) return false;
	writeFileAtomicSync(file, desired);
	return true;
}
