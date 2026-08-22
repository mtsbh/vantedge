(function () {
    'use strict';

    if (window.geminyzerOverlay) return;

    const OVERLAY_BUILD = '3.26';
    // Logged on every page of a supported site, before anything else can fail.
    // If this line is missing from the console, the script isn't being injected
    // at all (stale extension, or the page isn't in the manifest's match list)
    // — as opposed to being injected and declining to mount.
    console.log(`Vantedge: overlay script loaded (build ${OVERLAY_BUILD}, path ${location.pathname})`);

    function safe(fn, context = 'General') {
        try {
            return fn();
        } catch (e) {
            console.error(`Vantedge Overlay Error in ${context}:`, e);
            return null;
        }
    }

    // Money math + formatting live in money.js (loaded just ahead of this file
    // by the manifest) so the overlay, popup and service worker all count P/L
    // the same way.
    if (!self.VantedgeMoney) {
        console.error('Vantedge: money.js did not load before overlay.js — check the extension files. Overlay disabled.');
        return;
    }
    const { curKey, curEpsilon, fmtMoney, betProfit } = self.VantedgeMoney;

    // Shared heat palette for both grids (keno numbers, mines tiles): neutral
    // gray at the expected rate, brown fill + amber edge above it, steel fill +
    // blue edge below. `ratio` is observed/expected; maxAbove/maxBelow are the
    // observed spread either side of 1, so the tint scales to the data instead
    // of washing out once counts converge.
    const HEAT = {
        top: [47, 56, 69], bot: [36, 44, 56], border: [72, 80, 94],
        hotFill: [112, 74, 38], hotEdge: [206, 138, 60],
        coldFill: [40, 80, 116], coldEdge: [72, 144, 198]
    };
    function heatStyle(ratio, maxAbove, maxBelow) {
        let fillTgt, edgeTgt, t;
        if (ratio >= 1) {
            t = maxAbove > 0 ? Math.min((ratio - 1) / maxAbove, 1) : 0;
            fillTgt = HEAT.hotFill; edgeTgt = HEAT.hotEdge;
        } else {
            t = maxBelow > 0 ? Math.min((1 - ratio) / maxBelow, 1) : 0;
            fillTgt = HEAT.coldFill; edgeTgt = HEAT.coldEdge;
        }
        const mix = (a, b) => Math.round(a + (b - a) * t);
        const rgb = (base, tgt) => `rgb(${mix(base[0], tgt[0])}, ${mix(base[1], tgt[1])}, ${mix(base[2], tgt[2])})`;
        return {
            background: `linear-gradient(180deg, ${rgb(HEAT.top, fillTgt)}, ${rgb(HEAT.bot, fillTgt)})`,
            borderColor: rgb(HEAT.border, edgeTgt),
            color: '#eef3f8'
        };
    }
    // What an untouched cell looks like before any history exists.
    const HEAT_EMPTY = {
        background: 'linear-gradient(180deg, rgb(47,56,69), rgb(36,44,56))',
        borderColor: 'rgba(255,255,255,0.05)',
        color: '#8b949e'
    };
    // Spread of ratios either side of 1, for scaling the tint.
    function heatSpread(counts, expected) {
        let maxAbove = 0, maxBelow = 0;
        if (expected > 0) {
            for (let i = 0; i < counts.length; i++) {
                const r = counts[i] / expected;
                if (r > 1) { if (r - 1 > maxAbove) maxAbove = r - 1; }
                else if (1 - r > maxBelow) maxBelow = 1 - r;
            }
        }
        return { maxAbove, maxBelow };
    }

    class GeminyzerOverlay {
        constructor() {
            this.isVisible = true;
            this.isMinimized = false;
            this.isDragging = false;
            this.layoutMode = 'overlay';
            this.dragStart = { x: 0, y: 0 };
            this.position = { x: 20, y: 100 };
            this.stakeKenoButtons = [];
            this.correlationData = null;
            this.mutationObserver = null;
            this.cachedButtons = null;
            this.lastCacheTime = 0;
            this.currentActiveButton = null;
            this.storageListenerAdded = false;
            this.cachedKenoResults = null;
            this.CACHE_DURATION = 30000; // 30 seconds
            this.heatmapCells = []; // Cache heatmap cells for performance
            this.strategyToggles = {
                variance: false  // high=9, low=5
            };
            // Hot Groups: saved favorites (number-set keys) + favorites-only filter,
            // plus current group size (2-10) and ranking view (hot/frequent/overdue/cold).
            this.comboFavorites = [];
            this.showFavoritesOnly = false;
            this.hotGroupSize = 4;
            this.hotGroupView = 'hot';
            this.smartPickView = 'pattern';
            this.smartPickSize = 6;
            // Strategy grid view: 'main' (core 16) or 'alt' (alternative set).
            this.strategyView = 'main';
            this._momentum = null;
            // Mines mode: which mine count the board is filtered to, and the
            // finished rounds behind it (see the "Mines mode" section below).
            this.gameMode = 'keno';
            this.minesCount = null;
            this._minesGames = [];
            // Storage listeners get removed on teardown — the site can route in
            // and out of a game many times in one page load.
            this._storageListeners = [];
            // Bump when the curated main/drawer strategy set changes so a stale saved
            // strategyOrder/sideDrawerStrategies is reset to the new defaults once.
            this.LAYOUT_VERSION = 3;

            const browserAPI = (typeof browser !== 'undefined' && browser?.storage) ? browser :
                (typeof chrome !== 'undefined' && chrome?.storage) ? chrome : null;
            if (browserAPI && browserAPI.storage && browserAPI.storage.local) {
                browserAPI.storage.local.get(['strategyToggles', 'comboFavorites'], (result) => {
                    if (result && result.strategyToggles) {
                        this.strategyToggles = result.strategyToggles;
                    }
                    if (result && Array.isArray(result.comboFavorites)) {
                        this.comboFavorites = result.comboFavorites;
                        safe(() => this.renderHotCombos());
                    }
                });
            }

            // Storage origin for Winna: game runs in games.winna.com iframe,
            // so data is stored under that origin, not winna.com
            this.storageOrigin = this.getStorageOrigin();

            // Number pool: 40 default; Rainbet "Extreme" mode = 56 (auto-detected).
            // gridCols stays 8 in all known variants; rows scale with count.
            this.numberCount = 40;
            this.gridCols = 8;
            this.gridRows = 5;

            this.data = {
                kenoStats: {
                    totalBets: 0,
                    lifetimeBets: 0,
                    hotNumbers: new Array(this.numberCount).fill(0),
                    lastDrawn: [],
                    perNumberStats: Array.from({ length: this.numberCount }, () => ({
                        count: 0,
                        betsSince: 0,
                        lastOccurrences: [],
                        lastBetIndex: -1,
                        avgInterval: 0,
                        entropy: 0
                    }))
                },
                selectedNumbers: new Set(),
            };
            this.performanceMetrics = {
                overdue: { avgTime: 0, calls: 0 }
            };

            this.strategyExplanations = {
                // Row 1: Core Fundamentals
                hot: { name: "Hot", method: "Frequency Analysis", description: "Selects the most frequently drawn numbers from all recorded games.", usage: "Best for: Following long-term trends. Top performer!" },
                cold: { name: "Cold", method: "Inverse Frequency", description: "Chooses the least frequently drawn numbers, based on mean-reversion theory.", usage: "Best for: Contrarian betting." },
                smart: { name: "Smart", method: "Dynamic Percentile Zoning", description: "Uses percentile-based zones (top 25%, middle 50%, bottom 25%) for balanced coverage with randomized sampling.", usage: "Best for: Comprehensive board coverage with reduced variance." },
                random: { name: "Random", method: "True Random Selection", description: "Randomly selects 9 numbers with no bias or pattern analysis.", usage: "Best for: Avoiding personal bias, baseline comparison." },

                // Row 2: Statistical Analysis
                overdue: { name: "Overdue", method: "Regression to Mean", description: "Selects numbers with highest overdue score (betsSince > 1.5x avgInterval). Uses regression to mean theory to find 'due' numbers.", usage: "Best for: Exploiting mean reversion on numbers that should appear soon." },
                variance: { name: "Variance", method: "Chi-Square/Z-Score", description: "Uses statistical tests (Chi-Square or Z-Score) to find numbers with significant deviations from expected frequency.", usage: "Best for: High-confidence statistical analysis." },
                positional: { name: "Positional", method: "Grid Zone Analysis + Chi-Square", description: "Analyzes 8x5 grid with chi-square validation to detect statistically significant row/column biases (p<0.05).", usage: "Best for: Scientific detection of spatial RNG biases. Top performer on Stake!" },
                hotzone: { name: "Hotzone", method: "2-D Grid-Block Density", description: "Sibling of Positional that scans 2×2 blocks of the board instead of whole rows/columns, so it catches a bias localized to a corner or the center that row/column averages dilute away. Z-score gated; weights the spatial signal by block significance and falls back to Hot when no zone is real.", usage: "Best for: Localized spatial RNG hotspots that Positional's marginals miss." },
                progressive: { name: "Progressive", method: "Momentum Analysis", description: "Calculates a momentum score (frequency / recency) to find accelerating numbers.", usage: "Best for: Spotting numbers heating up now." },

                // Row 3: Advanced Methods
                transition: { name: "Transition", method: "Cold-to-Hot Detection", description: "Identifies numbers transitioning from cold to hot state (decreasing betsSince with increasing count). Catches numbers emerging from cold streaks.", usage: "Best for: Early entry on warming numbers." },
                entropy: { name: "Entropy", method: "Consistency Analysis", description: "Selects numbers with the most consistent and predictable draw intervals (lowest coefficient of variation in gaps).", usage: "Best for: Finding reliable, stable patterns." },

                // Row 4: Pattern Detection
                antipattern: { name: "Anti-Pattern", method: "Avoidance Analysis", description: "Identifies recently frequent combinations and deliberately avoids them. Works without background correlation data.", usage: "Best for: Advanced contrarian betting." },
                streak: { name: "Streak", method: "Consecutive Detection", description: "Finds numbers that appeared in back-to-back or near-consecutive games. Catches hot streaks early.", usage: "Best for: Riding momentum on streaking numbers." },
                volatility: { name: "Volatility", method: "Grid Variance Analysis", description: "Analyzes coefficient of variation in number frequencies to find positions with high statistical volatility. Targets unpredictable but due numbers.", usage: "Best for: Sequential draw dependency — catches patterns temporal misses." },
                // Row 5: Precision Methods
                ema: { name: "EMA", method: "Exponential Moving Average", description: "Recency-weighted frequency with decay alpha=0.15. Recent games count ~6x more than old ones. Superior to Hot for shifting patterns.", usage: "Best for: Live sessions where trends evolve fast." },
                digitbias: { name: "Digit Bias", method: "Last-Digit Chi-Square", description: "Tests whether numbers ending in 0-9 are drawn at statistically unequal rates. Uses chi-square significance gate (p<0.05, df=9) — falls back to Hot when distribution is uniform.", usage: "Best for: Sites with systematic single-digit RNG skew." },
                parity: { name: "Parity", method: "Even/Odd Binomial Z-Test", description: "Tests whether even or odd numbers are being drawn at unequal rates. Binomial z-test (p<0.05) — boosts the favored parity class weighted by individual frequency. Works from game 5.", usage: "Best for: Sessions with persistent even/odd draw imbalance." },

                // Row 7: Meta Strategies
                adaptive: { name: "Adaptive", method: "Session Meta-Strategy", description: "Queries AI performance scores and blends the top 2 recommended strategies weighted by their recent win rates. Dynamically updates as session patterns shift.", usage: "Best for: Any session length. The strategy that picks your strategy." },
                regime: { name: "Regime", method: "CUSUM Change-Point Detection", description: "Uses CUSUM algorithm to detect if the session has shifted into a hot or cold distributional regime. Switches between Hot-biased and Cold-biased blends automatically based on detected regime.", usage: "Best for: Long sessions (50+ games) where RNG drift is expected." },
                // New strategies
                cohesion: { name: "Cohesion", method: "Cluster Travel Analysis", description: "Measures how well a number travels with the current hot cluster. Very strong on biased RNGs.", usage: "Best for: Finding numbers that cluster with current hot numbers." },
                edge: { name: "Edge", method: "Kelly-Inspired Meta", description: "Kelly-inspired: favors strategies that performed well recently (uses legend/legendHits if available).", usage: "Best for: Meta-analysis of strategy performance." },
                // User-pasted strategies (2026-05-13)
                delta: { name: "Delta", method: "Sequential Gap Pattern", description: "Analyzes deltas (gaps) between numbers in past winning combinations. Picks the most-frequent delta pattern, anchors on the hottest number, then walks the pattern around the 1-40 ring.", usage: "Best for: Sessions of 30+ games where gap structure may repeat." },
                regression: { name: "Regression", method: "Linear Trend on Intervals", description: "Linear regression on each number's last 15 occurrence intervals. Scores numbers with statistically meaningful negative slope (decreasing gaps → accelerating). r² > 0.25 gate.", usage: "Best for: 40+ games. Only meaningful if the RNG drifts." },
                portfolio: { name: "Portfolio", method: "Sharpe-Style Heat/Risk", description: "Heat ÷ entropy as a Sharpe-like ratio. Favors numbers with strong heat AND low variance in their interval pattern.", usage: "Best for: Variance reduction. Doesn't change EV." },
                comboways: { name: "Cluster", method: "Co-Occurrence Clustering", description: "Builds a set from numbers that land together in the same draws — seeds from the hottest number and grows by total co-occurrence — so the pick clusters tightly for more partial-match coverage.", usage: "Best for: Sessions where certain numbers keep showing up together." },
                condbonus: { name: "Pulse", method: "Recency × Frequency", description: "Scores each number by overall frequency × how recently it last hit, boosted by hits in the last 20 draws — surfacing numbers that are frequent AND active right now.", usage: "Best for: Riding numbers heating up in the current session." },
                // Re-added historical strategies
                bayesian: { name: "Bayesian", method: "Dynamic Posterior Update", description: "Maintains a Bayesian posterior for each number's hit probability, updating after every draw. Selects numbers with the highest posterior-weighted scores.", usage: "Best for: Statistically grounded probability estimates that sharpen with more data." },
                montecarlo: { name: "MonteCarlo", method: "200-Sim Weighted Sampling", description: "Runs 200 simulations of future draws using empirical frequencies, then picks the 9 numbers that appear most across all simulations.", usage: "Best for: Robust picks under uncertainty — smooths over small-sample noise." },
                coverage: { name: "Coverage", method: "Hot + Max-Spread Hybrid", description: "Selects top hot numbers plus additional numbers that maximize coverage of the board, combining frequency bias with spatial spread.", usage: "Best for: Maximizing partial hits by covering both hot zones and gaps." },
                wheeling: { name: "Wheeling", method: "Correlation-Based Expansion", description: "Seeds from the hottest number then expands by finding its most correlated partners — numbers that frequently appear together.", usage: "Best for: Sites with co-occurrence data. Builds a synergistic set." },
                timeseries: { name: "Forecast", method: "EMA on Intervals", description: "Applies exponential moving average to each number's inter-draw intervals. Selects numbers whose EMA interval predicts imminent appearance.", usage: "Best for: Sessions with identifiable cyclical timing patterns." },
                balanced: { name: "Balanced", method: "Zone-Based Coverage", description: "Divides the board into zones (low/mid/high) and selects proportional representatives from each, ensuring no zone is over- or under-represented.", usage: "Best for: Avoiding clustering bias — maximizes board coverage systematically." },
                momentum: { name: "Momentum", method: "Recent-Interval Acceleration", description: "Scores each number by comparing its recent gap intervals to its long-term average. Numbers appearing faster than usual get high momentum scores.", usage: "Best for: Spotting numbers whose appearance rate is currently accelerating." },
                poisson: { name: "Poisson", method: "Poisson Survival Probability", description: "Models each number's gap as a Poisson process (λ = avgInterval). Scores by survival probability — how overdue a number is relative to its expected rate.", usage: "Best for: 50+ games. The most statistically grounded gap strategy." },
                gapextremes: { name: "Extreme", method: "Z-Score Gap Analysis", description: "Uses standardized z-scores to find numbers with statistically extreme current gaps — either extremely overdue or on a hot streak. Targets both extremes.", usage: "Best for: High-conviction plays on statistical outliers at either end." }
            };

            this.initialize();
        }

        getStorageOrigin() {
            const origin = window.location.origin;
            // Winna's game iframe is at games.winna.com, data stored there
            if (origin.includes('winna.com') && !origin.includes('games.winna.com')) {
                return 'https://games.winna.com';
            }
            return origin;
        }

        debounce(func, wait) {
            let timeout;
            return (...args) => {
                clearTimeout(timeout);
                timeout = setTimeout(() => func.apply(this, args), wait);
            };
        }

        // TAG: KENO-MODE-DETECTION
        // Detects whether the current Rainbet Keno is in Extreme mode (1–56) vs
        // classic/low/medium/hard (1–40). All other sites are 40-only.
        detectNumberCount() {
            const site = this.getCurrentSite();
            if (site !== 'rainbet') return 40;

            // Scan visible numbered cells. If any valid 41–56 cell is on-screen,
            // the board is the Extreme 7×8 layout.
            const candidates = document.querySelectorAll('div, button, span, [role="button"]');
            let sawHigh = false;
            for (const el of candidates) {
                if (el.closest('#geminyzer-overlay')) continue;
                const text = (el.textContent || '').trim();
                if (text.length > 2) continue; // numbers are 1–2 chars
                const n = parseInt(text, 10);
                if (isNaN(n) || text !== String(n) || n < 41 || n > 56) continue;
                const rect = el.getBoundingClientRect();
                if (rect.width > 20 && rect.height > 20) { sawHigh = true; break; }
            }
            return sawHigh ? 56 : 40;
        }

        // Re-allocate stat arrays for the new pool size; preserves no history.
        resetStatsArrays() {
            this.data.kenoStats.totalBets = 0;
            this.data.kenoStats.hotNumbers = new Array(this.numberCount).fill(0);
            this.data.kenoStats.perNumberStats = Array.from({ length: this.numberCount }, () => ({
                count: 0,
                betsSince: 0,
                lastOccurrences: [],
                lastBetIndex: -1,
                avgInterval: 0,
                entropy: 0
            }));
        }

        // Apply a detected mode change: resize stats, force heatmap re-init,
        // invalidate button cache. Called from processKenoData on every cycle.
        applyDetectedMode() {
            const detected = this.detectNumberCount();
            if (detected === this.numberCount) return false;
            this.numberCount = detected;
            this.gridRows = Math.ceil(detected / this.gridCols);
            this.resetStatsArrays();
            // Force heatmap to rebuild with new cell count
            const grid = this.overlay?.querySelector('#overlay-keno-grid');
            if (grid) grid.innerHTML = '';
            this.heatmapCells.length = 0;
            // Invalidate keno button cache so findKenoNumbers re-scans for the new range
            this.cachedButtons = null;
            this.lastCacheTime = 0;
            // Drop the UI throttle so the new heatmap renders immediately
            this.lastUiUpdateTime = 0;
            return true;
        }

        // Rainbet-only: lightweight 1.5s poll so flipping the mode dropdown
        // (without placing a bet) is reflected in the overlay immediately.
        // No-op on other sites; cheap DOM scan when active.
        setupModePoll() {
            if (this.getCurrentSite() !== 'rainbet') return;
            if (this._modePollHandle) clearInterval(this._modePollHandle);
            this._modePollHandle = setInterval(() => {
                if (!this.applyDetectedMode()) return;
                // Mode changed — re-process cached draws so stats refill from
                // history that matches the new mode, then repaint.
                if (this.cachedKenoResults) {
                    this.processKenoData(this.cachedKenoResults);
                }
                if (this.overlay) {
                    this.populateHeatmap();
                    this.updateUI();
                }
            }, 1500);
        }

        initialize() {
            this.gameMode = this.detectGameMode();
            this.createOverlay();
            this.loadOverlayPosition(); // Load saved position after overlay is created
            this.addStyles();
            this.attachEventListeners();
            this.setupGlobalReference();
            this.setupUrlWatcher();
            this.loadLayoutMode();
            this.mountMode();
        }

        // Which game this page is: the manifest only injects the overlay on keno
        // and mines pages, so the path tells us which body to build.
        detectGameMode() {
            return /mines/i.test(location.pathname) ? 'mines' : 'keno';
        }

        // Route moved to a different supported game while we were already up.
        applyRouteGame(game) {
            if (!game || game === this.gameMode) return;
            this.gameMode = game;
            this.mountMode();
        }

        // Build the body for the active game and start its data flow. Called on
        // init and again if the site navigates between keno and mines in place.
        mountMode() {
            const content = this.overlay?.querySelector('#overlay-content');
            if (!content) return;
            const mines = this.gameMode === 'mines';
            content.innerHTML = mines ? this.minesMarkup() : this.kenoMarkup();
            this.overlay.classList.toggle('vx-mines-mode', mines);
            const label = this.overlay.querySelector('#overlay-stats-label');
            if (label) label.textContent = mines ? 'games' : 'bets';
            if (mines) this.initMinesMode(); else this.initKenoMode();
        }

        initKenoMode() {
            this.heatmapCells.length = 0; // fresh grid nodes after a remount
            this.setupQuickActions();
            this.populateHeatmap();
            this.updateUI();
            this.updateAIRecommendation(); // Update AI recommendation on init
            this.loadDataFromStorage();
            this.setupStorageListener();
            this.loadActiveButton();
            this.detectKeno();
            this.loadSideDrawerState();
            this.setupModePoll();

            setTimeout(() => {
                if (typeof browser !== 'undefined' && browser.storage) {
                    browser.storage.local.get(['strategyInfoCollapsed'], (result) => {
                        const explanationBox = this.overlay.querySelector('.strategy-explanation');
                        if (explanationBox) {
                            if (result.strategyInfoCollapsed === false) {
                                explanationBox.classList.remove('collapsed');
                            }
                        }
                    });
                }
            }, 100);
        }

        loadDataFromStorage() {
            const browserAPI = (typeof browser !== 'undefined' && browser?.storage) ? browser :
                (typeof chrome !== 'undefined' && chrome?.storage) ? chrome : null;
            if (!browserAPI || !browserAPI.storage || !browserAPI.storage.local) {
                console.warn('Browser storage API not available.');
                return;
            }

            browserAPI.storage.local.get(['kenoResults', 'lastDrawnNumbers', 'kenoTotalBets'], (result) => {
                if (browserAPI.runtime?.lastError) {
                    console.error('Error loading data from storage:', browserAPI.runtime.lastError.message);
                    return;
                }
                // Lifetime counter from the background (survives the 1500-entry
                // history cap). Read before processKenoData so the first render
                // already shows it.
                this.data.kenoStats.lifetimeBets =
                    result?.kenoTotalBets?.[`${this.storageOrigin}-keno-session`] ?? 0;
                this.processKenoData(result?.kenoResults);
                if (result?.lastDrawnNumbers) {
                    this.data.kenoStats.lastDrawn = result.lastDrawnNumbers;
                }
            });
        }

        setupStorageListener() {
            const browserAPI = (typeof browser !== 'undefined') ? browser : chrome;
            if (browserAPI && browserAPI.storage && browserAPI.storage.onChanged) {
                // Debounce storage listener so rapid writes during draw animations don't
                // trigger a full processKenoData rebuild on every single storage event.
                const debounceTime = window.location.href.includes('rainbet.com') ? 600 : 500;

                const debouncedListener = this.debounce((changes, area) => {
                    if (area !== 'local') return;
                    if (changes.kenoTotalBets) {
                        this.data.kenoStats.lifetimeBets =
                            changes.kenoTotalBets.newValue?.[`${this.storageOrigin}-keno-session`] ?? 0;
                    }
                    if (changes.kenoResults) {
                        this.processKenoData(changes.kenoResults.newValue);
                    }
                }, debounceTime);

                if (!this.storageListenerAdded) {
                    browserAPI.storage.onChanged.addListener(debouncedListener);
                    this._storageListeners.push(debouncedListener);
                    this.storageListenerAdded = true;
                }
            }
        }

        trackPerformance(strategyName, fn) {
            const startTime = performance.now();
            const result = fn();
            const endTime = performance.now();
            let metrics = this.performanceMetrics[strategyName];
            if (!metrics) {
                metrics = { avgTime: 0, calls: 0 };
                this.performanceMetrics[strategyName] = metrics;
            }
            metrics.calls++;
            metrics.avgTime = ((metrics.avgTime * (metrics.calls - 1)) + (endTime - startTime)) / metrics.calls;
            return result;
        }

        processKenoData(kenoResults) {
            const siteKey = `${this.storageOrigin}-keno-session`;
            const allResults = kenoResults?.[siteKey] || [];

            // Detect Rainbet extreme mode and resize stat arrays if it just changed.
            const modeChanged = this.applyDetectedMode();

            // Mode-filter the history. Rainbet bets carry a `risk` tag
            // ('classic'|'low'|'medium'|'hard'|'extreme'), which is authoritative.
            // Fallback: any draw containing a number > 40 must be extreme.
            const N = this.numberCount;
            const wantExtreme = N === 56;
            const siteSpecificResults = allResults.filter(bet => {
                const drawn = bet?.state?.drawnNumbers;
                if (!Array.isArray(drawn) || drawn.length === 0) return false;
                const risk = bet?.state?.risk;
                if (risk === 'extreme') return wantExtreme;
                if (risk && risk !== 'extreme') return !wantExtreme;
                // No risk tag — fall back to max-drawn heuristic
                let maxN = 0;
                for (let i = 0; i < drawn.length; i++) if (drawn[i] > maxN) maxN = drawn[i];
                return wantExtreme ? maxN > 40 : maxN <= 40;
            });

            // Single source of truth for "real" bets: the validated, mode-filtered,
            // settled set. P/L, combos and recent-draw helpers all read this so they
            // can't drift from the "Bets" count or count stale/partial frames.
            // Set before the early-return below so it's always current.
            this._validBets = siteSpecificResults;

            // Skip the expensive stats rebuild if the bet COUNT is unchanged — but a
            // bet can still settle in place (multiplier 0 -> 11) without changing the
            // count, so refresh the P/L-dependent UI (it reads the fresh _validBets).
            const newTotal = siteSpecificResults.length;
            if (!modeChanged && newTotal === this.data.kenoStats.totalBets) {
                safe(() => this.updateUI());
                return;
            }

            // OPTIMIZED: Allocation-free single-pass processing
            const MAX_ANALYSIS = 1000;
            const limitedResults = siteSpecificResults.slice(0, MAX_ANALYSIS);
            const numGames = limitedResults.length;

            // Reset stats — reuse existing arrays/objects to avoid GC pressure on every draw.
            this.data.kenoStats.totalBets = siteSpecificResults.length;
            // Window actually analyzed (≤ MAX_ANALYSIS). Anything comparing the
            // windowed counts against an expectation MUST use this, not totalBets —
            // mixing them made Hot/Cold saturate once bets passed the window size.
            this.data.kenoStats.analyzedGames = numGames;
            const hotNumbers = this.data.kenoStats.hotNumbers;
            const perNumberStats = this.data.kenoStats.perNumberStats;
            for (let i = 0; i < N; i++) {
                hotNumbers[i] = 0;
                const s = perNumberStats[i];
                s.count = 0; s.betsSince = 0; s.lastBetIndex = -1;
                s.avgInterval = 0; s.entropy = 0;
                s.lastOccurrences.length = 0; // clear in-place, no new array
            }

            // Process stats from oldest to newest to ensure intervals are monotonic
            for (let i = numGames - 1; i >= 0; i--) {
                const bet = limitedResults[i];
                if (!bet?.state?.drawnNumbers) continue;

                const drawn = bet.state.drawnNumbers;
                const betIndex = numGames - 1 - i; // Oldest is 0, newest is numGames-1

                // Update hot numbers and occurrences
                for (let j = 0; j < drawn.length; j++) {
                    const num = drawn[j];
                    if (num >= 1 && num <= N) {
                        const idx = num - 1;
                        hotNumbers[idx]++;
                        const stat = perNumberStats[idx];
                        stat.count++;

                        if (stat.lastBetIndex >= 0) {
                            const interval = betIndex - stat.lastBetIndex;
                            stat.lastOccurrences.push(interval);
                            if (stat.lastOccurrences.length > 50) stat.lastOccurrences.shift();
                        }
                        stat.lastBetIndex = betIndex;
                    }
                }
            }

            // Finalize betsSince, avgInterval and entropy
            for (let i = 0; i < N; i++) {
                const stat = perNumberStats[i];

                // betsSince is games since the most recent appearance (at the end of our history)
                if (stat.lastBetIndex >= 0) {
                    stat.betsSince = (numGames - 1) - stat.lastBetIndex;
                } else {
                    stat.betsSince = numGames;
                }

                if (stat.lastOccurrences.length > 0) {
                    stat.avgInterval = stat.lastOccurrences.reduce((a, b) => a + b, 0) / stat.lastOccurrences.length;
                    if (stat.lastOccurrences.length > 2) {
                        const sumSq = stat.lastOccurrences.reduce((a, b) => a + Math.pow(b - stat.avgInterval, 2), 0);
                        stat.entropy = Math.sqrt(sumSq / stat.lastOccurrences.length);
                    }
                }
            }

            this.cachedKenoResults = kenoResults;

            // Reflect the most recent game's picked numbers on the overlay grid
            const latestBet = siteSpecificResults[0];
            const latestSelected = latestBet?.state?.selectedNumbers;
            if (Array.isArray(latestSelected) && latestSelected.length > 0) {
                this.syncSelectionUI(latestSelected.filter(n => n >= 1 && n <= N));
            }

            // Heatmap + status bar (bets/hot/cold/P&L/momentum) refresh on every
            // processed bet so P/L tracks each result promptly — these are cheap.
            // The heavier panels (Smart Picker, Hot Groups, Combo History) and the
            // AI/correlation round-trips are throttled to ~2s so long autobet
            // sessions don't lag the page.
            this.populateHeatmap();
            this.updateStatusBar();
            const now = Date.now();
            if (!this.lastUiUpdateTime || (now - this.lastUiUpdateTime) >= 2000) {
                this.renderInsights();
                this.updateAIRecommendation();
                this.fetchAndDisplayCorrelations();
                this.lastUiUpdateTime = now;
            }
        }

        updateUI() {
            this.updateStatusBar();
            this.updateStrategyPLBadges();
            this.renderInsights();
        }

        // What the header/tile "Bets" shows: the lifetime count when the
        // background has one (it keeps climbing past the 1500-entry history
        // cap), else the buffer length. Analysis code keeps using totalBets.
        displayBetCount() {
            const s = this.data.kenoStats;
            return Math.max(s.lifetimeBets || 0, s.totalBets || 0);
        }

        // Cheap, runs on every settled bet so P/L / bets / momentum stay instant.
        updateStatusBar() {
            safe(() => {
                const totalBetsEl = this.overlay.querySelector('#overlay-total-bets');
                if (totalBetsEl) {
                    totalBetsEl.textContent = this.displayBetCount().toLocaleString();
                }
                // Momentum is shared by the status strip and the heatmap arrows;
                // compute once per refresh and cache.
                this._momentum = this.computeMomentum();
                this.refreshMomentumArrows();
                this.updateStatusStrip();
            });
        }

        // Heavier panels (combo engines re-render full lists) — throttled by the
        // caller during rapid autobet so long sessions don't lag the page.
        renderInsights() {
            safe(() => {
                this.renderSmartPicker();
                this.renderHotCombos();
                this.renderComboHistory();
            });
        }

        // --- Insights engine (status strip, momentum, hot combos) ---------------

        // Recent draws as arrays of numbers, newest first, filtered to the active
        // pool size so classic (≤40) and Rainbet extreme (≤56) don't mix.
        getRecentDraws(limit = 150) {
            const all = this._validBets || [];
            const N = this.numberCount;
            const out = [];
            for (let i = 0; i < all.length && out.length < limit; i++) {
                const drawn = all[i]?.state?.drawnNumbers;
                if (Array.isArray(drawn) && drawn.length &&
                    drawn.every(n => n >= 1 && n <= N)) {
                    out.push(drawn);
                }
            }
            return out;
        }

        // Per-number trend: compares hit-rate in the most recent window against the
        // window before it. Returns an index-1 array of 'up' | 'down' | 'flat'.
        computeMomentum() {
            const N = this.numberCount;
            const m = new Array(N + 1).fill('flat');
            const draws = this.getRecentDraws(120);
            if (draws.length < 20) return m;
            const w = Math.min(20, Math.floor(draws.length / 2));
            const rate = (set) => {
                const c = new Array(N + 1).fill(0);
                set.forEach(d => d.forEach(n => { if (n >= 1 && n <= N) c[n]++; }));
                for (let i = 0; i <= N; i++) c[i] /= (set.length || 1);
                return c;
            };
            const r = rate(draws.slice(0, w));
            const p = rate(draws.slice(w, w * 2));
            for (let n = 1; n <= N; n++) {
                const d = r[n] - p[n];
                if (d > 0.06) m[n] = 'up';
                else if (d < -0.06) m[n] = 'down';
            }
            return m;
        }

        // Per-number Heat Score 0-100: blends recent (last 20 draws) performance,
        // overall session frequency, and recency (time since last hit), normalized
        // across the board so the hottest number ≈ 100 and the coldest ≈ 0.
        computeHeatScores() {
            const N = this.numberCount;
            const scores = new Array(N + 1).fill(0);
            const draws = this.getRecentDraws(1000);
            const total = draws.length;
            if (!total) return scores;
            const recentWin = Math.min(20, total);
            const recent = new Array(N + 1).fill(0);
            const overall = new Array(N + 1).fill(0);
            const lastSeen = new Array(N + 1).fill(Infinity); // draws since last hit
            for (let i = 0; i < total; i++) {
                const d = draws[i];
                for (let j = 0; j < d.length; j++) {
                    const n = d[j];
                    if (n >= 1 && n <= N) {
                        overall[n]++;
                        if (i < recentWin) recent[n]++;
                        if (i < lastSeen[n]) lastSeen[n] = i;
                    }
                }
            }
            const raw = new Array(N + 1).fill(0);
            let min = Infinity, max = -Infinity;
            for (let n = 1; n <= N; n++) {
                const recentRate = recent[n] / recentWin;
                const overallRate = overall[n] / total;
                const recency = lastSeen[n] === Infinity ? 0 : 1 / (1 + lastSeen[n]);
                const r = 0.5 * recentRate + 0.3 * overallRate + 0.2 * recency;
                raw[n] = r;
                if (r < min) min = r;
                if (r > max) max = r;
            }
            const span = (max - min) || 1;
            for (let n = 1; n <= N; n++) scores[n] = Math.round(((raw[n] - min) / span) * 100);
            return scores;
        }

        refreshMomentumArrows() {
            if (!this.heatmapCells || !this.heatmapCells.length || !this._momentum) return;
            for (let i = 0; i < this.heatmapCells.length; i++) {
                const slot = this.heatmapCells[i]?.momSlot;
                if (!slot) continue;
                const st = this._momentum[i + 1];
                slot.innerHTML = (st && st !== 'flat') ? this.momentumIcon(st) : '';
            }
        }

        momentumIcon(state) {
            if (state === 'up') return `<svg class="vx-mom up" viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 15 12 8 19 15"></polyline></svg>`;
            if (state === 'down') return `<svg class="vx-mom down" viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 9 12 16 19 9"></polyline></svg>`;
            return '';
        }

        // Count numbers running hot/cold vs. their expected frequency (±15%).
        hotColdCounts() {
            const N = this.numberCount;
            const counts = this.data.kenoStats.hotNumbers;
            const bets = this.data.kenoStats.totalBets;
            if (!bets) return { hot: 0, cold: 0, expected: 0 };
            // Expected draws per number over the SAME window the counts were
            // built from (last ≤1000 games) — using totalBets here inflated
            // expected past what windowed counts can reach, pinning Hot at 0
            // and saturating Cold once a session passed 1000 bets.
            const windowGames = this.data.kenoStats.analyzedGames || Math.min(bets, 1000);
            const expected = windowGames * ((this._drawnPerGame || 10) / N);
            let hot = 0, cold = 0;
            for (let i = 0; i < N; i++) {
                if (counts[i] > expected * 1.15) hot++;
                else if (counts[i] < expected * 0.85) cold++;
            }
            return { hot, cold, expected };
        }

        // Session P/L in real money, stake-weighted: a $2 loss is −$2 and a $2
        // bet paying 3x is +$4, not ±1 unit each. Free ($0) bets are excluded and
        // currencies are kept apart — see money.js.
        sessionPL() {
            const stats = VantedgeMoney.summarize(this._validBets || []); // settled bets only
            this._paidBetCount = stats.paid;
            return stats;
        }

        // Per-strategy session P/L over the tracked bets, same units as
        // sessionPL(): Σ(multiplier − 1) per paid bet, grouped by the strategy
        // tag the background attached to each bet (activeStrategy/strategyUsed).
        // Untagged bets (manual picks) simply don't appear here.
        computeStrategyPL() {
            const all = this._validBets || [];
            if (this._stratPLCache && this._stratPLCache.ref === all) return this._stratPLCache.map;
            const map = {};
            for (let i = 0; i < all.length; i++) {
                const b = all[i];
                const id = b?.activeStrategy || b?.strategyUsed;
                if (!id) continue;
                const m = map[id] || (map[id] = { plays: 0, paid: 0, pl: 0, best: 0 });
                m.plays++;
                const mult = Number(b?.payoutMultiplier) || 0;
                if (mult > m.best) m.best = mult;
                if ((Number(b?.amount) || 0) > 0) { m.paid++; m.pl += mult - 1; }
            }
            this._stratPLCache = { ref: all, map };
            return map;
        }

        // Small P/L number under each strategy tile (Core grid, Alt grid and the
        // side drawer) — the Smart Picker statline treatment, per strategy. Only
        // appears once a strategy has settled paid bets this session.
        updateStrategyPLBadges() {
            safe(() => {
                const map = this.computeStrategyPL();
                const items = [
                    ...(this.overlay?.querySelectorAll('.action-item') || []),
                    ...document.querySelectorAll('#overlay-side-actions .action-item')
                ];
                items.forEach(item => {
                    const id = item.dataset.strategyId;
                    const s = id && map[id];
                    let el = item.querySelector('.vx-spl');
                    if (!s || !s.paid) { if (el) el.remove(); return; }
                    if (!el) {
                        el = document.createElement('span');
                        el.className = 'vx-spl';
                        item.appendChild(el);
                    }
                    el.textContent = this.plFmt(s.pl);
                    el.classList.toggle('pos', s.pl > 0.05);
                    el.classList.toggle('neg', s.pl < -0.05);
                    el.title = `${this.getStrategyName(id)} — session P/L ${this.plFmt(s.pl)} over ${s.paid} paid bets (${s.plays} plays, best ${s.best.toFixed(1)}x)`;
                });
            });
        }

        updateStatusStrip() {
            const el = this.overlay?.querySelector('#overlay-status-strip');
            if (!el) return;
            const bets = this.data.kenoStats.totalBets;
            const { hot, cold, expected } = this.hotColdCounts();
            const plStat = this.sessionPL();
            const hasPaid = plStat.paid > 0;
            const eps = curEpsilon(plStat.cur, plStat.pl);
            const plCls = plStat.pl > eps ? 'hot' : (plStat.pl < -eps ? 'plneg' : '');
            const exp = expected ? Math.round(expected) : 0;
            const roi = plStat.roi;
            const others = plStat.others.length
                ? ` Also ${plStat.others.map(o => fmtMoney(o.pl, o.cur)).join(', ')} (kept separate — no conversion).`
                : '';
            const tip = {
                bets: 'Settled bets tracked on this seed.',
                hot: `Numbers drawn 15%+ ABOVE expected (~${exp}× each so far). How many are running hot.`,
                cold: `Numbers drawn 15%+ BELOW expected (~${exp}× each so far). How many are running cold.`,
                pl: hasPaid
                    ? `Net profit on real-money bets: stake × (multiplier − 1), summed. `
                      + `${plStat.bets} paid bet${plStat.bets === 1 ? '' : 's'}, ${fmtMoney(plStat.wagered, plStat.cur, { signed: false })} wagered, `
                      + `ROI ${roi > 0 ? '+' : ''}${roi.toFixed(1)}%.${others} Free ($0) bets are excluded.`
                    : 'Net profit on real-money bets: stake × (multiplier − 1), summed. Free ($0) bets are excluded.'
            };
            el.innerHTML =
                this.statTile('Bets', bets.toLocaleString(), '', tip.bets) +
                this.statTile('Hot', bets ? hot : '—', 'hot', tip.hot) +
                this.statTile('Cold', bets ? cold : '—', 'cold', tip.cold) +
                // Only real-money bets have P/L; free ($0) play shows "—".
                this.statTile('P/L', hasPaid ? fmtMoney(plStat.pl, plStat.cur, { compact: true }) : '—', hasPaid ? plCls : '', tip.pl);
        }

        // Top co-occurring number trios from recent draws. Strength is each trio's
        // internal co-occurrence relative to the strongest trio (a heat bar, not a
        // probability) — honest "drawn together most often lately".

        // Hypergeometric expected gap for a k-group fully hitting: 1 / P(all k of
        // the group are among the numbers drawn in one game). With a 40-pool / 10-
        // drawn keno this gives 17, 82, 435, 2611, 18279, 155377 for k=2..7.
        expectedGroupGap(k) {
            const pool = this.numberCount;
            const drawn = this._drawnPerGame || 10;
            let p = 1;
            for (let i = 0; i < k; i++) {
                const num = drawn - i, den = pool - i;
                if (num <= 0 || den <= 0) return Infinity;
                p *= num / den;
            }
            return p > 0 ? 1 / p : Infinity;
        }

        // Enumerate every k-element subset of arr (sorted), calling cb with each.
        _kSubsets(arr, k, cb) {
            const n = arr.length;
            if (k > n) return;
            const pick = new Array(k);
            const rec = (start, depth) => {
                if (depth === k) { cb(pick.slice()); return; }
                for (let i = start; i <= n - (k - depth); i++) {
                    pick[depth] = arr[i];
                    rec(i + 1, depth + 1);
                }
            };
            rec(0, 0);
        }

        // Co-occurring groups of size k from recent draws, with hit count, current
        // gap (draws since last full hit), avg interval and heat score
        // (gapRatio × count/maxCount). Cached per (size, drawCount) since it runs
        // on every UI refresh.
        computeHotGroups(k, limit = 200) {
            const N = this.numberCount;
            const draws = this.getRecentDraws(limit);
            const cacheKey = `${k}:${draws.length}`;
            if (this._hotGroupCache && this._hotGroupCache.key === cacheKey) {
                return this._hotGroupCache.result;
            }
            const minGames = Math.max(15, k * 3);
            if (draws.length < minGames) {
                const r = { groups: [], draws: draws.length, ready: false };
                this._hotGroupCache = { key: cacheKey, result: r };
                return r;
            }
            const stat = Object.create(null);
            let dpg = 0;
            for (let idx = 0; idx < draws.length; idx++) {
                const u = [...new Set(draws[idx])].filter(n => n >= 1 && n <= N).sort((a, b) => a - b);
                if (u.length > dpg) dpg = u.length;
                if (u.length < k) continue;
                this._kSubsets(u, k, (sub) => {
                    const key = sub.join('-');
                    let s = stat[key];
                    if (!s) { stat[key] = { count: 1, minIdx: idx, maxIdx: idx }; }
                    else { s.count++; if (idx < s.minIdx) s.minIdx = idx; if (idx > s.maxIdx) s.maxIdx = idx; }
                });
            }
            this._drawnPerGame = dpg || 10;
            const expGap = this.expectedGroupGap(k);
            let maxCount = 1;
            for (const key in stat) if (stat[key].count > maxCount) maxCount = stat[key].count;
            const groups = [];
            for (const key in stat) {
                const s = stat[key];
                if (k >= 3 && s.count < 2) continue; // singletons aren't a "group" for trios+
                const gap = s.minIdx; // draws since last full hit (0 = most recent)
                const avgInterval = s.count > 1 ? Math.round((s.maxIdx - s.minIdx) / (s.count - 1)) : draws.length;
                const gapRatio = expGap === Infinity ? 0 : gap / expGap;
                groups.push({
                    numbers: key.split('-').map(Number), key,
                    count: s.count, gap, avgInterval, gapRatio,
                    heat: gapRatio * (s.count / maxCount)
                });
            }
            const r = { groups, draws: draws.length, maxCount, expGap, ready: true };
            this._hotGroupCache = { key: cacheKey, result: r };
            return r;
        }

        comboKey(numbers) {
            return [...numbers].sort((a, b) => a - b).join('-');
        }

        isFavoriteCombo(key) {
            return Array.isArray(this.comboFavorites) && this.comboFavorites.includes(key);
        }

        toggleComboFavorite(key) {
            if (!Array.isArray(this.comboFavorites)) this.comboFavorites = [];
            const i = this.comboFavorites.indexOf(key);
            if (i >= 0) this.comboFavorites.splice(i, 1);
            else this.comboFavorites.push(key);
            const browserAPI = (typeof browser !== 'undefined') ? browser : chrome;
            browserAPI?.storage?.local?.set({ comboFavorites: this.comboFavorites });
            this.renderHotCombos();
        }

        applyCombo(numbers) {
            this.animateSequentialSelection([...numbers].sort((a, b) => a - b));
        }

        // Star icon markup (filled when favorited).
        _starSvg(on, size = 13) {
            return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.1 8.6 22 9.3 17 14.1 18.2 21 12 17.6 5.8 21 7 14.1 2 9.3 8.9 8.6 12 2"></polygon></svg>`;
        }

        // The section keeps the legacy id #overlay-hot-combos; renamed conceptually
        // to "Hot Groups" to match the size/tab/columns spec.
        renderHotCombos() {
            const el = this.overlay?.querySelector('#overlay-hot-combos');
            if (!el) return;

            const size = this.hotGroupSize || (this.hotGroupSize = 4);
            const view = this.hotGroupView || (this.hotGroupView = 'hot');
            const favOnly = !!this.showFavoritesOnly;

            const sizePills = [2, 3, 4, 5, 6, 7, 8, 9, 10].map(s =>
                `<button class="vx-gsize ${s === size ? 'on' : ''}" data-size="${s}" title="Groups of ${s} numbers that land together">${s}</button>`).join('');

            const viewTips = {
                hot: 'Hot — ranked by heat score (how often it hits × how overdue it is). The default "strongest now" view.',
                frequent: 'Frequent — ranked by raw hit count. Groups that appear most often, overdue or not.',
                overdue: 'Overdue — ranked by gap vs its expected interval. Groups that are "due".',
                cold: 'Cold — least-frequent groups in the window (the dud pile).'
            };
            const tabs = [['hot', 'Hot'], ['frequent', 'Frequent'], ['overdue', 'Overdue'], ['cold', 'Cold']].map(([v, label]) =>
                `<button class="vx-gtab ${v === view ? 'on' : ''}" data-view="${v}" title="${viewTips[v]}">${label}</button>`).join('');

            let groups;
            if (favOnly) {
                // Favorites are exact number-sets; show them with live stats for the
                // current pool (gap/heat recomputed against recent draws).
                const live = this.computeHotGroups(size);
                const byKey = Object.create(null);
                (live.groups || []).forEach(g => { byKey[g.key] = g; });
                groups = (this.comboFavorites || []).map(key => byKey[key] || {
                    numbers: key.split('-').map(Number), key, count: 0, gap: null, gapRatio: 0, heat: 0
                });
            } else {
                const res = this.computeHotGroups(size);
                if (!res.ready) {
                    el.innerHTML = this._hotGroupsShell(sizePills, tabs, favOnly) +
                        `<div class="vx-combos-empty">Need ${Math.max(15, size * 3)}+ draws for ${size}-groups — keep playing.</div>`;
                    this.wireHotCombos();
                    return;
                }
                groups = res.groups.slice();
                const cmp = {
                    hot: (a, b) => b.heat - a.heat || b.count - a.count,
                    frequent: (a, b) => b.count - a.count || a.gap - b.gap,
                    overdue: (a, b) => b.gapRatio - a.gapRatio || b.count - a.count,
                    cold: (a, b) => a.count - b.count || b.gap - a.gap
                }[view] || ((a, b) => b.heat - a.heat);
                groups.sort(cmp);
                groups = groups.slice(0, 10);
            }

            const maxHeat = Math.max(...groups.map(g => g.heat || 0), 0.0001);
            const rows = groups.map(g => {
                const fav = this.isFavoriteCombo(g.key);
                const nums = g.numbers.join(', ');
                const gapState = (g.gap === 0) ? 'now' : (g.gapRatio >= 1.5) ? 'overdue' : (g.gapRatio >= 0.8) ? 'due' : '';
                const gapText = (g.gap == null) ? '—' : (g.gap === 0 ? 'NOW' : g.gap);
                const heatPct = Math.round(((g.heat || 0) / maxHeat) * 100);
                // Group trend = net momentum of its member numbers.
                const mom = this._momentum || [];
                let up = 0, down = 0;
                g.numbers.forEach(n => { if (mom[n] === 'up') up++; else if (mom[n] === 'down') down++; });
                const gArrow = up > down ? this.momentumIcon('up') : (down > up ? this.momentumIcon('down') : '');
                return `<div class="vx-grow" data-combo-numbers="${g.numbers.join(',')}" title="Click to select these ${g.numbers.length} numbers">
                            <span class="vx-gnums"><span class="vx-gtrend">${gArrow}</span>${nums}</span>
                            <span class="vx-gcell">${g.count || 0}</span>
                            <span class="vx-gcell gap ${gapState}">${gapText}</span>
                            <span class="vx-gcell heat">${heatPct}%</span>
                            <button class="vx-combo-star ${fav ? 'on' : ''}" data-combo-key="${g.key}" title="${fav ? 'Remove favorite' : 'Save favorite'}" aria-label="Toggle favorite">${this._starSvg(fav)}</button>
                        </div>`;
            }).join('');

            const empty = favOnly
                ? `<div class="vx-combos-empty">No favorites yet — tap the ☆ on a group.</div>`
                : `<div class="vx-combos-empty">No repeat groups at size ${size} yet.</div>`;

            // Clickable column headers map to the matching ranking view.
            const car = (v) => view === v ? ' <span class="vx-gcar">▾</span>' : '';
            const head = `<div class="vx-ghead">
                    <span class="vx-gnums" title="Click a row to select these numbers on the board">Group</span>
                    <span class="vx-gcell vx-gsort ${view === 'frequent' ? 'on' : ''}" data-sortview="frequent" title="Hits — times this exact group was drawn together. Click to sort.">Hits${car('frequent')}</span>
                    <span class="vx-gcell vx-gsort ${view === 'overdue' ? 'on' : ''}" data-sortview="overdue" title="Gap — draws since it last hit. NOW=just hit, yellow=due, amber glow=overdue (>1.5× expected). Click to sort.">Gap${car('overdue')}</span>
                    <span class="vx-gcell vx-gsort ${view === 'hot' ? 'on' : ''}" data-sortview="hot" title="Heat — combined score of frequency and how overdue it is, vs the top group. Click to sort.">Heat${car('hot')}</span>
                    <span style="width:17px"></span>
                </div>`;
            // When almost nothing has repeated at this size, every ranking surfaces
            // the same one or two groups — flag it so the tabs don't look broken.
            const sparse = !favOnly && groups.length > 0 &&
                (groups.length < 3 || groups.every(g => (g.count || 0) <= 2));
            const hint = sparse
                ? `<div class="vx-combos-hint">Few repeating ${size}-groups yet — the Hot/Frequent/Overdue/Cold views need more draws (or a smaller size) to differ.</div>`
                : '';

            el.innerHTML = this._hotGroupsShell(sizePills, tabs, favOnly) + head +
                (groups.length ? rows + hint : empty);

            this.wireHotCombos();
        }

        _hotGroupsShell(sizePills, tabs, favOnly) {
            // Honest yardstick for the gap colors: how often a group of this size
            // fully hits by pure chance (hypergeometric). "Overdue" = past 1.5x this.
            const size = this.hotGroupSize || 4;
            const exp = this.expectedGroupGap(size);
            const expHint = isFinite(exp)
                ? `<div class="vx-gexp" title="A ${size}-number group fully hits about once per ${Math.round(exp).toLocaleString()} draws by pure chance. Gap colors compare each group's current gap to this: yellow from 0.8x, amber glow past 1.5x.">${size}-groups hit ~1 in ${Math.round(exp).toLocaleString()} draws</div>`
                : '';
            return `
                <div class="vx-combos-head">
                    <span class="vx-section-title">Hot groups</span>
                    <button class="vx-fav-toggle ${favOnly ? 'on' : ''}" id="overlay-fav-toggle" title="Show favorites only" aria-label="Show favorites only">
                        ${this._starSvg(favOnly, 12)} Favorites
                    </button>
                </div>
                <div class="vx-gsizes">${sizePills}</div>
                <div class="vx-gtabs">${tabs}</div>${expHint}`;
        }

        wireHotCombos() {
            const el = this.overlay?.querySelector('#overlay-hot-combos');
            if (!el) return;
            const favBtn = el.querySelector('#overlay-fav-toggle');
            if (favBtn) favBtn.onclick = () => {
                this.showFavoritesOnly = !this.showFavoritesOnly;
                this.renderHotCombos();
            };
            el.querySelectorAll('.vx-gsize').forEach(btn => {
                btn.onclick = () => { this.hotGroupSize = parseInt(btn.dataset.size, 10); this.renderHotCombos(); };
            });
            el.querySelectorAll('.vx-gtab').forEach(btn => {
                btn.onclick = () => { this.hotGroupView = btn.dataset.view; this.renderHotCombos(); };
            });
            el.querySelectorAll('.vx-gsort').forEach(h => {
                h.onclick = () => { this.hotGroupView = h.dataset.sortview; this.renderHotCombos(); };
            });
            el.querySelectorAll('.vx-combo-star').forEach(btn => {
                btn.onclick = (e) => { e.stopPropagation(); this.toggleComboFavorite(btn.dataset.comboKey); };
            });
            el.querySelectorAll('.vx-grow').forEach(row => {
                row.onclick = () => {
                    const nums = (row.dataset.comboNumbers || '').split(',').map(Number).filter(Boolean);
                    if (nums.length) this.applyCombo(nums);
                };
            });
        }

        // --- Combo stats engine (powers Combo History + Smart Picker stats) ------

        // Per-combo stats derived purely from the bet history (what you actually
        // played). Keyed by the sorted selection. Cached by history length.
        computeComboHistory(limit = 1000) {
            const all = this._validBets || [];
            // Key the cache on the array reference, not length: a bet settling
            // (multiplier 0 -> 11) keeps the count but must recompute P/L.
            if (this._comboHistCache && this._comboHistCache.ref === all) return this._comboHistCache.map;
            const N = this.numberCount;
            const map = Object.create(null);
            const lim = Math.min(all.length, limit);
            for (let i = 0; i < lim; i++) {
                const b = all[i];
                const sel = b?.state?.selectedNumbers;
                if (!Array.isArray(sel) || sel.length < 2) continue;
                const nums = [...new Set(sel.map(Number))].filter(n => n >= 1 && n <= N).sort((a, b) => a - b);
                if (nums.length < 2) continue;
                const key = nums.join('-');
                let m = map[key];
                if (!m) m = map[key] = {
                    key, numbers: nums, plays: 0, paid: 0, sumMult: 0, best: 0,
                    pl: 0, wagered: 0, cur: null, mixed: false, firstSeen: i, lastSeen: i
                };
                m.plays++;
                const mult = Number(b.payoutMultiplier) || 0;
                const amt = Number(b.amount) || 0;
                if (mult > m.best) m.best = mult;
                // Money P/L, same rule as sessionPL: stake × (multiplier − 1).
                if (amt > 0) {
                    m.paid++;
                    m.sumMult += mult;
                    m.pl += betProfit(b);
                    m.wagered += amt;
                    const cur = curKey(b.currency);
                    if (m.cur === null) m.cur = cur;
                    else if (m.cur !== cur) m.mixed = true; // don't mix currencies in one total
                }
                if (i < m.firstSeen) m.firstSeen = i;
                if (i > m.lastSeen) m.lastSeen = i;
            }
            for (const k in map) {
                const m = map[k];
                m.avg = m.paid > 0 ? m.sumMult / m.paid : 0;
                m.age = m.lastSeen; // bets since the combo was first played
                m.roi = m.wagered > 0 ? (m.pl / m.wagered) * 100 : 0;
                if (m.cur === null) m.cur = 'usd';
            }
            this._comboHistCache = { ref: all, map };
            return map;
        }

        // Gap (draws since the combo last fully hit) + total full hits, from the
        // draw history — counts even when the combo wasn't being played.
        comboGap(numbers) {
            const draws = this.getRecentDraws(1000);
            let gap = null, hits = 0;
            for (let i = 0; i < draws.length; i++) {
                const d = draws[i];
                let all = true;
                for (let j = 0; j < numbers.length; j++) { if (d.indexOf(numbers[j]) === -1) { all = false; break; } }
                if (all) { hits++; if (gap === null) gap = i; }
            }
            return { gap, hits };
        }

        // Stats for one specific combo (Smart Picker preview).
        getComboStats(numbers) {
            const key = [...numbers].sort((a, b) => a - b).join('-');
            const m = this.computeComboHistory()[key];
            const g = this.comboGap([...numbers].sort((a, b) => a - b));
            return {
                best: m?.best || 0, avg: m?.avg || 0, plays: m?.plays || 0,
                pl: m?.pl || 0, wagered: m?.wagered || 0, cur: m?.cur || 'usd',
                mixed: !!m?.mixed, paid: m?.paid || 0, roi: m?.roi || 0,
                gap: g.gap, hits: g.hits
            };
        }

        // Money P/L for a combo row. Combos played across two currencies can't be
        // added up, so those show the mixed marker instead of a wrong total.
        plFmt(v, cur = 'usd', opts = {}) {
            if (opts.mixed) return 'mixed';
            return fmtMoney(v, cur, opts);
        }

        // Win / loss / flat for a money P/L, at that currency's display precision.
        plClass(v, cur, pos = 'pos', neg = 'neg') {
            const eps = curEpsilon(cur, v);
            return v > eps ? pos : (v < -eps ? neg : '');
        }

        // Top payout multipliers ever landed for an exact combo, with hit counts.
        comboTopMultipliers(numbers, topN = 5) {
            const all = this._validBets || [];
            const key = [...numbers].sort((a, b) => a - b).join('-');
            const counts = Object.create(null);
            for (let i = 0; i < all.length; i++) {
                const b = all[i];
                const sel = b?.state?.selectedNumbers;
                if (!Array.isArray(sel)) continue;
                const k = [...new Set(sel.map(Number))].filter(n => n >= 1 && n <= this.numberCount).sort((a, b) => a - b).join('-');
                if (k !== key) continue;
                const m = Number(b.payoutMultiplier) || 0;
                if (m <= 0) continue;
                const r = m >= 10 ? Math.round(m) : Math.round(m * 10) / 10;
                counts[r] = (counts[r] || 0) + 1;
            }
            return Object.keys(counts).map(m => ({ m: parseFloat(m), c: counts[m] }))
                .sort((a, b) => b.m - a.m).slice(0, topN);
        }

        renderComboHistory() {
            const el = this.overlay?.querySelector('#overlay-combo-history');
            if (!el) return;
            const map = this.computeComboHistory();
            let combos = Object.values(map);
            if (!combos.length) {
                el.innerHTML = `<div class="vx-combos-head"><span class="vx-section-title">Combo history</span></div>
                    <div class="vx-combos-empty">No combos played yet on this site.</div>`;
                return;
            }
            // Most recently played first, cap to 8.
            combos.sort((a, b) => a.firstSeen - b.firstSeen);
            combos = combos.slice(0, 8);
            const rows = combos.map(m => {
                const g = this.comboGap(m.numbers);
                const gapText = g.gap == null ? '—' : (g.gap === 0 ? 'NOW' : g.gap);
                const plCls = m.mixed ? '' : this.plClass(m.pl, m.cur);
                const plTitle = m.paid
                    ? (m.mixed
                        ? 'Played in more than one currency — totals aren\'t comparable, so no sum is shown.'
                        : `Net profit: stake × (multiplier − 1), summed. ${fmtMoney(m.wagered, m.cur, { signed: false })} wagered over ${m.paid} paid play${m.paid === 1 ? '' : 's'}, ROI ${m.roi > 0 ? '+' : ''}${m.roi.toFixed(1)}%.`)
                    : 'Only free ($0) plays so far — no money staked.';
                return `<div class="vx-chrow" data-combo-numbers="${m.numbers.join(',')}">
                            <div class="vx-chtop">
                                <span class="vx-gnums">${m.numbers.join('-')}</span>
                                <span class="vx-chpl ${plCls}" title="${plTitle}">${m.paid ? this.plFmt(m.pl, m.cur, { mixed: m.mixed, compact: true }) : '—'}</span>
                            </div>
                            <div class="vx-chsub">best <span class="vx-chbest" title="Top multipliers — click to expand${m.bestCount > 1 ? ` (best landed ${m.bestCount}×)` : ''}">${m.best.toFixed(1)}x${bestSup}</span> · avg ${m.avg.toFixed(1)}x · ${m.plays} plays · gap <span class="vx-chgap ${gapState}" title="${gapTip}">${gapText}${gapSup}</span></div>
                            <div class="vx-chdetail" hidden></div>
                        </div>`;
            }).join('');
            el.innerHTML = `<div class="vx-combos-head"><span class="vx-section-title">Combo history</span><span class="vx-chcount">${Object.keys(map).length}</span></div>${rows}`;
            el.querySelectorAll('.vx-chrow').forEach(row => {
                const nums = (row.dataset.comboNumbers || '').split(',').map(Number).filter(Boolean);
                row.onclick = () => { if (nums.length) this.applyCombo(nums); };
                const bestEl = row.querySelector('.vx-chbest');
                const detail = row.querySelector('.vx-chdetail');
                if (bestEl && detail) bestEl.onclick = (e) => {
                    e.stopPropagation();
                    if (!detail.hidden) { detail.hidden = true; return; }
                    const tops = this.comboTopMultipliers(nums);
                    detail.innerHTML = tops.length
                        ? 'Top: ' + tops.map(t => `<span class="vx-chmx">${t.m}x<sup>${t.c}</sup></span>`).join(' · ')
                        : 'No paid hits recorded yet.';
                    detail.hidden = false;
                };
            });
        }

        // --- Smart Picker --------------------------------------------------------

        // Pattern: composite score across multiple signals (streaks, gaps,
        // positional tendency, frequency, momentum, hot-combo membership), then top N.
        patternScores() {
            const N = this.numberCount;
            const score = new Array(N + 1).fill(0);
            const addRanked = (nums, w) => {
                if (!nums) return;
                const len = nums.length || 1;
                nums.forEach((n, i) => { if (n >= 1 && n <= N) score[n] += w * (1 - i / len); });
            };
            addRanked(this.getStreakNumbers(N), 1.0);      // streaks / clusters
            addRanked(this.getOverdueNumbers(N), 0.7);     // gaps
            addRanked(this.getPositionalNumbers(N), 0.6);  // positional tendency
            addRanked(this.getHotNumbers(N), 0.5);         // frequency
            const mom = this._momentum || this.computeMomentum();
            for (let n = 1; n <= N; n++) if (mom[n] === 'up') score[n] += 0.5;  // momentum
            const hg = this.computeHotGroups(3);
            (hg.groups || []).slice(0, 12).forEach(g => g.numbers.forEach(n => { score[n] += 0.4; }));
            return score;
        }

        // Pairs: recency-weighted affinity matrix; start from the strongest single
        // affinity, grow by adding the number most co-correlated with the set so far.
        pairsPick(size) {
            const N = this.numberCount;
            const draws = this.getRecentDraws(150);
            const W = draws.length;
            const aff = Object.create(null);
            const single = new Array(N + 1).fill(0);
            const pk = (a, b) => (a < b ? a + '-' + b : b + '-' + a);
            draws.forEach((d, idx) => {
                const w = 1 - idx / (W + 1); // newest ≈ 1, oldest → 0
                const u = [...new Set(d)].filter(n => n >= 1 && n <= N).sort((a, b) => a - b);
                u.forEach(n => { single[n] += w; });
                for (let i = 0; i < u.length; i++)
                    for (let j = i + 1; j < u.length; j++) {
                        const k = u[i] + '-' + u[j];
                        aff[k] = (aff[k] || 0) + w;
                    }
            });
            let start = 1;
            for (let n = 2; n <= N; n++) if (single[n] > single[start]) start = n;
            const picked = [start];
            while (picked.length < size) {
                let best = -1, bestScore = -1;
                for (let n = 1; n <= N; n++) {
                    if (picked.includes(n)) continue;
                    let s = 0;
                    for (const p of picked) s += aff[pk(p, n)] || 0;
                    if (s > bestScore) { bestScore = s; best = n; }
                }
                if (best < 0) break;
                picked.push(best);
            }
            return picked.slice(0, size).sort((a, b) => a - b);
        }

        // Build a pick of `size` numbers using one of three lenses. All need >=30
        // recent games; below that they fall back to random (per the reference).
        smartPick(view, size) {
            const N = this.numberCount;
            if (this.getRecentDraws(30).length < 30) return this.getRandomNumbers(size);
            if (view === 'pairs') return this.pairsPick(size);
            if (view === 'stats') {
                return (this.getVarianceNumbers(size) || []).filter(n => n >= 1 && n <= N).slice(0, size).sort((a, b) => a - b);
            }
            const score = this.patternScores();
            return Array.from({ length: N }, (_, i) => i + 1)
                .sort((a, b) => score[b] - score[a])
                .slice(0, size)
                .sort((a, b) => a - b);
        }

        renderSmartPicker() {
            const el = this.overlay?.querySelector('#overlay-smart-picker');
            if (!el) return;
            const view = this.smartPickView || (this.smartPickView = 'pattern');
            const size = this.smartPickSize || (this.smartPickSize = 6);

            const tabTips = {
                pattern: 'Pattern — blends many signals (streaks, gaps, positional bias, frequency, momentum, hot-combo membership) into one score and picks the top numbers.',
                pairs: 'Pairs — recency-weighted correlation matrix; starts from the strongest number and grows a set that tends to land TOGETHER.',
                stats: 'Stats — z-score / chi-square: numbers running most significantly ABOVE their expected frequency (statistically over-represented).'
            };
            const tabs = [['pattern', 'Pattern'], ['pairs', 'Pairs'], ['stats', 'Stats']].map(([v, l]) =>
                `<button class="vx-gtab ${v === view ? 'on' : ''}" data-spview="${v}" title="${tabTips[v]}">${l}</button>`).join('');
            const sizeOpts = [4, 5, 6, 7, 8, 9, 10].map(s =>
                `<option value="${s}" ${s === size ? 'selected' : ''}>${s} numbers</option>`).join('');

            const pick = this.smartPick(view, size);
            const stats = pick.length ? this.getComboStats(pick) : null;
            const gapText = !stats ? '—' : (stats.gap == null ? '—' : (stats.gap === 0 ? 'NOW' : stats.gap));

            const numsHtml = pick.length
                ? pick.map(n => `<span class="vx-chip">${n}</span>`).join('')
                : `<span class="vx-combos-empty" style="padding:0">Need 30+ games — playing builds the picks.</span>`;

            const statline = stats ? `<div class="vx-spstats">
                    <span>best <b>${stats.best.toFixed(1)}x</b></span>
                    <span>avg <b>${stats.avg.toFixed(1)}x</b></span>
                    <span>plays <b>${stats.plays}</b></span>
                    <span>gap <b>${gapText}</b></span>
                    <span title="${stats.paid ? `Net profit on ${stats.paid} paid play${stats.paid === 1 ? '' : 's'} of this exact combo, ${fmtMoney(stats.wagered, stats.cur, { signed: false })} wagered.` : 'No money staked on this combo yet.'}">P/L <b class="${stats.mixed ? '' : this.plClass(stats.pl, stats.cur)}">${stats.paid ? this.plFmt(stats.pl, stats.cur, { mixed: stats.mixed, compact: true }) : '—'}</b></span>
                </div>` : '';

            el.innerHTML = `
                <div class="vx-combos-head"><span class="vx-section-title">Smart picker</span></div>
                <div class="vx-gtabs">${tabs}</div>
                <div class="vx-spctl">
                    <select class="vx-spsize" id="overlay-sp-size" title="How many numbers to pick">${sizeOpts}</select>
                    ${pick.length ? `<button class="vx-spapply" id="overlay-sp-apply">Apply</button>` : ''}
                </div>
                <div class="vx-spnums">${numsHtml}</div>
                ${statline}`;

            el.querySelectorAll('.vx-gtab').forEach(b => b.onclick = () => { this.smartPickView = b.dataset.spview; this.renderSmartPicker(); });
            const sizeSel = el.querySelector('#overlay-sp-size');
            if (sizeSel) sizeSel.onchange = (e) => { this.smartPickSize = parseInt(e.target.value, 10); this.renderSmartPicker(); };
            const applyBtn = el.querySelector('#overlay-sp-apply');
            if (applyBtn) applyBtn.onclick = () => this.applyCombo(pick);
        }

        fetchAndDisplayCorrelations() {
            // Throttle correlation analysis - it's expensive and not needed on every bet
            const now = Date.now();
            if (this.lastCorrelationFetch && (now - this.lastCorrelationFetch) < 5000) {
                return; // Skip if we fetched in the last 5 seconds
            }
            this.lastCorrelationFetch = now;

            const siteKey = `${this.storageOrigin}-keno-session`;
            const results = this.cachedKenoResults?.[siteKey] || [];

            if (results.length < 10) {
                this.correlationData = null;
                return;
            }
            const browserAPI = (typeof browser !== 'undefined') ? browser : chrome;
            if (browserAPI && browserAPI.runtime && browserAPI.runtime.sendMessage) {
                const origin = this.storageOrigin;
                browserAPI.runtime.sendMessage({ type: 'ANALYZE_CORRELATIONS', origin: origin }, (response) => {
                    if (browserAPI.runtime.lastError) {
                        // Service worker might be inactive - silently skip (won't break overlay)
                        this.correlationData = null;
                        return;
                    }
                    if (response && response.result) {
                        this.correlationData = response.result;
                    }
                });
            }
        }

        createOverlay() {
            this.overlay = document.createElement('div');
            this.overlay.id = 'geminyzer-overlay';
            this.overlay.innerHTML = `
            <div class="overlay-header">
                <div class="overlay-title">
                    <span class="overlay-icon">${this.ctlIcon('bolt')}</span>
                    <span class="overlay-name">VantEdge</span>
                    <span class="overlay-pro">PRO</span>
                    <span class="overlay-stats">
                        <span id="overlay-total-bets">0</span> <span id="overlay-stats-label">bets</span>
                        <span id="enhancement-status" class="enhancement-status" title="Enhancement Status">⚡</span>
                    </span>
                </div>
                <div class="overlay-controls">
                    <button id="overlay-layout" title="Toggle sidebar / overlay">${this.ctlIcon('layout')}</button>
                    <button id="overlay-reset" title="Reset Stats">${this.ctlIcon('refresh')}</button>
                    <button id="overlay-minimize" title="Minimize">${this.ctlIcon('minus')}</button>
                    <button id="overlay-toggle" title="Hide">${this.ctlIcon('x')}</button>
                </div>
            </div>
            <div class="overlay-content" id="overlay-content"></div>`;
            safe(() => document.body.appendChild(this.overlay));

            // The old slide-out "Alternative" drawer + its ▶ tab were removed in
            // favour of the in-grid Core/Alternative toggle. All drawer methods
            // (positionSideDrawer/toggleSideDrawer/etc.) null-guard, so leaving them
            // is harmless; we simply no longer create the DOM.
        }

        // ===================== Mines mode ==================================
        // Mines rounds are captured by injected.js and stored by the service
        // worker under `minesResults[origin]` (finished rounds only — those are
        // the ones that reveal the whole layout). The panel reads that history
        // straight from storage, the same way the keno body reads kenoResults.
        //
        // Everything here is descriptive: where mines have landed in the rounds
        // you played, and what the board pays. Layouts are drawn fresh each
        // round, so none of it forecasts the next one.

        initMinesMode() {
            this.minesSelection = new Set();
            this.loadMinesFromStorage();
            this.setupMinesStorageListener();
        }

        loadMinesFromStorage() {
            const browserAPI = (typeof browser !== 'undefined' && browser?.storage) ? browser :
                (typeof chrome !== 'undefined' && chrome?.storage) ? chrome : null;
            if (!browserAPI?.storage?.local) {
                console.warn('Browser storage API not available.');
                return;
            }
            browserAPI.storage.local.get(['minesResults'], (result) => {
                if (browserAPI.runtime?.lastError) {
                    console.error('Error loading mines data:', browserAPI.runtime.lastError.message);
                    return;
                }
                this.processMinesData(result?.minesResults);
            });
        }

        setupMinesStorageListener() {
            const browserAPI = (typeof browser !== 'undefined') ? browser : chrome;
            if (!browserAPI?.storage?.onChanged || this.minesListenerAdded) return;
            // Debounced like the keno listener: a round can write several times
            // while it settles, and the whole panel re-renders on each change.
            const debounced = this.debounce((changes, area) => {
                if (area === 'local' && changes.minesResults) {
                    this.processMinesData(changes.minesResults.newValue);
                }
            }, 400);
            browserAPI.storage.onChanged.addListener(debounced);
            this._storageListeners.push(debounced);
            this.minesListenerAdded = true;
        }

        processMinesData(minesResults) {
            const all = minesResults?.[this.storageOrigin] || [];
            this._minesGames = all.filter(g => g && g.state); // newest first
            this._minesAnalysisCache = null;
            // Keep the count the user picked while it still has rounds; otherwise
            // follow the most recent round.
            const counts = this.minesCountsPlayed();
            if (!counts.includes(this.minesCount)) {
                this.minesCount = this.minesGameCount(this._minesGames[0]) || counts[0] || null;
            }
            this.renderMines();
        }

        // --- payout math ---------------------------------------------------

        // What the board pays for `revealed` gems in a row with `mineCount`
        // mines: (1 − 1% house edge) / P(that many safe picks), which works out
        // to 0.99 × C(25,k) / C(25−M,k). Rounded to cents with exact halves
        // going down, which is what the games print (1 mine on a 3-mine board
        // is exactly 1.125 and shows as 1.12x). Checked row by row against a
        // published 3-mine ladder and against 16-mine values.
        minesMultiplier(mineCount, revealed) {
            const N = 25;
            if (!(mineCount > 0) || revealed <= 0 || revealed > N - mineCount) return 0;
            let m = 0.99;
            for (let i = 0; i < revealed; i++) m *= (N - i) / (N - mineCount - i);
            return Math.round(m * 100 - 1e-9) / 100;
        }

        // 1.12x / 13.80x / 114x / 2.3kx — the way the games print them.
        fmtMult(m) {
            if (!(m > 0)) return '—';
            if (m < 100) return `${m.toFixed(2)}x`;
            if (m < 1000) return `${Math.round(m)}x`;
            if (m < 1e6) return `${(m / 1e3).toFixed(1).replace(/\.0$/, '')}kx`;
            return `${(m / 1e6).toFixed(1).replace(/\.0$/, '')}Mx`;
        }

        // --- history shaping -------------------------------------------------

        // Mines in a round. Sites tag it as minesCount/mineCount; if neither came
        // through, the revealed layout is itself the count.
        minesGameCount(game) {
            if (!game) return null;
            const tagged = Number(game.state?.minesCount ?? game.state?.mineCount) || 0;
            if (tagged > 0) return tagged;
            const mines = game.state?.mines;
            return Array.isArray(mines) && mines.length ? mines.length : null;
        }

        // Mine counts played on this site, low to high.
        minesCountsPlayed() {
            const seen = new Set();
            for (const g of this._minesGames) {
                const c = this.minesGameCount(g);
                if (c) seen.add(c);
            }
            return [...seen].sort((a, b) => a - b);
        }

        minesGamesForCount(count = this.minesCount) {
            return this._minesGames.filter(g => this.minesGameCount(g) === count);
        }

        // Tiles the player actually clicked in a round, 0-24.
        minesPicksOf(game) {
            const rounds = game?.state?.rounds;
            if (!Array.isArray(rounds)) return [];
            const out = [];
            for (const r of rounds) {
                const f = parseInt(r?.field ?? r, 10);
                if (f >= 0 && f < 25) out.push(f);
            }
            return out;
        }

        // Everything the panel derives from one mine count's rounds, computed
        // once per (count, history length) — the render path touches it a lot.
        minesAnalysis() {
            const games = this.minesGamesForCount();
            const key = `${this.minesCount}:${games.length}:${this._minesGames.length}`;
            if (this._minesAnalysisCache?.key === key) return this._minesAnalysisCache.value;

            const hits = new Array(25).fill(0);
            const masks = [];   // one 25-bit mine mask per round, for cluster lookups
            for (const g of games) {
                const mines = g.state?.mines;
                if (!Array.isArray(mines) || !mines.length) continue;
                let mask = 0;
                for (let i = 0; i < mines.length; i++) {
                    const pos = parseInt(mines[i], 10);
                    if (pos >= 0 && pos < 25) { hits[pos]++; mask |= (1 << pos); }
                }
                masks.push(mask);
            }
            const value = { games, hits, masks, layouts: masks.length };
            this._minesAnalysisCache = { key, value };
            return value;
        }

        // Session numbers for a set of rounds: money P/L (shared rule), win rate,
        // average multiplier and streaks. A round counts as a win when it paid
        // anything back.
        minesSessionStats(games) {
            const money = VantedgeMoney.summarize(games);
            let wins = 0, sumMult = 0, best = 0;
            for (const g of games) {
                const mult = Number(g.payoutMultiplier) || 0;
                if (mult > 0) wins++;
                if (mult > best) best = mult;
                sumMult += mult;
            }
            let streak = { type: null, count: 0 };
            const longest = { win: 0, loss: 0 };
            for (let i = games.length - 1; i >= 0; i--) { // oldest first
                const type = (Number(games[i].payoutMultiplier) || 0) > 0 ? 'win' : 'loss';
                streak = streak.type === type ? { type, count: streak.count + 1 } : { type, count: 1 };
                if (streak.count > longest[type]) longest[type] = streak.count;
            }
            return {
                money, games: games.length, wins, best,
                avgMult: games.length ? sumMult / games.length : 0,
                winRate: games.length ? (wins / games.length) * 100 : 0,
                streak, longest
            };
        }

        // Corner (4 tiles), edge (12) and centre (9) shares of the mines seen.
        // `share` is the observed split, `expected` what an even spread gives.
        minesRegions(hits) {
            const regions = { corner: [], edge: [], center: [] };
            for (let i = 0; i < 25; i++) {
                const r = Math.floor(i / 5), c = i % 5;
                const onEdge = r === 0 || r === 4 || c === 0 || c === 4;
                const corner = (r === 0 || r === 4) && (c === 0 || c === 4);
                regions[corner ? 'corner' : onEdge ? 'edge' : 'center'].push(i);
            }
            const total = hits.reduce((a, b) => a + b, 0);
            return Object.entries(regions).map(([name, tiles]) => {
                const seen = tiles.reduce((sum, i) => sum + hits[i], 0);
                return {
                    name, tiles: tiles.length,
                    share: total ? (seen / total) * 100 : 0,
                    expected: (tiles.length / 25) * 100,
                    seen
                };
            });
        }

        // Groups of tiles that came through a round clean together. `rate` is the
        // share of rounds where none of them was mined; `fair` is the rate an
        // untouched board gives, so `edge` is how far this history sits from it.
        // Candidates come from the least-mined tiles — a cluster is only
        // interesting where the tiles are individually clean too.
        minesClusters(size, limit = 3) {
            const { hits, masks, layouts } = this.minesAnalysis();
            const mineCount = this.minesCount;
            if (layouts < 10 || !mineCount || size > 25 - mineCount) return [];
            const pool = hits.map((h, i) => ({ i, h }))
                .sort((a, b) => a.h - b.h || a.i - b.i)
                .slice(0, Math.min(12, 25 - mineCount))
                .map(t => t.i);
            // Fair rate for k tiles all missing the mines: C(25-M,k)/C(25,k).
            let fair = 1;
            for (let i = 0; i < size; i++) fair *= (25 - mineCount - i) / (25 - i);

            const out = [];
            const combo = new Array(size);
            const walk = (start, depth) => {
                if (depth === size) {
                    let mask = 0;
                    for (const t of combo) mask |= (1 << t);
                    let clean = 0;
                    for (let m = 0; m < masks.length; m++) if ((masks[m] & mask) === 0) clean++;
                    const rate = clean / masks.length;
                    out.push({ tiles: combo.slice().sort((a, b) => a - b), rate, clean, fair, edge: fair > 0 ? (rate / fair - 1) * 100 : 0 });
                    return;
                }
                for (let i = start; i <= pool.length - (size - depth); i++) {
                    combo[depth] = pool[i];
                    walk(i + 1, depth + 1);
                }
            };
            walk(0, 0);
            return out.sort((a, b) => b.rate - a.rate || a.tiles[0] - b.tiles[0]).slice(0, limit);
        }

        // Tile sets the player actually revealed, keyed by the sorted set —
        // the mines twin of the keno combo history.
        minesComboHistory() {
            const { games } = this.minesAnalysis();
            const map = Object.create(null);
            games.forEach((g, idx) => {
                const picks = [...new Set(this.minesPicksOf(g))].sort((a, b) => a - b);
                if (picks.length < 2) return;
                const key = picks.join('-');
                let m = map[key];
                if (!m) m = map[key] = { key, tiles: picks, plays: 0, paid: 0, best: 0, sumMult: 0, pl: 0, wagered: 0, cur: null, mixed: false, lastSeen: idx };
                m.plays++;
                const mult = Number(g.payoutMultiplier) || 0;
                if (mult > m.best) m.best = mult;
                const stake = VantedgeMoney.betStake(g);
                if (stake > 0) {
                    m.paid++;
                    m.sumMult += mult;
                    m.pl += betProfit(g);
                    m.wagered += stake;
                    const cur = curKey(g.currency);
                    if (m.cur === null) m.cur = cur; else if (m.cur !== cur) m.mixed = true;
                }
                if (idx < m.lastSeen) m.lastSeen = idx;
            });
            return Object.values(map).map(m => {
                m.avg = m.paid ? m.sumMult / m.paid : 0;
                m.cur = m.cur || 'usd';
                return m;
            }).sort((a, b) => b.plays - a.plays || b.best - a.best);
        }

        // --- selection + board marking ---------------------------------------

        minesToggleTile(i) {
            if (this.minesSelection.has(i)) this.minesSelection.delete(i); else this.minesSelection.add(i);
            this.renderMines();
        }

        minesSelect(tiles) {
            this.minesSelection = new Set(tiles);
            this.renderMines();
        }

        // The n least-mined tiles at this mine count.
        minesSafestTiles(n) {
            const { hits } = this.minesAnalysis();
            return hits.map((h, i) => ({ i, h })).sort((a, b) => a.h - b.h || a.i - b.i).slice(0, n).map(t => t.i);
        }

        // n tiles drawn from the cleaner half — same information, less
        // predictable than always taking the same top tiles.
        minesRandomSafeTiles(n) {
            const { hits } = this.minesAnalysis();
            const half = hits.map((h, i) => ({ i, h })).sort((a, b) => a.h - b.h || a.i - b.i)
                .slice(0, Math.max(n, 13)).map(t => t.i);
            for (let i = half.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [half[i], half[j]] = [half[j], half[i]];
            }
            return half.slice(0, n).sort((a, b) => a - b);
        }

        // The 25 tiles of the live board, if they can be found. Cached briefly —
        // the board re-renders constantly during a round.
        findMinesTiles() {
            const now = Date.now();
            if (this._minesTiles && (now - this._minesTilesAt) < 3000) return this._minesTiles;
            return safe(() => {
                const groups = new Map();
                const nodes = document.querySelectorAll('button, [role="button"], [data-test*="tile"], [class*="tile"]');
                for (const el of nodes) {
                    if (el.closest('#geminyzer-overlay')) continue;
                    const rect = el.getBoundingClientRect();
                    if (rect.width < 30 || rect.height < 30) continue;
                    if (Math.abs(rect.width - rect.height) > rect.width * 0.35) continue; // tiles are square
                    const parent = el.parentElement;
                    if (!parent) continue;
                    if (!groups.has(parent)) groups.set(parent, []);
                    groups.get(parent).push(el);
                }
                for (const [, kids] of groups) {
                    if (kids.length !== 25) continue;
                    // Row-major order is what the games index by.
                    kids.sort((a, b) => {
                        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
                        return Math.abs(ra.top - rb.top) > 5 ? ra.top - rb.top : ra.left - rb.left;
                    });
                    this._minesTiles = kids;
                    this._minesTilesAt = now;
                    return kids;
                }
                this._minesTiles = null;
                this._minesTilesAt = now;
                return null;
            });
        }

        // Ring the selected tiles on the real board. Marks only — revealing a
        // tile is a real bet action, so the clicking stays with the player.
        syncMinesBoardMarks() {
            safe(() => {
                const tiles = this.findMinesTiles();
                if (!tiles) return;
                tiles.forEach((el, i) => el.classList.toggle('vx-board-pick', this.minesSelection.has(i)));
            });
        }

        // --- rendering --------------------------------------------------------

        renderMines() {
            safe(() => {
                // Header count tracks the selected mine count, so it always agrees
                // with the Games tile rather than quietly counting other boards.
                const total = this.overlay?.querySelector('#overlay-total-bets');
                if (total) total.textContent = this.minesGamesForCount().length.toLocaleString();
                const stats = this.overlay?.querySelector('.overlay-stats');
                if (stats) {
                    stats.title = this.minesCount
                        ? `Finished rounds at ${this.minesCount} mines. ${this._minesGames.length} recorded here in total.`
                        : 'Finished mines rounds recorded here.';
                }
                this.renderMinesStrip();
                this.renderMinesBoard();
                this.renderMinesHistory();
                this.syncMinesBoardMarks();
            });
        }

        renderMinesStrip() {
            const el = this.overlay?.querySelector('#overlay-mines-strip');
            if (!el) return;
            const st = this.minesSessionStats(this.minesGamesForCount());
            const m = st.money;
            const hasPaid = m.paid > 0;
            const eps = curEpsilon(m.cur, m.pl);
            const plCls = m.pl > eps ? 'hot' : (m.pl < -eps ? 'plneg' : '');
            const per = this.minesCount ? ` at ${this.minesCount} mines` : '';
            const others = m.others.length
                ? ` Also ${m.others.map(o => fmtMoney(o.pl, o.cur)).join(', ')} (kept separate — no conversion).`
                : '';
            const tip = {
                games: `Finished rounds${per} on this site.`,
                win: `Rounds that paid anything back${per}. Cashing out below your stake still counts as a win here.`,
                avg: `Average payout multiplier over every round${per} — busts included, so 1.00x is break-even. Best so far ${this.fmtMult(st.best)}.`,
                pl: hasPaid
                    ? `Net profit${per}: stake × (multiplier − 1), summed. `
                      + `${m.bets} paid round${m.bets === 1 ? '' : 's'}, ${fmtMoney(m.wagered, m.cur, { signed: false })} wagered, `
                      + `ROI ${m.roi > 0 ? '+' : ''}${m.roi.toFixed(1)}%.${others} Free ($0) rounds are excluded.`
                    : `Net profit${per} on real-money rounds. Free ($0) rounds are excluded.`
            };
            el.innerHTML =
                this.statTile('Games', st.games.toLocaleString(), '', tip.games) +
                this.statTile('Win', st.games ? `${st.winRate.toFixed(0)}%` : '—', '', tip.win) +
                this.statTile('Avg', st.games ? `${st.avgMult.toFixed(2)}x` : '—', st.avgMult > 1 ? 'hot' : '', tip.avg) +
                this.statTile('P/L', hasPaid ? fmtMoney(m.pl, m.cur, { compact: true }) : '—', hasPaid ? plCls : '', tip.pl);
        }

        renderMinesBoard() {
            const el = this.overlay?.querySelector('#overlay-mines-board');
            if (!el) return;
            const counts = this.minesCountsPlayed();
            if (!counts.length) {
                el.innerHTML = `<div class="vx-combos-head"><span class="vx-section-title">Mine heatmap</span></div>
                    <div class="vx-combos-empty">No finished mines rounds on this site yet — play one and the board fills in.</div>`;
                return;
            }
            const mineCount = this.minesCount;
            const { hits, layouts } = this.minesAnalysis();
            const expected = layouts ? layouts * (mineCount / 25) : 0;
            const worst = Math.max(...hits, 1);
            const ranked = hits.map((h, i) => ({ i, h })).sort((a, b) => a.h - b.h || a.i - b.i);
            const ready = layouts >= 10;

            const tabs = counts.map(c =>
                `<button class="vx-mtab ${c === mineCount ? 'on' : ''}" data-minecount="${c}" title="Rounds played with ${c} mines">${c}</button>`
            ).join('');

            const cells = hits.map((h, i) => {
                const pct = layouts ? (h / layouts) * 100 : 0;
                const style = layouts === 0 ? '' : this.minesTileStyle(h, expected, worst);
                const title = layouts
                    ? `Tile ${i + 1} — mined in ${h} of ${layouts} rounds (${pct.toFixed(0)}%), an even spread gives ${expected.toFixed(1)}`
                    : `Tile ${i + 1} — no rounds yet`;
                return `<div class="vx-mcell${this.minesSelection.has(i) ? ' picked' : ''}" data-tile="${i}" style="${style}" title="${title}">
                            <span class="vx-mnum">${i + 1}</span>
                            <span class="vx-mhits">${layouts ? h : '—'}</span>
                        </div>`;
            }).join('');

            const picked = this.minesSelection.size;
            const cur = this.minesMultiplier(mineCount, picked);
            const next = this.minesMultiplier(mineCount, picked + 1);
            const maxReveal = 25 - mineCount;
            const pickLine = picked
                ? `<span class="vx-mselk">Selected ${picked}</span>
                   <b class="vx-mselv">${this.fmtMult(cur)}</b>
                   <span class="vx-mselnext">next ${next ? this.fmtMult(next) : '—'}</span>`
                : `<span class="vx-mselk">No tiles selected</span><span class="vx-mselnext">pick some to see the payout</span>`;

            const sizeOpts = Array.from({ length: Math.min(maxReveal, 12) }, (_, k) => k + 1)
                .map(n => `<option value="${n}" ${n === (this.minesPickSize || 3) ? 'selected' : ''}>${n}</option>`).join('');

            const safest = ranked.slice(0, 3).map(r => `<b>${r.i + 1}</b>`).join(' ');
            const danger = ranked.slice(-3).reverse().map(r => `<b class="bad">${r.i + 1}</b>`).join(' ');
            const rankLine = ready
                ? `<div class="vx-mrank"><span>Least mined ${safest}</span><span>Most mined ${danger}</span></div>`
                : `<div class="vx-mrank dim">Rankings need 10 rounds at this mine count (${layouts} so far).</div>`;

            const regions = this.minesRegions(hits);
            const regionLine = ready
                ? `<div class="vx-mregions">${regions.map(r =>
                      `<span title="${r.tiles} tiles held ${r.seen} of the mines seen — an even spread gives ${r.expected.toFixed(0)}%">${r.name} <b class="${r.share > r.expected + 4 ? 'bad' : (r.share < r.expected - 4 ? 'good' : '')}">${r.share.toFixed(0)}%</b></span>`
                  ).join('')}</div>`
                : '';

            el.innerHTML = `
                <div class="vx-combos-head"><span class="vx-section-title">Mine heatmap</span><span class="vx-chcount">${layouts} rounds</span></div>
                <div class="vx-mtabs" title="Filter every panel by how many mines were on the board">${tabs}<span class="vx-mtabs-k">mines</span></div>
                <div class="vx-mines-grid">${cells}</div>
                ${rankLine}
                ${regionLine}
                <div class="vx-mpick">
                    <select class="vx-mpsize" id="overlay-mines-size" title="How many tiles to pick">${sizeOpts}</select>
                    <button class="vx-mpbtn" id="overlay-mines-safest" title="The least-mined tiles in this history">Safest</button>
                    <button class="vx-mpbtn" id="overlay-mines-random" title="Drawn from the cleaner half, so it isn't the same tiles every round">Random safe</button>
                    <button class="vx-mpbtn" id="overlay-mines-clear" title="Clear the selection">Clear</button>
                </div>
                <div class="vx-msel">${pickLine}</div>
                <div class="vx-mines-note">Picks are marked on the board — revealing a tile is a real bet, so that click stays yours. Layouts are drawn fresh every round: this is where mines have been, not where they'll be.</div>
                ${this.renderMinesClusters()}`;

            el.querySelectorAll('.vx-mtab').forEach(b => {
                b.onclick = () => {
                    this.minesCount = parseInt(b.dataset.minecount, 10);
                    this.minesSelection.clear();
                    this.renderMines();
                };
            });
            el.querySelectorAll('.vx-mcell').forEach(c => {
                c.onclick = () => this.minesToggleTile(parseInt(c.dataset.tile, 10));
            });
            const size = el.querySelector('#overlay-mines-size');
            // Re-render: the cluster table is built at the picker's size.
            if (size) size.onchange = (e) => { this.minesPickSize = parseInt(e.target.value, 10); this.renderMines(); };
            const pickSize = () => this.minesPickSize || 3;
            const safeBtn = el.querySelector('#overlay-mines-safest');
            if (safeBtn) safeBtn.onclick = () => this.minesSelect(this.minesSafestTiles(pickSize()));
            const randBtn = el.querySelector('#overlay-mines-random');
            if (randBtn) randBtn.onclick = () => this.minesSelect(this.minesRandomSafeTiles(pickSize()));
            const clearBtn = el.querySelector('#overlay-mines-clear');
            if (clearBtn) clearBtn.onclick = () => this.minesSelect([]);
            el.querySelectorAll('.vx-mclust').forEach(row => {
                row.onclick = () => this.minesSelect((row.dataset.tiles || '').split(',').map(Number));
            });
        }

        // Green where a tile has been cleaner than an even spread, red where it
        // has taken more than its share — mines reads as safe/dangerous rather
        // than the keno grid's hot/cold.
        minesTileStyle(hits, expected, worst) {
            const base = [47, 56, 69], baseBot = [36, 44, 56];
            const safe = [30, 84, 54], safeEdge = [63, 185, 80];
            const risk = [110, 42, 42], riskEdge = [229, 83, 75];
            let t, fill, edge;
            if (expected <= 0) { t = 0; fill = base; edge = [72, 80, 94]; }
            else if (hits <= expected) {
                t = Math.min((expected - hits) / expected, 1);
                fill = safe; edge = safeEdge;
            } else {
                t = Math.min((hits - expected) / Math.max(worst - expected, 1), 1);
                fill = risk; edge = riskEdge;
            }
            const mix = (a, b) => Math.round(a + (b - a) * t);
            const rgb = (from, to) => `rgb(${mix(from[0], to[0])}, ${mix(from[1], to[1])}, ${mix(from[2], to[2])})`;
            return `background:linear-gradient(180deg, ${rgb(base, fill)}, ${rgb(baseBot, fill)});`
                 + `border-color:${rgb([72, 80, 94], edge)};color:#eef3f8`;
        }

        renderMinesClusters() {
            const size = Math.min(this.minesPickSize || 3, Math.max(25 - (this.minesCount || 1) - 1, 1));
            const clusters = this.minesClusters(size);
            if (!clusters.length) return '';
            const rows = clusters.map(c => {
                const ev = c.rate * this.minesMultiplier(this.minesCount, c.tiles.length);
                const edgeCls = c.edge > 0 ? 'good' : 'bad';
                return `<div class="vx-mclust" data-tiles="${c.tiles.join(',')}" title="All ${c.tiles.length} came through clean in ${c.clean} of the rounds. An untouched board gives ${(c.fair * 100).toFixed(0)}%. Click to select them.">
                            <span class="vx-mctiles">${c.tiles.map(t => t + 1).join(' · ')}</span>
                            <span class="vx-mcrate">${(c.rate * 100).toFixed(0)}%</span>
                            <span class="vx-mcedge ${edgeCls}">${c.edge > 0 ? '+' : ''}${c.edge.toFixed(0)}%</span>
                            <span class="vx-mcev">${ev.toFixed(2)}</span>
                        </div>`;
            }).join('');
            return `<div class="vx-mclusters">
                        <div class="vx-mchead"><span>Clean together</span><span>rate</span><span>vs fair</span><span title="History rate × the payout for that many reveals. A record of what those tiles returned, not an expectation for the next round.">ret</span></div>
                        ${rows}
                    </div>`;
        }

        renderMinesHistory() {
            const el = this.overlay?.querySelector('#overlay-mines-history');
            if (!el) return;
            const games = this.minesGamesForCount();
            const head = `<div class="vx-combos-head"><span class="vx-section-title">Recent rounds</span><span class="vx-chcount">${games.length}</span></div>`;
            if (!games.length) {
                el.innerHTML = head + `<div class="vx-combos-empty">Nothing at this mine count yet.</div>`;
                return;
            }
            const chips = games.slice(0, 16).map(g => {
                const mult = Number(g.payoutMultiplier) || 0;
                const win = mult > 0;
                const stake = VantedgeMoney.betStake(g);
                const picks = this.minesPicksOf(g);
                const where = picks.length ? ` · picked ${picks.map(p => p + 1).join(', ')}` : '';
                const title = stake
                    ? `${this.fmtMult(mult) || 'bust'} on ${fmtMoney(stake, g.currency, { signed: false })} — ${fmtMoney(betProfit(g), g.currency)}${where}`
                    : `${win ? this.fmtMult(mult) : 'bust'} on a free round${where}`;
                return `<span class="vx-mchip ${win ? 'win' : 'loss'}" title="${title}">${win ? this.fmtMult(mult).replace('x', '') + 'x' : '✕'}</span>`;
            }).join('');
            const st = this.minesSessionStats(games);
            const { type, count } = st.streak;
            const streakText = type
                ? `${count} ${type === 'win' ? (count === 1 ? 'win' : 'wins') : (count === 1 ? 'loss' : 'losses')}`
                : '—';
            const combos = this.minesComboHistory().slice(0, 5);
            const comboRows = combos.length ? `
                <div class="vx-mcombos">
                    <div class="vx-mchead"><span>Tiles you revealed</span><span>best</span><span>avg</span><span>plays</span></div>
                    ${combos.map(c => `
                        <div class="vx-mclust" data-tiles="${c.tiles.join(',')}" title="Click to select these tiles. ${c.paid ? `${fmtMoney(c.pl, c.cur)} over ${c.paid} paid play${c.paid === 1 ? '' : 's'}${c.mixed ? ' (mixed currencies — no total shown)' : ''}` : 'Free plays only'}. Last played ${c.lastSeen === 0 ? 'this round' : `${c.lastSeen} rounds ago`}.">
                            <span class="vx-mctiles">${c.tiles.map(t => t + 1).join(' · ')}</span>
                            <span class="vx-mcrate">${this.fmtMult(c.best)}</span>
                            <span class="vx-mcedge">${c.avg.toFixed(2)}x</span>
                            <span class="vx-mcev">${c.plays}</span>
                        </div>`).join('')}
                </div>` : '';
            el.innerHTML = head + `
                <div class="vx-mchips">${chips}</div>
                <div class="vx-mstreak">Current streak <b class="${type === 'win' ? 'pos' : 'neg'}">${streakText}</b>
                    · best run <b class="pos">${st.longest.win}W</b> / <b class="neg">${st.longest.loss}L</b></div>
                ${comboRows}
                ${this.renderMinesPayouts()}`;
            el.querySelectorAll('.vx-mclust').forEach(row => {
                row.onclick = () => this.minesSelect((row.dataset.tiles || '').split(',').map(Number));
            });
            const toggle = el.querySelector('#overlay-mines-payhead');
            if (toggle) toggle.onclick = () => { this.minesPayoutsOpen = !this.minesPayoutsOpen; this.renderMines(); };
        }

        // The full payout ladder for this mine count — exact, so it matches the
        // table on the page.
        renderMinesPayouts() {
            const mineCount = this.minesCount;
            if (!mineCount) return '';
            const maxReveal = 25 - mineCount;
            const open = !!this.minesPayoutsOpen;
            const head = `<div class="vx-mpayhead" id="overlay-mines-payhead" title="Every multiplier for a ${mineCount}-mine board">
                    <span class="vx-section-title">Payouts</span>
                    <span class="vx-chcount">${mineCount} mines</span>
                    <span class="vx-mpaymax">max ${this.fmtMult(this.minesMultiplier(mineCount, maxReveal))}</span>
                    <span class="vx-mcar">${open ? '▲' : '▼'}</span>
                </div>`;
            if (!open) return head;
            const rows = Array.from({ length: maxReveal }, (_, k) => k + 1).map(k =>
                `<span class="vx-mpayrow ${k === this.minesSelection.size ? 'on' : ''}"><i>${k}</i>${this.fmtMult(this.minesMultiplier(mineCount, k))}</span>`
            ).join('');
            return head + `<div class="vx-mpaygrid">${rows}</div>`;
        }

        // One status-strip tile, shared by the keno and mines strips.
        statTile(label, value, cls = '', title = '') {
            return `<div class="vx-stat" title="${title}"><span class="vx-stat-k">${label}</span><span class="vx-stat-v ${cls}">${value}</span></div>`;
        }

        kenoMarkup() {
            return `
                <div class="vx-status-strip" id="overlay-status-strip"></div>
                <div class="keno-heatmap-container">
                    <div class="keno-heatmap-grid" id="overlay-keno-grid"></div>
                    <div class="quick-actions-container">
                        <div class="vx-strat-toggle" id="overlay-strat-toggle">
                            <button class="vx-st-btn on" data-stratview="main">Core</button>
                            <button class="vx-st-btn" data-stratview="alt">Alternative</button>
                        </div>
                        <div class="quick-actions-grid" id="overlay-quick-actions">
                            </div>
                    </div>
                </div>
                <div class="vx-combos" id="overlay-smart-picker"></div>
                <div class="vx-combos" id="overlay-hot-combos"></div>
                <div class="vx-combos" id="overlay-combo-history"></div>`;
        }

        minesMarkup() {
            return `
                <div class="vx-status-strip" id="overlay-mines-strip"></div>
                <div class="vx-combos" id="overlay-mines-board"></div>
                <div class="vx-combos" id="overlay-mines-history"></div>`;
        }

        // Small monochrome control glyph for the header (logo + buttons).
        ctlIcon(name) {
            const P = {
                bolt: '<path d="M13 2 3 14h7v8l10-12h-7z"/>',
                layout: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="15" y1="3" x2="15" y2="21"/>',
                refresh: '<path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 3 21 9 15 9"/>',
                check: '<polyline points="20 6 9 17 4 12"/>',
                x: '<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>',
                minus: '<line x1="5" y1="12" x2="19" y2="12"/>',
                plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'
            };
            return `<svg class="vx-ctl-icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
        }

        // Monochrome line icons (Lucide-style inline SVG). Inline because content
        // scripts can't rely on a webfont/CDN loading under casino-site CSP.
        // stroke="currentColor" lets each icon inherit the tile's text colour, so
        // active/AI/regime states (which only change border + glow) keep working.
        getStrategyIcon(strategyId) {
            const P = {
                hot: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
                cold: '<line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/><path d="m20 16-4-4 4-4"/><path d="m4 8 4 4-4 4"/><path d="m16 4-4 4-4-4"/><path d="m8 20 4-4 4 4"/>',
                smart: '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
                random: '<path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="m15 15 6 6"/><path d="m3 4 5 5"/>',
                overdue: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>',
                variance: '<path d="M3 12h4l3 8 4-16 3 8h4"/>',
                positional: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>',
                hotzone: '<rect x="3" y="3" width="18" height="18" rx="2"/><rect x="8" y="8" width="8" height="8"/>',
                progressive: '<polyline points="3 17 9 11 13 15 21 7"/><polyline points="15 7 21 7 21 13"/>',
                transition: '<path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 3 21 9 15 9"/>',
                entropy: '<circle cx="12" cy="12" r="1"/><path d="M20.2 20.2c2.04-2.03.02-7.36-4.5-11.9-4.54-4.52-9.87-6.54-11.9-4.5-2.04 2.03-.02 7.36 4.5 11.9 4.54 4.52 9.87 6.54 11.9 4.5Z"/><path d="M15.7 15.7c4.52-4.54 6.54-9.87 4.5-11.9-2.03-2.04-7.36-.02-11.9 4.5-4.52 4.54-6.54 9.87-4.5 11.9 2.03 2.04 7.36.02 11.9-4.5Z"/>',
                antipattern: '<circle cx="12" cy="12" r="9"/><line x1="5.6" y1="5.6" x2="18.4" y2="18.4"/>',
                streak: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
                volatility: '<path d="M2 12c2 0 2-5 4-5s2 5 4 5 2-5 4-5 2 5 4 5 2-5 4-5"/>',
                ema: '<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>',
                digitbias: '<line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/>',
                parity: '<path d="M12 3v18"/><path d="M5 7h14"/><path d="M5 7 2 13a3 3 0 0 0 6 0z"/><path d="M19 7l-3 6a3 3 0 0 0 6 0z"/><path d="M8 21h8"/>',
                adaptive: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
                regime: '<path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/>',
                cohesion: '<path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 0 1 0 10h-2"/><line x1="8" y1="12" x2="16" y2="12"/>',
                edge: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
                delta: '<path d="M12 4 4 19h16z"/>',
                regression: '<path d="M21.3 8.7 8.7 21.3a1 1 0 0 1-1.4 0l-4.6-4.6a1 1 0 0 1 0-1.4L15.3 2.7a1 1 0 0 1 1.4 0l4.6 4.6a1 1 0 0 1 0 1.4z"/><path d="m7.5 10.5 2 2"/><path d="m10.5 7.5 2 2"/><path d="m13.5 4.5 2 2"/>',
                portfolio: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/>',
                comboways: '<line x1="7" y1="7" x2="16" y2="9"/><line x1="7" y1="7" x2="9" y2="16"/><line x1="16" y1="9" x2="17" y2="17"/><line x1="9" y1="16" x2="17" y2="17"/><circle cx="7" cy="7" r="2.2"/><circle cx="16" cy="9" r="2.2"/><circle cx="9" cy="16" r="2.2"/><circle cx="17" cy="17" r="2.2"/>',
                condbonus: '<path d="M2 12h4l3 8 4-16 3 8h6"/>',
                bayesian: '<path d="M4 4h16"/><path d="m4 4 8 8-8 8h16"/>',
                montecarlo: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1"/><circle cx="15.5" cy="8.5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="8.5" cy="15.5" r="1"/><circle cx="15.5" cy="15.5" r="1"/>',
                coverage: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
                wheeling: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="3" x2="12" y2="21"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="5.6" y1="5.6" x2="18.4" y2="18.4"/><line x1="18.4" y1="5.6" x2="5.6" y2="18.4"/>',
                timeseries: '<polyline points="3 18 8 13 12 16 21 6"/><circle cx="8" cy="13" r="1"/><circle cx="12" cy="16" r="1"/>',
                balanced: '<path d="M12 3v18"/><path d="M5 7h14"/><path d="M5 7 2 13a3 3 0 0 0 6 0z"/><path d="M19 7l-3 6a3 3 0 0 0 6 0z"/><path d="M8 21h8"/>',
                momentum: '<path d="M9.59 4.59A2 2 0 1 1 11 8H2"/><path d="M17 12a2 2 0 1 0 2 2H2"/><path d="M14.83 19.41A2 2 0 1 0 16 23H2"/>',
                poisson: '<path d="M6.5 12c.94-3.46 4.94-6 8.5-6 3.56 0 6.06 2.54 7 6-.94 3.47-3.44 6-7 6s-7.56-2.53-8.5-6z"/><circle cx="16" cy="10" r="1"/><path d="M2 12s2 2 4 2"/>',
                gapextremes: '<polyline points="8 7 3 12 8 17"/><polyline points="16 7 21 12 16 17"/><line x1="3" y1="12" x2="21" y2="12"/>'
            };
            const inner = P[strategyId] || '<path d="M13 2 3 14h7v8l10-12h-7z"/>';
            return `<svg class="vx-strat-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
        }

        setupQuickActions() {
            const grid = this.overlay.querySelector('#overlay-quick-actions');
            if (!grid) {
                console.warn('⚠️ Vantedge: Grid not found in setupQuickActions');
                return;
            }

            const defaultPortfolio = [
                // Row 1 - Core
                { id: 'hot', name: 'Hot' },
                { id: 'cold', name: 'Cold' },
                { id: 'ema', name: 'EMA' },
                { id: 'smart', name: 'Smart' },

                // Row 2 - Momentum
                { id: 'overdue', name: 'Overdue' },
                { id: 'parity', name: 'Parity' },
                { id: 'progressive', name: 'Progressive' },
                { id: 'streak', name: 'Streak' },

                // Row 3 - Precision & Meta
                { id: 'cohesion', name: 'Cohesion' }, // new
                { id: 'entropy', name: 'Entropy' },
                { id: 'digitbias', name: 'Digit' },
                { id: 'positional', name: 'Positional' },

                // Row 4 - Advanced Meta
                { id: 'montecarlo', name: 'Monte Carlo' },
                { id: 'variance', name: 'Variance' },
                { id: 'antipattern', name: 'Anti-Pattern' },
                { id: 'random', name: 'Random' },
            ];

            // Reset a stale saved layout (if the curated set changed) before loading.
            this.ensureLayoutVersion()
                .then(() => Promise.all([this.loadStrategyOrder(), this.loadAltOrder()]))
                .then(([savedOrder, savedAltOrder]) => {
                let portfolio = defaultPortfolio;
                const browserAPI = (typeof browser !== 'undefined') ? browser : chrome;

                if (savedOrder && savedOrder.length === defaultPortfolio.length) {
                    // Honour saved order regardless of whether IDs match defaults
                    // (drag-drop swap with the side drawer can replace defaults).
                    portfolio = savedOrder.map(id => ({ id, name: this.getStrategyName(id) }));
                } else if (savedOrder && savedOrder.length > 0) {
                    // Length mismatch — layout changed. Reset.
                    browserAPI.storage.local.set({ strategyOrder: defaultPortfolio.map(s => s.id) }).catch(err => {
                        console.error('❌ Vantedge: Failed to reset strategy order:', err);
                    });
                }

                // Cache the core portfolio and derive the alternative set (drawer
                // defaults minus anything already on the core grid), then render the
                // active view and wire the Core/Alternative toggle. The Alt grid has
                // its own saved order (altStrategyOrder) so it can be sorted
                // independently of the Core grid's strategyOrder.
                this._mainPortfolio = portfolio;
                const mainIds = new Set(portfolio.map(s => s.id));
                const altSet = this.SIDE_DRAWER_DEFAULTS
                    .filter(s => !mainIds.has(s.id) && this.getSelectMethodName(s.id));
                this._altPortfolio = this.applySavedOrder(altSet, savedAltOrder);
                this.renderActiveStrategyView();
                this.wireStratToggle();
            });
        }

        wireStratToggle() {
            const toggle = this.overlay.querySelector('#overlay-strat-toggle');
            if (!toggle) return;
            toggle.querySelectorAll('.vx-st-btn').forEach(btn => {
                btn.onclick = () => this.setStrategyView(btn.dataset.stratview);
            });
        }

        setStrategyView(view) {
            this.strategyView = (view === 'alt') ? 'alt' : 'main';
            const toggle = this.overlay.querySelector('#overlay-strat-toggle');
            if (toggle) toggle.querySelectorAll('.vx-st-btn').forEach(b =>
                b.classList.toggle('on', b.dataset.stratview === this.strategyView));
            this.renderActiveStrategyView();
        }

        renderActiveStrategyView() {
            if (this.strategyView === 'alt') this.renderAltGrid(this._altPortfolio || []);
            else this.renderMainGrid(this._mainPortfolio || []);
        }

        // Alternative strategies rendered into the main grid area. Click applies the
        // strategy; drag swaps two Alt tiles (persisted to altStrategyOrder, which is
        // separate from the Core grid's strategyOrder so neither disturbs the other).
        renderAltGrid(portfolio) {
            const grid = this.overlay.querySelector('#overlay-quick-actions');
            if (!grid) return;
            grid.innerHTML = portfolio.map((s, index) => `
                <div class="action-item"
                     id="overlay-select-${s.id}"
                     draggable="true"
                     data-strategy-id="${s.id}"
                     data-source="alt-grid"
                     data-index="${index}">
                    <button class="action-btn-lg" data-action="${s.id}">
                        ${this.getStrategyIcon(s.id)}
                    </button>
                    <span class="action-label">${this.getStrategyName(s.id)}</span>
                </div>
            `).join('');
            this.setupAltGridInteractions();
            // Re-apply the AI gold-glow if its pick lives in this view.
            safe(() => this.updateAIRecommendation());
            this.updateStrategyPLBadges();
        }

        // Click + drag-to-swap for the Alt grid. Mirrors setupStrategyInteractions
        // but routes drops to swapAltStrategies so strategyOrder is never touched.
        setupAltGridInteractions() {
            const grid = this.overlay.querySelector('#overlay-quick-actions');
            if (!grid) return;

            const items = grid.querySelectorAll('.action-item');

            items.forEach(item => {
                const id = item.dataset.strategyId;

                item.addEventListener('click', () => {
                    // A finished drag fires a click on the source tile — ignore it.
                    if (this._suppressClick) { this._suppressClick = false; return; }
                    this.setActiveButton(id);
                    const method = this.getSelectMethodName(id);
                    if (method && typeof this[method] === 'function') this[method]();
                    const browserAPI = (typeof browser !== 'undefined') ? browser : chrome;
                    browserAPI?.runtime?.sendMessage?.({ type: 'SET_ACTIVE_STRATEGY', strategy: id, origin: this.storageOrigin })?.catch?.(() => {});
                });

                item.addEventListener('dragstart', (e) => {
                    this.dragSource = item;
                    item.classList.add('dragging');
                    this._suppressClick = true;
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', id || '');
                });

                item.addEventListener('dragend', () => {
                    item.classList.remove('dragging');
                    this.overlay.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
                    this.dragSource = null;
                    setTimeout(() => { this._suppressClick = false; }, 150);
                });

                item.addEventListener('dragover', (e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    if (this.dragSource && this.dragSource !== item) {
                        items.forEach(i => i.classList.remove('drag-over'));
                        item.classList.add('drag-over');
                    }
                });

                item.addEventListener('dragleave', () => {
                    item.classList.remove('drag-over');
                });

                item.addEventListener('drop', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (this.dragSource && this.dragSource !== item) {
                        this.swapAltStrategies(this.dragSource, item);
                    }
                    item.classList.remove('drag-over');
                });
            });
        }

        // True swap of two Alt-grid tiles. Persists altStrategyOrder and re-renders.
        swapAltStrategies(draggedItem, targetItem) {
            const draggedId = draggedItem.dataset.strategyId;
            const targetId = targetItem.dataset.strategyId;
            if (!draggedId || !targetId || draggedId === targetId) return;
            // Ignore drags that originated outside this view (e.g. a stale dragSource).
            if (draggedItem.dataset.source !== 'alt-grid' || targetItem.dataset.source !== 'alt-grid') return;

            const alt = (this._altPortfolio || []).slice();
            const di = alt.findIndex(s => s.id === draggedId);
            const ti = alt.findIndex(s => s.id === targetId);
            if (di < 0 || ti < 0) return;
            // Exchange the two tiles only (not a reorder that shifts everything).
            [alt[di], alt[ti]] = [alt[ti], alt[di]];
            this._altPortfolio = alt;

            const browserAPI = (typeof browser !== 'undefined') ? browser : chrome;
            const persist = browserAPI?.storage?.local
                ? browserAPI.storage.local.set({ altStrategyOrder: alt.map(s => s.id) })
                : Promise.resolve();
            Promise.resolve(persist).catch(err => console.error('Vantedge: alt swap persist failed', err));
            this.renderAltGrid(alt);
        }

        // Reorder a derived strategy list to match a saved id order. Unknown/removed
        // ids in the saved order are skipped and new strategies are appended, so the
        // saved order survives changes to the curated set.
        applySavedOrder(list, savedOrder) {
            if (!Array.isArray(savedOrder) || savedOrder.length === 0) return list;
            const byId = new Map(list.map(s => [s.id, s]));
            const ordered = [];
            savedOrder.forEach(id => {
                if (byId.has(id)) { ordered.push(byId.get(id)); byId.delete(id); }
            });
            return ordered.concat(list.filter(s => byId.has(s.id)));
        }

        renderMainGrid(portfolio) {
            const grid = this.overlay.querySelector('#overlay-quick-actions');
            if (!grid) return;
            grid.innerHTML = portfolio.map((strategy, index) => `
                <div class="action-item"
                     id="overlay-select-${strategy.id}"
                     draggable="true"
                     data-strategy-id="${strategy.id}"
                     data-source="main-grid"
                     data-index="${index}">
                    <button class="action-btn-lg" data-action="${strategy.id}">
                        ${this.getStrategyIcon(strategy.id)}
                    </button>
                    <span class="action-label">${strategy.name}</span>
                </div>
            `).join('');
            this.setupStrategyInteractions();
            this.updateStrategyPLBadges();
        }

        getStrategyName(id) {
            return this.strategyExplanations?.[id]?.name || this.capitalize(id);
        }

        async loadStrategyOrder() {
            const browserAPI = (typeof browser !== 'undefined') ? browser : chrome;
            return new Promise(resolve => {
                browserAPI.storage.local.get('strategyOrder', result => {
                    resolve(result.strategyOrder || null);
                });
            });
        }

        // Saved order for the Alternative grid. Handles both Chrome (callback) and
        // Firefox (promise-only) storage APIs; never rejects.
        async loadAltOrder() {
            const browserAPI = (typeof browser !== 'undefined') ? browser : chrome;
            if (!browserAPI?.storage?.local) return null;
            return new Promise(resolve => {
                const done = (result) => resolve((result && result.altStrategyOrder) || null);
                const p = browserAPI.storage.local.get('altStrategyOrder', done);
                if (p && typeof p.then === 'function') p.then(done, () => resolve(null));
            });
        }

        // One-time reset of the saved layout when the curated strategy set changes.
        // Handles both Chrome (callback) and Firefox (promise) storage APIs.
        ensureLayoutVersion() {
            const browserAPI = (typeof browser !== 'undefined') ? browser : chrome;
            return new Promise(resolve => {
                if (!browserAPI?.storage?.local) { resolve(); return; }
                const finish = () => resolve();
                const onGet = (r) => {
                    const v = (r && r.strategyLayoutVersion) || 0;
                    if (v >= this.LAYOUT_VERSION) { resolve(); return; }
                    const afterSet = () => finish();
                    const afterRemove = () => {
                        const p = browserAPI.storage.local.set({ strategyLayoutVersion: this.LAYOUT_VERSION }, afterSet);
                        if (p && typeof p.then === 'function') p.then(afterSet, afterSet);
                    };
                    const pr = browserAPI.storage.local.remove(['strategyOrder', 'sideDrawerStrategies', 'altStrategyOrder'], afterRemove);
                    if (pr && typeof pr.then === 'function') pr.then(afterRemove, afterRemove);
                };
                const pg = browserAPI.storage.local.get('strategyLayoutVersion', onGet);
                if (pg && typeof pg.then === 'function') pg.then(onGet, () => resolve());
            });
        }

        async loadOverlayPosition() {
            const browserAPI = (typeof browser !== 'undefined') ? browser : chrome;
            return new Promise(resolve => {
                browserAPI.storage.local.get('overlayPosition', result => {
                    if (result.overlayPosition) {
                        this.position = result.overlayPosition;
                        this.overlay.style.left = this.position.x + 'px';
                        this.overlay.style.top = this.position.y + 'px';
                        // A position saved on a bigger screen can be entirely
                        // off-screen here (e.g. desktop 1440px → tablet 800px).
                        this.clampToViewport();
                    }
                    resolve(result.overlayPosition || null);
                    // Re-position the side drawer tab now that the overlay's final
                    // position is known. Without this, positionSideDrawer() can fire
                    // before loadOverlayPosition() completes and place the tab based
                    // on the CSS default position (left:350px) instead of the saved one.
                    setTimeout(() => this.positionSideDrawer(), 0);
                });
            });
        }

        async saveStrategyOrder() {
            const grid = this.overlay.querySelector('#overlay-quick-actions');
            if (!grid) return;

            const items = Array.from(grid.querySelectorAll('.action-item'));
            const order = items.map(item => item.dataset.strategyId).filter(id => id);
            if (order.length === 0) return;

            const browserAPI = (typeof browser !== 'undefined') ? browser : chrome;
            try {
                await browserAPI.storage.local.set({ strategyOrder: order });
                grid.style.boxShadow = '0 0 10px rgba(76, 175, 80, 0.8)';
                setTimeout(() => { grid.style.boxShadow = ''; }, 300);
            } catch (error) {
                console.error('Failed to save strategy order:', error);
            }
        }

        // TAG: SIDE-DRAWER
        SIDE_DRAWER_DEFAULTS = [
            { id: 'hotzone', name: 'Hotzone' },
            { id: 'edge', name: 'Edge' },
            { id: 'adaptive', name: 'Adaptive' },
            { id: 'delta', name: 'Delta' },
            { id: 'regression', name: 'Regression' },
            { id: 'portfolio', name: 'Portfolio' },
            { id: 'comboways', name: 'Cluster' },
            { id: 'condbonus', name: 'Pulse' },
            { id: 'bayesian', name: 'Bayesian' },
            { id: 'coverage', name: 'Coverage' },
            { id: 'wheeling', name: 'Wheeling' },
            { id: 'timeseries', name: 'Forecast' },
            { id: 'balanced', name: 'Balanced' },
            { id: 'momentum', name: 'Momentum' },
            { id: 'poisson', name: 'Poisson' },
            { id: 'gapextremes', name: 'Extreme' }
        ];

        populateSideDrawer() {
            const browserAPI = (typeof browser !== 'undefined') ? browser : chrome;
            if (!browserAPI?.storage?.local) {
                this.renderSideDrawer(this.SIDE_DRAWER_DEFAULTS);
                return;
            }
            // Use Promise API to support both Chrome (callback + promise) and
            // Firefox (promise-only on the browser.* namespace)
            const resolve = (result) => {
                // What's currently on the main grid — the drawer must never show
                // any of these (a strategy lives in exactly one place).
                const mainGrid = this.overlay.querySelector('#overlay-quick-actions');
                const mainIds = new Set(mainGrid
                    ? Array.from(mainGrid.querySelectorAll('.action-item')).map(i => i.dataset.strategyId)
                    : []);
                const saved = (result && Array.isArray(result.sideDrawerStrategies) && result.sideDrawerStrategies.length > 0)
                    ? result.sideDrawerStrategies
                    : null;

                // Reconcile the drawer against current code + the main grid:
                //   1. drop entries with no method (removed strategies), anything
                //      now on the main grid (prevents duplicates when a tile is
                //      moved there), and any in-drawer duplicates;
                //   2. append new default strategies the user hasn't seen yet
                //      (e.g. Hotzone) that aren't already in the drawer or grid.
                const base = saved || this.SIDE_DRAWER_DEFAULTS;
                const seen = new Set();
                const cleaned = base.filter(s => {
                    if (!s || !this.getSelectMethodName(s.id)) return false;
                    if (mainIds.has(s.id)) return false;
                    if (seen.has(s.id)) return false;
                    seen.add(s.id);
                    return true;
                });
                const additions = this.SIDE_DRAWER_DEFAULTS.filter(d => !seen.has(d.id) && !mainIds.has(d.id));
                let strategies = cleaned.concat(additions);
                if (strategies.length === 0) strategies = this.SIDE_DRAWER_DEFAULTS.filter(d => !mainIds.has(d.id));

                if (saved && browserAPI?.storage?.local) {
                    const changed = strategies.length !== saved.length || strategies.some((s, i) => s.id !== saved[i]?.id);
                    if (changed) {
                        const setP = browserAPI.storage.local.set({ sideDrawerStrategies: strategies });
                        if (setP && typeof setP.then === 'function') setP.catch(() => {});
                    }
                }
                this.renderSideDrawer(strategies);
            };
            const p = browserAPI.storage.local.get('sideDrawerStrategies');
            if (p && typeof p.then === 'function') {
                p.then(resolve).catch(() => this.renderSideDrawer(this.SIDE_DRAWER_DEFAULTS));
            } else {
                // Chrome callback path
                browserAPI.storage.local.get('sideDrawerStrategies', resolve);
            }
        }

        renderSideDrawer(strategies) {
            const sideGrid = document.getElementById('overlay-side-actions');
            const drawer = document.getElementById('overlay-side-drawer');
            if (!sideGrid || !drawer) return;

            // Horizontal layout: 4 rows like the main overlay, columns grow rightward.
            // Items fill top-to-bottom in a column, then wrap to the next column
            // (grid-auto-flow: column), so the panel reads as 4 rows × many columns.
            const n = strategies.length;
            const rows = Math.min(4, n) || 1;
            const cols = Math.ceil(n / rows);
            const cellW = 80;   // px per column tile — close to the main grid's tile
                                // size, with room for the longest labels ("Gap
                                // Extremes", "Anti-Pattern") to fit on one line.
            const gap = 4;
            sideGrid.style.gridTemplateColumns = 'none';
            sideGrid.style.gridTemplateRows = `repeat(${rows}, auto)`;
            sideGrid.style.gridAutoFlow = 'column';
            sideGrid.style.gridAutoColumns = `${cellW}px`;
            sideGrid.style.gap = `${gap}px`;
            // Width = columns + inter-column gaps + 10px drawer padding each side, so
            // positionSideDrawer can place/flip the drawer without horizontal scroll.
            drawer.style.width = (cols * cellW + (cols - 1) * gap + 20) + 'px';
            // Height is determined by content (4 rows); bottom-aligned by positionSideDrawer.

            sideGrid.innerHTML = strategies.map(strategy => `
                <div class="action-item"
                     data-strategy-id="${strategy.id}"
                     data-source="side-drawer"
                     draggable="true">
                    <button class="action-btn-lg" data-action="${strategy.id}">
                        ${this.getStrategyIcon(strategy.id)}
                    </button>
                    <span class="action-label">${this.getStrategyName(strategy.id)}</span>
                </div>
            `).join('');

            this.setupSideDrawerInteractions();
            // Re-position now that the width is set (positionSideDrawer reads drawer.style.width).
            this.positionSideDrawer();
        }

        getSelectMethodName(strategyId) {
            const map = {
                'hot': 'selectHotNumbers',
                'cold': 'selectColdNumbers',
                'smart': 'selectSmartNumbers',
                'random': 'selectRandomNumbers',
                'overdue': 'selectOverdueNumbers',
                'variance': 'selectVarianceNumbers',
                'positional': 'selectPositionalNumbers',
                'hotzone': 'selectHotzoneNumbers',
                'progressive': 'selectProgressiveNumbers',
                'transition': 'selectTransitionNumbers',
                'entropy': 'selectEntropyNumbers',
                'antipattern': 'selectAntiPatternNumbers',
                'streak': 'selectStreakNumbers',
                'volatility': 'selectVolatilityNumbers',
                'ema': 'selectEMANumbers',
                'digitbias': 'selectDigitBiasNumbers',
                'parity': 'selectParityNumbers',
                'adaptive': 'selectAdaptiveNumbers',
                'regime': 'selectRegimeNumbers',
                'cohesion': 'selectCohesionNumbers',
                'edge': 'selectEdgeNumbers',
                'delta': 'selectDeltaPatternNumbers',
                'regression': 'selectRegressionNumbers',
                'portfolio': 'selectPortfolioNumbers',
                'comboways': 'selectCombinatorialWaysNumbers',
                'condbonus': 'selectConditionalBonusNumbers',
                // Re-added historical strategies
                'bayesian': 'selectBayesianNumbers',
                'montecarlo': 'selectMonteCarloNumbers',
                'coverage': 'selectCoverageNumbers',
                'wheeling': 'selectWheelingNumbers',
                'timeseries': 'selectTimeSeriesNumbers',
                'balanced': 'selectBalancedNumbers',
                'momentum': 'selectMomentumNumbers',
                'poisson': 'selectPoissonNumbers',
                'gapextremes': 'selectGapExtremesNumbers'
            };
            return map[strategyId];
        }

        setupSideDrawerInteractions() {
            const drawer = document.getElementById('overlay-side-drawer');
            const sideGrid = document.getElementById('overlay-side-actions');
            if (!drawer || !sideGrid) return;

            const items = sideGrid.querySelectorAll('.action-item');
            items.forEach(item => {
                const strategyId = item.dataset.strategyId;

                item.addEventListener('click', () => {
                    if (this._suppressClick) { this._suppressClick = false; return; }
                    this.setActiveButton(strategyId);
                    // Run strategy immediately — sendMessage is fire-and-forget after
                    const methodName = this.getSelectMethodName(strategyId);
                    if (methodName && typeof this[methodName] === 'function') {
                        this[methodName]();
                    }
                    if (typeof browser !== 'undefined' && browser.runtime) {
                        browser.runtime.sendMessage({
                            type: 'SET_ACTIVE_STRATEGY',
                            strategy: strategyId,
                            origin: this.storageOrigin
                        }).catch(() => {});
                    }
                });

                item.addEventListener('dragstart', (e) => {
                    this.dragSource = item;
                    item.classList.add('dragging');
                    this._suppressClick = true;
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', strategyId);
                });

                item.addEventListener('dragend', () => {
                    item.classList.remove('dragging');
                    this.overlay.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
                    this.dragSource = null;
                    setTimeout(() => { this._suppressClick = false; }, 150);
                });

                item.addEventListener('dragover', (e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    if (this.dragSource && this.dragSource !== item) {
                        item.classList.add('drag-over');
                    }
                });

                item.addEventListener('dragleave', () => {
                    item.classList.remove('drag-over');
                });

                item.addEventListener('drop', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (this.dragSource && this.dragSource !== item) {
                        this.swapStrategies(this.dragSource, item);
                    }
                    item.classList.remove('drag-over');
                });
            });
        }

        // True swap of two Core-grid tiles (the drawer was removed, so this only
        // needs the main grid). Persists strategyOrder and re-renders in place.
        swapStrategies(draggedItem, targetItem) {
            const draggedId = draggedItem.dataset.strategyId;
            const targetId = targetItem.dataset.strategyId;
            if (!draggedId || !targetId || draggedId === targetId) return;
            // Never let an Alt-view drag write to strategyOrder — both grids share
            // the #overlay-quick-actions container, so the source must be checked.
            if (draggedItem.dataset.source === 'alt-grid' || targetItem.dataset.source === 'alt-grid') return;

            const mainGrid = this.overlay.querySelector('#overlay-quick-actions');
            if (!mainGrid) return;

            const mainIds = Array.from(mainGrid.querySelectorAll('.action-item')).map(i => i.dataset.strategyId);
            const di = mainIds.indexOf(draggedId);
            const ti = mainIds.indexOf(targetId);
            if (di < 0 || ti < 0) return;
            // Exchange the two tiles only (not a reorder that shifts everything).
            [mainIds[di], mainIds[ti]] = [mainIds[ti], mainIds[di]];

            const browserAPI = (typeof browser !== 'undefined') ? browser : chrome;
            const persist = browserAPI?.storage?.local
                ? browserAPI.storage.local.set({ strategyOrder: mainIds })
                : Promise.resolve();
            Promise.resolve(persist).then(() => {
                // Keep the cached Core portfolio (used by the Core/Alt toggle) in sync.
                this._mainPortfolio = mainIds.map(id => ({ id, name: this.getStrategyName(id) }));
                this.renderMainGrid(this._mainPortfolio);
            }).catch(err => console.error('Vantedge: swap persist failed', err));
        }

        positionSideDrawer() {
            // Drawer and tab are document.body children (fixed position) so they are
            // never clipped by the overlay's backdrop-filter stacking context (Firefox fix).
            const drawer = document.getElementById('overlay-side-drawer');
            const tab = document.getElementById('overlay-drawer-tab');
            if (!drawer || !tab || !this.overlay) return;

            const overlayRect = this.overlay.getBoundingClientRect();
            if (!overlayRect.width) return; // overlay not laid out yet

            const vw = window.innerWidth;
            const vh = window.innerHeight;
            const tabWidth = 18;
            const tabHeight = 56;

            // Drawer width is set by renderSideDrawer() based on strategy count.
            // Read it from the inline style (works even when drawer is display:none).
            const drawerWidth = parseInt(drawer.style.width) || 200;

            // Flip tab/drawer to left side when there isn't room on the right.
            const fitsRight = (overlayRect.right + tabWidth + drawerWidth) <= vw;
            const tabLeft = fitsRight ? overlayRect.right : (overlayRect.left - tabWidth);

            // Tab: center vertically on the whole overlay.
            const tabTop = Math.max(0, Math.min(
                vh - tabHeight,
                overlayRect.top + overlayRect.height / 2 - tabHeight / 2
            ));

            tab.style.position = 'fixed';
            tab.style.left = tabLeft + 'px';
            tab.style.top = tabTop + 'px';
            tab.style.zIndex = '1000001';
            tab.style.borderRadius = fitsRight ? '0 8px 8px 0' : '8px 0 0 8px';
            tab.style.borderLeft = fitsRight ? 'none' : '1px solid rgba(255,255,255,0.10)';
            tab.style.borderRight = fitsRight ? '1px solid rgba(255,255,255,0.10)' : 'none';

            // Drawer is sized to its own content (title + 4 rows of tiles) so there
            // is no vertical empty space, and its bottom is aligned with the overlay
            // bottom — the same bottom line as the left strategy-button block. With 4
            // compact rows the panel ends up the same height as that strategy block.
            const drawerLeft = fitsRight
                ? (overlayRect.right + tabWidth)
                : (overlayRect.left - tabWidth - drawerWidth - 4);
            const bottomGap = Math.max(0, vh - overlayRect.bottom);

            drawer.style.position = 'fixed';
            drawer.style.left = drawerLeft + 'px';
            drawer.style.bottom = bottomGap + 'px';
            drawer.style.top = 'auto';
            drawer.style.height = 'auto';
            drawer.style.maxHeight = Math.max(80, overlayRect.bottom - 8) + 'px';
            // Reset any flex centering from earlier builds — no vertical empty space.
            drawer.style.display = 'block';
            drawer.style.flexDirection = '';
            drawer.style.justifyContent = '';
            drawer.style.zIndex = '1000000';
        }

        toggleSideDrawer() {
            const drawer = document.getElementById('overlay-side-drawer');
            const tab = document.getElementById('overlay-drawer-tab');
            if (!drawer || !tab) return;

            const isOpen = !drawer.classList.contains('side-drawer-closed');
            if (isOpen) {
                drawer.classList.add('side-drawer-closed');
                tab.textContent = '▶';
            } else {
                drawer.classList.remove('side-drawer-closed');
                tab.textContent = '◀';
                this.populateSideDrawer();
                this.positionSideDrawer();
            }
            // No persistence of open/closed state — drawer always starts closed on page load.
        }

        loadSideDrawerState() {
            // Drawer is closed by default on every page load.
            // We only need to position the tab so it sits next to the strategy grid.
            const positionWhenReady = () => {
                if (this.overlay.querySelector('.quick-actions-container .action-item')) {
                    this.positionSideDrawer();
                } else {
                    setTimeout(positionWhenReady, 60);
                }
            };
            positionWhenReady();

            // Clean up any stale "drawer was open" flag from earlier versions so it doesn't surprise the user.
            const browserAPI = (typeof browser !== 'undefined') ? browser : chrome;
            if (browserAPI?.storage?.local) {
                browserAPI.storage.local.remove('sideDrawerOpen').catch(() => {});
            }
        }

        // Helper
        capitalize(str) {
            return str.charAt(0).toUpperCase() + str.slice(1);
        }

        moveStrategyToMain(strategyId) {
            // Add strategy to main grid if not already there
            const grid = this.overlay.querySelector('#overlay-quick-actions');
            const existingItem = grid.querySelector(`[data-strategy-id="${strategyId}"]`);

            if (!existingItem) {
                // Get strategy info
                const strategyInfo = {
                    antipattern: { id: 'antipattern', name: 'Anti-Pattern' },
                    variance: { id: 'variance', name: 'Variance' }
                }[strategyId];

                if (strategyInfo) {
                    const div = document.createElement('div');
                    div.className = 'action-item';
                    div.draggable = true;
                    div.dataset.strategyId = strategyId;
                    div.innerHTML = `
                        <button class="action-btn-lg" data-action="${strategyId}">
                            ${this.getStrategyIcon(strategyId)}
                        </button>
                        <span class="action-label">${strategyInfo.name}</span>
                    `;

                    // Add click listener
                    div.addEventListener('click', (e) => {
                        if (e.target.classList.contains('action-btn-lg')) return; // Let button handle it
                        this.setActiveButton(strategyId);
                        const methodMap = {
                            'antipattern': 'selectAntiPatternNumbers',
                            'variance': 'selectVarianceNumbers'
                        };
                        const methodName = methodMap[strategyId];
                        if (methodName && typeof this[methodName] === 'function') {
                            this[methodName]();
                        }
                    });

                    // Add drag listeners (simplified)
                    div.addEventListener('dragstart', (e) => {
                        e.dataTransfer.setData('text/plain', strategyId);
                    });

                    grid.appendChild(div);
                    this.setupStrategyInteractions(); // Re-attach interactions
                }
            }

            this.showToast(`✅ ${strategyId} moved to Main Grid`);
            this.saveStrategyOrder();
        }

        moveToAdvanced(strategyId) {
            // For now just remove from current order
            const grid = this.overlay.querySelector('#overlay-quick-actions');
            const item = grid.querySelector(`[data-strategy-id="${strategyId}"]`);
            if (item) item.remove();
            this.saveStrategyOrder();

            // Optional: show toast
            this.showToast(`Moved ${strategyId} to Advanced`);
        }

        showToast(message) {
            const toast = document.createElement('div');
            toast.textContent = message;
            toast.style.cssText = `
                position: fixed;
                top: 20px;
                right: 20px;
                background: #333;
                color: #fff;
                padding: 10px 15px;
                border-radius: 5px;
                z-index: 10000;
                font-family: Arial, sans-serif;
            `;
            document.body.appendChild(toast);
            setTimeout(() => toast.remove(), 3000);
        }

        async saveOverlayPosition() {
            const browserAPI = (typeof browser !== 'undefined') ? browser : chrome;
            try {
                await browserAPI.storage.local.set({ overlayPosition: this.position });
            } catch (error) {
                console.error('Failed to save overlay position:', error);
            }
        }

        setupStrategyInteractions() {
            const grid = this.overlay.querySelector('#overlay-quick-actions');
            if (!grid) return;

            const items = grid.querySelectorAll('.action-item');

            items.forEach(item => {
                const strategyId = item.dataset.strategyId;

                // Click listener for strategy selection
                item.addEventListener('click', () => {
                    if (this._suppressClick) { this._suppressClick = false; return; }

                    this.setActiveButton(strategyId);

                    // Use storageOrigin to ensure correct data storage (important for Winna iframe)
                    const siteOrigin = this.storageOrigin;
                    if (typeof browser !== 'undefined' && browser.runtime) {
                        browser.runtime.sendMessage({
                            type: 'SET_ACTIVE_STRATEGY',
                            strategy: strategyId,
                            origin: siteOrigin
                        });
                    }

                    // Auto-click Keno numbers — use the complete method map so any
                    // strategy works here, including ones dragged in from the drawer.
                    const methodName = this.getSelectMethodName(strategyId);
                    if (methodName && typeof this[methodName] === 'function') {
                        this[methodName]();
                    }
                });

                // Drag listeners — use this.dragSource so side drawer can swap with us
                item.addEventListener('dragstart', (e) => {
                    this.dragSource = item;
                    item.classList.add('dragging');
                    this._suppressClick = true;
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', item.dataset.strategyId || '');
                });

                item.addEventListener('dragend', () => {
                    item.classList.remove('dragging');
                    this.overlay.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
                    this.dragSource = null;
                    setTimeout(() => { this._suppressClick = false; }, 150);
                });

                item.addEventListener('dragover', (e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    if (this.dragSource && this.dragSource !== item) {
                        items.forEach(i => i.classList.remove('drag-over'));
                        item.classList.add('drag-over');
                    }
                });

                item.addEventListener('dragleave', () => {
                    item.classList.remove('drag-over');
                });

                item.addEventListener('drop', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (this.dragSource && this.dragSource !== item) {
                        this.swapStrategies(this.dragSource, item);
                    }
                    item.classList.remove('drag-over');
                });
            });
        }

        addStyles() {
            if (document.getElementById('geminyzer-overlay-styles')) return;

            const styles = document.createElement('style');
            styles.id = 'geminyzer-overlay-styles';
            styles.textContent = `
               @import url('https://fonts.googleapis.com/css2?family=Ubuntu:wght@300;400;500;700&display=swap');
               #geminyzer-overlay {
                   position: fixed;
                   top: 500px; left: 350px;
                   transform-origin: top left;
                   width: 400px;
                   min-height: 450px;
                   max-height: 80vh;
                   background: linear-gradient(180deg, #0e141d 0%, #0b1017 100%);
                   border: 1px solid rgba(255, 255, 255, 0.10);
                   border-radius: 12px;
                   color: #e7edf4;
                   font-family: 'Ubuntu', -apple-system, BlinkMacSystemFont, sans-serif;
                   font-size: 13px;
                   z-index: 999999;
                   box-shadow: 0 16px 48px rgba(0, 0, 0, 0.55);
                   backdrop-filter: blur(10px);
                   overflow: visible;
                   transition: opacity 0.3s ease, transform 0.3s ease;
                   pointer-events: auto;
                }

                #geminyzer-overlay.dragging {
                    transition: none !important;
                    user-select: none;
                    cursor: grabbing;
                }

               #geminyzer-overlay.minimized {
                   height: 50px;
                   min-height: 50px;
               }

               #geminyzer-overlay.hidden {
                   transform: translateX(400px);
                   opacity: 0;
               }

               /* --- Sidebar mode: dock full-height on the right edge --- */
               #geminyzer-overlay.sidebar-mode {
                   top: 0 !important;
                   right: 0 !important;
                   left: auto !important;
                   bottom: 0 !important;
                   height: 100vh !important;
                   min-height: 100vh !important;
                   max-height: 100vh !important;
                   /* Responsive: ~400px on wide screens, shrinks on narrow ones so
                      it always fits beside the game instead of overlapping it. */
                   width: clamp(300px, 30vw, 400px);
                   border-radius: 0;
                   border-top: none;
                   border-right: none;
                   border-bottom: none;
               }
               #geminyzer-overlay.sidebar-mode .overlay-header { cursor: default; }
               #geminyzer-overlay.sidebar-mode .overlay-content { max-height: calc(100vh - 54px); }
               #geminyzer-overlay.sidebar-mode.minimized {
                   height: 50px !important;
                   min-height: 50px !important;
               }
               #overlay-layout.active {
                   background: rgba(76, 175, 80, 0.25) !important;
                   border-color: rgb(68, 231, 74) !important;
                   color: #fff !important;
               }

               .overlay-header {
                   display: flex;
                   justify-content: space-between;
                   align-items: center;
                   padding: 11px 13px;
                   background: linear-gradient(180deg, rgba(255,255,255,0.03), transparent);
                   border-bottom: 1px solid rgba(255, 255, 255, 0.07);
                   cursor: move;
                   user-select: none;
                   touch-action: none;
               }

               .overlay-title {
                   display: flex;
                   align-items: center;
                   gap: 8px;
                   font-weight: 600;
                   font-size: 14px;
               }

               .overlay-icon {
                   width: 22px;
                   height: 22px;
                   border-radius: 6px;
                   background: rgba(63, 185, 80, 0.16);
                   border: 1px solid rgba(63, 185, 80, 0.45);
                   color: #3fb950;
                   display: flex;
                   align-items: center;
                   justify-content: center;
                   flex: 0 0 auto;
               }

               .overlay-name {
                   font-weight: 600;
                   letter-spacing: 0.2px;
               }

               .overlay-pro {
                   font-size: 9px;
                   font-weight: 600;
                   color: #3fb950;
                   border: 1px solid rgba(63, 185, 80, 0.4);
                   border-radius: 4px;
                   padding: 1px 4px;
                   letter-spacing: 0.5px;
               }

               .overlay-stats {
                   font-size: 11px;
                   color: #8b949e;
                   margin-left: 6px;
                   white-space: nowrap;
               }

               .enhancement-status {
                   margin-left: 8px;
                   font-size: 12px;
                   cursor: help;
                   opacity: 0.5;
                   transition: opacity 0.3s;
               }

               .enhancement-status.active {
                   opacity: 1;
                   filter: drop-shadow(0 0 4px rgba(255, 215, 0, 0.8));
               }

               .overlay-controls {
                   display: flex;
                   gap: 4px;
               }

               .overlay-controls button {
                   background: transparent;
                   border: 1px solid rgba(255, 255, 255, 0.08);
                   color: #8a97a8;
                   width: 26px;
                   height: 26px;
                   padding: 0;
                   border-radius: 6px;
                   cursor: pointer;
                   transition: all 0.15s ease;
                   display: flex;
                   align-items: center;
                   justify-content: center;
               }

               .overlay-controls button:hover {
                   background: rgba(255, 255, 255, 0.06);
                   border-color: rgba(255, 255, 255, 0.18);
                   color: #e7edf4;
               }

               .vx-ctl-icon { display: block; }
               @keyframes vx-spin { to { transform: rotate(360deg); } }
               .overlay-controls button.vx-spin .vx-ctl-icon { animation: vx-spin 0.8s linear infinite; }

               .overlay-content {
                   padding: 12px;
                   overflow-y: auto;
                   max-height: calc(80vh - 100px);
               }

               .keno-heatmap-grid {
                   display: grid;
                   grid-template-columns: repeat(8, 1fr);
                   gap: 4px;
                   margin-bottom: 16px;
               }

               .heatmap-number {
                   aspect-ratio: 1;
                   display: flex;
                   flex-direction: column;
                   justify-content: center;
                   align-items: center;
                   border-radius: 7px;
                   border: 1.5px solid rgba(255, 255, 255, 0.05);
                   cursor: pointer;
                   transition: transform 0.12s ease, box-shadow 0.12s ease, border-color 0.12s ease;
                   font-size: 11px;
                   font-weight: 600;
                   position: relative;
               }

               .heatmap-number {
                   cursor: pointer;
               }

               .heatmap-number:hover {
                   transform: translateY(-1px);
                   box-shadow: 0 4px 12px rgba(0, 0, 0, 0.45);
                   border-color: rgba(255, 255, 255, 0.18);
               }

               .heatmap-number.selected {
                   box-shadow: 0 0 0 2px #00ca51;
                   transform: scale(1.05);
               }

               .heatmap-number.selecting {
                   animation: number-select-pulse 0.4s ease-in-out;
                   border: 2px solid #00ca51 !important;
               }

               @keyframes number-select-pulse {
                   0% { transform: scale(1); }
                   50% { transform: scale(1.2); box-shadow: 0 0 16px rgba(0, 202, 81, 0.8); }
                   100% { transform: scale(1); }
               }

               .heatmap-number .number {
                   font-size: 12px;
                   font-weight: 700;
                   line-height: 1;
               }

               .heatmap-number .count {
                   font-size: 10px;
                   font-weight: 300;
                   opacity: 0.8;
                   margin-top: 2px;
               }

               .quick-actions-container {
                   display: flex;
                   flex-direction: column;
                   gap: 8px;
                   margin-top: 16px;
               }

                .quick-actions-grid {
                    display: grid;
                    grid-template-columns: repeat(4, 1fr);
                    gap: 3px;
                    margin-bottom: 8px;
                }

                .action-item {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 2px;
                    cursor: grab;
                    padding: 1px;
                    transition: all 0.2s ease;
                }

                /* Tiny per-strategy session P/L under the tile label */
                .vx-spl {
                    font-size: 8px;
                    font-weight: 600;
                    line-height: 1;
                    color: #8a97a8;
                    letter-spacing: 0.2px;
                }
                .vx-spl.pos { color: #3fb950; }
                .vx-spl.neg { color: #e5534b; }

                .action-item.dragging {
                    opacity: 0.4;
                    cursor: grabbing;
                    transform: scale(0.95);
                }

                .action-item.drag-over {
                    transform: scale(1.05);
                    background: rgba(76, 175, 80, 0.2);
                    border-radius: 8px;
                }

                .action-btn-lg {
                    background: #141b25;
                    border: 1px solid rgba(255, 255, 255, 0.07);
                    color: #e7edf4;
                    padding: 3px;
                    border-radius: 8px;
                    cursor: pointer;
                    transition: background 0.12s ease, border-color 0.12s ease, box-shadow 0.12s ease;
                    font-size: 13px;
                    width: 90%;
                    aspect-ratio: auto;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    box-shadow: 0 2px 4px rgba(0,0,0,0.2);
                    position: relative;
                }

                .action-btn-lg:hover {
                    background: #202a3a;
                    border-color: rgba(63, 185, 80, 0.45);
                    box-shadow: none;
                    transform: translateY(-1px);
                }

                .action-btn-lg.active-button {
                    border: 2px solid #00ca51 !important;
                    background: linear-gradient(135deg, rgba(0, 202, 81, 0.15), rgba(0, 202, 81, 0.05)) !important;
                    box-shadow: 0 0 6px rgba(0, 202, 81, 0.4) !important;
                    transform: scale(1.01);
                }

                .action-btn-lg.ai-recommended {
                    box-shadow: 0 0 12px rgba(255, 215, 0, 0.8), 0 0 6px rgba(255, 215, 0, 0.6) !important;
                    border-color: rgba(255, 215, 0, 0.7) !important;
                }

                .action-label {
                    font-size: 10px;
                    font-weight: 500;
                    color:rgb(202, 201, 201);
                    text-align: center;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    max-width: 100%;
                }

                #geminyzer-overlay.minimized .overlay-content {
                   display: none !important;
               }

                .low-mode { background-color: #ffcc00; color: #333; font-weight: bold; }

                /* --- REGIME BUTTON COLOR --- */
                .action-btn-lg.regime-hot {
                    border-color: #ff6b35 !important;
                    background: linear-gradient(135deg, rgba(255,107,53,0.18), rgba(255,107,53,0.06)) !important;
                    box-shadow: 0 0 8px rgba(255,107,53,0.5) !important;
                }
                .action-btn-lg.regime-cold {
                    border-color: #4fc3f7 !important;
                    background: linear-gradient(135deg, rgba(79,195,247,0.18), rgba(79,195,247,0.06)) !important;
                    box-shadow: 0 0 8px rgba(79,195,247,0.5) !important;
                }
                .action-btn-lg.regime-neutral {
                    border-color: #aaa !important;
                    background: linear-gradient(135deg, rgba(170,170,170,0.12), rgba(170,170,170,0.04)) !important;
                }
                .action-label.regime-hot  { color: #ff6b35 !important; }
                .action-label.regime-cold { color: #4fc3f7 !important; }
                .action-label.regime-neutral { color: #aaa !important; }

                /* MOBILE / TABLET */

                /* Touch devices: comfortable tap targets */
                @media (pointer: coarse) {
                    .overlay-controls button { width: 34px; height: 34px; }
                    .overlay-controls { gap: 6px; }
                    .heatmap-number { font-size: 12px; }
                }

                /* Phones + small tablets: both layout modes collapse into a
                   bottom sheet — there is no room to float or dock beside the
                   game board. Position rules use !important so they beat both
                   drag-set inline styles and the sidebar-mode dock rules. */
                @media (max-width: 700px) {
                    #geminyzer-overlay,
                    #geminyzer-overlay.sidebar-mode {
                        top: auto !important;
                        left: 0 !important;
                        right: 0 !important;
                        bottom: 0 !important;
                        width: 100% !important;
                        height: auto !important;
                        min-height: 0 !important;
                        max-height: 60vh !important;
                        border-radius: 12px 12px 0 0;
                        border-left: none;
                        border-right: none;
                        border-bottom: none;
                        border-top: 1px solid rgba(255, 255, 255, 0.10);
                        box-sizing: border-box;
                        overflow: hidden;
                    }
                    #geminyzer-overlay.hidden {
                        transform: translateY(110%);
                    }
                    #geminyzer-overlay.minimized,
                    #geminyzer-overlay.sidebar-mode.minimized {
                        height: 50px !important;
                        min-height: 50px !important;
                        overflow: hidden;
                    }

                    #geminyzer-overlay .overlay-content,
                    #geminyzer-overlay.sidebar-mode .overlay-content {
                        max-height: calc(60vh - 54px);
                        overflow-y: auto;
                        -webkit-overflow-scrolling: touch;
                        padding: 10px 10px calc(12px + env(safe-area-inset-bottom, 0px)) 10px;
                    }

                    /* Bottom sheet is fixed in place — no dragging */
                    .overlay-header { cursor: default; }
                    .overlay-stats { display: none; }

                    .quick-actions-grid { gap: 4px; }
                    .action-btn-lg { font-size: 12px; padding: 6px 2px; }
                    .action-label { font-size: 8px; }

                    /* No room for the side drawer next to a full-width sheet */
                    #overlay-drawer-tab, #overlay-side-drawer { display: none !important; }
                }

           /* --- Side drawer — fixed siblings of overlay (Firefox backdrop-filter fix) --- */
           #overlay-drawer-tab {
               position: fixed;
               width: 18px;
               height: 56px;
               background: #141b25;
               border: 1px solid rgba(255, 255, 255, 0.10);
               border-left: none;
               border-radius: 0 8px 8px 0;
               color: #3fb950;
               font-size: 11px;
               line-height: 1;
               cursor: pointer;
               display: flex;
               align-items: center;
               justify-content: center;
               padding: 0;
               z-index: 1000001;
               transition: background 0.15s ease, color 0.15s ease;
           }
           #overlay-drawer-tab:hover {
               background: linear-gradient(135deg, #2e2e2e, #1f1f1f);
               color: #6dd170;
           }

           #overlay-side-drawer {
               position: fixed;
               width: 200px;
               /* height and maxHeight set dynamically by positionSideDrawer() */
               background: linear-gradient(180deg, #0e141d 0%, #0b1017 100%);
               border: 1px solid rgba(255, 255, 255, 0.10);
               border-radius: 12px;
               box-shadow: 0 16px 48px rgba(0,0,0,0.6);
               padding: 10px;
               box-sizing: border-box;
               overflow-y: auto;
               z-index: 1;
               opacity: 1;
               transition: opacity 0.18s ease, transform 0.18s ease;
           }
           #overlay-side-drawer.side-drawer-closed {
               display: none !important;
           }

           .side-drawer-title {
               font-size: 10px;
               font-weight: 600;
               color: #8a97a8;
               text-transform: uppercase;
               text-align: center;
               padding-bottom: 7px;
               margin-bottom: 9px;
               border-bottom: 1px solid rgba(255, 255, 255, 0.07);
               letter-spacing: 1.4px;
           }

           /* Horizontal layout: 4 rows, columns grow rightward. The concrete
              grid-template-rows / grid-auto-flow / width are set per-render in
              renderSideDrawer() based on how many strategies are in the drawer. */
           .side-drawer-grid {
               display: grid;
               grid-auto-flow: column;
               gap: 4px;
           }
           /* Drawer tiles track the main grid's button size (width:100% fills the
              column), but the icon glyph is one notch smaller (12px vs the main
              13px) so it reads as a slightly lighter variant. */
           #overlay-side-actions .action-btn-lg {
               width: 100%;
               font-size: 12px;
           }
           /* Monochrome strategy glyphs; drawer variant one notch smaller. */
           .vx-strat-icon { display: block; }
           #overlay-side-actions .vx-strat-icon { width: 16px; height: 16px; }

           /* ---- Core/Alternative strategy toggle ---- */
           .vx-strat-toggle {
               display: flex;
               gap: 4px;
               margin-bottom: 8px;
           }
           .vx-st-btn {
               flex: 1;
               background: transparent;
               border: 1px solid rgba(255, 255, 255, 0.08);
               color: #8b949e;
               border-radius: 6px;
               padding: 4px 0;
               font-size: 10px;
               font-weight: 500;
               letter-spacing: 0.3px;
               text-transform: uppercase;
               cursor: pointer;
               transition: all 0.12s ease;
           }
           .vx-st-btn:hover { color: #e6edf3; border-color: rgba(255, 255, 255, 0.18); }
           .vx-st-btn.on { background: rgba(63, 185, 80, 0.16); border-color: rgba(63, 185, 80, 0.5); color: #3fb950; }

           /* ---- Status strip ---- */
           .vx-status-strip {
               display: grid;
               grid-template-columns: repeat(4, 1fr);
               gap: 5px;
               padding: 7px 12px;
               border-bottom: 1px solid rgba(255, 255, 255, 0.10);
           }
           .vx-stat {
               display: flex;
               align-items: baseline;
               justify-content: space-between;
               gap: 4px;
               background: linear-gradient(160deg, #161e2a, #0f151e);
               border: 1px solid rgba(255, 255, 255, 0.08);
               border-radius: 7px;
               padding: 4px 8px;
               min-width: 0;
           }
           .vx-stat-k {
               font-size: 9px;
               font-weight: 500;
               color: #7d8694;
               text-transform: uppercase;
               letter-spacing: 0.5px;
           }
           .vx-stat-v {
               font-size: 14px;
               font-weight: 600;
               color: #e6edf3;
               white-space: nowrap;
               font-variant-numeric: tabular-nums;
               /* money P/L can be long ("+1,234.56 USDT") — clip instead of
                  stretching the 4-up grid */
               min-width: 0;
               overflow: hidden;
               text-overflow: ellipsis;
           }
           .vx-stat-v.hot { color: #3fb950; }
           .vx-stat-v.cold { color: #58a6ff; }
           .vx-stat-v.heat { color: #3fb950; }
           .vx-stat-v.plneg { color: #e5534b; }
           .vx-stat-sub {
               font-size: 10px;
               font-weight: 400;
               color: #6e7681;
               margin-left: 2px;
           }

           /* ---- Heatmap momentum arrows ---- */
           .heatmap-number { position: relative; }
           .vx-mom {
               position: absolute;
               top: 1px;
               right: 1px;
               /* Dark halo so the arrow reads on any HSL cell colour. */
               filter: drop-shadow(0 0 1px rgba(0,0,0,0.95)) drop-shadow(0 0 1px rgba(0,0,0,0.7));
           }
           .vx-mom.up { color: #16e85a; }
           .vx-mom.down { color: #4ea8ff; }

           /* ---- Hot combos ---- */
           .vx-combos {
               padding: 10px 12px 12px;
               border-top: 1px solid rgba(255, 255, 255, 0.10);
           }
           .vx-combos-head {
               display: flex;
               align-items: center;
               justify-content: space-between;
               margin-bottom: 8px;
           }
           .vx-section-title {
               font-size: 10px;
               font-weight: 600;
               color: #8a97a8;
               text-transform: uppercase;
               letter-spacing: 1.2px;
           }
           .vx-fav-toggle {
               display: inline-flex;
               align-items: center;
               gap: 4px;
               font-size: 10px;
               color: #8b949e;
               background: transparent;
               border: 1px solid rgba(255, 255, 255, 0.10);
               border-radius: 6px;
               padding: 3px 7px;
               cursor: pointer;
               transition: all 0.12s ease;
           }
           .vx-fav-toggle:hover { border-color: rgba(240, 192, 0, 0.5); color: #e6edf3; }
           .vx-fav-toggle.on { color: #f0c000; border-color: rgba(240, 192, 0, 0.45); }
           /* size pills (2-10) */
           .vx-gsizes { display: flex; gap: 3px; margin-bottom: 7px; }
           .vx-gsize {
               flex: 1;
               background: #10161f;
               border: 1px solid rgba(255, 255, 255, 0.08);
               color: #8b949e;
               border-radius: 5px;
               padding: 3px 0;
               font-size: 10px;
               cursor: pointer;
               transition: all 0.12s ease;
           }
           .vx-gsize:hover { border-color: rgba(63, 185, 80, 0.4); color: #e6edf3; }
           .vx-gsize.on { background: rgba(63, 185, 80, 0.16); border-color: rgba(63, 185, 80, 0.5); color: #3fb950; }
           /* view tabs */
           .vx-gtabs { display: flex; gap: 3px; margin-bottom: 8px; }
           .vx-gtab {
               flex: 1;
               background: transparent;
               border: 1px solid rgba(255, 255, 255, 0.08);
               color: #8b949e;
               border-radius: 5px;
               padding: 4px 0;
               font-size: 10px;
               cursor: pointer;
               transition: all 0.12s ease;
           }
           .vx-gtab:hover { color: #e6edf3; border-color: rgba(255, 255, 255, 0.18); }
           .vx-gtab.on { background: rgba(255, 255, 255, 0.06); color: #e6edf3; border-color: rgba(255, 255, 255, 0.2); }
           /* table header + rows */
           .vx-ghead, .vx-grow {
               display: flex;
               align-items: center;
               gap: 6px;
           }
           .vx-ghead {
               font-size: 9px;
               color: #6e7681;
               text-transform: uppercase;
               letter-spacing: 0.4px;
               padding: 0 4px 5px;
           }
           .vx-grow {
               background: #0f1620;
               border: 1px solid rgba(255, 255, 255, 0.08);
               border-radius: 6px;
               padding: 5px 4px 5px 8px;
               margin-bottom: 5px;
               cursor: pointer;
               transition: all 0.12s ease;
           }
           .vx-grow:last-child { margin-bottom: 0; }
           .vx-grow:hover { border-color: rgba(63, 185, 80, 0.45); background: #111924; }
           .vx-gnums {
               flex: 1;
               min-width: 0;
               font-size: 11px;
               font-weight: 500;
               color: #e6edf3;
               white-space: nowrap;
               overflow: hidden;
               text-overflow: ellipsis;
           }
           .vx-gcell {
               flex: 0 0 auto;
               width: 34px;
               text-align: right;
               font-size: 10px;
               color: #8b949e;
           }
           .vx-gcell.heat { color: #3fb950; }
           .vx-gcell.gap.now { color: #3fb950; }
           .vx-gcell.gap.due { color: #d6a700; }
           .vx-gcell.gap.overdue { color: #e0913a; font-weight: 600; text-shadow: 0 0 6px rgba(224, 145, 58, 0.85); }
           /* Combo History gap uses the same states as Hot Groups gap */
           .vx-chgap.now { color: #3fb950; }
           .vx-chgap.due { color: #d6a700; }
           .vx-chgap.overdue { color: #e0913a; font-weight: 600; text-shadow: 0 0 6px rgba(224, 145, 58, 0.85); }
           .vx-chsub sup, .vx-chmx sup { font-size: 8px; opacity: 0.75; }
           .vx-gexp {
               font-size: 9px;
               color: #6e7681;
               text-align: right;
               padding: 2px 2px 0;
           }
           .vx-gtrend { display: inline-flex; vertical-align: middle; margin-right: 3px; }
           .vx-gtrend:empty { display: none; }
           .vx-combo-star {
               background: transparent;
               border: none;
               padding: 0 2px;
               cursor: pointer;
               color: #3a434f;
               display: inline-flex;
               flex: 0 0 auto;
               transition: color 0.12s ease;
           }
           .vx-combo-star:hover { color: #f0c000; }
           .vx-combo-star.on { color: #f0c000; }
           .vx-combos-empty {
               font-size: 11px;
               color: #6e7681;
               text-align: center;
               padding: 10px 4px;
           }
           .vx-combos-hint {
               font-size: 9px;
               color: #6e7681;
               text-align: center;
               padding: 7px 4px 2px;
               line-height: 1.4;
           }

           /* ---- Smart picker ---- */
           .vx-spctl {
               display: flex;
               align-items: center;
               justify-content: space-between;
               gap: 8px;
               margin-bottom: 8px;
           }
           .vx-spsize {
               background: #10161f;
               border: 1px solid rgba(255, 255, 255, 0.10);
               color: #e6edf3;
               border-radius: 6px;
               padding: 4px 8px;
               font-size: 11px;
               cursor: pointer;
               outline: none;
           }
           .vx-spsize:hover { border-color: rgba(63, 185, 80, 0.45); }
           .vx-spnums {
               display: flex;
               flex-wrap: wrap;
               gap: 4px;
               align-items: center;
           }
           .vx-chip {
               background: #1a2330;
               border-radius: 4px;
               font-size: 11px;
               font-weight: 500;
               color: #e6edf3;
               padding: 2px 7px;
           }
           .vx-spapply {
               flex: 0 0 auto;
               background: rgba(63, 185, 80, 0.16);
               border: 1px solid rgba(63, 185, 80, 0.5);
               color: #3fb950;
               border-radius: 6px;
               padding: 5px 12px;
               font-size: 11px;
               font-weight: 600;
               cursor: pointer;
               transition: all 0.12s ease;
           }
           .vx-spapply:hover { background: rgba(63, 185, 80, 0.28); }
           .vx-spstats {
               display: flex;
               flex-wrap: wrap;
               gap: 4px 12px;
               margin-top: 8px;
               font-size: 10px;
               color: #6e7681;
           }
           .vx-spstats b { color: #c9d1d9; font-weight: 600; }
           .vx-spstats b.pos, .vx-chpl.pos { color: #3fb950; }
           .vx-spstats b.neg, .vx-chpl.neg { color: #e5534b; }

           /* ---- Combo history ---- */
           .vx-chcount {
               font-size: 10px;
               color: #6e7681;
               background: #10161f;
               border: 1px solid rgba(255, 255, 255, 0.08);
               border-radius: 10px;
               padding: 1px 8px;
           }
           .vx-chrow {
               background: #0f1620;
               border: 1px solid rgba(255, 255, 255, 0.08);
               border-radius: 6px;
               padding: 6px 9px;
               margin-bottom: 5px;
               cursor: pointer;
               transition: all 0.12s ease;
           }
           .vx-chrow:last-child { margin-bottom: 0; }
           .vx-chrow:hover { border-color: rgba(63, 185, 80, 0.45); background: #111924; }
           .vx-chtop { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
           .vx-chpl { font-size: 11px; font-weight: 600; color: #8b949e; flex: 0 0 auto; }
           .vx-chsub { font-size: 9px; color: #6e7681; margin-top: 3px; }
           .vx-chbest { color: #3fb950; cursor: pointer; border-bottom: 1px dotted rgba(63, 185, 80, 0.5); }
           .vx-chdetail { font-size: 9px; color: #8b949e; margin-top: 4px; padding-top: 4px; border-top: 1px solid rgba(255, 255, 255, 0.06); }
           .vx-chmx { color: #c9d1d9; }
           .vx-chmx sup { color: #6e7681; font-size: 8px; }
           /* sortable header cells */
           .vx-gsort { cursor: pointer; }
           .vx-gsort:hover { color: #e6edf3; }
           .vx-gsort.on { color: #3fb950; }
           .vx-gcar { font-size: 8px; }

           /* ---- Mines mode ---- */
           /* the AI badge drives keno strategies — nothing to apply in mines */
           .vx-mines-mode #enhancement-status { display: none; }
           /* two-up tiles: money and percentages need more room than a quarter
              of the panel gives them */
           .vx-mines-mode .vx-status-strip { grid-template-columns: repeat(2, 1fr); }
           .vx-mtabs {
               display: flex;
               align-items: center;
               gap: 4px;
               margin: 8px 0 10px;
           }
           .vx-mtab {
               background: #10161f;
               border: 1px solid rgba(255, 255, 255, 0.08);
               color: #8b949e;
               border-radius: 6px;
               padding: 2px 9px;
               font-size: 11px;
               font-weight: 600;
               font-family: inherit;
               cursor: pointer;
               font-variant-numeric: tabular-nums;
           }
           .vx-mtab:hover { color: #e6edf3; border-color: rgba(255, 255, 255, 0.18); }
           .vx-mtab.on { background: rgba(63, 185, 80, 0.16); border-color: rgba(63, 185, 80, 0.5); color: #3fb950; }
           .vx-mtabs-k { font-size: 9px; color: #6e7681; text-transform: uppercase; letter-spacing: 0.5px; margin-left: 2px; }
           .vx-mines-grid {
               display: grid;
               grid-template-columns: repeat(5, 1fr);
               gap: 4px;
           }
           .vx-mcell {
               aspect-ratio: 1;
               display: flex;
               flex-direction: column;
               justify-content: center;
               align-items: center;
               gap: 1px;
               border-radius: 7px;
               border: 1.5px solid rgba(255, 255, 255, 0.05);
               font-size: 11px;
               font-weight: 600;
               position: relative;
               cursor: pointer;
               transition: transform 0.12s ease, box-shadow 0.12s ease;
           }
           .vx-mcell:hover { transform: translateY(-1px); }
           /* tiles in the current selection */
           .vx-mcell.picked {
               box-shadow: 0 0 0 2px #3fb950, 0 0 8px rgba(63, 185, 80, 0.5);
               border-color: #3fb950 !important;
           }
           .vx-mnum { font-size: 11px; line-height: 1; }
           .vx-mhits { font-size: 9px; opacity: 0.75; font-variant-numeric: tabular-nums; }
           .vx-mrank {
               display: flex;
               justify-content: space-between;
               gap: 8px;
               font-size: 10px;
               color: #8b949e;
               margin-top: 9px;
           }
           .vx-mrank b { color: #3fb950; margin-left: 2px; }
           .vx-mrank b.bad { color: #e5534b; }
           .vx-mrank.dim { color: #6e7681; justify-content: flex-start; }
           .vx-mregions {
               display: flex;
               gap: 10px;
               font-size: 9px;
               color: #6e7681;
               margin-top: 5px;
               text-transform: uppercase;
               letter-spacing: 0.4px;
           }
           .vx-mregions b { color: #c9d1d9; font-variant-numeric: tabular-nums; }
           .vx-mregions b.good { color: #3fb950; }
           .vx-mregions b.bad { color: #e5534b; }
           .vx-mpick { display: flex; gap: 5px; align-items: center; margin-top: 10px; }
           .vx-mpsize, .vx-mpbtn {
               background: #10161f;
               border: 1px solid rgba(255, 255, 255, 0.1);
               color: #c9d1d9;
               border-radius: 6px;
               padding: 3px 8px;
               font-size: 10px;
               font-weight: 600;
               font-family: inherit;
               cursor: pointer;
           }
           .vx-mpbtn:hover { border-color: rgba(63, 185, 80, 0.5); color: #3fb950; }
           .vx-mpsize { padding: 3px 4px; }
           .vx-msel {
               display: flex;
               align-items: baseline;
               gap: 8px;
               margin-top: 8px;
               font-size: 11px;
               color: #8b949e;
           }
           .vx-mselk { font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px; color: #7d8694; }
           .vx-mselv { font-size: 15px; color: #3fb950; font-variant-numeric: tabular-nums; }
           .vx-mselnext { font-size: 10px; color: #6e7681; margin-left: auto; }
           .vx-mines-note { font-size: 9px; color: #6e7681; margin-top: 7px; line-height: 1.4; }
           /* cluster + revealed-combo tables share a row layout */
           .vx-mclusters, .vx-mcombos { margin-top: 10px; }
           .vx-mchead, .vx-mclust {
               display: grid;
               grid-template-columns: 1fr 42px 44px 40px;
               gap: 4px;
               align-items: center;
               font-variant-numeric: tabular-nums;
           }
           .vx-mchead {
               font-size: 8px;
               text-transform: uppercase;
               letter-spacing: 0.5px;
               color: #6e7681;
               padding: 0 6px 4px;
           }
           .vx-mchead span:not(:first-child), .vx-mclust span:not(:first-child) { text-align: right; }
           .vx-mclust {
               background: #0d131c;
               border: 1px solid rgba(255, 255, 255, 0.06);
               border-radius: 7px;
               padding: 5px 6px;
               margin-bottom: 4px;
               font-size: 10px;
               color: #c9d1d9;
               cursor: pointer;
           }
           .vx-mclust:hover { border-color: rgba(63, 185, 80, 0.45); background: #111924; }
           .vx-mctiles { color: #e6edf3; font-weight: 600; }
           .vx-mcrate { color: #3fb950; font-weight: 600; }
           .vx-mcedge.good { color: #3fb950; }
           .vx-mcedge.bad { color: #e5534b; }
           .vx-mcev { color: #8b949e; }
           /* payout ladder */
           .vx-mpayhead {
               display: flex;
               align-items: center;
               gap: 6px;
               margin-top: 12px;
               cursor: pointer;
           }
           .vx-mpayhead:hover .vx-section-title { color: #3fb950; }
           .vx-mpaymax { font-size: 10px; color: #3fb950; margin-left: auto; font-variant-numeric: tabular-nums; }
           .vx-mcar { font-size: 8px; color: #6e7681; }
           .vx-mpaygrid {
               display: grid;
               grid-template-columns: repeat(3, 1fr);
               gap: 3px;
               margin-top: 7px;
           }
           .vx-mpayrow {
               background: #0d131c;
               border: 1px solid rgba(255, 255, 255, 0.06);
               border-radius: 5px;
               padding: 3px 5px;
               font-size: 10px;
               color: #c9d1d9;
               display: flex;
               justify-content: space-between;
               gap: 4px;
               font-variant-numeric: tabular-nums;
           }
           .vx-mpayrow i { color: #6e7681; font-style: normal; }
           .vx-mpayrow.on { border-color: rgba(63, 185, 80, 0.5); color: #3fb950; }
           .vx-mpayrow.on i { color: #3fb950; }
           .vx-mchips { display: flex; flex-wrap: wrap; gap: 4px; }
           .vx-mchip {
               font-size: 10px;
               font-weight: 600;
               border-radius: 5px;
               padding: 2px 6px;
               border: 1px solid transparent;
               font-variant-numeric: tabular-nums;
           }
           .vx-mchip.win { background: rgba(63, 185, 80, 0.14); border-color: rgba(63, 185, 80, 0.4); color: #3fb950; }
           .vx-mchip.loss { background: rgba(229, 83, 75, 0.12); border-color: rgba(229, 83, 75, 0.35); color: #e5534b; }
           .vx-mstreak { font-size: 10px; color: #8b949e; margin-top: 9px; }
           .vx-mstreak b.pos { color: #3fb950; }
           .vx-mstreak b.neg { color: #e5534b; }
           `;

            // Marks on the game's own tiles. Separate node because these rules
            // target the host page, not anything inside the overlay.
            const boardStyles = document.createElement('style');
            boardStyles.id = 'vantedge-board-styles';
            boardStyles.textContent = `
               .vx-board-pick {
                   outline: 2px solid #3fb950 !important;
                   outline-offset: -2px;
                   box-shadow: inset 0 0 12px rgba(63, 185, 80, 0.45) !important;
               }
           `;
            safe(() => document.head.appendChild(boardStyles));

            safe(() => document.head.appendChild(styles));
        }

        attachEventListeners() {
            safe(() => {
                const minimizeBtn = this.overlay.querySelector('#overlay-minimize');
                const toggleBtn = this.overlay.querySelector('#overlay-toggle');
                const resetBtn = this.overlay.querySelector('#overlay-reset');
                const drawerTab = document.getElementById('overlay-drawer-tab');
                const header = this.overlay.querySelector('.overlay-header');

                if (minimizeBtn) minimizeBtn.addEventListener('click', () => this.toggleMinimize());
                if (toggleBtn) toggleBtn.addEventListener('click', () => this.toggleVisibility());
                if (resetBtn) resetBtn.addEventListener('click', () => this.resetStats());
                const layoutBtn = this.overlay.querySelector('#overlay-layout');
                if (layoutBtn) layoutBtn.addEventListener('click', () => this.toggleLayoutMode());
                if (drawerTab) {
                    drawerTab.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.toggleSideDrawer();
                    });
                }
                if (header) header.addEventListener('pointerdown', (e) => this.startDrag(e));
                // Click the AI status badge to apply whatever it recommends.
                const enh = this.overlay.querySelector('#enhancement-status');
                if (enh) {
                    enh.style.cursor = 'pointer';
                    enh.addEventListener('click', (e) => { e.stopPropagation(); this.applyRecommendedStrategy(); });
                }
            });
        }

        showDefaultExplanation() {
            const contentEl = this.overlay.querySelector('#strategy-explanation-text');
            if (contentEl && !this.currentActiveButton) {
                contentEl.innerHTML = `
            <span class="strategy-name">Strategy Info</span>
            <div class="strategy-description">Hover over any strategy button to see how it works</div>
        `;
            }
        }

        setActiveButton(buttonId) {
            const toggleableStrategies = ['variance'];
            toggleableStrategies.forEach(strategyId => {
                if (strategyId !== buttonId) {
                    if (this.strategyToggles[strategyId] === true) {
                        this.strategyToggles[strategyId] = false;

                        const btn = this.overlay.querySelector(`.action-btn-lg[data-action="${strategyId}"]`);
                        if (btn) {
                            btn.classList.remove('low-mode');
                        }
                    }
                }
            });

            const browserAPI = (typeof browser !== 'undefined') ? browser : chrome;
            browserAPI.storage.local.set({ strategyToggles: this.strategyToggles });

            // Clear active state in main grid AND side drawer (drawer is a body sibling)
            document.querySelectorAll('.action-btn-lg').forEach(btn => {
                btn.classList.remove('active-button');
            });
            document.querySelectorAll('.action-item').forEach(item => {
                item.classList.remove('explaining');
            });

            // Reset regime button appearance if user switches away
            if (this._regimeResetOnNext && buttonId !== 'regime') {
                const rb = this.overlay.querySelector('#overlay-select-regime .action-btn-lg');
                const rl = this.overlay.querySelector('#overlay-select-regime .action-label');
                if (rb) { rb.classList.remove('regime-hot', 'regime-cold', 'regime-neutral'); rb.textContent = '🌡️'; rb.title = ''; }
                if (rl) { rl.classList.remove('regime-hot', 'regime-cold'); rl.textContent = 'Regime'; }
                this._regimeResetOnNext = false;
            }

            // Find in main grid (has id) or side drawer (has data-action only)
            const activeBtn = this.overlay.querySelector(`#overlay-select-${buttonId} .action-btn-lg`)
                || document.querySelector(`#overlay-side-actions .action-btn-lg[data-action="${buttonId}"]`);
            const activeItem = this.overlay.querySelector(`#overlay-select-${buttonId}`)
                || document.querySelector(`#overlay-side-actions .action-item[data-strategy-id="${buttonId}"]`);

            if (activeBtn && activeItem) {
                activeBtn.classList.add('active-button');
                activeItem.classList.add('explaining');
            }

            this.currentActiveButton = buttonId;

            if (typeof browser !== 'undefined' && browser.storage) {
                browser.storage.local.set({ activeKenoStrategy: buttonId });
            }
            window.postMessage({ type: 'VANTEDGE_STRATEGY_SELECTED', strategy: buttonId }, window.location.origin);
        }

        clearActiveButton() {
            document.querySelectorAll('.action-btn-lg').forEach(btn => {
                btn.classList.remove('active-button');
            });
            document.querySelectorAll('.action-item').forEach(item => {
                item.classList.remove('explaining');
            });

            // Reset regime button appearance on full deselect
            if (this._regimeResetOnNext) {
                const rb = this.overlay.querySelector('#overlay-select-regime .action-btn-lg');
                const rl = this.overlay.querySelector('#overlay-select-regime .action-label');
                if (rb) { rb.classList.remove('regime-hot', 'regime-cold', 'regime-neutral'); rb.textContent = '🌡️'; rb.title = ''; }
                if (rl) { rl.classList.remove('regime-hot', 'regime-cold'); rl.textContent = 'Regime'; }
                this._regimeResetOnNext = false;
            }

            this.currentActiveButton = null;
            this.showDefaultExplanation();

            if (typeof browser !== 'undefined' && browser.storage) {
                browser.storage.local.remove(['activeOverlayButton', 'activeKenoStrategy']);
            }
        }

        loadActiveButton() {
            if (typeof browser !== 'undefined' && browser.storage) {
                browser.storage.local.get(['activeKenoStrategy'], (result) => {
                    if (result.activeKenoStrategy) {
                        this.setActiveButton(result.activeKenoStrategy);
                    }
                });
            }
        }

        detectKeno() {
            let attempts = 0;
            const maxAttempts = 10;
            const retryDelay = 2000;

            // One detection loop at a time — remounting the keno body (or a URL
            // change) would otherwise leave the old interval running.
            clearInterval(this._kenoDetectHandle);
            this._kenoDetectHandle = setInterval(() => {
                attempts++;
                const kenoButtons = this.findKenoNumbers();

                if (kenoButtons && kenoButtons.length >= 35) {
                    clearInterval(this._kenoDetectHandle);
                    this.stakeKenoButtons = kenoButtons;
                    return;
                }

                if (attempts >= maxAttempts) {
                    clearInterval(this._kenoDetectHandle);
                }
            }, retryDelay);
        }

        setupUrlWatcher() {
            let lastURL = location.href;
            const debouncedUrlCheck = this.debounce(() => {
                const url = location.href;
                if (url !== lastURL) {
                    lastURL = url;
                    // Game swaps are handled by the route watcher at the bottom of
                    // this file; here we only refresh keno's board detection.
                    if (url.includes('keno')) {
                        this.cachedButtons = null;
                        this.detectKeno();
                    }
                }
            }, 1000);
            this.mutationObserver = new MutationObserver(debouncedUrlCheck);
            this.mutationObserver.observe(document, { subtree: true, childList: true });
        }


        findKenoNumbers() {
            const now = Date.now();
            if (this.cachedButtons && (now - this.lastCacheTime) < 3000) {
                return this.cachedButtons;
            }

            return safe(() => {
                const site = this.getCurrentSite();
                // On Rainbet we may be in Extreme (1–56) instead of classic (1–40).
                // Everywhere else, 40 is the universal upper bound.
                const maxN = (site === 'rainbet') ? 56 : 40;
                let selector = '';
                let parentSelector = null;
                let containerSelector = null;
                let bestMatch = [];

                if (site === 'roobet') {
                    const sections = document.querySelectorAll('section');
                    let roobetContainer = null;
                    sections.forEach(section => {
                        const labels = section.querySelectorAll('label');
                        if (labels.length >= 40) {
                            roobetContainer = section;
                        }
                    });

                    console.log('[Vantedge] Roobet: Found container with', roobetContainer?.querySelectorAll('label').length || 0, 'labels');

                    if (roobetContainer) {
                        const labels = Array.from(roobetContainer.querySelectorAll('label'));
                        const foundButtons = [];

                        labels.forEach(label => {
                            if (label.closest('#geminyzer-overlay')) return;

                            const span = label.querySelector('span:not([type="checkbox"])');
                            if (!span) return;

                            const text = span.textContent?.trim();
                            const num = parseInt(text, 10);

                            // Roobet is classic-only — keep 1–40
                            if (isNaN(num) || num < 1 || num > 40 || text !== num.toString()) return;

                            const rect = label.getBoundingClientRect();
                            const style = window.getComputedStyle(label);

                            if (rect.width > 20 && rect.height > 20 &&
                                style.display !== 'none' && style.visibility !== 'hidden') {
                                foundButtons.push({ element: label, number: num });
                            }
                        });

                        console.log('[Vantedge] Roobet: Found', foundButtons.length, 'buttons');

                        if (foundButtons.length >= 35) {
                            const uniqueMap = new Map();
                            foundButtons.forEach(item => uniqueMap.set(item.number, item));
                            bestMatch = Array.from(uniqueMap.values())
                                .sort((a, b) => a.number - b.number)
                                .map(item => item.element);

                            console.log('[Vantedge] Roobet: Returning', bestMatch.length, 'unique buttons');
                            this.lastCacheTime = now;
                            this.cachedButtons = bestMatch;
                            return bestMatch;
                        } else {
                            console.warn('[Vantedge] Roobet: Only found', foundButtons.length, 'buttons, expected 40');
                        }
                    } else {
                        console.warn('[Vantedge] Roobet: No section with 40+ labels found');
                    }

                    return [];
                } else if (site === 'rainbet') {
                    const possibleContainers = [
                        'div[class*="Keno_grid"]',
                        'div[class*="keno_grid" i]',
                        'div[class*="Grid"]',
                        'div[class*="grid"]',
                        'div[class*="keno" i]',
                        '[data-testid*="keno"]',
                        'main div[class*="game"]'
                    ];

                    for (const testSelector of possibleContainers) {
                        const testContainer = document.querySelector(testSelector);
                        if (testContainer) {
                            containerSelector = testSelector;
                            break;
                        }
                    }

                    if (!containerSelector) {
                        containerSelector = 'div[class*="Keno_grid"]'; // fallback
                    }

                    selector = 'span[class*="Keno_number"], span[class*="keno_number" i], span[class*="number"], button span';
                    parentSelector = 'button[class*="Keno_grid-item"], button[class*="keno_grid-item" i], button[class*="grid-item" i], button';
                } else if (site === 'shuffle') {
                    containerSelector = 'div[class*="KenoGrid_numberContainer"]';
                    selector = 'button[data-testid^="keno-button-"]';
                    parentSelector = null;
                } else if (site === 'betfury') {
                    const possibleContainers = [
                        'div.board',
                        'div[class*="board"]',
                        'div[class*="keno"]',
                        'div[class*="Keno"]',
                        'div[class*="game"]',
                        'div[class*="Game"]',
                        'div.keno-grid',
                        'div.game-board',
                        '[data-testid*="keno"]',
                        'canvas + div',
                        'main div[class*="grid"]'
                    ];

                    for (const testSelector of possibleContainers) {
                        const testContainer = document.querySelector(testSelector);
                        if (testContainer) {
                            containerSelector = testSelector;
                            break;
                        }
                    }

                    if (!containerSelector) {
                        containerSelector = 'div.board'; // fallback
                    }

                    selector = 'button span, button, div[role="button"]';
                    parentSelector = 'button, div[role="button"]';
                } else if (site === 'winna') {
                    containerSelector = '.keno-field';
                    selector = 'button > span';
                    parentSelector = 'button';
                } else if (site === 'acebet') {
                    // Rebuilt board: numbers are now plain <button>s (the digit is
                    // the button's only text). Match buttons and keep the ones whose
                    // text is 1-40; the generic scan below dedupes and filters.
                    containerSelector = null;
                    selector = 'button';
                    parentSelector = null;
                } else { // Stake (default)
                    containerSelector = '.game-content.stake-original, [data-testid="game-keno"]';
                    selector = 'button.tile > span.tile-number, button.tile > span, button[data-testid^="tile-"] span';
                    parentSelector = 'button';
                }

                let gameContainer = containerSelector ? document.querySelector(containerSelector) : document.body;
                if (!gameContainer && site === 'stake') {
                    const testButton = document.querySelector('button[data-testid^="tile-"]');
                    if (testButton) {
                        gameContainer = testButton.parentElement || document.body;
                    }
                }
                if (!gameContainer && site === 'acebet') {
                    gameContainer = document.body;
                }
                if (!gameContainer) {
                    return [];
                }

                bestMatch = [];
                const elements = Array.from(gameContainer.querySelectorAll(selector));
                const foundButtons = [];

                elements.forEach(el => {
                    if (el.closest('#geminyzer-overlay')) return;

                    const text = el.textContent?.trim();
                    const num = parseInt(text, 10);

                    if (isNaN(num) || num < 1 || num > maxN || text !== num.toString()) return;

                    const buttonElement = parentSelector ? el.closest(parentSelector) : el;
                    if (!buttonElement) return;

                    const rect = buttonElement.getBoundingClientRect();
                    const style = window.getComputedStyle(buttonElement);

                    if (rect.width > 20 && rect.height > 20 &&
                        style.display !== 'none' && style.visibility !== 'hidden') {
                        foundButtons.push({ element: buttonElement, number: num });
                    }
                });

                if (foundButtons.length >= 35) {
                    const uniqueMap = new Map();
                    foundButtons.forEach(item => uniqueMap.set(item.element, item));
                    bestMatch = Array.from(uniqueMap.values())
                        .sort((a, b) => a.number - b.number)
                        .map(item => item.element);
                }

                if (bestMatch.length < 35) {
                    console.warn(`⚠️ ${site}: Only ${bestMatch.length}/40 buttons found, trying fallback...`);
                    bestMatch = this.manualKenoDetection();
                }

                if (bestMatch.length >= 35) {
                    this.lastCacheTime = now;
                    this.cachedButtons = bestMatch;
                } else {
                    this.cachedButtons = null;
                }
                return bestMatch;
            }, []);
        }

        manualKenoDetection() {
            const site = this.getCurrentSite();
            const maxN = (site === 'rainbet') ? 56 : 40;
            const allElements = document.querySelectorAll('div, button, span, [role="button"], [tabindex], text');
            let potentialButtons = [];

            allElements.forEach(el => {
                if (el.closest('#geminyzer-overlay')) return;
                const text = el.textContent?.trim();
                const num = parseInt(text, 10);
                if (isNaN(num) || num < 1 || num > maxN || text !== num.toString()) return;
                const rect = el.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0) return;
                const parent = el.closest('div, section, label, button');
                if (!parent) return;
                potentialButtons.push({ element: el, number: num, parent: parent });
            });

            // Need at least 40 for classic; if Rainbet has more, accept the bigger pool
            if (potentialButtons.length < 40) return [];

            const parentGroups = new Map();
            potentialButtons.forEach(btn => {
                if (!parentGroups.has(btn.parent)) parentGroups.set(btn.parent, []);
                parentGroups.get(btn.parent).push(btn);
            });

            let bestGroup = [];
            for (const group of parentGroups.values()) {
                // Prefer exact-match for the expected pool size (40 or 56)
                if (group.length === maxN || group.length === 40) {
                    if (group.length > bestGroup.length) bestGroup = group;
                }
                if (group.length >= 35 && group.length > bestGroup.length) {
                    bestGroup = group;
                }
            }

            return bestGroup
                .sort((a, b) => a.number - b.number)
                .map(item => {
                    const site = this.getCurrentSite();
                    if (site === 'roobet') {
                        return item.element.closest('label') || item.element;
                    }
                    if (site === 'rainbet' || site === 'shuffle' || site === 'betfury' || site === 'winna') {
                        return item.element.closest('button') || item.element;
                    }
                    return item.element;
                });
        }

        populateHeatmap() {
            const grid = this.overlay.querySelector('#overlay-keno-grid');
            if (!grid) return;

            const N = this.numberCount;
            const hotNumbers = this.data.kenoStats.hotNumbers;
            const totalOccurrences = hotNumbers.reduce((a, b) => a + b, 0);
            const average = totalOccurrences / N; // expected draws per number
            // Observed spread so the tint scales to it — keeps clear hot/cold
            // contrast even once counts converge to within a few % late-game
            // (fixed 1.4x/0.6x thresholds would wash out to near-neutral).
            const { maxAbove, maxBelow } = heatSpread(hotNumbers, average);

            // Initialize cache on first run (or after a mode change cleared it)
            if (this.heatmapCells.length === 0) {
                for (let i = 0; i < N; i++) {
                    const number = i + 1;
                    const cell = document.createElement('div');
                    cell.className = 'heatmap-number';
                    cell.dataset.number = number;
                    cell.innerHTML = `<span class="number">${number}</span><span class="count">0</span><span class="vx-mom-slot"></span>`;
                    // Click a heatmap cell to toggle that number on the game board.
                    cell.addEventListener('click', () => this.toggleNumberSelection(number));
                    grid.appendChild(cell);
                    this.heatmapCells[i] = {
                        cell: cell,
                        countSpan: cell.querySelector('.count'),
                        momSlot: cell.querySelector('.vx-mom-slot')
                    };
                }
            }

            // Fast update using cached references
            const heatScores = this.computeHeatScores();
            for (let i = 0; i < N; i++) {
                const occurrences = hotNumbers[i];
                const cached = this.heatmapCells[i];

                cached.countSpan.textContent = occurrences;
                cached.cell.title = `#${i + 1} · heat ${heatScores[i + 1]}/100 · drawn ${occurrences}× in last 1000`;

                if (cached.momSlot) {
                    const state = this._momentum ? this._momentum[i + 1] : 'flat';
                    cached.momSlot.innerHTML = (state && state !== 'flat') ? this.momentumIcon(state) : '';
                }

                // Neutral gray near the average, brown above it, blue below —
                // the shared palette the mines grid also paints with.
                const style = totalOccurrences === 0
                    ? HEAT_EMPTY
                    : heatStyle(average > 0 ? occurrences / average : 1, maxAbove, maxBelow);
                Object.assign(cached.cell.style, style);
            }
        }

        async updateAIRecommendation() {
            try {
                const browserAPI = (typeof browser !== 'undefined') ? browser : chrome;
                const response = await new Promise((resolve) => {
                    browserAPI.runtime.sendMessage({
                        type: 'GET_AI_RECOMMENDATION',
                        origin: this.storageOrigin
                    }, resolve);
                });

                if (response && response.success && response.recommendation) {
                    const recommendation = response.recommendation;

                    if (!recommendation.strategy || typeof recommendation.score !== 'number') {
                        console.warn('Invalid recommendation data:', recommendation);
                        return;
                    }

                    const winRate = typeof recommendation.recentWinRate === 'number' ? recommendation.recentWinRate : 0;
                    const avgMult = typeof recommendation.avgMultiplier === 'number' ? recommendation.avgMultiplier : 0;

                    // Clear previous glow on BOTH surfaces (drawer is a body sibling,
                    // not inside this.overlay).
                    document.querySelectorAll('.action-btn-lg.ai-recommended').forEach(btn => {
                        btn.classList.remove('ai-recommended');
                        btn.removeAttribute('title');
                    });

                    // The recommended strategy may live on the main grid OR in the
                    // Alternative drawer — glow whichever holds it.
                    const recommendedBtn =
                        this.overlay.querySelector(`#overlay-select-${recommendation.strategy} .action-btn-lg`) ||
                        document.querySelector(`#overlay-side-actions .action-btn-lg[data-action="${recommendation.strategy}"]`);
                    if (recommendedBtn) {
                        recommendedBtn.classList.add('ai-recommended');
                        recommendedBtn.setAttribute('title',
                            `AI Recommended (${recommendation.score.toFixed(1)}% score)\n` +
                            `Win Rate: ${winRate.toFixed(1)}%\n` +
                            `Avg Multiplier: ${avgMult.toFixed(2)}x`
                        );
                    }

                    // Cache AI recommendation for adaptive strategy + the ✨ click-to-apply.
                    this._lastAIRecommendation = recommendation;
                }

                // Pass the already-fetched response so updateEnhancementStatus doesn't
                // need to send a second GET_AI_RECOMMENDATION round-trip.
                await this.updateEnhancementStatus(response);
            } catch (e) {
                console.warn('Failed to fetch AI recommendation:', e);
            }
        }

        // Apply whatever the AI currently recommends — works even when that strategy
        // lives in the Alternative drawer (so "recommends BAYESIAN" is one click away).
        applyRecommendedStrategy() {
            const rec = this._lastAIRecommendation;
            if (!rec || !rec.strategy) return;
            const id = rec.strategy;
            const method = this.getSelectMethodName(id);
            if (method && typeof this[method] === 'function') {
                this.setActiveButton(id);
                this[method]();
                const browserAPI = (typeof browser !== 'undefined') ? browser : chrome;
                browserAPI?.runtime?.sendMessage?.({ type: 'SET_ACTIVE_STRATEGY', strategy: id, origin: this.storageOrigin })?.catch?.(() => {});
            }
        }

        async updateEnhancementStatus(cachedAiRes = null) {
            const statusEl = this.overlay.querySelector('#enhancement-status');
            if (!statusEl) return;

            try {
                // Reuse the response already fetched by updateAIRecommendation to avoid
                // a redundant background round-trip for the same GET_AI_RECOMMENDATION data.
                const aiRes = cachedAiRes ?? await new Promise(resolve => {
                    const browserAPI = (typeof browser !== 'undefined') ? browser : chrome;
                    browserAPI.runtime.sendMessage({
                        type: 'GET_AI_RECOMMENDATION',
                        origin: this.storageOrigin
                    }, resolve);
                });

                if (aiRes?.success && aiRes.recommendation) {
                    statusEl.classList.add('active');
                    statusEl.textContent = '✨';
                    statusEl.title = `AI Prediction Active\nRecommends: ${aiRes.recommendation.strategy.toUpperCase()} (${Math.round(aiRes.recommendation.score)}% match)\n\nClick to apply this strategy (works even if it's in the Alternative drawer).\nGold glow marks it on the grid. Changes dynamically as patterns change.`;
                } else {
                    statusEl.classList.remove('active');
                    statusEl.textContent = '⚡';
                    statusEl.title = 'AI Prediction: Not active\n\nPlay 10+ games to unlock predictive AI recommendations';
                }
            } catch (e) {
                console.warn('Failed to update enhancement status:', e);
            }
        }

        clearSelection() {
            const clearButton = Array.from(document.querySelectorAll('button')).find(btn => btn.textContent?.toLowerCase().includes('clear'));
            if (clearButton) {
                this.clickElement(clearButton);
            } else {
                const kenoButtons = this.findKenoNumbers();
                if (kenoButtons) {
                    kenoButtons.forEach(btn => {
                        if (this.isButtonSelected(btn)) this.clickElement(btn);
                    });
                }
            }
        }

        syncSelectionBetweenTabs() {
            this.overlay.querySelectorAll('[data-number]').forEach(el => {
                const number = parseInt(el.dataset.number);
                el.classList.toggle('selected', this.data.selectedNumbers.has(number));
            });
        }

        applyToStake() {
            if (this.data.selectedNumbers.size === 0) return;

            const site = this.getCurrentSite();

            if (site === 'winna') {
                this.highlightWinnaNumbers();
                return;
            }

            const kenoButtons = this.findKenoNumbers();
            if (!kenoButtons || kenoButtons.length < 35) return;

            kenoButtons.forEach(btn => {
                if (this.isButtonSelected(btn)) {
                    this.clickElement(btn);
                }
            });

            setTimeout(() => {
                let appliedCount = 0;
                this.data.selectedNumbers.forEach(number => {
                    const button = kenoButtons.find(btn => this.kenoButtonNumber(btn) === number);
                    if (button) {
                        this.clickElement(button);
                        appliedCount++;
                    }
                });
            }, 200);
        }

        // Map board number -> <button>. The board now renders in the same document
        // as the overlay (winna.com/game/originals/keno). Markup is
        // `<button class="field-button ..."><div class="field-button__surface">
        // <span>32</span></div></button>`, so match the button class and read the
        // nested text. Falls back to "any button whose whole label is 1-40" so a
        // class rename doesn't kill this again.
        findWinnaBoardButtons() {
            const num = (b) => {
                const t = (b.textContent || '').trim();
                return /^\d{1,2}$/.test(t) ? parseInt(t, 10) : NaN;
            };
            // Our own UI lives in this document too and is full of 1-40 labelled
            // buttons (Hot Groups sizes, Smart Picker). Never treat those as board
            // tiles — doing so is what made a strategy click light up the sidebar.
            const OURS = '#geminyzer-overlay, #overlay-side-drawer, #overlay-drawer-tab';
            const notOurs = (b) => !b.closest(OURS);

            // querySelectorAll does not pierce shadow roots, so walk them too —
            // otherwise a shadow-rendered board looks identical to "no board here".
            const deep = (selector) => {
                const out = [];
                const walk = (root) => {
                    out.push(...root.querySelectorAll(selector));
                    root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) walk(el.shadowRoot); });
                };
                walk(document);
                return out;
            };

            const collect = (list) => {
                const map = new Map();
                list.filter(notOurs).forEach(b => {
                    const n = num(b);
                    if (n >= 1 && n <= 40 && !map.has(n)) map.set(n, b);
                });
                return map;
            };

            let map = collect(deep('.keno-field button'));
            if (map.size === 0) map = collect(deep('button.field-button'));
            if (map.size === 0) {
                // Last resort: scan every button. Only trust it if it looks like a
                // real 40-tile board — a handful of numeric buttons is some other
                // control (bet multipliers, pagination), not the keno grid.
                const scanned = collect(deep('button'));
                map = scanned.size >= 30 ? scanned : new Map();
            }
            return map;
        }

        ensureWinnaPickStyle() {
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
                @keyframes vantedgePulse { 0%, 100% { opacity: .55 } 50% { opacity: 1 } }`;
            (document.head || document.documentElement).appendChild(style);
        }

        // A fuller pointer sequence than clickElement: Vue binds real pointer
        // events, and some handlers ignore a PointerEvent with no pointerId or
        // button state. Kept Winna-local so other sites' click paths don't shift.
        winnaClick(button) {
            safe(() => {
                const r = button.getBoundingClientRect();
                const base = {
                    bubbles: true, cancelable: true, composed: true, view: window,
                    clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
                    button: 0
                };
                const pointer = { ...base, pointerId: 1, isPrimary: true, pointerType: 'mouse', width: 1, height: 1 };
                button.dispatchEvent(new PointerEvent('pointerover', pointer));
                button.dispatchEvent(new PointerEvent('pointerenter', pointer));
                button.dispatchEvent(new PointerEvent('pointerdown', { ...pointer, buttons: 1 }));
                button.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
                button.dispatchEvent(new PointerEvent('pointerup', pointer));
                button.dispatchEvent(new MouseEvent('mouseup', base));
                button.dispatchEvent(new MouseEvent('click', base));
            });
        }

        // Apply the recommended numbers to Winna's board.
        //
        // The board lives in this document, so drive it here rather than through
        // content.js's bridge — that indirection was the thing silently failing.
        // Try a real click first; Winna's Vue handlers may ignore untrusted events,
        // so anything that doesn't take gets a pulsing marker to tap manually.
        highlightWinnaNumbers(numbersArg = null) {
            const numbers = numbersArg || Array.from(this.data.selectedNumbers);
            const buttons = this.findWinnaBoardButtons();

            if (buttons.size === 0) {
                // No board in this document — fall back to the iframe layout.
                this.highlightWinnaIframe(numbers);
                return;
            }

            this.ensureWinnaPickStyle();
            this._winnaWanted = numbers.slice();

            // Deselect anything picked that we don't want, then pick what we do.
            buttons.forEach((button, n) => {
                const selected = button.classList.contains('selected');
                if (selected && !numbers.includes(n)) this.winnaClick(button);
            });
            numbers.forEach(n => {
                const button = buttons.get(n);
                if (button && !button.classList.contains('selected')) this.winnaClick(button);
            });

            // Whatever the clicks couldn't select gets marked for manual tapping.
            setTimeout(() => this.markWinnaPicks(), 250);
            this.startWinnaBoardObserver();
        }

        // Mark wanted-but-not-yet-selected numbers. Selected ones lose the marker,
        // so the highlights drain away as you tap them.
        markWinnaPicks() {
            const wanted = this._winnaWanted || [];
            this.findWinnaBoardButtons().forEach((button, n) => {
                const mark = wanted.includes(n) && !button.classList.contains('selected');
                button.classList.toggle('vantedge-pick', mark); // no-op when already correct
            });
        }

        startWinnaBoardObserver() {
            if (this._winnaObserver) return;
            const board = document.querySelector('.keno-field')
                || document.querySelector('button.field-button')?.parentElement;
            if (!board) return;
            let scheduled = false;
            this._winnaObserver = new MutationObserver(() => {
                if (scheduled || !(this._winnaWanted || []).length) return;
                scheduled = true;
                requestAnimationFrame(() => { scheduled = false; this.markWinnaPicks(); });
            });
            this._winnaObserver.observe(board, {
                childList: true, subtree: true, attributes: true, attributeFilter: ['class']
            });
        }

        // Legacy iframe layout (games.winna.com / originals.winna.com), handled by
        // the bridge in content.js.
        highlightWinnaIframe(numbers) {
            const frames = Array.from(document.querySelectorAll('iframe'));
            // Prefer a frame that names Winna, but the game frame's src can be
            // opaque (blob:/about:blank, or a CDN host). Falling back to every
            // frame is safe: the bridge in content.js only acts inside a winna.com
            // frame, and unrelated widgets ignore an unknown message type.
            const named = frames.filter(f => /winna|originals|games/i.test(f.src || ''));
            const targets = (named.length ? named : frames).filter(f => f.contentWindow);

            if (!targets.length) {
                console.warn('Vantedge: Winna board not found — no 40-tile board in this document and no iframe to reach.');
                return;
            }

            targets.forEach(f => f.contentWindow.postMessage({ type: 'WINNA_CLEAR_HIGHLIGHT' }, '*'));
            setTimeout(() => {
                targets.forEach(f => f.contentWindow.postMessage({ type: 'WINNA_HIGHLIGHT_NUMBERS', numbers }, '*'));
            }, 300);
        }

        syncSelectionUI(numbers = []) {
            this.overlay.querySelectorAll('[data-number]').forEach(el => {
                el.classList.remove('selected');
            });
            if (numbers.length > 0) {
                numbers.forEach(num => {
                    const el = this.overlay.querySelector(`[data-number="${num}"]`);
                    if (el) el.classList.add('selected');
                });
            }
        }

        clickElement(element) {
            safe(() => {
                const rect = element.getBoundingClientRect();
                const centerX = rect.left + rect.width / 2;
                const centerY = rect.top + rect.height / 2;
                const opts = {
                    bubbles: true,
                    cancelable: true,
                    view: window,
                    clientX: centerX,
                    clientY: centerY
                };
                // Full pointer→mouse sequence works cross-browser (Chrome, Firefox)
                // and correctly triggers React/Svelte/Vue synthetic event handlers
                ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type => {
                    const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
                    element.dispatchEvent(new Ctor(type, opts));
                });
            });
        }

        isButtonSelected(element) {
            const site = this.getCurrentSite();

            if (site === 'roobet') {
                const checkbox = element.querySelector('input[type="checkbox"]');
                return checkbox ? checkbox.checked : false;
            }

            if (site === 'rainbet') {
                return element.classList.contains('Keno_active__uAf15') ||
                    element.querySelector('.Keno_active-background__uAf15')?.style?.display !== 'none';
            }

            if (site === 'shuffle') {
                const img = element.querySelector('img.KenoGrid_buttonImg__g1cTo');
                return img && img.style.transform === 'scale(1)';
            }

            if (site === 'betfury') {
                return element.classList.contains('selected') ||
                    element.classList.contains('active') ||
                    !element.disabled;
            }

            if (site === 'winna') {
                return element.classList.contains('selected');
            }

            const classes = element.className;
            return classes.includes('selected') || classes.includes('active') || classes.includes('is-selected');
        }

        // Read the keno number from a board button/cell. Roobet renders the number
        // twice (an SVG <text> AND a <span>), so the cell's textContent is doubled
        // ("7" -> "77"); read its span instead. Everywhere else the textContent is
        // the clean number.
        kenoButtonNumber(element) {
            if (this.getCurrentSite() === 'roobet') {
                const span = element.querySelector('span:not([type="checkbox"])');
                return parseInt((span?.textContent || '').trim(), 10);
            }
            return parseInt((element.textContent || element.innerText || '').trim(), 10);
        }

        animateSequentialSelection(numbers) {
            if (!numbers || numbers.length === 0) {
                console.warn("Vantedge: A strategy returned no numbers to select.");
                return;
            }

            const site = this.getCurrentSite();

            // Winna deselects per-button inside highlightWinnaNumbers. Routing it
            // through clearSelection() would click "Clear Table", and Vue applies
            // that on its own tick — potentially wiping the picks we just made.
            if (site === 'winna') {
                this.syncSelectionUI(numbers);
                this.highlightWinnaNumbers(numbers);
                return;
            }

            this.clearSelection();
            this.syncSelectionUI(numbers);

            const kenoButtons = this.findKenoNumbers();
            if (!kenoButtons || kenoButtons.length === 0) return;

            const delay = 30;

            // Firefox keeps CSS win-animations running on drawn numbers even after React
            // updates their "selected" state, causing a mixed green+border visual.
            // 250ms is enough for the draw animation to finish on all tested sites.
            const isFirefox = typeof InstallTrigger !== 'undefined' ||
                              navigator.userAgent.includes('Firefox');
            const startDelay = isFirefox ? 250 : 0;

            numbers.forEach((num, index) => {
                setTimeout(() => {
                    // Re-fetch button at click time in case DOM updated during startDelay
                    const freshButtons = startDelay > 0 ? this.findKenoNumbers() : kenoButtons;
                    const button = (freshButtons || kenoButtons).find(btn => this.kenoButtonNumber(btn) === num);
                    if (button) this.clickElement(button);
                }, startDelay + index * delay);
            });
        }

        // Toggle a single number's selection on the board (heatmap click-to-add).
        toggleNumberSelection(n) {
            safe(() => {
                const site = this.getCurrentSite();
                const cell = this.overlay.querySelector(`#overlay-keno-grid [data-number="${n}"]`);
                const wasSelected = cell ? cell.classList.contains('selected') : false;

                if (site === 'winna') {
                    // Track the set here; highlightWinnaNumbers tries to click the
                    // board and marks whatever the click couldn't select.
                    if (!this._winnaManual) this._winnaManual = new Set();
                    if (wasSelected) this._winnaManual.delete(n); else this._winnaManual.add(n);
                    if (cell) cell.classList.toggle('selected', !wasSelected);
                    this.highlightWinnaNumbers([...this._winnaManual]);
                    return;
                }

                const buttons = this.findKenoNumbers();
                const button = (buttons || []).find(b => this.kenoButtonNumber(b) === n);
                if (button) this.clickElement(button);
                // Optimistically reflect the toggle on the heatmap; the next bet's
                // syncSelectionUI will reconcile against true board state.
                if (cell) cell.classList.toggle('selected', !wasSelected);
            });
        }

        showQuickFeedback(numbers) {
            numbers.forEach((num, index) => {
                setTimeout(() => {
                    const heatmapNumber = this.overlay.querySelector(`[data-number="${num}"]`);
                    if (heatmapNumber) {
                        heatmapNumber.classList.add('selecting');
                        setTimeout(() => heatmapNumber.classList.remove('selecting'), 300);
                    }
                }, index * 50);
            });
        }

        // ================================================================
        // STRATEGY IMPLEMENTATIONS
        // ================================================================

        // --- Strategy: Hot ---
        getHotNumbers(count = 9) {
            return this.data.kenoStats.hotNumbers
                .map((o, i) => ({ n: i + 1, o }))
                .sort((a, b) => b.o - a.o)
                .slice(0, count)
                .map(x => x.n);
        }
        selectHotNumbers() {
            const numbers = this.getHotNumbers();
            this.animateSequentialSelection(numbers);
        }

        // --- Strategy: Cold ---
        getColdNumbers(count = 9) {
            return this.data.kenoStats.hotNumbers
                .map((o, i) => ({ n: i + 1, o }))
                .sort((a, b) => a.o - b.o)
                .slice(0, count)
                .map(x => x.n);
        }
        selectColdNumbers() {
            const numbers = this.getColdNumbers();
            this.animateSequentialSelection(numbers);
        }

        // --- Strategy: Random ---
        getRandomNumbers(count = 9) {
            const numbers = [];
            const available = Array.from({ length: this.numberCount }, (_, i) => i + 1);
            while (numbers.length < count && available.length > 0) {
                const randomIndex = Math.floor(Math.random() * available.length);
                numbers.push(available.splice(randomIndex, 1)[0]);
            }
            return numbers.sort((a, b) => a - b);
        }
        selectRandomNumbers() {
            const numbers = this.getRandomNumbers();
            this.animateSequentialSelection(numbers);
        }

        // --- Strategy: Smart ---
        getSmartNumbers(count = 9) {
            const sorted = this.data.kenoStats.hotNumbers.map((o, i) => ({ n: i + 1, o })).sort((a, b) => b.o - a.o);

            const hotCount = Math.ceil(count * 0.3);
            const mediumCount = Math.ceil(count * 0.4);
            const coldCount = count - hotCount - mediumCount;

            const top25Threshold = Math.floor(sorted.length * 0.25);
            const bottom25Start = Math.floor(sorted.length * 0.75);

            const hot = sorted.slice(0, top25Threshold).map(x => x.n);
            const medium = sorted.slice(top25Threshold, bottom25Start).map(x => x.n);
            const cold = sorted.slice(bottom25Start).map(x => x.n);

            const result = [
                ...this.sampleArray(hot, hotCount),
                ...this.sampleArray(medium, mediumCount),
                ...this.sampleArray(cold, coldCount)
            ];

            return result.slice(0, count);
        }

        // Helper: Random sample from array (Fisher-Yates, unbiased)
        sampleArray(arr, n) {
            if (arr.length <= n) return arr;
            const shuffled = [...arr];
            for (let i = shuffled.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
            }
            return shuffled.slice(0, n);
        }
        selectSmartNumbers() {
            const numbers = this.getSmartNumbers();
            this.animateSequentialSelection(numbers);
        }

        // --- Strategy: Variance ---
        getVarianceNumbers(externalCount = null) {
            const isLow = this.strategyToggles.variance;
            const count = externalCount ?? (isLow ? 5 : 9);
            if (this.data.kenoStats.totalBets < 20) return this.getHotNumbers(count);
            const useChi = this.data.kenoStats.totalBets < 50;
            const hot = this.data.kenoStats.hotNumbers;
            if (useChi) {
                const E = this.data.kenoStats.totalBets * 0.5;
                return hot.map((O, i) => ({ n: i + 1, s: Math.pow(O - E, 2) / E })).sort((a, b) => b.s - a.s).slice(0, count).map(x => x.n);
            } else {
                const expectedPerNum = this.data.kenoStats.totalBets * 0.5;
                const stdDev = Math.sqrt(expectedPerNum * 0.5);
                return hot.map((o, i) => ({ n: i + 1, s: (o - expectedPerNum) / stdDev })).sort((a, b) => b.s - a.s).slice(0, count).map(x => x.n);
            }
        }
        selectVarianceNumbers() {
            const numbers = this.getVarianceNumbers();
            this.animateSequentialSelection(numbers);
            const btn = this.overlay.querySelector('.action-btn-lg[data-action="variance"]');
            if (btn) {
                btn.classList.toggle('low-mode', !this.strategyToggles.variance);
            }
            this.strategyToggles.variance = !this.strategyToggles.variance;
            const browserAPI = (typeof browser !== 'undefined') ? browser : chrome;
            browserAPI.storage.local.set({ strategyToggles: this.strategyToggles });
        }

        // --- Strategy: Entropy ---
        getEntropyNumbers(count = 9) {
            if (this.data.kenoStats.totalBets < 20) return this.getHotNumbers(count);

            const stats = this.data.kenoStats.perNumberStats;

            // Use coefficient of variation (CV = stdDev / mean) — lower CV = more predictable interval
            const scored = stats
                .map((s, i) => ({
                    n: i + 1,
                    score: s.count > 2 && s.avgInterval > 0 && s.entropy > 0
                        ? (1 / (s.entropy / s.avgInterval)) * Math.log(s.count + 1)  // 1/CV weighted by appearances
                        : 0
                }))
                .filter(x => x.score > 0)
                .sort((a, b) => b.score - a.score);

            let selected = scored.slice(0, count).map(x => x.n);

            if (selected.length < count) {
                const fillers = this.getProgressiveNumbers(count * 2)
                    .filter(n => !selected.includes(n));
                selected.push(...fillers.slice(0, count - selected.length));
            }

            return selected.slice(0, count);
        }
        selectEntropyNumbers() {
            const numbers = this.getEntropyNumbers();
            this.animateSequentialSelection(numbers);
        }


        // --- Strategy: Transition (Cold-to-Hot Detection) ---
        getTransitionNumbers(count = 9) {
            if (this.data.kenoStats.totalBets < 20) return this.getHotNumbers(count);

            const stats = this.data.kenoStats.perNumberStats;

            return stats
                .map((s, i) => {
                    if (s.count < 3 || s.avgInterval <= 0) return { n: i + 1, score: 0 };
                    // Transition signal: decreasing betsSince (warming up) with decent count
                    // Score based on how much betsSince dropped relative to avgInterval
                    const transitionSignal = s.avgInterval - s.betsSince;
                    const reliability = Math.min(s.count / 10, 1);
                    return { n: i + 1, score: Math.max(0, transitionSignal) * reliability };
                })
                .filter(x => x.score > 0)
                .sort((a, b) => b.score - a.score)
                .slice(0, count)
                .map(x => x.n);
        }
        selectTransitionNumbers() {
            const numbers = this.getTransitionNumbers();
            this.animateSequentialSelection(numbers);
        }


        // --- Strategy: Volatility (Grid Variance Analysis) ---
        getVolatilityNumbers(count = 9) {
            if (this.data.kenoStats.totalBets < 30) return this.getHotNumbers(count);

            const stats = this.data.kenoStats.perNumberStats;
            const hot = this.data.kenoStats.hotNumbers;

            return stats
                .map((s, i) => {
                    if (s.count < 5 || s.entropy <= 0) return { n: i + 1, score: 0 };
                    // High entropy = inconsistent intervals = volatile number
                    // Boost by frequency to ensure we're not just picking noise
                    const volatilityScore = s.entropy * Math.log(s.count + 1);
                    return { n: i + 1, score: volatilityScore };
                })
                .filter(x => x.score > 0)
                .sort((a, b) => b.score - a.score)
                .slice(0, count)
                .map(x => x.n);
        }
        selectVolatilityNumbers() {
            const numbers = this.getVolatilityNumbers();
            this.animateSequentialSelection(numbers);
        }





        // --- Strategy: Overdue ---
        getOverdueNumbers(count = 9) {
            if (this.data.kenoStats.totalBets < 30) return this.getHotNumbers(count);

            const stats = this.data.kenoStats.perNumberStats;
            if (!stats || stats.length === 0) return this.getHotNumbers(count);

            const overdueNumbers = stats.map((s, i) => ({
                n: i + 1,
                betsSince: s.betsSince || 0,
                avgInterval: s.avgInterval || 1,
                count: s.count || 0,
                ratio: (s.avgInterval > 0 && s.count > 3) ? s.betsSince / s.avgInterval : 0
            }))
                .filter(x => x.ratio >= 1.5)
                .sort((a, b) => b.ratio - a.ratio);

            if (overdueNumbers.length >= count) {
                return overdueNumbers.slice(0, count).map(x => x.n);
            }

            const selected = overdueNumbers.map(x => x.n);
            const fillers = this.getHotNumbers(count * 2).filter(n => !selected.includes(n));
            return [...selected, ...fillers].slice(0, count);
        }
        selectOverdueNumbers() {
            const numbers = this.getOverdueNumbers();
            this.animateSequentialSelection(numbers);
        }

        // --- Strategy: Positional (Chi-Square Grid Analysis) ---
        getPositionalNumbers(count = 9) {
            if (this.data.kenoStats.totalBets < 30) return this.getSmartNumbers(count);

            const coords = {};
            for (let i = 0; i < this.numberCount; i++) coords[i + 1] = { r: Math.floor(i / 8), c: i % 8 };

            const hot = this.data.kenoStats.hotNumbers;
            const totalBets = this.data.kenoStats.totalBets;

            const rH = Array(5).fill(0);
            const cH = Array(8).fill(0);
            for (let n = 1; n <= this.numberCount; n++) {
                rH[coords[n].r] += hot[n - 1];
                cH[coords[n].c] += hot[n - 1];
            }

            const expectedHitsPerRow = totalBets * 4;
            const rowChiSquare = rH.reduce((sum, observed) => {
                return sum + Math.pow(observed - expectedHitsPerRow, 2) / expectedHitsPerRow;
            }, 0);

            const expectedHitsPerCol = totalBets * 2.5;
            const colChiSquare = cH.reduce((sum, observed) => {
                return sum + Math.pow(observed - expectedHitsPerCol, 2) / expectedHitsPerCol;
            }, 0);

            const rowBiasDetected = rowChiSquare > 9.488;   // df=4, p<0.05
            const colBiasDetected = colChiSquare > 14.067;  // df=7, p<0.05

            let rowWeight = 0.1;
            let colWeight = 0.1;

            if (rowBiasDetected && colBiasDetected) {
                rowWeight = 0.3;
                colWeight = 0.2;
            } else if (rowBiasDetected) {
                rowWeight = 0.4;
                colWeight = 0.1;
            } else if (colBiasDetected) {
                rowWeight = 0.1;
                colWeight = 0.4;
            }

            return Array.from({ length: this.numberCount }, (_, i) => i + 1)
                .map(n => ({
                    n,
                    s: (0.5 * hot[n - 1]) + (rowWeight * rH[coords[n].r]) + (colWeight * cH[coords[n].c])
                }))
                .sort((a, b) => b.s - a.s)
                .slice(0, count)
                .map(x => x.n);
        }
        selectPositionalNumbers() {
            const numbers = this.getPositionalNumbers();
            this.animateSequentialSelection(numbers);
        }

        // --- Strategy: Hotzone (2-D grid-block local density, chi-square gated) ---
        // Sibling of Positional. Positional tests row/column MARGINALS, so a bias
        // localized to a small 2-D region (a hot corner, the center) gets averaged
        // away across its whole row and column. Hotzone instead slides a 2×2 window
        // over the board and finds the single most over-represented block, then
        // boosts the numbers that sit inside hot zones. Same gating discipline:
        // weight scales with the block's significance and it falls back to Hot when
        // no zone is statistically real.
        getHotzoneNumbers(count = 9) {
            if (this.data.kenoStats.totalBets < 30) return this.getPositionalNumbers(count);

            const cols = this.gridCols;          // 8 in all known variants
            const rows = this.gridRows;          // 5 classic / 7 extreme
            const N = this.numberCount;
            const hot = this.data.kenoStats.hotNumbers;

            const totalHits = hot.reduce((a, b) => a + b, 0);
            if (totalHits <= 0) return this.getHotNumbers(count);

            const W = 2, H = 2;                  // 2×2 scan window
            const expectedBlock = (totalHits / N) * (W * H);
            const cellHit = (r, c) => {
                const i = r * cols + c;
                return (i >= 0 && i < N) ? hot[i] : 0;
            };

            // For each cell, remember the hit-count of the hottest 2×2 block it
            // belongs to; track the most extreme block deviation for the gate.
            const blockHits = new Float32Array(N);
            let bestBlockZ = 0;
            for (let r = 0; r + H <= rows; r++) {
                for (let c = 0; c + W <= cols; c++) {
                    let observed = 0;
                    for (let dr = 0; dr < H; dr++)
                        for (let dc = 0; dc < W; dc++)
                            observed += cellHit(r + dr, c + dc);
                    const z = (observed - expectedBlock) / Math.sqrt(expectedBlock || 1);
                    if (z > bestBlockZ) bestBlockZ = z;
                    for (let dr = 0; dr < H; dr++)
                        for (let dc = 0; dc < W; dc++) {
                            const i = (r + dr) * cols + (c + dc);
                            if (i >= 0 && i < N && observed > blockHits[i]) blockHits[i] = observed;
                        }
                }
            }

            // Significance gate. ~28 overlapping blocks are scanned (classic board),
            // so the threshold is stricter than Positional's single-test gate to
            // offset multiple comparisons. No significant zone → behave like Hot.
            let zoneWeight;
            if (bestBlockZ > 3.5) zoneWeight = 0.4;        // very strong local bias
            else if (bestBlockZ > 2.5) zoneWeight = 0.25;  // significant
            else return this.getHotNumbers(count);

            return Array.from({ length: N }, (_, i) => ({
                n: i + 1,
                s: 0.5 * hot[i] + zoneWeight * blockHits[i]
            }))
                .sort((a, b) => b.s - a.s)
                .slice(0, count)
                .map(x => x.n);
        }
        selectHotzoneNumbers() {
            const numbers = this.getHotzoneNumbers();
            this.animateSequentialSelection(numbers);
        }

        // --- Strategy: Anti-Pattern ---
        getAntiPatternNumbers(count = 9) {
            const totalBets = this.data.kenoStats.totalBets;
            if (totalBets < 20) return this.getColdNumbers(count);

            const recentNumbers = new Set();
            const stats = this.data.kenoStats.perNumberStats;

            stats.forEach((stat, i) => {
                if (stat.betsSince <= 3 && stat.count >= 3) {
                    recentNumbers.add(i + 1);
                }
            });

            if (this.correlationData) {
                [2, 3].forEach(size => {
                    const C = this.correlationData.correlations?.[size] || {};
                    const S = this.correlationData.betsSinceDrop?.[size] || {};
                    Object.entries(C).forEach(([combo, c]) => {
                        if ((S[combo] || 999) < 5 && c > 2) {
                            combo.split('-').forEach(n => recentNumbers.add(parseInt(n)));
                        }
                    });
                });
            }

            const antiNumbers = Array.from({ length: this.numberCount }, (_, i) => i + 1)
                .filter(n => !recentNumbers.has(n));

            if (antiNumbers.length >= count) {
                return antiNumbers
                    .map(n => ({ n, h: this.data.kenoStats.hotNumbers[n - 1] }))
                    .sort((a, b) => a.h - b.h)
                    .slice(0, count)
                    .map(x => x.n);
            }

            const selected = antiNumbers;
            const fillers = this.getColdNumbers(count * 2)
                .filter(n => !selected.includes(n));
            return [...selected, ...fillers].slice(0, count);
        }
        selectAntiPatternNumbers() {
            const numbers = this.getAntiPatternNumbers();
            this.animateSequentialSelection(numbers);
        }

        // --- Strategy: Progressive ---
        getProgressiveNumbers(count = 9) {
            if (this.data.kenoStats.totalBets < 10) return this.getHotNumbers(count);
            return this.data.kenoStats.perNumberStats
                .map((s, i) => ({ n: i + 1, s: s.count / Math.max(s.betsSince + 1, 2) }))
                .sort((a, b) => b.s - a.s)
                .slice(0, count)
                .map(x => x.n);
        }
        selectProgressiveNumbers() {
            const numbers = this.getProgressiveNumbers();
            this.animateSequentialSelection(numbers);
        }

        // --- Strategy: Poisson Deviation ---
        getPoissonNumbers(count = 9) {
            if (this.data.kenoStats.totalBets < 30) return this.getHotNumbers(count);

            const stats = this.data.kenoStats.perNumberStats;
            const totalBets = this.data.kenoStats.totalBets;

            const scored = stats.map((s, i) => {
                if (s.count < 3) return { n: i + 1, score: 0 };

                // λ = expected gap between appearances
                const lambda = totalBets / s.count;

                // Survival probability: P(gap >= betsSince) = 1 - PoissonCDF(betsSince-1, lambda)
                const survival = 1 - this.poissonCDF(Math.max(s.betsSince - 1, 0), lambda);

                // Weight by frequency reliability
                const reliability = Math.min(s.count / 20, 1);

                return { n: i + 1, score: survival * reliability };
            });

            const sorted = scored.filter(x => x.score > 0).sort((a, b) => b.score - a.score);
            let selected = sorted.slice(0, count).map(x => x.n);

            if (selected.length < count) {
                const fillers = this.getHotNumbers(count * 2).filter(n => !selected.includes(n));
                selected.push(...fillers.slice(0, count - selected.length));
            }
            return selected.slice(0, count);
        }
        selectTransitionNumbers() {
            const numbers = this.getTransitionNumbers();
            this.animateSequentialSelection(numbers);
        }


        // --- Strategy: Volatility (Grid Variance Analysis) ---
        getVolatilityNumbers(count = 9) {
            if (this.data.kenoStats.totalBets < 30) return this.getHotNumbers(count);

            const stats = this.data.kenoStats.perNumberStats;
            const hot = this.data.kenoStats.hotNumbers;

            return stats
                .map((s, i) => {
                    if (s.count < 5 || s.entropy <= 0) return { n: i + 1, score: 0 };
                    // High entropy = inconsistent intervals = volatile number
                    // Boost by frequency to ensure we're not just picking noise
                    const volatilityScore = s.entropy * Math.log(s.count + 1);
                    return { n: i + 1, score: volatilityScore };
                })
                .filter(x => x.score > 0)
                .sort((a, b) => b.score - a.score)
                .slice(0, count)
                .map(x => x.n);
        }
        selectVolatilityNumbers() {
            const numbers = this.getVolatilityNumbers();
            this.animateSequentialSelection(numbers);
        }

        // --- Strategy: Cohesion (NEW) ---
        getCohesionNumbers(count = 9) {
            if (this.data.kenoStats.totalBets < 30) return this.getSmartNumbers(count);
            const stats = this.data.kenoStats.perNumberStats;
            const hot = this.data.kenoStats.hotNumbers;

            // Find clusters of nearby hot numbers
            const candidates = [];
            for (let i = 0; i < this.numberCount; i++) {
                if (hot[i] < 2) continue;
                const neighbors = [i - 1, i, i + 1].filter(j => j >= 0 && j < this.numberCount);
                const neighborHeat = neighbors.reduce((sum, j) => sum + hot[j], 0);
                candidates.push({ n: i + 1, cohesion: neighborHeat, heat: hot[i] });
            }

            return candidates
                .sort((a, b) => b.cohesion - a.cohesion || b.heat - a.heat)
                .slice(0, count)
                .map(x => x.n)
                .sort((a, b) => a - b);
        }
        selectCohesionNumbers() {
            const numbers = this.getCohesionNumbers();
            this.animateSequentialSelection(numbers);
        }

        // --- Strategy: Edge (NEW) ---
        getEdgeNumbers(count = 9) {
            if (this.data.kenoStats.totalBets < 25) return this.getRandomNumbers(count);
            const hot = this.data.kenoStats.hotNumbers;

            // Focus on the boundary zones (edges) of the grid
            const N = this.numberCount;
            const corners = [1, 2, N - 1, N];  // actual corners
            const edges = Array.from({ length: this.numberCount }, (_, i) => i + 1).filter(n => {
                const row = Math.floor((n - 1) / 8);
                const col = (n - 1) % 8;
                return row === 0 || row === 4 || col === 0 || col === 7;  // top, bottom, left, right edges
            });

            const edgeScores = edges.map(n => ({ n, heat: hot[n - 1] }))
                .sort((a, b) => b.heat - a.heat)
                .slice(0, count);

            return edgeScores.map(x => x.n).sort((a, b) => a - b);
        }
        selectEdgeNumbers() {
            const numbers = this.getEdgeNumbers();
            this.animateSequentialSelection(numbers);
        }

        // --- Strategy: Streak ---
        getStreakNumbers(count = 9) {
            if (this.data.kenoStats.totalBets < 15) return this.getHotNumbers(count);

            const stats = this.data.kenoStats.perNumberStats;
            const streaks = [];

            for (let i = 0; i < this.numberCount; i++) {
                const stat = stats[i];
                if (!stat || stat.lastOccurrences.length < 2) continue;

                let streakCount = 1;
                const intervals = [...stat.lastOccurrences.slice(-5)].reverse();

                for (const interval of intervals) {
                    if (interval <= 2) {
                        streakCount++;
                    } else {
                        break;
                    }
                }

                if (streakCount >= 2) {
                    streaks.push({
                        num: i + 1,
                        streakCount,
                        recentness: stat.betsSince,
                        heat: stat.count
                    });
                }
            }

            streaks.sort((a, b) =>
                b.streakCount - a.streakCount ||
                a.recentness - b.recentness ||
                b.heat - a.heat
            );

            let selected = streaks.slice(0, count).map(s => s.num);

            if (selected.length < count) {
                const fillers = this.getHotNumbers(count * 2)
                    .filter(n => !selected.includes(n));
                selected.push(...fillers.slice(0, count - selected.length));
            }

            return selected.slice(0, count);
        }
        selectStreakNumbers() {
            const numbers = this.getStreakNumbers();
            this.animateSequentialSelection(numbers);
        }

        selectVolatilityNumbers() {
            const numbers = this.getVolatilityNumbers();
            this.animateSequentialSelection(numbers);
        }


        // --- Strategy: EMA Hot ---
        getEMANumbers(count = 9) {
            const siteKey = `${this.storageOrigin}-keno-session`;
            const results = this.cachedKenoResults?.[siteKey] || [];
            if (results.length < 10) return this.getHotNumbers(count);

            // Dynamic alpha: measure recent volatility (std dev of draw-set sizes over last 20 games)
            // High volatility → higher alpha (react faster), low volatility → lower alpha (smoother)
            const recentWindow = results.slice(-20);
            const sizes = recentWindow.map(r => r?.state?.drawnNumbers?.length || 0);
            const meanSize = sizes.reduce((a, b) => a + b, 0) / sizes.length;
            const variance = sizes.reduce((a, b) => a + Math.pow(b - meanSize, 2), 0) / sizes.length;
            const volatility = Math.sqrt(variance) / (meanSize || 1);
            const alpha = Math.min(0.30, Math.max(0.15, 0.20 + volatility * 0.5));

            // Process oldest → newest so recent games carry the highest weight
            const ema = new Array(this.numberCount).fill(0);
            for (let i = 0; i < results.length; i++) {
                const drawn = results[i]?.state?.drawnNumbers;
                if (!drawn) continue;
                const drawnSet = new Set(drawn);
                for (let n = 0; n < this.numberCount; n++) {
                    ema[n] = alpha * (drawnSet.has(n + 1) ? 1 : 0) + (1 - alpha) * ema[n];
                }
            }

            return ema
                .map((score, i) => ({ n: i + 1, score }))
                .sort((a, b) => b.score - a.score)
                .slice(0, count)
                .map(x => x.n);
        }
        selectEMANumbers() {
            const numbers = this.getEMANumbers();
            this.animateSequentialSelection(numbers);
        }

        // --- Strategy: Digit Bias (Last-Digit Chi-Square) ---
        getDigitBiasNumbers(count = 9) {
            if (this.data.kenoStats.totalBets < 30) return this.getHotNumbers(count);

            const hot = this.data.kenoStats.hotNumbers;
            const totalBets = this.data.kenoStats.totalBets;

            // digit 0 → {10,20,30,40}, digit 1 → {1,11,21,31}, etc.
            const digitTotals = new Array(10).fill(0);
            for (let i = 0; i < this.numberCount; i++) {
                digitTotals[(i + 1) % 10] += hot[i];
            }

            // Expected: 4 numbers/digit × (20/40 draw rate) × totalBets = 2 × totalBets
            const expectedPerDigit = totalBets * 2;

            // Chi-square gate (df=9, p<0.05 = 16.919)
            const chiSquare = digitTotals.reduce((sum, obs) =>
                sum + Math.pow(obs - expectedPerDigit, 2) / expectedPerDigit, 0);

            if (chiSquare < 16.919) {
                return this.getHotNumbers(count);
            }

            // Signed z-score per digit
            const digitBias = digitTotals.map((obs, d) => ({
                d,
                zscore: (obs - expectedPerDigit) / Math.max(Math.sqrt(expectedPerDigit), 1)
            }));

            return Array.from({ length: this.numberCount }, (_, i) => {
                const digit = (i + 1) % 10;
                const z = digitBias[digit].zscore;
                const boost = 1 + Math.min(Math.max(z * 0.15, -0.4), 0.4);
                return { n: i + 1, score: (hot[i] + 1) * boost };
            })
                .sort((a, b) => b.score - a.score)
                .slice(0, count)
                .map(x => x.n);
        }
        selectDigitBiasNumbers() {
            const numbers = this.getDigitBiasNumbers();
            this.animateSequentialSelection(numbers);
        }

        // --- Strategy: Parity Bias ---
        getParityNumbers(count = 9) {
            const hot = this.data.kenoStats.hotNumbers;
            const total = hot.reduce((s, v) => s + v, 0);
            if (total < 5) return this.getHotNumbers(count);

            // Which parity (even / odd) has been drawn more?
            let evenTotal = 0, oddTotal = 0;
            for (let i = 0; i < this.numberCount; i++) {
                if ((i + 1) % 2 === 0) evenTotal += hot[i];
                else oddTotal += hot[i];
            }
            const favorEven = evenTotal >= oddTotal;

            // Split numbers into favored and other parity, ranked by hot count within each group
            const favored = [], other = [];
            for (let i = 0; i < this.numberCount; i++) {
                const n = i + 1;
                ((n % 2 === 0) === favorEven ? favored : other).push({ n, score: hot[i] });
            }
            favored.sort((a, b) => b.score - a.score);
            other.sort((a, b) => b.score - a.score);

            // 70 % from the favored parity group, 30 % filler from the other
            // This always produces a distinctly different set from plain Hot
            const nFavored = Math.ceil(count * 0.70); // 7 of 9 (or 6 if count=8)
            const nOther   = count - nFavored;

            return [
                ...favored.slice(0, nFavored),
                ...other.slice(0, nOther)
            ].map(x => x.n);
        }
        selectParityNumbers() {
            const numbers = this.getParityNumbers();
            this.animateSequentialSelection(numbers);
        }

        // --- Strategy: Poisson CDF helper ---
        poissonCDF(k, lambda) {
            let s = 0,
                t = Math.exp(-lambda);
            for (let i = 0; i <= k; i++) {
                s += t;
                t *= lambda / (i + 1);
                if (t < 1e-9 && i > lambda) break;
            }
            return s;
        }

        // =====================================================================
        // RESTORED STRATEGIES (recovered from git history)
        // =====================================================================

        // --- Strategy: Bayesian (Dynamic Posterior Scoring) ---
        getBayesianNumbers(count = 9) {
            if (this.data.kenoStats.totalBets < 30) return this.getHotNumbers(count);
            if (!this.cachedBayesian || (Date.now() - this.lastBayesianCache) > this.CACHE_DURATION) {
                this.cachedBayesian = this.data.kenoStats.perNumberStats.map((s, i) => {
                    if (s.count < 3) return { n: i + 1, s: 0 };
                    const avgI = s.avgInterval || (this.data.kenoStats.totalBets / s.count);
                    const prior = 0.5 * Math.min(2.5, Math.max(1, s.betsSince / avgI));
                    const freqL = s.count / this.data.kenoStats.totalBets;
                    const recencyB = Math.exp(-s.betsSince / avgI);
                    const evidence = (s.count + 1) / (this.data.kenoStats.totalBets + 2);
                    const predictability = Math.max(0.1, 1 - ((s.entropy || 0) / Math.sqrt(this.data.kenoStats.totalBets)));
                    const posterior = (freqL * recencyB * prior) / evidence;
                    return { n: i + 1, s: posterior * predictability };
                });
                this.lastBayesianCache = Date.now();
            }
            return [...this.cachedBayesian].sort((a, b) => b.s - a.s).slice(0, count).map(x => x.n);
        }
        selectBayesianNumbers() {
            const numbers = this.getBayesianNumbers();
            this.animateSequentialSelection(numbers);
        }

        // --- Strategy: Monte Carlo (Weighted Simulation) ---
        getMonteCarloNumbers(count = 9) {
            if (this.data.kenoStats.totalBets < 20) return this.getHotNumbers(count);
            const maxSims = 200;
            const scores = new Array(this.numberCount).fill(0);
            const weights = this.data.kenoStats.hotNumbers.map(n => n + 1);
            let prevScores = new Array(this.numberCount).fill(0);
            for (let s = 0; s < maxSims; s++) {
                const draw = new Set();
                while (draw.size < 10) {
                    let totalW = 0;
                    const available = [];
                    for (let i = 0; i < this.numberCount; i++) {
                        if (!draw.has(i + 1)) { totalW += weights[i]; available.push({ n: i + 1, w: totalW }); }
                    }
                    const rand = Math.random() * totalW;
                    const sel = available.find(x => x.w >= rand);
                    if (sel) draw.add(sel.n);
                }
                draw.forEach(n => scores[n - 1]++);
                if (s % 50 === 0 && s > 100) {
                    const variance = scores.reduce((sum, v, i) => sum + Math.abs(v - prevScores[i]), 0) / this.numberCount;
                    if (variance < 0.5) break;
                    prevScores = [...scores];
                }
            }
            return scores.map((s, n) => ({ n: n + 1, s })).sort((a, b) => b.s - a.s).slice(0, count).map(x => x.n);
        }
        selectMonteCarloNumbers() {
            const numbers = this.getMonteCarloNumbers();
            this.animateSequentialSelection(numbers);
        }

        // --- Strategy: Coverage (Hot + Maximum Spread) ---
        getCoverageNumbers(count = 9) {
            if (this.data.kenoStats.totalBets < 20) return this.getSmartNumbers(count);
            const candidates = this.data.kenoStats.hotNumbers
                .map((o, i) => ({ n: i + 1, heat: o }))
                .sort((a, b) => b.heat - a.heat)
                .slice(0, count * 2);
            const selected = [candidates.shift().n];
            while (selected.length < count && candidates.length > 0) {
                candidates.sort((a, b) => {
                    const minDistA = Math.min(...selected.map(s => Math.abs(s - a.n)));
                    const minDistB = Math.min(...selected.map(s => Math.abs(s - b.n)));
                    return (minDistB * b.heat) - (minDistA * a.heat);
                });
                selected.push(candidates.shift().n);
            }
            return selected;
        }
        selectCoverageNumbers() {
            const numbers = this.getCoverageNumbers();
            this.animateSequentialSelection(numbers);
        }

        // --- Strategy: Wheeling (Correlation-Based Way Tickets) ---
        getWheelingNumbers(count = 9) {
            if (!this.correlationData || this.data.kenoStats.totalBets < 20) return this.getHotNumbers(count);
            const pairEntries = Object.entries(this.correlationData.correlations?.[2] || {})
                .filter(([, c]) => c > 2).sort(([, a], [, b]) => b - a);
            if (pairEntries.length === 0) return this.getHotNumbers(count);
            const groupSize = Math.ceil(count / 3);
            const groups = pairEntries.slice(0, 3).map(([pair]) => pair.split('-').map(Number));
            const selected = [];
            groups.forEach(group => {
                selected.push(...group);
                while (group.length < groupSize && selected.length < count) {
                    const best = this._findMostCorrelatedNumber(group, selected);
                    if (best) { group.push(best); selected.push(best); } else break;
                }
            });
            let unique = [...new Set(selected)];
            if (unique.length < count) {
                const fillers = this.getOverdueNumbers(count * 2).filter(n => !unique.includes(n));
                unique.push(...fillers.slice(0, count - unique.length));
            }
            return unique.slice(0, count);
        }
        _findMostCorrelatedNumber(group, alreadySelected) {
            const correlations = this.correlationData?.correlations?.[2] || {};
            let bestNum = null, bestScore = 0;
            for (let candidate = 1; candidate <= this.numberCount; candidate++) {
                if (alreadySelected.includes(candidate)) continue;
                let score = 0;
                for (const g of group) {
                    score += (correlations[`${g}-${candidate}`] || 0) + (correlations[`${candidate}-${g}`] || 0);
                }
                if (score > bestScore) { bestScore = score; bestNum = candidate; }
            }
            return bestNum;
        }
        selectWheelingNumbers() {
            const numbers = this.getWheelingNumbers();
            this.animateSequentialSelection(numbers);
        }

        // --- Strategy: Time-Series Forecast (EMA on Intervals) ---
        getTimeSeriesNumbers(count = 9) {
            if (this.data.kenoStats.totalBets < 30) return this.getOverdueNumbers(count);
            const alpha = 0.3;
            const forecasts = this.data.kenoStats.perNumberStats.map((s, i) => {
                if (s.count < 3) return { n: i + 1, forecast: s.betsSince / Math.max(s.avgInterval, 1) };
                // Build intervals from lastOccurrences
                const occ = [...s.lastOccurrences].sort((a, b) => a - b);
                const intervals = [];
                for (let j = 1; j < occ.length; j++) intervals.push(occ[j] - occ[j - 1]);
                if (intervals.length < 2) return { n: i + 1, forecast: s.betsSince / Math.max(s.avgInterval, 1) };
                let ema = intervals[0];
                for (let j = 1; j < intervals.length; j++) ema = alpha * intervals[j] + (1 - alpha) * ema;
                return { n: i + 1, forecast: ema - s.betsSince };
            });
            return forecasts.sort((a, b) => a.forecast - b.forecast).slice(0, count).map(f => f.n);
        }
        selectTimeSeriesNumbers() {
            const numbers = this.getTimeSeriesNumbers();
            this.animateSequentialSelection(numbers);
        }

        // --- Strategy: Balanced Distribution (Zone Coverage) ---
        getBalancedNumbers(count = 9) {
            if (this.data.kenoStats.totalBets < 10) return this.getSmartNumbers(count);
            const hot = this.data.kenoStats.hotNumbers;
            // Divide the pool into 4 equal zones (e.g. 0–10, 10–20, …, 30–40 for classic;
            // 0–14, 14–28, 28–42, 42–56 for extreme).
            const _step = this.numberCount / 4;
            const zones = [
                { s: 0,         e: _step },
                { s: _step,     e: _step * 2 },
                { s: _step * 2, e: _step * 3 },
                { s: _step * 3, e: this.numberCount }
            ];
            const perZone = Math.ceil(count / zones.length);
            const selected = [];
            const avg = this.data.kenoStats.totalBets / this.numberCount;
            zones.forEach(({ s, e }) => {
                const nums = Array.from({ length: e - s }, (_, i) => ({ n: s + i + 1, hits: hot[s + i] }))
                    .sort((a, b) => Math.abs(a.hits - avg) - Math.abs(b.hits - avg));
                selected.push(...nums.slice(0, perZone).map(n => n.n));
            });
            return selected.slice(0, count);
        }
        selectBalancedNumbers() {
            const numbers = this.getBalancedNumbers();
            this.animateSequentialSelection(numbers);
        }

        // --- Strategy: Momentum (Recent Acceleration) ---
        getMomentumNumbers(count = 9) {
            const totalBets = this.data.kenoStats.totalBets;
            if (totalBets < 20) return this.getHotNumbers(count);
            const w = Math.min(15, Math.floor(totalBets * 0.15));
            return this.data.kenoStats.perNumberStats.map((s, i) => {
                const recent = s.lastOccurrences.filter(g => g >= totalBets - w).length;
                const recentRate = recent / w;
                const histRate = s.count / totalBets;
                return { n: i + 1, score: recentRate + (recentRate - histRate) * 2 };
            }).sort((a, b) => b.score - a.score).slice(0, count).map(x => x.n);
        }
        selectMomentumNumbers() {
            const numbers = this.getMomentumNumbers();
            this.animateSequentialSelection(numbers);
        }

        // --- Strategy: Poisson (select wrapper — get* already in HEAD) ---
        selectPoissonNumbers() {
            const numbers = this.getPoissonNumbers();
            this.animateSequentialSelection(numbers);
        }

        // =====================================================================
        // END RESTORED STRATEGIES
        // =====================================================================

        // --- Strategy: Adaptive (Session Meta-Strategy, replaces Kelly) ---
        // Blends AI-recommended strategies, weighted by session performance + legend hit data
        getAdaptiveNumbers(count = 9) {
            if (this.data.kenoStats.totalBets < 20) return this.getSmartNumbers(count);

            const strategyMap = {
                hot: (c) => this.getHotNumbers(c),
                cold: (c) => this.getColdNumbers(c),
                smart: (c) => this.getSmartNumbers(c),
                overdue: (c) => this.getOverdueNumbers(c),
                variance: (c) => this.getVarianceNumbers(c),
                positional: (c) => this.getPositionalNumbers(c),
                hotzone: (c) => this.getHotzoneNumbers(c),
                progressive: (c) => this.getProgressiveNumbers(c),
                transition: (c) => this.getTransitionNumbers(c),
                entropy: (c) => this.getEntropyNumbers(c),
                streak: (c) => this.getStreakNumbers(c),
                ema: (c) => this.getEMANumbers(c),
                volatility: (c) => this.getVolatilityNumbers(c),
                digitbias: (c) => this.getDigitBiasNumbers(c),
                parity: (c) => this.getParityNumbers(c),
                antipattern: (c) => this.getAntiPatternNumbers(c),
                regime: (c) => this.getRegimeNumbers(c)
            };

            // Diverse complement pairs — primary drives, secondary diversifies
            const complements = {
                hot: ['overdue', 'positional'],
                cold: ['streak', 'entropy'],
                overdue: ['hot', 'ema'],
                ema: ['positional', 'overdue'],
                streak: ['cold', 'transition'],
                positional: ['ema', 'overdue'],
                hotzone: ['positional', 'ema'],
                progressive: ['streak', 'hot'],
                poisson: ['positional', 'cold'],
                entropy: ['ema', 'positional'],
                variance: ['overdue', 'cold'],
                antipattern: ['cold', 'overdue'],
                smart: ['positional', 'ema'],
                regime: ['hot', 'overdue'],
                digitbias: ['hot', 'positional'],
                parity: ['digitbias', 'hot']
            };

            // Build legend-based strategy bias: strategies with more big hits get a weight bonus
            const siteKey = `${this.storageOrigin}-keno-session`;
            const legendHits = this.data.legendStats?.[siteKey]?.hitsByStrategy || {};
            const totalLegendHits = Object.values(legendHits).reduce((a, b) => a + b, 0) || 1;
            const legendBonus = (id) => 1 + (legendHits[id] || 0) / totalLegendHits;

            const rec = this._lastAIRecommendation;
            let topStrategies = [];

            if (rec && rec.strategy && strategyMap[rec.strategy]) {
                const primary = rec.strategy;
                const [sec1, sec2] = complements[primary] || ['positional', 'ema'];
                const totalBets = this.data.kenoStats.totalBets;

                // Use 3-way blend once we have enough data for secondaries to be meaningful
                if (totalBets >= 50) {
                    topStrategies = [
                        { id: primary, weight: 3 * legendBonus(primary) },
                        { id: sec1, weight: 1.5 * legendBonus(sec1) },
                        { id: sec2, weight: 1 * legendBonus(sec2) }
                    ];
                } else {
                    topStrategies = [
                        { id: primary, weight: 2 * legendBonus(primary) },
                        { id: sec1, weight: 1 * legendBonus(sec1) }
                    ];
                }
            } else {
                // No AI recommendation yet — use legend stats to pick best known performers
                const ranked = Object.entries(legendHits).sort((a, b) => b[1] - a[1]);
                const best = ranked[0]?.[0];
                if (best && strategyMap[best]) {
                    const [sec1] = complements[best] || ['positional'];
                    topStrategies = [
                        { id: best, weight: 2 * legendBonus(best) },
                        { id: sec1, weight: 1 }
                    ];
                } else {
                    topStrategies = [
                        { id: 'hot', weight: 2 },
                        { id: 'positional', weight: 1 }
                    ];
                }
            }

            const votes = new Float32Array(this.numberCount + 1);
            topStrategies.forEach(({ id, weight }) => {
                const fn = strategyMap[id];
                if (!fn) return;
                try { fn(12).forEach(n => { votes[n] += weight; }); } catch (e) { /* skip */ }
            });

            return Array.from({ length: this.numberCount }, (_, i) => ({
                n: i + 1,
                v: votes[i + 1],
                h: this.data.kenoStats.hotNumbers[i] || 0
            }))
                .sort((a, b) => b.v - a.v || b.h - a.h)
                .slice(0, count)
                .map(x => x.n);
        }
        selectAdaptiveNumbers() {
            const numbers = this.getAdaptiveNumbers();
            this.animateSequentialSelection(numbers);
        }

        // Internal: returns { numbers, regime, blend }
        _detectRegime(count = 9) {
            return this.trackPerformance('regime', () => {
                const siteKey = `${this.storageOrigin}-keno-session`;
                const results = this.cachedKenoResults?.[siteKey] || [];
                if (results.length < 40) {
                    return { numbers: this.getSmartNumbers(count), regime: 'insufficient', blend: 'Smart (need 40+ games)' };
                }

                const hot = this.data.kenoStats.hotNumbers;
                const lookback = Math.min(results.length, 100);
                const windowSize = 10;
                const hitRates = [];

                for (let i = results.length - 1; i >= results.length - lookback; i--) {
                    const drawn = results[i]?.state?.drawnNumbers;
                    if (!drawn || drawn.length === 0) continue;
                    let avgFreq = 0;
                    for (let j = 0; j < drawn.length; j++) {
                        avgFreq += hot[drawn[j] - 1] || 0;
                    }
                    hitRates.push(avgFreq / drawn.length);
                }

                if (hitRates.length < windowSize * 2) {
                    return { numbers: this.getSmartNumbers(count), regime: 'insufficient', blend: 'Smart (need more data)' };
                }

                const globalMean = hitRates.reduce((a, b) => a + b, 0) / hitRates.length;
                const k = 0.5;
                const sigma = Math.sqrt(hitRates.reduce((a, b) => a + Math.pow(b - globalMean, 2), 0) / hitRates.length) || 1;
                // 3σ threshold — more responsive than 4σ, still avoids noise
                const threshold = 3 * sigma;

                let sPlus = 0, sMinus = 0, maxSPlus = 0, maxSMinus = 0;
                const recent = hitRates.slice(0, windowSize);
                for (const x of recent) {
                    sPlus = Math.max(0, sPlus + (x - globalMean) - k * sigma);
                    sMinus = Math.max(0, sMinus + (globalMean - x) - k * sigma);
                    maxSPlus = Math.max(maxSPlus, sPlus);
                    maxSMinus = Math.max(maxSMinus, sMinus);
                }

                const hotRegime = maxSPlus > threshold;
                const coldRegime = maxSMinus > threshold;

                // Transitional / neutral: both signals active simultaneously = regime flip in progress
                if (hotRegime && coldRegime) {
                    const votes = new Float32Array(this.numberCount + 1);
                    this.getEntropyNumbers(12).forEach(n => { votes[n] += 2; });
                    this.getPositionalNumbers(12).forEach(n => { votes[n] += 2; });
                    this.getEMANumbers(12).forEach(n => { votes[n] += 1; });
                    const numbers = Array.from({ length: this.numberCount }, (_, i) => ({ n: i + 1, v: votes[i + 1] }))
                        .sort((a, b) => b.v - a.v).slice(0, count).map(x => x.n);
                    return { numbers, regime: 'transitional', blend: 'Entropy × Positional × EMA' };
                }

                if (!hotRegime && !coldRegime) {
                    // Neutral: no clear directional bias — blend EMA + Positional instead of plain Smart
                    const votes = new Float32Array(this.numberCount + 1);
                    this.getEMANumbers(12).forEach(n => { votes[n] += 2; });
                    this.getPositionalNumbers(12).forEach(n => { votes[n] += 2; });
                    this.getSmartNumbers(12).forEach(n => { votes[n] += 1; });
                    const numbers = Array.from({ length: this.numberCount }, (_, i) => ({ n: i + 1, v: votes[i + 1] }))
                        .sort((a, b) => b.v - a.v).slice(0, count).map(x => x.n);
                    return { numbers, regime: 'neutral', blend: 'EMA × Positional × Smart' };
                }

                if (hotRegime) {
                    const votes = new Float32Array(this.numberCount + 1);
                    this.getHotNumbers(12).forEach(n => { votes[n] += 3; });
                    this.getEMANumbers(12).forEach(n => { votes[n] += 2; });
                    this.getStreakNumbers(12).forEach(n => { votes[n] += 1; });
                    const numbers = Array.from({ length: this.numberCount }, (_, i) => ({ n: i + 1, v: votes[i + 1] }))
                        .sort((a, b) => b.v - a.v).slice(0, count).map(x => x.n);
                    return { numbers, regime: 'hot', blend: 'Hot × EMA × Streak' };
                }

                // Cold regime
                const votes = new Float32Array(this.numberCount + 1);
                this.getColdNumbers(12).forEach(n => { votes[n] += 3; });
                this.getOverdueNumbers(12).forEach(n => { votes[n] += 2; });
                this.getPoissonNumbers(12).forEach(n => { votes[n] += 1; });
                const numbers = Array.from({ length: this.numberCount }, (_, i) => ({ n: i + 1, v: votes[i + 1] }))
                    .sort((a, b) => b.v - a.v).slice(0, count).map(x => x.n);
                return { numbers, regime: 'cold', blend: 'Cold × Overdue × Poisson' };
            });
        }

        getRegimeNumbers(count = 9) {
            return this._detectRegime(count).numbers;
        }

        _applyRegimeColor(regime, blend) {
            const btn = this.overlay.querySelector('#overlay-select-regime .action-btn-lg');
            const lbl = this.overlay.querySelector('#overlay-select-regime .action-label');
            if (!btn || !lbl) return;

            // Clear previous regime classes
            btn.classList.remove('regime-hot', 'regime-cold', 'regime-neutral');
            lbl.classList.remove('regime-hot', 'regime-cold', 'regime-neutral');

            const map = {
                hot: { btnCls: 'regime-hot', lblCls: 'regime-hot', icon: '🔥', text: 'Hot' },
                cold: { btnCls: 'regime-cold', lblCls: 'regime-cold', icon: '🧊', text: 'Cold' },
                neutral: { btnCls: 'regime-neutral', lblCls: '', icon: '⚖️', text: 'Neutral' },
                transitional: { btnCls: 'regime-neutral', lblCls: '', icon: '🔄', text: 'Shift' },
                insufficient: { btnCls: 'regime-neutral', lblCls: '', icon: '📊', text: 'Regime' }
            };
            const { btnCls, lblCls, icon, text } = map[regime] || map.neutral;

            if (btnCls) btn.classList.add(btnCls);
            if (lblCls) lbl.classList.add(lblCls);

            // Update button icon and label to show detected regime
            btn.textContent = icon;
            lbl.textContent = text;
            btn.title = `Regime: ${regime.toUpperCase()}\n→ ${blend}`;

            // Reset icon/label when a different strategy is clicked
            // by hooking into the next setActiveButton call
            this._regimeResetOnNext = true;
        }

        selectRegimeNumbers() {
            const { numbers, regime, blend } = this._detectRegime();
            this.animateSequentialSelection(numbers);
            this._applyRegimeColor(regime, blend);
        }

        // TAG: NEW-STRATEGY-GAP-EXTREMES
        getGapExtremesNumbers(count = 9) {
            if (this.data.kenoStats.totalBets < 25) return this.getOverdueNumbers(count);

            const stats = this.data.kenoStats.perNumberStats;
            const totalBets = this.data.kenoStats.totalBets;

            const scored = stats.map((s, i) => {
                if (s.count < 3 || s.avgInterval <= 0) return { n: i + 1, score: 0 };

                const expectedGap = s.avgInterval;
                const zScore = (s.betsSince - expectedGap) / Math.max(s.entropy || (expectedGap * 0.6), 1);

                // Bonus for numbers that are both extreme and reasonably frequent
                const reliability = Math.min(s.count / 15, 1.0);
                return { n: i + 1, score: zScore * reliability };
            });

            let selected = scored
                .filter(x => x.score > 0.3)
                .sort((a, b) => b.score - a.score)
                .slice(0, count)
                .map(x => x.n);

            if (selected.length < count) {
                const fillers = this.getEMANumbers(count * 2).filter(n => !selected.includes(n));
                selected.push(...fillers.slice(0, count - selected.length));
            }

            return selected.slice(0, count);
        }

        selectGapExtremesNumbers() {
            const numbers = this.getGapExtremesNumbers();
            this.animateSequentialSelection(numbers);
        }

        // TAG: NEW-STRATEGY-COHESION
        getCohesionNumbers(count = 9) {
            const siteKey = `${this.storageOrigin}-keno-session`;
            const results = this.cachedKenoResults?.[siteKey] || [];
            if (results.length < 30) return this.getHotNumbers(count);

            const lookback = Math.min(results.length, 120);
            const recent = results.slice(-lookback);

            const hotNumbers = this.getHotNumbers(12); // Current leaders
            const hotSet = new Set(hotNumbers);

            const coScore = new Float32Array(this.numberCount);

            for (const bet of recent) {
                const drawn = bet?.state?.drawnNumbers || [];
                const drawnSet = new Set(drawn);

                for (const h of hotNumbers) {
                    const hi = h - 1;
                    if (drawnSet.has(h)) {
                        for (const n of drawn) {
                            if (n !== h) {
                                coScore[n - 1] += 1.0;
                            }
                        }
                    }
                }
            }

            const scored = Array.from({ length: this.numberCount }, (_, i) => ({
                n: i + 1,
                score: coScore[i] * (this.data.kenoStats.hotNumbers[i] + 1)
            })).sort((a, b) => b.score - a.score);

            return scored.slice(0, count).map(x => x.n);
        }

        selectCohesionNumbers() {
            const numbers = this.getCohesionNumbers();
            this.animateSequentialSelection(numbers);
        }

        // TAG: NEW-STRATEGY-EDGE
        getEdgeNumbers(count = 9) {
            // Fallback if no performance data
            if (!this._lastAIRecommendation && this.data.kenoStats.totalBets < 40) {
                return this.getAdaptiveNumbers(count);
            }

            const votes = new Float32Array(this.numberCount + 1);
            const strategies = ['ema', 'positional', 'hot', 'gapextremes', 'cohesion'];

            strategies.forEach(strat => {
                const weight = 2.0; // Can be enhanced with real performance tracking later
                try {
                    let nums = [];
                    switch (strat) {
                        case 'ema': nums = this.getEMANumbers(12); break;
                        case 'positional': nums = this.getPositionalNumbers(12); break;
                        case 'hot': nums = this.getHotNumbers(12); break;
                        case 'gapextremes': nums = this.getGapExtremesNumbers(12); break;
                        case 'cohesion': nums = this.getCohesionNumbers(12); break;
                    }
                    nums.forEach(n => votes[n] += weight);
                } catch (e) { }
            });

            return Array.from({ length: this.numberCount }, (_, i) => ({
                n: i + 1,
                v: votes[i + 1],
                h: this.data.kenoStats.hotNumbers[i]
            }))
                .sort((a, b) => b.v - a.v || b.h - a.h)
                .slice(0, count)
                .map(x => x.n);
        }

        selectEdgeNumbers() {
            const numbers = this.getEdgeNumbers();
            this.animateSequentialSelection(numbers);
        }

        // ==========================================================================
        // TAG: USER-PASTED-STRATEGIES (added 2026-05-13)
        // Delta, Regression, PoissonGap, Portfolio, ComboWays, CondBonus
        // Fallbacks swapped from getPredictedNumbers → getHotNumbers (not implemented yet).
        // ==========================================================================

        getDeltaPatternNumbers(count = 9) {
            const siteKey = `${window.location.origin}-keno-session`;
            const results = (this.cachedKenoResults?.[siteKey] || []).slice(0, 50);
            if (results.length < 30) return this.getHotNumbers(count);
            const deltas = [];
            results.forEach(g => {
                if (g?.state?.drawnNumbers?.length >= 4) {
                    const sorted = g.state.drawnNumbers.map(Number).sort((a, b) => a - b);
                    const d = [];
                    for (let i = 1; i < sorted.length; i++) { d.push(sorted[i] - sorted[i - 1]); }
                    deltas.push(d);
                }
            });
            const freq = {};
            deltas.forEach(p => { const k = p.join('-'); freq[k] = (freq[k] || 0) + 1; });
            const top = Object.entries(freq).sort((a, b) => b[1] - a[1])[0];
            if (!top) return this.getHotNumbers(count);
            const bestDeltas = top[0].split('-').map(Number);
            const startNum = this.getHotNumbers(3)[0];
            const selected = [startNum];
            let curr = startNum;
            for (let i = 0; i < bestDeltas.length && selected.length < count; i++) {
                curr += bestDeltas[i];
                if (curr > this.numberCount) curr -= this.numberCount;
                if (!selected.includes(curr)) selected.push(curr);
            }
            return selected;
        }
        selectDeltaPatternNumbers() {
            const numbers = this.getDeltaPatternNumbers();
            this.animateSequentialSelection(numbers);
        }

        getRegressionNumbers(count = 8) {
            if (this.data.kenoStats.totalBets < 40) return this.getHotNumbers(count);

            if (!this.cachedRegression || (Date.now() - this.lastRegressionCache) > this.CACHE_DURATION) {
                this.cachedRegression = this.data.kenoStats.perNumberStats.map((s, i) => {
                    const y = s.lastOccurrences?.slice(-15) || [];
                    if (y.length < 7) return { n: i + 1, s: 0 };

                    const n = y.length;
                    const x = Array.from({ length: n }, (_, j) => j);
                    const sumX = x.reduce((a, b) => a + b, 0);
                    const sumY = y.reduce((a, b) => a + b, 0);
                    const sumXY = x.reduce((sum, xi, j) => sum + xi * y[j], 0);
                    const sumX2 = x.reduce((sum, xi) => sum + xi * xi, 0);
                    const sumY2 = y.reduce((sum, yi) => sum + yi * yi, 0);
                    const den = n * sumX2 - sumX * sumX;

                    if (Math.abs(den) < 1e-6) return { n: i + 1, s: 0 };

                    const slope = (n * sumXY - sumX * sumY) / den;
                    const correlation = (n * sumXY - sumX * sumY) / Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
                    const r2 = isNaN(correlation) ? 0 : Math.pow(correlation, 2);

                    const score = r2 > 0.25 ? Math.max(0, -slope * r2) : 0;
                    return { n: i + 1, s: score };
                });
                this.lastRegressionCache = Date.now();
            }
            const validResults = this.cachedRegression.filter(x => x.s > 0).sort((a, b) => b.s - a.s);
            let selection = validResults.map(x => x.n);
            if (selection.length < count) {
                const fallbackCount = count - selection.length;
                const fallbackNumbers = this.getHotNumbers(count + 5).filter(n => !selection.includes(n));
                selection.push(...fallbackNumbers.slice(0, fallbackCount));
            }
            return selection.slice(0, count);
        }
        selectRegressionNumbers() {
            const numbers = this.getRegressionNumbers();
            this.animateSequentialSelection(numbers);
        }

        getPortfolioNumbers(count = 8) {
            if (this.data.kenoStats.totalBets < 30) return this.getHotNumbers(count);
            return this.data.kenoStats.perNumberStats.map((s, i) => {
                const heat = this.calculateHeatScore(s.count, s.betsSince, s.avgInterval, this.data.kenoStats.totalBets);
                const risk = s.entropy || 1;
                const sharpe = heat / (risk + 1);
                return { n: i + 1, s: sharpe };
            }).sort((a, b) => b.s - a.s).slice(0, count).map(x => x.n);
        }
        selectPortfolioNumbers() {
            const numbers = this.getPortfolioNumbers();
            this.animateSequentialSelection(numbers);
        }

        // --- Strategy: Cluster (co-occurrence) ---
        // Numbers that land together: seed from the hottest, grow by total
        // co-occurrence with the set so far, for a tightly-clustered pick.
        getCombinatorialWaysNumbers(count = 9) {
            const N = this.numberCount;
            const draws = this.getRecentDraws(150);
            if (draws.length < 20) return this.getHotNumbers(count);
            const pair = Object.create(null);
            const pk = (a, b) => (a < b ? a + '-' + b : b + '-' + a);
            draws.forEach(d => {
                const u = [...new Set(d)].filter(n => n >= 1 && n <= N).sort((a, b) => a - b);
                for (let i = 0; i < u.length; i++)
                    for (let j = i + 1; j < u.length; j++)
                        pair[u[i] + '-' + u[j]] = (pair[u[i] + '-' + u[j]] || 0) + 1;
            });
            const start = this.getHotNumbers(1)[0] || 1;
            const picked = [start];
            while (picked.length < count) {
                let best = -1, bestScore = -1;
                for (let n = 1; n <= N; n++) {
                    if (picked.includes(n)) continue;
                    let s = 0;
                    for (const p of picked) s += pair[pk(p, n)] || 0;
                    if (s > bestScore) { bestScore = s; best = n; }
                }
                if (best < 0) break;
                picked.push(best);
            }
            if (picked.length < count) {
                for (const n of this.getHotNumbers(count * 2)) {
                    if (!picked.includes(n)) picked.push(n);
                    if (picked.length >= count) break;
                }
            }
            return picked.slice(0, count).sort((a, b) => a - b);
        }
        selectCombinatorialWaysNumbers() {
            const numbers = this.getCombinatorialWaysNumbers();
            this.animateSequentialSelection(numbers);
        }

        // --- Strategy: Pulse (recency × frequency, recent-window boosted) ---
        getConditionalBonusNumbers(count = 9) {
            if (this.data.kenoStats.totalBets < 30) return this.getHotNumbers(count);
            const N = this.numberCount;
            const stats = this.data.kenoStats.perNumberStats;
            const draws = this.getRecentDraws(20);
            const recentWin = Math.max(1, draws.length);
            const recent = new Array(N + 1).fill(0);
            draws.forEach(d => d.forEach(n => { if (n >= 1 && n <= N) recent[n]++; }));
            return stats
                .map((s, i) => {
                    const n = i + 1;
                    const recency = 1 / (s.betsSince + 1);     // how recently it last hit
                    const recentRate = recent[n] / recentWin;  // how often it's hit lately
                    // frequent × recent, amplified by current-window activity
                    return { n, s: s.count * recency * (1 + recentRate * 3) };
                })
                .sort((a, b) => b.s - a.s)
                .slice(0, count)
                .map(x => x.n);
        }
        selectConditionalBonusNumbers() {
            const numbers = this.getConditionalBonusNumbers();
            this.animateSequentialSelection(numbers);
        }

        calculateHeatScore(count, betsSince, avgInterval, totalBets) {
            if (count <= 1 || totalBets <= 0 || !isFinite(avgInterval) || avgInterval <= 0) return 0;
            const occurrenceRate = count / totalBets;
            const frequencyFactor = Math.log(occurrenceRate * 1000 + 1) / Math.log(2);
            const recencyFactor = Math.exp(-betsSince / avgInterval);
            const closenessToExpected = Math.exp(-Math.pow(betsSince - avgInterval, 2) / (2 * Math.pow(avgInterval / 2, 2)));
            const occurrencePenalty = 2 / (1 + Math.exp(-count / 3)) - 1;
            let heatScore = frequencyFactor * recencyFactor * closenessToExpected * occurrencePenalty;
            const cooldownFactor = 1 / (1 + Math.exp((betsSince - avgInterval) / (avgInterval / 4)));
            heatScore *= cooldownFactor;
            const maxPossibleScore = Math.log(1001) / Math.log(2);
            return Math.min(Math.max(heatScore * 100 / maxPossibleScore, 0), 100);
        }

        getCurrentSite() {
            const hostname = window.location.hostname;
            if (hostname.includes('stake')) return 'stake';
            if (hostname.includes('rainbet')) return 'rainbet';
            if (hostname.includes('roobet')) return 'roobet';
            if (hostname.includes('shuffle')) return 'shuffle';
            if (hostname.includes('betfury')) return 'betfury';
            if (hostname.includes('winna')) return 'winna';
            if (hostname.includes('acebet')) return 'acebet';
            return 'unknown';
        }

        // --- Layout mode: floating overlay vs docked sidebar ---
        // Fallback only; pushPageForSidebar measures the real (responsive) width.
        static SIDEBAR_WIDTH = 400;

        applyLayoutMode(mode) {
            this.layoutMode = (mode === 'sidebar') ? 'sidebar' : 'overlay';
            if (this.overlay) {
                this.overlay.classList.toggle('sidebar-mode', this.layoutMode === 'sidebar');
                const btn = this.overlay.querySelector('#overlay-layout');
                if (btn) btn.classList.toggle('active', this.layoutMode === 'sidebar');
            }
            // Sidebar sits BESIDE the game, not over it: a fixed panel would overlap
            // the board, so push the whole page left by the panel width. Shrinking
            // <html> reflows the in-flow page content while the fixed panel keeps its
            // right-edge dock. Cleared in overlay mode (and while hidden).
            this.pushPageForSidebar(this.layoutMode === 'sidebar' && this.isVisible);
            // Re-dock the side drawer for the new position.
            safe(() => this.positionSideDrawer());
            const browserAPI = (typeof browser !== 'undefined') ? browser : chrome;
            browserAPI?.storage?.local?.set({ layoutMode: this.layoutMode });
        }

        // Below this width the panel renders as a bottom sheet (see the
        // max-width:700px CSS block) — keep the JS breakpoint in sync with it.
        isNarrowScreen() {
            return window.innerWidth <= 700;
        }

        pushPageForSidebar(on) {
            safe(() => {
                const docEl = document.documentElement;
                docEl.style.transition = 'margin-right 0.2s ease';
                if (this.isNarrowScreen()) {
                    // Bottom sheet: reserve scroll space below the page instead of
                    // pushing it sideways (a side push would eat the whole screen).
                    docEl.style.marginRight = '';
                    const h = (on && this.overlay) ? this.overlay.offsetHeight : 0;
                    docEl.style.marginBottom = h ? `${h}px` : '';
                    return;
                }
                docEl.style.marginBottom = '';
                // Measure the actual rendered sidebar width (it's responsive) so the
                // reserved gap always matches — no over/under-push when resizing.
                const w = (on && this.overlay) ? this.overlay.offsetWidth : 0;
                docEl.style.marginRight = on ? `${w || GeminyzerOverlay.SIDEBAR_WIDTH}px` : '';
            });
        }

        // Keep a floating overlay reachable: pull it back on-screen if the saved
        // position (or a window resize) left it outside the viewport.
        clampToViewport() {
            safe(() => {
                if (!this.overlay || this.layoutMode === 'sidebar' || this.isNarrowScreen()) return;
                const w = this.overlay.offsetWidth || 400;
                const h = this.overlay.offsetHeight || 450;
                const x = Math.max(0, Math.min(window.innerWidth - Math.min(w, window.innerWidth), this.position?.x ?? 0));
                const y = Math.max(0, Math.min(window.innerHeight - Math.min(h, window.innerHeight), this.position?.y ?? 0));
                if (x !== this.position?.x || y !== this.position?.y) {
                    this.position = { x, y };
                    this.overlay.style.left = x + 'px';
                    this.overlay.style.top = y + 'px';
                    this.positionSideDrawer();
                }
            });
        }

        // Keep the reserved gap matched to the (responsive) sidebar as the window
        // resizes, so it never starts overlapping the game.
        setupSidebarResize() {
            if (this._sidebarResizeAdded) return;
            this._sidebarResizeAdded = true;
            const onResize = this.debounce(() => {
                // Re-run in every mode: crossing the narrow-screen breakpoint has to
                // swap the reserved gap between margin-right and margin-bottom.
                this.pushPageForSidebar(this.layoutMode === 'sidebar' && this.isVisible);
                this.clampToViewport();
            }, 150);
            window.addEventListener('resize', onResize);
        }

        toggleLayoutMode() {
            this.applyLayoutMode(this.layoutMode === 'sidebar' ? 'overlay' : 'sidebar');
        }

        loadLayoutMode() {
            this.setupSidebarResize();
            const browserAPI = (typeof browser !== 'undefined') ? browser : chrome;
            // Default to the docked sidebar (the intended experience) when nothing
            // is saved yet.
            const apply = (r) => this.applyLayoutMode((r && r.layoutMode) || 'sidebar');
            if (!browserAPI?.storage?.local) { this.applyLayoutMode('sidebar'); return; }
            const p = browserAPI.storage.local.get('layoutMode');
            if (p && typeof p.then === 'function') p.then(apply).catch(() => apply({}));
            else browserAPI.storage.local.get('layoutMode', apply);
        }

        startDrag(e) {
            if (this.layoutMode === 'sidebar') return;   // docked — not draggable
            if (this.isNarrowScreen()) return;           // bottom sheet — fixed in place
            if (e.button !== undefined && e.button !== 0) return;
            if (e.target && e.target.closest('button')) return; // header buttons: tap, not drag
            e.preventDefault();
            this.isDragging = true;
            this.overlay.classList.add('dragging');

            const rect = this.overlay.getBoundingClientRect();
            const offsetX = e.clientX - rect.left;
            const offsetY = e.clientY - rect.top;

            const handleDrag = (e) => {
                if (!this.isDragging) return;
                e.preventDefault();

                const w = this.overlay.offsetWidth || 380;
                const newX = Math.max(0, Math.min(window.innerWidth - w, e.clientX - offsetX));
                const newY = Math.max(0, Math.min(window.innerHeight - 50, e.clientY - offsetY));

                this.overlay.style.left = newX + 'px';
                this.overlay.style.top = newY + 'px';

                this.position.x = newX;
                this.position.y = newY;

                this.positionSideDrawer();
            };

            const stopDrag = () => {
                this.isDragging = false;
                this.overlay.classList.remove('dragging');
                document.removeEventListener('pointermove', handleDrag);
                document.removeEventListener('pointerup', stopDrag);
                document.removeEventListener('pointercancel', stopDrag);
                this.saveOverlayPosition();
            };

            document.addEventListener('pointermove', handleDrag);
            document.addEventListener('pointerup', stopDrag);
            document.addEventListener('pointercancel', stopDrag);
        }

        toggleMinimize() {
            safe(() => {
                this.isMinimized = !this.isMinimized;
                this.overlay.classList.toggle('minimized', this.isMinimized);
                const minimizeBtn = this.overlay.querySelector('#overlay-minimize');
                if (minimizeBtn) {
                    minimizeBtn.innerHTML = this.ctlIcon(this.isMinimized ? 'plus' : 'minus');
                    minimizeBtn.title = this.isMinimized ? 'Restore' : 'Minimize';
                }
                // Tab and drawer are body siblings — hide them when minimized via JS
                const tab = document.getElementById('overlay-drawer-tab');
                const drawer = document.getElementById('overlay-side-drawer');
                if (tab) tab.style.display = this.isMinimized ? 'none' : '';
                if (drawer && this.isMinimized) drawer.classList.add('side-drawer-closed');
                if (!this.isMinimized) {
                    setTimeout(() => this.positionSideDrawer(), 0);
                }
                // Bottom-sheet mode reserves page space equal to the sheet height —
                // re-measure after the minimize/restore height change lands.
                if (this.layoutMode === 'sidebar' && this.isNarrowScreen()) {
                    setTimeout(() => this.pushPageForSidebar(this.isVisible), 50);
                }
            });
        }

        toggleVisibility() {
            safe(() => {
                this.isVisible = !this.isVisible;
                this.overlay.classList.toggle('hidden', !this.isVisible);
                // Tab and drawer are body siblings — sync their visibility
                const tab = document.getElementById('overlay-drawer-tab');
                const drawer = document.getElementById('overlay-side-drawer');
                const hide = !this.isVisible;
                if (tab) tab.style.display = hide ? 'none' : '';
                if (drawer && hide) drawer.classList.add('side-drawer-closed');
                // Keep the page-push in sync: free the reserved gap when hidden,
                // restore it when shown back into sidebar mode.
                this.pushPageForSidebar(this.layoutMode === 'sidebar' && this.isVisible);
            });
        }

        resetStats() {
            safe(() => {
                const siteOrigin = this.storageOrigin;
                const siteName = new URL(siteOrigin).hostname;

                const clears = this.gameMode === 'mines'
                    ? '• Every finished mines round recorded here\n• The mine-frequency grid and streaks'
                    : '• All game history\n• Heatmaps\n• Strategy performance data\n• Correlations';
                if (!confirm(`⚠️ Reset stats for ${siteName}?\n\nThis will clear:\n${clears}\n\nYour overlay position and strategy order will be preserved.`)) {
                    return;
                }

                const resetBtn = this.overlay.querySelector('#overlay-reset');
                if (resetBtn) {
                    resetBtn.disabled = true;
                    resetBtn.innerHTML = this.ctlIcon('refresh');
                    resetBtn.classList.add('vx-spin');
                }

                const browserAPI = (typeof browser !== 'undefined') ? browser : chrome;
                if (browserAPI && browserAPI.runtime) {
                    browserAPI.runtime.sendMessage({
                        type: 'RESET_SITE_STATS',
                        origin: siteOrigin
                    }, (response) => {
                        if (browserAPI.runtime.lastError) {
                            console.error('❌ Vantedge: Reset failed - runtime error:', browserAPI.runtime.lastError.message);
                            if (resetBtn) {
                                resetBtn.classList.remove('vx-spin');
                                resetBtn.innerHTML = this.ctlIcon('x');
                                setTimeout(() => {
                                    resetBtn.innerHTML = this.ctlIcon('refresh');
                                    resetBtn.disabled = false;
                                }, 2000);
                            }
                            return;
                        }

                        if (response && response.success) {
                            this.resetData();

                            if (resetBtn) {
                                resetBtn.classList.remove('vx-spin');
                                resetBtn.innerHTML = this.ctlIcon('check');
                                setTimeout(() => {
                                    resetBtn.innerHTML = this.ctlIcon('refresh');
                                    resetBtn.disabled = false;
                                }, 2000);
                            }
                        } else {
                            const errorMsg = response?.error || 'Unknown error';
                            console.error('❌ Vantedge: Reset failed -', errorMsg);
                            console.error('Full response:', response);
                            if (resetBtn) {
                                resetBtn.classList.remove('vx-spin');
                                resetBtn.innerHTML = this.ctlIcon('x');
                                resetBtn.title = `Reset failed: ${errorMsg}`;
                                setTimeout(() => {
                                    resetBtn.innerHTML = this.ctlIcon('refresh');
                                    resetBtn.title = 'Reset Stats (Clears all game data)';
                                    resetBtn.disabled = false;
                                }, 3000);
                            }
                        }
                    });
                }
            });
        }

        setupGlobalReference() {
            window.geminyzerOverlay = this;
        }

        resetData() {
            if (this.gameMode === 'mines') {
                this._minesGames = [];
                this.minesCount = null;
                this.renderMines();
                this.loadMinesFromStorage();
                return;
            }
            this.data = {
                kenoStats: {
                    totalBets: 0,
                    lifetimeBets: 0,
                    hotNumbers: new Array(this.numberCount).fill(0),
                    lastDrawn: [],
                    perNumberStats: Array.from({ length: this.numberCount }, () => ({
                        count: 0,
                        betsSince: 0,
                        lastOccurrences: [],
                        lastBetIndex: -1,
                        avgInterval: 0,
                        entropy: 0
                    }))
                },
                selectedNumbers: new Set(),
            };
            // Clear all strategy caches
            this._lastAIRecommendation = null;

            this.clearSelection();
            this.populateHeatmap();
            this.updateUI();

            const browserAPI = (typeof browser !== 'undefined') ? browser : chrome;
            browserAPI.storage.local.get(['kenoResults', 'lastDrawnNumbers'], (result) => {
                if (result.kenoResults) {
                    this.processKenoData(result.kenoResults);
                }
                if (result.lastDrawnNumbers) {
                    this.data.kenoStats.lastDrawn = result.lastDrawnNumbers;
                }
            });
        }

        destroy() {
            safe(() => {
                // Release the page-push so the host page reclaims the reserved gap.
                this.pushPageForSidebar(false);
                clearInterval(this._modePollHandle);
                clearInterval(this._kenoDetectHandle);
                this.mutationObserver?.disconnect();
                const browserAPI = (typeof browser !== 'undefined') ? browser : chrome;
                this._storageListeners.forEach(fn => {
                    safe(() => browserAPI?.storage?.onChanged?.removeListener(fn));
                });
                this._storageListeners = [];
                this.storageListenerAdded = false;
                this.minesListenerAdded = false;
                document.querySelectorAll('.vx-board-pick').forEach(el => el.classList.remove('vx-board-pick'));
                if (this.overlay) {
                    this.overlay.remove();
                }
                if (window.geminyzerOverlay === this) {
                    delete window.geminyzerOverlay;
                }
            });
        }
    }

    // Which game the current URL is, or null for the rest of the site.
    function routeGame() {
        const path = location.pathname;
        if (/mines/i.test(path)) return 'mines';
        if (/keno/i.test(path)) return 'keno';
        return null;
    }

    // Console handle, present on every page of a supported site whether or not
    // the overlay mounted. `__vantedge.bets()` prints the stake and multiplier
    // actually recorded for recent bets, which separates a capture problem (the
    // stake arrived wrong) from a maths problem (right stake, wrong P/L).
    window.__vantedge = {
        build: OVERLAY_BUILD,
        get route() { return routeGame(); },
        get mounted() { return !!document.getElementById('geminyzer-overlay'); },
        settled() {
            const o = window.geminyzerOverlay;
            if (!o) return null;
            return o.gameMode === 'mines' ? o.minesGamesForCount() : (o._validBets || []);
        },
        pl() {
            const list = this.settled();
            if (!list) return 'overlay not mounted';
            const s = self.VantedgeMoney.summarize(list);
            return {
                game: window.geminyzerOverlay.gameMode,
                pl: fmtMoney(s.pl, s.cur),
                wagered: fmtMoney(s.wagered, s.cur, { signed: false }),
                paidBets: s.bets,
                roi: `${s.roi > 0 ? '+' : ''}${s.roi.toFixed(1)}%`
            };
        },
        bets(n = 5) {
            const list = this.settled();
            if (!list) return 'overlay not mounted';
            return list.slice(0, n).map(b => ({
                stake: Number(b?.amount) || 0,
                multiplier: Number(b?.payoutMultiplier) || 0,
                currency: curKey(b?.currency),
                profit: betProfit(b)
            }));
        }
    };

    function initializeOverlay() {
        if (window.geminyzerOverlay || !routeGame()) return;
        safe(() => {
            const overlay = new GeminyzerOverlay();
            console.log(`✅ Vantedge overlay mounted (${overlay.gameMode})`);
            document.addEventListener('keydown', (e) => {
                if (e.ctrlKey && e.shiftKey && e.key === 'G') {
                    e.preventDefault();
                    safe(() => overlay.toggleVisibility());
                }
            });
        });
    }

    // These sites are single-page apps: opening Mines from the lobby swaps the
    // route without loading a document, so nothing new is ever injected. The
    // script therefore loads across the site and mounts itself when the route
    // becomes a game it supports — and tears down when you leave. Polling the
    // URL beats hooking pushState/replaceState/popstate, which every framework
    // and every in-app link would otherwise have to cooperate with.
    let lastRoute = null;
    function checkRoute() {
        const game = routeGame();
        if (game === lastRoute) return;
        lastRoute = game;
        if (game) {
            if (window.geminyzerOverlay) {
                // Already up (keno ↔ mines in place) — swap the body instead.
                safe(() => window.geminyzerOverlay.applyRouteGame(game));
            } else {
                initializeOverlay();
            }
        } else if (window.geminyzerOverlay) {
            safe(() => window.geminyzerOverlay.destroy());
        }
    }

    // The site's router can re-render the page out from under us and take the
    // overlay node with it, leaving a live instance pointing at a detached div.
    // Rebuild when that happens instead of staying invisible.
    function checkAlive() {
        if (!routeGame() || !window.geminyzerOverlay) return;
        if (document.getElementById('geminyzer-overlay')) return;
        console.log('Vantedge: overlay node was removed by the page — remounting');
        safe(() => window.geminyzerOverlay.destroy());
        initializeOverlay();
    }

    function startRouteWatch() {
        checkRoute();
        setInterval(() => { checkRoute(); checkAlive(); }, 1000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(startRouteWatch, 800));
    } else {
        setTimeout(startRouteWatch, 800);
    }
})();




















