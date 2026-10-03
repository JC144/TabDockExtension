class Main {
    constructor() {
        if (document.readyState === 'complete') {
            this.#initialize();
        } else {
            window.addEventListener('load', () => this.#initialize(), { once: true });
        }
    }

    async #initialize() {
        // Ask for the persisted dock edge before building the dock, so the
        // first paint is already on the right edge (no bottom-to-top jump).
        // The background owns it: nothing a page could read holds it.
        let dockPosition = 'bottom';
        try {
            if (await api.runtime.sendMessage({ action: 'getDockPosition' }) === 'top') {
                dockPosition = 'top';
            }
        } catch (e) { }

        this.dock = new Dock(dockPosition);

        this.#registerEvents();
        this.#loadTabs();
    }

    #registerEvents() {
        api.runtime.onMessage.addListener((message) => {
            if (!message) return;
            switch (message.action) {
                // The background pushes this window's view (no url, no other
                // window's tabs) whenever it changes; the page filters nothing.
                case 'tabsUpdated':
                    this.dock.update(message.tabData);
                    break;
                case 'expandDock':
                    this.dock.expandDock();
                    break;
                // No persist: this is the echo of another tab's change (or our
                // own, where setPosition's same-value early return makes it a
                // no-op).
                case 'dockPositionChanged':
                    this.dock.setPosition(message.position);
                    break;
            }
        });
    }

    // Initial pull. A push may land before or after the answer; update() is
    // idempotent, so whichever arrives last wins.
    #loadTabs() {
        api.runtime.sendMessage({ action: 'getTabs' })
            .then(view => this.dock.update(view))
            .catch(() => { });
    }
}
