class FaviconCache {
  constructor(maxSize = 50) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.browser = typeof browser === "undefined" ? chrome : browser;
  }

  async getFavicon(url) {
    const domain = new URL(url).hostname;
    
    if (!this.cache.has(domain)) {
      const favicon = await this.#fetchFavicon(url);
      this.#addToCache(domain, favicon);
    }
    
    return this.cache.get(domain);
  }

  #addToCache(domain, favicon) {
    // Implement LRU cache
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(domain, favicon);
  }

  async #fetchFavicon(url) {
    let favIconUrl = new URL(this.browser.runtime.getURL("/_favicon/"));
    favIconUrl.searchParams.set("pageUrl", url);
    favIconUrl.searchParams.set("size", "32");
    
    try {
      const response = await fetch(favIconUrl.toString());
      if (response.ok && response.headers.get('Content-Type')?.startsWith('image/')) {
        return favIconUrl.toString();
      }
    } catch (error) {
      console.error('Failed to fetch favicon:', error);
    }
    
    return this.browser.runtime.getURL("images/default_favicon.png");
  }

  clear() {
    this.cache.clear();
  }
}

class Background {
  #updateTimeout;
  #faviconCache;
  #cleanupInterval;

  constructor() {
    if (typeof browser === "undefined") {
      this.browser = chrome;
    }
    else {
      this.browser = browser;
    }

    this.windowTabData = new Map();
    this.#faviconCache = new FaviconCache();
    this.#initialize();
    
    // Periodic cleanup every 5 minutes
    this.#cleanupInterval = setInterval(() => {
      this.#performCleanup();
    }, 5 * 60 * 1000);
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

      // Process tabs in batches to avoid blocking
      const batchSize = 10;
      for (let i = 0; i < tabs.length; i += batchSize) {
        const batch = tabs.slice(i, i + batchSize);
        await Promise.all(batch.map(tab => this.#updateTab(tab)));
      }

      // Send window ID to content script when it's injected
      if (tabs[0]?.id) {
        this.browser.tabs.sendMessage(tabs[0].id, {
          action: 'setWindowId',
          windowId: window.id
        }).catch(() => {
          // Ignore errors - content script might not be ready yet
        });
      }
    }

    this.#saveTabData();
  }

  #registerEvents() {
    // Tab events
    this.browser.tabs.onCreated.addListener(async (tab) => await this.#updateTab(tab));
    this.browser.tabs.onRemoved.addListener((tabId, removeInfo) => this.#removeTab(tabId, removeInfo.windowId));
    this.browser.tabs.onUpdated.addListener(async(tabId, info, tab) => await this.#onTabUpdated(tabId, info, tab));
    this.browser.tabs.onAttached.addListener((tabId, attachInfo) => this.#handleTabAttached(tabId, attachInfo));
    this.browser.tabs.onDetached.addListener((tabId, detachInfo) => this.#handleTabDetached(tabId, detachInfo));

    // Window events
    this.browser.windows.onCreated.addListener((window) => this.#handleNewWindow(window));
    this.browser.windows.onRemoved.addListener((windowId) => this.#handleWindowRemoved(windowId));

    this.browser.runtime.onMessage.addListener(this.#onMessageReceived.bind(this));
  }

  async #handleTabAttached(tabId, attachInfo) {
    const tab = await this.browser.tabs.get(tabId);
    const domain = new URL(tab.url).hostname;

    // Remove from old window
    const oldWindowTabs = this.windowTabData.get(attachInfo.oldWindowId);
    if (oldWindowTabs) {
      const domainData = oldWindowTabs.find(d => d.domain === domain);
      if (domainData) {
        domainData.tabs = domainData.tabs.filter(t => t.id !== tabId);
        
        if (domainData.tabs.length === 0) {
          const domainIndex = oldWindowTabs.indexOf(domainData);
          oldWindowTabs.splice(domainIndex, 1);
        }
      }
    }

    // Add to new window
    await this.#updateTab(tab);
    this.#saveTabData();

    // Notify content script
    try {
      await this.browser.tabs.sendMessage(tabId, {
        action: 'windowChanged',
        windowId: attachInfo.newWindowId
      });
    } catch (error) {
      // Ignore errors
    }
  }

  #handleTabDetached(tabId, detachInfo) {
    const oldWindowTabs = this.windowTabData.get(detachInfo.oldWindowId);
    if (oldWindowTabs) {
      for (const domainData of oldWindowTabs) {
        const tabIndex = domainData.tabs.findIndex(t => t.id === tabId);
        if (tabIndex !== -1) {
          domainData.tabs.splice(tabIndex, 1);
          
          if (domainData.tabs.length === 0) {
            const domainIndex = oldWindowTabs.indexOf(domainData);
            oldWindowTabs.splice(domainIndex, 1);
          }
          break;
        }
      }
      
      this.#saveTabData();
    }
  }

  #handleNewWindow(window) {
    this.windowTabData.set(window.id, []);
    this.#saveTabData();
  }

  #handleWindowRemoved(windowId) {
    this.windowTabData.delete(windowId);
    this.#saveTabData();
  }

  async #onTabUpdated(tabId, info, tab) {
    // Only update on significant changes
    if (info.status === 'complete' || info.url || info.title) {
      await this.#updateTab(tab);
    }
  }

  #updateTabOrder(windowId, newOrder) {
    const windowTabs = this.windowTabData.get(windowId);
    if (!windowTabs) return;

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
          const domainIndex = windowTabs.indexOf(domainData);
          windowTabs.splice(domainIndex, 1);
        }
        break;
      }
    }

    this.#debouncedSaveTabData();
  }

  async #updateTab(tab) {
    if (!tab?.url || !tab.windowId) return;

    let windowTabs = this.windowTabData.get(tab.windowId);
    if (!windowTabs) {
      windowTabs = [];
      this.windowTabData.set(tab.windowId, windowTabs);
    }

    const domain = new URL(tab.url).hostname;
    let domainData = windowTabs.find(d => d.domain === domain);

    if (!domainData) {
      domainData = {
        domain: domain,
        tabs: []
      };
      windowTabs.push(domainData);
    }

    // Use cached favicon or get new one
    const faviconUrl = tab.favIconUrl || await this.#faviconCache.getFavicon(tab.url);

    // Store minimal data
    const tabData = {
      id: tab.id,
      url: tab.url,
      title: tab.title ? tab.title.substring(0, 100) : '', // Limit title length
      favicon: faviconUrl
    };

    const existingTabIndex = domainData.tabs.findIndex(t => t.id === tab.id);
    if (existingTabIndex === -1) {
      domainData.tabs.push(tabData);
    } else {
      // Keep old favicon if new one isn't available
      if (!tabData.favicon) {
        tabData.favicon = domainData.tabs[existingTabIndex].favicon;
      }
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
      // Only save windows that have tabs
      if (tabs.length > 0) {
        // Create a minimal copy for storage
        tabDataObject[windowId] = tabs.map(domainData => ({
          domain: domainData.domain,
          tabs: domainData.tabs.map(tab => ({
            id: tab.id,
            url: tab.url,
            title: tab.title,
            favicon: tab.favicon
          }))
        }));
      }
    }
    
    // Use local storage with size check
    this.browser.storage.local.set({ tabData: tabDataObject }, () => {
      if (this.browser.runtime.lastError) {
        console.error('Storage error:', this.browser.runtime.lastError);
        // Clear cache and retry if storage fails
        this.#performCleanup();
        this.browser.storage.local.set({ tabData: tabDataObject });
      }
    });
  }

  #performCleanup() {
    // Clean up closed windows
    this.browser.windows.getAll().then(windows => {
      const windowIds = new Set(windows.map(w => w.id));
      for (const [windowId] of this.windowTabData) {
        if (!windowIds.has(windowId)) {
          this.windowTabData.delete(windowId);
        }
      }
    });

    // Clear favicon cache periodically
    if (this.#faviconCache.cache.size > 40) {
      this.#faviconCache.clear();
    }

    // Verify tab data integrity
    for (const [windowId, tabs] of this.windowTabData) {
      // Remove any invalid entries
      const validTabs = tabs.filter(domainData => 
        domainData.domain && domainData.tabs && domainData.tabs.length > 0
      );
      this.windowTabData.set(windowId, validTabs);
    }
  }

  destroy() {
    if (this.#cleanupInterval) {
      clearInterval(this.#cleanupInterval);
    }
    if (this.#updateTimeout) {
      clearTimeout(this.#updateTimeout);
    }
    this.#faviconCache.clear();
    this.windowTabData.clear();
  }
}

const background = new Background();