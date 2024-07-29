(async () => {
    const browser = chrome ?? browser;
    const src = browser.runtime.getURL('main.js');
    const contentScript = await import(src);
    var main = new contentScript.default();
})();