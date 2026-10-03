// Proximity magnification: how far (px) the effect reaches from the cursor,
// peak scale boost (1 + MAX_BOOST) and peak upward lift (px).
const MAGNIFY_RADIUS = 120;
const MAGNIFY_MAX_BOOST = 0.4;
const MAGNIFY_MAX_LIFT = 6;

class Dock {
    // Chromium only (IntersectionObserver v2): tells whether an element is
    // really displayed, i.e. not covered by, nor faded or distorted through,
    // anything else. null where the browser can't tell.
    #visibilityObserver = null;
    #visibleElements = new WeakSet();

    constructor(initialPosition = 'bottom') {
        this.#initialize(initialPosition);
    }

    #initialize(initialPosition) {
        this.state = {
            isOver: false,
            isOpen: true,
            // 'bottom' or 'top': which window edge the dock is anchored to
            position: initialPosition === 'top' ? 'top' : 'bottom',
            isDraggingDock: false,
            // True when the dock is displayed in the browser's top layer
            // (Popover API available), see #createDock
            topLayer: false,
            // Set when the dock was dropped on the trash zone: gone from this
            // page until the next reload
            removed: false,
            // True while a pointer-drag reorders dock icons or tab rows;
            // suspends magnification, auto-collapse and dropdown opening.
            isReordering: false,
            // tabData that arrived mid-reorder, replayed by endReorder()
            pendingUpdate: null,
            // At most one dropdown has its rows mounted per page
            mountedDockItem: null,
            magnifyFrame: null,
            mouseX: 0
        };

        this.dom = {
            // The host <div>, the only node in the page's DOM
            host: null,
            shadow: null,
            // .dock, the positioned element inside the shadow root
            dock: null,
            grip: null,
            trash: null,
            dockItemContainer: null,
        };

        // domain -> DockItem. Order is never stored here: it derives from tabData
        // on update(), and from the DOM when persisting a drag.
        this.dockItems = new Map();

        if (typeof IntersectionObserverEntry !== 'undefined' && 'isVisible' in IntersectionObserverEntry.prototype) {
            this.#visibilityObserver = new IntersectionObserver(entries => {
                for (const entry of entries) {
                    if (entry.isVisible) {
                        this.#visibleElements.add(entry.target);
                    } else {
                        this.#visibleElements.delete(entry.target);
                    }
                }
            }, { trackVisibility: true, delay: 100 });
        }

        this.#createDock();
        this.#registerEvents();
    }

    // The page only sees an empty <div>: the dock, the trash zone and all
    // their styles live in its closed shadow root, so no id, class or global
    // stylesheet is exposed for the page to match, restyle or spoof.
    // The host must stay a built-in element: a custom element name (anything
    // with a hyphen) can be registered by the page beforehand, and its class
    // then reads the closed shadow root through ElementInternals.shadowRoot.
    #createDock() {
        this.dom.host = document.createElement('div');
        const shadow = this.dom.host.attachShadow({ mode: 'closed' });
        this.dom.shadow = shadow;

        // Keeps the shadow content hidden (no unstyled flash) until the real
        // sheet arrives, which then replaces it.
        const bootStyle = document.createElement('style');
        bootStyle.textContent = ':host { display: none !important; }';
        shadow.appendChild(bootStyle);

        // The background reads the packaged sheet: a fetch from here would need
        // it to be web-accessible, i.e. exposed to every site.
        api.runtime.sendMessage({ action: 'getStyles' })
            .then(cssText => {
                if (typeof cssText !== 'string') return;
                const styleElement = document.createElement('style');
                styleElement.textContent = cssText;
                bootStyle.replaceWith(styleElement);
            });

        this.dom.dock = document.createElement('div');
        this.dom.dock.className = 'dock';
        this.dom.dock.classList.toggle('dock-top', this.state.position === 'top');
        // Shown as a manual popover, i.e. in the browser's top layer: there,
        // the opacity, transform, filter or z-index of the host's ancestors
        // (all under the page's control, it can even move the host into a
        // container of its own) no longer apply. The page can thus neither
        // make the dock invisible nor slide it under the cursor to steal a
        // real click. Without the Popover API the dock stays a plain
        // fixed-position element.
        this.state.topLayer = typeof this.dom.dock.showPopover === 'function';
        if (this.state.topLayer) {
            this.dom.dock.popover = 'manual';
        }

        const dockContainer = document.createElement('div');
        dockContainer.className = 'dock-container';

        this.dom.grip = document.createElement('div');
        this.dom.grip.className = 'dock-grip';
        this.dom.grip.title = 'Drag to move the dock to the top or bottom of the window';
        dockContainer.appendChild(this.dom.grip);

        this.dom.dockItemContainer = document.createElement('div');
        this.dom.dockItemContainer.className = 'tab-group-container';
        dockContainer.appendChild(this.dom.dockItemContainer);

        this.dom.dock.appendChild(dockContainer);
        shadow.appendChild(this.dom.dock);
        document.body.appendChild(this.dom.host);
        this.#showInTopLayer(this.dom.dock);

        this.expandDock();
    }

    // No-op when already shown. A popover closes by itself when its tree
    // leaves the document, so a host moved by the page comes back hidden
    // (cf. the :not(:popover-open) rules) until this runs again.
    #showInTopLayer(el) {
        if (!this.state.topLayer || !this.dom.host.isConnected) return;
        try {
            if (!el.matches(':popover-open')) el.showPopover();
        } catch (e) { }
    }

    // The top layer is a stack and the page can push its own elements onto
    // it after ours: hiding and showing again moves el back to the top.
    #raise(el) {
        if (!this.state.topLayer || !this.dom.host.isConnected) return;
        try {
            if (el.matches(':popover-open')) el.hidePopover();
            el.showPopover();
        } catch (e) { }
    }

    #registerEvents() {
        this.dom.dock.addEventListener('mouseover', e => {
            // The pointer reaches the dock, so the dock must be what the user
            // sees there: back above anything the page stacked over it
            // (a click-through overlay hides it without blocking the mouse).
            // Not mid-drag: hiding would drop the drag's transitions.
            if (!this.state.isOver && e.isTrusted && !this.state.isDraggingDock && !this.state.isReordering) {
                this.#raise(this.dom.dock);
                // Commit the pre-expansion offset of the re-shown dock, so
                // the slide of expandDock() still plays.
                this.dom.dock.getBoundingClientRect();
            }
            this.state.isOver = true;
            if (!this.state.isDraggingDock) {
                this.expandDock();
            }
        });
        this.dom.dock.addEventListener('mouseleave', e => {
            this.state.isOver = false;
            this.#resetMagnify();
        });
        this.dom.dock.addEventListener('mousemove', e => {
            this.state.mouseX = e.clientX;
            if (this.state.magnifyFrame === null) {
                this.state.magnifyFrame = requestAnimationFrame(() => {
                    this.state.magnifyFrame = null;
                    this.#applyMagnify();
                });
            }
        });

        this.dom.dockItemContainer.addEventListener('click', this.#handleDockItemEvents.bind(this));
        this.dom.dockItemContainer.addEventListener('mousedown', this.#handleDockItemEvents.bind(this));

        // An element going fullscreen joins the top layer above the dock. When
        // it contains the host (the page itself going fullscreen), the dock
        // is part of what is displayed and comes back above it, as it did
        // before living in the top layer; a fullscreen video stays alone.
        document.addEventListener('fullscreenchange', () => {
            const fullscreenElement = document.fullscreenElement;
            if (fullscreenElement && fullscreenElement.contains(this.dom.host)
                && !this.state.removed && !this.state.isDraggingDock && !this.state.isReordering) {
                this.#raise(this.dom.dock);
            }
        });

        document.addEventListener('mousemove', (e) => {
            // Back in the top layer if the page moved the host meanwhile.
            if (!this.state.removed) {
                this.#showInTopLayer(this.dom.dock);
            }
            const nearEdge = this.state.position === 'top'
                ? e.clientY < window.innerHeight * 0.1
                : e.clientY > window.innerHeight * 0.9;
            if (this.state.isOpen && !this.state.isOver && !this.state.isDraggingDock && !this.state.isReordering && !nearEdge) {
                this.#collapseDock();
            }
        });

        this.#registerGripDrag();

        this.dragController = attachDragReorder(this.dom.dockItemContainer, {
            itemSelector: '.tab-group',
            // The dropdown is a DOM child of the icon: without this, pressing
            // a tab row would also start an icon drag here.
            ignoreSelector: '.dropdown-container',
            axis: 'x',
            reversed: false,
            onDragStart: () => {
                this.beginReorder();
                this.dom.dockItemContainer.classList.add('reordering');
                if (this.state.mountedDockItem) {
                    this.state.mountedDockItem.unmountDropdown();
                    this.state.mountedDockItem = null;
                }
                this.#resetMagnify();
            },
            onDragEnd: () => {
                this.dom.dockItemContainer.classList.remove('reordering');
                this.endReorder();
            },
            onCommit: (from, to, el) => {
                const children = this.dom.dockItemContainer.children;
                this.dom.dockItemContainer.insertBefore(el, to > from ? children[to].nextSibling : children[to]);
                this.persistOrder();
            }
        });
    }

    watchVisibility(el) {
        if (this.#visibilityObserver) this.#visibilityObserver.observe(el);
    }

    unwatchVisibility(el) {
        if (this.#visibilityObserver) this.#visibilityObserver.unobserve(el);
    }

    // False when the browser reports el (watched beforehand) as not plainly
    // visible: the page may have painted something of its own over it, to
    // dress a dock control up as one of its buttons. Always true where the
    // browser can't tell (no IntersectionObserver v2).
    isUnobstructed(el) {
        return !this.#visibilityObserver || this.#visibleElements.has(el);
    }

    beginReorder() {
        this.state.isReordering = true;
    }

    // Replays the tabData that update() deferred during the drag; after a
    // commit the persistOrder echo follows right behind and re-syncs order.
    endReorder() {
        this.state.isReordering = false;
        if (this.state.pendingUpdate !== null) {
            const pending = this.state.pendingUpdate;
            this.state.pendingUpdate = null;
            this.update(pending);
        }
    }

    // Dragging the grip moves the whole dock; it snaps to the top or bottom
    // edge on release, or is removed from the page when dropped on the trash
    // zone. Raw mouse events, independent from the pointer-based reordering
    // of dock items and tab rows (the grip is outside their containers).
    #registerGripDrag() {
        this.dom.grip.addEventListener('mousedown', (e) => {
            if (!e.isTrusted || e.button !== 0 || this.state.removed) return;
            e.preventDefault();

            this.state.isDraggingDock = true;
            if (this.state.mountedDockItem) {
                this.state.mountedDockItem.unmountDropdown();
                this.state.mountedDockItem = null;
            }
            this.#resetMagnify();

            // Freeze the dock exactly where it stands, then drag by cursor
            // delta: no jump on grab, and the centering transform can be
            // dropped for free 2D movement.
            const rect = this.dom.dock.getBoundingClientRect();
            const startX = e.clientX;
            const startY = e.clientY;
            this.dom.dock.classList.add('dock-dragging');
            this.dom.dock.style.left = `${rect.x}px`;
            this.dom.dock.style.top = `${rect.y}px`;
            this.dom.dock.style.bottom = 'auto';
            this.dom.dock.style.transform = 'none';

            const trash = this.#ensureTrashZone();
            // Force a layout so the .visible transition actually plays when
            // the element was just inserted.
            trash.getBoundingClientRect();
            trash.classList.add('visible');

            let lastY = startY;
            let overTrash = false;

            const onMove = (moveEvent) => {
                lastY = moveEvent.clientY;
                // No clamping: the dock tracks the cursor 1:1 even past the
                // viewport edges, so the grip never slips out from under the
                // mouse. Release always brings it back (snap or removal).
                this.dom.dock.style.left = `${rect.x + moveEvent.clientX - startX}px`;
                this.dom.dock.style.top = `${rect.y + moveEvent.clientY - startY}px`;

                // Drop zone: the whole bottom-right third of the window
                overTrash = moveEvent.clientX > window.innerWidth * 2 / 3
                    && moveEvent.clientY > window.innerHeight * 2 / 3;
                trash.classList.toggle('active', overTrash);
            };

            const onDrop = () => {
                window.removeEventListener('mousemove', onMove, true);
                window.removeEventListener('mouseup', onDrop, true);
                window.removeEventListener('blur', onDrop, true);

                this.state.isDraggingDock = false;
                this.dom.dock.classList.remove('dock-dragging');
                trash.classList.remove('visible', 'active');

                if (overTrash) {
                    this.#removeDockForPage();
                    return;
                }

                // Restore horizontal centering, then snap to the nearest edge.
                this.dom.dock.style.left = '';
                this.dom.dock.style.transform = '';
                const position = lastY < window.innerHeight / 2 ? 'top' : 'bottom';
                this.setPosition(position, { persist: true });
                // Always rewrite the anchored offset: it clears the inline
                // top/bottom left by the drag even when the edge didn't change.
                this.expandDock();
            };

            window.addEventListener('mousemove', onMove, true);
            window.addEventListener('mouseup', onDrop, true);
            window.addEventListener('blur', onDrop, true);
        });
    }

    #ensureTrashZone() {
        if (!this.dom.trash) {
            this.dom.trash = document.createElement('div');
            this.dom.trash.className = 'dock-trash';
            this.dom.trash.innerHTML =
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">'
                + '<path d="M9 3h6l1 2h4v2H4V5h4l1-2zm-3 6h12l-.9 12.1a2 2 0 0 1-2 1.9H8.9a2 2 0 0 1-2-1.9L6 9zm4 2.5v8h1.5v-8H10zm2.5 0v8H14v-8h-1.5z"/>'
                + '</svg>';
            if (this.state.topLayer) {
                this.dom.trash.popover = 'manual';
            }
            // Sibling of the dock, not a child: the dock's transform would
            // otherwise become the containing block of its position: fixed.
            this.dom.shadow.appendChild(this.dom.trash);
        }
        // In the top layer like the dock, and above it: z-index means nothing
        // there, only the order of arrival. Invisible at rest, so re-showing
        // it at every drag start is never seen.
        this.#raise(this.dom.trash);
        return this.dom.trash;
    }

    // Dropping the dock on the trash zone hides it for this page only: no
    // storage write, so the next reload brings it back.
    #removeDockForPage() {
        this.state.removed = true;
        if (this.state.mountedDockItem) {
            this.state.mountedDockItem.unmountDropdown();
            this.state.mountedDockItem = null;
        }
        this.#resetMagnify();

        // The independent opacity/scale properties don't fight the inline
        // transform left by the drag.
        this.dom.dock.style.transition = 'opacity 0.2s ease, scale 0.2s ease';
        this.dom.dock.style.opacity = '0';
        this.dom.dock.style.scale = '0.8';
        // The trash lives in the same shadow root: removing the host takes it too
        setTimeout(() => this.dom.host.remove(), 200);
    }

    #handleDockItemEvents(e) {
        // Real user input only: an event dispatched by a script (the page's
        // included) has isTrusted false and must never open a tab.
        if (!e.isTrusted) return;
        const target = e.target.closest('.tab-group');

        if (target) {
            const domain = target.dataset.domain;
            const dockItem = this.dockItems.get(domain);

            if (dockItem) {
                switch (e.type) {
                    case 'click':
                        if (e.target.closest('.favicon')) {
                            e.preventDefault();
                            api.runtime.sendMessage({ action: 'openTab', domain: dockItem.domain });
                        }
                        break;
                    case 'mousedown':
                        if (e.target.closest('.favicon') && e.button === 1) {
                            e.preventDefault();
                            api.runtime.sendMessage({ action: 'openAndNavigateToTab', domain: dockItem.domain });
                        }
                        break;
                }
            }
        }
    }

    // Continuous macOS-style magnification: each favicon's scale/lift is a
    // linear falloff of the cursor's horizontal distance to its button center.
    // Uses the independent scale/translate properties so the transform-based
    // jump animation is never overridden.
    #applyMagnify() {
        if (this.state.isReordering || this.state.isDraggingDock) return;
        for (const button of this.dom.dockItemContainer.children) {
            const r = button.getBoundingClientRect();
            const t = Math.max(0, 1 - Math.abs(this.state.mouseX - (r.left + r.width / 2)) / MAGNIFY_RADIUS);
            const favicon = button.querySelector('.favicon');
            favicon.style.scale = String(1 + t * MAGNIFY_MAX_BOOST);
            // Icons grow toward the screen center: lift up at the bottom edge,
            // push down at the top edge.
            const lift = this.state.position === 'top' ? t : -t;
            favicon.style.translate = `0 ${lift * MAGNIFY_MAX_LIFT}px`;
        }
    }

    #resetMagnify() {
        if (this.state.magnifyFrame !== null) {
            cancelAnimationFrame(this.state.magnifyFrame);
            this.state.magnifyFrame = null;
        }
        for (const button of this.dom.dockItemContainer.children) {
            const favicon = button.querySelector('.favicon');
            favicon.style.scale = '';
            favicon.style.translate = '';
        }
    }

    // Called by a DockItem on hover: only one dropdown keeps its rows mounted,
    // so the page's DOM is bounded by the largest domain, not the total tab count.
    onDropdownOpen(dockItem) {
        if (this.state.mountedDockItem && this.state.mountedDockItem !== dockItem) {
            this.state.mountedDockItem.unmountDropdown();
        }
        this.state.mountedDockItem = dockItem;
        dockItem.mountDropdown();
    }

    // Writes the inline offset on the anchored edge and clears the other one:
    // a leftover inline top/bottom from a grip drag would pin both edges.
    #applyOffset(open) {
        const offset = open ? '10px' : '-48px';
        if (this.state.position === 'top') {
            this.dom.dock.style.top = offset;
            this.dom.dock.style.bottom = '';
        } else {
            this.dom.dock.style.bottom = offset;
            this.dom.dock.style.top = '';
        }
    }

    // Switches the anchored edge. The background's dockPositionChanged echo
    // re-enters here with the same value, so an early return keeps it idempotent.
    setPosition(position, { persist = false } = {}) {
        if (position !== 'top' && position !== 'bottom') return;

        if (position !== this.state.position) {
            this.state.position = position;
            this.dom.dock.classList.toggle('dock-top', position === 'top');
            if (this.state.mountedDockItem) {
                this.state.mountedDockItem.unmountDropdown();
                this.state.mountedDockItem = null;
            }
            this.#applyOffset(this.state.isOpen);
        }

        if (persist) {
            api.runtime.sendMessage({ action: 'setDockPosition', position: position }).catch(() => { });
        }
    }

    #collapseDock() {
        if (this.dom.dock && !this.state.removed) {
            this.#applyOffset(false);
            this.state.isOpen = false;
            this.#resetMagnify();
            if (this.state.mountedDockItem) {
                this.state.mountedDockItem.unmountDropdown();
                this.state.mountedDockItem = null;
            }
        }
    }

    expandDock() {
        if (this.dom.dock && !this.state.removed) {
            this.#applyOffset(true);
            this.state.isOpen = true;
        }
    }

    #createDockItem(domainData) {
        return new DockItem(this, domainData);
    }

    // The background is the only storage writer: it reorders its canonical tabData
    // and saves once; the storage.onChanged echo makes update() a no-op here.
    persistOrder() {
        const newOrder = Array.from(this.dom.dockItemContainer.children)
            .map(button => this.dockItems.get(button.dataset.domain))
            .filter(Boolean)
            .map(dockItem => ({ domain: dockItem.domain, tabIds: dockItem.getTabIds() }));

        api.runtime.sendMessage({ action: 'updateTabOrder', newOrder: newOrder });
    }

    update(tabData) {
        if (!Array.isArray(tabData)) return;

        // Rebuilding the containers mid-drag would invalidate the drag's
        // cached geometry; defer and let endReorder() replay the last one.
        if (this.state.isReordering) {
            this.state.pendingUpdate = tabData;
            return;
        }
        tabData = tabData.filter(d => d && Array.isArray(d.tabs) && d.tabs.length > 0);

        // Remove domains that are gone
        const domains = new Set(tabData.map(d => d.domain));
        for (const [domain, dockItem] of this.dockItems) {
            if (!domains.has(domain)) {
                if (this.state.mountedDockItem === dockItem) {
                    this.state.mountedDockItem = null;
                }
                dockItem.remove();
                this.dockItems.delete(domain);
            }
        }

        // Create missing domains, refresh existing ones
        for (const domainData of tabData) {
            let dockItem = this.dockItems.get(domainData.domain);
            if (!dockItem) {
                dockItem = this.#createDockItem(domainData);
                this.dockItems.set(domainData.domain, dockItem);
                this.dom.dockItemContainer.appendChild(dockItem.dom.button);
                dockItem.startFaviconAnimation();
            } else {
                dockItem.update(domainData);
            }
        }

        this.#syncDomOrder(tabData);
    }

    // DOM order = tabData array order. No-op when already in order, so the
    // post-drag storage echo never disturbs hover state or CSS transitions.
    #syncDomOrder(tabData) {
        const desired = tabData.map(d => this.dockItems.get(d.domain).dom.button);
        const current = Array.from(this.dom.dockItemContainer.children);
        if (desired.length === current.length && desired.every((node, i) => node === current[i])) return;
        desired.forEach(button => this.dom.dockItemContainer.appendChild(button));
    }
}
