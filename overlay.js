(function () {
    'use strict';

    if (window.geminyzerOverlay) return;

    const OVERLAY_BUILD = '3.28';
    // Logged on every page of a supported site, before anything else can fail.
    // If this line is missing from the console, the script isn't being injected
    // at all (stale extension, or the page isn't in the manifest's match list)
    // — as opposed to being injected and declining to mount.
    console.log(`Vantedge: overlay script loaded (build ${OVERLAY_BUILD}, path ${location.pathname})`);

    const DEBUG = false;
    function log(...args) { if (DEBUG) console.log(...args); }

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
    // Strategy ids that have been renamed or retired over the extension's life.
    // Legend history and per-strategy performance are keyed by whatever id was
    // current when the bet was placed, so without this a real export loses 7% of
    // its hits to names nothing answers to any more — and Adaptive, which now
    // weights strategies by hits per game played, can never match them to a play
    // count. Renames map to their successor; strategies that were removed
    // outright map to null and are dropped rather than misattributed.
    const STRATEGY_ALIASES = {
        timeseries: 'drought',     // Forecast became Drought Rebound
        comboways: 'anticluster',  // Cluster became Anti-Cluster
        gapextremes: 'repeat',     // Extreme became Repeat Chaser
        gap: 'overdue',            // early name for the gap read
        zonehot: 'hotzone',
        volchase: 'volatility',
        surge: 'momentum',
        bounce: 'streak',
        temporal: 'ema',
        predict: 'smart',
        // removed with no successor — counted, but not credited to anyone
        ensemble: null, mix: null, kelly: null, spectral: null, manual: null,
        delta: null, regression: null, parity: null,
        // Sector duplicated Positional, Coverage duplicated Hot, and Realised
        // credited every number on a winning ticket whether it was drawn or not.
        // Their history is counted but credited to nobody, as with the rest here.
        sector: null, cohesion: null, coverage: null, realised: null, condbonus: null
    };
    function canonicalStrategyId(id) {
        if (!id) return null;
        if (Object.prototype.hasOwnProperty.call(STRATEGY_ALIASES, id)) return STRATEGY_ALIASES[id];
        return id;
    }

    // What each strategy is worth playing at when the spot control is on Auto.
    //
    // These used to be assigned by feel. They are now measured. Method: replay a
    // long session game by game, ask each strategy for its top 10 and record
    // which of those ten were drawn, so we get its hit rate at every rank of its
    // OWN ranking. Feed that rate curve through the exact Fisher noncentral
    // hypergeometric for a 10-from-40 draw and Stake's High-risk pay table, and
    // take the spot count with the best expected value. The draw is sampled
    // sequentially with weights, so the distribution is Wallenius noncentral
    // hypergeometric, NOT Fisher: Fisher understates EV by up to 19% under lift
    // and picks a different spot count at weak lift. Values below come from
    // simulating the real process, and only where it beats a plain 6 by more
    // than ~3% — below that the difference is inside the noise and not worth a
    // special case (EMA measures k=3 but gains 0.1%, so it keeps the default).
    //
    // What the rate curve says is where a strategy keeps its conviction:
    //   - falling (Progressive 0.320 at rank 2 -> 0.268 by rank 10, Wheeling,
    //     Bayesian, Portfolio) — it is sure about a few numbers and padding after
    //     that, so play few spots.
    //   - rising — the top pick is the worst and it only works in aggregate.
    //     Read this one carefully: a rising curve can be the strategy padding
    //     from Hot at the high ranks rather than a real signal. Overdue was set
    //     to 10 on exactly that reading and it was wrong — at 10 spots it is its
    //     own strategy only 40% of the time (96% at 4), so the rise was Hot's.
    //     Any strategy with a fallback is now capped where it stays autonomous:
    //     Overdue and Digit both at 4.
    //   - flat (Hot, Coverage, Adaptive, EMA) — the signal is spread evenly and
    //     the count barely matters; sit mid-table.
    // Several of the old hand-picked values were backwards: Overdue was 4 and
    // measures 9, Portfolio was 8 and measures 3, Hotzone was 6 and measures 9.
    //
    // IMPORTANT — what this is not. On a fair board the expected value is 0.990
    // at every spot count from 1 to 10, identical to three decimals, because each
    // row of the pay table is built to the same 99% RTP. Stake keno is provably
    // fair, so none of this buys an edge, and no spot count is worth more than
    // another there. The rate curves above were measured on a deliberately biased
    // board, which is what makes them a property of the STRATEGY (where in its
    // own ranking it concentrates its picks) rather than of any real board. The
    // strategies whose curve stayed flat at 0.25 even against a real bias —
    // Cold, Variance, Transition, Anti-Pattern, Poisson, Anti-Cluster, Balanced,
    // Random — have no measurable concentration, so they keep the default.
    const SPOTS_DEFAULT = 6;
    // [first click, second click]. Clicking a tile again plays the smaller,
    // more concentrated version of the same read; a single value means the
    // strategy has no second mode. These are the owner's picks, settled after
    // four independent reviews of the strategy code disagreed with each other
    // (their proposals for Hot alone ranged from 3 to 10).
    //
    // They are not an edge. Every spot count on this board returns 98.65-99.07%,
    // so the number chosen moves variance and nothing else -- a 3-pick on High
    // wins once in 82 rounds, the same pick on Classic wins 59% of the time.
    // What the second click buys is concentration: fewer numbers, all of them
    // ones the strategy actually ranked, instead of a tail padded from Hot.
    const STRATEGY_SPOTS = {
        hot: [9, 7], cold: [9, 6], smart: [10], ema: [8, 6],
        overdue: [9, 5], progressive: [8, 5], streak: [8, 5], entropy: [9, 4],
        positional: [9, 8], digitbias: [8], successor: [9],
        montecarlo: [9], variance: [9, 5], antipattern: [8, 6], random: [9],
        repeat: [6], portfolio: [8], wheeling: [6], momentum: [8, 5],
        adaptive: [9, 6], edge: [8, 5], regime: [8, 4], bayesian: [9, 5],
        drought: [8], cycle: [9], hotzone: [8], anticluster: [10, 6],
        balanced: [8], transition: [8, 6], volatility: [7], poisson: [9], runs: [9]
    };

    // Stake keno pay tables, 1-40 board with 10 drawn. multiplier[risk][picks][hits].
    // Sourced independently and cross-checked two ways: every row's hypergeometric
    // expected value lands within 98.65-99.07% (Stake Originals run a 1% house
    // edge, not the 3% often quoted), and every full-hit cell matches a table the
    // owner supplied separately. Only valid for the 40-number board — Rainbet's
    // 56-number Extreme mode pays differently and the panel hides there.
    const KENO_PAYOUTS = {
        classic: {
            1: [0, 3.96], 2: [0, 1.9, 4.5], 3: [0, 1, 3.1, 10.4],
            4: [0, 0.8, 1.8, 5, 22.5], 5: [0, 0.25, 1.4, 4.1, 16.5, 36],
            6: [0, 0, 1, 3.68, 7, 16.5, 40], 7: [0, 0, 0.47, 3, 4.5, 14, 31, 60],
            8: [0, 0, 0, 2.2, 4, 13, 22, 55, 70],
            9: [0, 0, 0, 1.55, 3, 8, 15, 44, 60, 85],
            10: [0, 0, 0, 1.4, 2.25, 4.5, 8, 17, 50, 80, 100]
        },
        low: {
            1: [0.7, 1.85], 2: [0, 2, 3.8], 3: [0, 1.1, 1.38, 26],
            4: [0, 0, 2.2, 7.9, 90], 5: [0, 0, 1.5, 4.2, 13, 300],
            6: [0, 0, 1.1, 2, 6.2, 100, 700], 7: [0, 0, 1.1, 1.6, 3.5, 15, 225, 700],
            8: [0, 0, 1.1, 1.5, 2, 5.5, 39, 100, 800],
            9: [0, 0, 1.1, 1.3, 1.7, 2.5, 7.5, 50, 250, 1000],
            10: [0, 0, 1.1, 1.2, 1.3, 1.8, 3.5, 13, 50, 250, 1000]
        },
        medium: {
            1: [0.4, 2.75], 2: [0, 1.8, 5.1], 3: [0, 0, 2.8, 50],
            4: [0, 0, 1.7, 10, 100], 5: [0, 0, 1.4, 4, 14, 390],
            6: [0, 0, 0, 3, 9, 180, 710], 7: [0, 0, 0, 2, 7, 30, 400, 800],
            8: [0, 0, 0, 2, 4, 11, 67, 400, 900],
            9: [0, 0, 0, 2, 2.5, 5, 15, 100, 500, 1000],
            10: [0, 0, 0, 1.6, 2, 4, 7, 26, 100, 500, 1000]
        },
        high: {
            1: [0, 3.96], 2: [0, 0, 17.1], 3: [0, 0, 0, 81.5],
            4: [0, 0, 0, 10, 259], 5: [0, 0, 0, 4.5, 48, 450],
            6: [0, 0, 0, 0, 11, 350, 710], 7: [0, 0, 0, 0, 7, 90, 400, 800],
            8: [0, 0, 0, 0, 5, 20, 270, 600, 900],
            9: [0, 0, 0, 0, 4, 11, 56, 500, 800, 1000],
            10: [0, 0, 0, 0, 3.5, 8, 13, 63, 500, 800, 1000]
        }
    };
    const RISK_ORDER = ['classic', 'low', 'medium', 'high'];

    // Exact hypergeometric: P(h of your k picks are among the 10 drawn from 40).
    function hyperP(k, h) {
        const C = (n, r) => {
            if (r < 0 || r > n) return 0;
            let v = 1;
            for (let i = 0; i < r; i++) v = v * (n - i) / (i + 1);
            return v;
        };
        return C(10, h) * C(30, k - h) / C(40, k);
    }

    // Expected return and standard deviation per unit staked for one pay row.
    // The sd is the point of the whole panel: across risk levels the EV barely
    // moves (every row is built to the same ~99% RTP) while the spread does not.
    function ladderStats(risk, picks) {
        const pay = KENO_PAYOUTS[risk]?.[picks];
        if (!pay) return null;
        let ev = 0, e2 = 0;
        for (let h = 0; h < pay.length; h++) {
            const p = hyperP(picks, h);
            ev += p * pay[h];
            e2 += p * pay[h] * pay[h];
        }
        return { ev, sd: Math.sqrt(Math.max(0, e2 - ev * ev)), pay };
    }

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
            this.heatmapMode = 'tiered';
            // Spot count for the strategy tiles: 'auto' runs each strategy at its
            // own tuned size, a number pins every strategy to that size.
            this.spotMode = 'auto';
            this.currentSelectedCombo = null;
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
            //
            // 5: Core and Alternative membership and order both changed (Coverage
            // promoted in, Delta, Regression and Parity removed, both grids
            // re-sorted). Bumping was missed at the time and the effect was silent:
            // the saved order is honoured verbatim whenever its LENGTH still
            // matches, so an existing install kept rendering the old sixteen ids.
            // Parity stayed in Core, Coverage never appeared in either grid, and
            // Alternative showed 15 because Parity was occupying a Core slot and so
            // got filtered out of the drawer set as well.
            this.LAYOUT_VERSION = 8;

            const browserAPI = (typeof browser !== 'undefined' && browser?.storage) ? browser :
                (typeof chrome !== 'undefined' && chrome?.storage) ? chrome : null;
            if (browserAPI && browserAPI.storage && browserAPI.storage.local) {
                browserAPI.storage.local.get(['strategyToggles', 'comboFavorites', 'heatmapMode', 'spotMode'], (result) => {
                    if (result && result.strategyToggles) {
                        this.strategyToggles = result.strategyToggles;
                    }
                    if (result && (result.spotMode === 'auto' || Number(result.spotMode) >= 2)) {
                        this.spotMode = result.spotMode === 'auto' ? 'auto' : Number(result.spotMode);
                        safe(() => this.renderSpotControl());
                    }
                    if (result && result.heatmapMode) {
                        this.heatmapMode = result.heatmapMode;
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
                random: { name: "Random", method: "True Random Selection", description: "Picks the requested number of spots uniformly at random, with no bias or pattern analysis.", usage: "Best for: Avoiding personal bias, baseline comparison." },

                // Row 2: Statistical Analysis
                overdue: { name: "Overdue", method: "Regression to Mean", description: "Selects numbers with highest overdue score (betsSince > 1.5x avgInterval). Uses regression to mean theory to find 'due' numbers.", usage: "Best for: Exploiting mean reversion on numbers that should appear soon." },
                variance: { name: "Variance", method: "Chi-Square/Z-Score", description: "Statistical tests (chi-square under 50 bets, z-score above it) to find the numbers whose all-time count deviates most from the 0.5-per-game expectation.", usage: "Best for: High-confidence statistical analysis." },
                positional: { name: "Positional", method: "Grid Zone Analysis + Chi-Square", description: "Analyzes 8x5 grid with chi-square validation to detect statistically significant row/column biases (p<0.05).", usage: "Best for: Scientific detection of spatial RNG biases. Top performer on Stake!" },
                hotzone: { name: "Hotzone", method: "2-D Block Z-Score → Gap", description: "Scans 2×2 and larger blocks of the board for a locally significant bias (z > 2.5), then picks the most overdue numbers inside the strongest blocks. Hands back Hot when no block stands out, rather than dressing up the same ranking.", usage: "Best for: Localized spatial bias that row/column averages dilute away." },
                progressive: { name: "Progressive", method: "Momentum Analysis", description: "Calculates a momentum score (frequency / recency) to find accelerating numbers.", usage: "Best for: Spotting numbers heating up now." },

                // Row 3: Advanced Methods
                transition: { name: "Transition", method: "Cold-to-Hot Detection", description: "Identifies numbers transitioning from cold to hot state (decreasing betsSince with increasing count). Catches numbers emerging from cold streaks.", usage: "Best for: Early entry on warming numbers." },
                entropy: { name: "Entropy", method: "Consistency Analysis", description: "Selects numbers with the most consistent and predictable draw intervals (lowest coefficient of variation in gaps).", usage: "Best for: Finding reliable, stable patterns." },

                // Row 4: Pattern Detection
                antipattern: { name: "Anti-Pattern", method: "Avoidance Analysis", description: "Identifies recently frequent combinations and deliberately avoids them. Works without background correlation data.", usage: "Best for: Advanced contrarian betting." },
                streak: { name: "Streak", method: "Consecutive Detection", description: "Finds numbers that appeared in back-to-back or near-consecutive games. Catches hot streaks early.", usage: "Best for: Riding momentum on streaking numbers." },
                volatility: { name: "Volatility", method: "Grid Variance Analysis", description: "Coefficient of variation of each number's gaps — the spread of its intervals against its own mean interval. High CV means the number arrives in bursts and lulls rather than at a steady pace. The exact mirror of Entropy, which takes the steadiest numbers.", usage: "Best for: Numbers that move in bursts, when you want to be on for the next one." },
                // Row 5: Precision Methods
                ema: { name: "EMA", method: "Exponential Moving Average", description: "Recency-weighted frequency. Alpha adapts between 0.15 and 0.30 with how volatile the recent draws are — steadier board, longer memory. Recent games count several times more than old ones, so it turns faster than Hot when a session shifts.", usage: "Best for: Live sessions where trends evolve fast." },
                digitbias: { name: "Digit", method: "Last-Digit Chi-Square", description: "Tests whether numbers ending 0-9 are drawn at unequal rates. A chi-square gate (p<0.05, df=9) has to clear before the digit z-scores boost each number's heat; otherwise it falls back to Hot.", usage: "Best for: Sites with systematic single-digit RNG skew." },

                // Row 7: Meta Strategies
                adaptive: { name: "Adaptive", method: "Session Meta-Strategy", description: "Queries AI performance scores and blends the top 2 recommended strategies weighted by their recent win rates. Dynamically updates as session patterns shift.", usage: "Best for: Any session length. The strategy that picks your strategy." },
                regime: { name: "Regime", method: "CUSUM Change-Point Detection", description: "Uses CUSUM algorithm to detect if the session has shifted into a hot or cold distributional regime. Switches between Hot-biased and Cold-biased blends automatically based on detected regime.", usage: "Best for: Long sessions (40+ games) where RNG drift is expected." },
                // New strategies
                edge: { name: "Edge", method: "Kelly-Inspired Meta", description: "Kelly-inspired: scores each strategy by its realised profit per unit staked this session, shrunk toward zero by how many rounds it has actually run, then blends the top few weighted by that edge. Falls back to a fixed slate while nothing has shown an edge yet.", usage: "Best for: Leaning on whatever has actually been paying in THIS session." },
                // User-pasted strategies (2026-05-13)
                portfolio: { name: "Portfolio", method: "Sharpe-Style Heat/Risk", description: "Heat ÷ entropy as a Sharpe-like ratio. Favors numbers with strong heat AND low variance in their interval pattern.", usage: "Best for: Variance reduction. Doesn't change EV." },
                anticluster: { name: "Anti-Cluster", method: "Minimum Co-Occurrence", description: "The mirror of Wheeling: greedily builds a set of numbers that have AVOIDED each other in your draws, spreading the ticket across independent draws instead of stacking it on one cluster.", usage: "Best for: More chances at a small hit rather than one big simultaneous one." },
                // Re-added historical strategies
                bayesian: { name: "Bayesian", method: "Dynamic Posterior Update", description: "Maintains a Bayesian posterior for each number's hit probability, updating after every draw. Selects numbers with the highest posterior-weighted scores.", usage: "Best for: Statistically grounded probability estimates that sharpen with more data." },
                montecarlo: { name: "MonteCarlo", method: "200-Sim Weighted Sampling", description: "Runs up to 200 simulations of a draw, sampling without replacement weighted by each number's hit count, and takes the numbers that come up most often. Since the weights are the hit counts, this is Hot with sampling noise on top — the jitter is the point, not a separate signal.", usage: "Best for: Playing the hot end of the board without picking the identical ticket every time." },
                wheeling: { name: "Wheeling", method: "Correlation-Based Expansion", description: "Seeds from the hottest number then expands by finding its most correlated partners — numbers that frequently appear together.", usage: "Best for: Any site — the pair counts come from your own recent draws. Builds a synergistic set." },
                drought: { name: "Drought", method: "Rate vs Its Own Pace", description: "Numbers whose recent rate has fallen furthest below THEIR OWN session pace — not below the flat expectation. A number can run hot all session and still be in a personal drought right now.", usage: "Best for: A dip in a number that has otherwise been good to you." },
                balanced: { name: "Balanced", method: "Zone-Based Coverage", description: "Splits the board into four equal zones and takes an equal share from each, picking inside a zone the numbers sitting CLOSEST to the expected hit count — the unremarkable ones, not the hot or cold tails.", usage: "Best for: Spreading a ticket evenly and deliberately avoiding both tails." },
                momentum: { name: "Momentum", method: "Recent-Interval Acceleration", description: "Scores each number by comparing its recent gap intervals to its long-term average. Numbers appearing faster than usual get high momentum scores.", usage: "Best for: Spotting numbers whose appearance rate is currently accelerating." },
                successor: { name: "Successor", method: "Lag-1 Markov, Off-Diagonal", description: "Conditions on the numbers drawn in the LAST game and plays the ones that have most often followed them, measured against each candidate's own rate rather than against chance so the score is a conditional lift and not heat in disguise. Needs 150+ draws.", usage: "Best for: A board where what comes up next depends on what just came up." },
                cycle: { name: "Cycle", method: "Autocorrelation, Lags 2-20", description: "Looks for a rhythm rather than a rate: the strongest autocorrelation in each number's hit series at lags 2 to 20, kept only if it clears a Sidak-corrected Bartlett band, and played only while the cycle points at this game. Needs 200+ draws.", usage: "Best for: A board where numbers arrive on a period rather than at random." },
                runs: { name: "Runs", method: "Wald-Wolfowitz", description: "Counts runs in each number's hit/miss sequence against the exact distribution-free null. A strongly negative z means the hits arrive in bunches; those numbers are played while still inside a bunch. Volatility measures how spread out the gaps are, this measures how they are arranged.", usage: "Best for: A board where hits cluster in time instead of scattering." },
                poisson: { name: "Poisson", method: "Poisson Survival Probability", description: "Models each number's gap as a Poisson process, with λ its mean gap over the whole session (games ÷ hits). Scores by survival probability — the chance a gap this long would happen at that rate, so the most improbably overdue numbers rank highest.", usage: "Best for: 30+ games. The most statistically grounded gap strategy." },
                repeat: { name: "Repeat", method: "Lag-1 Autocorrelation", description: "Given a number was drawn, how often it was drawn again in the very next game, against the 0.25 chance rate and shrunk toward it. The only strategy that reads draw ORDER — every other one treats the session as an unordered pile of counts.", usage: "Best for: Boards where numbers come in back-to-back runs." }
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
            this.renderSpotControl();
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

            browserAPI.storage.local.get(
                ['kenoResults', 'lastDrawnNumbers', 'kenoTotalBets', 'legendStats', 'kenoStrategyPerformance'],
                (result) => {
                if (browserAPI.runtime?.lastError) {
                    console.error('Error loading data from storage:', browserAPI.runtime.lastError.message);
                    return;
                }
                // Lifetime counter from the background (survives the 1500-entry
                // history cap). Read before processKenoData so the first render
                // already shows it.
                this.data.kenoStats.lifetimeBets =
                    result?.kenoTotalBets?.[`${this.storageOrigin}-keno-session`] ?? 0;
                // Adaptive weights strategies by their big-hit rate. Both halves
                // of that live in background state and were never read here, so
                // the bonus silently evaluated to 1 for every strategy.
                this.data.legendStats = result?.legendStats || {};
                this.data.kenoStrategyPerformance = result?.kenoStrategyPerformance || {};
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
                safe(() => this.checkGapAlerts());
                this.renderInsights();
                this.updateAIRecommendation();
                safe(() => this.renderKenoPayouts());
                this.fetchAndDisplayCorrelations();
                this.lastUiUpdateTime = now;
            }
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

        updateUI() {
            this.updateStatusBar();
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
                safe(() => this.probeHandoffs());
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

        // Count numbers running hot/cold vs. their expected frequency.
        hotColdCounts() {
            const N = this.numberCount;
            const counts = this.data.kenoStats.hotNumbers;
            const bets = this.data.kenoStats.totalBets;
            if (!bets) return { hot: 0, cold: 0, expected: 0 };
            const windowGames = this.data.kenoStats.analyzedGames || Math.min(bets, 1000);
            const expected = windowGames * ((this._drawnPerGame || 10) / N);
            let hot = 0, cold = 0;
            for (let i = 0; i < N; i++) {
                if (counts[i] > expected) hot++;
                else if (counts[i] < expected) cold++;
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

        // Per-strategy session P/L over the tracked bets
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

        // Strategy grid tiles remain clean without messy in-button amount badges.
        updateStrategyPLBadges() {
            safe(() => {
                const items = [
                    ...(this.overlay?.querySelectorAll('.action-item') || []),
                    ...document.querySelectorAll('#overlay-side-actions .action-item')
                ];
                items.forEach(item => {
                    const el = item.querySelector('.vx-spl');
                    if (el) el.remove();
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
            const plCls = plStat.pl > eps ? 'pos' : (plStat.pl < -eps ? 'neg' : '');
            const exp = expected ? Math.round(expected) : 0;
            const roi = plStat.roi;
            const others = plStat.others.length
                ? ` Also ${plStat.others.map(o => fmtMoney(o.pl, o.cur)).join(', ')} (kept separate — no conversion).`
                : '';
            const tip = {
                bets: 'Settled bets tracked on this seed.',
                hot: `Numbers drawn ABOVE expected (~${exp}× each so far).`,
                cold: `Numbers drawn BELOW expected (~${exp}× each so far).`,
                pl: hasPaid
                    ? `Net profit on real-money bets: stake × (multiplier − 1), summed. `
                      + `${plStat.bets} paid bet${plStat.bets === 1 ? '' : 's'}, ${fmtMoney(plStat.wagered, plStat.cur, { signed: false })} wagered, `
                      + `ROI ${roi > 0 ? '+' : ''}${roi.toFixed(1)}%.${others} Free ($0) bets are excluded.`
                    : 'Net profit on real-money bets: stake × (multiplier − 1), summed. Free ($0) bets are excluded.'
            };
            const plFormatted = hasPaid ? fmtMoney(plStat.pl, plStat.cur, { compact: true }) : '—';
            el.innerHTML = `
                <div class="vx-stat-item" title="${tip.bets}">
                    <span class="vx-stat-num">${bets.toLocaleString()}</span>
                    <span class="vx-stat-txt">BETS</span>
                </div>
                <div class="vx-stat-item" title="${tip.hot}">
                    <span class="vx-stat-num vx-hot-txt">${bets ? hot : '—'}</span>
                    <span class="vx-stat-txt">HOT</span>
                </div>
                <div class="vx-stat-item" title="${tip.cold}">
                    <span class="vx-stat-num vx-cold-txt">${bets ? cold : '—'}</span>
                    <span class="vx-stat-txt">COLD</span>
                </div>
                <div class="vx-stat-item" title="${tip.pl}">
                    <span class="vx-stat-num ${hasPaid ? plCls : ''}">${plFormatted}</span>
                    <span class="vx-stat-txt">P/L</span>
                </div>
            `;
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
        // gap (draws since last full hit), avg interval and heat score + rising burst score.
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
            const shortWindow = Math.min(35, draws.length);

            for (let idx = 0; idx < draws.length; idx++) {
                const u = [...new Set(draws[idx])].filter(n => n >= 1 && n <= N).sort((a, b) => a - b);
                if (u.length > dpg) dpg = u.length;
                if (u.length < k) continue;
                this._kSubsets(u, k, (sub) => {
                    const key = sub.join('-');
                    let s = stat[key];
                    if (!s) {
                        stat[key] = { count: 1, minIdx: idx, maxIdx: idx, recentCount: idx < shortWindow ? 1 : 0 };
                    } else {
                        s.count++;
                        if (idx < s.minIdx) s.minIdx = idx;
                        if (idx > s.maxIdx) s.maxIdx = idx;
                        if (idx < shortWindow) s.recentCount = (s.recentCount || 0) + 1;
                    }
                });
            }
            this._drawnPerGame = dpg || 10;
            const expGap = this.expectedGroupGap(k);
            const pGroup = expGap === Infinity ? 0 : 1 / expGap;
            const expectedRecentHits = shortWindow * pGroup;

            let maxCount = 1;
            for (const key in stat) if (stat[key].count > maxCount) maxCount = stat[key].count;
            const groups = [];
            for (const key in stat) {
                const s = stat[key];
                if (k >= 3 && s.count < 2) continue; // singletons aren't a "group" for trios+
                const gap = s.minIdx; // draws since last full hit (0 = most recent)
                const avgInterval = s.count > 1 ? Math.round((s.maxIdx - s.minIdx) / (s.count - 1)) : Math.round(expGap);
                const gapRatio = expGap === Infinity ? 0 : gap / expGap;
                
                // Rising score: mid-burst moment when short-window hit rate beats expected binomial odds
                const recentBurst = (s.recentCount || 0) / Math.max(0.1, expectedRecentHits);
                const risingScore = recentBurst * (1 / (gap + 1));

                groups.push({
                    numbers: key.split('-').map(Number), key,
                    count: s.count, gap, avgInterval, gapRatio,
                    recentCount: s.recentCount || 0,
                    risingScore,
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
            this.currentSelectedCombo = [...numbers].sort((a, b) => a - b);
            safe(() => this.renderKenoPayouts());
            this.animateSequentialSelection(this.currentSelectedCombo);
            this.renderSmartPicker();
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
                hot: 'Hot — ranked by heat score (how often it hits × how overdue it is).',
                rising: 'Rising — combos mid-burst the moment their short-window hit rate beats expected odds.',
                frequent: 'Frequent — ranked by raw hit count. Groups that appear most often, overdue or not.',
                overdue: 'Overdue — ranked by gap vs its expected interval. Groups that are "due".',
                cold: 'Cold — least-frequent groups in the window (the dud pile).'
            };
            const tabs = [
                ['hot', 'Hot'],
                ['rising', 'Rising'],
                ['frequent', 'Frequent'],
                ['overdue', 'Overdue'],
                ['cold', 'Cold']
            ].map(([v, label]) =>
                `<button class="vx-gtab ${v === view ? 'on' : ''}" data-view="${v}" title="${viewTips[v]}">${label}</button>`).join('');

            let groups;
            if (favOnly) {
                // Favorites are exact number-sets; show them with live stats for the
                // current pool (gap/heat recomputed against recent draws).
                const live = this.computeHotGroups(size);
                const byKey = Object.create(null);
                (live.groups || []).forEach(g => { byKey[g.key] = g; });
                groups = (this.comboFavorites || []).map(key => byKey[key] || {
                    numbers: key.split('-').map(Number), key, count: 0, gap: null, gapRatio: 0, avgInterval: null, heat: 0
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
                    rising: (a, b) => b.risingScore - a.risingScore || a.gap - b.gap,
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
                const avgVal = g.avgInterval != null ? g.avgInterval : Math.round(g.expGap || 10);
                const isCurrent = this.currentSelectedCombo && this.comboKey(this.currentSelectedCombo) === g.key;

                return `<div class="vx-grow ${isCurrent ? 'selected-group' : ''}" data-combo-numbers="${g.numbers.join(',')}" title="Click to select these ${g.numbers.length} numbers">
                            <span class="vx-gnums">${nums}</span>
                            <span class="vx-gcell">${g.count || 0}</span>
                            <span class="vx-gcell gap ${gapState}">${gapText}</span>
                            <span class="vx-gcell">${avgVal}</span>
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
                    <span class="vx-gcell" title="Average interval (draws between hits)">Avg</span>
                    <span class="vx-gcell vx-gsort ${view === 'hot' ? 'on' : ''}" data-sortview="hot" title="Heat — combined score of frequency and how overdue it is, vs the top group. Click to sort.">Heat${car('hot')}</span>
                    <span style="width:17px"></span>
                </div>`;

            const sparse = !favOnly && groups.length > 0 &&
                (groups.length < 3 || groups.every(g => (g.count || 0) <= 2));
            const hint = sparse
                ? `<div class="vx-combos-hint">Few repeating ${size}-groups yet — keep playing to see distinct trends.</div>`
                : '';

            el.innerHTML = this._hotGroupsShell(sizePills, tabs, favOnly) + head +
                (groups.length ? rows + hint : empty);

            this.wireHotCombos();
        }

        _hotGroupsShell(sizePills, tabs, favOnly) {
            const size = this.hotGroupSize || 4;
            const exp = this.expectedGroupGap(size);
            const expHint = isFinite(exp)
                ? `<div class="vx-gexp" title="A ${size}-number group fully hits about once per ${Math.round(exp).toLocaleString()} draws by pure chance.">${size}-groups hit ~1 in ${Math.round(exp).toLocaleString()} draws</div>`
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

        // Recent draws as bitmasks (lo: 1-31, hi: 32-62), cached per bet set so
        // gap checks across many combos don't rescan and re-Set every draw.
        _drawMasks(limit) {
            const all = this._validBets || [];
            const c = this._drawMaskCache;
            if (c && c.ref === all && c.n === this.numberCount && c.limit >= limit) return c;
            const cap = Math.max(limit, 1000);
            const draws = this.getRecentDraws(cap);
            const lo = new Int32Array(draws.length), hi = new Int32Array(draws.length);
            for (let i = 0; i < draws.length; i++) {
                const d = draws[i];
                for (let j = 0; j < d.length; j++) {
                    const n = d[j];
                    if (n <= 31) lo[i] |= 1 << (n - 1); else hi[i] |= 1 << (n - 32);
                }
            }
            this._drawMaskCache = { ref: all, n: this.numberCount, limit: cap, lo, hi, len: draws.length };
            return this._drawMaskCache;
        }

        // Gap (draws since the combo last fully hit) + total full hits, from the
        // draw history — counts even when the combo wasn't being played.
        comboGap(numbers, limit = 1000) {
            const { lo, hi, len } = this._drawMasks(limit);
            let wl = 0, wh = 0;
            for (const n of numbers) {
                if (n >= 1 && n <= 31) wl |= 1 << (n - 1);
                else if (n >= 32 && n <= 62) wh |= 1 << (n - 32);
            }
            const end = Math.min(len, limit);
            let gap = null, hits = 0;
            for (let i = 0; i < end; i++) {
                if ((lo[i] & wl) === wl && (hi[i] & wh) === wh) {
                    hits++;
                    if (gap === null) gap = i;
                }
            }
            return { gap, hits, count: hits, draws: end };
        }

        // Stats for one specific combo (Smart Picker preview).
        getComboStats(numbers) {
            const key = [...numbers].sort((a, b) => a - b).join('-');
            const m = this.computeComboHistory()[key];
            const g = this.comboGap([...numbers].sort((a, b) => a - b));
            const expGap = this.expectedGroupGap(numbers.length);
            const gapRatio = g.gap == null || !isFinite(expGap) || expGap === 0 ? 0 : g.gap / expGap;
            const avgInterval = m?.plays > 1 ? Math.round((m.lastSeen - m.firstSeen) / (m.plays - 1)) : null;
            return {
                best: m?.best || 0, avg: m?.avg || 0, plays: m?.plays || 0,
                pl: m?.pl || 0, wagered: m?.wagered || 0, cur: m?.cur || 'usd',
                mixed: !!m?.mixed, paid: m?.paid || 0, roi: m?.roi || 0,
                gap: g.gap, gapRatio, hits: g.hits, expGap, avgInterval
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
                const expGap = this.expectedGroupGap(m.numbers.length);
                const gapRatio = g.gap == null || !isFinite(expGap) || expGap === 0 ? 0 : g.gap / expGap;
                const gapState = (g.gap === 0) ? 'now' : (gapRatio >= 1.5) ? 'overdue' : (gapRatio >= 0.8) ? 'due' : '';
                const gapTip = g.gap == null ? 'No full hits in the tracked window'
                    : g.gap === 0 ? 'Just hit — gap resets to NOW'
                    : `Draws since this combo last fully hit. Expected ~${Math.round(expGap).toLocaleString()} draws, current gap ${g.gap} (${(gapRatio*100).toFixed(0)}% of expected).`;
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
                            <div class="vx-chsub">best <span class="vx-chbest" title="Top multipliers — click to expand">${m.best.toFixed(1)}x</span> · avg ${m.avg.toFixed(1)}x · ${m.plays} plays · gap <span class="vx-chgap ${gapState}" title="${gapTip}">${gapText}</span></div>
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

        // Pattern: rides what is hot — frequency in last 150 draws weighted by gap vs expected,
        // boosted by hot-combo co-occurrence and recent momentum.
        patternScores() {
            const N = this.numberCount;
            const draws = this.getRecentDraws(150);
            const totalDraws = draws.length;
            const score = new Array(N + 1).fill(0);
            if (!totalDraws) return score;

            const counts = new Array(N + 1).fill(0);
            const lastSeen = new Array(N + 1).fill(totalDraws);
            const expGap = N / (this._drawnPerGame || 10); // ~4 on Stake 40-grid

            draws.forEach((d, idx) => {
                const u = [...new Set(d)].filter(n => n >= 1 && n <= N);
                u.forEach(n => {
                    counts[n]++;
                    if (idx < lastSeen[n]) lastSeen[n] = idx;
                });
            });

            for (let n = 1; n <= N; n++) {
                const c = counts[n];
                const gap = lastSeen[n];
                // Base heat: frequency weighted by gap vs expected
                const gapWeight = gap <= expGap ? 1.25 : Math.max(0.2, 1 - (gap - expGap) / (3 * expGap));
                score[n] = c * gapWeight;
            }

            // Boost numbers inside session's hottest combos
            const hg = this.computeHotGroups(3, 150);
            (hg.groups || []).slice(0, 10).forEach(g => {
                const heat = g.heat || 0;
                g.numbers.forEach(n => {
                    if (n >= 1 && n <= N) score[n] += heat * 1.5;
                });
            });

            // Momentum boost
            const mom = this._momentum || this.computeMomentum();
            for (let n = 1; n <= N; n++) {
                if (mom[n] === 'up') score[n] += 1.0;
            }

            return score;
        }

        // Pairs: recency-weighted co-occurrence matrix; seeds from the strongest
        // repeating combo in the session, extends with numbers that co-occur more
        // often than chance, with empirical Bayes shrinkage for thin samples.
        pairsPick(size) {
            const N = this.numberCount;
            const draws = this.getRecentDraws(150);
            const W = draws.length;
            if (W < 10) return this.getRandomNumbers(size);

            const aff = Object.create(null);
            const single = new Array(N + 1).fill(0);
            const pk = (a, b) => (a < b ? a + '-' + b : b + '-' + a);
            const pPairExp = ((this._drawnPerGame || 10) * ((this._drawnPerGame || 10) - 1)) / (N * (N - 1));

            draws.forEach((d, idx) => {
                const w = 1 - (idx / (W + 1)) * 0.6; // recency weighting
                const u = [...new Set(d)].filter(n => n >= 1 && n <= N).sort((a, b) => a - b);
                u.forEach(n => { single[n] += w; });
                for (let i = 0; i < u.length; i++) {
                    for (let j = i + 1; j < u.length; j++) {
                        const k = pk(u[i], u[j]);
                        aff[k] = (aff[k] || 0) + w;
                    }
                }
            });

            // Seed from top repeating combo in session
            const hg = this.computeHotGroups(2, 150);
            let seedPair = null;
            if (hg.groups && hg.groups.length > 0) {
                seedPair = hg.groups[0].numbers;
            }

            const picked = seedPair ? [...seedPair] : [];
            if (!picked.length) {
                let start = 1;
                for (let n = 2; n <= N; n++) if (single[n] > single[start]) start = n;
                picked.push(start);
            }

            // Empirical Bayes shrinkage constant (k=3)
            const kShrink = 3;
            const expAffinity = (W * pPairExp);

            while (picked.length < size) {
                let best = -1, bestScore = -1;
                for (let n = 1; n <= N; n++) {
                    if (picked.includes(n)) continue;
                    let s = 0;
                    for (const p of picked) {
                        const raw = aff[pk(p, n)] || 0;
                        const shrunk = (raw + kShrink * expAffinity) / (W + kShrink);
                        s += shrunk;
                    }
                    if (s > bestScore) {
                        bestScore = s;
                        best = n;
                    }
                }
                if (best < 0) break;
                picked.push(best);
            }
            return picked.slice(0, size).sort((a, b) => a - b);
        }

        // Stats: deficit z-score against expected frequency, weighted by overdue gap.
        statsPick(size) {
            const N = this.numberCount;
            const draws = this.getRecentDraws(1000);
            const total = draws.length;
            if (total < 15) return this.getRandomNumbers(size);

            const p = (this._drawnPerGame || 10) / N; // 0.25 on Stake 40-grid
            const expectedHits = total * p;
            const stdDev = Math.sqrt(total * p * (1 - p)) || 1;
            const counts = new Array(N + 1).fill(0);
            const lastSeen = new Array(N + 1).fill(total);

            draws.forEach((d, idx) => {
                const u = [...new Set(d)].filter(n => n >= 1 && n <= N);
                u.forEach(n => {
                    counts[n]++;
                    if (idx < lastSeen[n]) lastSeen[n] = idx;
                });
            });

            const expGap = 1 / p; // ~4 draws
            const scores = [];
            for (let n = 1; n <= N; n++) {
                const hits = counts[n];
                const deficitZ = (expectedHits - hits) / stdDev; // positive when underrepresented
                const gap = lastSeen[n];
                const gapWeight = gap >= expGap ? 1 + 0.3 * Math.min(gap / expGap, 4) : 0.8;
                const score = deficitZ * gapWeight;
                scores.push({ n, score });
            }

            return scores.sort((a, b) => b.score - a.score)
                .slice(0, size)
                .map(x => x.n)
                .sort((a, b) => a - b);
        }

        // Build a pick of `size` numbers using one of three lenses.
        smartPick(view, size) {
            const N = this.numberCount;
            if (this.getRecentDraws(20).length < 20) return this.getRandomNumbers(size);
            if (view === 'pairs') return this.pairsPick(size);
            if (view === 'stats') return this.statsPick(size);
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
                pattern: 'Pattern — rides the current run: scores numbers by heat in last 150 draws weighted by gap vs expected, plus hot combo boost.',
                pairs: 'Pairs — builds around groups that land together using co-occurrence correlation matrix with shrinkage.',
                stats: 'Stats — statistical deficit z-score: targets numbers due vs expected frequency and past their expected gap.'
            };

            const sizeOpts = [2, 3, 4, 5, 6, 7, 8, 9, 10].map(s =>
                `<option value="${s}" ${s === size ? 'selected' : ''}>${s}</option>`).join('');

            const pick = this.smartPick(view, size);
            const activeNums = (this.currentSelectedCombo && this.currentSelectedCombo.length > 0)
                ? this.currentSelectedCombo
                : pick;

            const stats = activeNums.length ? this.getComboStats(activeNums) : null;
            const gapText = !stats ? '--' : (stats.gap == null ? '--' : (stats.gap === 0 ? 'NOW' : stats.gap));
            const gapClass = stats ? (stats.gap === 0 ? 'now' : (stats.gapRatio >= 1.5 ? 'overdue' : (stats.gapRatio >= 0.8 ? 'due' : ''))) : '';
            const plClass = stats && stats.paid ? this.plClass(stats.pl, stats.cur) : '';
            const plText = stats && stats.paid ? this.plFmt(stats.pl, stats.cur, { mixed: stats.mixed, compact: true }) : '--';

            const numsDisplay = activeNums.length
                ? activeNums.join(', ')
                : 'Need more draws to analyze.';

            el.innerHTML = `
                <div class="vx-combos-head"><span class="vx-section-title">SMART PICKER</span></div>
                <div class="vx-sp-row1">
                    <button class="vx-sp-btn ${view === 'pattern' ? 'on' : ''}" data-spview="pattern" title="${tabTips.pattern}">
                        <span class="vx-sp-icon">⬡</span> Pattern
                    </button>
                    <button class="vx-sp-btn ${view === 'pairs' ? 'on' : ''}" data-spview="pairs" title="${tabTips.pairs}">
                        <span class="vx-sp-icon">∞</span> Pairs
                    </button>
                    <button class="vx-sp-btn ${view === 'stats' ? 'on' : ''}" data-spview="stats" title="${tabTips.stats}">
                        <span class="vx-sp-icon">ılı</span> Stats
                    </button>
                    <div class="vx-sp-select-wrap">
                        <select class="vx-spsize" id="overlay-sp-size" title="Spot count">${sizeOpts}</select>
                    </div>
                </div>
                <div class="vx-sp-nums-row">
                    <div class="vx-sp-nums-list" id="overlay-current-combo-nums">${numsDisplay}</div>
                </div>
                <div class="vx-sp-stats-grid">
                    <div class="vx-sp-col"><span class="vx-sp-k">BEST</span><span class="vx-sp-v ${stats && stats.best > 0 ? 'pos' : ''}">${stats && stats.best > 0 ? stats.best.toFixed(1) + 'x' : '--'}</span></div>
                    <div class="vx-sp-col"><span class="vx-sp-k">AVG</span><span class="vx-sp-v">${stats && stats.avg > 0 ? stats.avg.toFixed(1) + 'x' : '--'}</span></div>
                    <div class="vx-sp-col"><span class="vx-sp-k">BETS</span><span class="vx-sp-v">${stats ? stats.plays : '0'}</span></div>
                    <div class="vx-sp-col"><span class="vx-sp-k">GAP</span><span class="vx-sp-v ${gapClass}">${gapText}</span></div>
                    <div class="vx-sp-col"><span class="vx-sp-k">P/L</span><span class="vx-sp-v ${plClass}">${plText}</span></div>
                </div>`;

            el.querySelectorAll('.vx-sp-btn').forEach(b => b.onclick = () => {
                this.smartPickView = b.dataset.spview;
                const newPick = this.smartPick(this.smartPickView, this.smartPickSize);
                this.currentSelectedCombo = newPick;
                this.applyCombo(newPick);
                this.renderSmartPicker();
            });
            const sizeSel = el.querySelector('#overlay-sp-size');
            if (sizeSel) sizeSel.onchange = (e) => {
                this.smartPickSize = parseInt(e.target.value, 10);
                const newPick = this.smartPick(this.smartPickView, this.smartPickSize);
                this.currentSelectedCombo = newPick;
                this.applyCombo(newPick);
                this.renderSmartPicker();
            };
            // No click handler on the numbers: choosing a tab or a size already
            // applies them to the board, so a second way to do the same thing
            // just made a read-out look like a button.
        }

        getSiteBadgeText() {
            const site = this.getCurrentSite();
            const map = {
                stake: 'Stake',
                rainbet: 'Rainbet',
                roobet: 'Roobet',
                shuffle: 'Shuffle',
                betfury: 'BetFury',
                winna: 'Winna',
                acebet: 'AceBet'
            };
            return map[site] || 'Stake';
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
                    <span class="overlay-site-badge" id="overlay-site-badge">${this.getSiteBadgeText()}</span>
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

        // How big the board actually is. Stake and Shuffle deal a 5x5, but
        // Rainbet runs other grid sizes, and every tile index, expectation and
        // payout below depends on the count — so read it from the rounds rather
        // than assuming 25. Round the largest index seen up to the next square.
        minesBoardSize() {
            const games = this._minesGames || [];
            let max = -1;
            for (let i = 0; i < games.length && i < 200; i++) {
                const st = games[i]?.state;
                for (const m of (st?.mines || [])) { const v = parseInt(m, 10); if (v > max) max = v; }
                for (const r of (st?.rounds || [])) {
                    const v = parseInt(r?.field ?? r, 10);
                    if (v > max) max = v;
                }
            }
            if (max < 0) return { tiles: 25, cols: 5 };
            for (const cols of [3, 4, 5, 6, 7, 8]) {
                if (max < cols * cols) return { tiles: cols * cols, cols };
            }
            return { tiles: 25, cols: 5 };
        }

        // What the board pays for `revealed` gems in a row with `mineCount`
        // mines: (1 − 1% house edge) / P(that many safe picks), which works out
        // to 0.99 × C(25,k) / C(25−M,k). Rounded to cents with exact halves
        // going down, which is what the games print (1 mine on a 3-mine board
        // is exactly 1.125 and shows as 1.12x). Checked row by row against a
        // published 3-mine ladder and against 16-mine values.
        minesMultiplier(mineCount, revealed) {
            const N = this.minesBoardSize().tiles;
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
                if (f >= 0 && f < this.minesBoardSize().tiles) out.push(f);
            }
            return out;
        }

        // Everything the panel derives from one mine count's rounds, computed
        // once per (count, history length) — the render path touches it a lot.
        minesAnalysis() {
            const games = this.minesGamesForCount();
            const key = `${this.minesCount}:${games.length}:${this._minesGames.length}`;
            if (this._minesAnalysisCache?.key === key) return this._minesAnalysisCache.value;

            const N = this.minesBoardSize().tiles;
            const hits = new Array(N).fill(0);
            const masks = [];   // one 25-bit mine mask per round, for cluster lookups
            for (const g of games) {
                const mines = g.state?.mines;
                if (!Array.isArray(mines) || !mines.length) continue;
                let mask = 0;
                for (let i = 0; i < mines.length; i++) {
                    const pos = parseInt(mines[i], 10);
                    if (pos >= 0 && pos < N) { hits[pos]++; mask |= (1 << pos); }
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
            const { cols } = this.minesBoardSize();
            const last = cols - 1;
            for (let i = 0; i < cols * cols; i++) {
                const r = Math.floor(i / cols), c = i % cols;
                const onEdge = r === 0 || r === last || c === 0 || c === last;
                const corner = (r === 0 || r === last) && (c === 0 || c === last);
                regions[corner ? 'corner' : onEdge ? 'edge' : 'center'].push(i);
            }
            const total = hits.reduce((a, b) => a + b, 0);
            return Object.entries(regions).map(([name, tiles]) => {
                const seen = tiles.reduce((sum, i) => sum + hits[i], 0);
                return {
                    name, tiles: tiles.length,
                    share: total ? (seen / total) * 100 : 0,
                    expected: (tiles.length / (cols * cols)) * 100,
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
            if (layouts < 10 || !mineCount || size > this.minesBoardSize().tiles - mineCount) return [];
            const pool = hits.map((h, i) => ({ i, h }))
                .sort((a, b) => a.h - b.h || a.i - b.i)
                .slice(0, Math.min(12, this.minesBoardSize().tiles - mineCount))
                .map(t => t.i);
            // Fair rate for k tiles all missing the mines: C(N-M,k)/C(N,k).
            const N = this.minesBoardSize().tiles;
            let fair = 1;
            for (let i = 0; i < size; i++) fair *= (N - mineCount - i) / (N - i);

            // A big group's fair rate is tiny — ten tiles clean on a ten-mine
            // board happens about once in a thousand rounds — so a SINGLE lucky
            // round reads as +7000% against it and a return of 77x. Two guards:
            // a group has to have come through clean more than once to be
            // listed at all, and the rate is shrunk toward fair by PRIOR
            // pseudo-rounds, so one hit in fourteen can't masquerade as an edge.
            const PRIOR = 12;
            const MIN_CLEAN = 2;
            const out = [];
            const combo = new Array(size);
            const walk = (start, depth) => {
                if (depth === size) {
                    let mask = 0;
                    for (const t of combo) mask |= (1 << t);
                    let clean = 0;
                    for (let m = 0; m < masks.length; m++) if ((masks[m] & mask) === 0) clean++;
                    if (clean < MIN_CLEAN) return;
                    const raw = clean / masks.length;
                    const rate = (clean + fair * PRIOR) / (masks.length + PRIOR);
                    out.push({
                        tiles: combo.slice().sort((a, b) => a - b),
                        rate, raw, clean, rounds: masks.length, fair,
                        edge: fair > 0 ? (rate / fair - 1) * 100 : 0
                    });
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

        // The board's tiles, found by geometry rather than by DOM shape.
        //
        // The first attempt grouped candidates by parentElement and demanded
        // exactly N children — which fails the moment each tile sits in its own
        // wrapper div, and that is how the boards are actually built. Nothing
        // was ever marked. Tiles are instead identified by what makes them a
        // board: N elements of the SAME size, square, laid out on a regular
        // grid. That holds whatever the markup around them looks like.
        findMinesTiles() {
            const now = Date.now();
            if (this._minesTiles && (now - this._minesTilesAt) < 3000) return this._minesTiles;
            return safe(() => {
                const { tiles: want, cols } = this.minesBoardSize();
                const rows = Math.round(want / cols);
                const accept = (els) => {
                    this._minesTiles = els;
                    this._minesTilesAt = now;
                    this._minesBoardFound = true;
                    return els;
                };

                // 1. Stake labels every tile `data-testid="game-tile-N"`. When the
                //    game names its own board, trust that over any geometry guess —
                //    guessing by shape can lock onto the site's left nav, which is
                //    also a run of equal-sized squares on a regular grid.
                const tagged = Array.from(document.querySelectorAll('[data-testid^="game-tile-"]'))
                    .filter(el => !el.closest('#geminyzer-overlay'))
                    .map(el => ({ el, i: parseInt((String(el.dataset.testid).match(/(\d+)$/) || [])[1], 10) }))
                    .filter(x => Number.isFinite(x.i))
                    .sort((a, b) => a.i - b.i);
                if (tagged.length >= want) return accept(tagged.slice(0, want).map(x => x.el));

                // 2. Other sites don't tag their tiles, so fall back to shape: a
                //    block of equal-sized squares sitting on a regular grid.
                const buckets = new Map();
                const nodes = document.querySelectorAll('button, div, span, [role="button"], td, li, svg, canvas');
                for (const el of nodes) {
                    if (el.closest('#geminyzer-overlay')) continue;
                    const r = el.getBoundingClientRect();
                    if (r.width < 28 || r.height < 28 || r.width > 260) continue;
                    if (Math.abs(r.width - r.height) > r.width * 0.3) continue;   // square-ish
                    if (el.children.length > 3) continue;                          // a tile, not a container
                    const key = `${Math.round(r.width / 2)}x${Math.round(r.height / 2)}`;
                    if (!buckets.has(key)) buckets.set(key, []);
                    buckets.get(key).push({ el, r });
                }
                // Does this exact set of `want` tiles form a rows x cols grid?
                const isGrid = (picked) => {
                    if (picked.length !== want) return false;
                    const near = (vals, v) => vals.find(x => Math.abs(x - v) < 6);
                    const xs = [], ys = [];
                    for (const t of picked) {
                        if (near(xs, t.r.left) === undefined) xs.push(t.r.left);
                        if (near(ys, t.r.top) === undefined) ys.push(t.r.top);
                    }
                    return xs.length === cols && ys.length === rows;
                };
                let best = null;
                for (const [, list] of buckets) {
                    if (list.length < want) continue;
                    const cx = list.reduce((a, t) => a + t.r.left, 0) / list.length;
                    const cy = list.reduce((a, t) => a + t.r.top, 0) / list.length;
                    const picked = list.slice()
                        .sort((a, b) => Math.hypot(a.r.left - cx, a.r.top - cy) - Math.hypot(b.r.left - cx, b.r.top - cy))
                        .slice(0, want);
                    // Validate the tiles actually taken, not the bucket they came
                    // from. The old check passed as long as the BUCKET spanned
                    // enough rows and columns, so a bucket holding the board plus
                    // unrelated squares could hand back a set that was never a grid.
                    if (!isGrid(picked)) continue;
                    if (!best || picked.length > best.length) best = picked;
                }
                if (!best) {
                    this._minesTiles = null;
                    this._minesTilesAt = now;
                    this._minesBoardFound = false;
                    return null;
                }
                best.sort((a, b) => (Math.abs(a.r.top - b.r.top) > 6 ? a.r.top - b.r.top : a.r.left - b.r.left));
                return accept(best.map(t => t.el));
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
            const board = this.minesBoardSize();
            const expected = layouts ? layouts * (mineCount / board.tiles) : 0;
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
            const maxReveal = this.minesBoardSize().tiles - mineCount;
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
                <div class="vx-mines-grid" style="grid-template-columns:repeat(${board.cols}, 1fr)">${cells}</div>
                ${rankLine}
                ${regionLine}
                <div class="vx-mpick">
                    <select class="vx-mpsize" id="overlay-mines-size" title="How many tiles to pick">${sizeOpts}</select>
                    <button class="vx-mpbtn" id="overlay-mines-safest" title="The least-mined tiles in this history">Safest</button>
                    <button class="vx-mpbtn" id="overlay-mines-random" title="Drawn from the cleaner half, so it isn't the same tiles every round">Random safe</button>
                    <button class="vx-mpbtn" id="overlay-mines-clear" title="Clear the selection">Clear</button>
                </div>
                <div class="vx-msel">${pickLine}</div>
                <div class="vx-mines-note">${this._minesBoardFound === false
                    ? 'Couldn\'t find the game board to mark — the picks above are still valid, you just have to click them yourself. '
                    : 'Picks are marked on the board — revealing a tile is a real bet, so that click stays yours. '}Layouts are drawn fresh every round: this is where mines have been, not where they'll be.</div>
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
            const size = Math.min(this.minesPickSize || 3, Math.max(this.minesBoardSize().tiles - (this.minesCount || 1) - 1, 1));
            const clusters = this.minesClusters(size);
            if (!clusters.length) {
                // Empty because nothing cleared the sample bar, not because the
                // panel forgot — say which, or the section just vanishes.
                const { layouts } = this.minesAnalysis();
                if (layouts >= 10 && this.minesCount && size <= this.minesBoardSize().tiles - this.minesCount) {
                    return `<div class="vx-mines-note">No group of ${size} has come through clean more than once in ${layouts} rounds — nothing here worth reading yet.</div>`;
                }
                return '';
            }
            const rows = clusters.map(c => {
                const ev = c.rate * this.minesMultiplier(this.minesCount, c.tiles.length);
                const edgeCls = c.edge > 0 ? 'good' : 'bad';
                return `<div class="vx-mclust" data-tiles="${c.tiles.join(',')}" title="Clean together in ${c.clean} of ${c.rounds} rounds (${(c.raw * 100).toFixed(0)}% raw). An untouched board gives ${(c.fair * 100).toFixed(2)}%. Shown rate is shrunk toward that fair rate so a lucky round doesn't read as an edge. Click to select them.">
                            <span class="vx-mctiles">${c.tiles.map(t => t + 1).join(' · ')}</span>
                            <span class="vx-mcrate">${(c.rate * 100).toFixed(0)}%<i class="vx-mcn">${c.clean}/${c.rounds}</i></span>
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
                    <div class="vx-mchead vx-mc5"><span>Tiles you revealed</span><span>best</span><span>avg</span><span>plays</span><span title="Rounds since you last revealed this exact set. NOW means the round just played.">gap</span></div>
                    ${combos.map(c => `
                        <div class="vx-mclust vx-mc5" data-tiles="${c.tiles.join(',')}" title="Click to select these tiles. ${c.paid ? `${fmtMoney(c.pl, c.cur)} over ${c.paid} paid play${c.paid === 1 ? '' : 's'}${c.mixed ? ' (mixed currencies — no total shown)' : ''}` : 'Free plays only'}. Last played ${c.lastSeen === 0 ? 'this round' : `${c.lastSeen} rounds ago`}.">
                            <span class="vx-mctiles">${c.tiles.map(t => t + 1).join(' · ')}</span>
                            <span class="vx-mcrate">${this.fmtMult(c.best)}</span>
                            <span class="vx-mcedge">${c.avg.toFixed(2)}x</span>
                            <span class="vx-mcev">${c.plays}</span>
                            <span class="vx-mcgap ${c.lastSeen === 0 ? 'now' : ''}">${c.lastSeen === 0 ? 'NOW' : c.lastSeen}</span>
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
            const maxReveal = this.minesBoardSize().tiles - mineCount;
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

        // Draws since a specific combo last landed in full, and how many times it
        // has. Cheaper than computeHotGroups for a handful of saved combos, and
        // works for any size rather than one k at a time.
        // Tell you when a SAVED combo crosses into due or overdue territory.
        //
        // Favourites only, on purpose. The hot-groups table churns constantly, so
        // alerting on all of it would be noise; a starred combo is one you chose
        // to watch. Fires once per state per combo and re-arms when it hits.
        //
        // The wording stays neutral. A combo at 94% of its expected gap has the
        // same chance next round as one that just landed — the draw has no memory
        // — so this reports where the gap is, and does not suggest acting on it.
        checkGapAlerts() {
            safe(() => {
                if (this.numberCount !== 40) return;
                // Favourites plus anything you have actually played more than a
                // couple of times. Starring is friction and a combo you have been
                // betting is one you care about whether or not you remembered to
                // star it.
                //
                // It stops there for a reason. Being overdue is not rare — gaps
                // are geometric, so P(gap >= 1.5x expected) = e^-1.5, about 22%.
                // Measured on 600 draws: of 9,819 tracked 3-picks, 2,137 were
                // overdue at the same moment. Alerting on every tracked combo
                // means a couple of thousand notifications, which is why the set
                // is the ones with your money in them rather than all of them.
                // Hot Groups -> Overdue is the view for browsing the rest.
                const favs = Array.isArray(this.comboFavorites) ? this.comboFavorites : [];
                const hist = safe(() => this.computeComboHistory()) || {};
                const played = Object.keys(hist).filter(k => (hist[k]?.plays || 0) >= 3);
                const watch = [...new Set([...favs, ...played])].slice(0, 40);
                if (!watch.length) return;
                this._gapAlertState = this._gapAlertState || {};
                for (const key of watch) {
                    const nums = key.split('-').map(Number).filter(n => n >= 1 && n <= this.numberCount);
                    if (nums.length < 2 || nums.length > 10) continue;
                    const exp = this.expectedGroupGap(nums.length);
                    if (!isFinite(exp) || exp <= 0) continue;
                    const { gap } = this.comboGap(nums, 600);
                    if (gap === null) continue;
                    const ratio = gap / exp;
                    const state = gap === 0 ? 'now' : ratio >= 1.5 ? 'overdue' : ratio >= 0.8 ? 'due' : '';
                    const prev = this._gapAlertState[key];
                    if (state === prev) continue;
                    this._gapAlertState[key] = state;
                    const tag = favs.includes(key) ? 'saved' : 'played';
                    if (state === 'due' && prev !== 'overdue') {
                        this.showToast(`${key} (${tag}) is at ${Math.round(ratio * 100)}% of its expected gap — ${gap} of ~${Math.round(exp)} draws.`, 'due');
                    } else if (state === 'overdue') {
                        this.showToast(`${key} (${tag}) is past 1.5x its expected gap — ${gap} draws against ~${Math.round(exp)}.`, 'overdue');
                    }
                }
            });
        }

        // What the current ticket pays at each risk level.
        //
        // This is deliberately NOT a timing signal. Switching risk changes the
        // shape of the payout, never the odds: every row is built to the same
        // ~99% RTP, so the EV column barely moves while the spread column moves
        // a lot. On a 4-pick, High drops the 1.7x that lands 21% of the time and
        // pays 259x instead of 100x for the full hit — same expected return,
        // roughly 2.4x the standard deviation. That is the whole trade.
        renderKenoPayouts() {
            const el = this.overlay?.querySelector('#overlay-keno-payouts');
            if (!el) return;
            // 56-number Extreme runs a different table; don't show a wrong one.
            if (this.numberCount !== 40) { el.innerHTML = ''; return; }
            const picks = (this.currentSelectedCombo?.length)
                || this.data.selectedNumbers?.size || 0;
            if (!picks || picks < 1 || picks > 10) {
                el.innerHTML = `<div class="vx-combos-head"><span class="vx-section-title">Payouts</span></div>
                    <div class="vx-combos-empty">Pick 1-10 numbers to see what they pay.</div>`;
                return;
            }
            const open = !!this.kenoPayoutsOpen;
            const pFull = hyperP(picks, picks);
            const oneIn = pFull > 0 ? Math.round(1 / pFull) : Infinity;
            const head = `<div class="vx-mpayhead" id="overlay-keno-payhead"
                    title="Exact hypergeometric: all ${picks} of your picks inside the 10 drawn from 40.">
                    <span class="vx-section-title">Payouts</span>
                    <span class="vx-chcount">${picks} picks</span>
                    <span class="vx-mpaymax">all ${picks} · 1 in ${oneIn.toLocaleString()}</span>
                    <span class="vx-mcar">${open ? '▲' : '▼'}</span>
                </div>`;
            if (!open) { el.innerHTML = head; this._wireKenoPayouts(); return; }

            // Only show hit counts some risk level actually pays for.
            const cols = [];
            for (let h = 0; h <= picks; h++) {
                if (RISK_ORDER.some(r => (KENO_PAYOUTS[r][picks] || [])[h] > 0)) cols.push(h);
            }
            const fmt = (v) => !v ? '<span class="vx-kpz">—</span>'
                : (v >= 100 ? Math.round(v) : v.toFixed(v < 10 ? 2 : 1)) + 'x';
            const header = `<div class="vx-kprow vx-kphead"><span class="vx-kpname"></span>`
                + cols.map(h => `<span class="vx-kpcell">${h}</span>`).join('')
                + `<span class="vx-kpcell vx-kpev">RTP</span><span class="vx-kpcell vx-kpev">SPREAD</span></div>`;
            const rows = RISK_ORDER.map(r => {
                const st = ladderStats(r, picks);
                if (!st) return '';
                return `<div class="vx-kprow"><span class="vx-kpname">${r}</span>`
                    + cols.map(h => `<span class="vx-kpcell ${h === picks ? 'full' : ''}">${fmt(st.pay[h])}</span>`).join('')
                    + `<span class="vx-kpcell vx-kpev">${(st.ev * 100).toFixed(1)}%</span>`
                    + `<span class="vx-kpcell vx-kpev">${st.sd.toFixed(1)}</span></div>`;
            }).join('');
            el.innerHTML = head
                + `<div class="vx-kpwrap"><div class="vx-kptable">${header}${rows}</div></div>`
                + `<div class="vx-kpnote">Columns are hits. RTP is near-identical across rows — risk changes the spread, not the edge, and never the odds of hitting.</div>`;
            this._wireKenoPayouts();
        }

        _wireKenoPayouts() {
            const h = this.overlay?.querySelector('#overlay-keno-payhead');
            if (h) h.onclick = () => { this.kenoPayoutsOpen = !this.kenoPayoutsOpen; this.renderKenoPayouts(); };
        }

        // One status-strip tile, shared by the keno and mines strips.
        // Same markup and classes as the keno strip. It used to emit .vx-stat-k
        // / .vx-stat-v, whose CSS went away with the strip redesign — leaving the
        // mines strip unstyled and rendering "Games14" with no gap.
        statTile(label, value, cls = '', title = '') {
            const cls2 = cls === 'hot' ? 'vx-hot-txt' : cls === 'cold' ? 'vx-cold-txt' : cls === 'plneg' ? 'neg' : cls;
            return `<div class="vx-stat-item" title="${title}">`
                + `<span class="vx-stat-num ${cls2}">${value}</span>`
                + `<span class="vx-stat-txt">${label.toUpperCase()}</span></div>`;
        }

        kenoMarkup() {
            return `
                <div class="vx-status-strip" id="overlay-status-strip"></div>
                <div class="keno-heatmap-container">
                    <div class="keno-heatmap-header">
                        <span class="vx-section-title">HEATMAP</span>
                        <button class="vx-hm-mode-btn" id="overlay-heatmap-mode" title="Toggle Tiered vs Gradient color modes">${(this.heatmapMode || 'tiered').toUpperCase()}</button>
                    </div>
                    <div class="keno-heatmap-grid" id="overlay-keno-grid"></div>
                    <div class="quick-actions-container">
                        <div class="vx-strat-toggle" id="overlay-strat-toggle">
                            <button class="vx-st-btn on" data-stratview="main">Core</button>
                            <button class="vx-st-btn" data-stratview="alt">Alternative</button>
                            <span class="vx-spots" id="overlay-spots"></span>
                        </div>
                        <div class="quick-actions-grid" id="overlay-quick-actions">
                            </div>
                    </div>
                </div>
                <div class="vx-combos" id="overlay-keno-payouts"></div>
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
                adaptive: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
                regime: '<path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/>',
                edge: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
                portfolio: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/>',
                anticluster: '<line x1="7" y1="7" x2="16" y2="9"/><line x1="7" y1="7" x2="9" y2="16"/><line x1="16" y1="9" x2="17" y2="17"/><line x1="9" y1="16" x2="17" y2="17"/><circle cx="7" cy="7" r="2.2"/><circle cx="16" cy="9" r="2.2"/><circle cx="9" cy="16" r="2.2"/><circle cx="17" cy="17" r="2.2"/>',
                bayesian: '<path d="M4 4h16"/><path d="m4 4 8 8-8 8h16"/>',
                montecarlo: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1"/><circle cx="15.5" cy="8.5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="8.5" cy="15.5" r="1"/><circle cx="15.5" cy="15.5" r="1"/>',
                wheeling: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="3" x2="12" y2="21"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="5.6" y1="5.6" x2="18.4" y2="18.4"/><line x1="18.4" y1="5.6" x2="5.6" y2="18.4"/>',
                drought: '<polyline points="3 18 8 13 12 16 21 6"/><circle cx="8" cy="13" r="1"/><circle cx="12" cy="16" r="1"/>',
                balanced: '<path d="M12 3v18"/><path d="M5 7h14"/><path d="M5 7 2 13a3 3 0 0 0 6 0z"/><path d="M19 7l-3 6a3 3 0 0 0 6 0z"/><path d="M8 21h8"/>',
                momentum: '<path d="M9.59 4.59A2 2 0 1 1 11 8H2"/><path d="M17 12a2 2 0 1 0 2 2H2"/><path d="M14.83 19.41A2 2 0 1 0 16 23H2"/>',
                poisson: '<path d="M6.5 12c.94-3.46 4.94-6 8.5-6 3.56 0 6.06 2.54 7 6-.94 3.47-3.44 6-7 6s-7.56-2.53-8.5-6z"/><circle cx="16" cy="10" r="1"/><path d="M2 12s2 2 4 2"/>',
                repeat: '<polyline points="8 7 3 12 8 17"/><polyline points="16 7 21 12 16 17"/><line x1="3" y1="12" x2="21" y2="12"/>',
                successor: '<circle cx="5" cy="12" r="2.4"/><circle cx="19" cy="12" r="2.4"/><line x1="8" y1="12" x2="15" y2="12"/><polyline points="13 9 16 12 13 15"/>',
                cycle: '<path d="M3 12a9 9 0 1 1 3 6.7"/><polyline points="3 13 3 19 9 19"/><circle cx="12" cy="12" r="2"/>',
                runs: '<line x1="3" y1="16" x2="21" y2="16"/><rect x="4" y="9" width="2.6" height="5"/><rect x="7.6" y="9" width="2.6" height="5"/><rect x="11.2" y="9" width="2.6" height="5"/><rect x="17.4" y="9" width="2.6" height="5"/>'
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

            // Membership is measured, not chosen. Two numbers decide it, both taken
            // by replaying ~600 games and running every strategy at each step:
            //
            //   autonomy — how often the tile returns its OWN numbers rather than
            //     padding from Hot through its fallback. Measured on a fair board,
            //     which is what a player actually sees.
            //   own signal — hit rate on just those autonomous steps, against a
            //     board with a real bias planted in it. A strategy that cannot
            //     beat 0.25 when the bias genuinely exists cannot beat it anywhere.
            //
            // Promoted from Alternative, all at 100% autonomy with a real signal
            // that was sitting behind a toggle: Coverage (z +7.5), Repeat (+5.6),
            // Portfolio (+4.7), Wheeling (+4.3).
            //
            // Demoted: Overdue is autonomous only 24% of the time. Smart (z +0.5)
            // and Entropy (+1.3) are their own work but showed no signal against a
            // real bias. Parity was demoted for being autonomous 0% of the time and
            // has since been removed outright — it returned Hot's exact set.
            //
            // Cold and Variance stay despite negative z. They are contrarian by
            // construction, so underperforming against a planted bias is them
            // working, not failing.
            // Ordered as a testing path, not a ranking. Each row is a different
            // KIND of read, so walking the grid one tile at a time tries a new
            // signal each click instead of re-testing the same axis; and rows go
            // in the order the data becomes usable (measured: how many games
            // before a tile stops padding from Hot and is actually itself).
            //
            // Row 1 is live from ~10 games, rows 2-3 from ~20-30. Random sits
            // last as the control you are comparing everything against.
            const defaultPortfolio = [
                // Row 1 - Frequency. Usable almost immediately.
                { id: 'hot', name: 'Hot' },
                { id: 'cold', name: 'Cold' },
                { id: 'smart', name: 'Smart' },
                { id: 'ema', name: 'EMA' },

                // Row 2 - Timing: how numbers space themselves out. From ~20-30.
                { id: 'overdue', name: 'Overdue' },
                { id: 'progressive', name: 'Progressive' },
                { id: 'streak', name: 'Streak' },
                { id: 'entropy', name: 'Entropy' },

                // Row 3 - Where numbers sit, and how their gaps behave.
                // Realised held the second slot and moved to Alternative: it scores
                // a number by the P/L of every bet that contained it, so a winning
                // ticket credits all nine numbers equally whether they were drawn
                // or not. Volatility takes the slot with a gap-shape read instead.
                // Coverage moved out of the fourth for Poisson, which measures the
                // same waiting time Coverage only approximates through heat.
                { id: 'positional', name: 'Positional' },
                { id: 'volatility', name: 'Volatility' },
                { id: 'digitbias', name: 'Digit' },
                { id: 'poisson', name: 'Poisson' },

                // Row 4 - Statistical treatments, then the control. Anti-Cluster
                // replaces Anti-Pattern here: both are contrarian, but Anti-Cluster
                // builds its set from measured co-occurrence rather than excluding
                // whatever happens to have come up lately.
                { id: 'montecarlo', name: 'Monte Carlo' },
                { id: 'variance', name: 'Variance' },
                { id: 'anticluster', name: 'Anti-Cluster' },
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
            safe(() => this.refreshSpotBadges());
            safe(() => this.probeHandoffs());
            // Re-apply the AI gold-glow if its pick lives in this view.
            safe(() => this.updateAIRecommendation());
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
                    // Go through runStrategy like the Core grid does. Calling the
                    // select* method directly skipped the spot count entirely —
                    // every Alternative tile fell back to the getter's default of
                    // 9, ignoring both Auto and a pin — and skipped the hand-off
                    // check, so an Alt tile never showed that it was borrowing.
                    this.runStrategy(id, this.getSelectMethodName(id));
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
            safe(() => this.refreshSpotBadges());
            safe(() => this.probeHandoffs());
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
        // Same idea, ordered by what the measurement says is worth trying.
        // Row 1 earned a Core slot on signal alone and only missed out because
        // Core is full; row 4 is here because it measured no signal at all.
        SIDE_DRAWER_DEFAULTS = [
            // Real own signal, 100% autonomous
            { id: 'repeat', name: 'Repeat' },
            { id: 'portfolio', name: 'Portfolio' },
            { id: 'wheeling', name: 'Wheeling' },
            { id: 'momentum', name: 'Momentum' },
            { id: 'successor', name: 'Successor' },
            // Blends and meta — these compose other strategies by design
            { id: 'adaptive', name: 'Adaptive' },
            { id: 'edge', name: 'Edge' },
            { id: 'regime', name: 'Regime' },
            { id: 'bayesian', name: 'Bayesian' },
            // Situational — need a specific condition to say anything
            { id: 'drought', name: 'Drought' },
            { id: 'hotzone', name: 'Hotzone' },
            { id: 'cycle', name: 'Cycle' },
            { id: 'runs', name: 'Runs' },
            // Contrarian / no measured signal
            { id: 'balanced', name: 'Balanced' },
            { id: 'transition', name: 'Transition' },
            { id: 'antipattern', name: 'Anti-Pattern' }
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
            return this.selectMethodMap()[strategyId];
        }

        selectMethodMap() {
            const map = {
                'hot': 'selectHotNumbers',
                'cold': 'selectColdNumbers',
                'smart': 'selectSmartNumbers',
                'random': 'selectRandomNumbers',
                'successor': 'selectSuccessorNumbers',
                'cycle': 'selectCycleNumbers',
                'runs': 'selectRunsNumbers',
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
                'adaptive': 'selectAdaptiveNumbers',
                'regime': 'selectRegimeNumbers',
                'edge': 'selectEdgeNumbers',
                'portfolio': 'selectPortfolioNumbers',
                'anticluster': 'selectAntiClusterNumbers',
                // Re-added historical strategies
                'bayesian': 'selectBayesianNumbers',
                'montecarlo': 'selectMonteCarloNumbers',
                'wheeling': 'selectWheelingNumbers',
                'drought': 'selectDroughtReboundNumbers',
                'balanced': 'selectBalancedNumbers',
                'momentum': 'selectMomentumNumbers',
                'poisson': 'selectPoissonNumbers',
                'repeat': 'selectRepeatChaserNumbers'
            };
            return map;
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
                    this.runStrategy(strategyId, methodName);
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
                        this.runStrategy(strategyId, methodName);
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

        showToast(message, kind = '') {
            const toast = document.createElement('div');
            toast.className = `vx-toast ${kind}`;
            toast.textContent = message;
            document.body.appendChild(toast);
            setTimeout(() => toast.classList.add('out'), 5200);
            setTimeout(() => toast.remove(), 5600);
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
                    this.runStrategy(strategyId, methodName);
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
                   /* No backdrop-filter: the background is opaque so the blur was
                      invisible, and Firefox re-blurs the live page behind it on
                      every frame the game animates. */
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
                   font-size: 11px;
                   font-weight: 700;
                   color: #3fb950;
                   letter-spacing: 0.5px;
                   margin-left: -2px;
               }

               .overlay-site-badge {
                   font-size: 11px;
                   font-weight: 600;
                   color: #8b949e;
                   background: rgba(255, 255, 255, 0.06);
                   border: 1px solid rgba(255, 255, 255, 0.10);
                   border-radius: 5px;
                   padding: 1px 7px;
                   margin-left: 6px;
                   letter-spacing: 0.2px;
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

                /* No second-click marker: the spot badge already shows the number
                   the next click will play, and the mode resets whenever you move
                   to another tile, so there is no state to advertise. */

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
               align-items: center;
               gap: 4px;
               margin-bottom: 8px;
           }
           .vx-spots { display: inline-flex; align-items: center; gap: 4px; margin-left: auto; }
           .vx-spot-auto, .vx-spot-sel {
               background: #10161f;
               border: 1px solid rgba(255, 255, 255, 0.10);
               color: #8b949e;
               border-radius: 6px;
               padding: 3px 7px;
               font-family: inherit;
               font-size: 10px;
               font-weight: 600;
               cursor: pointer;
           }
           .vx-spot-auto.on { background: rgba(63, 185, 80, 0.16); border-color: rgba(63, 185, 80, 0.5); color: #3fb950; }
           .vx-spot-sel { padding: 3px 2px; }
           .vx-spot-k { font-size: 9px; color: #6e7681; text-transform: uppercase; letter-spacing: 0.5px; }
           .action-item { position: relative; }
           .vx-spot-badge {
               position: absolute;
               top: 2px;
               right: 4px;
               font-size: 8px;
               font-weight: 700;
               color: #6e7681;
               font-variant-numeric: tabular-nums;
               pointer-events: none;
           }
           .vx-spot-badge.pinned { color: #3fb950; }
           /* A tile currently returning another strategy's ticket. This used to
              print "-> Name" absolutely at bottom:-2px, which landed straight on
              top of .action-label. It is a state of the tile, not a third line
              of text: dim it and put an amber dot in the free corner, with the
              full sentence on the tile's title. */
           .vx-borrowed .action-btn-lg {
               opacity: 0.5;
               border-style: dashed;
           }
           .vx-borrowed .action-label { opacity: 0.6; }
           .vx-borrowed::before {
               content: '';
               position: absolute;
               top: 3px;
               left: 4px;
               width: 4px;
               height: 4px;
               border-radius: 50%;
               background: #d29922;
               pointer-events: none;
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

           /* ---- Keno payout ladder ---- */
           .vx-kpwrap { overflow-x: auto; }
           .vx-kptable { min-width: 100%; font-variant-numeric: tabular-nums; }
           .vx-kprow {
               display: flex; align-items: center; gap: 2px;
               padding: 2px 0;
               border-bottom: 1px solid rgba(255, 255, 255, 0.04);
           }
           .vx-kprow:last-child { border-bottom: 0; }
           .vx-kphead { color: #6e7681; font-size: 8px; text-transform: uppercase; letter-spacing: 0.4px; }
           .vx-kpname {
               flex: 0 0 52px; font-size: 9px; font-weight: 600;
               color: #8b949e; text-transform: capitalize;
           }
           .vx-kpcell {
               flex: 1 1 0; min-width: 30px; text-align: center;
               font-size: 9px; color: #c9d1d9;
           }
           .vx-kpcell.full { color: #3fb950; font-weight: 700; }
           .vx-kpz { color: #4a5260; }
           .vx-kpev { flex: 0 0 38px; color: #8b949e; }
           .vx-kpnote {
               margin-top: 5px; font-size: 8px; line-height: 1.35;
               color: #6e7681;
           }

           /* ---- Toast ---- */
           .vx-toast {
               position: fixed; top: 18px; right: 18px; z-index: 2147483000;
               max-width: 320px;
               background: #161c26;
               border: 1px solid rgba(255, 255, 255, 0.10);
               border-left: 3px solid #6e7681;
               border-radius: 8px;
               padding: 9px 12px;
               font-family: 'Ubuntu', system-ui, sans-serif;
               font-size: 11px; line-height: 1.4; color: #e6edf3;
               box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
               opacity: 1; transition: opacity 0.35s ease, transform 0.35s ease;
           }
           .vx-toast.due { border-left-color: #d29922; }
           .vx-toast.overdue { border-left-color: #e5534b; }
           .vx-toast.out { opacity: 0; transform: translateY(-6px); }

            /* ---- Status strip ---- */
            .vx-status-strip {
                display: flex;
                align-items: center;
                justify-content: space-around;
                padding: 9px 12px;
                background: transparent;
                border-bottom: 1px solid rgba(255, 255, 255, 0.08);
            }
            .vx-stat-item {
                display: flex;
                align-items: baseline;
                gap: 5px;
            }
            .vx-stat-num {
                font-size: 13px;
                font-weight: 700;
                color: #e6edf3;
                font-variant-numeric: tabular-nums;
            }
            .vx-stat-txt {
                font-size: 10px;
                font-weight: 600;
                color: #6e7681;
                letter-spacing: 0.5px;
            }
            .vx-stat-num.vx-hot-txt { color: #3fb950; }
            .vx-stat-num.vx-cold-txt { color: #58a6ff; }
            .vx-stat-num.pos { color: #3fb950; }
            .vx-stat-num.neg { color: #e5534b; }

            /* ---- Heatmap header & mode ---- */
            .keno-heatmap-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin-bottom: 8px;
            }
            .vx-hm-mode-btn {
                background: rgba(255, 255, 255, 0.05);
                border: 1px solid rgba(255, 255, 255, 0.12);
                color: #8b949e;
                border-radius: 5px;
                padding: 2px 8px;
                font-size: 10px;
                font-weight: 600;
                cursor: pointer;
                letter-spacing: 0.5px;
                transition: all 0.12s ease;
            }
            .vx-hm-mode-btn:hover {
                color: #3fb950;
                border-color: rgba(63, 185, 80, 0.4);
                background: rgba(63, 185, 80, 0.08);
            }

            /* ---- Heatmap momentum arrows ---- */
            .heatmap-number { position: relative; }
            .vx-mom {
                position: absolute;
                top: 1px;
                right: 1px;
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
            /* view tabs: clean underline tabs */
            .vx-gtabs {
                display: flex;
                gap: 8px;
                margin-bottom: 8px;
                border-bottom: 1px solid rgba(255, 255, 255, 0.07);
                padding-bottom: 4px;
            }
            .vx-gtab {
                flex: 1;
                background: transparent;
                border: none;
                border-bottom: 2px solid transparent;
                color: #8b949e;
                padding: 4px 0;
                font-size: 11px;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.12s ease;
                text-align: center;
            }
            .vx-gtab:hover { color: #e6edf3; }
            .vx-gtab.on {
                color: #3fb950;
                border-bottom: 2px solid #3fb950;
                background: transparent;
            }
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
            .vx-grow.selected-group {
                border-color: rgba(63, 185, 80, 0.7);
                background: rgba(63, 185, 80, 0.08);
            }
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
                width: 32px;
                text-align: right;
                font-size: 10px;
                color: #8b949e;
            }
            .vx-gcell.heat { color: #3fb950; }
            .vx-gcell.gap.now { color: #3fb950; font-weight: 600; }
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
            .vx-sp-row1 {
                display: flex;
                align-items: center;
                gap: 6px;
                margin-bottom: 8px;
            }
            .vx-sp-btn {
                flex: 1;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 4px;
                background: #141b25;
                border: 1px solid rgba(255, 255, 255, 0.08);
                color: #8b949e;
                border-radius: 6px;
                padding: 4px 4px;
                font-size: 10px;
                font-weight: 600;
                line-height: 1.15;
                cursor: pointer;
                transition: all 0.12s ease;
            }
            .vx-sp-btn:hover {
                color: #e6edf3;
                border-color: rgba(255, 255, 255, 0.2);
            }
            .vx-sp-btn.on {
                background: rgba(63, 185, 80, 0.15);
                border-color: rgba(63, 185, 80, 0.5);
                color: #3fb950;
            }
            .vx-sp-icon {
                font-size: 10px;
                line-height: 1.15;
            }
            .vx-sp-select-wrap {
                flex: 0 0 auto;
            }
            .vx-sp-select-wrap .vx-spsize {
                height: 21.5px;
                padding: 0 4px;
                line-height: 1.15;
                background: #10161f;
                border: 1px solid rgba(255, 255, 255, 0.08);
                color: #e6edf3;
                border-radius: 6px;
                font-size: 10px;
                font-weight: 600;
                cursor: pointer;
            }
            .vx-sp-nums-row {
                margin-bottom: 6px;
            }
            .vx-sp-nums-list {
                padding: 3px 4px;
                text-align: center;
                font-size: 12px;
                font-weight: 600;
                color: #e6edf3;
                letter-spacing: 0.6px;
            }
            .vx-sp-stats-grid {
                display: grid;
                grid-template-columns: repeat(5, 1fr);
                gap: 4px;
                background: #0f151e;
                border: 1px solid rgba(255, 255, 255, 0.06);
                border-radius: 6px;
                padding: 6px 4px;
            }
            .vx-sp-col {
                display: flex;
                flex-direction: column;
                align-items: center;
                gap: 2px;
            }
            .vx-sp-k {
                font-size: 9px;
                font-weight: 600;
                color: #6e7681;
                letter-spacing: 0.5px;
            }
            .vx-sp-v {
                font-size: 11px;
                font-weight: 700;
                color: #c9d1d9;
                font-variant-numeric: tabular-nums;
            }
            .vx-sp-v.pos { color: #3fb950; }
            .vx-sp-v.neg { color: #e5534b; }
            .vx-sp-v.now { color: #3fb950; }
            .vx-sp-v.due { color: #d6a700; }
            .vx-sp-v.overdue { color: #e0913a; text-shadow: 0 0 6px rgba(224, 145, 58, 0.85); }

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
           }
           /* the revealed-combo table carries a gap column too */
           .vx-mchead.vx-mc5, .vx-mclust.vx-mc5 {
               grid-template-columns: 1fr 40px 40px 30px 34px;
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
           /* the sample behind the rate — a rate without it invites over-reading */
           .vx-mcn { font-style: normal; font-size: 8px; color: #6e7681; margin-left: 3px; font-weight: 500; }
           .vx-mcedge.good { color: #3fb950; }
           .vx-mcedge.bad { color: #e5534b; }
           .vx-mcev { color: #8b949e; }
           .vx-mcgap { color: #8b949e; font-variant-numeric: tabular-nums; }
           .vx-mcgap.now { color: #3fb950; font-weight: 700; }
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
            // The spot-size alternation resets itself whenever the clicked tile
            // changes (see afterStrategyRun), so there is nothing to clear here.

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
            const checkUrl = () => {
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
            };
            clearInterval(this._urlPollHandle);
            // Poll instead of observing every DOM mutation on the page: the
            // casino re-renders constantly (bet feeds, balance, animations) and a
            // document-wide subtree observer fired on all of it.
            this._urlPollHandle = setInterval(checkUrl, 1000);
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

                    log('[Vantedge] Roobet: Found container with', roobetContainer?.querySelectorAll('label').length || 0, 'labels');

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

                        log('[Vantedge] Roobet: Found', foundButtons.length, 'buttons');

                        if (foundButtons.length >= 35) {
                            const uniqueMap = new Map();
                            foundButtons.forEach(item => uniqueMap.set(item.number, item));
                            bestMatch = Array.from(uniqueMap.values())
                                .sort((a, b) => a.number - b.number)
                                .map(item => item.element);

                            log('[Vantedge] Roobet: Returning', bestMatch.length, 'unique buttons');
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
                    // Current board: <button class="tile" data-testid="game-tile-38">
                    // <div class="tile-face"><span class="tile-number">38</span>
                    // <div class="cover"><span class="tile-number">38</span></div></div>.
                    // The number is printed twice (face + cover), so the button reads
                    // "38 38" - match the face span only.
                    selector = 'button[data-testid^="game-tile-"] .tile-face > span.tile-number, button.tile > span.tile-number, button.tile > span, button[data-testid^="tile-"] span';
                    parentSelector = 'button';
                }

                let gameContainer = containerSelector ? document.querySelector(containerSelector) : document.body;
                if (!gameContainer && site === 'stake') {
                    const testButton = document.querySelector('button[data-testid^="game-tile-"], button[data-testid^="tile-"]');
                    gameContainer = testButton?.parentElement || document.body;
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
                    if (bestMatch.length < 35) bestMatch = this.genericKenoDetection(maxN);
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

        // Markup-agnostic board finder for when a site's classes change.
        // Starts from text nodes reading exactly 1..maxN, takes the outermost
        // element still reading just that number as the tile (or the button
        // around it), then picks the tightest container holding 35+ distinct
        // numbers. Text nodes keep this cheap on large pages.
        genericKenoDetection(maxN = 40) {
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            const tiles = [];
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                const text = node.data.trim();
                if (!/^\d{1,2}$/.test(text)) continue;
                const num = parseInt(text, 10);
                if (num < 1 || num > maxN) continue;
                let el = node.parentElement;
                if (!el || el.closest('#geminyzer-overlay')) continue;
                while (el.parentElement && el.parentElement !== document.body &&
                       (el.parentElement.textContent || '').trim() === text) {
                    el = el.parentElement;
                }
                const btn = el.closest('button, [role="button"]');
                if (btn && (btn.textContent || '').trim() === text) el = btn;
                const rect = el.getBoundingClientRect();
                if (rect.width < 20 || rect.height < 20) continue;
                tiles.push({ el, num });
            }

            // Tightest ancestor (up to 4 levels above a tile) holding 35+ numbers.
            const counts = new Map();
            tiles.forEach(t => {
                let a = t.el.parentElement;
                for (let d = 0; a && d < 4; d++, a = a.parentElement) {
                    if (!counts.has(a)) counts.set(a, { depth: d, nums: new Set() });
                    const c = counts.get(a);
                    c.nums.add(t.num);
                    c.depth = Math.min(c.depth, d);
                }
            });
            let best = null;
            counts.forEach((c, a) => {
                if (c.nums.size < 35) return;
                if (!best || c.depth < best.depth) best = { a, depth: c.depth };
            });
            if (!best) return [];

            const byNum = new Map();
            tiles.forEach(t => {
                if (!byNum.has(t.num) && best.a.contains(t.el)) byNum.set(t.num, t.el);
            });
            return Array.from(byNum.entries()).sort((x, y) => x[0] - y[0]).map(e => e[1]);
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

        gradientHeatStyle(val, minVal, maxVal) {
            if (maxVal === minVal) {
                return {
                    background: 'rgb(224, 177, 70)',
                    borderColor: 'rgba(0, 0, 0, 0.25)',
                    color: '#111827'
                };
            }
            const t = Math.max(0, Math.min(1, (val - minVal) / (maxVal - minVal)));
            const stops = [
                { t: 0.0, c: [229, 115, 115] },  // coral red
                { t: 0.25, c: [243, 156, 18] },  // warm orange
                { t: 0.5, c: [224, 177, 70] },   // amber yellow
                { t: 0.75, c: [139, 195, 74] },  // lime green
                { t: 1.0, c: [46, 204, 113] }    // emerald green
            ];
            let lower = stops[0], upper = stops[stops.length - 1];
            for (let i = 0; i < stops.length - 1; i++) {
                if (t >= stops[i].t && t <= stops[i + 1].t) {
                    lower = stops[i];
                    upper = stops[i + 1];
                    break;
                }
            }
            const range = upper.t - lower.t || 1;
            const factor = (t - lower.t) / range;
            const r = Math.round(lower.c[0] + (upper.c[0] - lower.c[0]) * factor);
            const g = Math.round(lower.c[1] + (upper.c[1] - lower.c[1]) * factor);
            const b = Math.round(lower.c[2] + (upper.c[2] - lower.c[2]) * factor);
            const textCol = t < 0.12 ? '#ffffff' : '#111827';
            return {
                background: `rgb(${r}, ${g}, ${b})`,
                borderColor: 'rgba(0, 0, 0, 0.2)',
                color: textCol
            };
        }

        populateHeatmap() {
            const grid = this.overlay.querySelector('#overlay-keno-grid');
            if (!grid) return;

            const modeBtn = this.overlay.querySelector('#overlay-heatmap-mode');
            if (modeBtn) {
                modeBtn.textContent = (this.heatmapMode || 'tiered').toUpperCase();
                modeBtn.onclick = () => {
                    this.heatmapMode = (this.heatmapMode === 'tiered') ? 'gradient' : 'tiered';
                    modeBtn.textContent = this.heatmapMode.toUpperCase();
                    const browserAPI = (typeof browser !== 'undefined') ? browser : chrome;
                    browserAPI?.storage?.local?.set({ heatmapMode: this.heatmapMode });
                    this.populateHeatmap();
                };
            }

            const N = this.numberCount;
            const hotNumbers = this.data.kenoStats.hotNumbers;
            const totalOccurrences = hotNumbers.reduce((a, b) => a + b, 0);
            const average = totalOccurrences / N; // expected draws per number
            const { maxAbove, maxBelow } = heatSpread(hotNumbers, average);

            const minCount = Math.min(...hotNumbers);
            const maxCount = Math.max(...hotNumbers);
            const isGradient = this.heatmapMode === 'gradient';

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

                let style;
                if (totalOccurrences === 0) {
                    style = HEAT_EMPTY;
                } else if (isGradient) {
                    style = this.gradientHeatStyle(occurrences, minCount, maxCount);
                } else {
                    style = heatStyle(average > 0 ? occurrences / average : 1, maxAbove, maxBelow);
                }
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
            const testId = element.getAttribute?.('data-testid') || '';
            const m = testId.match(/^game-tile-(\d+)$/);
            if (m) return parseInt(m[1], 10);
            return parseInt((element.textContent || element.innerText || '').trim(), 10);
        }

        animateSequentialSelection(numbers) {
            if (!numbers || numbers.length === 0) {
                console.warn("Vantedge: A strategy returned no numbers to select.");
                return;
            }

            this.currentSelectedCombo = [...numbers].sort((a, b) => a - b);
            safe(() => this.renderSmartPicker());
            safe(() => this.renderHotCombos());

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

        // Spots a strategy runs at: the pin if one is set, else its tuned size.
        // A pin always wins -- it is the user saying what they want outright.
        // On Auto, a strategy with two modes alternates between them per click.
        spotsFor(strategyId) {
            if (this.spotMode !== 'auto') return Math.max(1, Math.min(10, Number(this.spotMode) || SPOTS_DEFAULT));
            const modes = STRATEGY_SPOTS[strategyId];
            if (!Array.isArray(modes) || !modes.length) return SPOTS_DEFAULT;
            // Second click only counts while you stay on the same tile. Moving to
            // another strategy starts it fresh on its own first (larger) size.
            const second = modes.length > 1
                && this._spotFor === strategyId
                && this._spotSecond === true;
            return second ? modes[1] : modes[0];
        }

        // Does this tile have a second click at all?
        hasSecondMode(strategyId) {
            const m = STRATEGY_SPOTS[strategyId];
            return Array.isArray(m) && m.length > 1;
        }

        renderSpotControl() {
            const el = this.overlay?.querySelector('#overlay-spots');
            if (!el) return;
            const pinned = this.spotMode !== 'auto';
            const opts = [2, 3, 4, 5, 6, 7, 8, 9, 10]
                .map(n => `<option value="${n}" ${pinned && Number(this.spotMode) === n ? 'selected' : ''}>${n}</option>`).join('');
            el.innerHTML = `
                <button class="vx-spot-auto ${pinned ? '' : 'on'}" id="overlay-spots-auto"
                    title="Auto — each strategy runs at its own size, and clicking a tile again plays its smaller, more concentrated version. Pick a number instead to pin every strategy to it.">Auto</button>
                <select class="vx-spot-sel" id="overlay-spots-sel" title="Pin every strategy to this many numbers">
                    <option value="" ${pinned ? '' : 'selected'}>–</option>${opts}
                </select>
                <span class="vx-spot-k">spots</span>`;
            const setMode = (mode) => {
                this.spotMode = mode;
                const api = (typeof browser !== 'undefined') ? browser : chrome;
                safe(() => api?.storage?.local?.set({ spotMode: mode }));
                this.renderSpotControl();
                safe(() => this.refreshSpotBadges());
            safe(() => this.probeHandoffs());
            };
            el.querySelector('#overlay-spots-auto').onclick = () => setMode('auto');
            el.querySelector('#overlay-spots-sel').onchange = (e) => {
                const v = e.target.value;
                setMode(v === '' ? 'auto' : Number(v));
            };
            safe(() => this.refreshSpotBadges());
            safe(() => this.probeHandoffs());
        }

        // Show on each tile how many numbers it will fill, so a click is never
        // a surprise — the strategy's own size on Auto, the pin when pinned.
        refreshSpotBadges() {
            const items = [
                ...(this.overlay?.querySelectorAll('.action-item') || []),
                ...document.querySelectorAll('#overlay-side-actions .action-item')
            ];
            items.forEach(item => {
                const id = item.dataset.strategyId;
                if (!id) return;
                let badge = item.querySelector('.vx-spot-badge');
                if (!badge) {
                    badge = document.createElement('span');
                    badge.className = 'vx-spot-badge';
                    item.appendChild(badge);
                }
                // On a pin the header already reads "N SPOTS", so repeating N on
                // every tile is noise. On Auto the badge always shows, because
                // every strategy now has its own size and half of them change it
                // on a second click -- that is exactly when the number matters.
                // (This used to hide the badge whenever the count equalled
                // SPOTS_DEFAULT, which made nine tiles go blank once the table
                // stopped being mostly 6s.)
                const n = this.spotsFor(id);
                badge.textContent = this.spotMode === 'auto' ? n : '';
                badge.classList.toggle('pinned', false);
            });
        }

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
        // Numbers running furthest BELOW their expected frequency, by z-score.
        //
        // This ranked (observed − expected) descending, which selects the most
        // OVER-drawn numbers — the same end of the board as Hot, so the two
        // strategies largely returned the same ticket. Scoring the deficit
        // instead gives Variance its own half of the distribution.
        //
        // Kept as a plain z-score, deliberately: the Stats picker already
        // weights the same deficit by how overdue each number is, so leaving
        // that out here keeps the two distinguishable — Variance is the pure
        // statistical reading, Stats the one that also chases the gap.
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
            // The mode flip lives in afterStrategyRun now, for every strategy that
            // has two modes. Doing it here as well would flip it twice per click.
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
                    if (s.count < 5 || s.entropy <= 0 || s.avgInterval <= 0) return { n: i + 1, score: 0 };
                    // Coefficient of variation, the mirror of what Entropy ranks.
                    // `entropy` is the spread of the number's gaps in games, and
                    // raw spread scales with gap length, so ranking it directly
                    // just surfaced whichever numbers were rarest. Dividing by the
                    // mean gap makes it a shape measure — genuinely erratic rather
                    // than merely infrequent. Weighted by appearances so a number
                    // seen five times can't out-rank one seen fifty on noise.
                    const cv = s.entropy / s.avgInterval;
                    return { n: i + 1, score: cv * Math.log(s.count + 1) };
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

            const blockHits = new Float32Array(N);
            let bestBlockZ = 0;
            for (let r = 0; r + H <= rows; r++) {
                for (let c = 0; c + W <= cols; c++) {
                    let observed = 0;
                    for (let dr = 0; dr < H; dr++)
                        for (let dc = 0; dc < W; dc++)
                            observed += cellHit(r + dr, c + dc);
                    // sqrt(expectedBlock) is a Poisson SD, and it is WRONG for a
                    // 10-of-40 draw without replacement -- the true SD is smaller.
                    // Do not "fix" it in isolation. Scanning 28 overlapping blocks
                    // and keeping the largest z inflates false positives, and this
                    // too-large SD deflates them by almost exactly as much. Measured
                    // on simulated fair boards, the pair cancels: the gate below
                    // fires on 3.4-4.9% of fair boards (nominal 5%). Substituting
                    // the correct SD while leaving the 2.5 threshold alone takes
                    // that to 14-17%. Either leave both, or replace the whole gate
                    // with a scan statistic against a simulated null.
                    const z = (observed - expectedBlock) / Math.sqrt(expectedBlock || 1);
                    if (z > bestBlockZ) bestBlockZ = z;
                    for (let dr = 0; dr < H; dr++)
                        for (let dc = 0; dc < W; dc++) {
                            const i = (r + dr) * cols + (c + dc);
                            if (i >= 0 && i < N && observed > blockHits[i]) blockHits[i] = observed;
                        }
                }
            }

            // No block stands out — say so by handing back Hot rather than
            // dressing the same ranking up as a zone read.
            if (bestBlockZ <= 2.5) return this.getHotNumbers(count);

            // A block IS significant: take the numbers inside the strongest
            // blocks and order them by gap. Blending 0.5 × hit count into the
            // score (as before) let frequency outvote the zone and returned
            // Hot's ticket anyway.
            const cut = Math.max(...blockHits) * 0.9;
            const pool = [];
            for (let i = 0; i < N; i++) if (blockHits[i] >= cut) pool.push(i + 1);
            const ranked = this._byOverdue(pool);
            if (ranked.length >= count) return ranked.slice(0, count).sort((a, b) => a - b);
            const fill = this.getHotNumbers(count * 2).filter(n => !ranked.includes(n));
            return [...ranked, ...fill].slice(0, count).sort((a, b) => a - b);
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

                const lambda = totalBets / s.count;
                const survival = 1 - this.poissonCDF(Math.max(s.betsSince - 1, 0), lambda);
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
        selectPoissonNumbers() {
            const numbers = this.getPoissonNumbers();
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
        // Most-overdue-first ordering for a pool of numbers. Used by the frame
        // strategies (digit families, board zones): the frame decides WHICH pool
        // is interesting, this decides which numbers inside it to take. Scoring
        // the pool by hit count instead is what collapsed them onto Hot.
        _byOverdue(pool) {
            const stats = this.data.kenoStats.perNumberStats || [];
            const fallbackGap = this.numberCount / (this._drawnPerGame || 10);
            return pool.map(n => {
                const st = stats[n - 1];
                const avg = st && st.avgInterval > 0 ? st.avgInterval : fallbackGap;
                return { n, ratio: st ? (st.betsSince || 0) / avg : 0 };
            }).sort((a, b) => b.ratio - a.ratio).map(x => x.n);
        }

        // Digit families (…1, …2, …) scored against their expected share, then
        // picked inside the winning families by gap.
        //
        // It used to multiply each number's own hit count by a small family
        // weight (±40% at most), so the raw count decided the order and the
        // result was Hot's ticket. Now the family z-score decides which pool to
        // draw from, and the pool is ordered by overdue — the frequency signal
        // can no longer leak into the number-level choice.
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

        // --- Strategy: Wheeling (Correlation-Based Way Tickets) ---
        // Pair counts over the recent draws, keyed "lo-hi". Built here rather than
        // waiting on the service worker's correlation round-trip: Wheeling used to
        // fall back to Hot whenever that message hadn't landed, which made it Hot
        // most of the time and silently.
        pairCounts(limit = 150) {
            const N = this.numberCount;
            const draws = this.getRecentDraws(limit);
            const cache = this._pairCache;
            if (cache && cache.n === draws.length && cache.limit === limit) return cache.map;
            const map = Object.create(null);
            for (const d of draws) {
                const u = [...new Set(d)].filter(n => n >= 1 && n <= N).sort((a, b) => a - b);
                for (let i = 0; i < u.length; i++)
                    for (let j = i + 1; j < u.length; j++)
                        map[`${u[i]}-${u[j]}`] = (map[`${u[i]}-${u[j]}`] || 0) + 1;
            }
            this._pairCache = { n: draws.length, limit, map, draws: draws.length };
            return map;
        }

        getWheelingNumbers(count = 9) {
            if (this.data.kenoStats.totalBets < 20) return this.getHotNumbers(count);
            const WINDOW = 150;
            const pairs = this.pairCounts(WINDOW);
            // Mean and sd of a pair's co-occurrence count over the window actually
            // available, so a short session is not judged against a full one.
            const seen = Math.min(WINDOW, this.data.kenoStats.totalBets || WINDOW);
            const d = this._drawnPerGame || 10, NN = this.numberCount;
            const pPair = (d / NN) * ((d - 1) / (NN - 1));
            const pairGate = seen * pPair + 3 * Math.sqrt(seen * pPair * (1 - pPair));
            const pairEntries = Object.entries(pairs)
                // A pair co-occurs with probability (10/40)(9/39) = 0.0577, so over
                // a 150-draw window the mean count is 8.65 and sd 2.86. `c > 2` sits
                // below the mean and passed 99% of all 780 pairs, which made the
                // sort a pick of the extreme tail of 780 comparisons. Gate at the
                // window's own mean + 3 sd instead.
                .filter(([, c]) => c > pairGate).sort(([, a], [, b]) => b - a);
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
            const correlations = this.pairCounts(150);
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
        // Drought Rebound — numbers whose recent rate has fallen furthest below
        // THEIR OWN long-run rate, not below the uniform expectation. That is what
        // separates it from Cold (lowest all-time count) and from Variance (below
        // the 0.25 expectation lately): a number can run well above average all
        // session and still be in a personal drought right now.
        getDroughtReboundNumbers(count = 9) {
            const ks = this.data.kenoStats;
            const N = this.numberCount;
            const games = ks.analyzedGames || Math.min(ks.totalBets, 1000);
            if (games < 40) return this.getColdNumbers(count);
            const w = Math.max(20, Math.min(60, Math.round(games * 0.25)));
            const draws = this.getRecentDraws(w);
            if (draws.length < 20) return this.getColdNumbers(count);
            const recent = new Array(N + 1).fill(0);
            for (const d of draws) for (const n of d) if (n >= 1 && n <= N) recent[n]++;
            return Array.from({ length: N }, (_, i) => {
                const histRate = (ks.hotNumbers[i] || 0) / games;
                if (histRate <= 0) return { n: i + 1, score: 0 };
                const recentRate = recent[i + 1] / draws.length;
                // how far below its own pace, as a share of that pace
                return { n: i + 1, score: (histRate - recentRate) / histRate };
            }).sort((a, b) => b.score - a.score).slice(0, count).map(x => x.n);
        }
        selectDroughtReboundNumbers() {
            this.animateSequentialSelection(this.getDroughtReboundNumbers());
        }

        // --- Strategy: Balanced Distribution (Zone Coverage) ---
        getBalancedNumbers(count = 9) {
            if (this.data.kenoStats.totalBets < 10) return this.getSmartNumbers(count);
            const hot = this.data.kenoStats.hotNumbers;
            const _step = this.numberCount / 4;
            const zones = [
                { s: 0,         e: _step },
                { s: _step,     e: _step * 2 },
                { s: _step * 2, e: _step * 3 },
                { s: _step * 3, e: this.numberCount }
            ];
            // floor, not ceil: ceil overfills every zone and the slice at the end
            // then removes the overflow from the LAST zone only -- at the default
            // count of 6 that dropped zone 4 entirely, from the one strategy whose
            // whole point is even coverage. Remainder is spread one per zone.
            const perZone = Math.floor(count / zones.length);
            let remainder = count - perZone * zones.length;
            const selected = [];
            const avg = this.data.kenoStats.totalBets / this.numberCount;
            zones.forEach(({ s, e }) => {
                const nums = Array.from({ length: e - s }, (_, i) => ({ n: s + i + 1, hits: hot[s + i] }))
                    .sort((a, b) => Math.abs(a.hits - avg) - Math.abs(b.hits - avg));
                const take = perZone + (remainder > 0 ? 1 : 0);
                if (remainder > 0) remainder--;
                selected.push(...nums.slice(0, take).map(n => n.n));
            });
            return selected.slice(0, count);
        }
        selectBalancedNumbers() {
            const numbers = this.getBalancedNumbers();
            this.animateSequentialSelection(numbers);
        }

        // --- Strategy: Momentum (Recent Acceleration) ---
        // Numbers hitting faster lately than their own session rate.
        //
        // This counted "recent hits" as `lastOccurrences.filter(g => g >= totalBets - w)`,
        // but lastOccurrences holds the INTERVALS between a number's appearances,
        // not game indices — processKenoData pushes `interval`. So the filter was
        // counting intervals longer than the whole session minus w, which only
        // rarely-drawn numbers ever have, and Momentum returned Cold's ticket.
        // The scoring formula was right all along; it was reading the wrong array.
        getMomentumNumbers(count = 9) {
            const ks = this.data.kenoStats;
            const games = ks.analyzedGames || Math.min(ks.totalBets, 1000);
            if (games < 20) return this.getHotNumbers(count);
            const N = this.numberCount;
            const w = Math.max(10, Math.min(30, Math.round(games * 0.15)));
            const draws = this.getRecentDraws(w);
            if (draws.length < 10) return this.getHotNumbers(count);
            const recent = new Array(N + 1).fill(0);
            for (const d of draws) for (const n of d) if (n >= 1 && n <= N) recent[n]++;
            return Array.from({ length: N }, (_, i) => {
                const recentRate = recent[i + 1] / draws.length;
                const histRate = (ks.hotNumbers[i] || 0) / games;
                // rate now, plus double weight on the acceleration
                return { n: i + 1, score: recentRate + (recentRate - histRate) * 2 };
            }).sort((a, b) => b.score - a.score).slice(0, count).map(x => x.n);
        }
        selectMomentumNumbers() {
            const numbers = this.getMomentumNumbers();
            this.animateSequentialSelection(numbers);
        }

        // =====================================================================
        // END RESTORED STRATEGIES
        // =====================================================================

        // Run a strategy at the size the spot control asks for. The select*
        // wrappers all fill a fixed nine; the get* functions have taken a count
        // all along, so this calls those and keeps the wrapper only where it
        // does something extra on click (Variance's high/low toggle).
        // Variance used to be excluded from this path so that its select*
        // wrapper still ran, because that wrapper owns the high/low toggle the
        // algorithm reads. The cost was that Variance took the wrapper's
        // argument-less call, so it always played the getter's signature default
        // of 9 -- ignoring Auto and ignoring a pin -- and skipped the hand-off
        // check. The toggle now runs as a post-step instead (afterStrategyRun),
        // after the getter has read it, so both work.
        runStrategy(strategyId, methodName) {
            // Variance owns a high/low toggle whose ONLY effect is its count
            // (5 low, 9 high), so handing it Auto's 6 would silently retire the
            // feature. On Auto it keeps its own sizes; an explicit pin still wins,
            // because a pin is the user saying what they want.
            const spots = this.spotsFor(strategyId);
            const getter = methodName && methodName.replace(/^select/, 'get');
            if (getter && typeof this[getter] === 'function') {
                this.traceStrategyGetters();
                this._trace = { depth: 0, nested: [] };
                const nums = safe(() => this[getter](spots));
                const trace = this._trace;
                this._trace = null;
                if (Array.isArray(nums) && nums.length) {
                    this.noteStrategyHandoff(strategyId, trace, nums);
                    this.animateSequentialSelection([...nums].sort((a, b) => a - b));
                    safe(() => this.afterStrategyRun(strategyId));
                    return;
                }
            }
            if (methodName && typeof this[methodName] === 'function') this[methodName]();
        }

        // UI state a strategy owns beyond picking numbers. Runs after the getter,
        // never before: getVarianceNumbers reads strategyToggles.variance, so
        // flipping it first would apply the new mode to the ticket that was just
        // built under the old one.
        // Flip to the other mode for NEXT time. Runs after the getter, never
        // before, so the click just made used the count the badge was showing.
        // A pin suspends the alternation entirely: with an explicit count set,
        // every click means the same thing.
        afterStrategyRun(strategyId) {
            if (this.spotMode !== 'auto' || !this.hasSecondMode(strategyId)) {
                this._spotFor = strategyId;
                this._spotSecond = false;
                safe(() => this.refreshSpotBadges());
                return;
            }
            // Same tile again -> alternate. A different tile -> that one is now the
            // one being cycled, and the click just made was its first.
            this._spotSecond = (this._spotFor === strategyId) ? !this._spotSecond : true;
            this._spotFor = strategyId;
            safe(() => this.refreshSpotBadges());
        }

        // Most strategies hand off to another one under a data threshold —
        // `if (totalBets < 30) return this.getHotNumbers(count)` and so on, 27
        // times across the file. That is sensible; doing it silently is not,
        // because clicking Poisson at 18 bets gives you Hot's ticket with
        // nothing saying so.
        //
        // Rather than rewrite 27 call sites, spot it from the outside: a real
        // hand-off returns the delegate's array verbatim. Blends like Adaptive
        // and Edge call other strategies too, but they re-rank the votes, so
        // their result never matches any single ingredient.
        traceStrategyGetters() {
            if (this._tracedGetters) return;
            this._tracedGetters = true;
            const proto = Object.getPrototypeOf(this);
            Object.getOwnPropertyNames(proto)
                .filter(n => /^get[A-Z]\w*Numbers$/.test(n) && typeof proto[n] === 'function')
                .forEach(name => {
                    const orig = proto[name];
                    const overlay = this;
                    // own property shadows the prototype for this instance only
                    this[name] = function (...args) {
                        const t = overlay._trace;
                        if (t) t.depth++;
                        let out;
                        try {
                            out = orig.apply(this, args);
                        } finally {
                            if (t) {
                                t.depth--;
                                // depth still > 0 → this ran inside another getter
                                if (t.depth > 0 && Array.isArray(out)) t.nested.push({ name, out });
                            }
                        }
                        return out;
                    };
                });
        }

        // getHotNumbers -> 'hot', getRepeatChaserNumbers -> 'repeat'…
        strategyIdForGetter(getterName) {
            const stripped = getterName.replace(/^get/, '').replace(/Numbers$/, '');
            const map = safe(() => this.selectMethodMap()) || {};
            for (const id in map) {
                if (map[id] === 'select' + stripped + 'Numbers') return id;
            }
            return stripped.toLowerCase();
        }

        // Strategies that legitimately compose others — saying "this is Hot's
        // pick" about a declared blend is noise, and Adaptive already names what
        // it is blending on its own tile.
        static get BLENDS() { return ['adaptive', 'edge', 'regime']; }

        noteStrategyHandoff(strategyId, trace, result) {
            safe(() => {
                this._handoffs = this._handoffs || {};
                const clear = () => { delete this._handoffs[strategyId]; };
                if (!Array.isArray(result) || !result.length) return clear();
                if (GeminyzerOverlay.BLENDS.includes(strategyId)) return clear();

                // A gated strategy rarely returns a filler's list verbatim — it
                // returns its own few picks with the rest topped up from Hot, so
                // an equality test never fires. Overdue clears its own gate for
                // about 4 of 10 numbers on a fair board and pads the rest, and
                // the ticket looked entirely like Overdue's own work. Equality
                // also misses a prefix, and misses a FULL hand-off that differs
                // only in order — Hotzone and Digit sort their result while Hot
                // returns heat order.
                //
                // So measure how much of the result the filler actually supplied,
                // and treat a clear majority as a hand-off.
                let best = null;
                for (const call of (trace?.nested || [])) {
                    const id = this.strategyIdForGetter(call.name);
                    if (!id || id === strategyId) continue;
                    if (!Array.isArray(call.out) || !call.out.length) continue;
                    const from = new Set(call.out);
                    const n = result.reduce((a, v) => a + (from.has(v) ? 1 : 0), 0);
                    const frac = n / result.length;
                    if (frac >= 0.6 && (!best || frac > best.frac)) best = { id, frac, n };
                }
                if (best) this._handoffs[strategyId] = { to: best.id, n: best.n, of: result.length };
                else clear();
                if (!this._probing) this.refreshHandoffMarks();
            });
        }

        // Work out which tiles are handing off WITHOUT waiting for a click, so a
        // thin session shows what isn't ready yet up front. Only worth doing
        // while the data is thin — that's both when hand-offs happen and when
        // running every strategy is cheap.
        probeHandoffs() {
            safe(() => {
                const bets = this.data.kenoStats.totalBets || 0;
                if (bets > 80) {                       // past every data threshold
                    // Clear the thin-session marks once on the way past the cap,
                    // then leave the map alone. Not every hand-off is about thin
                    // data: Hotzone hands back to Hot whenever no block clears its
                    // significance test, and Edge falls back to its fixed slate
                    // until something shows an edge — either can happen at 300
                    // games. Those are found by clicking (runStrategy calls
                    // noteStrategyHandoff), and wiping the map on every bet
                    // erased them again before they could be seen.
                    if (!this._handoffCapCleared) {
                        this._handoffCapCleared = true;
                        if (this._handoffs && Object.keys(this._handoffs).length) {
                            this._handoffs = {};
                        }
                    }
                    this.refreshHandoffMarks();
                    return;
                }
                this._handoffCapCleared = false;
                // Already worked out for this bet count — but the grid may have
                // been rebuilt since (it renders asynchronously after the saved
                // order loads), so repaint rather than returning empty-handed.
                if (this._probedAt === bets) { this.refreshHandoffMarks(); return; }
                // Running every strategy is ~35 getters (Monte Carlo included).
                // During autobet that ran on every bet; coalesce to one probe per
                // 2s, finished off the hot path once the burst settles.
                const now = Date.now();
                if (this._probeLast && now - this._probeLast < 2000) {
                    if (!this._probeTimer) {
                        this._probeTimer = setTimeout(() => {
                            this._probeTimer = null;
                            const run = () => this.probeHandoffs();
                            if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 1000 });
                            else setTimeout(run, 0);
                        }, 2000 - (now - this._probeLast));
                    }
                    this.refreshHandoffMarks();
                    return;
                }
                this._probeLast = now;
                this._probedAt = bets;
                this.traceStrategyGetters();
                const map = this.selectMethodMap();
                this._probing = true;                  // paint once at the end, not 35 times
                Object.keys(map).forEach(id => {
                    const getter = map[id].replace(/^select/, 'get');
                    if (typeof this[getter] !== 'function') return;
                    this._trace = { depth: 0, nested: [] };
                    const nums = safe(() => this[getter](this.spotsFor(id)));
                    const trace = this._trace;
                    this._trace = null;
                    if (Array.isArray(nums) && nums.length) this.noteStrategyHandoff(id, trace, nums);
                });
                this._probing = false;
                this.refreshHandoffMarks();
            });
        }

        // Mark a tile that is currently returning someone else's ticket.
        refreshHandoffMarks() {
            const marks = this._handoffs || {};
            const items = [
                ...(this.overlay?.querySelectorAll('.action-item') || []),
                ...document.querySelectorAll('#overlay-side-actions .action-item')
            ];
            items.forEach(item => {
                const id = item.dataset.strategyId;
                if (!id) return;
                const to = marks[id];
                let mark = item.querySelector('.vx-handoff');
                if (!to) {
                    if (mark) mark.remove();
                    item.classList.remove('vx-borrowed');
                    if (item.dataset.handoffTitle) {
                        item.title = '';
                        delete item.dataset.handoffTitle;
                    }
                    return;
                }
                const rec = (to && typeof to === 'object') ? to : { to, n: 0, of: 0 };
                const toName = this.getStrategyName(rec.to) || rec.to;
                const myName = this.getStrategyName(id) || id;
                if (mark) mark.remove();          // legacy text mark, if present
                item.classList.add('vx-borrowed');
                item.title = (rec.n && rec.n < rec.of)
                    ? `${myName} only found ${rec.of - rec.n} of ${rec.of} numbers itself — the other ${rec.n} are ${toName}'s.`
                    : `${myName} doesn't have enough data yet — this is ${toName}'s pick.`;
                item.dataset.handoffTitle = '1';
            });
        }

        // Re-key a by-strategy map onto today's ids, merging what a rename split
        // in two. `merge` combines two values for the same target id; the default
        // adds numbers, which is what the legend hit counts need.
        foldStrategyAliases(map, merge) {
            const out = {};
            if (!map) return out;
            const add = merge || ((a, b) => (a || 0) + (b || 0));
            for (const id in map) {
                const key = canonicalStrategyId(id);
                if (!key) continue;              // retired with no successor
                out[key] = key in out ? add(out[key], map[id]) : map[id];
            }
            return out;
        }

        // Names the strategies Adaptive is currently blending, on its own tile.
        noteAdaptiveBlend(topStrategies) {
            safe(() => {
                const names = topStrategies
                    .map(t => this.getStrategyName(t.id) || t.id)
                    .filter(Boolean);
                if (!names.length) return;
                this._adaptiveBlend = names.join(' + ');
                const label = `Adaptive — currently blending ${this._adaptiveBlend}`;
                const item = this.overlay?.querySelector('.action-item[data-strategy-id="adaptive"]')
                    || document.querySelector('#overlay-side-actions .action-item[data-strategy-id="adaptive"]');
                if (item) item.title = label;
                const btn = item?.querySelector('.action-btn-lg');
                if (btn) btn.title = label;
            });
        }

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
                antipattern: (c) => this.getAntiPatternNumbers(c),
                regime: (c) => this.getRegimeNumbers(c),
                repeat: (c) => this.getRepeatChaserNumbers(c),
                drought: (c) => this.getDroughtReboundNumbers(c),
                anticluster: (c) => this.getAntiClusterNumbers(c),
                successor: (c) => this.getSuccessorNumbers(c),
                cycle: (c) => this.getCycleNumbers(c),
                runs: (c) => this.getRunsNumbers(c)
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
                repeat: ['hot', 'streak'],
                drought: ['overdue', 'cold'],
                anticluster: ['balanced', 'cold'],
                successor: ['repeat', 'hot'],
                cycle: ['overdue', 'ema'],
                runs: ['streak', 'hot']
            };

            // Build legend-based strategy bias: strategies with more big hits get a weight bonus
            const siteKey = `${this.storageOrigin}-keno-session`;
            const legendHits = this.foldStrategyAliases(this.data.legendStats?.[siteKey]?.hitsByStrategy);
            const perf = this.foldStrategyAliases(this.data.kenoStrategyPerformance?.[siteKey], (a, b) => ({
                totalGames: (a?.totalGames || 0) + (b?.totalGames || 0),
                wins: (a?.wins || 0) + (b?.wins || 0),
                totalMultiplier: (a?.totalMultiplier || 0) + (b?.totalMultiplier || 0),
                maxMultiplier: Math.max(a?.maxMultiplier || 0, b?.maxMultiplier || 0)
            }));
            // Big-hit counts alone measure how often you CLICKED a strategy, not
            // how it performed — in a real export the top scorer was Random, with
            // 47 of 389 hits, purely because it got played most. Divide by the
            // games each strategy actually ran so the bonus reflects hit RATE,
            // and fall back to no bonus where the play count is missing or thin.
            const legendBonus = (id) => {
                const hits = legendHits[id] || 0;
                const games = perf[id]?.totalGames || 0;
                if (!hits || games < 20) return 1;
                return 1 + Math.min((hits / games) * 10, 1);
            };

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
                // Same correction here: rank by hits per game played, not raw hits.
                const ranked = Object.entries(legendHits)
                    .map(([id, hits]) => [id, hits / Math.max(perf[id]?.totalGames || 0, 1)])
                    .filter(([id]) => (perf[id]?.totalGames || 0) >= 20)
                    .sort((a, b) => b[1] - a[1]);
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

            // Adaptive is a blend of other strategies by design — so say which
            // ones. Without this the tile looks like an independent signal while
            // quietly returning whatever its primary returned.
            this.noteAdaptiveBlend(topStrategies);

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

                // Newest-first array: the head IS the recent end. This counted
                // down from the tail, so hitRates[0] was the OLDEST game and the
                // CUSUM below ran over the oldest ten draws of the session.
                for (let i = 0; i < lookback; i++) {
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
        // Repeat Chaser — lag-1 autocorrelation. For each number: given it was
        // drawn, how often was it drawn again in the very next game, against the
        // 0.25 chance rate. Nothing else in the engine looks at draw ORDER; every
        // other strategy treats the session as an unordered pile of counts.
        getRepeatChaserNumbers(count = 9) {
            const N = this.numberCount;
            const draws = this.getRecentDraws(300);
            if (draws.length < 30) return this.getHotNumbers(count);
            const p = (this._drawnPerGame || 10) / N;
            const seen = new Array(N + 1).fill(0);    // times it appeared with a next draw to check
            const again = new Array(N + 1).fill(0);   // ...and appeared in that next draw too
            // draws[0] is newest, so draws[i + 1] is the game BEFORE draws[i]
            for (let i = 0; i < draws.length - 1; i++) {
                const now = new Set(draws[i]);
                for (const n of draws[i + 1]) {
                    if (n < 1 || n > N) continue;
                    seen[n]++;
                    if (now.has(n)) again[n]++;
                }
            }
            return Array.from({ length: N }, (_, i) => {
                const n = i + 1;
                if (seen[n] < 4) return { n, score: -1 };
                const rate = again[n] / seen[n];
                // shrink toward chance so a 2-of-3 fluke can't outrank a real run
                const shrunk = (again[n] + p * 8) / (seen[n] + 8);
                return { n, score: (shrunk - p) * Math.min(seen[n] / 20, 1) + rate * 0.001 };
            }).sort((a, b) => b.score - a.score).slice(0, count).map(x => x.n);
        }
        selectRepeatChaserNumbers() {
            this.animateSequentialSelection(this.getRepeatChaserNumbers());
        }


        // TAG: NEW-STRATEGY-EDGE
        getEdgeNumbers(count = 9) {
            // Fallback if no performance data
            if (!this._lastAIRecommendation && this.data.kenoStats.totalBets < 40) {
                return this.getAdaptiveNumbers(count);
            }

            // Kelly-inspired means weighting by realised edge, and this used to
            // hand every strategy a flat 2.0 with a "can be enhanced later" note —
            // so it was a fixed equal-weight vote of five strategies wearing a
            // performance-weighted label, and it tracked Adaptive closely because
            // neither was reading anything session-specific.
            //
            // The Kelly-relevant quantity is profit per unit staked, which is what
            // the performance record already holds: totalMultiplier / totalGames
            // is the average return of a bet placed on that strategy, so that
            // minus 1 is its edge. Shrink toward zero by sample size so a
            // strategy with one lucky round can't own the vote.
            const siteKey = `${this.storageOrigin}-keno-session`;
            const perf = this.foldStrategyAliases(this.data.kenoStrategyPerformance?.[siteKey], (a, b) => ({
                totalGames: (a?.totalGames || 0) + (b?.totalGames || 0),
                wins: (a?.wins || 0) + (b?.wins || 0),
                totalMultiplier: (a?.totalMultiplier || 0) + (b?.totalMultiplier || 0),
                maxMultiplier: Math.max(a?.maxMultiplier || 0, b?.maxMultiplier || 0)
            }));
            const getters = {
                ema: (c) => this.getEMANumbers(c),
                positional: (c) => this.getPositionalNumbers(c),
                hot: (c) => this.getHotNumbers(c),
                repeat: (c) => this.getRepeatChaserNumbers(c),
                successor: (c) => this.getSuccessorNumbers(c),
                cold: (c) => this.getColdNumbers(c),
                overdue: (c) => this.getOverdueNumbers(c),
                streak: (c) => this.getStreakNumbers(c),
                drought: (c) => this.getDroughtReboundNumbers(c),
                digitbias: (c) => this.getDigitBiasNumbers(c),
                anticluster: (c) => this.getAntiClusterNumbers(c)
            };
            const edgeOf = (id) => {
                const p = perf[id];
                const games = p?.totalGames || 0;
                if (!games) return 0;
                const avgMult = (p.totalMultiplier || 0) / games;
                return Math.max(0, avgMult - 1) * (games / (games + 30));   // shrunk
            };

            let weighted = Object.keys(getters)
                .map(id => ({ id, w: edgeOf(id) }))
                .filter(x => x.w > 0)
                .sort((a, b) => b.w - a.w)
                .slice(0, 5);

            // Nothing in this session has shown an edge yet — say so by falling
            // back to the old fixed slate rather than inventing weights.
            if (!weighted.length) {
                weighted = ['ema', 'positional', 'hot', 'repeat', 'successor'].map(id => ({ id, w: 1 }));
            }
            this._edgeBlend = weighted.map(x => `${this.getStrategyName(x.id) || x.id}`).join(' + ');

            const votes = new Float32Array(this.numberCount + 1);
            const top = weighted[0].w || 1;
            weighted.forEach(({ id, w }) => {
                const weight = 1 + (w / top);              // 1..2, best strategy doubled
                try { getters[id](12).forEach(n => { votes[n] += weight; }); } catch (e) { }
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
        // ==========================================================================

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

        // --- Strategy: Successor (lag-1 Markov, off the diagonal) ---
        // Repeat asks whether a number follows ITSELF. Successor asks which
        // numbers follow the ones that came up LAST GAME, which is the same
        // transition matrix read off its diagonal, and it is the only strategy
        // on either grid conditioned on the previous draw.
        //
        // The obvious version of this is Hot wearing a hat. Scoring a candidate
        // as sum over n in last of ( P(m|n) - 0.25 ) averages ten heavily
        // overlapping sub-samples of the same history, so it collapses to ten
        // times m's own marginal rate and ranks exactly like heat. Centring
        // each term on m's MARGINAL rate instead of on chance cancels that
        // component and leaves the conditional dependence, which is the thing
        // actually being claimed.
        //
        // Null: under a fair shuffle the next draw is independent of this one,
        // so C[n][m] ~ Binomial(R[n], q[m]) and every centred term has mean
        // zero. Dividing by the pooled standard error makes the sum a z-score
        // rather than a raw lift, so a candidate backed by thin rows cannot
        // outrank one backed by full ones.
        getSuccessorNumbers(count = 9) {
            const N = this.numberCount;
            const draws = this.getRecentDraws(300);
            if (draws.length < 150) return this.getHotNumbers(count);

            // C[n][m] = times m appeared in the draw AFTER one containing n.
            // R[n]    = times n appeared with a next draw to check.
            // marg[m] = times m appeared in any draw that had a predecessor.
            const C = Array.from({ length: N + 1 }, () => new Float32Array(N + 1));
            const R = new Array(N + 1).fill(0);
            const marg = new Array(N + 1).fill(0);
            let pairs = 0;
            // draws[0] is newest, so draws[i + 1] is the game BEFORE draws[i].
            for (let i = 0; i < draws.length - 1; i++) {
                const next = draws[i], prev = draws[i + 1];
                pairs++;
                for (const m of next) if (m >= 1 && m <= N) marg[m]++;
                for (const n of prev) {
                    if (n < 1 || n > N) continue;
                    R[n]++;
                    const row = C[n];
                    for (const m of next) if (m >= 1 && m <= N) row[m]++;
                }
            }
            // Rows with almost no exposure say nothing; drop them rather than
            // let them drag ten-term sums around.
            const last = [...new Set(draws[0])].filter(n => n >= 1 && n <= N && R[n] >= 8);
            if (!last.length || !pairs) return this.getHotNumbers(count);

            const K = 8;   // shrinkage strength, same as Repeat
            const hot = this.data.kenoStats.hotNumbers || [];
            return Array.from({ length: N }, (_, i) => {
                const m = i + 1;
                const q = marg[m] / pairs;              // m's own rate: the thing to beat
                let lift = 0, varSum = 0;
                for (const n of last) {
                    // shrink toward m's marginal so a 2-of-3 fluke cannot top the table
                    lift += (C[n][m] + q * K) / (R[n] + K) - q;
                    varSum += q * (1 - q) / R[n];
                }
                const se = Math.sqrt(Math.max(varSum, 1e-12));
                return { n: m, z: lift / se, h: hot[i] || 0 };
            }).sort((a, b) => b.z - a.z || b.h - a.h)
                .slice(0, count).map(x => x.n).sort((a, b) => a - b);
        }
        selectSuccessorNumbers() {
            this.animateSequentialSelection(this.getSuccessorNumbers());
        }

        // --- Strategy: Cycle (autocorrelation past lag 1) ---
        // Every other gap strategy here uses only the mean and the spread of a
        // number's gaps. None asks whether the gaps repeat on a PERIOD. This
        // takes each number's hit/miss series and looks for the strongest
        // autocorrelation at lags 2 to 20, then plays only the numbers whose
        // cycle points at this game.
        //
        // Under independence the sample autocorrelation is approximately
        // N(0, 1/D), so Bartlett's band is 2/sqrt(D). Nineteen lags per number
        // is nineteen chances to clear it, so the band is Sidak-corrected:
        // z(1 - 0.05/(2*19)) / sqrt(D), and z(0.99868) ~ 3.0. On a fair board
        // almost nothing clears that, and the tile hands back to Hot -- which is
        // the gate working, not the strategy failing.
        getCycleNumbers(count = 9) {
            const N = this.numberCount;
            const draws = this.getRecentDraws(200);
            const D = draws.length;
            if (D < 200) return this.getHotNumbers(count);
            const MINLAG = 2, MAXLAG = 20;
            const band = 3.0 / Math.sqrt(D);
            const inSet = Array.from({ length: D }, (_, t) => new Set(draws[t]));
            const scored = [];
            for (let n = 1; n <= N; n++) {
                const x = new Array(D);
                for (let t = 0; t < D; t++) x[t] = inSet[t].has(n) ? 1 : 0;
                const mean = x.reduce((a, b) => a + b, 0) / D;
                let c0 = 0;
                for (let t = 0; t < D; t++) c0 += (x[t] - mean) * (x[t] - mean);
                if (c0 <= 0) continue;
                let bestLag = 0, bestR = 0;
                for (let k = MINLAG; k <= MAXLAG; k++) {
                    let ck = 0;
                    for (let t = 0; t + k < D; t++) ck += (x[t] - mean) * (x[t + k] - mean);
                    const r = ck / c0;
                    if (Math.abs(r) > Math.abs(bestR)) { bestR = r; bestLag = k; }
                }
                if (!bestLag || Math.abs(bestR) < band) continue;
                // In phase = the cycle points at NOW. draws[0] is the last game
                // played, so the game k back from the one about to be played is
                // draws[k - 1]. A positive correlation says "drawn then -> likely
                // now"; a negative one says "drawn then -> unlikely now".
                const then = x[bestLag - 1] === 1;
                if (bestR > 0 ? !then : then) continue;
                scored.push({ n, score: Math.abs(bestR), lag: bestLag });
            }
            scored.sort((a, b) => b.score - a.score);
            this._lastCycle = scored.length ? `lag ${scored[0].lag}` : 'no cycle';
            const picked = scored.slice(0, count).map(x => x.n);
            if (picked.length < count) {
                const fill = this.getHotNumbers(count * 2).filter(n => !picked.includes(n));
                picked.push(...fill.slice(0, count - picked.length));
            }
            return picked.slice(0, count).sort((a, b) => a - b);
        }
        selectCycleNumbers() {
            this.animateSequentialSelection(this.getCycleNumbers());
        }

        // --- Strategy: Runs (Wald-Wolfowitz) ---
        // Volatility measures how SPREAD OUT a number's gaps are. This measures
        // how they are ARRANGED, which is a different property: a number can
        // have a high gap CV with its hits evenly scattered, and a low one with
        // them bunched, so the two rank differently by construction.
        //
        // A run is a maximal block of consecutive hits or consecutive misses.
        // With n1 hits and n0 misses in n games the null moments are exact:
        //   E[R]   = 2*n1*n0/n + 1
        //   Var[R] = 2*n1*n0*(2*n1*n0 - n) / (n^2 * (n - 1))
        // A strongly negative z means the hits arrive in bunches. Those are only
        // worth playing while the sequence is still inside a bunch, so a number
        // also has to have come up in one of the last two games.
        getRunsNumbers(count = 9) {
            const N = this.numberCount;
            const draws = this.getRecentDraws(300);
            const n = draws.length;
            if (n < 40) return this.getHotNumbers(count);
            const inSet = draws.map(d => new Set(d));
            const scored = [];
            for (let num = 1; num <= N; num++) {
                let n1 = 0, runs = 0, prev = -1;
                for (let t = n - 1; t >= 0; t--) {          // oldest -> newest
                    const hit = inSet[t].has(num) ? 1 : 0;
                    if (hit) n1++;
                    if (hit !== prev) { runs++; prev = hit; }
                }
                const n0 = n - n1;
                if (n1 < 10 || n0 < 10) continue;           // normal approximation floor
                const t2 = 2 * n1 * n0;
                const eR = t2 / n + 1;
                const vR = t2 * (t2 - n) / (n * n * (n - 1));
                if (vR <= 0) continue;
                const z = (runs - eR) / Math.sqrt(vR);
                if (z >= -1) continue;                      // no clustering worth playing
                if (!inSet[0].has(num) && !(inSet[1] && inSet[1].has(num))) continue;
                scored.push({ n: num, score: -z });
            }
            scored.sort((a, b) => b.score - a.score);
            const picked = scored.slice(0, count).map(x => x.n);
            if (picked.length < count) {
                const fill = this.getHotNumbers(count * 2).filter(x => !picked.includes(x));
                picked.push(...fill.slice(0, count - picked.length));
            }
            return picked.slice(0, count).sort((a, b) => a - b);
        }
        selectRunsNumbers() {
            this.animateSequentialSelection(this.getRunsNumbers());
        }

        // --- Strategy: Cluster (co-occurrence) ---
        // Numbers that land together: seed from the hottest, grow by total
        // co-occurrence with the set so far, for a tightly-clustered pick.
        // Anti-Cluster — the mirror of Wheeling. Greedily builds a set of numbers
        // that have AVOIDED each other, so the ticket spreads across independent
        // draws instead of stacking on one cluster: more chances at a small hit,
        // fewer at everything landing at once.
        getAntiClusterNumbers(count = 9) {
            const N = this.numberCount;
            const draws = this.getRecentDraws(150);
            if (draws.length < 20) return this.getSmartNumbers(count);
            const pairs = this.pairCounts(150);
            const together = (a, b) => pairs[a < b ? `${a}-${b}` : `${b}-${a}`] || 0;
            // seed with the number that shares fewest draws with everything else
            const totals = Array.from({ length: N }, (_, i) => {
                let t = 0;
                for (let j = 1; j <= N; j++) if (j !== i + 1) t += together(i + 1, j);
                return { n: i + 1, t };
            }).sort((a, b) => a.t - b.t);
            const picked = [totals[0].n];
            while (picked.length < count && picked.length < N) {
                let best = null, bestScore = Infinity;
                for (let n = 1; n <= N; n++) {
                    if (picked.includes(n)) continue;
                    let score = 0;
                    for (const q of picked) score += together(n, q);
                    if (score < bestScore) { bestScore = score; best = n; }
                }
                if (!best) break;
                picked.push(best);
            }
            return picked.sort((a, b) => a - b);
        }
        selectAntiClusterNumbers() {
            this.animateSequentialSelection(this.getAntiClusterNumbers());
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
                clearInterval(this._urlPollHandle);
                clearTimeout(this._probeTimer);
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
            log(`✅ Vantedge overlay mounted (${overlay.gameMode})`);
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
        log('Vantedge: overlay node was removed by the page — remounting');
        safe(() => window.geminyzerOverlay.destroy());
        initializeOverlay();
    }

    function startRouteWatch() {
        checkRoute();
        setInterval(() => { checkRoute(); checkAlive(); }, 1000);
    }

    // Mount only after the page has finished loading. Stake is SvelteKit
    // (Svelte 5): it hydrates the server-rendered board after its modules load,
    // and any node we add to <head>/<body> before then can derail hydration
    // ("Failed to hydrate: TypeError: Illegal invocation"). A failed hydration
    // leaves the board as dead server HTML - the tiles render but nothing on
    // them is clickable, by hand or by us.
    const HYDRATION_GRACE_MS = 1500;
    if (document.readyState === 'complete') {
        setTimeout(startRouteWatch, HYDRATION_GRACE_MS);
    } else {
        window.addEventListener('load', () => setTimeout(startRouteWatch, HYDRATION_GRACE_MS), { once: true });
    }
})();




















