import { afterEach, beforeEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getConfig,
	getConfigFilePath,
	setConfigFilePath,
} from "../../modules/config.ts";
import { broadcastConfig } from "../../rpc/config-broadcast.ts";
import { addClient, removeClient } from "../../rpc/events.ts";
import type { AppWebSocket } from "../../rpc/types.ts";

/**
 * An open tab's socket on a config of its own. Each test starts from an empty
 * config the tab was told about, whatever an earlier case sent.
 */
export function useConfigClient() {
	const tab = { directory: "", sent: [] as string[] };
	let previousPath: string;
	let previousConfig: Record<string, unknown>;
	let client: AppWebSocket;

	beforeEach(async () => {
		tab.directory = await mkdtemp(join(tmpdir(), "config-clear-"));
		previousPath = getConfigFilePath();
		setConfigFilePath(join(tab.directory, "config.json"));
		previousConfig = { ...getConfig() };
		for (const key of Object.keys(getConfig()))
			Reflect.deleteProperty(getConfig(), key);
		client = {
			data: { isAuthenticated: true, lastActive: 0 },
			send: (message: string) => {
				tab.sent.push(message);
			},
		} as unknown as AppWebSocket;
		addClient(client);
		broadcastConfig(getConfig());
		tab.sent = [];
	});

	afterEach(async () => {
		removeClient(client);
		for (const key of Object.keys(getConfig()))
			Reflect.deleteProperty(getConfig(), key);
		Object.assign(getConfig(), previousConfig);
		setConfigFilePath(previousPath);
		await rm(tab.directory, { recursive: true, force: true });
	});

	/** The `config` and `config_clear` frames the tab received. */
	const frames = () =>
		tab.sent
			.map((message) => JSON.parse(message) as Record<string, unknown>)
			.filter((frame) => "config" in frame || "config_clear" in frame);

	/** What the tab hears from `write`, once it knows the config as it stands. */
	async function heardFrom(write: () => unknown): Promise<unknown[]> {
		broadcastConfig(getConfig());
		tab.sent = [];
		await write();
		return frames().map((frame) =>
			"config" in frame ? "config" : frame.config_clear,
		);
	}

	return { tab, frames, heardFrom };
}
