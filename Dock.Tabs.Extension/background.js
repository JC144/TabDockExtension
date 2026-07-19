// background.js is not a module (MV2 background page), so the browser-api.js shim is duplicated here.
const api = (typeof browser !== 'undefined') ? browser : chrome;
const isMV3 = api.runtime.getManifest().manifest_version === 3;

class Background {
  #saveTimer = null;
  // Firefox only: source URL -> Promise<data: URL | null>, one fetch per icon
  // per session. Rebuilt empty on every background restart.
  #faviconCache = new Map();
  // Firefox only: favicons already resolved in a previous session, restored by
  // domain when #reconcile re-creates the domain entries.
  #storedFavicons = new Map();

  constructor() {
    this.tabData = [];
    // MV3 service workers must register their listeners synchronously in the
    // first event-loop turn, or the event that woke the worker is dropped.
    // Handlers await this.ready so they run against the reconciled tabData.
    this.ready = this.#initialize();
    this.#registerEvents();
  }

  async #initialize() {
    let storedTabData = [];
    try {
      const data = await api.storage.local.get('tabData');
      if (Array.isArray(data.tabData)) {
        storedTabData = data.tabData;
      }
    } catch (e) {
      // Corrupt or unreadable storage: start from the live tabs only.
    }

    const liveTabs = await api.tabs.query({});
    this.#reconcile(storedTabData, liveTabs);
    this.#saveTabData();
  }

  // Rebuild tabData from the live tabs while preserving the stored domain order
  // and intra-domain tab order. Tab ids change across browser restarts, so stored
  // tabs are re-matched by id first, then by url. Also migrates the old schema
  // (per-tab favicon, possibly a large data: URI) to the per-domain one.
  #reconcile(storedTabData, liveTabs) {
    // Only data: values are restorable (the old schema stored raw http URLs,
    // which must be re-resolved); faviconSource is needed to detect staleness.
    for (const domainData of storedTabData) {
      if (domainData && typeof domainData.favicon === 'string'
        && domainData.favicon.startsWith('data:') && domainData.faviconSource) {
        this.#storedFavicons.set(domainData.domain, { favicon: domainData.favicon, faviconSource: domainData.faviconSource });
      }
    }

    const unclaimed = liveTabs.filter(t => t && t.url);
    const claim = (predicate) => {
      const index = unclaimed.findIndex(predicate);
      return index === -1 ? null : unclaimed.splice(index, 1)[0];
    };

    for (const domainData of storedTabData) {
      if (!domainData || !Array.isArray(domainData.tabs)) continue;
      for (const storedTab of domainData.tabs) {
        const liveTab = claim(t => t.id === storedTab.id && this.#getHostname(t.url) === domainData.domain)
          || claim(t => t.url === storedTab.url);
        if (liveTab) {
          this.#upsertTab(liveTab);
        }
      }
    }

    for (const liveTab of [...unclaimed]) {
      this.#upsertTab(liveTab);
    }
  }

  #registerEvents() {
    // The listeners return undefined (not a promise) so the message channel is
    // never mistaken for a pending response; the work is queued behind init.
    api.tabs.onCreated.addListener((tab) => { this.ready.then(() => this.#upsertTab(tab)); });
    api.tabs.onRemoved.addListener((tabId) => { this.ready.then(() => this.#removeTab(tabId)); });
    api.tabs.onUpdated.addListener((tabId, info, tab) => { this.ready.then(() => this.#onTabUpdated(tabId, info, tab)); });
    // A tab dragged to another window fires onAttached (not onUpdated), so the
    // stored windowId must be refreshed from the live tab. The tab's content
    // script cached its windowId at load, so it must be told about the move
    // (it may not be injected on that page: ignore the send error).
    api.tabs.onAttached.addListener((tabId, attachInfo) => {
      this.ready.then(() => api.tabs.get(tabId).then(tab => this.#upsertTab(tab)).catch(() => {}));
      api.tabs.sendMessage(tabId, { action: 'windowChanged', windowId: attachInfo.newWindowId }).catch(() => {});
    });
    api.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.action === 'getWindowId') {
        // Answered synchronously; the channel is not kept open.
        sendResponse({ windowId: sender.tab ? sender.tab.windowId : undefined });
        return;
      }
      this.ready.then(() => this.#onMessageReceived(message));
    });
  }

  #onTabUpdated(tabId, info, tab) {
    // Firefox often reports favIconUrl in a separate event after 'complete',
    // so a favicon arrival must also trigger an upsert. Title changes arrive
    // on their own too (SPAs updating document.title long after 'complete').
    if (info.status === 'complete' || info.favIconUrl || info.title) {
      this.#upsertTab(tab);
    }
  }

  // Merge, don't replace: newOrder comes from one window's dock and only covers
  // the domains/tabs visible there. Mentioned entries are reordered within the
  // slots they already occupy; everything else keeps its position.
  #updateTabOrder(newOrder) {
    const orderedDomains = newOrder
      .map(item => this.tabData.find(d => d.domain === item.domain))
      .filter(Boolean);
    const mentionedDomains = new Set(orderedDomains.map(d => d.domain));
    let domainSlot = 0;
    this.tabData = this.tabData.map(d => mentionedDomains.has(d.domain) ? orderedDomains[domainSlot++] : d);

    for (const item of newOrder) {
      const domainData = this.tabData.find(d => d.domain === item.domain);
      if (!domainData) continue;
      const orderedTabs = item.tabIds
        .map(id => domainData.tabs.find(t => t.id === id))
        .filter(Boolean);
      const mentionedIds = new Set(orderedTabs.map(t => t.id));
      let tabSlot = 0;
      domainData.tabs = domainData.tabs.map(t => mentionedIds.has(t.id) ? orderedTabs[tabSlot++] : t);
    }

    this.#saveTabData();
  }

  #onMessageReceived(message) {
    switch (message.action) {
      case 'focusTab':
        // Also focus the window: the tab may live in another one (the dock
        // shows every window's tabs when the content script's windowId is unknown).
        api.tabs.update(message.tabId, { active: true })
          .then(tab => api.windows.update(tab.windowId, { focused: true }))
          .catch(() => {});
        api.tabs.sendMessage(message.tabId, { action: 'expandDock' });
        break;
      case 'openTab':
        api.tabs.create({ url: message.tabUri, active: false });
        break;
      case 'closeTab':
        api.tabs.remove(message.tabId);
        break;
      case 'openAndNavigateToTab':
        api.tabs.create({ url: message.tabUri, active: true });
        break;
      case 'updateTabOrder':
        this.#updateTabOrder(message.newOrder);
        break;
    }
  }

  #getHostname(url) {
    try {
      return new URL(url).hostname;
    } catch (e) {
      return null;
    }
  }

  #getFaviconURL(u, version) {
    let favIconUrl = new URL(api.runtime.getURL("/_favicon/"));
    favIconUrl.searchParams.set("pageUrl", u);
    favIconUrl.searchParams.set("size", "32");
    // Ignored by the _favicon endpoint; only there to make the URL string
    // differ so the dock <img> refetches (see #applyDomainFavicon).
    if (version) favIconUrl.searchParams.set("v", version);

    return favIconUrl.toString();
  }

  // One favicon per domain. On Chrome the _favicon endpoint gives a ~120-byte URL
  // that also bypasses the host pages' CSP. Firefox has no _favicon endpoint and
  // pages' CSP applies to content-script <img> loads, so the background fetches
  // the icon itself (host permissions bypass CSP/CORS here) and stores a small
  // 32x32 PNG data: URL that the dock draws onto a canvas.
  #applyDomainFavicon(domainData, tab) {
    if (isMV3) {
      // _favicon serves the default globe until Chrome has downloaded the
      // site's real icon, and the recomputed URL is byte-identical after the
      // later favIconUrl onUpdated event, so the dock's <img> would never
      // refetch. Bump a version when the tab's favIconUrl changes to force it.
      if (!domainData.favicon || domainData.faviconSource !== tab.favIconUrl) {
        domainData.faviconSource = tab.favIconUrl;
        domainData.faviconVersion = (domainData.faviconVersion || 0) + 1;
      }
      domainData.favicon = this.#getFaviconURL(tab.url, domainData.faviconVersion);
      return;
    }
    if (!tab.favIconUrl) return;
    if (domainData.faviconSource === tab.favIconUrl && domainData.favicon) return;
    domainData.faviconSource = tab.favIconUrl;
    this.#resolveFavicon(tab.favIconUrl).then(dataUrl => {
      // The domain may have been removed or its source superseded meanwhile.
      const live = this.tabData.find(d => d.domain === domainData.domain);
      if (!live || live.faviconSource !== tab.favIconUrl) return;
      live.favicon = dataUrl; // null falls back to the default icon in the UI
      this.#saveTabData();
    });
  }

  #resolveFavicon(source) {
    let promise = this.#faviconCache.get(source);
    if (!promise) {
      promise = this.#rasterize(source).catch(() => null);
      this.#faviconCache.set(source, promise);
    }
    return promise;
  }

  // Normalizes any favicon (ico/svg/oversized data: URI) into a 32x32 PNG the
  // content script can always decode. Image + DOM canvas require the persistent
  // MV2 background page; an MV3/event-page port must switch to
  // createImageBitmap + OffscreenCanvas.
  async #rasterize(source) {
    let objectUrl = null;
    try {
      let src = source;
      if (source.startsWith('data:')) {
        if (source.length > 1024 * 1024) return null;
      } else {
        const response = await fetch(source, { credentials: 'omit' });
        if (!response.ok) return null;
        const blob = await response.blob();
        if (blob.size > 512 * 1024) return null;
        objectUrl = URL.createObjectURL(blob);
        src = objectUrl;
      }
      const img = await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = reject;
        image.src = src;
      });
      const canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 32;
      canvas.getContext('2d').drawImage(img, 0, 0, 32, 32);
      return canvas.toDataURL('image/png');
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
  }

  #removeTab(tabId) {
    for (const domainData of this.tabData) {
      const tabIndex = domainData.tabs.findIndex(t => t.id === tabId);
      if (tabIndex !== -1) {
        domainData.tabs.splice(tabIndex, 1);
      }
    }
    this.tabData = this.tabData.filter(d => d.tabs.length !== 0);
    this.#saveTabData();
  }

  #upsertTab(tab) {
    if (!tab || !tab.url) return;
    const hostname = this.#getHostname(tab.url);
    if (!hostname) return;

    // A tab that navigated to another domain must leave its previous one.
    for (const domainData of this.tabData) {
      if (domainData.domain === hostname) continue;
      const tabIndex = domainData.tabs.findIndex(t => t.id === tab.id);
      if (tabIndex !== -1) {
        domainData.tabs.splice(tabIndex, 1);
      }
    }
    this.tabData = this.tabData.filter(d => d.tabs.length !== 0);

    let domainData = this.tabData.find(d => d.domain === hostname);
    if (!domainData) {
      // New domains go to the end of tabData
      domainData = { domain: hostname, favicon: null, tabs: [] };
      const stored = this.#storedFavicons.get(hostname);
      if (stored) {
        domainData.favicon = stored.favicon;
        domainData.faviconSource = stored.faviconSource;
      }
      this.tabData.push(domainData);
    }

    const existingTab = domainData.tabs.find(t => t.id === tab.id);
    if (existingTab) {
      existingTab.url = tab.url;
      existingTab.title = tab.title;
      existingTab.windowId = tab.windowId;
    } else {
      // New tabs go to the end of the domain's tab list
      domainData.tabs.push({ id: tab.id, url: tab.url, title: tab.title, windowId: tab.windowId });
    }

    // The dock shows the first tab's favicon for the whole domain; any tab may
    // supply it while the domain has none (favIconUrl timing varies per tab).
    if (domainData.tabs[0].id === tab.id || !domainData.favicon) {
      this.#applyDomainFavicon(domainData, tab);
    }

    this.#saveTabData();
  }

  // Trailing debounce: coalesces event bursts (e.g. every tab firing onUpdated at
  // browser startup) into a single storage write, i.e. one broadcast to all pages.
  #saveTabData() {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => {
      api.storage.local.set({ tabData: this.tabData });
    }, 150);
  }
}

const background = new Background();
