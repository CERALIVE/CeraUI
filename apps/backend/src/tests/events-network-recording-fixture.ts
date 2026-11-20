import { onTestFinished, spyOn } from "bun:test";
import * as emitter from "../modules/events/emit.ts";
import { networkEventsFixture } from "./events-network-fixture.ts";

export function recordNetworkEvents() {
	const calls: { code: string; params: unknown }[] = [];
	const emit = emitter.emitEvent;
	const recording = spyOn(emitter, "emitEvent").mockImplementation(
		(code, params) => {
			calls.push({ code, params });
			emit(code, params);
		},
	);
	onTestFinished(() => recording.mockRestore());
	const fixture = networkEventsFixture();
	return { ...fixture, calls };
}
