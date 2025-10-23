import Dock from './Dock/Dock.js';

class Main {
    constructor() {
        this.browser = typeof browser === "undefined" ? chrome : browser;
        this.initialized = false;
        this.storageListener = null;
        this.messageListener = null;
        this.visibilityListener = null;
        this.dock = null;
        this.currentWindowId = null;
        this.tabDataCache = null;
        this.lastUpdateTime = 0;
        this.updateThrottle = 500; // Throttle updates to 500ms

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

        // Register visibility change event
        this.visibilityListener = this.#handleVisibilityChange.bind(this);
        document.addEventListener('visibilitychange', this.visibilityListener);
        
        // Only initialize if the document is visible
        if (document.visibilityState === 'visible') {
            this.#initializeDock();
        }
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
            this.tabDataCache = null;
            this.lastUpdateTime = 0;
        }
    }

    #handleVisibilityChange() {
        if (document.visibilityState === 'visible') {
            if (!this.initialized) {
                this.#initializeDock();
            }
        } else {
            // Don't cleanup immediately - dock might still be in use
            setTimeout(() => {
                if (document.visibilityState !== 'visible' && this.dock && !this.dock.state.isOver) {
                    this.#cleanupDock();
                }
            }, 1000);
        }
    }

    #registerEvents() {
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
                
                // Clear cache to force reload
                this.tabDataCache = null;
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

        if (this.visibilityListener) {
            document.removeEventListener('visibilitychange', this.visibilityListener);
            this.visibilityListener = null;
        }
    }

    #handleStorageChange(changes, area) {
        // Throttle updates
        const now = Date.now();
        if (now - this.lastUpdateTime < this.updateThrottle) {
            return;
        }
        this.lastUpdateTime = now;

        if (area === 'local' && changes.tabData && this.dock) {
            // Get only the current window's tab data
            const windowTabData = changes.tabData.newValue[this.currentWindowId] || [];
            
            // Only update if data actually changed
            if (this.#hasDataChanged(windowTabData)) {
                this.tabDataCache = windowTabData;
                this.dock.update(windowTabData);
            }
        }
    }

    #hasDataChanged(newData) {
        if (!this.tabDataCache) return true;
        if (this.tabDataCache.length !== newData.length) return true;
        
        // Simple comparison - could be optimized further
        return JSON.stringify(this.tabDataCache) !== JSON.stringify(newData);
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
                    this.tabDataCache = windowTabData;
                    this.dock.update(windowTabData);
                }
                resolve(data.tabData || {});
            });
        });
    }

    // Public cleanup method for content script to call
    cleanup() {
        this.#cleanupDock();
    }
}

export default Main;