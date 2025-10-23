import TabItem from './TabItem.js';

class DockItem {
    constructor(parent, domain, tabs) {
        this.#initialize(parent, domain, tabs);
    }

    #initialize(parent, domain, tabs) {
        this.dom = {
            button: null,
            favicon: null,
            dropdown: null,
            tabsList: null
        };

        this.state = {
            draggedTabItem: null
        }

        this.tabItems = [];
        this.domain = domain;
        this.parent = parent;

        if (typeof browser === "undefined") {
            this.browser = chrome;
        }
        else {
            this.browser = browser;
        }

        // Store event handlers for cleanup
        this.eventHandlers = {
            click: null,
            mousedown: null,
            dragover: null,
            drop: null,
            dragstart: null,
            dragend: null
        };

        this.#createDockItem(tabs);
        this.#registerEvents();
    }

    #createDockItem(tabs) {
        this.dom.button = document.createElement('div');
        this.dom.button.className = 'tab-group';
        this.dom.button.dataset.domain = this.domain;

        this.dom.favicon = document.createElement('img');
        this.dom.favicon.className = 'favicon';
        this.dom.favicon.alt = this.domain;
        this.dom.favicon.dataset.domain = this.domain;
        this.dom.favicon.loading = 'lazy'; // Add lazy loading

        this.setFaviconSrc(tabs[0].favicon);

        this.dom.button.setAttribute('draggable', true);
        this.dom.button.appendChild(this.dom.favicon);

        this.dom.dropdown = document.createElement('div');
        this.dom.dropdown.className = 'dropdown-content';
        this.dom.dropdown.dataset.domain = this.domain;

        this.dom.tabsList = document.createElement('div');
        this.dom.tabsList.className = 'tabs-list';
        this.dom.dropdown.appendChild(this.dom.tabsList);

        // Only create visible tabs initially
        const maxInitialTabs = 10;
        tabs.slice(0, maxInitialTabs).forEach((tab) => {
            this.createTabItem(tab);
        });

        // Lazy load remaining tabs
        if (tabs.length > maxInitialTabs) {
            setTimeout(() => {
                tabs.slice(maxInitialTabs).forEach((tab) => {
                    this.createTabItem(tab);
                });
            }, 100);
        }
    }

    #registerEvents() {
        // Store event handlers for cleanup
        this.eventHandlers.click = this.#handleTabItemEvents.bind(this);
        this.eventHandlers.mousedown = this.#handleTabItemEvents.bind(this);
        this.eventHandlers.dragover = (e) => {
            e.preventDefault();
        };

        this.dom.dropdown.addEventListener('click', this.eventHandlers.click);
        this.dom.dropdown.addEventListener('mousedown', this.eventHandlers.mousedown);
        this.dom.button.addEventListener('dragover', this.eventHandlers.dragover);
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
                    this.browser.runtime.sendMessage({ action: 'focusTab', tabId: tabId });
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
        this.browser.runtime.sendMessage({ action: 'closeTab', tabId: tabId });
        this.removeTabItem(tabId);
        if(this.tabItems.length == 0){
            this.parent.removeDockItem(this.domain);
        }
    }

    #reorderArray(arr, oldIndex, newIndex) {
        arr.splice(newIndex, 0, arr.splice(oldIndex, 1)[0]);
    }

    update(updatedTabs) {
        // Filter out undefined values
        this.tabItems = this.tabItems.filter(t => t !== undefined);

        // Compare if a tab is in dockObject.tabData but not in tabData
        let removedTabItems = this.tabItems.filter(tabItem => !updatedTabs.map(t => t.id).includes(tabItem.tab.id));
        if (removedTabItems.length > 0) {
            removedTabItems.forEach(tabItem => {
                this.removeTabItem(tabItem.tab.id);
            });
        }

        // Compare if a tab is in tabData but not in dockObject.tabData
        let newTabs = updatedTabs.filter(tab => !this.tabItems.map(tabItem => tabItem.tab.id).includes(tab.id));
        if (newTabs.length > 0) {
            newTabs.forEach(tab => {
                this.createTabItem(tab, updatedTabs);
            });
        }
    }

    onMove(onButtonMoved) {
        this.eventHandlers.drop = onButtonMoved;
        this.dom.button.addEventListener('drop', this.eventHandlers.drop);
    }

    onDragStart(onDragStarted) {
        this.eventHandlers.dragstart = onDragStarted;
        this.dom.button.addEventListener('dragstart', this.eventHandlers.dragstart);
    }

    onDragEnd(onDragEnded) {
        this.eventHandlers.dragend = onDragEnded;
        this.dom.button.addEventListener('dragend', this.eventHandlers.dragend);
    }

    createTabItem(tab) {
        const tabItem = new TabItem(tab, this);
        this.dom.tabsList.appendChild(tabItem.dom.tabItem);
        this.tabItems.push(tabItem);

        tabItem.onDragStart(() => {
            this.state.draggedTabItem = tabItem;
            setTimeout(() => {
                tabItem.dom.tabItem.classList.add('dragging');
            }, 0);
        });

        tabItem.onDragEnd(() => {
            setTimeout(() => {
                this.state.draggedTabItem = null;
                tabItem.dom.tabItem.classList.remove('dragging');
            }, 0);
        });

        tabItem.onMove((e) => {
            e.preventDefault();
            if (this.state.draggedTabItem != null && tabItem !== this.state.draggedTabItem) {

                const draggedIndex = Object.values(this.tabItems).indexOf(this.state.draggedTabItem);
                const targetIndex = Object.values(this.tabItems).indexOf(tabItem);

                this.#reorderArray(this.tabItems, draggedIndex, targetIndex);
                this.reorderDom();

                this.parent.saveState();
            }
        });
    }

    reorderDom() {
        let lastDomChild = null;
        for (let i = this.tabItems.length - 1; i >= 0; i--) {
            this.dom.tabsList.insertBefore(this.tabItems[i].dom.tabItem, lastDomChild);
            lastDomChild = this.tabItems[i].dom.tabItem;
        }
    }

    removeTabItem(tabId) {
        let tabItem = this.tabItems.find(t => t.tab.id == tabId);
        if (tabItem) {
            this.tabItems.splice(this.tabItems.indexOf(tabItem), 1);
            tabItem.destroy();
        }
    }

    remove() {
        // Clean up event listeners
        if (this.dom.dropdown) {
            this.dom.dropdown.removeEventListener('click', this.eventHandlers.click);
            this.dom.dropdown.removeEventListener('mousedown', this.eventHandlers.mousedown);
        }
        
        if (this.dom.button) {
            this.dom.button.removeEventListener('dragover', this.eventHandlers.dragover);
            if (this.eventHandlers.drop) {
                this.dom.button.removeEventListener('drop', this.eventHandlers.drop);
            }
            if (this.eventHandlers.dragstart) {
                this.dom.button.removeEventListener('dragstart', this.eventHandlers.dragstart);
            }
            if (this.eventHandlers.dragend) {
                this.dom.button.removeEventListener('dragend', this.eventHandlers.dragend);
            }
            this.dom.button.remove();
        }
        
        if (this.dom.dropdown) {
            this.dom.dropdown.remove();
        }
        
        // Clean up tab items
        this.tabItems.forEach(tabItem => {
            if (tabItem && tabItem.destroy) {
                tabItem.destroy();
            }
        });
        
        this.tabItems = [];
        this.eventHandlers = null;
    }

    // Alias for compatibility
    destroy() {
        this.remove();
    }

    startFaviconAnimation() {
        this.dom.favicon.classList.add('jump');
        setTimeout(() => this.dom.favicon.classList.remove('jump'), 500);
    }

    setFaviconSrc(src) {
        let faviconSrc = src;
        if (faviconSrc === undefined || faviconSrc == "default_favicon.png") {
            faviconSrc = this.browser.runtime.getURL("images/default_favicon.png");
        }
        this.dom.favicon.src = faviconSrc;
    }
}

export default DockItem;