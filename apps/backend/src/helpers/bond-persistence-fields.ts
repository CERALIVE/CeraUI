import { z } from "zod";

/** Runtime config fields for the new reader, never for the legacy wire. */
export const bondPersistenceFields = {
	// Pair exclusions after the legacy writer expands the pair's bit.
	bond_group_out: z.record(z.string().min(1), z.literal(true)).optional(),
	// Port and vendor ON. `pin` marks a derived exact bit that the ON outranks.
	bond_opt_in: z
		.record(
			z.string().min(1),
			z.record(z.string(), z.object({ pin: z.literal(true).optional() })),
		)
		.optional(),
	// Port and vendor OFF. `exact` marks a vendor-owned legacy bit; `rollback`
	// keeps a path bit for a serial-keyed OFF if the serial becomes unreadable.
	bond_port_out: z
		.record(
			z.string().min(1),
			z.record(
				z.string().min(1),
				z.object({
					exact: z.literal(true).optional(),
					rollback: z.literal(true).optional(),
				}),
			),
		)
		.optional(),
	// Only appended path bits, not keys the legacy writer also produced.
	bond_rollback_out: z.record(z.string().min(1), z.literal(true)).optional(),
};
