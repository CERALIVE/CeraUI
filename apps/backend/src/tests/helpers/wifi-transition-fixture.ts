import { expect, spyOn } from "bun:test";
import { statusResponseSchema } from "@ceraui/rpc/schemas";
import * as regdomain from "../../modules/wifi/regdomain.ts";
import * as compat from "../../rpc/compat.ts";
import { firstAp } from "./wifi-first-ap-fixture.ts";

export async function isolateTransition(hybrid = false) {
	const f = await firstAp(undefined, hybrid);
	spyOn(regdomain, "runIw").mockResolvedValue("");
	const peer: unknown[][] = [];
	const collect = (scope: string, type: string, payload: unknown) => {
		if (type !== "status") return;
		const row = statusResponseSchema.parse(payload).wifi?.[f.row.id];
		if (row) peer.push([scope, row.incarnation, row.transition, row.leaving]);
	};
	spyOn(compat, "broadcastMsg").mockImplementation((type, payload) =>
		collect("normal", type, payload),
	);
	spyOn(compat, "broadcastMsgLocal").mockImplementation((type, payload) => {
		collect("local", type, payload);
		return "";
	});
	const startAccepted = async () => {
		expect(await f.start()).toEqual({ success: true });
		const uuid = f.created();
		if (!uuid) throw new Error("Missing fixture AP");
		return uuid;
	};
	return { ...f, peer, startAccepted, collect };
}
