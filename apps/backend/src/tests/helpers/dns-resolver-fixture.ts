import {
	type DnsResolverLike,
	setDnsResolverFactoryForTest,
} from "../../modules/network/dns.ts";

export type DnsQuery = {
	readonly resolverId: number;
	readonly method: "resolve4" | "resolve6";
	readonly hostname: string;
	readonly settle: (
		err: NodeJS.ErrnoException | null,
		addresses: Array<string>,
	) => void;
};

export type DnsResolverHub = {
	readonly queries: Array<DnsQuery>;
	resolverCount: number;
	cancels: Array<number>;
};

export function installFakeResolvers(): DnsResolverHub {
	const hub: DnsResolverHub = { queries: [], resolverCount: 0, cancels: [] };
	setDnsResolverFactoryForTest((): DnsResolverLike => {
		const resolverId = ++hub.resolverCount;
		const record =
			(method: "resolve4" | "resolve6") =>
			(
				hostname: string,
				callback: (
					err: NodeJS.ErrnoException | null,
					addresses: Array<string>,
				) => void,
			) => {
				hub.queries.push({ resolverId, method, hostname, settle: callback });
			};
		return {
			resolve4: record("resolve4"),
			resolve6: record("resolve6"),
			cancel: () => hub.cancels.push(resolverId),
		};
	});
	return hub;
}

export function queriesFor(
	hub: DnsResolverHub,
	hostname: string,
): Array<DnsQuery> {
	return hub.queries.filter((query) => query.hostname === hostname);
}

export function settleAll(
	queries: Array<DnsQuery>,
	err: NodeJS.ErrnoException | null,
	addresses: Array<string>,
): void {
	for (const query of queries) query.settle(err, addresses);
}

export const dnsNotFound = (): NodeJS.ErrnoException =>
	Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
