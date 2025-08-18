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

type Option = { name: string; disabled?: boolean };

export function updateOptionList(
    select: JQuery<HTMLOptionElement>,
    options: Array<Record<string, Option>>,
    selected: string | null = null
): void {
    const validIds: { [key: string]: boolean } = {};

    let entriesToDeselect: JQuery<HTMLOptionElement>[] = [];
    let entryToSelect: JQuery<HTMLOptionElement> | undefined;
    let prevOption: JQuery<HTMLOptionElement> | undefined;

    for (const o in options) {
        for (const value in options[o]) {
            const id = `o_${o}_${value}`;
            validIds[id] = true;

            let entry = select.find(`.${id}`);
            if (entry.length == 0) {
                const html = '<option></option>'
                entry = $(html);
                entry.addClass(id);
                entry.data('option_id', id);
                entry.attr('value', value);

                if (prevOption) {
                    entry.insertAfter(prevOption);
                } else {
                    select.prepend(entry);
                }
            }

            const contents = options[o][value].name;
            if (contents != entry.text()) {
                entry.text(contents);
            }
            const isDisabled = options[o][value].disabled;
            if (entry.prop('disabled') !== isDisabled) {
                entry.prop('disabled', isDisabled);
            }
            const isSelected = (selected && value == selected);
            const wasSelected = entry.prop('selected');
            if (isSelected && !wasSelected) {
                entryToSelect = entry;
            }
            if (!isSelected && wasSelected) {
                entriesToDeselect.push(entry);
            }

            prevOption = entry;
        }
    } // for o in options

    // Delete removed options
    select.find('option').each(function () {
        const option = $(this)
        const optionId = option.data('option_id');
        if (optionId && !validIds[optionId]) {
            option.remove();
        }
    });

    // Update the selected entry if it's changed
    // First, we have to deselect any other entries
    for (const e of entriesToDeselect) {
        e.prop('selected', false);
    }

    if (entryToSelect) {
        entryToSelect.prop('selected', true);
    }
}
