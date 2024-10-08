class Background {
  constructor() {
    if (typeof browser === "undefined") {
      this.browser = chrome;
    }
    else {
      this.browser = browser;
    }

    this.#initialize();
  }

  async #initialize() {
    this.#initializeTabs();
    this.#registerEvents();
  }

  #initializeTabs() {
    this.tabData = [];
    this.browser.tabs.query({}).then((tabs) => {
      tabs.forEach(tab => {
        this.#updateTab(tab);
      });
    }).then(() => {
      this.#saveTabData();
    });
  }

  #registerEvents() {
    this.browser.storage.local.get('tabData', (data) => {
      if (data.tabData) {
        this.tabData = data.tabData;
      }
    });

    this.browser.tabs.onCreated.addListener((tab) => this.#updateTab(tab));
    this.browser.tabs.onRemoved.addListener((tabId) => this.#removeTab(tabId));
    this.browser.tabs.onUpdated.addListener((tabId, info, tab) => this.#onTabUpdated(tabId, info, tab));
    this.browser.runtime.onMessage.addListener((message) => this.#onMessageReceived(message));
  }

  #onTabUpdated(tabId, info, tab) {
    if (info.status === 'complete') {
      this.#updateTab(tab);
    }
  }

  #updateTabOrder(newOrder) {
    // Reorder this.tabData based on newOrder
    const orderedTabData = newOrder.map(item => {
      const domainData = this.tabData.find(d => d.domain === item.domain);
      if (domainData) {
        // Reorder tabs within the domain
        const orderedTabs = item.tabIds.map(id => domainData.tabs.find(t => t.id === id)).filter(Boolean);
        return { ...domainData, tabs: orderedTabs };
      }
      return null;
    }).filter(Boolean);

    this.tabData = orderedTabData;
    this.#saveTabData();
  }

  #onMessageReceived(message) {
    switch (message.action) {
      case 'focusTab':
        this.browser.tabs.update(message.tabId, { active: true });
        this.browser.tabs.sendMessage(message.tabId, { action: 'expandDock' });
        break;
      case 'openTab':
        this.browser.tabs.create({ url: message.tabUri, active: false });
        break;
      case 'closeTab':
        this.browser.tabs.remove(message.tabId);
        break;
      case 'openAndNavigateToTab':
        this.browser.tabs.create({ url: message.tabUri, active: true });
        break;
      case 'updateTabOrder':
        this.#updateTabOrder(message.newOrder);
        break;
    }
  }

  #getFaviconURL(u) {
    let favIconUrl = new URL(this.browser.runtime.getURL("/_favicon/"));
    favIconUrl.searchParams.set("pageUrl", u);
    favIconUrl.searchParams.set("size", "32");
    fetch(favIconUrl.toString())
      .then(response => {
        if (response.ok && response.headers.get('Content-Type').startsWith('image/')) {
          // If successful, return the favicon URL
          return favIconUrl.toString();
        } else {
          // If unsuccessful, use the default favicon
          return this.browser.runtime.getURL("images/default_favicon.png");
        }
      })
      .catch(() => {
        // If there's an error (e.g., network error), use the default favicon
        return this.browser.runtime.getURL("images/default_favicon.png");
      });
  }

  #removeTab(tabId) {
    for (const tabDataIndex in this.tabData) {
      const domainData = this.tabData[tabDataIndex];
      const correspondingTab = domainData.tabs.find(t => t.id == tabId);
      if (correspondingTab) {
        this.tabData[tabDataIndex].tabs.splice(domainData.tabs.indexOf(correspondingTab), 1);
      }
    }
    const dockToRemove = this.tabData.filter(t => t.tabs.length == 0);
    for (const dock in dockToRemove) {
      this.tabData.splice(this.tabData.indexOf(dock), 1);
    }
    this.#saveTabData();
  }

  #updateTab(tab) {
    if (tab && tab.url) {
      const domainIndex = this.tabData.findIndex(d => d.domain === new URL(tab.url).hostname);
      if (domainIndex !== -1) {
        const domainData = this.tabData[domainIndex];
        const tabIndex = domainData.tabs.findIndex(t => t.id === tab.id);
        if (tabIndex === -1) {
          // If it's a new tab, add it to the end of the domain's tab list
          domainData.tabs.push({
            id: tab.id,
            url: tab.url,
            title: tab.title,
            favicon: tab.favIconUrl || this.#getFaviconURL(tab.url)
          });
        }
        else {
          domainData.url = tab.url;
          domainData.title = tab.title;
          domainData.favicon = tab.favIconUrl || this.#getFaviconURL(tab.url)
        }
      } else {
        // If it's a new domain
        // Remove the old tab and maybe its domain
        this.#removeTab(tab.id);
        // add it to the end of tabData
        this.tabData.push({
          domain: new URL(tab.url).hostname,
          tabs: [{
            id: tab.id,
            url: tab.url,
            title: tab.title,
            favicon: tab.favIconUrl || this.#getFaviconURL(tab.url)
          }]
        });
      }
      this.#saveTabData();
    }
  }

  #saveTabData() {
    this.browser.storage.local.set({ tabData: this.tabData });
  }
}

const background = new Background();