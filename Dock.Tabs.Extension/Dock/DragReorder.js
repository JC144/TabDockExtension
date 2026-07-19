// Pointer-based drag-to-reorder for one container of same-size items: the
// grabbed element follows the cursor 1:1 via an inline transform while its
// neighbors slide (their CSS transition) to open a gap at the insertion
// point. The DOM is never mutated during the move; onCommit owns the single
// reorder at drop, so persistOrder() can keep deriving order from the DOM.

// Below this distance (px) a press is a plain click: no capture, no drag.
const DRAG_THRESHOLD = 5;
// Settle guard when transitionend never fires (zero-distance drop).
const SETTLE_FALLBACK_MS = 250;
// Auto-scroll when the pointer nears a scrollable container's edge.
const SCROLL_EDGE_ZONE = 28;
const SCROLL_MAX_SPEED = 10;

function attachDragReorder(container, {
    itemSelector,
    ignoreSelector = null,
    // Gap/shift axis; the grabbed element itself follows on both axes.
    axis = 'x',
    // true when the container renders DOM order reversed (column-reverse):
    // DOM-forward is then screen-backward, which flips the midpoint test
    // and the shift direction.
    reversed = false,
    onDragStart = () => { },
    onDragEnd = () => { },
    onCommit = () => { }
}) {
    const start = axis === 'x' ? 'left' : 'top';
    const size = axis === 'x' ? 'width' : 'height';
    // Screen direction of DOM-forward along the axis.
    const dir = reversed ? -1 : 1;
    const axisTranslate = (px) => axis === 'x' ? `translateX(${px}px)` : `translateY(${px}px)`;

    let drag = null;

    function onPointerDown(e) {
        if (drag !== null || e.button !== 0 || !e.isPrimary) return;
        const el = e.target.closest(itemSelector);
        if (!el || el.parentElement !== container) return;
        if (ignoreSelector && e.target.closest(ignoreSelector)) return;

        // No preventDefault here: it would suppress the compatibility
        // mousedown/click events that plain clicks rely on.
        drag = {
            pointerId: e.pointerId,
            el,
            startX: e.clientX,
            startY: e.clientY,
            active: false,
            settling: false,
            frame: null,
            scrollFrame: null,
            moveEvent: null
        };
        window.addEventListener('pointermove', onPointerMove, true);
        window.addEventListener('pointerup', onPointerUp, true);
        window.addEventListener('pointercancel', onPointerCancel, true);
    }

    function onPointerMove(e) {
        if (drag === null || e.pointerId !== drag.pointerId || drag.settling) return;
        if (!drag.active) {
            if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < DRAG_THRESHOLD) return;
            if (!startDrag()) return;
        }
        e.preventDefault();
        drag.moveEvent = e;
        scheduleApply();
    }

    function startDrag() {
        const items = Array.from(container.children).filter(c => c.matches(itemSelector));
        const fromIndex = items.indexOf(drag.el);
        if (fromIndex === -1) { teardown(); return false; }

        try { drag.el.setPointerCapture(drag.pointerId); } catch { }

        drag.items = items;
        // Rects are cached once: transforms are the only thing that moves
        // during the drag, and they don't affect layout.
        drag.rects = items.map(item => item.getBoundingClientRect());
        drag.fromIndex = fromIndex;
        drag.toIndex = fromIndex;
        // Slot stride includes any inter-item margin; falls back to the
        // element's own size when it's the only item.
        drag.slotSize = items.length >= 2
            ? Math.abs(drag.rects[1][start] - drag.rects[0][start])
            : drag.rects[fromIndex][size];
        drag.scrollLeft0 = container.scrollLeft;
        drag.scrollTop0 = container.scrollTop;
        drag.active = true;

        // Auto-scroll needs the container's visible box; it doesn't move
        // during the drag (only transforms do), so one read is enough.
        drag.containerRect = container.getBoundingClientRect();
        const canScroll = axis === 'y'
            ? container.scrollHeight > container.clientHeight
            : container.scrollWidth > container.clientWidth;
        if (canScroll) {
            drag.scrollFrame = requestAnimationFrame(scrollTick);
        }

        drag.el.classList.add('dragging');
        window.addEventListener('keydown', onKeyDown, true);
        container.addEventListener('scroll', onScroll, { passive: true });
        onDragStart(drag.el);
        return true;
    }

    // Keeps the list scrolling while the pointer sits near (or past) an edge
    // of a partially-scrolled container, even with the pointer motionless.
    // The scrollTop/scrollLeft assignment fires the container's scroll event,
    // and the existing scroll compensation resyncs the follow transform and
    // the midpoint tests; the browser clamps out-of-range values (which also
    // covers column-reverse, whose scrollTop range is [-max, 0]).
    function scrollTick() {
        if (drag === null || !drag.active || drag.settling) return;
        drag.scrollFrame = requestAnimationFrame(scrollTick);
        if (drag.moveEvent === null) return;

        const p = axis === 'x' ? drag.moveEvent.clientX : drag.moveEvent.clientY;
        const dStart = p - (axis === 'x' ? drag.containerRect.left : drag.containerRect.top);
        const dEnd = (axis === 'x' ? drag.containerRect.right : drag.containerRect.bottom) - p;
        let delta = 0;
        if (dStart < SCROLL_EDGE_ZONE) {
            delta = -SCROLL_MAX_SPEED * (1 - Math.max(0, dStart) / SCROLL_EDGE_ZONE);
        } else if (dEnd < SCROLL_EDGE_ZONE) {
            delta = SCROLL_MAX_SPEED * (1 - Math.max(0, dEnd) / SCROLL_EDGE_ZONE);
        }
        if (delta === 0) return;
        if (axis === 'x') container.scrollLeft += delta;
        else container.scrollTop += delta;
    }

    function scheduleApply() {
        if (drag.frame !== null) return;
        drag.frame = requestAnimationFrame(() => {
            if (drag === null) return;
            drag.frame = null;
            if (drag.active && !drag.settling && drag.moveEvent !== null) applyMove();
        });
    }

    function applyMove() {
        const e = drag.moveEvent;
        // Scrolling moves the cached layout positions; compensating here keeps
        // both the follow transform and the midpoint test in sync without
        // re-reading (transformed) rects.
        const scrollDX = container.scrollLeft - drag.scrollLeft0;
        const scrollDY = container.scrollTop - drag.scrollTop0;
        drag.el.style.transform =
            `translate(${e.clientX - drag.startX + scrollDX}px, ${e.clientY - drag.startY + scrollDY}px)`;

        const p = axis === 'x' ? e.clientX : e.clientY;
        const scrollP = axis === 'x' ? scrollDX : scrollDY;
        let toIndex = 0;
        for (let i = 0; i < drag.items.length; i++) {
            if (i === drag.fromIndex) continue;
            const mid = drag.rects[i][start] - scrollP + drag.rects[i][size] / 2;
            const before = reversed ? p > mid : p < mid;
            if (!before) toIndex++;
        }
        drag.toIndex = toIndex;

        for (let i = 0; i < drag.items.length; i++) {
            if (i === drag.fromIndex) continue;
            let shift = 0;
            if (drag.fromIndex < i && i <= toIndex) shift = -dir * drag.slotSize;
            else if (toIndex <= i && i < drag.fromIndex) shift = dir * drag.slotSize;
            const value = shift === 0 ? '' : axisTranslate(shift);
            // Only touch changed values so running transitions aren't restarted.
            if (drag.items[i].style.transform !== value) {
                drag.items[i].style.transform = value;
            }
        }
    }

    function onScroll() {
        if (drag === null || !drag.active || drag.settling || drag.moveEvent === null) return;
        scheduleApply();
    }

    function onPointerUp(e) {
        if (drag === null || e.pointerId !== drag.pointerId || drag.settling) return;
        if (!drag.active) { teardown(); return; }
        swallowNextClick();
        settle(true);
    }

    function onPointerCancel(e) {
        if (drag === null || e.pointerId !== drag.pointerId) return;
        cancel();
    }

    function onKeyDown(e) {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        cancel();
    }

    // The drop position only holds if the container's items are still the
    // cached ones: an update() that added/removed/reordered nodes mid-drag
    // invalidates the indices, so back out instead of committing.
    function itemsUnchanged() {
        const current = Array.from(container.children).filter(c => c.matches(itemSelector));
        return current.length === drag.items.length && current.every((node, i) => node === drag.items[i]);
    }

    function settle(commit) {
        drag.settling = true;
        if (drag.frame !== null) { cancelAnimationFrame(drag.frame); drag.frame = null; }
        if (drag.scrollFrame !== null) { cancelAnimationFrame(drag.scrollFrame); drag.scrollFrame = null; }
        const el = drag.el;
        try { el.releasePointerCapture(drag.pointerId); } catch { }
        el.classList.remove('dragging');
        // .settling re-enables the transform transition the .dragging class
        // suppressed, so the element glides into place.
        el.classList.add('settling');

        if (commit && drag.toIndex !== drag.fromIndex && itemsUnchanged()) {
            el.style.transform = axisTranslate(dir * (drag.toIndex - drag.fromIndex) * drag.slotSize);
        } else {
            commit = false;
            el.style.transform = '';
            for (const item of drag.items) {
                if (item !== el) item.style.transform = '';
            }
        }

        let finished = false;
        const run = () => {
            if (finished || drag === null) return;
            finished = true;
            el.removeEventListener('transitionend', onEnd);
            finish(commit);
        };
        const onEnd = (ev) => {
            if (ev.target === el && ev.propertyName === 'transform') run();
        };
        el.addEventListener('transitionend', onEnd);
        setTimeout(run, SETTLE_FALLBACK_MS);
    }

    function finish(commit) {
        const { el, items, fromIndex, toIndex } = drag;
        // Clear every transform and reorder the DOM before the next paint,
        // with transitions suspended: the new flow position equals the
        // transformed one, so nothing moves and nothing animates back.
        for (const item of items) {
            item.style.transition = 'none';
            item.style.transform = '';
        }
        el.classList.remove('settling');
        if (commit) onCommit(fromIndex, toIndex, el);
        void container.offsetWidth;
        for (const item of items) {
            item.style.transition = '';
        }
        onDragEnd(el);
        teardown();
    }

    // A real drag still produces a trailing compatibility click, hit-tested at
    // the release point (possibly a neighbor): swallow exactly that one.
    function swallowNextClick() {
        const swallow = (e) => {
            e.preventDefault();
            e.stopPropagation();
        };
        container.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => container.removeEventListener('click', swallow, { capture: true }), 100);
    }

    // immediate: external teardown (an update() rebuilding the container)
    // can't wait for the settle animation.
    function cancel({ immediate = false } = {}) {
        if (drag === null) return;
        if (!drag.active) { teardown(); return; }
        if (immediate) {
            const el = drag.el;
            try { el.releasePointerCapture(drag.pointerId); } catch { }
            el.classList.remove('dragging', 'settling');
            el.style.transform = '';
            for (const item of drag.items) item.style.transform = '';
            onDragEnd(el);
            teardown();
            return;
        }
        if (drag.settling) return;
        settle(false);
    }

    function teardown() {
        window.removeEventListener('pointermove', onPointerMove, true);
        window.removeEventListener('pointerup', onPointerUp, true);
        window.removeEventListener('pointercancel', onPointerCancel, true);
        window.removeEventListener('keydown', onKeyDown, true);
        container.removeEventListener('scroll', onScroll);
        if (drag !== null) {
            if (drag.frame !== null) cancelAnimationFrame(drag.frame);
            if (drag.scrollFrame !== null) cancelAnimationFrame(drag.scrollFrame);
        }
        drag = null;
    }

    container.addEventListener('pointerdown', onPointerDown);

    return {
        cancel,
        detach() {
            cancel({ immediate: true });
            container.removeEventListener('pointerdown', onPointerDown);
        }
    };
}

export { attachDragReorder };
