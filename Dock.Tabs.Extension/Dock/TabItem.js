import { api } from '../browser-api.js';

class TabItem {
    constructor(tab, parent) {
        this.#initialize(tab, parent);
    }

    #initialize(tab, parent) {
        this.tab = tab;
        this.parent = parent;

        this.#createTabElement();
    }

    #createTabElement() {
        this.dom = {
            tabItem: null,
            text: null
        };
        this.dom.tabItem = document.createElement('div');
        this.dom.tabItem.className = 'tab-item';
        this.dom.tabItem.dataset.tabId = this.tab.id;

        const fragment = document.createDocumentFragment();

        this.dom.text = document.createElement('span');
        this.dom.text.className = 'tab-item-text';
        this.dom.text.textContent = this.tab.title;
        fragment.appendChild(this.dom.text);

        const closeButtonContainer = document.createElement('div');
        closeButtonContainer.className = 'close-button-container button-container';

        const closeButton = document.createElement('img');
        closeButton.classList.add('close-button-icon');
        closeButton.src = api.runtime.getURL("images/icons8-close.svg");
        closeButton.alt = 'Close tab';
        closeButtonContainer.appendChild(closeButton);
        fragment.appendChild(closeButtonContainer);

        this.dom.tabItem.appendChild(fragment);
    }

    update(tab) {
        this.tab = tab;
        if (this.dom.text.textContent !== tab.title) {
            this.dom.text.textContent = tab.title;
        }
    }

    remove() {
        this.dom.tabItem.remove();
    }
}

export default TabItem;
