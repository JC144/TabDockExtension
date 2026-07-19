import TabItem from './TabItem.js';
import { attachDragReorder } from './DragReorder.js';
import { api, isMV3 } from '../browser-api.js';

// Cached decode of the default icon, fetched once per page. Extension URLs are
// exempt from the host page's CSP when fetched from the content script, unlike
// <img> loads (cf. the CSS fetch in Dock.js).
let defaultBitmapPromise = null;
function getDefaultBitmap() {
    if (!defaultBitmapPromise) {
        defaultBitmapPromise = fetch(api.runtime.getURL('images/default_favicon.png'))
            .then(response => response.blob())
            .then(blob => createImageBitmap(blob));
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
            tabsList: null
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

        if (isMV3) {
            this.dom.favicon = document.createElement('img');
            this.dom.favicon.alt = this.domain;
        } else {
            // The host page's CSP applies to <img> loads injected by content
            // scripts; drawing on a canvas is not a document load, so it can't
            // be blocked. The pixels come as a data: PNG from the background.
            this.dom.favicon = document.createElement('canvas');
            this.dom.favicon.width = 32;
            this.dom.favicon.height = 32;
            this.dom.favicon.title = this.domain;
        }
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
        fragment.appendChild(this.dom.tabsListContainer);

        this.dom.button.appendChild(fragment);
    }

    #registerEvents() {
        this.dom.tabsListContainer.addEventListener('click', this.#handleTabItemEvents.bind(this));
        this.dom.tabsListContainer.addEventListener('mousedown', this.#handleTabItemEvents.bind(this));
        this.dom.button.addEventListener('mouseenter', () => {
            if (!this.parent.state.isReordering) {
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

    #closeTab(tabId) {
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

    getFirstTabUrl() {
        return this.tabs[0]?.url;
    }

    remove() {
        this.dom.button.remove();
        this.tabItems = null;
    }

    startFaviconAnimation() {
        this.dom.favicon.classList.add('jump');
        setTimeout(() => this.dom.favicon.classList.remove('jump'), 500);
    }

    setFaviconSrc(src) {
        if (this.#renderedFavicon === src) return;
        this.#renderedFavicon = src;

        if (isMV3) {
            let faviconSrc = src;
            if (!faviconSrc || faviconSrc == "default_favicon.png") {
                faviconSrc = api.runtime.getURL("images/default_favicon.png");
            }
            // One-shot: detached before the swap so a broken default can't loop.
            this.dom.favicon.onerror = () => {
                this.dom.favicon.onerror = null;
                this.dom.favicon.src = api.runtime.getURL("images/default_favicon.png");
            };
            if (this.dom.favicon.src !== faviconSrc) {
                this.dom.favicon.src = faviconSrc;
            }
            return;
        }

        this.#drawFavicon(src);
    }

    async #drawFavicon(src) {
        const token = ++this.#renderToken;
        let bitmap = null;
        if (src && src.startsWith('data:')) {
            try {
                const bytes = Uint8Array.from(atob(src.split(',')[1]), c => c.charCodeAt(0));
                bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
            } catch (e) {
                bitmap = null;
            }
        }
        if (!bitmap) {
            // null, "default_favicon.png", a stale raw URL from the old storage
            // schema, or an undecodable payload: show the default icon.
            bitmap = await getDefaultBitmap();
        }
        if (token !== this.#renderToken) return;
        const ctx = this.dom.favicon.getContext('2d');
        ctx.clearRect(0, 0, 32, 32);
        ctx.drawImage(bitmap, 0, 0, 32, 32);
    }
}

export default DockItem;
