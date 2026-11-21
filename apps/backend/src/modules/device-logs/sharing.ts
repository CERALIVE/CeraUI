type SharingState =
	| { readonly phase: "preparing" | "streaming" }
	| {
			readonly phase: "issued";
			readonly expiresAt: number;
			readonly revoke: () => void;
	  };

type SharingLease = { readonly conn: object | null; state: SharingState };
let owner: SharingLease | null = null;

export function reserveLogSharing(conn: object | null, now = Date.now()) {
	if (owner) {
		const { state } = owner;
		if (
			state.phase !== "issued" ||
			(state.expiresAt > now && (conn === null || owner.conn !== conn))
		)
			return null;
		state.revoke();
	}
	const lease: SharingLease = { conn, state: { phase: "preparing" } };
	owner = lease;
	return {
		issue(expiresAt: number, revoke: () => void) {
			lease.state = { phase: "issued", expiresAt, revoke };
		},
		stream() {
			lease.state = { phase: "streaming" };
		},
		release() {
			if (owner !== lease) return;
			if (lease.state.phase === "issued") lease.state.revoke();
			owner = null;
		},
	};
}
