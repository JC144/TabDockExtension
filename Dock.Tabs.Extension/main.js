import Dock from './Dock/Dock.js';

class Main {
    constructor() {
        this.browser = typeof browser === "undefined" ? chrome : browser;
        this.initialized = false;
        this.storageListener = null;
        this.messageListener = null;
        this.dock = null;
        this.currentWindowId = null;

        let checkDocumentState = setInterval(() => {
            if (document.readyState === "complete" || document.readyState === "loaded") {
                this.#initialize();
                clearInterval(checkDocumentState);
            }
        }, 10);
    }

    async #initialize() {     
        // Request window ID from background script
        await this.#getWindowId();

        // Register visibility change event first
        document.addEventListener('visibilitychange', this.#handleVisibilityChange.bind(this));
        
        // Only initialize if the document is visible
        if (document.visibilityState === 'visible') {
            this.#initializeDock();
        }

        this.#registerEvents();
        this.#loadTabs();
    }

    async #getWindowId() {
        return new Promise((resolve) => {
            // First try getting window ID from background script
            this.browser.runtime.sendMessage({ action: 'getWindowId' }, (response) => {
                if (response && response.windowId) {
                    this.currentWindowId = response.windowId;
                    resolve(response.windowId);
                }
            });

            // Also listen for setWindowId message in case it comes later
            const messageListener = (message) => {
                if (message.action === 'setWindowId') {
                    this.currentWindowId = message.windowId;
                    this.browser.runtime.onMessage.removeListener(messageListener);
                    resolve(message.windowId);
                }
            };
            this.browser.runtime.onMessage.addListener(messageListener);
        });
    }

    async #initializeDock() {
        if (!this.initialized && this.currentWindowId) {
            this.dock = new Dock();
            this.dock.setLoading(true);
            this.dock.setWindowId(this.currentWindowId);
            this.#registerEvents();

            try {
                this.initialized = true;
                await this.#loadTabs();
                this.dock.setLoading(false);
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
        // Existing storage and message listeners
        this.storageListener = this.#handleStorageChange.bind(this);
        this.messageListener = this.#handleMessage.bind(this);

        this.browser.storage.onChanged.addListener(this.storageListener);
        this.browser.runtime.onMessage.addListener((message, sender) => {
            // Handle window change messages
            if (message.action === 'windowChanged') {
                this.#handleWindowChange(message.windowId);
            }
            return this.messageListener(message, sender);
        });
    }

    async #handleWindowChange(newWindowId) {
        if (this.currentWindowId !== newWindowId) {
            this.currentWindowId = newWindowId;
            
            // Update dock's window ID
            if (this.dock) {
                this.dock.setWindowId(newWindowId);
                
                // Reload tabs for the new window
                await this.#loadTabs();
            }
        }
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
            // Get only the current window's tab data
            const windowTabData = changes.tabData.newValue[this.currentWindowId] || [];
            this.dock.update(windowTabData);
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
                
                if (data.tabData && this.currentWindowId) {
                    // Get only the current window's tab data
                    const windowTabData = data.tabData[this.currentWindowId] || [];
                    this.dock.update(windowTabData);
                }
                resolve(data.tabData || {});
            });
        });
    }
}

export default Main;