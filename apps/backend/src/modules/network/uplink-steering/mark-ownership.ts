import type { MarkClaim, MarkImage } from "./mark-journal.ts";

export function matchesLegacy(
	legacy: string,
	claims: readonly Pick<MarkClaim, "ifname" | "mark">[],
): boolean {
	return (
		claims.length > 0 &&
		claims.every(({ ifname, mark }) =>
			legacy
				.split("\n")
				.some(
					(line) =>
						line.includes(`0x${mark.toString(16)} `) &&
						line.includes(`oifname "${ifname}" masquerade`),
				),
		)
	);
}

/** The kernel ruleset proves an owner where the journal records none. */
export function provenByKernel(
	legacy: string,
	claims: readonly Pick<MarkClaim, "mark">[],
	link: Pick<MarkClaim, "ifname" | "mark">,
): boolean {
	return (
		!claims.some(({ mark }) => mark === link.mark) &&
		matchesLegacy(legacy, [link])
	);
}

/**
 * Whether `a` keeps the binding `b` holds in `base`. A base without collision
 * state was written beside main's applier, which never resets flows on a
 * rebind and may have rebound the link while a journal write was skipped, so
 * there only the owner counts.
 */
export function sameBinding(
	base: MarkImage,
	a: MarkClaim,
	b: MarkClaim | undefined,
): boolean {
	return (
		b !== undefined &&
		a.identity === b.identity &&
		(base.affected.length === 0 ||
			(a.ifindex === b.ifindex && a.sourceAddress === b.sourceAddress))
	);
}
