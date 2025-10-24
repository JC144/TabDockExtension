import DockItem from './DockItem.js';

class Dock {
    constructor() {
        this.#initialize();
    }

    async #initialize() {
        this.state = {
            isOver: false,
            isOpen: true,
            draggedDockItem: null,
            isLoading: true,
            position: 'bottom',
            hasAnimated: false
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

        this.dockItems = {};  // Use object instead of array for better memory management
        this.eventHandlers = {}; // Store event handlers for cleanup

        if (typeof browser === "undefined") {
            this.browser = chrome;
        }
        else {
            this.browser = browser;
        }

        await this.#loadSavedPosition();

        this.#createDock();
        this.#createPositionControls();
        this.#registerEvents();

        // Store bound handlers for cleanup
        this.boundHandlers = {
            resize: this.#adjustContainerWidth.bind(this),
            wheel: this.#handleWheel.bind(this),
            mouseover: this.#handleHover.bind(this),
            mouseout: this.#handleHoverOut.bind(this),
            dropdownMouseover: this.#handleDropdownHover.bind(this),
            dropdownMouseout: this.#handleDropdownHoverOut.bind(this)
        };

        window.addEventListener('resize', this.boundHandlers.resize);

        this.#addHorizontalScrolling();
        this.#addHoverBehavior();

        this.#createCloseButton();
        this.#registerCloseButtonEvents();

        // Listen for tab changes to update current website indicator
        this.#registerTabChangeListener();

        if (this.state.position === 'top') {
            this.#moveDockTo(this.state.position);
        }
    }

    async #loadSavedPosition() {
        return new Promise((resolve) => {
            this.browser.storage.local.get('dockPosition', (result) => {
                if (result.dockPosition) {
                    this.state.position = result.dockPosition;
                }
                resolve();
            });
        });
    }

    #saveDockPosition(position) {
        this.browser.storage.local.set({ dockPosition: position });
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

        // Store tab data per window
        this.browser.storage.local.get('tabData', (result) => {
            const allTabData = result.tabData || {};
            allTabData[this.windowId] = tabData;
            this.browser.storage.local.set({ tabData: allTabData });
        });

        this.browser.runtime.sendMessage({
            action: 'updateTabOrder',
            windowId: this.windowId,
            newOrder: dockItemArr.map(item => ({
                domain: item.domain,
                tabIds: item.tabItems.map(tabItem => tabItem.tab.id)
            }))
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

    #handleWheel(event) {
        if (event.deltaY !== 0) {
            event.preventDefault();

            const scrollAmount = event.deltaY * 2;
            const currentScroll = this.dom.dockItemContainer.scrollLeft;
            const maxScroll = this.dom.dockItemContainer.scrollWidth - this.dom.dockItemContainer.clientWidth;

            let newScroll = currentScroll + scrollAmount;
            newScroll = Math.max(0, Math.min(newScroll, maxScroll));

            this.dom.dockItemContainer.scrollTo({
                left: newScroll,
                behavior: 'smooth'
            });
        }
    }

    #handleHover(event) {
        const favicon = event.target.closest('.favicon');
        if (favicon) {
            const domain = favicon.dataset.domain;
            this.#showDropdown(domain);
        }
    }

    #handleHoverOut(event) {
        const favicon = event.target.closest('.favicon');
        if (favicon) {
            const domain = favicon.dataset.domain;
            this.#hideDropdown(domain);
        }
    }

    #handleDropdownHover(event) {
        const dropdown = event.target.closest('.dropdown-content');
        if (dropdown) {
            dropdown.classList.add('active');
        }
    }

    #handleDropdownHoverOut(event) {
        const dropdown = event.target.closest('.dropdown-content');
        if (dropdown) {
            dropdown.classList.remove('active');
        }
    }

    #createCloseButton() {
        this.dom.closeButton = document.createElement('div');
        this.dom.closeButton.className = 'interaction-button close-button';
        this.dom.closeButton.innerHTML = '&#x2715;';
        this.dom.closeButton.title = 'Close';
        this.dom.dockContainer.appendChild(this.dom.closeButton);
    }

    #registerCloseButtonEvents() {
        this.eventHandlers.closeButton = () => this.#closeDock();
        this.dom.closeButton.addEventListener('click', this.eventHandlers.closeButton);
    }

    #createPositionControls() {
        this.dom.positionControls = document.createElement('div');
        this.dom.positionControls.className = 'dock-position-controls';

        this.dom.upButton = document.createElement('div');
        this.dom.upButton.className = 'interaction-button position-button';
        this.dom.upButton.innerHTML = `
            <svg viewBox="0 0 28 28" style="margin: 1px 0px 0px 2px;">
                <path d="M12 4l-8 8h16l-8-8z" fill="black"/>
            </svg>
        `;

        this.dom.downButton = document.createElement('div');
        this.dom.downButton.className = 'interaction-button position-button';
        this.dom.downButton.innerHTML = `
            <svg viewBox="0 0 28 28" style="margin: 0px 0px 3px 2px;">
                <path d="M12 20l-8-8h16l-8 8z" fill="black"/>
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
        this.eventHandlers.upButton = () => this.#moveDockTo('top');
        this.eventHandlers.downButton = () => this.#moveDockTo('bottom');
        
        this.dom.upButton.addEventListener('click', this.eventHandlers.upButton);
        this.dom.downButton.addEventListener('click', this.eventHandlers.downButton);
    }

    #moveDockTo(position) {
        const wasTop = this.state.position === 'top';
        this.state.position = position;
        const isTop = position === 'top';
        
        if (wasTop !== isTop) {
            this.#recreateDropdowns();
            this.#saveDockPosition(position);
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
        const dropdownsData = Object.values(this.dockItems).map(dockItem => ({
            domain: dockItem.domain,
            tabs: dockItem.tabItems.map(item => item.tab)
        }));

        this.dom.dropdownContainer.innerHTML = '';

        dropdownsData.forEach(data => {
            const dockItem = this.dockItems[data.domain];
            if (dockItem) {
                dockItem.dom.dropdown.remove();
                
                dockItem.dom.dropdown = document.createElement('div');
                dockItem.dom.dropdown.className = 'dropdown-content';
                dockItem.dom.dropdown.dataset.domain = data.domain;

                dockItem.dom.tabsList = document.createElement('div');
                dockItem.dom.tabsList.className = 'tabs-list';
                dockItem.dom.dropdown.appendChild(dockItem.dom.tabsList);

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
        this.destroy();
    }

    #adjustContainerWidth() {
        if (this.dom.dockContainer) {
            this.dom.dockContainer.style.maxWidth = `${window.innerWidth - 160}px`;
        }
    }

    #addHorizontalScrolling() {
        this.dom.dockItemContainer.addEventListener('wheel', this.boundHandlers.wheel);
    }

    #createDock() {
        this.dom.dock = document.createElement('div');
        this.dom.dock.id = 'dock';

        const shadow = this.dom.dock.attachShadow({ mode: 'closed' });

        fetch(this.browser.runtime.getURL('dock-styles.css'))
            .then(response => response.text())
            .then(cssText => {
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
                setTimeout(() => {
                    this.dom.dock.style.opacity = '1';
                    this.dom.dock.style.transform = 'translate(-50%, 0)';
                    this.expandDock();
                    
                    // Trigger animation for dock items after dock appears
                    setTimeout(() => {
                        this.#animateDockItemsSequentially();
                        // Update current website indicator after animation
                        setTimeout(() => {
                            this.#updateCurrentWebsiteIndicator();
                        }, 100);
                    }, 200);
                }, 100);
            }
        }
    }

    isLoading() {
        return this.state.isLoading;
    }

    #registerEvents() {
        this.#registerPositionControlEvents();

        this.eventHandlers.dockMouseover = e => {
            this.state.isOver = true;
            this.expandDock();
        };
        
        this.eventHandlers.dockMouseleave = e => {
            this.state.isOver = false;
        };
        
        this.eventHandlers.dockItemClick = this.#handleDockItemEvents.bind(this);
        this.eventHandlers.dockItemMousedown = this.#handleDockItemEvents.bind(this);
        
        this.eventHandlers.documentMousemove = (e) => {
            if (this.state.isOpen && !this.state.isOver) {
                if (this.state.position === 'bottom' && 
                    e.clientY < (window.innerHeight - (window.innerHeight * 0.1))) {
                    this.#collapseDock();
                } else if (this.state.position === 'top' && 
                         e.clientY > (window.innerHeight * 0.1)) {
                    this.#collapseDock();
                }
            }
        };

        this.dom.dock.addEventListener('mouseover', this.eventHandlers.dockMouseover);
        this.dom.dock.addEventListener('mouseleave', this.eventHandlers.dockMouseleave);
        this.dom.dockItemContainer.addEventListener('click', this.eventHandlers.dockItemClick);
        this.dom.dockItemContainer.addEventListener('mousedown', this.eventHandlers.dockItemMousedown);
        document.addEventListener('mousemove', this.eventHandlers.documentMousemove);
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
        this.dom.dockItemContainer.addEventListener('mouseover', this.boundHandlers.mouseover);
        this.dom.dockItemContainer.addEventListener('mouseout', this.boundHandlers.mouseout);
        this.dom.dropdownContainer.addEventListener('mouseover', this.boundHandlers.dropdownMouseover);
        this.dom.dropdownContainer.addEventListener('mouseout', this.boundHandlers.dropdownMouseout);
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

        let leftPosition = faviconRect.left - dockRect.left + faviconRect.width / 2;

        if ((marginOneSide - dropDownRectHalfSized) + leftPosition < 0) {
            leftPosition = 0 - (marginOneSide - dropDownRectHalfSized);
        }
        else if (marginOneSide + dockRect.width + (dropDownRectHalfSized - (dockRect.width - leftPosition)) > window.innerWidth) {
            leftPosition = (window.innerWidth - (marginOneSide + dockRect.width + (dropDownRectHalfSized - (dockRect.width - leftPosition))) + leftPosition);
        }

        dropdown.style.left = `${leftPosition}px`;

        const availableSpace = this.state.position === 'top' 
            ? window.innerHeight - dockRect.bottom - 10
            : dockRect.top - 10;

        dropdown.querySelector('.tabs-list').style.maxHeight = `${availableSpace}px`;
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

    #animateDockItemsSequentially() {
        // Only animate once per dock initialization
        if (this.state.hasAnimated) return;
        this.state.hasAnimated = true;
        
        const dockItemElements = Array.from(this.dom.dockItemContainer.querySelectorAll('.tab-group'));
        
        // Set initial state for all items
        dockItemElements.forEach(element => {
            element.classList.add('dock-item-initial');
        });

        // Animate each item with a smooth delay
        dockItemElements.forEach((element, index) => {
            setTimeout(() => {
                // Skip animation if item is being dragged
                if (element.classList.contains('dragging')) {
                    element.classList.remove('dock-item-initial');
                    return;
                }
                
                element.classList.remove('dock-item-initial');
                element.classList.add('pop-in');
                
                // Remove animation class after animation completes
                setTimeout(() => {
                    element.classList.remove('pop-in');
                }, 800);
            }, index * 80); // 80ms delay between each item for smoother wave effect
        });
    }

    removeDockItem(domain) {
        if (this.dockItems[domain]) {
            this.dockItems[domain].destroy();
            delete this.dockItems[domain];
        }
    }

    #reorderArray(arr, oldIndex, newIndex) {
        arr.splice(newIndex, 0, arr.splice(oldIndex, 1)[0]);
    }

    #recreateDockItems(dockItemArr) {
        let nDockItems = {};
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

        // Remove items that are no longer present
        for (const domain in this.dockItems) {
            if (!tabData.find(d => d.domain == domain) || this.dockItems[domain] === undefined || this.dockItems[domain].length == 0) {
                this.removeDockItem(domain);
                hasBeenModified = true;
            }
        }

        // Insert new items
        let hasNewItems = false;
        for (const tabDataIndex in tabData) {
            const domainData = tabData[tabDataIndex];
            if (this.dockItems[domainData.domain] === undefined) {
                this.#insertNewDockItem(tabData, domainData.domain);
                hasBeenModified = true;
                hasNewItems = true;
            }
        }

        // Trigger animation for new items if this is the initial load
        if (hasNewItems && Object.keys(this.dockItems).length === tabData.length) {
            // Small delay to ensure DOM is updated
            setTimeout(() => {
                this.#animateDockItemsSequentially();
            }, 50);
        }

        // Update and reorder
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

        // Update current website indicator
        this.#updateCurrentWebsiteIndicator();

        if (hasBeenModified) {
            this.#recreateDockItems(dockItemArr);
            this.reorderDom(dockItemArr);
        }
    }

    #updateCurrentWebsiteIndicator() {
        // Request current tab info from background script
        this.browser.runtime.sendMessage({ 
            action: 'getCurrentTabInfo',
            windowId: this.windowId 
        }, (response) => {
            if (response && response.url) {
                const currentDomain = this.#extractDomain(response.url);
                
                // Update all dock items
                Object.values(this.dockItems).forEach(dockItem => {
                    const isCurrent = dockItem.domain === currentDomain;
                    dockItem.setCurrentWebsite(isCurrent);
                });
            } else {
                console.warn('No response or URL from getCurrentTabInfo');
            }
        });
    }

    #extractDomain(url) {
        try {
            const urlObj = new URL(url);
            return urlObj.hostname;
        } catch (error) {
            return null;
        }
    }

    #registerTabChangeListener() {
        // Listen for messages from background script about tab changes
        this.browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
            if (message.action === 'tabChanged' && message.windowId === this.windowId) {
                this.#updateCurrentWebsiteIndicator();
            }
        });
    }

    destroy() {
        // Remove all event listeners
        if (this.boundHandlers) {
            window.removeEventListener('resize', this.boundHandlers.resize);
            
            if (this.dom.dockItemContainer) {
                this.dom.dockItemContainer.removeEventListener('wheel', this.boundHandlers.wheel);
                this.dom.dockItemContainer.removeEventListener('mouseover', this.boundHandlers.mouseover);
                this.dom.dockItemContainer.removeEventListener('mouseout', this.boundHandlers.mouseout);
                this.dom.dockItemContainer.removeEventListener('click', this.eventHandlers.dockItemClick);
                this.dom.dockItemContainer.removeEventListener('mousedown', this.eventHandlers.dockItemMousedown);
            }
            
            if (this.dom.dropdownContainer) {
                this.dom.dropdownContainer.removeEventListener('mouseover', this.boundHandlers.dropdownMouseover);
                this.dom.dropdownContainer.removeEventListener('mouseout', this.boundHandlers.dropdownMouseout);
            }
        }
        
        if (this.eventHandlers) {
            if (this.dom.dock) {
                this.dom.dock.removeEventListener('mouseover', this.eventHandlers.dockMouseover);
                this.dom.dock.removeEventListener('mouseleave', this.eventHandlers.dockMouseleave);
            }
            
            if (this.dom.upButton) {
                this.dom.upButton.removeEventListener('click', this.eventHandlers.upButton);
            }
            
            if (this.dom.downButton) {
                this.dom.downButton.removeEventListener('click', this.eventHandlers.downButton);
            }
            
            if (this.dom.closeButton) {
                this.dom.closeButton.removeEventListener('click', this.eventHandlers.closeButton);
            }
            
            document.removeEventListener('mousemove', this.eventHandlers.documentMousemove);
        }
    
        // Clear all items with proper cleanup
        for (const domain in this.dockItems) {
            if (this.dockItems[domain]) {
                this.dockItems[domain].destroy();
            }
        }
        
        // Remove DOM elements
        if (this.dom.dock) {
            const shadow = this.dom.dock.shadowRoot;
            if (shadow) {
                shadow.innerHTML = '';
            }
            this.dom.dock.remove();
        }
    
        // Clear all references for garbage collection
        this.dockItems = null;
        this.dom = null;
        this.state = null;
        this.browser = null;
        this.windowId = null;
        this.eventHandlers = null;
        this.boundHandlers = null;
    }
}

export default Dock;