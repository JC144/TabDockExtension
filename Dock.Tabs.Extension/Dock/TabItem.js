class TabItem {
    constructor(tab, parent) {        
        this.#initialize(tab, parent);
    }

    #initialize(tab, parent) {
        this.tab = tab;
        this.parent = parent;
        if (this.browser === undefined) {
            this.browser = chrome;
          }
          else {
            this.browser = this.browser;
          }

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
        closeButtonContainer.appendChild(closeButton);
        fragment.appendChild(closeButtonContainer);

        this.dom.tabItem.appendChild(fragment);

        this.dom.tabItem.setAttribute('draggable', true);
    }

    onMove(onTabMoved) {
        this.dom.tabItem.addEventListener('drop', onTabMoved);
    }

    onDragStart(onDragStarted) {
        this.dom.tabItem.addEventListener('dragstart', onDragStarted);
    }

    onDragEnd(onDragEnded) {
        this.dom.tabItem.addEventListener('dragend', onDragEnded);
    }

    remove() {
        this.dom.tabItem.remove();
    }
}

export default TabItem;