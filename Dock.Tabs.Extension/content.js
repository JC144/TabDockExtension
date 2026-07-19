(async () => {
    const api = (typeof browser !== 'undefined') ? browser : chrome;
    const src = api.runtime.getURL('main.js');
    const contentScript = await import(src);
    new contentScript.default();
})();
