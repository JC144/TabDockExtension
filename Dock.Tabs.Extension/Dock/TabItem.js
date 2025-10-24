class TabItem {
    constructor(tab, parent) {
        this.#initialize(tab, parent);
    }

    #initialize(tab, parent) {
        this.tab = tab;
        this.parent = parent;
        if (typeof browser === "undefined") {
            this.browser = chrome;
        }
        else {
            this.browser = browser;
        }

        // Store event handlers for cleanup
        this.eventHandlers = {
            drop: null,
            dragstart: null,
            dragend: null,
            dragover: null,
            dragenter: null
        };

        this.#createTabElement();
    }

    #createTabElement() {
        this.dom = {
            tabItem: null
        };
        this.dom.tabItem = document.createElement('div');
        this.dom.tabItem.className = 'tab-item';
        this.dom.tabItem.dataset.tabId = this.tab.id;

        const fragment = document.createDocumentFragment();

        const tabItemText = document.createElement('span');
        tabItemText.className = 'tab-item-text';
        tabItemText.textContent = this.tab.title;
        fragment.appendChild(tabItemText);

        const closeButtonContainer = document.createElement('div');
        closeButtonContainer.className = 'close-button-container button-container';

        const closeButton = document.createElement('img');
        closeButton.classList.add('close-button-icon');
        closeButton.src = this.browser.runtime.getURL("images/icons8-close.svg");
        closeButton.alt = 'Close tab';
        closeButton.loading = 'lazy'; // Add lazy loading
        closeButtonContainer.appendChild(closeButton);
        fragment.appendChild(closeButtonContainer);

        this.dom.tabItem.appendChild(fragment);

        this.dom.tabItem.setAttribute('draggable', true);
    }

    onMove(onTabMoved) {
        this.eventHandlers.drop = onTabMoved;
        this.dom.tabItem.addEventListener('drop', this.eventHandlers.drop);
    }

    onDragStart(onDragStarted) {
        this.eventHandlers.dragstart = onDragStarted;
        this.dom.tabItem.addEventListener('dragstart', this.eventHandlers.dragstart);
    }

    onDragEnd(onDragEnded) {
        this.eventHandlers.dragend = onDragEnded;
        this.dom.tabItem.addEventListener('dragend', this.eventHandlers.dragend);
    }

    onDragOver(onDragOver) {
        this.eventHandlers.dragover = onDragOver;
        this.dom.tabItem.addEventListener('dragover', this.eventHandlers.dragover);
    }

    onDragEnter(onDragEnter) {
        this.eventHandlers.dragenter = onDragEnter;
        this.dom.tabItem.addEventListener('dragenter', this.eventHandlers.dragenter);
    }

    remove() {
        // Remove event listeners
        if (this.dom.tabItem) {
            if (this.eventHandlers.drop) {
                this.dom.tabItem.removeEventListener('drop', this.eventHandlers.drop);
            }
            if (this.eventHandlers.dragstart) {
                this.dom.tabItem.removeEventListener('dragstart', this.eventHandlers.dragstart);
            }
            if (this.eventHandlers.dragend) {
                this.dom.tabItem.removeEventListener('dragend', this.eventHandlers.dragend);
            }
            if (this.eventHandlers.dragover) {
                this.dom.tabItem.removeEventListener('dragover', this.eventHandlers.dragover);
            }
            if (this.eventHandlers.dragenter) {
                this.dom.tabItem.removeEventListener('dragenter', this.eventHandlers.dragenter);
            }
            
            this.dom.tabItem.remove();
        }
        
        // Clear references
        this.dom = null;
        this.eventHandlers = null;
        this.tab = null;
        this.parent = null;
        this.browser = null;
    }
    
    // Add destroy alias for consistency
    destroy() {
        this.remove();
    }
}

export default TabItem;