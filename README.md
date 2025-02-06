# BelaUI fork (typescript/esm and moblink)

## Known issues

- BEWARE! In general there are quite a few problems the fork (esp. with modems) that stem from the typescript conversion
- I'm pretty sure there is a bug somewhere that prevent disconnecting Wifi interfaces
- On the last test the moblink autodiscovery was kinda broken again, so you might need to toggle moblink on/off in Moblin before starting stream, while the belaUI fork is running already.

## Set up on the belabox

- Enable SSH on boot to make things easier (`sudo systemctl enable ssh`)
- Create a SSH key pair and install public key on the belabox, since the deploy script uses many separate ssh calls that would require you to type the password too many times (https://www.digitalocean.com/community/tutorials/how-to-set-up-ssh-keys-on-ubuntu-22-04). I added them for the root user (add to/create `/root/.ssh/authorized_keys`), but it might be possible to use the belabox user "user" instead.
- Install git/curl/rust on the belabox (we should be able to have a binary to ship at some point). See `dist/install-moblink-rust-relay.sh` for an untested script.
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

- Use newer moblink-rust-relay version that supports autodiscovery and does not need two bind addresses
- Fix the typescript conversion issues
- Fix the wifi disconnect issue
- Make deployment easier
- Ship a binary for the moblink relay