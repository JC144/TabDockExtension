import Dock from './Dock/Dock.js';

class Main {
    constructor() {
        this.browser = typeof browser === "undefined" ? chrome : browser;
        this.initialized = false;
        this.storageListener = null;
        this.messageListener = null;
        this.dock = null;

        let checkDocumentState = setInterval(() => {
            if (document.readyState === "complete" || document.readyState === "loaded") {
                this.#initialize();
                clearInterval(checkDocumentState);
            }
        }, 10);
    }

    #initialize() {     
        // Register visibility change event first
        document.addEventListener('visibilitychange', this.#handleVisibilityChange.bind(this));
        
        // Only initialize if the document is visible
        if (document.visibilityState === 'visible') {
            this.#initializeDock();
        }

        this.#registerEvents();
        this.#loadTabs();
    }

    async #initializeDock() {
        if (!this.initialized) {
            this.dock = new Dock();
            this.dock.setLoading(true);
            this.#registerEvents();

            try {
                this.initialized = true;
                await this.#loadTabs();
                this.dock.setLoading(false); // Turn off loading state when done
            } catch (error) {
                console.error('Failed to initialize dock:', error);
                this.#cleanupDock();
            }
        }
    }

    #cleanupDock() {
        if (this.initialized) {
            this.#unregisterEvents();
            if (this.dock) {
                // Assuming you add a destroy method to Dock class
                this.dock.destroy();
                this.dock = null;
            }
            this.initialized = false;
        }
    }

    #handleVisibilityChange() {
        if (document.visibilityState === 'visible') {
            this.#initializeDock();
        } else {
            this.#cleanupDock();
        }
    }

    #registerEvents() {
        // Store reference to bound listeners for cleanup
        this.storageListener = this.#handleStorageChange.bind(this);
        this.messageListener = this.#handleMessage.bind(this);

        this.browser.storage.onChanged.addListener(this.storageListener);
        this.browser.runtime.onMessage.addListener(this.messageListener);
    }

    #unregisterEvents() {
        if (this.storageListener) {
            this.browser.storage.onChanged.removeListener(this.storageListener);
            this.storageListener = null;
        }

        if (this.messageListener) {
            this.browser.runtime.onMessage.removeListener(this.messageListener);
            this.messageListener = null;
        }
    }

    #handleStorageChange(changes, area) {
        if (area === 'local' && changes.tabData && this.dock) {
            this.dock.update(changes.tabData.newValue);
        }
    }

    #handleMessage(message) {
        if (!this.dock) return;

        switch (message.action) {
            case 'expandDock':
                this.dock.expandDock();
                break;
        }
    }

    #loadTabs() {
        if (!this.dock) {
            this.#initializeDock();
            return;
        }

        return new Promise((resolve, reject) => {
            this.browser.storage.local.get('tabData', (data) => {
                if (chrome.runtime.lastError) {
                    reject(chrome.runtime.lastError);
                    return;
                }
                
                if (data.tabData) {
                    this.dock.update(data.tabData);
                }
                resolve(data.tabData || []);
            });
        });
    }
}

export default Main;