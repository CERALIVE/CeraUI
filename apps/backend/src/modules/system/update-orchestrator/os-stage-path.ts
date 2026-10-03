import { z } from "zod";
import { spawnWithTimeout } from "../../../helpers/spawn-policy.ts";
import type { RankedTransport } from "../update-transport/core.ts";
import { UpdateTransferError } from "../update-transport/pin.ts";
import { UPDATE_TRANSPORT_TABLE_BASE } from "../update-transport/pin-rules.ts";

export const OS_PIN_HEALTH_POLL_MS = 3_000;
export const OS_PIN_HEALTH_READ_TIMEOUT_MS = 2_000;
export const OS_PIN_HTTPS_POLL_MS = 10_000;
export const OS_PIN_HTTPS_TIMEOUT_MS = 5_000;
const CURL_TIMEOUT_SECONDS = String((OS_PIN_HTTPS_TIMEOUT_MS - 1_000) / 1_000);
export const OS_PIN_HTTPS_FAILURE_THRESHOLD = 2;

export type OsPinHealth =
	| { readonly kind: "healthy" | "unknown" }
	| {
			readonly kind: "lost";
			readonly reason:
				| "interface-removed"
				| "admin-down"
				| "carrier-down"
				| "family-address-lost"
				| "private-route-lost";
	  };
export type OsHttpsHealth =
	| { readonly kind: "healthy" | "unavailable" }
	| { readonly kind: "origin"; readonly status: number }
	| { readonly kind: "transport"; readonly error: UpdateTransferError };

const linkSchema = z.array(
	z.object({ ifname: z.string(), flags: z.array(z.string()) }),
);
const addressSchema = z.array(
	z.object({
		addr_info: z.array(
			z.object({
				family: z.string(),
				scope: z.string(),
				local: z.string(),
				tentative: z.boolean().optional(),
				dadfailed: z.boolean().optional(),
				valid_life_time: z.union([z.number(), z.string()]).optional(),
			}),
		),
	}),
);
const routeSchema = z.array(
	z.object({
		dst: z.string().optional(),
		dev: z.string().optional(),
		type: z.string().optional(),
	}),
);

export function classifyPinnedTopology(input: {
	readonly transport: RankedTransport;
	readonly links: string;
	readonly addresses: string;
	readonly routes: string;
	readonly carrier: string | null;
}): OsPinHealth {
	try {
		const { transport } = input;
		const link = linkSchema
			.parse(JSON.parse(input.links))
			.find((row) => row.ifname === transport.candidate.ifname);
		if (!link) return { kind: "lost", reason: "interface-removed" };
		if (!link.flags.includes("UP"))
			return { kind: "lost", reason: "admin-down" };
		if (input.carrier?.trim() === "0")
			return { kind: "lost", reason: "carrier-down" };
		const addresses = addressSchema
			.parse(JSON.parse(input.addresses))
			.flatMap((row) => row.addr_info);
		if (
			!addresses.some(
				(row) =>
					row.family === (transport.family === 4 ? "inet" : "inet6") &&
					row.scope === "global" &&
					!row.tentative &&
					!row.dadfailed &&
					row.valid_life_time !== 0,
			)
		)
			return { kind: "lost", reason: "family-address-lost" };
		if (
			!routeSchema
				.parse(JSON.parse(input.routes))
				.some(
					(row) =>
						row.dst === "default" &&
						row.dev === transport.candidate.ifname &&
						(row.type === undefined || row.type === "unicast"),
				)
		)
			return { kind: "lost", reason: "private-route-lost" };
		return { kind: "healthy" };
	} catch {
		return { kind: "unknown" };
	}
}

export async function readPinnedTopology(
	transport: RankedTransport,
	deps = {
		run: spawnWithTimeout,
		read: (path: string) => Bun.file(path).text(),
	},
): Promise<OsPinHealth> {
	try {
		const prefix = ["ip", "-j", `-${transport.family}`];
		const [links, addresses, routes, carrier] = await Promise.all([
			deps.run(["ip", "-j", "link", "show"], {
				timeoutMs: OS_PIN_HEALTH_READ_TIMEOUT_MS,
			}),
			deps.run(
				[...prefix, "address", "show", "dev", transport.candidate.ifname],
				{ timeoutMs: OS_PIN_HEALTH_READ_TIMEOUT_MS },
			),
			deps.run(
				[
					...prefix,
					"route",
					"show",
					"table",
					String(UPDATE_TRANSPORT_TABLE_BASE + 1),
				],
				{ timeoutMs: OS_PIN_HEALTH_READ_TIMEOUT_MS },
			),
			deps
				.read(`/sys/class/net/${transport.candidate.ifname}/carrier`)
				.catch(() => null),
		]);
		if (links.exitCode !== 0) return { kind: "unknown" };
		// A complete link inventory can prove removal even if the address read races it.
		const parsed = linkSchema.parse(JSON.parse(links.stdout));
		if (!parsed.some((row) => row.ifname === transport.candidate.ifname))
			return { kind: "lost", reason: "interface-removed" };
		if (addresses.exitCode !== 0 || routes.exitCode !== 0)
			return { kind: "unknown" };
		return classifyPinnedTopology({
			transport,
			links: links.stdout,
			addresses: addresses.stdout,
			routes: routes.stdout,
			carrier,
		});
	} catch {
		return { kind: "unknown" };
	}
}

export async function probePinnedBundle(
	url: string,
	transport: RankedTransport,
	run = spawnWithTimeout,
): Promise<OsHttpsHealth> {
	try {
		const result = await run(
			[
				"runuser",
				"-u",
				"ceralive-ota",
				"--",
				"curl",
				"-q",
				`-${transport.family}`,
				"--head",
				"--silent",
				"--show-error",
				"--noproxy",
				"*",
				"--proto",
				"=https",
				"--connect-timeout",
				CURL_TIMEOUT_SECONDS,
				"--max-time",
				CURL_TIMEOUT_SECONDS,
				"--output",
				"/dev/null",
				"--write-out",
				"%{http_code}",
				url,
			],
			{ timeoutMs: OS_PIN_HTTPS_TIMEOUT_MS },
		);
		if (result.exitCode !== 0) {
			const reasons = new Map<number, UpdateTransferError["reason"]>([
				[6, "dns-failed"],
				[7, "no-route"],
				[28, "blocked"],
				[35, "tls-error"],
				[60, "tls-error"],
			]);
			const reason = reasons.get(result.exitCode);
			return reason
				? { kind: "transport", error: new UpdateTransferError(reason, result) }
				: { kind: "unavailable" };
		}
		const status = Number(result.stdout.trim());
		if (status === 429 || (status >= 500 && status <= 599))
			return { kind: "origin", status };
		return status >= 200 && status < 300
			? { kind: "healthy" }
			: { kind: "unavailable" };
	} catch {
		return { kind: "unavailable" };
	}
}
