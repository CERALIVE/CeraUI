# BelaUI Fork

This is a fork of the default BELABOX UI (belaUI), that ported the code to Typescript and ESM (ECMAScript Modules) and
added a moblink relay feature.

## CeraUI Integration

This fork includes an option to use the [CeraUI](https://github.com/CERALIVE/CeraUI) interface, which is an alternative user interface designed for enhanced usability and additional features. When the `USE_CERAUI` option is enabled during installation or deployment, the system will download the latest CeraUI [release](https://github.com/CERALIVE/CeraUI/releases/latest) and use it instead of the standard BelaUI interface.

## Install the fork on your BELABOX

> **Note:** Replacing the original UI directly may cause issues. When your BELABOX is updated, it can revert the UI. Ensure you monitor updates and reapply the override after updates.

- Enable SSH for the default user (`user`) on your existing belaUI
- Connect to the BELABOX via SSH (use Putty on Windows, JuiceSSH on Android)
- Then run:
  ```bash
  # Standard installation with BelaUI
  wget -qO- https://raw.githubusercontent.com/pjeweb/belaui/override/install.sh | bash
  
  # Installation with CeraUI interface
  wget -qO- https://raw.githubusercontent.com/pjeweb/belaui/override/install.sh | USE_CERAUI=true bash
  ```
- To get back to the default belaUI, you can then run `sudo bash /opt/belaUI/reset-to-default.sh` through SSH.

## Development

### Prerequisites

You will need to have [bun.sh](https://bun.sh/docs/installation) in version v1.2.3 or newer installed to run the scripts.

### Install dependencies

To install the dependencies, you can use the following command:

```bash
bun install
```

### Run locally on dev machine

Local development is not really supported. Ideally you have a BELABOX to test changes. Build for production (see below) and deploy with the deploy script (see above).

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

## Install built version to BELABOX

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
- Run the deployment script by specifying the SSH target as an argument. For example, to deploy as root to a host at 192.168.100.100, run:

```bash
# Standard deployment with BelaUI
./deploy-to-local.sh root@192.168.100.100

# Deployment with CeraUI interface
USE_CERAUI=true ./deploy-to-local.sh root@192.168.100.100
```

### Reset to default belaUI

To reset the BELABOX to the default belaUI, you can run the reset script from the host (`./reset-local.sh`).

## License

This project is licensed under the **GPL-3.0 License**. See the [LICENSE](LICENSE) file for more details.
