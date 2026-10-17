import { isDeepStrictEqual } from "node:util";
import { updateOrchestratorPersistedStateSchema } from "@ceraui/rpc/schemas";
import { z } from "zod";
import { osChannelManifestSchema } from "./os-manifest.ts";
import { osStageCandidateKey } from "./os-stage-retry.ts";
import { fromPersisted, toPersisted } from "./persistence.ts";
import { reduceOrchestrator } from "./reducer.ts";

export const osAttemptIntentSchema = z
	.object({
		schema: z.literal(1),
		attemptId: z.uuid(),
		manifest: osChannelManifestSchema,
		phase: z.enum(["publishing", "launching"]),
		before: updateOrchestratorPersistedStateSchema,
		staged: updateOrchestratorPersistedStateSchema,
	})
	.strict()
	.refine((intent) => {
		const expected = reduceOrchestrator(fromPersisted(intent.before), {
			type: "OS_STAGING_STARTED",
			now: intent.staged.enteredAt,
			attempt: {
				attemptId: intent.attemptId,
				candidateKey: osStageCandidateKey(intent.manifest),
			},
		});
		return (
			intent.before.phase === "os-available" &&
			intent.staged.phase === "os-staging" &&
			isDeepStrictEqual(toPersisted(expected), intent.staged)
		);
	});

export type OsAttemptIntent = Readonly<z.infer<typeof osAttemptIntentSchema>>;
