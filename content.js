console.log('Vantedge: Content script loaded.');

if (typeof browser === 'undefined') {
    var browser = chrome;
}

const script = document.createElement('script');
script.src = browser.runtime.getURL('injected.js');
script.onload = function () { this.remove(); };
(document.head || document.documentElement).appendChild(script);

let port = null;
let isConnecting = false;
let messageQueue = [];
let reconnectAttempts = 0;
const maxReconnectAttempts = 5;

// ADDED: Variable to hold the last strategy selected in the overlay.
let lastSelectedStrategy = null;

function connect() {
    if (port || isConnecting) return;

    isConnecting = true;
    reconnectAttempts++;

    try {
        port = browser.runtime.connect({ name: 'grokalyzer-port' });
        isConnecting = false;
        reconnectAttempts = 0;

        flushMessageQueue();

        port.onDisconnect.addListener(() => {
            port = null;

            if (browser.runtime.lastError) {
                console.warn(`Disconnect reason: ${browser.runtime.lastError.message}`);
            }

            if (reconnectAttempts < maxReconnectAttempts) {
                setTimeout(connect, 2000);
            }
        });

    } catch (error) {
        isConnecting = false;
        port = null;

        if (reconnectAttempts < maxReconnectAttempts) {
            setTimeout(connect, 2000);
        } else {
            console.error("Vantedge: Failed to connect to background script after multiple attempts.");
        }
    }
}

function flushMessageQueue() {
    while (port && messageQueue.length > 0) {
        const message = messageQueue.shift();
        try {
            port.postMessage(message);
        } catch (error) {
            messageQueue.unshift(message);
            port = null;
            connect();
            break;
        }
    }
}


function sendMessage(message) {
    if (!port) {
        messageQueue.push(message);
        connect();
        return;
    }

    try {
        port.postMessage(message);
    } catch (error) {
        port = null;
        messageQueue.unshift(message);
        connect();
    }
}

// Track last message time PER TYPE to prevent cross-type throttling
let lastMessageTimes = {};
// Rainbet sends MANY messages - use longer throttle to prevent lag
const MESSAGE_THROTTLE = window.location.href.includes('rainbet.com') ? 200 : 50;

window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data.type) return;

    // ADDED: Listener for strategy selection from the overlay.
    if (event.data.type === 'VANTEDGE_STRATEGY_SELECTED') {
        lastSelectedStrategy = event.data.strategy;
        return; // This is not a message for the background script.
    }

    const gameDataTypes = ['PLINKO_BET_DATA', 'KENO_BET_DATA', 'MINES_BET_DATA'];

    // Only throttle game data messages, and only per message type
    if (gameDataTypes.includes(event.data.type)) {
        const now = Date.now();
        const messageType = event.data.type;
        const lastTime = lastMessageTimes[messageType] || 0;

        if (now - lastTime < MESSAGE_THROTTLE) {
            return; // Skip this message to prevent overwhelming the background script
        }
        lastMessageTimes[messageType] = now;

        // CHANGED: Attach the stored strategy to the Keno bet data before sending.
        if (event.data.type === 'KENO_BET_DATA') {
            if (lastSelectedStrategy) {
                event.data.data.activeStrategy = lastSelectedStrategy;
            }
        }
        sendMessage(event.data);
    }
});

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'RESET_OVERLAY_DATA') {
        if (window.geminyzerOverlay && typeof window.geminyzerOverlay.resetData === 'function') {
            window.geminyzerOverlay.resetData();
            sendResponse({ success: true });
        } else {
            sendResponse({ success: false, error: 'Overlay not available' });
        }
        return false; // Synchronous response sent
    }

    if (message.type === 'TOGGLE_OVERLAY') {
        if (window.geminyzerOverlay && typeof window.geminyzerOverlay.toggleVisibility === 'function') {
            window.geminyzerOverlay.toggleVisibility();
            sendResponse({ success: true });
        } else {
            sendResponse({ success: false, error: 'Overlay not available' });
        }
        return false; // Synchronous response sent
    }

    // Don't handle unknown message types
    return false;
});

function isSupportedSite() {
    const url = window.location.href;
    return url.includes('stake.') || url.includes('rainbet.com') || url.includes('roobet.com') || url.includes('shuffle.com') || url.includes('betfury.com') || url.includes('winna.com');
}

// Winna iframe bridge - highlight recommended numbers for manual tapping.
// The Winna game (Vue) only responds to TRUSTED clicks, so synthetic clicks
// from a content script can't pick numbers. Instead we visually mark the
// recommended buttons and the user taps them. We must NOT postMessage to
// window.parent (the winna.com shell logs "Unknown message type!" for it).
if (window.location.hostname.includes('games.winna.com')) {
    let recommendedNumbers = [];
    let highlightObserver = null;

    window.addEventListener('message', (event) => {
        // Only accept messages from parent
        if (event.source !== window.parent) return;

        if (event.data.type === 'WINNA_HIGHLIGHT_NUMBERS') {
            recommendedNumbers = Array.isArray(event.data.numbers) ? event.data.numbers : [];
            applyWinnaHighlights();
            startWinnaHighlightObserver();
        }

        if (event.data.type === 'WINNA_CLEAR_HIGHLIGHT') {
            recommendedNumbers = [];
            applyWinnaHighlights();
        }
    });

    function ensureWinnaHighlightStyle() {
        if (document.getElementById('vantedge-pick-style')) return;
        const style = document.createElement('style');
        style.id = 'vantedge-pick-style';
        style.textContent = `
            .vantedge-pick { position: relative; }
            .vantedge-pick::after {
                content: ''; position: absolute; inset: -3px; border-radius: inherit;
                border: 2.5px solid #ffd54a; box-shadow: 0 0 10px 2px rgba(255, 213, 74, .85);
                pointer-events: none; animation: vantedgePulse 1.1s ease-in-out infinite; z-index: 5;
            }
            /* Opaque solid beacon for the AutoHotkey auto-clicker to PixelSearch
               (#FF00FF magenta). Non-animated, click-through so a real OS click
               at this spot still lands on the button underneath. */
            .vantedge-pick::before {
                content: ''; position: absolute; top: 4px; right: 4px;
                width: 9px; height: 9px; background: #ff00ff; border-radius: 2px;
                pointer-events: none; z-index: 10;
            }
            @keyframes vantedgePulse { 0%, 100% { opacity: .55 } 50% { opacity: 1 } }`;
        (document.head || document.documentElement).appendChild(style);
    }

    // Map number -> button. The board is `.keno-field > button` where the
    // number text lives in a nested span, so read each button's textContent.
    function findWinnaButtons() {
        const container = document.querySelector('.keno-field');
        const map = new Map();
        if (!container) return map;
        container.querySelectorAll('button').forEach(button => {
            const num = parseInt(button.textContent?.trim(), 10);
            if (!isNaN(num) && num >= 1 && num <= 40) map.set(num, button);
        });
        return map;
    }

    // Highlight recommended numbers that aren't selected yet. Once a button is
    // selected (by you tapping, or the AHK auto-clicker), its marker is dropped
    // so the auto-clicker walks through the remaining ones and stops cleanly.
    function applyWinnaHighlights() {
        ensureWinnaHighlightStyle();
        const buttons = findWinnaButtons();
        buttons.forEach((button, num) => {
            const wanted = recommendedNumbers.includes(num) && !button.classList.contains('selected');
            button.classList.toggle('vantedge-pick', wanted); // toggle is a no-op when already correct -> no observer loop
        });
    }

    // Re-apply when the board changes: childList (round re-render replaces button
    // nodes) and class changes (a number becomes 'selected' -> clear its marker).
    // applyWinnaHighlights only toggles classes that need changing, so it converges
    // without an infinite observer loop.
    function startWinnaHighlightObserver() {
        if (highlightObserver) return;
        const container = document.querySelector('.keno-field');
        if (!container) return;
        let scheduled = false;
        highlightObserver = new MutationObserver(() => {
            if (scheduled || !recommendedNumbers.length) return;
            scheduled = true;
            requestAnimationFrame(() => { scheduled = false; applyWinnaHighlights(); });
        });
        highlightObserver.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    }
}