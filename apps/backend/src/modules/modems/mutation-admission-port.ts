import { tryAcquireModemMutation } from "../streaming/lifecycle-admission.ts";

export type ModemControlMutationAdmissionRequest = {
	readonly operationId: string;
	readonly physicalModemId: string;
	readonly impact: string;
	readonly requirement: Readonly<{ readonly required: boolean }>;
};

export type ModemControlMutationAdmissionDecision =
	| {
			readonly status: "admitted";
			readonly lease: { release(): Promise<void> };
	  }
	| {
			readonly status: "refused";
			readonly reason: "admission-refused";
			readonly detail: string;
	  };

export interface ModemControlMutationAdmissionPort {
	acquire(
		request: ModemControlMutationAdmissionRequest,
	): Promise<ModemControlMutationAdmissionDecision>;
}

export const modemMutationAdmissionPort: ModemControlMutationAdmissionPort = {
	async acquire(request) {
		const admission = tryAcquireModemMutation(request.physicalModemId);
		if (!admission.admitted) {
			return {
				status: "refused",
				reason: "admission-refused",
				detail: admission.refusal,
			};
		}
		return {
			status: "admitted",
			lease: {
				async release() {
					admission.lease.release();
				},
			},
		};
	},
};
