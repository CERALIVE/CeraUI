# BelaUI Fork

This is a fork of the default BELABOX UI (belaUI), that ported the code to Typescript and ESM (ECMAScript Modules) and
added a moblink relay feature.

## Getting started (one-liner)


- Enable SSH for the default user (`user`) and connect via SSH
- The run:
  ```bash
  wget -qO- https://raw.githubusercontent.com/pjeweb/belaui/override/install.sh | bash
  ```

## Getting started (long version)

### Preparation

It is recommended to create an SSH key pair and install public key on the BELABOX, since the deployment script uses
multiple ssh calls that would require you to type the password each time.

You can follow this tutorial to generate the key
pair: https://www.digitalocean.com/community/tutorials/how-to-set-up-ssh-keys-on-ubuntu-22-04

### Set up on the BELABOX

- Enable SSH for the default user (`user`) and connect via SSH
- Enable SSH on boot to make things easier (`sudo systemctl enable ssh`)
- Use `sudo su` to get root privileges and add to the authorized keys for the root user.
  Add the generated public ssh key to `/root/.ssh/authorized_keys` or create the file if it does not exist yet:
    1) Create the directory if it does not exist: `mkdir -p /root/.ssh`
    2) Append your ssh key to the `authorized_keys` file (replace `ssh-...` with your generated public key):
       `echo "ssh-..." >> /root/.ssh/authorized_keys`).
- Install rsync (`sudo apt install rsync`)
- Install an editor (e.g. `sudo apt install nano`)
- Edit the `/opt/belaUI/setup.json` and add the following line to your existing setup to enable the moblink relay:
    ```json
      "moblink_relay_enabled": true
    ```
  Make sure to add commas to the end of the lines before and after the new line, if necessary.

### Set up on host (currently tested on macOS)

- Install the generated private ssh key on the host (e.g. `~/.ssh/id_rsa` and `~/.ssh/id_rsa.pub`)
- It might be necessary or recommended to install a newer version of rsync from brew or similar (not tested if
  necessary)
- Run the deployment script (`./deploy-to-local.sh`), if necessary change the host or user (`SSH_TARGET`), e.g.
  `SSH_TARGET=root@192.168.100.100`.

## Reset to default belaUI

To reset the BELABOX to the default belaUI, you can run the reset script (`./reset-local.sh`).

## Development

### Install dependencies

To install the dependencies, you can use the following commands:

```bash
bun install
cd ui; bun install; cd ..
```

### Run locally

Local development is not really supported. Ideally you have a BELABOX to test changes.

You can run the UI locally with the following command:

```bash
bun run dev:ui
```

To run the server locally, you can use the following command:

```bash
bun run dev:server
```

### Build for production

To build the UI for production, you can use the following command:

```bash
bun run build
```

### Update moblink-rust-relay

To update the moblink-rust-relay you can run the following command:

```bash
bun run fetch-moblink-relay
```

### TODOs

- Make deployment easier (debian package?)
- Do not expose the default route as a moblink relay, if the streamer is connected to a hotspot. We should still run a
  relay if the streamer is connected through a shared network!
- Add a way to configure the moblink relay password (It is possible to change it in the `setup.json` for now)
- Visualize the moblink relay status in the UI
- Enabling/disabling Interfaces in the UI takes too long to take effect for the relays

### Ideas

- Add a button to reset a modem from the UI
- SRT Ingest: https://github.com/dimadesu/srt-ingest-for-belabox
- SRT(LA) to a local target (aka target IP is in a local network) should only use local network interfaces
