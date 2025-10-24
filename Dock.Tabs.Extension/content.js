// Minimal content script - loads dock on tab focus
(async () => {
    const browser = chrome ?? browser;
    let dockModule = null;
    let main = null;
    let triggerZone = null;
    let loadTimeout = null;
    let isLoading = false;
    let isTabFocused = document.hasFocus();
    let manuallyTriggered = false;

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

        // Load dock on hover (manual trigger)
        triggerZone.addEventListener('mouseenter', handleTriggerHover);
        triggerZone.addEventListener('mouseleave', handleTriggerLeave);
    }

    function handleTriggerHover() {
        if (isLoading || main) return;
        
        // Mark as manually triggered
        manuallyTriggered = true;
        
        // Clear any pending unload
        if (loadTimeout) {
            clearTimeout(loadTimeout);
            loadTimeout = null;
        }

        loadDock();
    }

    function handleTriggerLeave(e) {
        // Only handle if manually triggered
        if (!manuallyTriggered) return;
        
        // Don't unload if moving to dock
        if (main && main.dock && main.dock.state.isOver) return;
        
        // Delay unload to prevent flashing
        loadTimeout = setTimeout(() => {
            if (main && main.dock && !main.dock.state.isOver) {
                manuallyTriggered = false;
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
                    // If tab lost focus and not manually triggered, unload
                    if (!isTabFocused && !manuallyTriggered) {
                        clearInterval(checkInterval);
                        unloadDock();
                        return;
                    }
                    
                    // If manually triggered but not hovering anymore
                    if (manuallyTriggered && main && main.dock && !main.dock.state.isOver && !main.dock.state.isOpen) {
                        clearInterval(checkInterval);
                        loadTimeout = setTimeout(() => {
                            if (main && main.dock && !main.dock.state.isOver) {
                                manuallyTriggered = false;
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
        if (loadTimeout) {
            clearTimeout(loadTimeout);
            loadTimeout = null;
        }
        
        if (main) {
            main.cleanup();
            main = null;
            dockModule = null;
        }
    }

    // Handle tab focus changes
    function handleFocusChange() {
        const newFocusState = document.hasFocus();
        
        if (newFocusState !== isTabFocused) {
            isTabFocused = newFocusState;
            
            if (isTabFocused) {
                // Tab gained focus - load dock if auto-load is enabled
                browser.storage.local.get('autoLoadDock', (result) => {
                    const autoLoad = result.autoLoadDock !== false; // Default to true
                    if (autoLoad && !main && !manuallyTriggered) {
                        loadDock();
                    }
                });
            } else {
                // Tab lost focus - unload dock if not manually triggered
                if (!manuallyTriggered) {
                    // Small delay to handle rapid tab switching
                    setTimeout(() => {
                        if (!isTabFocused && !manuallyTriggered && main) {
                            unloadDock();
                        }
                    }, 100);
                }
            }
        }
    }

    // Handle visibility change (tab switch, minimize, etc.)
    function handleVisibilityChange() {
        if (document.hidden) {
            // Tab became hidden
            if (!manuallyTriggered && main) {
                unloadDock();
            }
        } else {
            // Tab became visible - check if it has focus
            setTimeout(() => {
                isTabFocused = document.hasFocus();
                handleFocusChange();
            }, 50);
        }
    }

    // Handle page load/navigation
    function handlePageLoad() {
        // When page loads, check if we should load the dock
        if (document.hasFocus()) {
            browser.storage.local.get('autoLoadDock', (result) => {
                const autoLoad = result.autoLoadDock !== false; // Default to true
                if (autoLoad && !main && !manuallyTriggered) {
                    loadDock();
                }
            });
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

    // Message listener for explicit dock commands
    browser.runtime.onMessage.addListener((message) => {
        switch (message.action) {
            case 'loadDock':
                if (!main) {
                    loadDock();
                }
                break;
            case 'unloadDock':
                unloadDock();
                break;
            case 'expandDock':
                // Handle expand dock message when switching tabs
                if (!main && isTabFocused) {
                    loadDock();
                } else if (main && main.dock) {
                    main.dock.expandDock();
                }
                break;
            case 'tabActivated':
            case 'windowFocused':
                // Tab became active - trigger focus check
                isTabFocused = true;
                handleFocusChange();
                break;
            case 'enableAutoLoad':
                // Auto-load was enabled in settings
                if (!main && isTabFocused) {
                    loadDock();
                }
                break;
            case 'disableAutoLoad':
                // Auto-load was disabled - unload if not manually triggered
                if (!manuallyTriggered && main) {
                    unloadDock();
                }
                break;
        }
    });

    // Initialize trigger zone when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createTriggerZone);
    } else {
        createTriggerZone();
    }

    // Set up focus detection
    window.addEventListener('focus', handleFocusChange);
    window.addEventListener('blur', handleFocusChange);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Set up page load detection
    window.addEventListener('load', handlePageLoad);
    
    // Also handle page show event (for back/forward navigation)
    window.addEventListener('pageshow', handlePageLoad);

    // Check initial focus state and load dock if needed
    setTimeout(() => {
        handleFocusChange();
    }, 100);

    // Clean up on page unload
    window.addEventListener('beforeunload', () => {
        window.removeEventListener('focus', handleFocusChange);
        window.removeEventListener('blur', handleFocusChange);
        document.removeEventListener('visibilitychange', handleVisibilityChange);
        window.removeEventListener('load', handlePageLoad);
        window.removeEventListener('pageshow', handlePageLoad);
        
        if (main) {
            unloadDock();
        }
        if (triggerZone) {
            triggerZone.remove();
        }
    });
})();