/*!
    belaUI - web UI for the BELABOX project
    Copyright (C) 2020-2022 BELABOX project

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

import "bootstrap/dist/css/bootstrap.css";
import "jquery-ui/themes/base/all.css";
import "./style.css";

import "./modules/jquery.ts";
import "jquery-ui";
import "jquery-ui/ui/widgets/mouse.js";
import "jquery-ui/ui/widgets/slider.js";
import "../vendor/jquery.ui.touch-punch.js";
import "bootstrap/js/dist/index.js";
import "bootstrap/js/dist/util.js";
import "bootstrap/js/dist/modal.js";
import "bootstrap/js/dist/collapse.js";
import "bootstrap/js/dist/tooltip.js";

import { initCommandButtons } from "./modules/command-button.ts";
import { initCopyToClipboard } from "./modules/copy-to-clipboard.ts";
import { initLogin } from "./modules/login.ts";
import { initPasswordBoxes } from "./modules/password-box.ts";
import { initPipelines } from "./modules/pipelines.ts";
import { initRemoteRelays } from "./modules/remote-relays.ts";
import { initRemote } from "./modules/remote.ts";
import { initSoftwareUpdate } from "./modules/software-update.ts";
import { initSsh } from "./modules/ssh.ts";
import { initStreamingUi } from "./modules/streaming.ts";
import { initTheme } from "./modules/theme.ts";
import { initWebsocket } from "./modules/websocket.ts";

initTheme();
initWebsocket();
initRemote();
initSoftwareUpdate();
initSsh();
initPipelines();
initRemoteRelays();
initStreamingUi();
initLogin();
initCommandButtons();
initPasswordBoxes();
initCopyToClipboard();
