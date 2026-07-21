import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
	evaluateIndicator,
	type LifecycleIndicatorDeps,
	reportActiveAudioSource,
	reportActiveVideoSource,
	reportAllLinksDown,
	reportEngineState,
	resetLifecycleIndicatorState,
	setLifecycleIndicatorDepsForTest,
} from "../modules/streaming/lifecycle-indicators.ts";

type NotifyCall = {
	name: string;
	type: "success" | "warning" | "error";
	msg: string;
	duration: number;
	isPersistent: boolean;
	isDismissable: boolean;
	key: string | undefined;
};

function makeSpyDeps(): {
	deps: LifecycleIndicatorDeps;
	notifies: NotifyCall[];
	removes: string[];
} {
	const notifies: NotifyCall[] = [];
	const removes: string[] = [];
	const deps: LifecycleIndicatorDeps = {
		notify: (
			name,
			type,
			msg,
			duration = 0,
			isPersistent = false,
			isDismissable = true,
			_authedOnly = true,
			key,
		) => {
			notifies.push({
				name,
				type,
				msg,
				duration,
				isPersistent,
				isDismissable,
				key,
			});
		},
		removeNotification: (name) => {
			removes.push(name);
		},
	};
	return { deps, notifies, removes };
}

describe("lifecycle-indicators evaluateIndicator", () => {
	beforeEach(() => resetLifecycleIndicatorState());
	afterEach(() => resetLifecycleIndicatorState());

	test("emits ONE persistent error on the ok→bad edge", () => {
		const { deps, notifies } = makeSpyDeps();
		const action = evaluateIndicator("all-links-down", true, true, deps);
		expect(action).toBe("lost");
		expect(notifies).toHaveLength(1);
		expect(notifies[0]).toMatchObject({
			name: "all-links-down",
			type: "error",
			isPersistent: true,
			isDismissable: false,
			duration: 0,
			key: "notifications.allLinksDown",
		});
	});

	test("DEDUPE: a repeated still-bad report does NOT re-emit (one toast)", () => {
		const { deps, notifies } = makeSpyDeps();
		evaluateIndicator("all-links-down", true, true, deps);
		evaluateIndicator("all-links-down", true, true, deps);
		evaluateIndicator("all-links-down", true, true, deps);
		expect(notifies).toHaveLength(1);
	});

	test("recovery removes the persistent notification and emits ONE transient success toast", () => {
		const { deps, notifies, removes } = makeSpyDeps();
		evaluateIndicator("all-links-down", true, true, deps);
		const action = evaluateIndicator("all-links-down", true, false, deps);
		expect(action).toBe("recovered");
		expect(removes).toEqual(["all-links-down"]);
		const recovered = notifies.at(-1);
		expect(recovered).toMatchObject({
			name: "all-links-down-recovered",
			type: "success",
			isPersistent: false,
			duration: 5,
			key: "notifications.linksRecovered",
		});
	});

	test("recovery is also deduped (bad→ok→ok fires the toast once)", () => {
		const { deps, notifies } = makeSpyDeps();
		evaluateIndicator("all-links-down", true, true, deps);
		evaluateIndicator("all-links-down", true, false, deps);
		evaluateIndicator("all-links-down", true, false, deps);
		const successes = notifies.filter((n) => n.type === "success");
		expect(successes).toHaveLength(1);
	});

	test("a stream stop clears a lingering bad indicator SILENTLY (no recovered toast)", () => {
		const { deps, notifies, removes } = makeSpyDeps();
		evaluateIndicator("engine-crashed", true, true, deps);
		const action = evaluateIndicator("engine-crashed", false, true, deps);
		expect(action).toBe("cleared");
		expect(removes).toEqual(["engine-crashed"]);
		expect(notifies.filter((n) => n.type === "success")).toHaveLength(0);
	});

	test("not-streaming with a clean state is a no-op (no notify, no remove)", () => {
		const { deps, notifies, removes } = makeSpyDeps();
		const action = evaluateIndicator("active-source-lost", false, true, deps);
		expect(action).toBe("none");
		expect(notifies).toHaveLength(0);
		expect(removes).toHaveLength(0);
	});

	test("a bad state never toasts while not streaming", () => {
		const { deps, notifies } = makeSpyDeps();
		evaluateIndicator("active-audio-lost", false, true, deps);
		expect(notifies).toHaveLength(0);
	});

	test("re-firing after a stop clears (bad → stop → stream → bad emits again)", () => {
		const { deps, notifies } = makeSpyDeps();
		evaluateIndicator("active-source-lost", true, true, deps);
		evaluateIndicator("active-source-lost", false, false, deps);
		evaluateIndicator("active-source-lost", true, true, deps);
		expect(notifies.filter((n) => n.type === "error")).toHaveLength(2);
	});
});

describe("lifecycle-indicators typed reporters (badness derivation)", () => {
	let spy: ReturnType<typeof makeSpyDeps>;
	beforeEach(() => {
		spy = makeSpyDeps();
		setLifecycleIndicatorDepsForTest(spy.deps);
	});
	afterEach(() => setLifecycleIndicatorDepsForTest(null));

	test("video: applied id absent from a non-empty set while streaming ⇒ lost", () => {
		reportActiveVideoSource({
			isStreaming: true,
			activeSourceId: "/dev/video1",
			presentSourceIds: ["/dev/video0", "/dev/video2"],
		});
		expect(spy.notifies).toHaveLength(1);
		expect(spy.notifies[0]?.name).toBe("active-source-lost");
	});

	test("video: an empty device set is the pre-scan state, NOT a loss", () => {
		reportActiveVideoSource({
			isStreaming: true,
			activeSourceId: "/dev/video1",
			presentSourceIds: [],
		});
		expect(spy.notifies).toHaveLength(0);
	});

	test("video: applied id still present ⇒ no notification", () => {
		reportActiveVideoSource({
			isStreaming: true,
			activeSourceId: "/dev/video1",
			presentSourceIds: ["/dev/video1"],
		});
		expect(spy.notifies).toHaveLength(0);
	});

	test("audio: caller-computed loss ⇒ silence-failover notification", () => {
		reportActiveAudioSource({ isStreaming: true, isDeviceLost: true });
		expect(spy.notifies[0]).toMatchObject({
			name: "active-audio-lost",
			key: "notifications.activeAudioLost",
		});
	});

	test("links: 0 active of N>0 ⇒ all-links-down; a partial drop does NOT fire", () => {
		reportAllLinksDown({ isStreaming: true, linkCount: 3, activeLinks: 1 });
		expect(spy.notifies).toHaveLength(0);
		reportAllLinksDown({ isStreaming: true, linkCount: 3, activeLinks: 0 });
		expect(spy.notifies).toHaveLength(1);
		expect(spy.notifies[0]?.name).toBe("all-links-down");
	});

	test("links: linkCount 0 (none configured) never fires the all-down banner", () => {
		reportAllLinksDown({ isStreaming: true, linkCount: 0, activeLinks: 0 });
		expect(spy.notifies).toHaveLength(0);
	});

	test("engine: unreachable while streaming ⇒ crash; reachable ⇒ recovered", () => {
		reportEngineState({ isStreaming: true, reachable: false });
		expect(spy.notifies[0]?.name).toBe("engine-crashed");
		reportEngineState({ isStreaming: true, reachable: true });
		expect(spy.notifies.at(-1)?.name).toBe("engine-crashed-recovered");
		expect(spy.notifies.at(-1)?.type).toBe("success");
	});
});
