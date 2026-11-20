import { AssertionError } from "node:assert";
import { hotspotToggleOutputSchema } from "@ceraui/rpc/schemas";

const checks = {
	preflight: "vm-preconditions",
	"b.control": "distinct-radio-control",
	"a.add": "profile-create",
	"a.add-result": "profile-added",
	"a.receipt": "creation-instance-binding",
	"a.fields": "profile-settings-readable",
	"a.provenance": "first-start-provenance",
	"a.binding": "profile-binding-fields",
	"a.state": "device-state-readable",
	"a.inactive": "profile-still-inactive",
	"a.runtime": "remaining-native-checks",
	"saved.setup": "native-backend-fixture",
	"saved.identity": "real-radio-identity",
	"saved.confirm": "initial-backend-confirmation",
	"saved.stop": "backend-stop",
	"saved.restart": "saved-backend-confirmation",
	"saved.bound": "saved-credential-binding",
	"recovery.loss": "observed-loss-recovery",
	"recovery.stop": "stop-prevents-recovery",
	"recovery.exhaust": "three-attempt-owner-exhaustion",
	"modify.parity": "native-serializer-byte-parity",
	"modify.foreign": "native-edit-race-retirement",
} as const;

type FirstApPhase = keyof typeof checks;
export type FirstApCheckpoint = (phase: FirstApPhase, result?: unknown) => void;

function shape(value: unknown) {
	if (value === null) return { kind: "null" };
	if (Array.isArray(value)) return { kind: "array", length: value.length };
	return { kind: typeof value };
}

/** The CLI boundary never serializes command exceptions or their credential-bearing argv. */
export async function runFirstAp(
	operation: (checkpoint: FirstApCheckpoint) => Promise<void>,
): Promise<boolean> {
	let phase: FirstApPhase = "preflight";
	try {
		await operation((next, result) => {
			phase = next;
			console.log("first-ap: phase", phase);
			if (result !== undefined) {
				const parsed = hotspotToggleOutputSchema.safeParse(result);
				console.log("first-ap: outcome", {
					phase,
					check: checks[phase],
					success: parsed.success && parsed.data.success,
					...(parsed.success && parsed.data.error
						? { error: parsed.data.error }
						: {}),
				});
			}
		});
		return true;
	} catch (error: unknown) {
		const identity = { phase, check: checks[phase] };
		console.error(
			"first-ap: FAIL",
			error instanceof AssertionError
				? {
						...identity,
						kind: "assertion",
						actual: shape(error.actual),
						expected: shape(error.expected),
					}
				: { ...identity, kind: "command-or-runtime" },
		);
		return false;
	}
}
