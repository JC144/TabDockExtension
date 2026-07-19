import Dock from './Dock/Dock.js';
import { api } from './browser-api.js';

class Main {
    constructor() {
        if (document.readyState === 'complete') {
            this.#initialize();
        } else {
            window.addEventListener('load', () => this.#initialize(), { once: true });
        }
    }

    async #initialize() {
        // Read the persisted dock edge before building the dock, so the first
        // paint is already on the right edge (no bottom-to-top jump).
        let dockPosition = 'bottom';
        try {
            const data = await api.storage.local.get('dockPosition');
            if (data.dockPosition === 'top') {
                dockPosition = 'top';
            }
        } catch (e) { }

        this.dock = new Dock(dockPosition);

        // Content scripts cannot read their own windowId; the background reads
        // it from sender.tab. Must be known before the first render.
        try {
            const response = await api.runtime.sendMessage({ action: 'getWindowId' });
            this.windowId = response ? response.windowId : undefined;
        } catch (e) {
            this.windowId = undefined;
        }

        this.#registerEvents();
        this.#loadTabs();
    }

    // The dock only shows this window's tabs. If the windowId is unknown
    // (no response from the background), fall back to showing everything.
    #filterForWindow(tabData) {
        if (this.windowId === undefined || !Array.isArray(tabData)) return tabData;
        return tabData
            .map(d => ({ ...d, tabs: d.tabs.filter(t => t.windowId === this.windowId) }))
            .filter(d => d.tabs.length > 0);
    }

    #registerEvents() {
        api.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && changes.tabData) {
                this.tabData = changes.tabData.newValue;
                this.dock.update(this.#filterForWindow(this.tabData));
            }
            // No persist: this is the echo of another tab's write (or our own,
            // where setPosition's same-value early return makes it a no-op).
            if (area === 'local' && changes.dockPosition) {
                this.dock.setPosition(changes.dockPosition.newValue);
            }
        });

        api.runtime.onMessage.addListener((message) => {
            switch (message.action) {
                case 'expandDock':
                    this.dock.expandDock();
                    break;
                // This tab was dragged to another window: the windowId cached
                // at load is stale, so re-filter the last known tabData for
                // the new window.
                case 'windowChanged':
                    this.windowId = message.windowId;
                    if (this.tabData) {
                        this.dock.update(this.#filterForWindow(this.tabData));
                    }
                    break;
            }
        });
    }

    #loadTabs() {
        api.storage.local.get('tabData').then((data) => {
            if (data.tabData) {
                this.tabData = data.tabData;
                this.dock.update(this.#filterForWindow(this.tabData));
            }
        });
    }
}

export default Main;
