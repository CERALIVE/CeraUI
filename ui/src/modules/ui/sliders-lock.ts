// Global slider lock setting
let sliderLockSetting: string | undefined = loadSliderLockSetting();

/* Slider locking */
function getSliderLockBtn(slider: JQuery<HTMLElement>): JQuery<HTMLElement> | null {
    const formGroup = slider.closest('.form-group');
    return formGroup.length ? formGroup.find('.button-slider-lock-unlock') : null;
}

function updateSliderLockState(
    slider: JQuery<HTMLElement>,
    isLocked: boolean,
    btn?: JQuery<HTMLElement> | null
): void {
    if (!btn) {
        btn = getSliderLockBtn(slider);
    }

    slider.slider('option', 'disabled', isLocked);
    btn?.text(isLocked ? "🔒" : "🔓");

    if (!isLocked && sliderLockSetting === 'autolock') {
        setSliderAutolockTimer(slider);
    }
}

export function setSliderAutolockTimer(slider: JQuery<HTMLElement>): void {
    const el = slider.get(0);
    if (!el) return;

    const existingTimer = Number(el.dataset.lockTimer);
    if (existingTimer) {
        clearTimeout(existingTimer);
    }

    if (sliderLockSetting !== 'autolock') {
        delete el.dataset.lockTimer;
        return;
    }

    const timer = window.setTimeout(() => {
        if (sliderLockSetting === 'autolock') {
            updateSliderLockState(slider, true);
        }
        delete el.dataset.lockTimer;
    }, 5000);

    el.dataset.lockTimer = timer.toString();
}

export function initSliderLock(slider: JQuery<HTMLElement>): void {
    const btn = getSliderLockBtn(slider);
    if (!btn || btn.length === 0) return;

    const btnWrapper = btn.parent();

    if (!sliderLockSetting) {
        btnWrapper.addClass('d-none');
        btn.off('click'); // Remove existing click handlers
        return;
    }

    const lockWasHidden = btnWrapper.hasClass('d-none');
    const isLocked = lockWasHidden ? true : slider.slider('option', 'disabled');

    updateSliderLockState(slider, isLocked, btn);

    if (lockWasHidden) {
        btn.on('click', function () {
            const parent = btn.closest('.form-group');
            const innerSlider = parent.find('.slider');
            const currentlyLocked = innerSlider.slider('option', 'disabled');
            updateSliderLockState(innerSlider, !currentlyLocked, btn);
        });
        btnWrapper.removeClass('d-none');
    }
}

/* Load slider lock setting */
function loadSliderLockSetting(): string | undefined {
    let s = localStorage.getItem('sliderLocks');
    switch (s) {
        case 'autolock':
        case 'on':
        case 'off':
            break;
        default:
            s = 'off';
    }

    $('#sliderLocks').val(s);

    return s !== 'off' ? s : undefined;
}

/* Listen for lock mode change */
export function initSliderLocks() {
    $('#sliderLocks').on('change', function () {
        let s: string | undefined = $(this).val() as string;
        localStorage.setItem('sliderLocks', s);

        if (s !== 'on' && s !== 'autolock') {
            s = undefined;
        }

        sliderLockSetting = s;

        $('.slider').each(function () {
            initSliderLock($(this));
        });
    });
}
