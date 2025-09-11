# CeraUI Backend (CERALIVE)

This is the backend for CERALIVE devices, originally forked from the BELABOX belaUI project. This codebase has been ported to Typescript and ESM (ECMAScript Modules). This fork is maintained by CERALIVE and includes additional features and improvements.

## CeraUI Integration

This fork includes an option to use the [CeraUI](https://github.com/CERALIVE/CeraUI) interface, which is an alternative user interface designed for enhanced usability and additional features. When the `USE_CERAUI` option is enabled during installation or deployment, the system will download the latest CeraUI main package from the [release](https://github.com/CERALIVE/CeraUI/releases/latest) and use it instead of the standard BelaUI interface.

## Install the fork on your CERALIVE device

> **Note:** Replacing the original UI directly may cause issues. When your CERALIVE device is updated, it can revert the UI. Ensure you monitor updates and reapply the override after updates.

- Enable SSH for the default user (`user`) on your existing belaUI
- Connect to the CERALIVE device via SSH (use Putty on Windows, JuiceSSH on Android)
- Then run:

  ```bash
  # Standard installation with BelaUI
  wget -qO- https://raw.githubusercontent.com/CERALIVE/belaUI-ts/main/install.sh | bash
  ```

  or

  ```bash
  # Installation with CeraUI interface
  wget -qO- https://raw.githubusercontent.com/CERALIVE/belaUI-ts/main/install.sh | USE_CERAUI=true bash
  ```

- To get back to the default belaUI, you can then run `sudo bash /opt/belaUI/reset-to-default.sh` through SSH.

## Installation Script

This repository includes a unified installation script (`install.sh`) that handles both local installation and remote deployment:

### Local Installation (from GitHub releases)

```bash
# Standard installation
./install.sh

# With CeraUI interface
USE_CERAUI=true ./install.sh
```

### Remote Deployment (from local dist folder)

```bash
# Standard deployment
./install.sh --remote [SSH_TARGET]

# With CeraUI interface
USE_CERAUI=true ./install.sh --remote [SSH_TARGET]

# Examples
./install.sh --remote root@belabox.local
./install.sh --remote root@192.168.1.100
```

Use `./install.sh --help` to see all available options.

> **Note:** The previous separate `install.sh` and `deploy-to-local.sh` scripts have been unified into a single `install.sh` script. The old scripts are available as `.bak` files for reference and will be removed in a future release.

## Development

### Prerequisites

You will need to have [bun.sh](https://bun.sh/docs/installation) in version v1.2.3 or newer installed to run the scripts.

### Install dependencies

To install the dependencies, you can use the following command:

```bash
bun install
```

### Run locally on dev machine

Local development is not really supported. Ideally you have a CERALIVE device to test changes. Build for production (see below) and deploy with the deploy script (see above).

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

## Install built version to CERALIVE device

### Preparation

It is recommended to create an SSH key pair and install public key on the CERALIVE device, since the deployment script uses
multiple ssh calls that would require you to type the password each time.

You can follow this tutorial to generate the key
pair: https://www.digitalocean.com/community/tutorials/how-to-set-up-ssh-keys-on-ubuntu-22-04

### Set up on the CERALIVE device

- Enable SSH for the default user (`user`) and connect via SSH
- Enable SSH on boot to make things easier (`sudo systemctl enable ssh`)
- Use `sudo su` to get root privileges and add to the authorized keys for the root user.
  Add the generated public ssh key to `/root/.ssh/authorized_keys` or create the file if it does not exist yet:
  1. Create the directory if it does not exist: `mkdir -p /root/.ssh`
  2. Append your ssh key to the `authorized_keys` file (replace `ssh-...` with your generated public key):
     `echo "ssh-..." >> /root/.ssh/authorized_keys`).
- Install rsync (`sudo apt install rsync`)
- Install an editor (e.g. `sudo apt install nano`)

### Set up on host (currently tested on macOS)

- Install the generated private ssh key on the host (e.g. `~/.ssh/id_rsa` and `~/.ssh/id_rsa.pub`)
- It might be necessary or recommended to install a newer version of rsync from brew or similar (not tested if
  necessary)
- Run the deployment script by specifying the SSH target as an argument. For example, to deploy as root to a host at 192.168.100.100, run:

```bash
# Standard deployment with BelaUI
./install.sh --remote root@192.168.100.100

# Deployment with CeraUI interface
USE_CERAUI=true ./install.sh --remote root@192.168.100.100
```

### Reset to default belaUI

To reset the CERALIVE device to the default belaUI, you can run the reset script from the host (`./reset-local.sh`).

## License

This project is licensed under the **GPL-3.0 License**. See the [LICENSE](LICENSE) file for more details.
