import {
	SHAPER_CONFIG,
	type ShaperAlgorithm,
	type ShaperApplyRequest,
	ShaperUnavailableError,
} from "./contracts.ts";
import { buildShaperPlan, type TcCommand } from "./plan.ts";

export interface RootQdisc {
	readonly kind: string;
	readonly handle: string;
}

export interface UplinkShaperApplierDeps {
	readonly readRoot: (ifname: string) => Promise<RootQdisc>;
	readonly runTc: (argv: readonly string[]) => Promise<void>;
	readonly readBacklog: (ifname: string) => Promise<number>;
	readonly readRecordedRoots?: () => Promise<Record<string, RootQdisc>>;
	readonly writeRecordedRoots?: (
		roots: Record<string, RootQdisc>,
	) => Promise<void>;
}

const RECOGNIZED_DEFAULTS = new Set([
	"mq",
	"fq_codel",
	"noqueue",
	"pfifo_fast",
]);

export class UplinkShaperApplier {
	readonly #deps: UplinkShaperApplierDeps;
	readonly #recorded = new Map<string, RootQdisc>();
	#algorithm: ShaperAlgorithm = "cake";
	#ownershipLoaded = false;

	constructor(deps: UplinkShaperApplierDeps) {
		this.#deps = deps;
	}

	async apply(request: ShaperApplyRequest): Promise<ShaperAlgorithm> {
		await this.#loadRecordedRoots();
		const ifnames = request.uplinks.map((uplink) => uplink.ifname);
		await this.#inventory(ifnames);
		await this.#restoreOmitted(ifnames);
		if (request.mode === "idle") {
			await this.#runPlan(
				buildShaperPlan({ ...request, cakeAvailable: false }),
			);
			return this.#algorithm;
		}
		try {
			await this.#runPlan(buildShaperPlan({ ...request, cakeAvailable: true }));
			this.#algorithm = "cake";
			return this.#algorithm;
		} catch (cakeError) {
			try {
				await this.#runPlan(
					buildShaperPlan({ ...request, cakeAvailable: false }),
				);
				this.#algorithm = "htb-fq_codel";
				return this.#algorithm;
			} catch (fallbackError) {
				throw new ShaperUnavailableError(
					"tc_apply_failed",
					`CAKE probe failed: ${messageOf(cakeError)}; HTB fallback failed: ${messageOf(fallbackError)}`,
				);
			}
		}
	}

	async clientBacklog(ifname: string): Promise<number> {
		return await this.#deps.readBacklog(ifname);
	}

	recordedRoots(): Record<string, RootQdisc> {
		return Object.fromEntries(
			[...this.#recorded.entries()].sort(([left], [right]) =>
				left.localeCompare(right),
			),
		);
	}

	async teardown(): Promise<void> {
		await this.#loadRecordedRoots();
		for (const [ifname, root] of [...this.#recorded.entries()].sort(
			([left], [right]) => left.localeCompare(right),
		)) {
			await this.#deps.runTc(restoreRootArgv(ifname, root));
		}
		this.#recorded.clear();
		await this.#persistRecordedRoots();
	}

	async #inventory(ifnames: readonly string[]): Promise<void> {
		const unseen = [...new Set(ifnames)].filter(
			(ifname) => !this.#recorded.has(ifname),
		);
		let roots: readonly (readonly [string, RootQdisc])[];
		try {
			roots = await Promise.all(
				unseen.map(
					async (ifname) =>
						[ifname, await this.#deps.readRoot(ifname)] as const,
				),
			);
		} catch (error) {
			throw new ShaperUnavailableError(
				"qdisc_inventory_failed",
				messageOf(error),
			);
		}
		for (const [ifname, root] of roots) {
			if (root.handle === SHAPER_CONFIG.rootHandle) continue;
			if (!RECOGNIZED_DEFAULTS.has(root.kind)) {
				throw new ShaperUnavailableError(
					"foreign_qdisc",
					`${ifname} owns custom root ${root.kind} ${root.handle}`,
				);
			}
		}
		for (const [ifname, root] of roots) {
			if (root.handle !== SHAPER_CONFIG.rootHandle)
				this.#recorded.set(ifname, root);
		}
		if (roots.length > 0) await this.#persistRecordedRoots();
	}

	async #restoreOmitted(retainedIfnames: readonly string[]): Promise<void> {
		const retained = new Set(retainedIfnames);
		for (const [ifname, root] of [...this.#recorded.entries()]) {
			if (retained.has(ifname)) continue;
			await this.#deps.runTc(restoreRootArgv(ifname, root));
			this.#recorded.delete(ifname);
		}
		await this.#persistRecordedRoots();
	}

	async #loadRecordedRoots(): Promise<void> {
		if (this.#ownershipLoaded) return;
		this.#ownershipLoaded = true;
		const stored = await this.#deps.readRecordedRoots?.();
		if (stored === undefined) return;
		for (const [ifname, root] of Object.entries(stored))
			this.#recorded.set(ifname, root);
	}

	async #persistRecordedRoots(): Promise<void> {
		await this.#deps.writeRecordedRoots?.(this.recordedRoots());
	}

	async #runPlan(plan: readonly TcCommand[]): Promise<void> {
		for (const command of plan) await this.#deps.runTc(command.argv);
	}
}

function restoreRootArgv(ifname: string, root: RootQdisc): readonly string[] {
	if (root.kind === "noqueue") return ["qdisc", "del", "dev", ifname, "root"];
	return ["qdisc", "replace", "dev", ifname, "root", root.kind];
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
