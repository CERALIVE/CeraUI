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

/* Pipelines */
import { config } from "../config.ts";
import {updateOptionList} from "../ui/options-list.ts";

type Pipeline = {
	name: string;
	disabled: boolean;
	asrc?: boolean;
	acodec?: boolean;
};

let pipelines: Record<string, Pipeline> = {};

export function getPipelines() {
	return pipelines;
}

export function updatePipelines(ps: Record<string, Pipeline> | null) {
	if (ps != null) {
		pipelines = ps;
	}

	updateOptionList($('#pipelines'), [pipelines], config.pipeline);

	const value = String($("#pipelines").val());

	pipelineSelectHandler(value);
}

function pipelineSelectHandler(s: string) {
	const p = pipelines[s];
	if (!p) return;

	if (p.asrc) {
		$("#selectAudioSource").removeClass("d-none");
	} else {
		$("#selectAudioSource").addClass("d-none");
	}

	if (p.acodec) {
		$("#selectAudioCodec").removeClass("d-none");
	} else {
		$("#selectAudioCodec").addClass("d-none");
	}
}

export function initPipelines() {
	$("#pipelines").on("change", (ev) => {
		pipelineSelectHandler((ev.target as HTMLInputElement).value);
	});
}
