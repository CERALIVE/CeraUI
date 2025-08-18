/*
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

import {config} from "../config.ts";
import {ws} from "./websocket.ts";

export function initAutoStart(): void {
    $('#autoStart').on('change', function (this: HTMLInputElement) {
        if (this.checked) {
            const confirmed = confirm(
                'Warning: Enabling this option will cause the encoder to start streaming automatically upon power-up or reset, potentially at unintended times. Do not enable this setting if automatic streaming poses any privacy or safety risks.'
            );
            if (!confirmed) {
                this.checked = false;
            }
        }

        const settingChanged = this.checked !== (config.autostart ?? false);
        const form = $(this).closest('form');
        form.find('button[type=submit]').prop('disabled', !settingChanged);
    });

    $('#autoStartForm').on('submit', function (event: JQuery.SubmitEvent) {
        event.preventDefault();

        const autostart = ($('#autoStart').prop('checked') as boolean);
        ws?.send(JSON.stringify({ config: { autostart } }));

        return false;
    });
}
