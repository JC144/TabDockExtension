import DockItem from './DockItem.js';
import { attachDragReorder } from './DragReorder.js';
import { api } from '../browser-api.js';

// Proximity magnification: how far (px) the effect reaches from the cursor,
// peak scale boost (1 + MAX_BOOST) and peak upward lift (px).
const MAGNIFY_RADIUS = 120;
const MAGNIFY_MAX_BOOST = 0.4;
const MAGNIFY_MAX_LIFT = 6;

class Dock {
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
            dock: null,
            grip: null,
            trash: null,
            dockItemContainer: null,
        };

        // domain -> DockItem. Order is never stored here: it derives from tabData
        // on update(), and from the DOM when persisting a drag.
        this.dockItems = new Map();

        this.#createDock();
        this.#registerEvents();
    }

    #createDock() {
        this.dom.dock = document.createElement('div');
        this.dom.dock.id = 'dock';
        this.dom.dock.classList.toggle('dock-top', this.state.position === 'top');

        const shadow = this.dom.dock.attachShadow({ mode: 'closed' });

        fetch(api.runtime.getURL('dock-styles.css'))
            .then(response => response.text())
            .then(cssText => {
                // Create a style element
                const styleElement = document.createElement('style');
                styleElement.textContent = cssText;

                shadow.appendChild(styleElement);
            });

        let template = document.createElement('template');
        template.id = 'dock-template';
        template.style.display = 'block';

        const fragment = document.createDocumentFragment();

        const dockContainer = document.createElement('div');
        dockContainer.className = 'dock-container';

        this.dom.grip = document.createElement('div');
        this.dom.grip.className = 'dock-grip';
        this.dom.grip.title = 'Drag to move the dock to the top or bottom of the window';
        dockContainer.appendChild(this.dom.grip);

        this.dom.dockItemContainer = document.createElement('div');
        this.dom.dockItemContainer.id = 'tab-group-container';
        this.dom.dockItemContainer.className = 'tab-group-container';
        dockContainer.appendChild(this.dom.dockItemContainer);

        fragment.appendChild(dockContainer);
        template.appendChild(fragment);

        shadow.appendChild(template);
        document.body.appendChild(this.dom.dock);

        this.expandDock();
    }

    #registerEvents() {
        this.dom.dock.addEventListener('mouseover', e => {
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

        document.addEventListener('mousemove', (e) => {
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
            if (e.button !== 0 || this.state.removed) return;
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
            this.dom.trash.id = 'dock-trash';
            this.dom.trash.innerHTML =
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">'
                + '<path d="M9 3h6l1 2h4v2H4V5h4l1-2zm-3 6h12l-.9 12.1a2 2 0 0 1-2 1.9H8.9a2 2 0 0 1-2-1.9L6 9zm4 2.5v8h1.5v-8H10zm2.5 0v8H14v-8h-1.5z"/>'
                + '</svg>';
            document.body.appendChild(this.dom.trash);
        }
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
        setTimeout(() => {
            this.dom.dock.remove();
            if (this.dom.trash) {
                this.dom.trash.remove();
            }
        }, 200);
    }

    #handleDockItemEvents(e) {
        const target = e.target.closest('.tab-group');

        if (target) {
            const domain = target.dataset.domain;
            const dockItem = this.dockItems.get(domain);

            if (dockItem) {
                switch (e.type) {
                    case 'click':
                        if (e.target.closest('.favicon')) {
                            e.preventDefault();
                            api.runtime.sendMessage({ action: 'openTab', tabUri: dockItem.getFirstTabUrl() });
                        }
                        break;
                    case 'mousedown':
                        if (e.target.closest('.favicon') && e.button === 1) {
                            e.preventDefault();
                            api.runtime.sendMessage({ action: 'openAndNavigateToTab', tabUri: dockItem.getFirstTabUrl() });
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

    // Switches the anchored edge. The storage.onChanged echo re-enters here
    // with the same value, so an early return keeps it idempotent.
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
            api.storage.local.set({ dockPosition: position });
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

export default Dock;
