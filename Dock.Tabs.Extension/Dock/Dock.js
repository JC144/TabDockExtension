import DockItem from './DockItem.js';

class Dock {
    constructor() {
        this.#initialize();
    }

    #initialize() {
        this.state = {
            isOver: false,
            isOpen: true,
            draggedDockItem: null,
            isLoading: true,
            position: 'bottom'
        };

        this.dom = {
            dock: null,
            dockContainer: null,
            dockItemContainer: null,
            dockBackground: null,
            dropdownContainer: null,
            closeButton: null,
            positionControls: null,
            upButton: null,
            downButton: null
        };

        this.dockItems = [];

        if (typeof browser === "undefined") {
            this.browser = chrome;
        }
        else {
            this.browser = browser;
        }

        this.#createDock();
        this.#createPositionControls();
        this.#registerEvents();

        window.addEventListener('resize', this.#adjustContainerWidth.bind(this));

        this.#addHorizontalScrolling();
        this.#addHoverBehavior();

        this.#createCloseButton();
        this.#registerCloseButtonEvents();
    }

    setWindowId(windowId) {
        this.windowId = windowId;
    }

    saveState() {
        const dockItemArr = Object.values(this.dockItems);
        this.#saveState(dockItemArr);
    }

    #saveState(dockItemArr) {
        let tabData = [];

        dockItemArr.forEach(dockItem => {
            tabData.push({ domain: dockItem.domain, tabs: dockItem.tabItems.map(t => t.tab) });
        });

        this.#recreateDockItems(dockItemArr);

        this.browser.storage.local.set({ tabData: tabData });

        this.browser.runtime.sendMessage({
            action: 'updateTabOrder',
            windowId: this.windowId,  // Include windowId in the message
            newOrder: dockItemArr.map(item => ({
                domain: item.domain,
                tabIds: item.tabItems.map(tabItem => tabItem.tab.id)
            }))
        });
    }

    // Update the message sending methods to include windowId
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
                            this.browser.runtime.sendMessage({ 
                                action: 'openTab', 
                                tabUri: dockItem.tabItems[0].tab.url,
                                windowId: this.windowId
                            });
                        }
                        break;
                    case 'mousedown':
                        if (e.target.closest('.favicon') && e.button === 1) {
                            e.preventDefault();
                            this.browser.runtime.sendMessage({ 
                                action: 'openAndNavigateToTab', 
                                tabUri: dockItem.tabItems[0].tab.url,
                                windowId: this.windowId
                            });
                        }
                        break;
                }
            }
        }
    }

    #createCloseButton() {
        this.dom.closeButton = document.createElement('div');
        this.dom.closeButton.className = 'interaction-button close-button';
        this.dom.closeButton.innerHTML = '&#x2715;'; // Unicode for '×'
        this.dom.closeButton.title = 'Close';
        this.dom.dockContainer.appendChild(this.dom.closeButton);
    }

    #registerCloseButtonEvents() {
        this.dom.closeButton.addEventListener('click', () => {
            this.#closeDock();
        });
    }

    #createPositionControls() {
        // Create container for position controls
        this.dom.positionControls = document.createElement('div');
        this.dom.positionControls.className = 'dock-position-controls';

        // Create up button
        this.dom.upButton = document.createElement('div');
        this.dom.upButton.className = 'interaction-button position-button';
        this.dom.upButton.innerHTML = `
            <svg viewBox="0 0 28 28" style="margin: 1px 0px 0px 2px;">
                <path d="M12 4l-8 8h16l-8-8z" fill="#6a6a6a"/>
            </svg>
        `;

        // Create down button
        this.dom.downButton = document.createElement('div');
        this.dom.downButton.className = 'interaction-button position-button';
        this.dom.downButton.innerHTML = `
            <svg viewBox="0 0 28 28" style="margin: 0px 0px 3px 2px;">
                <path d="M12 20l-8-8h16l-8 8z" fill="#6a6a6a"/>
            </svg>
        `;

        this.dom.positionControls.appendChild(this.dom.upButton);
        this.dom.positionControls.appendChild(this.dom.downButton);
        this.dom.dockItemContainer.appendChild(this.dom.positionControls);

        this.#updatePositionButtons();
    }

    #updatePositionButtons() {
        if (this.state.position === 'bottom') {
            this.dom.upButton.classList.add('visible');
            this.dom.downButton.classList.remove('visible');
        } else {
            this.dom.upButton.classList.remove('visible');
            this.dom.downButton.classList.add('visible');
        }
    }

    #registerPositionControlEvents() {
        this.dom.upButton.addEventListener('click', () => {
            this.#moveDockTo('top');
        });

        this.dom.downButton.addEventListener('click', () => {
            this.#moveDockTo('bottom');
        });
    }

    #moveDockTo(position) {
        const wasTop = this.state.position === 'top';
        this.state.position = position;
        const isTop = position === 'top';
        
        // Only recreate if position actually changed
        if (wasTop !== isTop) {
            this.#recreateDropdowns();
        }

        this.dom.dock.classList.toggle('top', isTop);
        this.dom.dockContainer.classList.toggle('top', isTop);
        this.dom.dropdownContainer.classList.toggle('top', isTop);
        
        if (isTop) {
            this.dom.dock.style.bottom = 'auto';
            this.dom.dock.style.top = '10px';
        } else {
            this.dom.dock.style.top = 'auto';
            this.dom.dock.style.bottom = '10px';
        }

        this.#updatePositionButtons();
    }

    #recreateDropdowns() {
        // Store the current dropdowns data
        const dropdownsData = Object.values(this.dockItems).map(dockItem => ({
            domain: dockItem.domain,
            tabs: dockItem.tabItems.map(item => item.tab)
        }));

        // Remove all existing dropdowns
        this.dom.dropdownContainer.innerHTML = '';

        // Recreate dropdowns with new structure
        dropdownsData.forEach(data => {
            const dockItem = this.dockItems[data.domain];
            if (dockItem) {
                // Remove old dropdown
                dockItem.dom.dropdown.remove();
                
                // Create new dropdown
                dockItem.dom.dropdown = document.createElement('div');
                dockItem.dom.dropdown.className = 'dropdown-content';
                dockItem.dom.dropdown.dataset.domain = data.domain;

                dockItem.dom.tabsList = document.createElement('div');
                dockItem.dom.tabsList.className = 'tabs-list';
                dockItem.dom.dropdown.appendChild(dockItem.dom.tabsList);

                // Recreate tab items
                data.tabs.forEach(tab => {
                    const tabItem = dockItem.tabItems.find(t => t.tab.id === tab.id);
                    if (tabItem) {
                        dockItem.dom.tabsList.appendChild(tabItem.dom.tabItem);
                    }
                });

                this.dom.dropdownContainer.appendChild(dockItem.dom.dropdown);
            }
        });
    }

    #closeDock() {
        // Remove the dock from the DOM
        this.dom.dock.remove();
    }

    #adjustContainerWidth() {
        if (this.dom.dockContainer) {
            this.dom.dockContainer.style.maxWidth = `${window.innerWidth - 160}px`;
        }
    }

    #addHorizontalScrolling() {
        this.dom.dockItemContainer.addEventListener('wheel', (event) => {
            if (event.deltaY !== 0) {
                event.preventDefault();

                // Calculate the scroll amount
                const scrollAmount = event.deltaY * 2;  // Adjust multiplier for desired scroll speed
                const currentScroll = this.dom.dockItemContainer.scrollLeft;
                const maxScroll = this.dom.dockItemContainer.scrollWidth - this.dom.dockItemContainer.clientWidth;

                // Determine the new scroll position
                let newScroll = currentScroll + scrollAmount;
                newScroll = Math.max(0, Math.min(newScroll, maxScroll));

                // Perform the smooth scroll
                this.dom.dockItemContainer.scrollTo({
                    left: newScroll,
                    behavior: 'smooth'
                });
            }
        });
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

        this.dom.dockBackground = document.createElement('div');
        this.dom.dockBackground.className = 'dock-background';

        this.dom.dockContainer = document.createElement('div');
        this.dom.dockContainer.className = 'dock-container';

        this.dom.dockItemContainer = document.createElement('div');
        this.dom.dockItemContainer.id = 'tab-group-container';
        this.dom.dockItemContainer.className = 'tab-group-container';

        this.dom.dropdownContainer = document.createElement('div');
        this.dom.dropdownContainer.className = 'dropdown-container';

        this.#adjustContainerWidth();

        this.dom.dockContainer.appendChild(this.dom.dockItemContainer);
        fragment.appendChild(this.dom.dockBackground);
        fragment.appendChild(this.dom.dockContainer);
        fragment.appendChild(this.dom.dropdownContainer);

        template.appendChild(fragment);
        shadow.appendChild(template);
        document.body.appendChild(this.dom.dock);

        this.expandDock();

        if (this.state.isLoading) {
            this.dom.dock.style.opacity = '0';
        }
    }

    setLoading(loading) {
        this.state.isLoading = loading;
        
        if (this.dom.dock) {
            if (loading) {
                this.dom.dock.style.opacity = '0';
                this.dom.dock.style.transform = 'translate(-50%, 20px)';
                this.#collapseDock();
            } else {
                // Trigger a smooth transition when showing the dock
                setTimeout(() => {
                    this.dom.dock.style.opacity = '1';
                    this.dom.dock.style.transform = 'translate(-50%, 0)';
                    this.expandDock();
                }, 100); // Small delay to ensure transition works
            }
        }
    }

    isLoading() {
        return this.state.isLoading;
    }

    #registerEvents() {
        this.#registerPositionControlEvents();

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
            if (this.state.isOpen && !this.state.isOver) {
                if (this.state.position === 'bottom' && 
                    e.clientY < (window.innerHeight - (window.innerHeight * 0.1))) {
                    this.#collapseDock();
                } else if (this.state.position === 'top' && 
                         e.clientY > (window.innerHeight * 0.1)) {
                    this.#collapseDock();
                }
            }
        });
    }

    #collapseDock() {
        if (this.dom.dock) {
            if (this.state.position === 'bottom') {
                this.dom.dock.style.bottom = '-54px';
            } else {
                this.dom.dock.style.top = '-54px';
            }
            this.state.isOpen = false;
            this.browser.runtime.sendMessage({ action: 'collapseDock' });
        }
    }

    expandDock() {
        if (this.dom.dock) {
            if (this.state.position === 'bottom') {
                this.dom.dock.style.bottom = '10px';
            } else {
                this.dom.dock.style.top = '10px';
            }
            this.state.isOpen = true;
        }
    }

    #addHoverBehavior() {
        this.dom.dockItemContainer.addEventListener('mouseover', (event) => {
            const favicon = event.target.closest('.favicon');
            if (favicon) {
                const domain = favicon.dataset.domain;
                this.#showDropdown(domain);
            }
        });

        this.dom.dockItemContainer.addEventListener('mouseout', (event) => {
            const favicon = event.target.closest('.favicon');
            if (favicon) {
                const domain = favicon.dataset.domain;
                this.#hideDropdown(domain);
            }
        });

        this.dom.dropdownContainer.addEventListener('mouseover', (event) => {
            const dropdown = event.target.closest('.dropdown-content');
            if (dropdown) {
                dropdown.classList.add('active');
            }
        });

        this.dom.dropdownContainer.addEventListener('mouseout', (event) => {
            const dropdown = event.target.closest('.dropdown-content');
            if (dropdown) {
                dropdown.classList.remove('active');
            }
        });
    }

    #showDropdown(domain) {
        const dropdown = this.dom.dropdownContainer.querySelector(`.dropdown-content[data-domain="${domain}"]`);
        const favicon = this.dom.dockItemContainer.querySelector(`.favicon[data-domain="${domain}"]`);
        if (dropdown && favicon) {
            dropdown.classList.add('active');
            this.#positionDropdown(dropdown, favicon);
        }
    }

    #hideDropdown(domain) {
        const dropdown = this.dom.dropdownContainer.querySelector(`.dropdown-content[data-domain="${domain}"]`);
        if (dropdown) {
            setTimeout(() => {
                if (!dropdown.matches(':hover')) {
                    dropdown.classList.remove('active');
                }
            }, 100);
        }
    }

    #positionDropdown(dropdown, favicon) {
        const faviconRect = favicon.getBoundingClientRect();
        const dockRect = this.dom.dock.getBoundingClientRect();
        const dropdownRect = dropdown.getBoundingClientRect();
        const marginSide = (window.innerWidth - dockRect.width);
        const marginOneSide = marginSide / 2;
        const dropDownRectHalfSized = (dropdownRect.width / 2);

        // Calculate the left position
        let leftPosition = faviconRect.left - dockRect.left + faviconRect.width / 2;

        // Check if the dropdown would overflow on the left side
        if ((marginOneSide - dropDownRectHalfSized) + leftPosition < 0) {
            leftPosition = 0 - (marginOneSide - dropDownRectHalfSized);
        }
        // Check if the dropdown would overflow on the right side
        else if (marginOneSide + dockRect.width + (dropDownRectHalfSized - (dockRect.width - leftPosition)) > window.innerWidth) {
            leftPosition = (window.innerWidth - (marginOneSide + dockRect.width + (dropDownRectHalfSized - (dockRect.width - leftPosition))) + leftPosition);
        }

        dropdown.style.left = `${leftPosition}px`;

        // Set max-height based on available space
        const availableSpace = this.state.position === 'top' 
            ? window.innerHeight - dockRect.bottom - 10  // Space below dock
            : dockRect.top - 10;  // Space above dock

        dropdown.querySelector('.tabs-list').style.maxHeight = `${Math.min(300, availableSpace)}px`;
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
        this.dom.dockItemContainer.appendChild(dockItem.dom.button);
        this.dom.dropdownContainer.appendChild(dockItem.dom.dropdown);
        return dockItem;
    }

    #insertNewDockItem(tabData, domain) {
        const dockItem = this.#createTabGroup(domain, tabData.find(d => d.domain == domain).tabs);
        this.dom.dockItemContainer.appendChild(dockItem.dom.button);
        this.dockItems[domain].startFaviconAnimation();
    }

    removeDockItem(domain) {
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

    #recreateDockItems(dockItemArr) {
        let nDockItems = [];
        for (let i = 0; i < dockItemArr.length; i++) {
            nDockItems[dockItemArr[i].domain] = dockItemArr[i];
        }
        this.dockItems = nDockItems;
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
                this.removeDockItem(domain);
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

    destroy() {
        // Remove all event listeners
        window.removeEventListener('resize', this.#adjustContainerWidth.bind(this));
        
        // Clean up DOM elements
        if (this.dom.dock) {
            this.dom.dock.remove();
        }
    
        // Clear all items
        for (const domain in this.dockItems) {
            if (this.dockItems[domain]) {
                this.dockItems[domain].remove();
            }
        }
        this.dockItems = [];
    
        // Clear DOM references
        this.dom = {
            dock: null,
            dockContainer: null,
            dockItemContainer: null,
            dockBackground: null,
            dropdownContainer: null,
            closeButton: null
        };
    
        // Reset state
        this.state = {
            isOver: false,
            isOpen: false,
            draggedDockItem: null
        };
    }
}

export default Dock;