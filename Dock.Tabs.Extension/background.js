// background.js is not a module (MV2 background page), so the browser-api.js shim is duplicated here.
const api = (typeof browser !== 'undefined') ? browser : chrome;
const isMV3 = api.runtime.getManifest().manifest_version === 3;
// Session-scoped storage: survives MV3 service worker restarts, dies with the
// browser, and is not readable by content scripts (trusted contexts only by
// default). Only needed on MV3: the Firefox MV2 background page is persistent,
// so its in-memory state already lives as long as the browser session.
const sessionStore = isMV3 ? api.storage.session : null;
// Minimum delay (ms) between two tab openings requested by the same page.
const OPEN_TAB_INTERVAL = 1000;
// Same for tab closings and tab switches: faster than any series of real
// clicks, so only a page scripting the channel ever hits it.
const CLOSE_TAB_INTERVAL = 100;
const FOCUS_TAB_INTERVAL = 100;
// Upper bound on the domains + tab ids of one updateTabOrder message, far
// above any real window.
const MAX_ORDER_ENTRIES = 10000;
// Minimum delay (ms) between two title refreshes of the same tab: a page
// rewriting document.title in a loop re-renders the docks at most this often.
const TITLE_UPDATE_INTERVAL = 1000;
// Firefox favicon cache size, in domains (one 32x32 PNG each).
const FAVICON_CACHE_MAX = 256;

// What must survive a browser restart (domain order, dock edge) lives in
// IndexedDB: it belongs to the extension's origin, so unlike storage.local no
// content script (hence no compromised page) can read or write it. Opened per
// operation: writes are rare, and an MV3 service worker can die at any time.
function openSettingsDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('tabdock', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('settings');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readSettings() {
  const db = await openSettingsDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('settings');
      const store = tx.objectStore('settings');
      const domainOrder = store.get('domainOrder');
      const dockPosition = store.get('dockPosition');
      tx.oncomplete = () => resolve({ domainOrder: domainOrder.result, dockPosition: dockPosition.result });
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function writeSetting(key, value) {
  const db = await openSettingsDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction('settings', 'readwrite');
      tx.objectStore('settings').put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

class Background {
  #saveTimer = null;
  // Firefox only: domain -> Promise<data: URL | null>. The first icon a domain
  // resolves to is kept for the session: an animated favicon neither refetches
  // nor grows the cache. Failures are dropped so a later icon can retry.
  // Rebuilt empty on every background restart.
  #faviconCache = new Map();
  // Packaged path -> Promise<string | null>, served to the content scripts.
  #packagedFiles = new Map();
  // Chrome only, during #initialize: domain -> the favicon persisted in the
  // session, so a service worker restart doesn't refetch every icon.
  #faviconSeed = null;
  // windowId -> JSON of the view last pushed to that window's tabs, so a change
  // confined to one window never re-renders the docks of the others.
  #lastSent = new Map();
  #lastDomainOrder = null;
  // 'bottom' or 'top': the window edge every dock is anchored to
  #dockPosition = 'bottom';
  // Sender tab id -> { open, close, focus: time of its last action of that
  // kind }, see #allow.
  #lastActionAt = new Map();
  // Tab id -> pending title refresh timer / time of its last refresh, see
  // #scheduleTitleUpdate.
  #titleTimers = new Map();
  #lastTitleAt = new Map();

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
    let domainOrder = null;
    try {
      if (sessionStore) {
        const session = await sessionStore.get('tabData');
        if (Array.isArray(session.tabData)) {
          storedTabData = session.tabData;
        }
      }
    } catch (e) {
      // Corrupt or unreadable storage: start from the live tabs only.
    }
    try {
      const settings = await readSettings();
      if (Array.isArray(settings.domainOrder)) {
        domainOrder = settings.domainOrder;
        // Nothing to rewrite while the order still matches what's on disk.
        this.#lastDomainOrder = domainOrder.join('\n');
      }
      if (settings.dockPosition === 'top') {
        this.#dockPosition = 'top';
      }
    } catch (e) {
      // IndexedDB unavailable: default edge, and the order isn't restored.
    }

    const liveTabs = await api.tabs.query({});
    this.#faviconSeed = new Map(storedTabData
      .filter(d => d && typeof d.domain === 'string' && typeof d.favicon === 'string' && d.favicon.startsWith('data:image/png;base64,'))
      .map(d => [d.domain, d]));
    this.#reconcile(storedTabData, liveTabs);
    this.#faviconSeed = null;
    // Session data (same browser session, stable tab ids) already carries the
    // order; the on-disk domain order only matters after a browser restart.
    if (storedTabData.length === 0 && domainOrder) {
      this.#applyDomainOrder(domainOrder);
    }
    this.#saveTabData();
  }

  // Rebuild tabData from the live tabs while preserving the stored domain order
  // and intra-domain tab order. Stored tabs are re-matched by id first, then by
  // url as a fallback.
  #reconcile(storedTabData, liveTabs) {
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

  // Stable sort of the domains by their persisted rank; domains unknown to the
  // stored order (opened since) stay at the end in their current order.
  #applyDomainOrder(domainOrder) {
    const rank = new Map(domainOrder.map((domain, i) => [domain, i]));
    const known = this.tabData
      .filter(d => rank.has(d.domain))
      .sort((a, b) => rank.get(a.domain) - rank.get(b.domain));
    const unknown = this.tabData.filter(d => !rank.has(d.domain));
    this.tabData = [...known, ...unknown];
  }

  #registerEvents() {
    // Earlier versions kept the domain order and the dock edge in
    // storage.local, readable by every page: wipe what an update leaves behind.
    api.runtime.onInstalled.addListener(() => { api.storage.local.clear().catch(() => {}); });
    // The listeners return undefined (not a promise) so the message channel is
    // never mistaken for a pending response; the work is queued behind init.
    api.tabs.onCreated.addListener((tab) => { this.ready.then(() => this.#upsertTab(tab)); });
    api.tabs.onRemoved.addListener((tabId) => {
      this.#lastActionAt.delete(tabId);
      clearTimeout(this.#titleTimers.get(tabId));
      this.#titleTimers.delete(tabId);
      this.#lastTitleAt.delete(tabId);
      this.ready.then(() => this.#removeTab(tabId));
    });
    api.tabs.onUpdated.addListener((tabId, info, tab) => { this.ready.then(() => this.#onTabUpdated(tabId, info, tab)); });
    // A tab dragged to another window fires onAttached (not onUpdated), so the
    // stored windowId must be refreshed from the live tab. The broadcast that
    // follows pushes the right view to the moved tab and to both windows.
    api.tabs.onAttached.addListener((tabId) => {
      this.ready.then(() => api.tabs.get(tabId).then(tab => this.#upsertTab(tab)).catch(() => {}));
    });
    // Content scripts run in the page's renderer: every message is untrusted
    // input, and only the dock's own pages (sender.tab) may talk to us.
    api.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (sender.id !== api.runtime.id || !sender.tab || !message || typeof message !== 'object') return;
      if (message.action === 'getTabs') {
        // A page pulls its own window's view once at load; pushes cover the rest.
        const windowId = sender.tab.windowId;
        this.ready.then(() => sendResponse(this.#viewFor(windowId)));
        return true; // keep the channel open for the async response
      }
      if (message.action === 'getDockPosition') {
        this.ready.then(() => sendResponse(this.#dockPosition));
        return true;
      }
      // Packaged assets go through here rather than web_accessible_resources,
      // which would let any site probe for (and fingerprint) the extension.
      if (message.action === 'getStyles' || message.action === 'getDefaultFavicon') {
        const file = message.action === 'getStyles'
          ? this.#getPackagedFile('dock-styles.css')
          : this.#getPackagedFile('images/default_favicon.png', 'image/png');
        file.then(sendResponse);
        return true;
      }
      this.ready.then(() => this.#onMessageReceived(message, sender.tab));
    });
  }

  #onTabUpdated(tabId, info, tab) {
    // Firefox often reports favIconUrl in a separate event after 'complete',
    // so a favicon arrival must also trigger an upsert. Title changes arrive
    // on their own too (SPAs updating document.title long after 'complete'),
    // and are throttled per tab.
    if (info.status === 'complete' || info.favIconUrl) {
      this.#upsertTab(tab);
    } else if (info.title) {
      this.#scheduleTitleUpdate(tabId);
    }
  }

  // Leading + trailing throttle: the first title change applies at once, the
  // next ones at most every TITLE_UPDATE_INTERVAL, and the last one always
  // lands. The tab is re-read when the timer fires, so the latest title (and
  // url) wins rather than the snapshot of the event that armed it.
  #scheduleTitleUpdate(tabId) {
    if (this.#titleTimers.has(tabId)) return;
    const last = this.#lastTitleAt.get(tabId);
    const wait = last === undefined ? 0 : Math.max(0, last + TITLE_UPDATE_INTERVAL - Date.now());
    this.#titleTimers.set(tabId, setTimeout(() => {
      this.#titleTimers.delete(tabId);
      this.#lastTitleAt.set(tabId, Date.now());
      api.tabs.get(tabId).then(tab => this.#upsertTab(tab)).catch(() => {});
    }, wait));
  }

  // Merge, don't replace: newOrder comes from one window's dock and only covers
  // the domains/tabs visible there. Mentioned entries are reordered within the
  // slots they already occupy; everything else keeps its position. Entries the
  // window can't see (other windows' tabs, unknown ids) are ignored.
  #updateTabOrder(newOrder, windowId) {
    const orderedDomains = newOrder
      .map(item => this.tabData.find(d => d.domain === item.domain && d.tabs.some(t => t.windowId === windowId)))
      .filter(Boolean);
    const mentionedDomains = new Set(orderedDomains.map(d => d.domain));
    let domainSlot = 0;
    this.tabData = this.tabData.map(d => mentionedDomains.has(d.domain) ? orderedDomains[domainSlot++] : d);

    for (const item of newOrder) {
      const domainData = this.tabData.find(d => d.domain === item.domain);
      if (!domainData) continue;
      const orderedTabs = item.tabIds
        .map(id => domainData.tabs.find(t => t.id === id && t.windowId === windowId))
        .filter(Boolean);
      const mentionedIds = new Set(orderedTabs.map(t => t.id));
      let tabSlot = 0;
      domainData.tabs = domainData.tabs.map(t => mentionedIds.has(t.id) ? orderedTabs[tabSlot++] : t);
    }

    this.#saveTabData();
  }

  // senderTab is the page's own tab: it may only act on the tabs its dock shows,
  // i.e. those of its window (see #viewFor).
  #onMessageReceived(message, senderTab) {
    const windowId = senderTab.windowId;
    switch (message.action) {
      case 'focusTab':
        if (!this.#isWindowTab(message.tabId, windowId)) return;
        if (!this.#allow(senderTab.id, 'focus', FOCUS_TAB_INTERVAL)) return;
        // Also focus the window, in case it isn't the focused one.
        api.tabs.update(message.tabId, { active: true })
          .then(tab => api.windows.update(tab.windowId, { focused: true }))
          .catch(() => {});
        api.tabs.sendMessage(message.tabId, { action: 'expandDock' }).catch(() => {});
        break;
      case 'openTab':
      case 'openAndNavigateToTab': {
        // Pages only know domains; the url is resolved here and never leaves
        // the background. Only among the sender's window tabs, and opened in
        // that window: a guessed domain must not pull another window's url
        // (and then its title, through the new tab) into this dock.
        if (!this.#allow(senderTab.id, 'open', OPEN_TAB_INTERVAL)) return;
        const url = this.#firstTabUrl(message.domain, windowId);
        if (url && /^https?:/i.test(url)) {
          api.tabs.create({ url, windowId, active: message.action === 'openAndNavigateToTab' }).catch(() => {});
        }
        break;
      }
      case 'closeTab':
        if (this.#isWindowTab(message.tabId, windowId) && this.#allow(senderTab.id, 'close', CLOSE_TAB_INTERVAL)) {
          api.tabs.remove(message.tabId).catch(() => {});
        }
        break;
      case 'updateTabOrder':
        if (this.#isValidOrder(message.newOrder)) {
          this.#updateTabOrder(message.newOrder, windowId);
        }
        break;
      case 'setDockPosition':
        this.#setDockPosition(message.position);
        break;
    }
  }

  // The edge is global: every dock of every window follows, the sender's
  // included (its setPosition is a no-op on the value it already has).
  #setDockPosition(position) {
    if ((position !== 'top' && position !== 'bottom') || position === this.#dockPosition) return;
    this.#dockPosition = position;
    writeSetting('dockPosition', position).catch(() => {});
    for (const domainData of this.tabData) {
      for (const tab of domainData.tabs) {
        api.tabs.sendMessage(tab.id, { action: 'dockPositionChanged', position }).catch(() => {});
      }
    }
  }

  #isWindowTab(tabId, windowId) {
    return Number.isInteger(tabId) && this.tabData.some(d =>
      d.tabs.some(t => t.id === tabId && t.windowId === windowId));
  }

  // A dock lists each domain once and each tab id once (two tabs on the same
  // url still have distinct ids). #updateTabOrder fills slots from the message
  // in order, so a repeated entry would overwrite another domain or tab:
  // anything a real dock can't send is rejected whole.
  #isValidOrder(newOrder) {
    if (!Array.isArray(newOrder)) return false;
    const domains = new Set();
    const tabIds = new Set();
    for (const item of newOrder) {
      if (!item || typeof item !== 'object' || typeof item.domain !== 'string' || !Array.isArray(item.tabIds)) return false;
      if (domains.has(item.domain)) return false;
      domains.add(item.domain);
      for (const id of item.tabIds) {
        if (!Number.isInteger(id) || tabIds.has(id)) return false;
        tabIds.add(id);
      }
      if (domains.size + tabIds.size > MAX_ORDER_ENTRIES) return false;
    }
    return true;
  }

  // One action of a kind per sender tab per interval: a real click never comes
  // faster, a page scripting the channel can't flood the window with tabs nor
  // close or switch them all at once.
  #allow(senderTabId, kind, interval) {
    const now = Date.now();
    let last = this.#lastActionAt.get(senderTabId);
    if (!last) {
      last = {};
      this.#lastActionAt.set(senderTabId, last);
    }
    if (last[kind] !== undefined && now - last[kind] < interval) return false;
    last[kind] = now;
    return true;
  }

  #firstTabUrl(domain, windowId) {
    if (typeof domain !== 'string') return null;
    const domainData = this.tabData.find(d => d.domain === domain);
    const tab = domainData && domainData.tabs.find(t => t.windowId === windowId);
    return tab ? tab.url : null;
  }

  // Only web pages get a dock entry: chrome://, about:, file: and other
  // extensions' pages (whose ids would reveal what else is installed) never
  // reach tabData, so they are never broadcast to the pages.
  #getHostname(url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
      return parsed.hostname;
    } catch (e) {
      return null;
    }
  }

  #getPackagedFile(path, mimeType) {
    let promise = this.#packagedFiles.get(path);
    if (!promise) {
      promise = fetch(api.runtime.getURL(path))
        .then(response => mimeType ? this.#toDataURL(response, mimeType) : response.text())
        .catch(() => null);
      this.#packagedFiles.set(path, promise);
    }
    return promise;
  }

  async #toDataURL(response, mimeType) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return `data:${mimeType};base64,${btoa(binary)}`;
  }

  // Chrome: reads the browser's own favicon cache (no network request). The
  // _favicon endpoint is only fetchable from extension contexts, so the page
  // never sees the tab's url and the endpoint needs no web-accessible entry.
  async #fetchChromeFavicon(pageUrl) {
    const url = new URL(api.runtime.getURL('/_favicon/'));
    url.searchParams.set('pageUrl', pageUrl);
    url.searchParams.set('size', '32');
    const response = await fetch(url);
    if (!response.ok) return null;
    return this.#toDataURL(response, 'image/png');
  }

  // One favicon per domain, handed to the pages as a 32x32 data: PNG that the
  // dock draws onto a canvas: no extension URL ends up in the page, and the
  // host pages' CSP (which applies to content-script <img> loads) never gets a
  // say. Chrome reads it from _favicon; Firefox has no such endpoint, so the
  // background fetches the icon itself (host permissions bypass CSP/CORS here).
  #applyDomainFavicon(domainData, tab) {
    // _favicon serves the default globe until Chrome has downloaded the site's
    // real icon, so Chrome refetches whenever the tab reports a new favIconUrl
    // (an undefined one included). Firefox needs an actual icon URL.
    // Firefox keeps a domain's first icon for the session (see #faviconCache).
    if (!isMV3 && (!tab.favIconUrl || domainData.favicon)) return;
    if (domainData.faviconSource === tab.favIconUrl && domainData.favicon) return;
    const source = tab.favIconUrl;
    domainData.faviconSource = source;
    const request = isMV3
      ? this.#fetchChromeFavicon(tab.url).catch(() => null)
      : this.#resolveFavicon(domainData.domain, source);
    request.then(dataUrl => {
      // The domain may have been removed or its source superseded meanwhile.
      const live = this.tabData.find(d => d.domain === domainData.domain);
      if (!live || live.faviconSource !== source) return;
      live.favicon = dataUrl; // null falls back to the default icon in the UI
      this.#saveTabData();
    });
  }

  #resolveFavicon(domain, source) {
    let promise = this.#faviconCache.get(domain);
    if (!promise) {
      promise = this.#rasterize(source).catch(() => null).then(dataUrl => {
        if (!dataUrl && this.#faviconCache.get(domain) === promise) {
          this.#faviconCache.delete(domain);
        }
        return dataUrl;
      });
      if (this.#faviconCache.size >= FAVICON_CACHE_MAX) {
        // Maps iterate in insertion order: drop the oldest domain.
        this.#faviconCache.delete(this.#faviconCache.keys().next().value);
      }
      this.#faviconCache.set(domain, promise);
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
        // The page picks this URL and host permissions bypass CORS, so only
        // plain web fetches, bounded in time and announced size. The timeout
        // also aborts the body read; blob.size still guards a missing or
        // understated content-length.
        const url = new URL(source);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
        const response = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(5000) });
        if (!response.ok || Number(response.headers.get('content-length')) > 512 * 1024) return null;
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
    // The manifest's "incognito": "not_allowed" already keeps private tabs
    // away from the extension; the check only backs it up.
    if (!tab || !tab.url || tab.incognito) return;
    const hostname = this.#getHostname(tab.url);
    if (!hostname) {
      // A tab that left the web (chrome://settings, about:blank...) leaves the
      // dock too, instead of lingering under its last domain with a stale url.
      if (this.tabData.some(d => d.tabs.some(t => t.id === tab.id))) {
        this.#removeTab(tab.id);
      }
      return;
    }

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
      const seed = this.#faviconSeed && this.#faviconSeed.get(hostname);
      domainData = seed
        ? { domain: hostname, favicon: seed.favicon, faviconSource: seed.faviconSource, tabs: [] }
        : { domain: hostname, favicon: null, tabs: [] };
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

  // What a page is allowed to see: its own window's tabs, without url or
  // windowId. Content scripts share the page's process, so anything sent to
  // them is readable by a compromised site.
  #viewFor(windowId) {
    return this.tabData
      .map(d => ({
        domain: d.domain,
        favicon: d.favicon,
        tabs: d.tabs
          .filter(t => t.windowId === windowId)
          .map(({ id, title }) => ({ id, title }))
      }))
      .filter(d => d.tabs.length > 0);
  }

  // Pushes each window's view to the tabs of that window, skipping windows
  // whose view is identical to the last one sent.
  #broadcast() {
    const tabsByWindow = new Map();
    for (const domainData of this.tabData) {
      for (const tab of domainData.tabs) {
        let ids = tabsByWindow.get(tab.windowId);
        if (!ids) {
          ids = [];
          tabsByWindow.set(tab.windowId, ids);
        }
        ids.push(tab.id);
      }
    }
    for (const windowId of [...this.#lastSent.keys()]) {
      if (!tabsByWindow.has(windowId)) this.#lastSent.delete(windowId);
    }
    for (const [windowId, tabIds] of tabsByWindow) {
      const view = this.#viewFor(windowId);
      const serialized = JSON.stringify(view);
      if (this.#lastSent.get(windowId) === serialized) continue;
      this.#lastSent.set(windowId, serialized);
      for (const tabId of tabIds) {
        // No receiver on chrome:// pages, discarded tabs or pages still
        // loading: the send rejects and that's fine (a loading page pulls
        // its view with getTabs once its content script is up).
        api.tabs.sendMessage(tabId, { action: 'tabsUpdated', tabData: view }).catch(() => {});
      }
    }
  }

  // Trailing debounce: coalesces event bursts (e.g. every tab firing onUpdated at
  // browser startup) into a single persist + push.
  #saveTabData() {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => this.#persist(), 150);
  }

  #persist() {
    if (sessionStore) {
      sessionStore.set({ tabData: this.tabData }).catch(() => {});
    }
    // Only the domain order goes to disk, no url, no title: just enough to
    // restore the dock order after a browser restart.
    const domainOrder = this.tabData.map(d => d.domain);
    const key = domainOrder.join('\n');
    if (key !== this.#lastDomainOrder) {
      this.#lastDomainOrder = key;
      writeSetting('domainOrder', domainOrder).catch(() => {});
    }
    this.#broadcast();
  }
}

const background = new Background();
