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

import "./modules/ui/jquery.ts";
import "jquery-ui";
import "jquery-ui/ui/widgets/mouse.js";
import "jquery-ui/ui/widgets/slider.js";
import "../vendor/jquery.ui.touch-punch.js";
import "bootstrap/js/dist/index.js";
import "bootstrap/js/dist/util.js";
import "bootstrap/js/dist/modal.js";
import "bootstrap/js/dist/collapse.js";
import "bootstrap/js/dist/tooltip.js";

import { initRemote } from "./modules/remote/remote.ts";
import { initRemoteRelays } from "./modules/remote/remote-relays.ts";
import { initPipelines } from "./modules/streaming/pipelines.ts";
import { initStreamingUi } from "./modules/streaming/streaming.ts";
import { initSoftwareUpdate } from "./modules/system/software-update.ts";
import { initSsh } from "./modules/system/ssh.ts";
import { initCommandButtons } from "./modules/ui/command-button.ts";
import { initCopyToClipboard } from "./modules/ui/copy-to-clipboard.ts";
import { initLogin } from "./modules/ui/login.ts";
import { initPasswordBoxes } from "./modules/ui/password-box.ts";
import { initTheme } from "./modules/ui/theme.ts";
import { initWebsocket } from "./modules/ui/websocket.ts";
import {initSliderLocks} from "./modules/ui/sliders-lock.ts";
import {initAutoStart} from "./modules/ui/auto-start.ts";

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
initSliderLocks();
initAutoStart();
