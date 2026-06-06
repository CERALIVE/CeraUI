/*
    CeraUI - web UI for the CERALIVE project
    Copyright (C) 2024-2025 CeraLive project


    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/**
 * Post-connection reachability probe.
 *
 * The relay-validate RPC's final stage: once the host has been DNS-resolved to
 * an IP, prove the operator's `addr:port` is actually reachable WITHOUT opening
 * a full SRT/SRTLA session. SRTLA and SRT both run over UDP, so this sends a
 * single tiny datagram on a *connected* UDP socket and waits — bounded by a
 * hard timeout — for one of three outcomes:
 *
 *   • a reply datagram          → reachable (peer is alive and answered)
 *   • an ICMP port-unreachable  → refused   (surfaced as the socket `error`
 *                                 handler on a connected UDP socket)
 *   • neither within `timeoutMs`→ timeout   (dropped / filtered / silent)
 *
 * The probe is fully async (no synchronous network I/O) and self-bounding: the
 * timer guarantees the promise settles within `timeoutMs` even if the OS never
 * reports anything, so it can never wedge the event loop.
 *
 * NOTE: `Bun.udpSocket` does NOT perform DNS resolution (`send`/`connect` take
 * IPs only), so callers MUST pass an already-resolved IP — the `dns` stage in
 * the procedure does that resolution and hands the IP down here.
 */

/** Hard upper bound on how long a single probe may run. */
export const PROBE_TIMEOUT_MS = 3000;

/** A benign 4-byte payload — enough to elicit an ICMP refusal on a dead port. */
const PROBE_PAYLOAD = new Uint8Array([0x00, 0x00, 0x00, 0x00]);

/** Outcome of a reachability probe. */
export type ProbeResult =
	| { reachable: true }
	| { reachable: false; reason: "timeout" | "refused" };

/**
 * Probe `ip:port` for UDP reachability, bounded by `timeoutMs`.
 *
 * @param ip        An already-resolved IPv4/IPv6 address (NOT a hostname).
 * @param port      Destination port.
 * @param timeoutMs Hard timeout; the promise always settles within this window.
 */
export async function probeReachability(
	ip: string,
	port: number,
	timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
	return await new Promise<ProbeResult>((resolve) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let socket: Awaited<ReturnType<typeof Bun.udpSocket>> | undefined;

		const finish = (result: ProbeResult): void => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			try {
				socket?.close();
			} catch {
				// socket may already be closed/closing — ignore.
			}
			resolve(result);
		};

		Bun.udpSocket({
			connect: { hostname: ip, port },
			socket: {
				// Any inbound datagram from the connected peer proves reachability.
				data(): void {
					finish({ reachable: true });
				},
				// On a connected UDP socket an ICMP port-unreachable surfaces here.
				error(): void {
					finish({ reachable: false, reason: "refused" });
				},
			},
		})
			.then((s) => {
				if (settled) {
					try {
						s.close();
					} catch {
						// already settled (e.g. immediate timeout) — just drop it.
					}
					return;
				}
				socket = s;
				timer = setTimeout(
					() => finish({ reachable: false, reason: "timeout" }),
					timeoutMs,
				);
				try {
					s.send(PROBE_PAYLOAD);
				} catch {
					// A synchronous send failure (e.g. instant ECONNREFUSED) means
					// the peer rejected us outright.
					finish({ reachable: false, reason: "refused" });
				}
			})
			.catch(() => {
				// Socket creation/connect failed — treat as a hard refusal.
				finish({ reachable: false, reason: "refused" });
			});
	});
}
