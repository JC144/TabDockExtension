class Background {
  #updateTimeout;

  constructor() {
    if (typeof browser === "undefined") {
      this.browser = chrome;
    }
    else {
      this.browser = browser;
    }

    this.windowTabData = new Map();
    this.#initialize();
  }

  async #initialize() {
    await this.#initializeWindows();
    this.#registerEvents();
  }

  async #initializeWindows() {
    const windows = await this.browser.windows.getAll();

    for (const window of windows) {
      const tabs = await this.browser.tabs.query({ windowId: window.id });
      this.windowTabData.set(window.id, []);

      tabs.forEach(tab => {
        this.#updateTab(tab);
      });

      // Send window ID to content script when it's injected
      this.browser.tabs.sendMessage(tabs[0]?.id, {
        action: 'setWindowId',
        windowId: window.id
      }).catch(() => {
        // Ignore errors - content script might not be ready yet
      });
    }

    this.#saveTabData();
  }

  #registerEvents() {
    // Tab events
    this.browser.tabs.onCreated.addListener((tab) => this.#updateTab(tab));
    this.browser.tabs.onRemoved.addListener((tabId, removeInfo) => this.#removeTab(tabId, removeInfo.windowId));
    this.browser.tabs.onUpdated.addListener((tabId, info, tab) => this.#onTabUpdated(tabId, info, tab));
    this.browser.tabs.onAttached.addListener((tabId, attachInfo) => this.#handleTabAttached(tabId, attachInfo));

    // Window events
    this.browser.windows.onCreated.addListener((window) => this.#handleNewWindow(window));
    this.browser.windows.onRemoved.addListener((windowId) => this.#handleWindowRemoved(windowId));

    this.browser.runtime.onMessage.addListener(this.#onMessageReceived);
  }

  async #handleTabAttached(tabId, attachInfo) {
    // When a tab is moved to a different window
    const tab = await this.browser.tabs.get(tabId);

    // Remove from old window
    this.#removeTab(tabId, attachInfo.oldWindowId);

    // Add to new window
    this.#updateTab(tab);

    // Notify the content script about the window change
    try {
      await this.browser.tabs.sendMessage(tabId, {
        action: 'windowChanged',
        windowId: attachInfo.newWindowId
      });
    } catch (error) {
      // Content script might not be ready, that's ok
      console.log('Could not notify content script of window change:', error);
    }
  }

  #handleTabDetached(tabId, detachInfo) {
    // Remove the tab from its old window
    this.#removeTab(tabId, detachInfo.oldWindowId);
  }

  #handleNewWindow(window) {
    // Initialize empty tab data for new window
    this.windowTabData.set(window.id, []);
    this.#saveTabData();
  }

  #handleWindowRemoved(windowId) {
    // Remove tab data for closed window
    this.windowTabData.delete(windowId);
    this.#saveTabData();
  }

  #onTabUpdated(tabId, info, tab) {
    if (info.status === 'complete') {
      this.#updateTab(tab);
    }
  }

  #updateTabOrder(windowId, newOrder) {
    const windowTabs = this.windowTabData.get(windowId);
    if (!windowTabs) return;

    // Reorder tabs based on newOrder
    const orderedTabData = newOrder.map(item => {
      const domainData = windowTabs.find(d => d.domain === item.domain);
      if (domainData) {
        const orderedTabs = item.tabIds.map(id => domainData.tabs.find(t => t.id === id)).filter(Boolean);
        return { ...domainData, tabs: orderedTabs };
      }
      return null;
    }).filter(Boolean);

    this.windowTabData.set(windowId, orderedTabData);
    this.#debouncedSaveTabData();
  }

  #onMessageReceived(message, sender, sendResponse) {
    switch (message.action) {
      case 'getWindowId':
        if (sender) {
          sendResponse({ windowId: sender.tab.windowId });
        }
        break;
      case 'focusTab':
        this.browser.tabs.update(message.tabId, { active: true });
        this.browser.tabs.sendMessage(message.tabId, { action: 'expandDock' });
        break;
      case 'openTab':
        this.browser.tabs.create({
          url: message.tabUri,
          active: false,
          windowId: message.windowId
        });
        break;
      case 'closeTab':
        this.browser.tabs.remove(message.tabId);
        break;
      case 'openAndNavigateToTab':
        this.browser.tabs.create({
          url: message.tabUri,
          active: true,
          windowId: message.windowId
        });
        break;
      case 'updateTabOrder':
        this.#updateTabOrder(message.windowId, message.newOrder);
        break;
    }
  }

  #removeTab(tabId, windowId) {
    const windowTabs = this.windowTabData.get(windowId);
    if (!windowTabs) return;

    for (const domainData of windowTabs) {
      const tabIndex = domainData.tabs.findIndex(t => t.id === tabId);
      if (tabIndex !== -1) {
        domainData.tabs.splice(tabIndex, 1);
        if (domainData.tabs.length === 0) {
          // Remove the domain if it has no more tabs
          const domainIndex = windowTabs.indexOf(domainData);
          windowTabs.splice(domainIndex, 1);
        }
        break;
      }
    }

    this.#debouncedSaveTabData();
  }

  #updateTab(tab) {
    if (!tab?.url || !tab.windowId) return;

    let windowTabs = this.windowTabData.get(tab.windowId);
    if (!windowTabs) {
      windowTabs = [];
      this.windowTabData.set(tab.windowId, windowTabs);
    }

    const domain = new URL(tab.url).hostname;
    let domainData = windowTabs.find(d => d.domain === domain);

    if (!domainData) {
      // New domain for this window
      domainData = {
        domain: domain,
        tabs: []
      };
      windowTabs.push(domainData);
    }

    const tabData = {
      id: tab.id,
      url: tab.url,
      title: tab.title,
      favicon: tab.favIconUrl || this.#getFaviconURL(tab.url)
    };

    const existingTabIndex = domainData.tabs.findIndex(t => t.id === tab.id);
    if (existingTabIndex === -1) {
      domainData.tabs.push(tabData);
    } else {
      domainData.tabs[existingTabIndex] = tabData;
    }

    this.#debouncedSaveTabData();
  }

  #debouncedSaveTabData() {
    clearTimeout(this.#updateTimeout);
    this.#updateTimeout = setTimeout(() => {
      this.#saveTabData();
    }, 1000);
  }

  #saveTabData() {
    // Convert Map to object for storage
    const tabDataObject = {};
    for (const [windowId, tabs] of this.windowTabData.entries()) {
      tabDataObject[windowId] = tabs;
    }
    this.browser.storage.local.set({ tabData: tabDataObject });
  }

  #getFaviconURL(u) {
    let favIconUrl = new URL(this.browser.runtime.getURL("/_favicon/"));
    favIconUrl.searchParams.set("pageUrl", u);
    favIconUrl.searchParams.set("size", "32");
    return fetch(favIconUrl.toString())
      .then(response => {
        if (response.ok && response.headers.get('Content-Type').startsWith('image/')) {
          return favIconUrl.toString();
        } else {
          return this.browser.runtime.getURL("images/default_favicon.png");
        }
      })
      .catch(() => {
        return this.browser.runtime.getURL("images/default_favicon.png");
      });
  }
}

const background = new Background();