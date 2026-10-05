<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## THE INTERFACE ADDRESS IS REPORTED, NOT SET [EXISTS]

`handleNetif` (`network-interfaces.ts`) reads `msg.ip` for exactly ONE purpose — the
echo guard `if (int.ip !== msg.ip) return;` — and then mutates `enabled` and nothing
else. **There is no apply path for an address anywhere in this backend**: no `ip
addr`, no `nmcli ipv4.addresses`, no persisted static config, for any interface kind.

The frontend used to offer a "Static IP address" field on top of that. Measured on
the bench Rock 5B+ (2026-08-16), saving `192.168.0.222` onto a dongle leased
`192.168.0.169`:

```
UI                  → toast "Saved"
ip -br -4 addr      → enx344b50000000  UP  192.168.0.169/24   (unchanged)
nmcli con show      → ipv4.method: auto   ipv4.addresses:      (untouched)
journalctl -u ceralive → not one line about the request
```

And the dead field was DESTRUCTIVE, not merely inert: a save that also flipped the
bond toggle was discarded WHOLE, because the edited address no longer matched the
observed one and the guard early-returns before touching `enabled`. Board-proven —
bonding toggled off, "Saved" toasted, row still read "In Bond".

- **The frontend now ECHOES the observed address** (`iface.ip`) rather than authoring
  one, so the guard reads as the concurrency check it is and the operator cannot trip
  it. The wire contract is unchanged; `netifConfigInputSchema.ip` stays optional and
  an address-less interface still OMITS it (`""` fails the regex).
- **A direct RPC call with a mismatched address is now REFUSED, not silently dropped.**
  This was a REAL remaining defect at the procedure layer —
  `configureNetworkInterfaceProcedure` returned `{success: true, applied}` whichever
  way `handleNetif` went, so a discarded save (including the bond toggle it carried)
  reached the caller as "Saved". `handleNetif` now returns a typed `NetifApplyOutcome`
  and the procedure forwards it as `{success:false, error}` — see THE NETIF RPC
  ANSWERS FOR WHAT IT ACTUALLY APPLIED below.
- **Do NOT re-add an address input anywhere** without first implementing the apply
  path. A control that cannot act is the defect; the missing feature is static
  addressing, and it is missing in the BACKEND, not in the dialog.

Frontend half: `apps/frontend/AGENTS.md` → "The interface address is REPORTED".

