// Minimal content script - only creates a trigger zone
(async () => {
    const browser = chrome ?? browser;
    let dockModule = null;
    let main = null;
    let triggerZone = null;
    let loadTimeout = null;
    let isLoading = false;

    // Create invisible trigger zone at bottom/top of page
    function createTriggerZone() {
        if (triggerZone) return;
        
        triggerZone = document.createElement('div');
        triggerZone.id = 'dock-trigger-zone';
        triggerZone.style.cssText = `
            position: fixed;
            left: 0;
            right: 0;
            height: 10px;
            z-index: 9998;
            pointer-events: auto;
            background: transparent;
        `;
        
        // Get saved position
        browser.storage.local.get('dockPosition', (result) => {
            const position = result.dockPosition || 'bottom';
            if (position === 'top') {
                triggerZone.style.top = '0';
                triggerZone.style.bottom = 'auto';
            } else {
                triggerZone.style.bottom = '0';
                triggerZone.style.top = 'auto';
            }
        });

        document.body.appendChild(triggerZone);

        // Load dock on hover
        triggerZone.addEventListener('mouseenter', handleTriggerHover);
        triggerZone.addEventListener('mouseleave', handleTriggerLeave);
    }

    function handleTriggerHover() {
        if (isLoading || main) return;
        
        // Clear any pending unload
        if (loadTimeout) {
            clearTimeout(loadTimeout);
            loadTimeout = null;
        }

        loadDock();
    }

    function handleTriggerLeave(e) {
        // Don't unload if moving to dock
        if (main && main.dock && main.dock.state.isOver) return;
        
        // Delay unload to prevent flashing
        loadTimeout = setTimeout(() => {
            if (main && main.dock && !main.dock.state.isOver) {
                unloadDock();
            }
        }, 3000); // Unload after 3 seconds of inactivity
    }

    async function loadDock() {
        if (main || isLoading) return;
        
        isLoading = true;
        try {
            const src = browser.runtime.getURL('main.js');
            dockModule = await import(src);
            main = new dockModule.default();
            
            // Add cleanup check
            if (main.dock) {
                // Monitor dock state
                const checkInterval = setInterval(() => {
                    if (main && main.dock && !main.dock.state.isOver && !main.dock.state.isOpen) {
                        clearInterval(checkInterval);
                        // Schedule unload
                        loadTimeout = setTimeout(() => {
                            if (main && main.dock && !main.dock.state.isOver) {
                                unloadDock();
                            }
                        }, 5000);
                    }
                }, 1000);
            }
        } catch (error) {
            console.error('Failed to load dock:', error);
        } finally {
            isLoading = false;
        }
    }

    function unloadDock() {
        if (main) {
            main.cleanup();
            main = null;
            dockModule = null;
        }
    }

    // Listen for position changes
    browser.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.dockPosition && triggerZone) {
            const position = changes.dockPosition.newValue;
            if (position === 'top') {
                triggerZone.style.top = '0';
                triggerZone.style.bottom = 'auto';
            } else {
                triggerZone.style.bottom = '0';
                triggerZone.style.top = 'auto';
            }
        }
    });

    // Initialize trigger zone when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createTriggerZone);
    } else {
        createTriggerZone();
    }

    // Clean up on page unload
    window.addEventListener('beforeunload', () => {
        if (main) {
            unloadDock();
        }
        if (triggerZone) {
            triggerZone.remove();
        }
    });
})();