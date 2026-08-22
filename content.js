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
// Installed on ANY Winna frame. The board used to live in a games.winna.com
// iframe but is now rendered inline on https://winna.com/game/originals/keno, so
// both layouts have to work:
//   - iframe layout: the overlay (top frame) postMessages in, handled below;
//   - inline layout: the overlay is in this same frame and calls
//     window.__vantedgeWinna directly (content scripts of one extension share an
//     isolated world, which is how content.js already reads window.geminyzerOverlay).
if (window.location.hostname.includes('winna.com')) {
    let recommendedNumbers = [];
    let highlightObserver = null;

    // Quiet by default. To trace which frame holds the board, run this in that
    // frame's console and reload:  localStorage.vantedge_debug = '1'
    // (guarded: localStorage throws in a sandboxed frame).
    const VX_DEBUG = (() => {
        try { return localStorage.getItem('vantedge_debug') === '1'; } catch (e) { return false; }
    })();

    // Vue binds real pointer events, and handlers often ignore a PointerEvent
    // with no pointerId/button state — so send the full sequence.
    const winnaClick = (button) => {
        try {
            const r = button.getBoundingClientRect();
            const base = {
                bubbles: true, cancelable: true, composed: true, view: window,
                clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0
            };
            const pointer = { ...base, pointerId: 1, isPrimary: true, pointerType: 'mouse', width: 1, height: 1 };
            button.dispatchEvent(new PointerEvent('pointerover', pointer));
            button.dispatchEvent(new PointerEvent('pointerenter', pointer));
            button.dispatchEvent(new PointerEvent('pointerdown', { ...pointer, buttons: 1 }));
            button.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
            button.dispatchEvent(new PointerEvent('pointerup', pointer));
            button.dispatchEvent(new MouseEvent('mouseup', base));
            button.dispatchEvent(new MouseEvent('click', base));
        } catch (e) { /* board mid-render */ }
    };

    const setWinnaHighlights = (numbers) => {
        recommendedNumbers = Array.isArray(numbers) ? numbers : [];

        // Try to actually select them first; whatever the click can't take
        // (Winna may require trusted events) falls through to the marker.
        const buttons = findWinnaButtons();
        buttons.forEach((button, n) => {
            const selected = button.classList.contains('selected');
            if (selected && !recommendedNumbers.includes(n)) winnaClick(button);
        });
        recommendedNumbers.forEach(n => {
            const button = buttons.get(n);
            if (button && !button.classList.contains('selected')) winnaClick(button);
        });

        setTimeout(applyWinnaHighlights, 250);
        startWinnaHighlightObserver();
    };
    const clearWinnaHighlights = () => {
        recommendedNumbers = [];
        applyWinnaHighlights();
    };

    // Direct API for the inline layout.
    window.__vantedgeWinna = { highlight: setWinnaHighlights, clear: clearWinnaHighlights };

    // Pass a message on to this frame's own child frames. The board can sit in a
    // nested iframe, and postMessage only reaches direct children — so each frame
    // relays downward. Messages never travel up, so this can't loop.
    const relayToChildFrames = (message) => {
        document.querySelectorAll('iframe').forEach(f => {
            try { f.contentWindow?.postMessage(message, '*'); } catch (e) { /* opaque frame */ }
        });
    };

    window.addEventListener('message', (event) => {
        const type = event.data?.type;
        if (type !== 'WINNA_HIGHLIGHT_NUMBERS' && type !== 'WINNA_CLEAR_HIGHLIGHT') return;

        // Deliberately NOT checking event.source against window.parent. The game
        // frame is sandboxed (opaque origin) and may be nested, both of which can
        // make that comparison fail; these message types are ours alone, so the
        // type check is the gate.
        relayToChildFrames(event.data);

        if (type === 'WINNA_HIGHLIGHT_NUMBERS') {
            const wanted = Array.isArray(event.data.numbers) ? event.data.numbers : [];
            const found = findWinnaButtons().size;
            // Frame URL included: with several frames answering, this is the only
            // way to tell which one actually holds the board.
            if (VX_DEBUG) console.log(`Vantedge: Winna bridge [${location.href}] received ${wanted.length} number(s); board tiles found: ${found}`);
            if (found > 0) setWinnaHighlights(wanted);
        }

        if (type === 'WINNA_CLEAR_HIGHLIGHT') {
            clearWinnaHighlights();
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

    // The board container has been `.keno-field`; the current markup is
    // `<button class="field-button ..."><div class="field-button__surface">
    // <span>32</span></div></button>`, so fall back to the button class itself.
    function findWinnaBoard() {
        return document.querySelector('.keno-field')
            || document.querySelector('button.field-button')?.closest('div, section, main')
            || document.body;
    }

    // Map number -> button. The number text lives in a nested span, so read each
    // button's textContent rather than a direct child node.
    function findWinnaButtons() {
        const num = (b) => {
            const t = (b.textContent || '').trim();
            return /^\d{1,2}$/.test(t) ? parseInt(t, 10) : NaN;
        };
        // querySelectorAll doesn't pierce shadow roots, so walk them too.
        const deep = (selector) => {
            const out = [];
            const walk = (root) => {
                out.push(...root.querySelectorAll(selector));
                root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) walk(el.shadowRoot); });
            };
            walk(document);
            return out;
        };
        // If the number sits in a leaf <span> inside the real tile, climb to the
        // clickable ancestor — that's what carries the `selected` class and what
        // the highlight ring needs to wrap.
        // Order matters: the number's own parent is `div.field-button__surface`,
        // which would match [class*="field-button"] and hand back the inner div
        // instead of the <button> that actually carries the `selected` class.
        const clickTarget = (el) =>
            el.closest('button')
            || el.closest('[role="button"]')
            || el.closest('[class*="field-button"]')
            || el.closest('[class*="tile"]')
            || el;

        const collect = (list) => {
            const map = new Map();
            list.forEach(el => {
                const n = num(el);
                if (n >= 1 && n <= 40 && !map.has(n)) map.set(n, clickTarget(el));
            });
            return map;
        };

        let map = collect(deep('.keno-field button, .keno-field [role="button"]'));
        if (map.size === 0) map = collect(deep('[class*="field-button"]'));
        if (map.size === 0) {
            // The tiles may not be <button> at all. Widen to anything clickable,
            // then to any leaf element labelled 1-40. Only trust the result if it
            // looks like a real 40-tile board; no extension UI exists in this
            // frame to confuse the scan.
            let scanned = collect(deep('button, [role="button"], a'));
            if (scanned.size < 30) {
                scanned = collect(deep('div, span, li').filter(el => el.children.length === 0));
            }
            map = scanned.size >= 30 ? scanned : new Map();
        }
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
        const container = findWinnaBoard();
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