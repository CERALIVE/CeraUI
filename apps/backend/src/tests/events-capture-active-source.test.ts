import { afterEach, expect, test } from "bun:test";
import { captureTransitions } from "./helpers/capture-event-transitions.ts";

const cases = [
	...[
		["A", "B"],
		["B", "A"],
		["A", "B", "C"],
		["B", "A", "C"],
		["B", "C", "A"],
	].map((live) => ({
		name: `explicit A in ${live.join(",")}`,
		live,
		degraded: [],
		active: "A",
		returned: true,
	})),
	{
		name: "A absent",
		live: ["B"],
		degraded: [],
		active: "B",
		returned: null,
	},
	{
		name: "A remains degraded while B is active",
		live: ["B"],
		degraded: ["A"],
		active: "B",
		returned: null,
	},
	{
		name: "degraded A is not a live return even if explicitly selected",
		live: ["B"],
		degraded: ["A"],
		active: "A",
		returned: null,
	},
	{
		name: "explicit A second while B is degraded",
		live: ["B", "A"],
		degraded: ["B"],
		active: "A",
		returned: true,
	},
	{
		name: "explicit A first while B is degraded",
		live: ["A", "B"],
		degraded: ["B"],
		active: "A",
		returned: true,
	},
	{
		name: "A first is not active when B is explicitly active",
		live: ["A", "B"],
		degraded: [],
		active: "B",
		returned: false,
	},
	{
		name: "A second is not active when B is explicitly active",
		live: ["B", "A"],
		degraded: [],
		active: "B",
		returned: false,
	},
];

let close = () => {};
afterEach(() => close());

for (const mode of ["recording", "store"] as const) {
	for (const scenario of cases) {
		test(`${mode}: return flag respects ${scenario.name}`, () => {
			const h = captureTransitions(mode);
			close = h.close;
			h.capture(["B"], ["A"]);
			h.explicitCapture(scenario);
			expect(
				h.events().filter((event) => event.code === "capture_input_returned"),
			).toEqual(
				scenario.returned === null
					? []
					: [
							{
								code: "capture_input_returned",
								params: {
									name: "Camera A",
									activeCamera: scenario.returned,
								},
							},
						],
			);
		});
	}
}
