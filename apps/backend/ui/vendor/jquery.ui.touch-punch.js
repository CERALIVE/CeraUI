/*!
 * jQuery UI Touch Punch - Modernized for jQuery 3+
 * Originally by Dave Furfero (2011–2014)
 * Updated and maintained by Andrescera
 *
 * Dual licensed under the MIT or GPL Version 2 licenses.
 *
 * Depends:
 *   - jquery.ui.widget.js
 *   - jquery.ui.mouse.js
 */

(function ($) {
    if (!('ontouchstart' in window || navigator.maxTouchPoints > 0)) {
        return;
    }

    const mouseProto = $.ui.mouse.prototype;
    const _mouseInit = mouseProto._mouseInit;
    const _mouseDestroy = mouseProto._mouseDestroy;
    let touchHandled;

    function simulateMouseEvent(event, simulatedType) {
        if (event.originalEvent.touches.length > 1) return;

        event.preventDefault();

        const touch = event.originalEvent.changedTouches[0];
        const simulatedEvent = new MouseEvent(simulatedType, {
            bubbles: true,
            cancelable: true,
            view: window,
            detail: 1,
            screenX: touch.screenX,
            screenY: touch.screenY,
            clientX: touch.clientX,
            clientY: touch.clientY,
            button: 0
        });

        event.target.dispatchEvent(simulatedEvent);
    }

    mouseProto._touchStart = function (event) {
        if (touchHandled || !this._mouseCapture(event.originalEvent.changedTouches[0])) {
            return;
        }

        touchHandled = true;
        this._touchMoved = false;

        simulateMouseEvent(event, 'mouseover');
        simulateMouseEvent(event, 'mousemove');
        simulateMouseEvent(event, 'mousedown');
    };

    mouseProto._touchMove = function (event) {
        if (!touchHandled) return;
        this._touchMoved = true;
        simulateMouseEvent(event, 'mousemove');
    };

    mouseProto._touchEnd = function (event) {
        if (!touchHandled) return;

        simulateMouseEvent(event, 'mouseup');
        simulateMouseEvent(event, 'mouseout');

        if (!this._touchMoved) {
            simulateMouseEvent(event, 'click');
        }

        touchHandled = false;
    };

    mouseProto._mouseInit = function () {
        this.element.on({
            touchstart: this._touchStart.bind(this),
            touchmove: this._touchMove.bind(this),
            touchend: this._touchEnd.bind(this)
        });

        _mouseInit.call(this);
    };

    mouseProto._mouseDestroy = function () {
        this.element.off({
            touchstart: this._touchStart.bind(this),
            touchmove: this._touchMove.bind(this),
            touchend: this._touchEnd.bind(this)
        });

        _mouseDestroy.call(this);
    };

})(jQuery);

