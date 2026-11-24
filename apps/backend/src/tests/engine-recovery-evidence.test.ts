import { expect, test } from "bun:test";
import { evidenceHarness } from "./helpers/stream-engine-evidence.ts";

test.each(["starting", "streaming"] as const)(
	"a reconnect does not admit Start after Idle followed by %s",
	async (state) => {
		const h = evidenceHarness(true);
		try {
			const observation = h.session.reconcile();
			await h.firstSubscription;
			const probe = h.clients[0];
			if (probe === undefined) throw new Error("Expected a status subscriber");

			probe.emit({ type: "status", seq: 1, state: "idle", streaming: false });
			probe.emit({
				type: "status",
				seq: 2,
				state,
				streaming: state === "streaming",
				...(state === "streaming" ? { active_input: "fresh-camera" } : {}),
			});

			expect(await observation).toBe(
				state === "starting" ? "reconciling" : "streaming",
			);
			expect(h.session.streamLiveness()).toBe(
				state === "starting" ? "unknown" : "streaming",
			);
			if (state === "streaming") {
				expect(h.backend.getTelemetry()?.active_input).toBe("fresh-camera");
				expect(await h.start()).toMatchObject({ result: "busy" });
			}
			expect(h.view().marked).toBe(true);
			expect(probe.calls).not.toContain("stop");
		} finally {
			h.dispose();
		}
	},
);

test("operator Stop supersedes an already subscribed recovery observer", async () => {
	const h = evidenceHarness(true);
	const release = Promise.withResolvers<void>();
	try {
		h.holdSubscribe(release.promise);
		const observation = h.session.reconcile();
		await h.firstSubscription;
		const probe = h.clients[0];
		if (probe === undefined) throw new Error("Expected a status subscriber");

		expect(await h.session.stop("operator")).toEqual({ result: "stopped" });
		probe.emit({ type: "status", seq: 1, state: "streaming", streaming: true });
		release.resolve();
		await observation;

		expect(h.session.streamLiveness()).toBe("idle");
		expect(probe.calls).toContain("close");
		expect(
			h.clients.flatMap(({ calls }) => calls).filter((call) => call === "stop"),
		).toHaveLength(1);
	} finally {
		release.resolve();
		h.dispose();
	}
});
