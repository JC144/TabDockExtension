import DockItem from './DockItem.js';

class Dock {
    constructor() {
        this.#initialize();
    }

    #initialize() {
        this.state = {
            isOver: false,
            isOpen: true,
            draggedDockItem: null
        };

        this.dom = {
            dock: null,
            dockItemContainer: null,
        };

        this.dockItems = [];

        this.browser = chrome ?? browser;

        this.#createDock();
        this.#registerEvents();
    }

    #createDock() {
        this.dom.dock = document.createElement('div');
        this.dom.dock.id = 'dock';

        const shadow = this.dom.dock.attachShadow({ mode: 'closed' });

        fetch(this.browser.runtime.getURL('dock-styles.css'))
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
            this.expandDock();
        });
        this.dom.dock.addEventListener('mouseleave', e => {
            this.state.isOver = false;
        });

        this.dom.dockItemContainer.addEventListener('click', this.#handleDockItemEvents.bind(this));
        this.dom.dockItemContainer.addEventListener('mousedown', this.#handleDockItemEvents.bind(this));

        document.addEventListener('mousemove', (e) => {
            if (this.state.isOpen && !this.state.isOver && e.clientY < (window.innerHeight - (window.innerHeight * 0.1))) {
                this.#collapseDock();
            }
        });
    }

    #handleDockItemEvents(e) {
        const target = e.target.closest('.tab-group');

        if (target) {
            const domain = target.dataset.domain;
            const dockItem = this.dockItems[domain];

            if (dockItem) {
                switch (e.type) {
                    case 'click':
                        if (e.target.closest('.favicon')) {
                            e.preventDefault();
                            this.browser.runtime.sendMessage({ action: 'openTab', tabUri: dockItem.tabItems[0].tab.url });
                        }
                        break;
                    case 'mousedown':
                        if (e.target.closest('.favicon') && e.button === 1) {
                            e.preventDefault();
                            this.browser.runtime.sendMessage({ action: 'openAndNavigateToTab', tabUri: dockItem.tabItems[0].tab.url });
                        }
                        break;
                }
            }
        }
    }

    #collapseDock() {
        if (this.dom.dock) {
            this.dom.dock.style.bottom = '-48px';
            this.state.isOpen = false;
            this.browser.runtime.sendMessage({ action: 'collapseDock' });
        }
    }

    expandDock() {
        if (this.dom.dock) {
            this.dom.dock.style.bottom = '10px';
            this.state.isOpen = true;
        }
    }

    #createTabGroup(domain, tabs) {
        let dockItem = new DockItem(this, domain, tabs);

        dockItem.onDragStart(() => {
            this.state.draggedDockItem = dockItem;
            setTimeout(() => {
                dockItem.dom.button.classList.add('dragging');
            }, 0);
        });

        dockItem.onDragEnd(() => {
            setTimeout(() => {
                this.state.draggedDockItem = null;
                dockItem.dom.button.classList.remove('dragging');
            }, 0);
        });

        dockItem.onMove((e) => {
            e.preventDefault();
            if (this.state.draggedDockItem != null && dockItem !== this.state.draggedDockItem) {
                const draggedIndex = Object.values(this.dockItems).indexOf(this.state.draggedDockItem);
                const targetIndex = Object.values(this.dockItems).indexOf(dockItem);

                const dockItemArr = Object.values(this.dockItems);
                this.#reorderArray(dockItemArr, draggedIndex, targetIndex);
                this.reorderDom(dockItemArr);
                this.#saveState(dockItemArr);
            }
        });

        this.dockItems[dockItem.domain] = dockItem;
        return dockItem;
    }

    #insertNewDockItem(tabData, domain) {
        const dockItem = this.#createTabGroup(domain, tabData.find(d => d.domain == domain).tabs);
        this.dom.dockItemContainer.appendChild(dockItem.dom.button);
        this.dockItems[domain].startFaviconAnimation();
    }

    #removeDockItem(domain) {
        if (this.dockItems[domain]) {
            this.dockItems[domain].remove();
        }
        let nDockItems = [];
        Object.values(this.dockItems).forEach((e) => {
            if (e.domain != domain) {
                nDockItems[e.domain] = e;
            }
        });
        this.dockItems = nDockItems;
    }

    #reorderArray(arr, oldIndex, newIndex) {
        arr.splice(newIndex, 0, arr.splice(oldIndex, 1)[0]);
    }

    #saveState(dockItemArr) {
        let tabData = [];

        dockItemArr.forEach(dockItem => {
            tabData.push({ domain: dockItem.domain, tabs: dockItem.tabItems.map(t => t.tab) });
        });

        this.#recreateDockItems(dockItemArr);

        this.browser.storage.local.set({ tabData: tabData });

        chrome.runtime.sendMessage({
            action: 'updateTabOrder',
            newOrder: dockItemArr.map(item => ({
                domain: item.domain,
                tabIds: item.tabItems.map(tabItem => tabItem.tab.id)
            }))
        });
    }

    #recreateDockItems(dockItemArr) {
        let nDockItems = [];
        for (let i = 0; i < dockItemArr.length; i++) {
            nDockItems[dockItemArr[i].domain] = dockItemArr[i];
        }
        this.dockItems = nDockItems;
    }

    saveState() {
        const dockItemArr = Object.values(this.dockItems);
        this.#saveState(dockItemArr);
    }

    reorderDom(dockItemArr) {
        let lastDomChild = null;
        for (let i = dockItemArr.length - 1; i >= 0; i--) {
            this.dom.dockItemContainer.insertBefore(dockItemArr[i].dom.button, lastDomChild);
            lastDomChild = dockItemArr[i].dom.button;
            dockItemArr[i].reorderDom();
        }
    }

    update(tabData) {
        let hasBeenModified = false;

        //Remove from dock, items that have been removed from other docks
        for (const domain in this.dockItems) {
            if (!tabData.find(d => d.domain == domain) || this.dockItems[domain] === undefined || this.dockItems[domain].length == 0) {
                this.#removeDockItem(domain);
                hasBeenModified = true;
            }
        }

        //Insert new item in the dock
        for (const tabDataIndex in tabData) {
            const domainData = tabData[tabDataIndex];
            if (this.dockItems[domainData.domain] === undefined) {
                this.#insertNewDockItem(tabData, domainData.domain);
                hasBeenModified = true;
            }
        }

        //Reorder the dock
        const dockItemArr = Object.values(this.dockItems);
        for (const tabDataIndex in tabData) {
            const domainData = tabData[tabDataIndex];
            const oldIndex = dockItemArr.indexOf(dockItemArr.find(d => d.domain == domainData.domain));
            if (tabDataIndex != oldIndex) {
                this.#reorderArray(dockItemArr, tabDataIndex, oldIndex);
                hasBeenModified = true;
            }
            this.dockItems[domainData.domain].update(domainData.tabs);
            if (domainData.tabs.length > 0) {
                if (this.dockItems[domainData.domain].dom.favicon.src != domainData.tabs[0].favicon) {
                    this.dockItems[domainData.domain].setFaviconSrc(domainData.tabs[0].favicon);
                }
            }

            for (const tabIndex in domainData.tabs) {
                const currentTabItems = dockItemArr[tabDataIndex].tabItems.filter(t => t !== undefined);
                const oldTabIndex = currentTabItems.indexOf(currentTabItems.find(t => t.tab.id == domainData.tabs[tabIndex].id));
                if (tabIndex != oldTabIndex) {
                    this.#reorderArray(currentTabItems, tabIndex, oldTabIndex);
                    hasBeenModified = true;
                }
                dockItemArr[tabDataIndex].tabItems = currentTabItems;
            }
        }

        //If the dock items have been modified
        //Save the order
        //And reorder the dom
        if (hasBeenModified) {
            this.#recreateDockItems(dockItemArr);
            this.reorderDom(dockItemArr);
        }
    }
}

export default Dock;