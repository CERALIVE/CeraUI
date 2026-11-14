import { afterEach, beforeEach, expect, test } from "bun:test";
import { changeConfigResultSchema } from "@ceralive/cerastream";
import {
	getMockState,
	initMockService,
	setMockHealth,
	stopMockService,
} from "../mocks/mock-service.ts";
import {
	changeMockComposition,
	startMockStreaming,
	stopMockStreaming,
} from "../mocks/providers/streaming.ts";
import { forcedLegacy } from "./helpers/forced-legacy.ts";

const savedMode = process.env.MOCK_MODE;
const cause =
	"invalid params: video_passthrough=force cannot be combined with composition";
beforeEach(() => {
	process.env.MOCK_MODE = "true";
	initMockService("caps-full");
});
afterEach(() => {
	stopMockService();
	if (savedMode === undefined) delete process.env.MOCK_MODE;
	else process.env.MOCK_MODE = savedMode;
});

for (const sample of [
	{
		name: "one frame is unproven",
		frameCount: 1,
		activeLinks: 0,
		proven: false,
	},
	{
		name: "two frames with no links prove the candidate",
		frameCount: 2,
		activeLinks: 0,
		proven: true,
	},
	{
		name: "connected links without egress proof stay unproven",
		frameCount: 2,
		activeLinks: 1,
		proven: false,
	},
	{
		name: "nonadvancing frames stay unproven",
		frameCount: 2,
		activeLinks: 0,
		framesAdvancing: false,
		proven: false,
	},
	{
		name: "a dead process stays unproven",
		frameCount: 2,
		activeLinks: 0,
		processAlive: false,
		proven: false,
	},
]) {
	test(`plain Start rollback eligibility: ${sample.name}`, () => {
		startMockStreaming(forcedLegacy);
		setMockHealth({
			frameCount: sample.frameCount,
			activeLinks: sample.activeLinks,
			...(sample.framesAdvancing === undefined
				? {}
				: { framesAdvancing: sample.framesAdvancing }),
			...(sample.processAlive === undefined
				? {}
				: { processAlive: sample.processAlive }),
		});
		expect(
			changeConfigResultSchema.parse(
				changeMockComposition({
					secondary_input_id: "hdmi",
					layout: "pip-top-right",
				}),
			),
		).toEqual({
			attempt_id: "cc-1",
			phase: sample.proven ? "reverted" : "rollback_failed",
			state: sample.proven ? "streaming" : "idle",
			reason: sample.proven ? cause : `${cause}; no_known_good`,
		});
		expect(getMockState().engineStart).toEqual(
			sample.proven ? forcedLegacy : null,
		);
	});
}

test("a new Start cannot use the prior session's frame sample as rollback proof", () => {
	startMockStreaming(forcedLegacy);
	setMockHealth({ frameCount: 2, activeLinks: 0 });
	stopMockStreaming();
	startMockStreaming(forcedLegacy);
	expect(
		changeConfigResultSchema.parse(
			changeMockComposition({
				secondary_input_id: "hdmi",
				layout: "pip-top-right",
			}),
		),
	).toEqual({
		attempt_id: "cc-1",
		phase: "rollback_failed",
		state: "idle",
		reason: `${cause}; no_known_good`,
	});
});
