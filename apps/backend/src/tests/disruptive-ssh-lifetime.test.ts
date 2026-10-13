import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "@orpc/server";
import * as commands from "../helpers/run.ts";
import { getConfig, setConfigFilePath } from "../modules/config.ts";
import { buildControlContext } from "../modules/remote-control/control-context.ts";
import { updateStreamLifecycleState } from "../modules/streaming/stream-lifecycle-status.ts";
import { updateStatus } from "../modules/streaming/streaming.ts";
import {
	resetSshServiceRunner,
	setSshServiceRunner,
} from "../modules/system/ssh.ts";
import { resetOrchestratorRuntimeForTest } from "../modules/system/update-orchestrator/runtime.ts";
import * as notifications from "../modules/ui/notifications.ts";
import { notificationRemove } from "../modules/ui/notifications.ts";
import {
	sshSetPersistentProcedure,
	sshStartProcedure,
	sshStopProcedure,
} from "../rpc/procedures/system.procedure.ts";

let dir = "";
const env = { ...process.env };
const password = getConfig().ssh_pass;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "power-ssh-"));
	setConfigFilePath(join(dir, "config.json"));
	process.env.CERALIVE_STREAMING_MARKER = join(dir, "streaming");
	process.env.NODE_ENV = "production";
	delete process.env.MOCK_MODE;
	resetOrchestratorRuntimeForTest();
	updateStatus(false);
	updateStreamLifecycleState("idle");
	notificationRemove("disruptive_action_refused");
});
afterEach(() => {
	resetSshServiceRunner();
	resetOrchestratorRuntimeForTest();
	updateStatus(false);
	updateStreamLifecycleState("idle");
	getConfig().ssh_pass = password;
	setConfigFilePath("config.json");
	notificationRemove("disruptive_action_refused");
	for (const key of ["NODE_ENV", "MOCK_MODE", "CERALIVE_STREAMING_MARKER"]) {
		if (env[key] === undefined) delete process.env[key];
		else process.env[key] = env[key];
	}
	rmSync(dir, { recursive: true, force: true });
});

for (const action of ["start", "stop", "persist"] as const) {
	test(`SSH ${action} broadcasts the translated disruptive refusal`, async () => {
		// Given current live evidence, not an idle snapshot.
		updateStatus(true);
		const broadcast = spyOn(notifications, "notificationBroadcast");
		// When the actual RPC procedure refuses.
		const context = buildControlContext();
		const result =
			action === "persist"
				? await call(sshSetPersistentProcedure, { enabled: true }, { context })
				: await call(
						action === "start" ? sshStartProcedure : sshStopProcedure,
						undefined,
						{ context },
					);
		// Then the existing machine reason also reaches the translated dismissible surface.
		expect(result).toEqual({ success: false, error: "streaming" });
		expect(broadcast).toHaveBeenCalledWith(
			"disruptive_action_refused",
			"warning",
			expect.any(String),
			10,
			false,
			true,
			false,
			"notifications.disruptiveActionRefused",
		);
		broadcast.mockRestore();
	});
}

test("SSH start rechecks after password provisioning before service submission", async () => {
	// Given password provisioning held without any real credential I/O.
	getConfig().ssh_pass = undefined;
	const entered = Promise.withResolvers<void>();
	const finished = Promise.withResolvers<string>();
	const passwordCommand = spyOn(commands, "runWithStdin").mockImplementation(
		() => {
			entered.resolve();
			return finished.promise;
		},
	);
	const file = Bun.file;
	writeFileSync(join(dir, "shadow"), "ceralive:$6$fixture:1:0:99999:7:::\n");
	const read = spyOn(Bun, "file").mockImplementation((path, options) => {
		if (path === "/etc/shadow") return file(join(dir, "shadow"), options);
		if (typeof path === "number") return file(path, options);
		if (typeof path === "string" || path instanceof URL)
			return file(path, options);
		return file(path, options);
	});
	const effects: string[] = [];
	setSshServiceRunner(async (action) => {
		effects.push(action);
	});
	try {
		const request = call(sshStartProcedure, undefined, {
			context: buildControlContext(),
		});
		await entered.promise;
		// When stream liveness becomes live before the provisioning continuation.
		updateStatus(true);
		finished.resolve("");
		const result = await request;
		// Then no service command follows stale admission.
		expect(effects).toEqual([]);
		expect(result).toEqual({ success: false, error: "streaming" });
	} finally {
		passwordCommand.mockRestore();
		read.mockRestore();
	}
});
