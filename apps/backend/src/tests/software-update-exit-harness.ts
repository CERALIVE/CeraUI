import { spyOn } from "bun:test";
import * as restartContinuation from "../modules/system/software-update-restart.ts";

/** Only the fixture boundary catches this; the production continuation aborts. */
export class TestUpdateExit extends Error {
	override readonly name = "TestUpdateExit";
}

export function observeTestUpdateExit(): ReturnType<
	typeof spyOn<typeof restartContinuation, "finishSoftwareUpdateRestart">
> {
	const finishRestart = restartContinuation.finishSoftwareUpdateRestart;
	return spyOn(
		restartContinuation,
		"finishSoftwareUpdateRestart",
	).mockImplementation((...args) =>
		finishRestart(...args).catch((error: unknown) => {
			if (!(error instanceof TestUpdateExit)) throw error;
		}),
	);
}
