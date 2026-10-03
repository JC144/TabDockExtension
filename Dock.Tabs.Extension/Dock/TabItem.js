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

        // The title is never a text node: window.find() searches closed shadow
        // roots too, and its true/false answer lets the page spell out any
        // text in them. It sits in an attribute the page can't reach, and the
        // sheet paints it as generated content (.tab-item-text::before).
        this.dom.text = document.createElement('span');
        this.dom.text.className = 'tab-item-text';
        this.#setTitle(this.tab.title);
        fragment.appendChild(this.dom.text);

        const closeButtonContainer = document.createElement('div');
        closeButtonContainer.className = 'close-button-container button-container';

        // Inline SVG (cf. the trash zone in Dock.js): no extension URL to load,
        // and nothing the host page's CSP could block.
        closeButtonContainer.insertAdjacentHTML('beforeend',
            '<svg class="close-button-icon" role="img" aria-label="Close tab" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">'
            + '<path d="M4.707 3.293 3.293 4.707 10.586 12l-7.293 7.293 1.414 1.414L12 13.414l7.293 7.293 1.414-1.414L13.414 12l7.293-7.293-1.414-1.414L12 10.586z"/>'
            + '</svg>');
        fragment.appendChild(closeButtonContainer);

        this.dom.tabItem.appendChild(fragment);
    }

    #setTitle(title) {
        const text = typeof title === 'string' ? title : '';
        if (this.dom.text.dataset.title !== text) {
            this.dom.text.dataset.title = text;
        }
    }

    update(tab) {
        this.tab = tab;
        this.#setTitle(tab.title);
    }

    remove() {
        this.dom.tabItem.remove();
    }
}
