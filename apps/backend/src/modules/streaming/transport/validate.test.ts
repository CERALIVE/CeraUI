import { afterEach, describe, expect, it } from "bun:test";

import { probeReachability } from "./validate.ts";

type AnyUdpSocket = Awaited<ReturnType<typeof Bun.udpSocket>>;

const open: AnyUdpSocket[] = [];

afterEach(() => {
	while (open.length > 0) {
		try {
			open.pop()?.close();
		} catch {
			// already closed
		}
	}
});

describe("probeReachability", () => {
	it("reports reachable when the peer answers", async () => {
		const server = await Bun.udpSocket({
			socket: {
				data(socket, _buf, port, addr) {
					socket.send("pong", port, addr);
				},
			},
		});
		open.push(server);

		const result = await probeReachability("127.0.0.1", server.port, 1000);
		expect(result).toEqual({ reachable: true });
	});

	it("reports refused when no listener is bound to the port", async () => {
		// Bind then immediately release a port so it is almost certainly closed;
		// a connected UDP probe to a dead loopback port draws ICMP unreachable.
		const placeholder = await Bun.udpSocket({});
		const deadPort = placeholder.port;
		placeholder.close();

		const result = await probeReachability("127.0.0.1", deadPort, 1000);
		expect(result).toEqual({ reachable: false, reason: "refused" });
	});

	it("reports timeout when an open port never answers", async () => {
		// A bound-but-silent listener keeps the port open (no ICMP refusal) and
		// never replies, so the probe can only resolve via its timeout bound.
		const silent = await Bun.udpSocket({ socket: { data() {} } });
		open.push(silent);

		const start = Date.now();
		const result = await probeReachability("127.0.0.1", silent.port, 150);
		expect(result).toEqual({ reachable: false, reason: "timeout" });
		expect(Date.now() - start).toBeGreaterThanOrEqual(140);
	});

	it("settles within the timeout bound even for a black-hole address", async () => {
		// TEST-NET-1 (RFC 5737) is non-routable; packets are dropped → timeout,
		// and the promise must still settle inside the bound (no event-loop wedge).
		const start = Date.now();
		const result = await probeReachability("192.0.2.1", 9999, 200);
		expect(result.reachable).toBe(false);
		expect(Date.now() - start).toBeLessThan(2000);
	});
});
