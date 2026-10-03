// Prefer the promise-based `browser` namespace (Firefox); Chrome MV3 `chrome.*` is promise-based too.
const api = (typeof browser !== 'undefined') ? browser : chrome;
