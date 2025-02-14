# BelaUI fork (typescript/esm and moblink)

## Known issues

- BEWARE! In general there are quite a few problems the fork (esp. with modems) that stem from the typescript conversion
- I'm pretty sure there is a bug somewhere that prevent disconnecting Wifi interfaces

## Set up on the belabox

- Enable SSH for the default user (`user`) and connect via SSH
- Enable SSH on boot to make things easier (`sudo systemctl enable ssh`)
- Create an SSH key pair and install public key on the belabox, since the deploy script uses many separate ssh calls that would require you to type the password too many times (https://www.digitalocean.com/community/tutorials/how-to-set-up-ssh-keys-on-ubuntu-22-04)
- Use `sudo su` to get root privileges and add to the authorized keys for the root user (add to/create `/root/.ssh/authorized_keys`: `mkdir -p /root/.ssh`, `echo "ssh-..." >> /root/.ssh/authorized_keys`).
- Install rsync (`sudo apt install rsync`)
- Install an editor (e.g. `sudo apt install nano`)
- Edit the `/opt/belaUI/setup.json` and add the following lines to your existing setup to enable the moblink relay:
```json
  "moblink_relay_enabled": true,
  "moblink_relay_bin": "/opt/moblink-rust-relay/target/release/moblink-rust-relay",
  "moblink_relay_streamer_password": "1234"
```

## Set up on host (currently tested on macos)

- Install the private ssh key
- Install bun.sh (https://bun.sh/)
- It might be necessary or recommended to install a newer version of rsync from brew or similar (not tested if necessary)
- Run the deploy script (`./deploy-to-local.sh`), if necessary change the host or user (`SSH_TARGET`), e.g. `SSH_TARGET=user@belabox.local`.

## TODO

- Make deployment easier
- Ship a binary for the moblink relay (https://github.com/moo-the-cow/moblink-rust-relay)
- Do not expose the default route as a moblink relay, if the streamer is connected to a hotspot. We should still run a relay if the streamer is connected through a shared network!
- Add a way to configure the moblink relay password
- Visualize the moblink relay status in the UI
- Enabling/disabling Interfaces in the UI takes too long to take effect for the relays

## Ideas

- SRT Ingest: https://github.com/dimadesu/srt-ingest-for-belabox
- SRT(LA) to a local target (aka target IP is in a local network) should only use local network interfaces
