// Prefer the promise-based `browser` namespace (Firefox); Chrome MV3 `chrome.*` is promise-based too.
export const api = (typeof browser !== 'undefined') ? browser : chrome;
export const isMV3 = api.runtime.getManifest().manifest_version === 3;
