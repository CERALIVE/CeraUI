import { z } from "zod";

export const CREDENTIAL_THRESHOLDS = ["90", "30", "7", "expired"] as const;
export type CredentialThreshold = (typeof CREDENTIAL_THRESHOLDS)[number];
export const MAX_CREDENTIAL_GENERATIONS = 1024;
const lifecycle = z.enum(["pending", "active", "acknowledged", "superseded"]);
const generation = z
	.object({
		digest: z.string().regex(/^[a-f0-9]{64}$/),
		id: z.uuid(),
		expiresAt: z.number().int().safe(),
		notices: z.partialRecord(z.enum(CREDENTIAL_THRESHOLDS), lifecycle),
	})
	.strict();

export const credentialLedgerSchema = z
	.object({
		schema: z.literal(1),
		currentGeneration: z.uuid().nullable(),
		generations: z.array(generation).max(MAX_CREDENTIAL_GENERATIONS),
	})
	.strict()
	.refine((state) => {
		const ids = new Set(state.generations.map((item) => item.id));
		const digests = new Set(state.generations.map((item) => item.digest));
		return (
			ids.size === state.generations.length &&
			digests.size === ids.size &&
			(state.currentGeneration === null || ids.has(state.currentGeneration))
		);
	});
export type CredentialLedgerState = z.infer<typeof credentialLedgerSchema>;
export type CredentialIntent = {
	readonly generation: string;
	readonly threshold: CredentialThreshold;
};

export function credentialThresholdsAt(
	expiresAt: number,
	now: number,
): readonly CredentialThreshold[] {
	const remaining = expiresAt - now;
	return CREDENTIAL_THRESHOLDS.filter((threshold) =>
		threshold === "expired"
			? remaining <= 0
			: remaining <= Number(threshold) * 86_400_000,
	);
}

export function credentialIntentId(intent: CredentialIntent): string {
	return `${intent.generation}:${intent.threshold}`;
}

export function credentialIntentKind(
	intent: CredentialIntent,
): "credentials-expiring" | "credentials-expired" {
	return intent.threshold === "expired"
		? "credentials-expired"
		: "credentials-expiring";
}
