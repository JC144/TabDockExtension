// Decodes a data: PNG without any load the host page's CSP could block (no
// <img>, no fetch). Anything else (null, a stale URL from an older schema, a
// corrupt payload) resolves to null.
async function decodeDataUrl(src) {
    if (typeof src !== 'string' || !src.startsWith('data:image/png;base64,')) return null;
    try {
        const bytes = Uint8Array.from(atob(src.slice(src.indexOf(',') + 1)), c => c.charCodeAt(0));
        return await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    } catch (e) {
        return null;
    }
}

// Cached decode of the default icon, requested once per page. It comes from
// the background as a data: URL: the packaged file isn't web-accessible.
let defaultBitmapPromise = null;
function getDefaultBitmap() {
    if (!defaultBitmapPromise) {
        defaultBitmapPromise = api.runtime.sendMessage({ action: 'getDefaultFavicon' })
            .then(decodeDataUrl, () => null);
    }
    return defaultBitmapPromise;
}

class DockItem {
    // undefined (not null) so the first setFaviconSrc(null) still renders.
    #renderedFavicon = undefined;
    #renderToken = 0;

    constructor(parent, domainData) {
        this.#initialize(parent, domainData);
    }

    #initialize(parent, domainData) {
        this.dom = {
            button: null,
            favicon: null,
            tabsListContainer: null,
            tabsList: null,
            shield: null
        };

        this.parent = parent;
        this.domain = domainData.domain;
        this.tabs = domainData.tabs;
        // Dropdown rows are mounted lazily on hover; null means unmounted.
        this.tabItems = null;

        this.#createDockItem(domainData.favicon);
        this.#registerEvents();
    }

    #createDockItem(favicon) {
        this.dom.button = document.createElement('div');
        this.dom.button.className = 'tab-group';
        this.dom.button.dataset.domain = this.domain;

        const fragment = document.createDocumentFragment();

        // The host page's CSP applies to <img> loads injected by content
        // scripts; drawing on a canvas is not a document load, so it can't be
        // blocked. The pixels come as a data: PNG from the background.
        this.dom.favicon = document.createElement('canvas');
        this.dom.favicon.width = 32;
        this.dom.favicon.height = 32;
        this.dom.favicon.title = this.domain;
        this.dom.favicon.className = 'favicon';
        this.dom.favicon.dataset.domain = this.domain;

        this.setFaviconSrc(favicon);

        fragment.appendChild(this.dom.favicon);

        // The dropdown shell must exist eagerly (the CSS :hover rules target it),
        // but its rows are only built by mountDropdown().
        this.dom.tabsListContainer = document.createElement('div');
        this.dom.tabsListContainer.className = 'dropdown-container';

        this.dom.tabsList = document.createElement('div');
        this.dom.tabsList.className = 'dropdown-content';
        this.dom.tabsListContainer.appendChild(this.dom.tabsList);

        // Covers the dropdown without catching any event; only there for the
        // parent to tell whether the rows are really what the user sees
        // (cf. #closeTab).
        this.dom.shield = document.createElement('div');
        this.dom.shield.className = 'dropdown-shield';
        this.dom.tabsListContainer.appendChild(this.dom.shield);
        this.parent.watchVisibility(this.dom.shield);

        fragment.appendChild(this.dom.tabsListContainer);

        this.dom.button.appendChild(fragment);
    }

    #registerEvents() {
        this.dom.tabsListContainer.addEventListener('click', this.#handleTabItemEvents.bind(this));
        this.dom.tabsListContainer.addEventListener('mousedown', this.#handleTabItemEvents.bind(this));
        this.dom.button.addEventListener('mouseenter', (e) => {
            if (e.isTrusted && !this.parent.state.isReordering) {
                this.parent.onDropdownOpen(this);
            }
        });

        this.dragController = attachDragReorder(this.dom.tabsList, {
            itemSelector: '.tab-item',
            ignoreSelector: '.close-button-container',
            axis: 'y',
            // column-reverse rendering: DOM-forward is visually upward
            reversed: true,
            onDragStart: () => {
                this.parent.beginReorder();
                // :hover can drop mid-drag (pointer capture); keep the
                // dropdown pinned open until the row settles.
                this.dom.tabsListContainer.classList.add('row-reordering');
            },
            onDragEnd: () => {
                this.dom.tabsListContainer.classList.remove('row-reordering');
                this.parent.endReorder();
            },
            onCommit: (from, to) => {
                this.#reorderArray(this.tabItems, from, to);
                this.#reorderArray(this.tabs, from, to);
                this.#syncRowOrder();
                this.parent.persistOrder();
            }
        });
    }

    #handleTabItemEvents(e) {
        // Real user input only (cf. Dock.js): a scripted event must never
        // focus or close a tab.
        if (!e.isTrusted) return;
        const tabItem = e.target.closest('.tab-item');
        if (!tabItem) return;

        const tabId = parseInt(tabItem.dataset.tabId);

        switch (e.type) {
            case 'click':
                if (e.target.closest('.close-button-container')) {
                    e.stopPropagation();
                    this.#closeTab(tabId);
                } else {
                    api.runtime.sendMessage({ action: 'focusTab', tabId: tabId });
                }
                break;
            case 'mousedown':
                if (e.button === 1) {
                    e.preventDefault();
                    this.#closeTab(tabId);
                }
                break;
        }
    }

    // Closing is the one action that can lose the user's work, so a real click
    // isn't enough: it must land on a dropdown nothing covers. A page could
    // otherwise paint a button of its own over a close button (click-through,
    // above the dock) and have the user close another tab.
    #closeTab(tabId) {
        if (!this.parent.isUnobstructed(this.dom.shield)) return;
        api.runtime.sendMessage({ action: 'closeTab', tabId: tabId });
    }

    #reorderArray(arr, oldIndex, newIndex) {
        arr.splice(newIndex, 0, arr.splice(oldIndex, 1)[0]);
    }

    mountDropdown() {
        if (this.tabItems !== null) return;
        this.tabItems = [];
        this.tabs.forEach((tab) => this.#createTabItem(tab));
    }

    unmountDropdown() {
        if (this.tabItems === null) return;
        this.dom.tabsList.replaceChildren();
        this.tabItems = null;
    }

    update(domainData) {
        this.tabs = domainData.tabs;
        this.setFaviconSrc(domainData.favicon);

        if (this.tabItems === null) return;

        // The dropdown is mounted: diff its rows against the new tabs.
        const liveIds = new Set(this.tabs.map(t => t.id));
        for (const tabItem of this.tabItems.filter(t => !liveIds.has(t.tab.id))) {
            this.tabItems.splice(this.tabItems.indexOf(tabItem), 1);
            tabItem.remove();
        }

        for (const tab of this.tabs) {
            const tabItem = this.tabItems.find(t => t.tab.id === tab.id);
            if (tabItem) {
                tabItem.update(tab);
            } else {
                this.#createTabItem(tab);
            }
        }

        const orderOf = (tabItem) => this.tabs.findIndex(t => t.id === tabItem.tab.id);
        this.tabItems.sort((a, b) => orderOf(a) - orderOf(b));
        this.#syncRowOrder();
    }

    #createTabItem(tab) {
        const tabItem = new TabItem(tab, this);
        this.dom.tabsList.appendChild(tabItem.dom.tabItem);
        this.tabItems.push(tabItem);
    }

    // DOM order = tabs array order; the visual (bottom-up) direction comes from
    // the CSS column-reverse on .dropdown-content, never from insertion order.
    #syncRowOrder() {
        const desired = this.tabItems.map(t => t.dom.tabItem);
        const current = Array.from(this.dom.tabsList.children);
        if (desired.length === current.length && desired.every((node, i) => node === current[i])) return;
        desired.forEach(node => this.dom.tabsList.appendChild(node));
    }

    getTabIds() {
        return this.tabs.map(t => t.id);
    }

    remove() {
        this.parent.unwatchVisibility(this.dom.shield);
        this.dom.button.remove();
        this.tabItems = null;
    }

    startFaviconAnimation() {
        this.dom.favicon.classList.add('jump');
        setTimeout(() => this.dom.favicon.classList.remove('jump'), 500);
    }

    setFaviconSrc(src) {
        if (this.#renderedFavicon === src) return;
        this.#drawFavicon(src);
    }

    async #drawFavicon(src) {
        const token = ++this.#renderToken;
        const bitmap = await decodeDataUrl(src) || await getDefaultBitmap();
        if (token !== this.#renderToken) return;
        const ctx = this.dom.favicon.getContext('2d');
        ctx.clearRect(0, 0, 32, 32);
        if (bitmap) ctx.drawImage(bitmap, 0, 0, 32, 32);
    }
}
