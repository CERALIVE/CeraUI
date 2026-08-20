/*
    CeraUI - web UI for the CeraLive project
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

/*
 * The REPLACE-NOT-PATCH request documents, and nothing else.
 *
 * Every HiLink write endpoint this build touches replaces the record it is sent
 * rather than merging into it, so a document that names one field silently
 * resets the others to firmware defaults. That is a whole class of defect — an
 * operator toggles roaming and loses their MTU; an operator picks a radio mode
 * and loses their band mask; an operator moves the LAN subnet and loses the DHCP
 * pool — and it is invisible until something else stops working.
 *
 * So the rule lives in ONE pure module: each builder echoes every OTHER member
 * of the record from the document the device just returned, each echo has a
 * STATED fallback, and the whole matrix is provable against captured bodies with
 * no device, no session and no transport.
 *
 * A fallback is chosen in the direction that keeps the device usable rather than
 * the direction that looks tidy: all-bands rather than no-bands, DHCP enabled
 * rather than disabled.
 */

import { XML_HEADER } from "./hilink-session.ts";
import type { HilinkDhcpRecord } from "./router-subnet-plan.ts";
import { xmlValue } from "./vendor-xml.ts";

/** `xmlValue`, with the stated fallback this module's whole contract rests on. */
function keeper(current: string): (tag: string, fallback: string) => string {
	return (tag, fallback) => xmlValue(current, tag) ?? fallback;
}

/**
 * Re-emit the WHOLE `/api/dialup/connection` document with one field changed.
 *
 * The endpoint replaces the record rather than patching it, so posting the
 * roaming flag alone would reset `MTU`, the idle timeout and the auto-dial
 * flags to whatever the firmware defaults to. The other five values are
 * therefore echoed back exactly as the device just reported them.
 */
export function hilinkConnectionBody(
	current: string,
	roamingAutoconnect: boolean,
): string {
	const keep = keeper(current);
	return (
		`${XML_HEADER}<request>` +
		`<RoamAutoConnectEnable>${roamingAutoconnect ? 1 : 0}</RoamAutoConnectEnable>` +
		`<MaxIdelTime>${keep("MaxIdelTime", "600")}</MaxIdelTime>` +
		`<ConnectMode>${keep("ConnectMode", "0")}</ConnectMode>` +
		`<MTU>${keep("MTU", "1500")}</MTU>` +
		`<auto_dial_switch>${keep("auto_dial_switch", "1")}</auto_dial_switch>` +
		`<pdp_always_on>${keep("pdp_always_on", "1")}</pdp_always_on>` +
		`</request>`
	);
}

/**
 * Re-emit the WHOLE `/api/net/net-mode` document with the mode changed.
 *
 * The two band masks are the record's other members and are echoed verbatim.
 * Their fallbacks are the vendor's own all-bands values, so a device that
 * answered the mode but not the masks is widened to "every band this radio has"
 * rather than narrowed to none — the failure direction that keeps a radio usable.
 */
export function hilinkNetModeBody(current: string, modeId: string): string {
	const keep = keeper(current);
	return (
		`${XML_HEADER}<request>` +
		`<NetworkMode>${modeId}</NetworkMode>` +
		`<NetworkBand>${keep("NetworkBand", "3FFFFFFF")}</NetworkBand>` +
		`<LTEBand>${keep("LTEBand", "7FFFFFFFFFFFFFFF")}</LTEBand>` +
		`</request>`
	);
}

/**
 * Re-emit the WHOLE `/api/dhcp/settings` record with the LAN subnet moved.
 *
 * This is the endpoint where replace-not-patch bites hardest: posting only the
 * new address would reset the DHCP pool, the lease time and both DNS entries to
 * firmware defaults, and the operator would discover it the next time a client
 * failed to lease. `router-subnet-plan.ts` has already carried every member
 * forward; this builder just serializes what it decided.
 */
export function hilinkDhcpSettingsBody(record: HilinkDhcpRecord): string {
	return (
		`${XML_HEADER}<request>` +
		`<DhcpIPAddress>${record.address}</DhcpIPAddress>` +
		`<DhcpLanNetmask>${record.netmask}</DhcpLanNetmask>` +
		`<DhcpStatus>${record.dhcpStatus}</DhcpStatus>` +
		`<DhcpStartIPAddress>${record.startAddress}</DhcpStartIPAddress>` +
		`<DhcpEndIPAddress>${record.endAddress}</DhcpEndIPAddress>` +
		`<DhcpLeaseTime>${record.leaseTime}</DhcpLeaseTime>` +
		`<DnsStatus>${record.dnsStatus}</DnsStatus>` +
		`<PrimaryDns>${record.primaryDns}</PrimaryDns>` +
		`<SecondaryDns>${record.secondaryDns}</SecondaryDns>` +
		`</request>`
	);
}
