import { expect, spyOn, test } from "bun:test";
import { checkOsChannel } from "../modules/system/update-orchestrator/os-agent.ts";
import * as identity from "../modules/system/update-orchestrator/os-identity.ts";
import * as manifest from "../modules/system/update-orchestrator/os-manifest.ts";
import { UpdateQuarantine } from "../modules/system/update-orchestrator/quarantine.ts";
import * as transport from "../modules/system/update-transport/executor.ts";

test("channel read refusal prevents real discovery from selecting or fetching another channel", async () => {
	// Given the real discovery entrypoint and an unreadable present drill override.
	const version = spyOn(
		manifest,
		"readBootedOsReleaseVersion",
	).mockResolvedValue("2026.9.0");
	const board = spyOn(identity, "readBoardIdentity").mockResolvedValue({
		board: "rock-5b-plus",
		compatible: "ceralive-rock-5b-plus",
	});
	const override = spyOn(
		manifest.defaultOsChannelDeps,
		"readOverride",
	).mockRejectedValue(Object.assign(new Error("EIO"), { code: "EIO" }));
	const selection = spyOn(transport, "selectUpdateTransport").mockRejectedValue(
		new Error("transfer fixture boundary"),
	);
	try {
		// When discovery runs, then no transport/candidate may be proposed.
		await expect(
			checkOsChannel("stable", new UpdateQuarantine()),
		).rejects.toMatchObject({ reason: "discovery_failed" });
		expect(selection).not.toHaveBeenCalled();
	} finally {
		selection.mockRestore();
		override.mockRestore();
		board.mockRestore();
		version.mockRestore();
	}
});
