import { afterEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { getConfig, getConfigFilePath } from "../modules/config.ts";
import { routeCommand } from "../modules/remote-control/command-router.ts";
import {
	CommandSchema,
	PROTOCOL_VERSION,
	type Result,
} from "../modules/remote-control/protocol.ts";
import {
	handleSelfFencingConfirm,
	resetSelfFencingState,
} from "../modules/remote-control/self-fencing.ts";
import { buildMsg } from "../modules/ui/websocket-server.ts";
import { object, secrets } from "./helpers/remote-privacy-cases.ts";
import { usePrivacyConfig } from "./helpers/remote-privacy-config.ts";
import {
	authenticateRemote,
	useRemotePrivacySocket,
} from "./helpers/remote-privacy-socket.ts";

usePrivacyConfig();
useRemotePrivacySocket();
afterEach(resetSelfFencingState);

test("remote SSH config read and registered config save preserve owner credentials", async () => {
	const remote = await authenticateRemote();
	const initial = remote.sent.find((frame) => "config" in JSON.parse(frame));
	const config: unknown = JSON.parse(initial ?? "{}").config;
	if (!object(config)) throw new Error("missing remote config");
	expect(config.ssh_pass).toBe(secrets.ssh_pass);
	expect(config).not.toHaveProperty("pairing_secret");

	// The SSH dialog displays/resets passwords; the existing generic config
	// transaction is the remote protocol's stored-parameter write path.
	const password = `${config.ssh_pass}-owner-edit`;
	const command = CommandSchema.parse({
		v: PROTOCOL_VERSION,
		kind: "command",
		type: "network.reconfig",
		cid: "43fcb783-4ad0-4980-a260-d1fd5f831413",
		role: "owner",
		self_fencing: true,
		payload: { ...config, ssh_pass: password },
	});
	const results: Result[] = [];
	await routeCommand(command, {
		sendResult: (frame) => {
			results.push(frame);
			return true;
		},
		selfFencing: { admitDisruptiveAction: async () => ({ ok: true }) },
	});
	await handleSelfFencingConfirm(command.cid);

	expect(results).toHaveLength(2);
	for (const frame of results) {
		expect(frame.payload.ok).toBe(true);
		expect(frame.payload.applied).toHaveProperty("ssh_pass", password);
		expect(frame.payload.applied).not.toHaveProperty("pairing_secret");
	}
	const persisted = JSON.parse(await readFile(getConfigFilePath(), "utf8"));
	expect(persisted.ssh_pass).toBe(password);
	expect(persisted.pairing_secret).toBe(secrets.pairing_secret);
	remote.sent.length = 0;
	remote.send(buildMsg("config", getConfig()));
	expect(JSON.parse(remote.sent[0] ?? "{}").config.ssh_pass).toBe(password);
	expect(remote.sent.join("\n")).not.toContain(secrets.pairing_secret);
});
