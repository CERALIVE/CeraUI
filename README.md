# CeraUI

CeraUI is a modern user interface built with **Svelte + Vite**, designed as an alternative frontend for [belaUI](https://github.com/BELABOX/belaUI). It communicates with the BELABOX WebSocket backend to provide a fast, interactive, and user-friendly experience.

## Features

- **Svelte 5 + Vite**: Enjoy a highly reactive and efficient UI built with the latest Svelte and Vite tooling.
- **Modern Design**: A sleek and minimalistic interface for an enhanced user experience.
- **Responsive Design**: The UI is optimized for all screen sizes.
- **WebSocket Integration**: Seamlessly communicates with the BELABOX backend.
- **Flexible Deployment**: Choose to serve on a different port with PM2 or replace the existing belaUI content.
- **Remote Control**: Full remote control functionality even without the automatic relay server selection feature.

## Objectives

One of the long-term objectives of this project, which will commence once the UI has full functionality, is to support both maintaining **vanilla** BELABOX builds (as seen on [belabox.net](https://belabox.net/)) and creating a separate branch for custom development to extend BELABOX functionalities. Additionally, I am interested in the way [pjeweb/belaUI](https://github.com/pjeweb/belaUI) was restructured.

## Roadmap

- **Updating Overlay Image**: Find a better picture for the updating overlay.

## Installation

### Prerequisites

- **Node.js** (v16 or later recommended)
- **pnpm** (or npm/yarn)

### Clone the Repository

```sh
git clone https://github.com/CERALIVE/CeraUI.git
cd CeraUI
```

### Install Dependencies

Using `pnpm` (recommended):

```sh
pnpm install
```

Or using `npm`:

```sh
npm install
```

### Local Development Setup

For development, you can run the project in dev mode from your computer. First, copy the `.env.example` file to `.env`:

```sh
cp .env.example .env
```

Then, replace the `VITE_SOCKET_ENDPOINT` value in the `.env` file with the BELABOX IP address on your local network.

**Important:** Before building for production, remove the `.env` file so that the UI can load the IP dynamically from `window.location`.

### Running the Development Server

After setting up your environment, start the development server:

```sh
pnpm run dev
```

This will start a local development server, usually accessible at `http://localhost:5173/`.

### Building for Production

Generate an optimized production build:

```sh
pnpm run build
```

The production build will be output to the `dist` directory.

### Preview Production Build

To serve the production build locally:

```sh
pnpm run preview
```

## Deployment Options

### Serving on a Different Port with PM2

You can serve the UI on a different port using **PM2** and ensure it runs at startup:

1. Install PM2 globally if you haven't already:

    ```sh
    npm install -g pm2
    ```

2. Install a static server like `serve`:

    ```sh
    npm install -g serve
    ```

3. Start serving the production build with PM2 on port `8080` (or any port of your choice):

    ```sh
    pm2 start "serve -s dist -l 8080" --name CeraUI
    ```

4. Save the PM2 process list and configure it to run at startup:

    ```sh
    pm2 save
    pm2 startup
    ```

### Replacing the Existing belaUI Frontend

If you prefer to replace the original belaUI frontend with CeraUI, copy the build files into the correct location:

```sh
sudo cp -r dist/* /opt/belaUI/public/
```

> **Note:** Replacing the original UI directly may cause issues. When belaUI is updated, it can overwrite these files, removing your custom UI. Ensure you monitor updates and reapply your changes if necessary.

## Documentation

### Development Tools

- **[DevTools Tab](docs/DEVTOOLS.md)**: Comprehensive guide to the development utilities and debugging tools available in the DevTools tab. Includes component testing, console debugging, system information, and troubleshooting guides.

## License

This project is licensed under the **GPL-3.0 License**. See the [LICENSE](LICENSE) file for more details.
