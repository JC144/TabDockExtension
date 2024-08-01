import Dock from './Dock/Dock.js';

class Main {
    constructor() {
        let checkDocumentState = setInterval(() => {
            if (document.readyState === "complete" || document.readyState === "loaded") {
                this.#initialize();
                clearInterval(checkDocumentState);
            }
        }, 10);
    }

    #initialize() {
        this.dock = new Dock();
        if (this.browser === undefined) {
            this.browser = chrome;
          }
          else {
            this.browser = this.browser;
          }

        this.#registerEvents();
        this.#loadTabs();
    }

    #registerEvents() {
        this.browser.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && changes.tabData) {
                this.dock.update(changes.tabData.newValue);
            }
        });

        this.browser.runtime.onMessage.addListener((message) => {
            switch (message.action) {
                case 'expandDock':
                    this.dock.expandDock();
                    break;
            }
        });
    }

    #loadTabs() {
        this.browser.storage.local.get('tabData', (data) => {
            if (data.tabData) {
                this.dock.update(data.tabData);
            }
        });
    }
}

export default Main;