// Vantedge injected script
(function () {
    // Storage origin. Bets are keyed by this string all the way through
    // (background stores `${site}-keno-session`), so every frame of a site must
    // report the SAME origin or the overlay reads an empty key.
    //
    // Winna serves the board from more than one host (winna.com shell,
    // games.winna.com and originals.winna.com game frames) and has moved between
    // them. The overlay, popup and background all resolve Winna to
    // games.winna.com, so canonicalise here to match — otherwise bets are
    // captured correctly but stored under a key nothing ever reads.
    // IMPORTANT: Winna's game frame is sandboxed WITHOUT allow-same-origin (the
    // console shows "The document is sandboxed and lacks the 'allow-same-origin'
    // flag"), which makes it an OPAQUE origin — window.location.origin there is
    // the string "null", not a URL. Keying off origin therefore filed every Winna
    // bet under "null-keno-session". hostname is still readable in a sandboxed
    // frame, so derive the site from that instead.
    const rawOrigin = window.location.origin;
    const host = window.location.hostname || '';
    const site = host.includes('winna.com') ? 'https://games.winna.com' : rawOrigin;

    // Off in production. Turn on per-tab without a rebuild:
    //   localStorage.vantedge_debug = '1'   then reload
    const DEBUG = (() => {
        try { return localStorage.getItem('vantedge_debug') === '1'; } catch (e) { return false; }
    })();
    function log(...args) { if (DEBUG) console.log('[Vantedge]', ...args); }
    // Always-on: capture silently stopping is the failure that costs a session's
    // data, so it says so whether or not debug logging is enabled.
    function warn(...args) { console.warn('[Vantedge]', ...args); }

    // ── Native-function cloaking ──────────────────────────────────────────────
    // Cloudflare bot-detection calls Function.prototype.toString.call(fetch) and
    // checks the result against "{ [native code] }".  We intercept that call via
    // a WeakMap so our patched functions are indistinguishable from native ones.
    const _nativeStrings = new WeakMap();
    const _origFnToString = Function.prototype.toString;
    try {
        Function.prototype.toString = function () {
            if (_nativeStrings.has(this)) return _nativeStrings.get(this);
            return _origFnToString.call(this);
        };
        // Make our override itself look native
        _nativeStrings.set(Function.prototype.toString, 'function toString() { [native code] }');
    } catch (e) { /* read-only env — best-effort */ }

    function cloak(fn, nativeStr) {
        try {
            _nativeStrings.set(fn, nativeStr);
            // Belt-and-suspenders: set .toString directly too
            Object.defineProperty(fn, 'toString', {
                value: () => nativeStr,
                configurable: true,
                writable: true
            });
        } catch (e) {}
        return fn;
    }
    // ─────────────────────────────────────────────────────────────────────────

    const gameAPIEndpoints = [
        '/_api/graphql',
        '/_api/casino/keno/bet',
        '/_api/casino/keno/play',
        '/_api/keno/ClassicKeno/play',
        '/_api/casino/plinko/bet',
        '/_api/casino/mines/bet',
        '/_api/casino/mines/next',
        '/_api/casino/mines/cashout',
        '/graphql',
        '/main-api/graphql/api/graphql', // Shuffle API Endpoint

        '/v1/games/keno/play',
        '/v1/games/plinko/play',
        '/v1/games/mines/play',
        '/v1/user/balance/primary',
        'originals.rainbet.com',
        'services.rainbet.com',
        'originals.winna.com/keno/play', // Winna API Endpoint
        'originals.winna.com/keno/finish',
        '/api/keno' // Acebet API Endpoint
    ];

    // Winna moves its game host around (originals.winna.com, and now
    // games-prod.winna.com — the frame src is
    // https://games-prod.winna.com/game/keno?...). Match any Winna host serving a
    // keno endpoint rather than maintaining a list that goes stale on every move.
    // Rainbet's keno route has moved before (/v1/games/keno/play,
    // /original-games/keno/play). Match any Rainbet URL that mentions keno so a
    // renamed path can't silently switch capture off — the same reason the Winna
    // matcher below exists.
    function isRainbetKenoURL(url) {
        if (typeof url !== 'string') return false;
        const u = url.toLowerCase();
        return u.includes('rainbet.com') && u.includes('keno');
    }

    // Rainbet's mines route is matched the same loose way as its keno route.
    // Keno was pinned to /v1/games/keno/play until the path moved and capture
    // stopped without a word; mines is still pinned to /v1/games/mines/play and
    // would fail identically. Match the game, not the path.
    function isRainbetMinesURL(url) {
        if (typeof url !== 'string') return false;
        const u = url.toLowerCase();
        return u.includes('rainbet.com') && u.includes('mines');
    }

    // Roobet mines was never wired up at all - only keno was - so nothing here
    // has ever been captured. Match the request so there is something to read.
    function isRoobetMinesURL(url) {
        if (typeof url !== 'string') return false;
        const u = url.toLowerCase();
        return u.includes('roobet.com') && u.includes('mines');
    }

    function isWinnaKenoURL(url) {
        if (typeof url !== 'string') return false;
        const u = url.toLowerCase();
        return u.includes('winna.com') && u.includes('keno');
    }

    const originalXHR = window.XMLHttpRequest;
    function interceptXHR() {
        const xhr = new originalXHR();
        const originalOpen = xhr.open;
        const originalSend = xhr.send;

        xhr.open = function (method, url, ...args) {
            this._method = method;
            this._url = url;
            return originalOpen.apply(this, [method, url, ...args]);
        };

        xhr.send = function (data) {
            this._requestData = data;

            const shouldIntercept = gameAPIEndpoints.some(endpoint => this._url.includes(endpoint)) ||
                                   isWinnaKenoURL(this._url) ||
                                   isRainbetKenoURL(this._url) ||
                                   isRainbetMinesURL(this._url) ||
                                   isRoobetMinesURL(this._url) ||
                                   (site.includes('betfury.com') && this._url.toLowerCase().includes('keno'));

            if (shouldIntercept) {
                log('🎯 XHR Intercepted:', this._url, this._method);

                this.addEventListener('load', function () {
                    try {
                        // Only read responseText if responseType is '' or 'text'
                        if (!this.responseType || this.responseType === '' || this.responseType === 'text' || this.responseType === 'json') {
                            handleResponse(this.responseText, this._url, this._method, this._requestData);
                        }
                    } catch (error) {
                        console.error('XHR response handling error:', error);
                    }
                });

                this.addEventListener('error', function () {
                    log('XHR error for:', this._url);
                });
            }

            return originalSend.apply(this, arguments);
        };

        return xhr;
    }
    window.XMLHttpRequest = cloak(interceptXHR, 'function XMLHttpRequest() { [native code] }');

    const originalFetch = window.fetch;
    window.fetch = cloak(function fetch(input, init = {}) {
        const url = typeof input === 'string' ? input : input.url;
        const method = init.method || 'GET';

        // Log ALL POST requests on BetFury to find game API
        if (site.includes('betfury.com') && method === 'POST') {
            log('BetFury POST detected:', url);
        }

        // Only intercept game-specific endpoints or BetFury Keno
        const shouldIntercept = gameAPIEndpoints.some(endpoint => url.includes(endpoint)) ||
                               isWinnaKenoURL(url) ||
                               isRainbetKenoURL(url) ||
                               isRainbetMinesURL(url) ||
                               isRoobetMinesURL(url) ||
                               (site.includes('betfury.com') && url.toLowerCase().includes('keno')) ||
                               (site.includes('betfury.com') && method === 'POST');

        if (shouldIntercept) {
            log('🎯 Fetch Intercepted:', url, method);

            return originalFetch.apply(this, arguments).then(response => {
                const clonedResponse = response.clone();

                clonedResponse.text().then(responseText => {
                    handleResponse(responseText, url, method, init.body);
                }).catch(err => {
                    log('Error reading response:', err);
                });

                return response;
            }).catch(error => {
                // Re-throw error so Shuffle's retry logic can handle it
                throw error;
            });
        }

        return originalFetch.apply(this, arguments);
    }, 'function fetch() { [native code] }');

    function handleResponse(responseText, url, method, requestData) {
        try {
            if (url.includes('betfury.com')) {
                handleBetFuryHTTPResponse(responseText, url, method, requestData);
            } else if (url.includes('rainbet.com')) {
                handleRainbetResponse(responseText, url, method, requestData);
            } else if (url.includes('stake.')) {
                handleStakeResponse(responseText, url, method, requestData);
            } else if (url.includes('shuffle.com')) {
                handleShuffleResponse(responseText, url, method, requestData);
            } else if (url.includes('roobet.com')) {
                handleRoobetResponse(responseText, url, method, requestData);
            } else if (url.includes('winna.com') || url.includes('games.winna.com') || site.includes('winna.com') || site.includes('games.winna.com')) {
                handleWinnaResponse(responseText, url, method, requestData);
            } else if (url.includes('acebet.com') || url.includes('acebet.co')) {
                handleAcebetResponse(responseText, url, method, requestData);
            }
        } catch (error) {
            // Silently handle errors to avoid breaking page functionality
            log('Response handling error:', error);
        }
    }

    function handleBetFuryHTTPResponse(responseText, url, method, requestData) {
        try {
            // Log ALL POST responses to find game API
            if (method === 'POST') {
                log('BetFury POST Response:', url);

                try {
                    const response = JSON.parse(responseText);
                    log('Response JSON:', response);

                    // Try to find and transform Keno data
                    const transformedData = transformBetFuryKenoData(response);
                    if (transformedData) {
                        log('Transformed BetFury Keno data:', transformedData);
                        window.postMessage({
                            type: 'KENO_BET_DATA',
                            data: transformedData,
                            site: site
                        }, '*');
                    }
                } catch (parseError) {
                    log('Response not JSON or parse failed:', parseError.message);
                }
            }
        } catch (error) {
            log('BetFury HTTP response parsing error:', error.message);
        }
    }

    // Roobet mines. Field names are read defensively, the same way the keno
    // transform above reads them, because Roobet's mines payload has not been
    // observed - only its keno one has. Whatever it calls the mine positions and
    // the revealed tiles, one of these should land; if none do, the caller warns
    // rather than storing an empty round.
    // Roobet mines, from an observed cashout response:
    //   { deck: { "0":"diamond", ... "9":"mine", "11":"mine", "17":"mine" },
    //     bet: { betAmount, currency, mult, payoutMultiplier, profit, won,
    //            betId, closedOut, gameName:"mines" } }
    // Mine positions are the deck keys whose value is "mine". The earlier
    // version of this guessed at mines/minePositions/bombs arrays; Roobet sends
    // none of those. A per-click reveal ({ result, payoutMultiplier,
    // provablyFairInfo.roundOver:false }) carries no deck, so it is skipped.
    function transformRoobetMinesData(gameData) {
        const deck = gameData.deck || gameData.bet?.deck;
        if (!deck || typeof deck !== 'object') return null;
        const mines = Object.keys(deck)
            .filter(k => String(deck[k]).toLowerCase() === 'mine')
            .map(Number)
            .filter(n => Number.isFinite(n))
            .sort((a, b) => a - b);
        const bet = gameData.bet || gameData;
        const num = v => parseFloat(v) || 0;
        return {
            id: bet.betId || bet.id || `mines-${Date.now()}`,
            active: false,                       // a deck only arrives once the round ends
            payoutMultiplier: num(bet.payoutMultiplier ?? bet.mult),
            payout: num(bet.payoutValue ?? bet.payout),
            amount: num(bet.betAmount ?? bet.amount),
            currency: String(bet.currency || bet.balanceType || 'usd').toLowerCase(),
            state: {
                mines,
                rounds: [],                      // Roobet does not report which tiles were opened
                minesCount: mines.length || 3
            },
            timestamp: new Date().toISOString()
        };
    }

    function handleRoobetResponse(responseText, url, method, requestData) {
        try {
            if (isRoobetMinesURL(url)) {
                const gameData = JSON.parse(responseText);
                const payload = gameData.data || gameData.game || gameData;
                const transformed = payload && transformRoobetMinesData(payload);
                if (transformed) {
                    log('✅ Roobet Mines round finished:', transformed.state);
                    window.postMessage({
                        type: 'MINES_BET_DATA',
                        data: transformed,
                        site: site
                    }, '*');
                } else if (payload && payload.result === undefined) {
                    // A reveal has `result` and no deck; that is the round still
                    // running rather than a shape we failed to read.
                    warn('Roobet mines response not recognised - capture skipped. Keys:',
                        Object.keys(payload || {}).join(', '));
                }
                return;
            }
            if (url.includes('/_api/keno/ClassicKeno/play')) {
                const gameData = JSON.parse(responseText);

                if (gameData.id && gameData.numbersDrawn) {
                    log('✅ Roobet Keno game detected (New API):', gameData);
                    const transformedData = transformRoobetKenoData(gameData);
                    if (transformedData) {
                        window.postMessage({
                            type: 'KENO_BET_DATA',
                            data: transformedData,
                            site: site
                        }, '*');
                    }
                }
            }
        } catch (error) {
            log('Roobet response parsing error:', error.message);
        }
    }

    function transformRoobetKenoData(gameData) {
        // Try to get wager data, but also support cases where it's at the top level
        const wager = gameData.wagers && gameData.wagers[0];

        // Extract values from either wager or gameData directly
        const multiplier = parseFloat(
            wager?.multiplier || gameData.multiplier ||
            wager?.payout_multiplier || gameData.payout_multiplier ||
            0
        );

        const payout = parseFloat(
            wager?.payout || gameData.payout ||
            wager?.winnings || gameData.winnings ||
            wager?.profit || gameData.profit ||
            wager?.win || gameData.win ||
            0
        );

        const amount = parseFloat(
            wager?.amount || gameData.amount ||
            wager?.wager || gameData.wager ||
            wager?.bet || gameData.bet ||
            0
        );

        const transformed = {
            id: gameData.id || `keno-${Date.now()}`,
            active: false,
            payoutMultiplier: multiplier,
            payout: payout,
            amount: amount,
            currency: wager?.currency?.toLowerCase() || gameData.currency?.toLowerCase() || 'usd',
            state: {
                drawnNumbers: gameData.numbersDrawn || gameData.drawn_numbers || [],
                selectedNumbers: wager?.selections || gameData.selections || wager?.selected || gameData.selected || [],
                risk: wager?.riskLevel || gameData.riskLevel || wager?.risk || gameData.risk || 'medium'
            },
            timestamp: new Date().toISOString()
        };

        log('🟢 TRANSFORMED Roobet data:', transformed);
        return transformed;
    }

    function handleWinnaResponse(responseText, url, method, requestData) {
        try {
            // Only process the /keno/play endpoint which has complete bet data
            if (url.includes('/keno/play') && !url.includes('/keno/finish')) {
                const response = JSON.parse(responseText);

                // Accept both the flat and `game`-wrapped shapes. Only `tiles` is
                // required — user_tiles is absent on some responses and the stats
                // only need the drawn numbers.
                const bet = unwrapWinnaBet(response);
                if (bet && Array.isArray(bet.data.tiles) && bet.data.tiles.length) {
                    const transformedData = transformWinnaKenoData(response);
                    if (transformedData) {
                        window.postMessage({
                            type: 'KENO_BET_DATA',
                            data: transformedData,
                            site: site
                        }, '*');
                    }
                }
            }
        } catch (error) {
            // Silently handle errors to avoid console spam
            log('Winna response parsing error:', error);
        }
    }

    // Winna's game frame talks socket.io (wss://api2.winna.com/socket.io/), whose
    // frames are engine.io-prefixed — `42["bet",{...}]`, `0{...}`, `40`. A plain
    // JSON.parse throws on all of those, so strip the numeric prefix and, for an
    // event frame, return the payload object rather than the ["name", …] tuple.
    // Plain-JSON sockets still work: the first branch passes them straight through.
    function parseWinnaSocketFrame(raw) {
        const s = String(raw).trim();
        let body = (s[0] === '{' || s[0] === '[') ? s : null;
        if (!body) {
            const m = s.match(/^\d+([\s\S]*)$/);
            if (!m) return null;
            body = m[1].trim();
            if (body[0] !== '{' && body[0] !== '[') return null;
        }
        let json;
        try { json = JSON.parse(body); } catch (e) { return null; }
        if (Array.isArray(json)) return json.find(x => x && typeof x === 'object') || null;
        return json;
    }

    // Unwrap a Winna bet payload. The HTTP /keno/play response carries the bet at
    // the root; the WebSocket message wraps the same object in a `game` envelope.
    function unwrapWinnaBet(payload) {
        if (!payload) return null;
        if (payload.data && payload.data.tiles) return payload;
        if (payload.game && payload.game.data && payload.game.data.tiles) return payload.game;
        return null;
    }

    // Winna reports tiles 0-indexed (0-39), so +1 maps them onto the board's 1-40
    // labels. If a round ever shows every number off by one in the overlay, this
    // is the single knob: set it to 0.
    //
    // A sampled payload can decide it on its own — a 0 can only appear in a
    // 0-indexed feed and a 40 can only appear in a 1-indexed one — so trust that
    // when it's present and fall back to the constant when it isn't. Mixing
    // offsets across rounds would corrupt the stats, so the evidence has to be
    // conclusive before it overrides.
    const WINNA_TILE_OFFSET = 1;
    function winnaTileOffset(values) {
        if (values.includes(0)) return 1;    // 0-indexed feed
        if (values.includes(40)) return 0;   // 1-indexed feed
        return WINNA_TILE_OFFSET;
    }

    function transformWinnaKenoData(payload) {
        const response = unwrapWinnaBet(payload);
        if (!response) return null;

        const rawDrawn = (response.data.tiles || []).map(n => parseInt(n, 10));
        const rawSelected = (response.data.user_tiles || []).map(n => parseInt(n, 10));
        const offset = winnaTileOffset(rawDrawn.concat(rawSelected).filter(n => !isNaN(n)));

        const transformed = {
            id: response.id || `keno-${Date.now()}`,
            active: false,
            payoutMultiplier: parseFloat(response.multiplier) || 0,
            payout: parseFloat(response.profit) || 0,
            amount: parseFloat(response.wager) || 0,
            currency: response.currency?.toLowerCase() || response.coin?.toLowerCase() || 'usd',
            state: {
                drawnNumbers: rawDrawn.map(num => num + offset)
                    .filter(num => !isNaN(num) && num >= 1 && num <= 40),
                selectedNumbers: rawSelected.map(num => num + offset)
                    .filter(num => !isNaN(num) && num >= 1 && num <= 40),
                risk: response.data.risk || response.type || 'classic'
            },
            timestamp: new Date().toISOString()
        };

        log('Winna raw tiles:', rawDrawn, '→ offset', offset, '→ drawn', transformed.state.drawnNumbers);
        log('Transformed Winna Keno data:', transformed);
        return transformed;
    }

    function handleAcebetResponse(responseText, url, method, requestData) {
        try {
            // Only process POST requests to /api/keno
            if (url.includes('/api/keno') && method === 'POST') {
                const response = JSON.parse(responseText);

                // Check if we have the required data
                if (response.id && response.userPicks && response.kenoPicks) {
                    log('✅ Acebet Keno game detected:', response);
                    const transformedData = transformAcebetKenoData(response);
                    if (transformedData) {
                        window.postMessage({
                            type: 'KENO_BET_DATA',
                            data: transformedData,
                            site: site
                        }, '*');
                    }
                }
            }
        } catch (error) {
            log('Acebet response parsing error:', error);
        }
    }

    function transformAcebetKenoData(response) {
        if (!response || !response.userPicks || !response.kenoPicks) return null;

        const transformed = {
            id: response.id || `keno-${Date.now()}`,
            active: false,
            payoutMultiplier: parseFloat(response.multiplier) || 0,
            payout: parseFloat(response.payout) || 0,
            amount: parseFloat(response.betAmount) || 0,
            currency: response.currency?.toLowerCase() || 'usd',
            state: {
                drawnNumbers: response.kenoPicks.filter(num => !isNaN(num) && num >= 1 && num <= 40),
                selectedNumbers: response.userPicks.filter(num => !isNaN(num) && num >= 1 && num <= 40),
                risk: 'classic' // Acebet doesn't specify risk in the response
            },
            timestamp: new Date().toISOString()
        };

        log('Transformed Acebet Keno data:', transformed);
        return transformed;
    }

    function handleShuffleResponse(responseText, url, method, requestData) {
        try {
            const response = JSON.parse(responseText);

            if (response.data && response.data.kenoPlay) {
                log('✅ Shuffle Keno game detected:', response.data.kenoPlay);
                const transformedData = transformShuffleKenoData(response.data.kenoPlay);
                if (transformedData) {
                    window.postMessage({
                        type: 'KENO_BET_DATA',
                        data: transformedData,
                        site: site
                    }, '*');
                }
            }
        } catch (error) {
            log('Shuffle response parsing error:', error.message);
        }
    }

    function transformShuffleKenoData(gameData) {
        const kenoAction = gameData.shuffleOriginalActions?.[0]?.action?.keno;
        if (!kenoAction) {
            log('Shuffle: No keno action found');
            return null;
        }

        // Parse multiplier correctly - Shuffle sends it as a string sometimes
        const multiplier = parseFloat(gameData.multiplier) || parseFloat(kenoAction.multiplier) || 0;

        const transformed = {
            id: gameData.id || `keno-${Date.now()}`,
            active: false,
            payoutMultiplier: multiplier,
            payout: parseFloat(gameData.payout) || 0,
            amount: parseFloat(gameData.amount) || 0,
            currency: gameData.currency?.toLowerCase() || 'btc',
            state: {
                drawnNumbers: (kenoAction.results || []).map(num => parseInt(num, 10))
                    .filter(num => !isNaN(num) && num >= 1 && num <= 40),
                selectedNumbers: (kenoAction.selected || []).map(num => parseInt(num, 10))
                    .filter(num => !isNaN(num) && num >= 1 && num <= 40),
                risk: kenoAction.risk?.toLowerCase().replace('_risk', '') || 'classic'
            },
            timestamp: new Date().toISOString()
        };

        log('🟢 TRANSFORMED Shuffle data:', transformed);
        return transformed;
    }

    function transformRainbetKenoData(response, requestData) {
        log('🔵 RAW Rainbet Keno data:', response);

        // Extract bet amount from request
        let betAmount = 0;
        if (requestData) {
            try {
                const requestBody = JSON.parse(requestData);
                betAmount = parseFloat(requestBody.amount ?? requestBody.bet_amount ?? requestBody.betAmount) || 0;
            } catch (e) {
                log('Could not parse Rainbet request data for amount');
            }
        }

        // Response is nested: { game_result: {...}, keno_result: {...} }
        const gameResult = response.game_result || response;
        const kenoResult = response.keno_result || response;

        // The request capture can miss (or name the field differently) — the
        // response's game_result carries bet_amount itself, so fall back to it.
        // Without this every Rainbet bet stored amount 0 and P/L showed "—".
        if (!betAmount) {
            betAmount = parseFloat(gameResult.bet_amount ?? response.bet_amount) || 0;
        }

        const rawDrawn = kenoResult.drawn_numbers || kenoResult.drawnNumbers || [];
        const rawSelected = kenoResult.selected_numbers || kenoResult.selectedNumbers || [];

        const payout = parseFloat(gameResult.payout || response.payout || 0);

        const transformed = {
            id: gameResult.game_history_id || response.id || `keno-${Date.now()}`,
            active: false,
            payoutMultiplier: parseFloat(gameResult.multiplier || response.multiplier || 0),
            payout: payout,
            amount: betAmount,
            currency: (gameResult.currency || response.currency || 'usd').toLowerCase(),
            state: {
                // Rainbet Extreme mode draws numbers 1–56; classic/low/medium/hard go up to 40.
                // Accept the full Extreme range; overlay.js filters per-mode on read.
                drawnNumbers: rawDrawn.map(num => parseInt(num, 10))
                    .filter(num => !isNaN(num) && num >= 1 && num <= 56),
                selectedNumbers: rawSelected.map(num => parseInt(num, 10))
                    .filter(num => !isNaN(num) && num >= 1 && num <= 56),
                risk: (kenoResult.difficulty || response.difficulty || 'classic').toLowerCase().replace('_risk', '')
            },
            timestamp: new Date().toISOString()
        };

        log('🟢 TRANSFORMED Rainbet Keno data:', transformed);
        return transformed;
    }

    function transformRainbetPlinkoData(plinkoData) {
        log('🔵 RAW Rainbet Plinko data:', plinkoData);

        const transformed = {
            id: plinkoData.id || `plinko-${Date.now()}`,
            active: false,
            payoutMultiplier: parseFloat(plinkoData.multiplier) || 0,
            payout: parseFloat(plinkoData.payout) || 0,
            amount: parseFloat(plinkoData.bet) || 0,
            currency: plinkoData.currency?.toLowerCase() || 'usd',
            seed: plinkoData.seed || 'unknown',
            state: {
                risk: plinkoData.risk?.toLowerCase() || 'medium',
                rows: parseInt(plinkoData.rows) || 16
            },
            timestamp: new Date().toISOString()
        };

        log('🟢 TRANSFORMED Rainbet Plinko data:', transformed);
        return transformed;
    }

    // Rainbet mines, from an observed cashout response:
    //   { multiplier, payout, win, success, revealedCellsCount, betId,
    //     board: ["M",0,0,0,"M",0,0,"M",0,"M",0,"M",0, ...] }   // 25 entries
    // The mine positions are the indices holding "M". This used to read
    // minesData.mines and minesData.rounds, neither of which Rainbet sends, so
    // state.mines came out empty on every round and nothing was ever stored --
    // the reason mines never worked here even when the request was intercepted.
    // A per-click reveal ({ multiplier, cell, revealedCellsCount }) carries no
    // board, so only the finished round is transformed.
    // Rainbet never puts the stake in a mines RESPONSE -- not in the opening
    // board, not in a reveal, not in the final board. It is only in the request
    // that opens the round, so it is stashed by betId there and attached when
    // the round resolves. Without this, mines P/L on Rainbet reads as zero.
    const rainbetMinesStake = Object.create(null);
    function rememberRainbetStake(betId, requestData) {
        if (!betId || !requestData) return;
        let body = requestData;
        if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { return; } }
        if (!body || typeof body !== 'object') return;
        const keys = ['betAmount', 'amount', 'bet', 'wager', 'stake', 'value'];
        for (const k of keys) {
            const v = parseFloat(body[k]);
            if (Number.isFinite(v) && v > 0) { rainbetMinesStake[betId] = v; return; }
        }
        // Say what WAS there, so the field can be named rather than guessed at.
        warn('Rainbet mines: no stake field in the opening request. Keys:',
            Object.keys(body).join(', '));
    }

    function transformRainbetMinesData(minesData) {
        const board = Array.isArray(minesData.board) ? minesData.board
                    : (Array.isArray(minesData.grid) ? minesData.grid : null);
        if (!board) return null;
        // Rainbet sends a board three times per round, and only the last one is
        // the result:
        //   place bet  -> every cell "X" (hidden)
        //   reveal     -> no board at all, just { cell, revealedCellsCount }
        //   cashout    -> 0 for safe, "M" for mine, nothing hidden
        //   lost       -> same, plus cell:"M", multiplier 0, win false
        // Treating the opening board as a result would file a finished round with
        // no mines on every bet, so a board with any cell still hidden is not one.
        if (board.some(v => String(v).toUpperCase() === 'X')) return null;
        const mines = [];
        board.forEach((v, i) => {
            const cell = String(v).toUpperCase();
            if (cell === 'M' || cell === 'MINE' || cell === 'BOMB') mines.push(i);
        });
        const num = v => parseFloat(v) || 0;
        return {
            id: minesData.betId || minesData.id || `mines-${Date.now()}`,
            active: false,                       // a board only arrives once the round ends
            payoutMultiplier: num(minesData.multiplier ?? minesData.payoutMultiplier),
            payout: num(minesData.payout),
            amount: num(minesData.betAmount ?? minesData.bet ?? minesData.amount)
                    || rainbetMinesStake[minesData.betId] || 0,
            currency: String(minesData.currency || 'usd').toLowerCase(),
            state: {
                mines,
                rounds: [],                      // Rainbet reports a count, not the tiles
                minesCount: mines.length || parseInt(minesData.minesCount || minesData.mines) || 3
            },
            revealed: parseInt(minesData.revealedCellsCount) || 0,
            timestamp: new Date().toISOString()
        };
    }

    function handleRainbetResponse(responseText, url, method, requestData) {
        try {
            const response = JSON.parse(responseText);

            // Only process game-specific responses, ignore balance updates and other noise
            if (isRainbetKenoURL(url)) {
                // Some routes wrap the result: { data: { keno_result … } }
                const payload = (response && response.data && (response.data.keno_result || response.data.game_result))
                    ? response.data
                    : response;
                const looksLikeKeno = payload && (payload.keno_result || payload.drawnNumbers ||
                    payload.drawn_numbers || payload.game_result || payload.success);
                if (!looksLikeKeno) {
                    // Don't fail silently: a shape change here is exactly how
                    // Rainbet capture stops without anything in the console.
                    warn('Rainbet keno response not recognised — capture skipped. Keys:', Object.keys(response || {}).join(', '));
                    return;
                }
                log('Rainbet Keno game detected:', payload);

                const transformedData = transformRainbetKenoData(payload, requestData);
                if (!transformedData.state.drawnNumbers.length) {
                    warn('Rainbet keno payload had no drawn numbers — capture skipped. Keys:',
                        Object.keys(payload).join(', '));
                    return;
                }

                window.postMessage({
                    type: 'KENO_BET_DATA',
                    data: transformedData,
                    site: site
                }, '*');
            }
            else if (url.includes('/v1/games/plinko/play') && response.data) {
                log('✅ Rainbet Plinko game detected:', response.data);
                const transformedData = transformRainbetPlinkoData(response.data);
                window.postMessage({
                    type: 'PLINKO_BET_DATA',
                    data: transformedData,
                    site: site
                }, '*');
            }
            else if (isRainbetMinesURL(url)) {
                // Same treatment keno already gets: match the game rather than a
                // path, and say so when a mines response arrives in a shape we
                // cannot read, instead of dropping it silently.
                const minesPayload = response.data || response.game || response;
                // The opening board is where the stake is available to capture.
                if (minesPayload && Array.isArray(minesPayload.board)
                    && minesPayload.board.every(v => String(v).toUpperCase() === 'X')) {
                    rememberRainbetStake(minesPayload.betId, requestData);
                }
                const transformedData = minesPayload && transformRainbetMinesData(minesPayload);
                if (transformedData) delete rainbetMinesStake[transformedData.id];
                if (transformedData) {
                    log('✅ Rainbet Mines round finished:', transformedData.state);
                    window.postMessage({
                        type: 'MINES_BET_DATA',
                        data: transformedData,
                        site: site
                    }, '*');
                } else if (minesPayload && minesPayload.cell === undefined
                           && minesPayload.revealedCellsCount === undefined) {
                    // A reveal has cell/revealedCellsCount and no board; that is the
                    // round still running, not a failure. Anything else is a shape
                    // we do not know about.
                    warn('Rainbet mines response not recognised - capture skipped. Keys:',
                        Object.keys(minesPayload || {}).join(', '));
                }
            }
            // Removed balance update logging - it spams and slows down Rainbet

        } catch (error) {
            log('Rainbet response parsing error:', error.message);
        }
    }

    function handleStakeResponse(responseText, url, method, requestData) {
        try {
            const response = JSON.parse(responseText);
            log('🎯 Processing Stake response from:', url);

            if (url.includes('graphql') || url.includes('_api/graphql')) {
                handleStakeGraphQLResponse(response, requestData);
                return;
            }

            if (url.includes('/keno/') && (response.kenoBet || response.data)) {
                const kenoData = response.kenoBet || response.data;
                if (kenoData && kenoData.state && kenoData.state.drawnNumbers) {
                    log('✅ Stake Keno game detected:', kenoData);

                    // ✅ ADD THIS LINE
                    const transformedData = transformStakeKenoData(kenoData);

                    window.postMessage({
                        type: 'KENO_BET_DATA',
                        data: transformedData,
                        site: site
                    }, '*');
                }
            }

            if (response.plinkoBet) {
                log('✅ Stake Plinko game detected:', response.plinkoBet);
                window.postMessage({
                    type: 'PLINKO_BET_DATA',
                    data: response.plinkoBet,
                    site: site
                }, '*');
            }

            if (response.minesBet || response.minesNext || response.minesCashout) {
                const minesData = response.minesBet || response.minesNext || response.minesCashout;
                log('✅ Stake Mines game detected:', minesData);
                window.postMessage({
                    type: 'MINES_BET_DATA',
                    data: minesData,
                    site: site
                }, '*');
            }

        } catch (error) {
            log('Stake response parsing error:', error.message);
        }
    }

    function handleStakeGraphQLResponse(response, requestData) {
        try {
            let requestBody = null;
            if (requestData) {
                try {
                    requestBody = typeof requestData === 'string' ? JSON.parse(requestData) : requestData;
                } catch (e) {
                    
                }
            }

            log('🔍 Stake GraphQL response analysis...');

            if (response.data) {
                const gameData = findKenoDataInResponse(response.data);

                if (gameData) {
                    log('✅ Stake Keno found in GraphQL response:', gameData);

                    const transformedData = transformStakeKenoData(gameData);

                    window.postMessage({
                        type: 'KENO_BET_DATA',
                        data: transformedData,
                        site: site
                    }, '*');
                }
            }

        } catch (error) {
            console.error('Stake GraphQL response handling error:', error);
        }
    }

    function findKenoDataInResponse(data) {
        function searchForKeno(obj, path = '') {
            if (!obj || typeof obj !== 'object') return null;

            // Priority 1: Object with ID and drawnNumbers (or state containing it)
            if (obj.id && (obj.drawnNumbers || (obj.state && obj.state.drawnNumbers))) {
                log('Found complete Keno bet object at path:', path);
                return obj;
            }

            // Priority 2: Traditional drawnNumbers check
            if (obj.drawnNumbers && Array.isArray(obj.drawnNumbers)) {
                log('Found drawnNumbers at path:', path);
                return obj;
            }

            // Priority 3: Game name check
            if (obj.game === 'keno' || obj.gameType === 'keno' || obj.type === 'keno') {
                log('Found Keno game object at path:', path);
                return obj;
            }

            for (const key in obj) {
                if (obj.hasOwnProperty(key)) {
                    // Avoid recursion into very deep or cyclical objects if necessary,
                    // but for GraphQL responses this is usually fine.
                    const result = searchForKeno(obj[key], path + '.' + key);
                    if (result) return result;
                }
            }

            return null;
        }

        return searchForKeno(data);
    }

    function transformStakeKenoData(gameData) {
        const rawDrawn = gameData.state?.drawnNumbers || gameData.drawnNumbers || gameData.numbers || [];
        const rawSelected = gameData.state?.selectedNumbers || gameData.selectedNumbers || gameData.picks || [];

        console.log('🔵 RAW Stake data:', gameData);
        console.log('🔍 Stake amount fields:', {
            amount: gameData.amount,
            bet: gameData.bet,
            betAmount: gameData.betAmount,
            stateAmount: gameData.state?.amount,
            amountMultiplier: gameData.amountMultiplier,
            currency: gameData.currency
        });

        // Try multiple field names for payout
        const payout = parseFloat(
            gameData.payout || gameData.payoutValue ||
            gameData.winnings || gameData.profit ||
            gameData.win || gameData.amount_won ||
            gameData.state?.payout || 0
        );

        // Real wagered amount (0 for free / $0 bets). NOT amountMultiplier — on
        // Stake that is a bet-size multiplier (≈1), not the wager, so using it made
        // free bets look paid and polluted P/L. Nullish-coalesce so a true 0 wager
        // is preserved instead of falling through to the next field.
        const betAmount = parseFloat(
            gameData.amount ?? gameData.bet ?? gameData.betAmount ?? gameData.state?.amount ?? 0
        );

        const transformed = {
            id: gameData.id || `keno-${Date.now()}`,
            active: gameData.active || false,
            payoutMultiplier: parseFloat(gameData.payoutMultiplier || gameData.multiplier || gameData.state?.payoutMultiplier || 0),
            payout: payout,
            amount: betAmount,
            currency: gameData.currency?.toLowerCase() || 'btc',
            state: {
                drawnNumbers: rawDrawn.map(num => parseInt(num, 10) + 1)
                    .filter(num => !isNaN(num) && num >= 1 && num <= 40),
                selectedNumbers: rawSelected.map(num => parseInt(num, 10) + 1)
                    .filter(num => !isNaN(num) && num >= 1 && num <= 40),
                risk: gameData.state?.risk || gameData.risk || 'classic'
            },
            timestamp: gameData.timestamp || new Date().toISOString()
        };

        log('🟢 TRANSFORMED Stake data:', transformed);
        return transformed;
    }

    // ===================================================================
    // WEBSOCKET INTERCEPTOR FOR BETFURY.COM
    // ===================================================================
    if (site.includes('betfury.com')) {
        log('✅ BetFury WebSocket interceptor initialized');
        log('   Site:', site);

        const OriginalWebSocket = window.WebSocket;
        window.WebSocket = cloak(function WebSocket(...args) {
            const ws = new OriginalWebSocket(...args);

            log('🔌 WebSocket connection opened:', args[0]);

            const originalSend = ws.send;
            ws.send = function(data) {
                // Only log Keno-related sends
                if (data && data.toString().toLowerCase().includes('keno')) {
                    log('📤 WebSocket KENO send:', data);
                }
                return originalSend.apply(this, arguments);
            };

            ws.addEventListener('message', function(event) {
                try {
                    const dataStr = event.data.toString();
                    const dataStrLower = dataStr.toLowerCase();
                    const containsKeno = dataStrLower.includes('keno');
                    const containsGameResult = dataStrLower.includes('gameresult');

                    // Only log game-related messages to reduce spam
                    if (containsKeno || containsGameResult) {
                        log('📨 BetFury game message');
                        log('   Full message:', dataStr);
                    }

                    // BetFury uses Socket.io format: "42["event", {data}, null]"
                    // Strip the Socket.io prefix (e.g., "42") and parse
                    let rawData = event.data;
                    if (typeof rawData === 'string' && /^\d+/.test(rawData)) {
                        rawData = rawData.replace(/^\d+/, ''); // Remove numeric prefix
                    }

                    const parsed = JSON.parse(rawData);

                    // Check if this is Socket.io array format: [event, data, ...]
                    if (Array.isArray(parsed) && parsed.length >= 2) {
                        const eventName = parsed[0];
                        const eventData = parsed[1];

                        // Only log game-related events to reduce spam
                        const gameRelated = eventName && typeof eventName === 'string' && (
                            eventName.toLowerCase().includes('game') ||
                            eventName.toLowerCase().includes('bet') ||
                            eventName.toLowerCase().includes('result') ||
                            eventName.toLowerCase().includes('play') ||
                            eventName.toLowerCase().includes('keno')
                        );

                        if (gameRelated) {
                            log('Game event detected:', eventName);
                        }

                        if (containsKeno || eventName.toLowerCase().includes('keno')) {
                            log('📥 KENO Event:', eventName);
                            log('📥 KENO Data:', eventData);
                        }

                        // Check if this is a Keno event
                        if (eventName === 'kenobethistory' || eventName.toLowerCase().includes('keno')) {
                            handleBetFuryWebSocketMessage(eventData);
                        }

                        // AGGRESSIVE: Try to process ANY event that looks like game data
                        if (eventData && typeof eventData === 'object') {
                            // Check if it has Keno-like fields even without "keno" in the name
                            if (eventData.roll_number || eventData.selected ||
                                (eventData.drawnNumbers && eventData.selectedNumbers)) {
                                log('Possible Keno data in event:', eventName, eventData);
                                handleBetFuryWebSocketMessage(eventData);
                            }
                        }
                    } else {
                        // Handle regular JSON format
                        const isKenoRelated = containsKeno ||
                                             parsed.game === 'keno' ||
                                             parsed.gameName === 'keno' ||
                                             parsed.tableType === 'KENO' ||
                                             parsed.gameType === 'keno' ||
                                             parsed.tableName?.toLowerCase().includes('keno');

                        if (isKenoRelated) {
                            log('📥 KENO JSON parsed:', parsed);
                            handleBetFuryWebSocketMessage(parsed);
                        }
                    }
                } catch (error) {
                    // Not JSON or parsing error - ignore silently
                }
            });

            return ws;
        }, 'function WebSocket() { [native code] }');
        window.WebSocket.prototype = OriginalWebSocket.prototype;
    }

    // ===================================================================
    // WEBSOCKET INTERCEPTOR FOR WINNA.COM (games.winna.com)
    // ===================================================================
    if (site.includes('winna.com') || site.includes('games.winna.com')) {
        const OriginalWebSocket = window.WebSocket;
        window.WebSocket = cloak(function WebSocket(...args) {
            const ws = new OriginalWebSocket(...args);

            ws.addEventListener('message', function(event) {
                try {
                    const dataStr = event.data;
                    if (typeof dataStr !== 'string') return;

                    const parsed = parseWinnaSocketFrame(dataStr);
                    if (!parsed) return;

                    // Only process the settled message (it carries `wager`). An
                    // in-progress message can already have tiles; capturing it
                    // would store multiplier 0 and the real result would then be
                    // dropped by the background's dedupe-by-id.
                    // Test for the FIELD, not a truthy value — a settled round can
                    // legitimately report wager 0, and `bet.wager` would drop it.
                    const bet = unwrapWinnaBet(parsed);
                    if (bet && bet.wager !== undefined) {
                        log('📥 Winna Keno WebSocket message:', parsed);
                        const transformedData = transformWinnaKenoData(parsed);
                        if (transformedData) {
                            window.postMessage({
                                type: 'KENO_BET_DATA',
                                data: transformedData,
                                site: site
                            }, '*');
                        }
                    }
                } catch (error) {
                    // Not JSON or parsing error - ignore silently
                }
            });

            return ws;
        }, 'function WebSocket() { [native code] }');
        window.WebSocket.prototype = OriginalWebSocket.prototype;
    }

    function handleBetFuryWebSocketMessage(data) {
        try {
            // DEBUG: Log all BetFury messages to understand their format
            log('🔍 BetFury WebSocket message:', data);
            log('   Message keys:', Object.keys(data));
            log('   Has roll_number?', !!data.roll_number);
            log('   Has selected?', !!data.selected);
            log('   Message type:', data.type || data.event || 'none');

            // BetFury uses different message formats
            // Look for keno game results in the message

            // Check if this looks like BetFury Keno data (has roll_number and selected fields)
            if (data.roll_number && data.selected) {
                log('BetFury Keno game detected (kenobethistory):', data);
                const transformedData = transformBetFuryKenoData(data);
                if (transformedData) {
                    log('Posting KENO_BET_DATA:', transformedData);
                    window.postMessage({
                        type: 'KENO_BET_DATA',
                        data: transformedData,
                        site: site
                    }, '*');
                }
                return; // Processed successfully
            }

            // Check if this is a keno result message (other formats)
            if (data.type === 'game.result' || data.event === 'game.result' ||
                data.game === 'keno' || data.gameName === 'keno' ||
                data.tableType === 'KENO' || data.gameType === 'keno' ||
                (data.tableName && data.tableName.toLowerCase().includes('keno'))) {
                log('✅ BetFury Keno game detected:', data);
                const transformedData = transformBetFuryKenoData(data);
                if (transformedData) {
                    window.postMessage({
                        type: 'KENO_BET_DATA',
                        data: transformedData,
                        site: site
                    }, '*');
                }
            }

            // Also check nested data structures
            if (data.data && (data.data.game === 'keno' || data.data.gameName === 'keno' ||
                data.data.tableType === 'KENO' ||
                (data.data.tableName && data.data.tableName.toLowerCase().includes('keno')))) {
                log('✅ BetFury Keno game detected (nested):', data.data);
                const transformedData = transformBetFuryKenoData(data.data);
                if (transformedData) {
                    window.postMessage({
                        type: 'KENO_BET_DATA',
                        data: transformedData,
                        site: site
                    }, '*');
                }
            }

            // Check for result in payload
            if (data.payload && data.payload.result) {
                const result = data.payload.result;
                if (result.game === 'keno' || result.gameName === 'keno' ||
                    result.tableType === 'KENO' ||
                    (result.tableName && result.tableName.toLowerCase().includes('keno')) ||
                    (result.drawnNumbers && result.selectedNumbers)) {
                    log('✅ BetFury Keno game detected (payload):', result);
                    const transformedData = transformBetFuryKenoData(result);
                    if (transformedData) {
                        window.postMessage({
                            type: 'KENO_BET_DATA',
                            data: transformedData,
                            site: site
                        }, '*');
                    }
                }
            }
        } catch (error) {
            log('BetFury WebSocket handler error:', error);
        }
    }

    function transformBetFuryKenoData(gameData) {
        // Extract drawn numbers - BetFury uses "roll_number" field
        const drawnNumbers = gameData.roll_number ||        // BetFury specific
                            gameData.drawnNumbers ||
                            gameData.drawn_numbers ||
                            gameData.result ||
                            gameData.numbers ||
                            gameData.drawnBalls ||
                            [];

        // Extract selected numbers - BetFury uses "selected" field
        const selectedNumbers = gameData.selected ||        // BetFury specific
                               gameData.selectedNumbers ||
                               gameData.selected_numbers ||
                               gameData.picks ||
                               gameData.selection ||
                               gameData.selectedBalls ||
                               [];

        // Extract bet amount
        const amount = gameData.amount ||
                      gameData.bet ||
                      gameData.betAmount ||
                      gameData.wager ||
                      0;

        // Extract payout and multiplier - BetFury uses "winAmount" and "multi"
        const payout = gameData.winAmount ||               // BetFury specific
                      gameData.payout ||
                      gameData.win ||
                      0;

        const multiplier = gameData.multi ||               // BetFury specific
                          gameData.multiplier ||
                          gameData.payoutMultiplier ||
                          gameData.coefficient ||
                          0;

        // Validate we have the essential data
        if (!drawnNumbers || drawnNumbers.length === 0) {
            log('BetFury: No drawn numbers found in data');
            return null;
        }

        const transformed = {
            id: gameData._id || gameData.id || gameData.gameId || gameData.betId || `keno-${Date.now()}`,
            active: gameData.active || false,
            payoutMultiplier: parseFloat(multiplier) || 0,
            payout: parseFloat(payout) || 0,
            amount: parseFloat(amount) || 0,
            currency: gameData.currency?.toLowerCase() || 'btc',
            state: {
                drawnNumbers: drawnNumbers.map(num => parseInt(num, 10))
                    .filter(num => !isNaN(num) && num >= 1 && num <= 40),
                selectedNumbers: selectedNumbers.map(num => parseInt(num, 10))
                    .filter(num => !isNaN(num) && num >= 1 && num <= 40),
                risk: gameData.risk?.toLowerCase() || 'classic'
            },
            timestamp: gameData.timestamp || gameData.createdAt || new Date().toISOString()
        };

        log('🟢 TRANSFORMED BetFury data:', transformed);
        return transformed;
    }

    let lastURL = location.href;
    new MutationObserver(() => {
        const url = location.href;
        if (url !== lastURL) {
            lastURL = url;
            if (url.includes('keno')) {
                log('🎯 Navigated to Keno page, monitoring for games...');
            }
        }
    }).observe(document, { subtree: true, childList: true });

})();