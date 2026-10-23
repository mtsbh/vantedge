const DEBUG = false;
function log(...args) { if (DEBUG) console.log(...args); }

// Shared money math (VantedgeMoney) — same importScripts / background.scripts
// pattern as the modules below. Every surface counts P/L through it.
try {
  if (typeof self.VantedgeMoney === 'undefined' && typeof importScripts === 'function') {
    importScripts('money.js');
  }
} catch (error) {
  console.error('❌ Failed to load money helpers:', error);
}

// Storage manager is loaded via service_worker importScripts (Chrome / FF 121+)
// or via background.scripts (Firefox < 121). Either way VantEdgeStorageManager
// ends up on the global scope by the time this script runs.
let storageManagerReady = false;

try {
  if (typeof VantEdgeStorageManager === 'undefined' && typeof importScripts === 'function') {
    importScripts('storage-manager.js');
  }
  storageManagerReady = typeof VantEdgeStorageManager !== 'undefined';
  if (storageManagerReady) {
    log('✅ Storage manager loaded successfully');
  } else {
    console.error('❌ Storage manager global not found');
  }
} catch (error) {
  console.error('❌ Failed to load storage manager:', error);
}

// Cloud sync module — same importScripts pattern (Chrome/Vivaldi only see
// service_worker entry, not the manifest "scripts" array).
try {
  if (typeof self.VantedgeCloudSync === 'undefined' && typeof importScripts === 'function') {
    importScripts('cloud-sync.js');
  }
  if (typeof self.VantedgeCloudSync !== 'undefined') {
    log('✅ Cloud sync module loaded');
  } else {
    console.error('❌ Cloud sync module global not found');
  }
} catch (error) {
  console.error('❌ Failed to load cloud sync module:', error);
}

const originalError = console.error;
const originalWarn = console.warn;
const originalLog = console.log;


console.error = function (...args) {
  const message = args.join(' ');
  const blockedErrors = [
    'Connection failed', 'Extension context invalidated', 'Could not find Stake number',
    'Connection attempt', 'failed, retrying', 'Port not available', 'Re-queuing message',
    'Cannot read properties of undefined', 'TypeError: Cannot read properties', 'reading \'local\'',
    'Not on supported site', 'NaN', 'Keyframe', 'parsing value', 'height',
    'Fetch Intercepted', 'Game data received', 'net::ERR_BLOCKED_BY_CLIENT', 'mixpanel'
  ];
  if (!blockedErrors.some(blocked => message.includes(blocked))) {
    originalError.apply(console, args);
  }
};
console.warn = function (...args) {
  const message = args.join(' ');
  const blockedWarnings = ['Not on supported site', 'Clearing display', 'Storage error', 'Failed to load data'];
  if (!blockedWarnings.some(blocked => message.includes(blocked))) { originalWarn.apply(console, args); }
};

let activeConnections = new Map();
let lastKenoStrategy = {};

(function () {
  if (typeof browser === 'undefined') {
    var browser = chrome;
  }

  const KEEP_ALIVE_ALARM_NAME = 'geminyzer-keep-alive';

  if (typeof browser !== 'undefined' && browser.runtime) {
    browser.alarms.create(KEEP_ALIVE_ALARM_NAME, { periodInMinutes: 0.4 });
    browser.alarms.onAlarm.addListener(alarm => {
      if (alarm.name === KEEP_ALIVE_ALARM_NAME) {
        browser.tabs.query({
          url: [
            "*://stake.com/*",
            "*://stake.us/*",
            "*://rainbet.com/*",
            "*://roobet.com/*"
          ]
        }, (tabs) => {
          if (tabs.length > 0) {
            tabs.forEach(tab => browser.tabs.sendMessage(tab.id, { type: 'KEEP_ALIVE_PING' }).catch(e => { }));
            if (Math.random() < 0.1) {
              log(`Vantedge BG: Pinged ${tabs.length} active tabs.`);
            }
          } else {
            browser.storage.local.get('keepAliveCheck');
          }
        });
      }
    });
  }

  let state = {
    seedResults: {}, allMultipliers: {}, betsSinceMultiplier: {}, lastOccurrenceMultiplier: {},
    kenoResults: {}, kenoHotNumbers: {}, kenoCorrelations: { 2: {}, 3: {}, 4: {}, 5: {}, 6: {} },
    kenoLastOccurrences: { 2: {}, 3: {}, 4: {}, 5: {}, 6: {} }, kenoLastSeen: { 2: {}, 3: {}, 4: {}, 5: {}, 6: {} },
    kenoTotalBets: {}, kenoLifetimeBets: {}, kenoEnhancedState: {}, minesResults: {}, minesHeatmaps: {}, currentMineCount: 3,
    minesAdvancedStats: { totalGames: 0, wins: 0, losses: 0, totalProfit: 0, totalWagered: 0, streaks: { current: { type: null, count: 0 }, longest: { win: 0, loss: 0 } }, patterns: { clusters: [], safeZones: [], hotSpots: [] }, gameHistory: [], gamesByMineCount: {}, currentMineCount: 3 }, legendStats: {}, lastPlayedGame: 'Plinko',
    // NEW: Enhanced prediction tracking
    kenoStrategyPerformance: {}, // Track win rate & multiplier per strategy
    kenoMomentumData: {}, // Track hot/cold streaks per number
    kenoZoneAnalysis: {}, // Track hot/cold zones on grid
    kenoBiasDetection: {}, // Track range bias (1-10, 11-20, etc.)
    kenoBetSizingStats: {} // Track performance by spot count (4, 6, 8, 10)
  };

  // Track reset timestamps to prevent race conditions
  let resetTimestamps = {};

  // Use Promise API — Firefox extension service workers don't call callbacks on
  // browser.storage.local.get(), so the old callback form left stateIsLoaded
  // permanently pending, blocking every message handler.
  let stateIsLoaded = (async () => {
    try {
      const result = await browser.storage.local.get(null);
      Object.keys(result).forEach(k => rememberSaved(k, result[k]));
      state = { ...state, ...result };
      migrateWinnaOrigins();
      return true;
    } catch (error) {
      console.error('Failed to load state from storage:', error);
      return false;
    }
  })();

  // Winna moved the keno board off the games.winna.com iframe and onto
  // winna.com/game/originals/keno, so bets were captured under whichever origin
  // the frame happened to have while the overlay only ever reads
  // games.winna.com. injected.js now canonicalises the origin, but sessions
  // recorded before that fix are stranded under the old keys — merge them in.
  //
  // Additive only: nothing is deleted, and bets already under the canonical key
  // win, so running this more than once is a no-op.
  function migrateWinnaOrigins() {
    const CANON = 'https://games.winna.com';
    // 'null' is the opaque origin of Winna's sandboxed game frame — bets landed
    // there while site was derived from window.location.origin.
    const LEGACY = ['https://winna.com', 'https://originals.winna.com', 'null'];
    const canonKey = `${CANON}-keno-session`;
    let merged = 0;

    LEGACY.forEach(origin => {
      const legacyKey = `${origin}-keno-session`;
      const legacy = state.kenoResults?.[legacyKey];
      if (!Array.isArray(legacy) || legacy.length === 0) return;

      if (!state.kenoResults) state.kenoResults = {};
      const canon = state.kenoResults[canonKey] || [];
      const seen = new Set(canon.map(b => b?.id));
      const additions = legacy.filter(b => b && !seen.has(b.id));
      if (additions.length === 0) return;

      // kenoResults is newest-first; bets carry an ISO timestamp, so re-sort the
      // union rather than assuming the two ranges don't interleave.
      state.kenoResults[canonKey] = canon.concat(additions).sort(
        (a, b) => new Date(b?.timestamp || 0) - new Date(a?.timestamp || 0)
      );
      if (state.kenoResults[canonKey].length > 1500) state.kenoResults[canonKey].length = 1500;

      if (!state.kenoLifetimeBets) state.kenoLifetimeBets = {};
      if (!state.kenoTotalBets) state.kenoTotalBets = {};
      const legacyLifetime = state.kenoLifetimeBets[legacyKey] || legacy.length;
      state.kenoLifetimeBets[canonKey] = (state.kenoLifetimeBets[canonKey] || 0) + legacyLifetime;
      state.kenoTotalBets[canonKey] = state.kenoLifetimeBets[canonKey];

      merged += additions.length;
    });

    if (merged > 0) {
      // Hot numbers are derived; rebuild from the merged buffer so they can't
      // disagree with it.
      if (!state.kenoHotNumbers) state.kenoHotNumbers = {};
      const counts = new Array(40).fill(0);
      (state.kenoResults[canonKey] || []).forEach(bet => {
        (bet?.state?.drawnNumbers || []).forEach(num => {
          const n = parseInt(num, 10);
          if (n >= 1 && n <= 40) counts[n - 1]++;
        });
      });
      state.kenoHotNumbers[canonKey] = counts;

      log(`♻️ Vantedge: merged ${merged} Winna bet(s) from legacy origins into ${canonKey}`);
      saveToStorage();
    }
  }

  // Initialize sophisticated storage manager for persistent legend stats
  (async () => {
    try {
      // VantEdgeStorageManager is now available globally via importScripts
      if (typeof VantEdgeStorageManager !== 'undefined') {
        const manager = new VantEdgeStorageManager();
        self.VantEdgeStorageManager = manager;
        storageManagerReady = await manager.init();
        log('VantEdge Storage Manager initialized:', storageManagerReady);
      } else {
        console.error('Storage manager class not found');
      }
    } catch (error) {
      console.error('Failed to initialize storage manager:', error);
    }
  })();

  browser.runtime.onConnect.addListener(port => {
    if (port.name !== 'grokalyzer-port') return;
    activeConnections.set(port, port.sender?.tab?.id);
    port.onMessage.addListener(async (message) => {
      await stateIsLoaded;
      if (!activeConnections.has(port)) return;

      // Process Keno and Mines bets only
      if (message.type !== 'KENO_BET_DATA' && message.type !== 'MINES_BET_DATA') return;

      // Process immediately for all sites (spam is already filtered in injected.js)
      if (message.type === 'KENO_BET_DATA') {
        handleKenoBet(message.data, message.site);
      } else if (message.type === 'MINES_BET_DATA') {
        handleMinesBet(message.data, message.site);
      }
    });
    port.onDisconnect.addListener(() => { activeConnections.delete(port); });
  });

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
      await stateIsLoaded;

      let siteKey;
      if (sender.tab && sender.tab.url) {
        siteKey = `${new URL(sender.tab.url).origin}-keno-session`;
      } else if (message.origin) {
        siteKey = `${message.origin}-keno-session`;
      }

      switch (message.type) {
        case 'RESET_STATS':
          resetAllStats();
          sendResponse({ success: true });
          break;

        case 'RESET_SITE_STATS':
          // Start reset asynchronously but respond immediately to prevent channel timeout
          resetSiteStats(message.origin)
            .then(() => {
              log(`✅ [RESET] Reset completed for ${message.origin}`);
            })
            .catch((error) => {
              console.error('❌ [RESET] Reset failed:', error);
            });
          // Send immediate success response - actual reset continues in background
          sendResponse({ success: true });
          break;

        case 'ANALYZE_CORRELATIONS':
          if (!siteKey) {
            sendResponse({ type: 'CORRELATIONS_RESULT', result: null });
            break;
          }
          const totalBets = state.kenoTotalBets[siteKey] || 0;
          const result = getCorrelationsWithBetsSince(siteKey, totalBets);
          sendResponse({ type: 'CORRELATIONS_RESULT', result });
          break;

        case 'SET_ACTIVE_STRATEGY':
          log(`Vantedge BG: Setting next Keno strategy for ${message.origin} to '${message.strategy}'`);
          lastKenoStrategy[message.origin] = message.strategy;
          sendResponse({ success: true });
          break;

        case 'GET_HEATMAP_FOR_MINE_COUNT':
          const requestedMineCount = message.mineCount || state.currentMineCount;
          const heatmap = state.minesHeatmaps[requestedMineCount] || new Array(25).fill(0);
          const totalGamesForCount = (state.minesAdvancedStats?.gamesByMineCount?.[requestedMineCount] || []).length;
          sendResponse({ heatmap, mineCount: requestedMineCount, totalGames: totalGamesForCount });
          break;

        case 'GET_PREDICTIONS': {
          const predMineCount = message.mineCount || state.currentMineCount;
          sendResponse({ safePositions: predictMinesSafePositions(predMineCount), mineCount: predMineCount });
          break;
        }

        // NEW: Enhanced prediction data requests
        case 'GET_AI_RECOMMENDATION':
          if (!siteKey) {
            sendResponse({ success: false, error: 'No site key' });
            break;
          }
          const aiRec = getBestStrategy(siteKey);
          sendResponse({ success: true, recommendation: aiRec });
          break;

        case 'GET_MOMENTUM_DATA':
          if (!siteKey) {
            sendResponse({ success: false, error: 'No site key' });
            break;
          }
          sendResponse({ success: true, data: state.kenoMomentumData[siteKey] || [] });
          break;

        case 'GET_ZONE_ANALYSIS':
          if (!siteKey) {
            sendResponse({ success: false, error: 'No site key' });
            break;
          }
          sendResponse({ success: true, data: state.kenoZoneAnalysis[siteKey] || null });
          break;

        case 'GET_BIAS_DETECTION':
          if (!siteKey) {
            sendResponse({ success: false, error: 'No site key' });
            break;
          }
          sendResponse({ success: true, data: state.kenoBiasDetection[siteKey] || null });
          break;

        case 'GET_LEGEND_STATS':
          if (!siteKey) {
            sendResponse({ success: false, error: 'No site key' });
            break;
          }
          const legendData = state.legendStats[siteKey] || {
            totalHits: 0,
            hitsByMultiplier: {},
            hitsByStrategy: {},
            recentHits: []
          };
          sendResponse({ success: true, stats: legendData });
          break;

        case 'GET_BET_SIZING_RECOMMENDATION':
          if (!siteKey) {
            sendResponse({ success: false, error: 'No site key' });
            break;
          }
          const optimalSpotCount = getBestSpotCount(siteKey);
          sendResponse({ success: true, optimalSpotCount, stats: state.kenoBetSizingStats[siteKey] || {} });
          break;

        case 'EXPORT_LEGEND_STATS': {
          // Try IndexedDB first (richer data), fall back to browser.storage.local
          try {
            const manager = self.VantEdgeStorageManager;
            if (manager && storageManagerReady) {
              const jsonData = await manager.exportToJSON();
              sendResponse({ success: true, data: jsonData });
            } else {
              // Direct fallback: read from browser.storage.local
              const result = await browser.storage.local.get('legendStats');
              const legendStats = result.legendStats || {};
              const exportData = {
                version: 1,
                exportDate: new Date().toISOString(),
                legendStats,
                metadata: {
                  totalSites: Object.keys(legendStats).length,
                  totalHits: Object.values(legendStats).reduce((s, v) => s + (v.totalHits || 0), 0)
                }
              };
              sendResponse({ success: true, data: JSON.stringify(exportData, null, 2) });
            }
          } catch (err) {
            sendResponse({ success: false, error: err.message });
          }
          break;
        }

        case 'IMPORT_LEGEND_STATS': {
          // Import directly into browser.storage.local — this always works in both
          // Chrome and Firefox service workers without needing IndexedDB.
          // IndexedDB (storage manager) is used as a secondary sync if available.
          try {
            const importData = JSON.parse(message.data);
            if (!importData.legendStats || typeof importData.legendStats !== 'object') {
              sendResponse({ success: false, error: 'Invalid file: missing legendStats' });
              break;
            }

            // Merge into existing legend stats
            const existing = await browser.storage.local.get('legendStats');
            const merged = { ...(existing.legendStats || {}), ...importData.legendStats };
            await browser.storage.local.set({ legendStats: merged });
            state.legendStats = merged;

            const sitesImported = Object.keys(importData.legendStats).length;
            log(`✅ Import: ${sitesImported} site(s) saved to browser.storage.local`);

            // Also push to IndexedDB if available (best-effort, non-blocking)
            const manager = self.VantEdgeStorageManager;
            if (manager && storageManagerReady) {
              (async () => {
                for (const [siteKey, stats] of Object.entries(importData.legendStats)) {
                  await manager.saveLegendStats(siteKey, stats).catch(e =>
                    console.warn('IndexedDB sync failed for', siteKey, e)
                  );
                }
              })();
            }

            sendResponse({ success: true, sitesImported });
          } catch (err) {
            console.error('❌ Import failed:', err);
            sendResponse({ success: false, error: err.message });
          }
          break;
        }

        case 'CREATE_BACKUP': {
          const manager = self.VantEdgeStorageManager;
          if (manager && storageManagerReady) {
            manager.createBackup(message.description || 'Manual backup').then(backupId => {
              sendResponse({ success: true, backupId });
            }).catch(err => {
              sendResponse({ success: false, error: err.message });
            });
          } else {
            sendResponse({ success: false, error: 'Storage manager not ready' });
          }
          break;
        }

        case 'GET_BACKUPS': {
          const manager = self.VantEdgeStorageManager;
          if (manager && storageManagerReady) {
            manager.getAllBackups().then(backups => {
              sendResponse({ success: true, backups });
            }).catch(err => {
              sendResponse({ success: false, error: err.message });
            });
          } else {
            sendResponse({ success: false, error: 'Storage manager not ready' });
          }
          break;
        }

        case 'RESTORE_BACKUP': {
          const manager = self.VantEdgeStorageManager;
          if (manager && storageManagerReady) {
            manager.restoreFromBackup(message.backupId).then(backup => {
              return browser.storage.local.get('legendStats').then(localResult => {
                if (localResult.legendStats) {
                  state.legendStats = localResult.legendStats;
                }
                sendResponse({ success: true, timestamp: backup.timestamp });
              });
            }).catch(err => {
              sendResponse({ success: false, error: err.message });
            });
          } else {
            sendResponse({ success: false, error: 'Storage manager not ready' });
          }
          break;
        }

        case 'GET_STORAGE_STATS': {
          const manager = self.VantEdgeStorageManager;
          if (manager && storageManagerReady) {
            manager.getStorageStats().then(stats => {
              sendResponse({ success: true, stats });
            }).catch(err => {
              sendResponse({ success: false, error: err.message });
            });
          } else {
            sendResponse({ success: false, error: 'Storage manager not ready' });
          }
          break;
        }

        case 'FORCE_SYNC_TO_INDEXEDDB': {
          const manager = self.VantEdgeStorageManager;
          if (manager && storageManagerReady) {
            // Read all legendStats from browser.storage.local (Promise API — Firefox compat)
            browser.storage.local.get('legendStats').then(async (result) => {
              try {
                const legendStats = result.legendStats || {};
                const siteKeys = Object.keys(legendStats);

                if (siteKeys.length === 0) {
                  sendResponse({ success: true, message: 'No legend stats found in browser storage', synced: 0 });
                  return;
                }

                // Re-sync all legend stats to IndexedDB
                for (const [siteKey, stats] of Object.entries(legendStats)) {
                  await manager.saveLegendStats(siteKey, stats);
                }

                // Create a fresh backup after sync
                await manager.createBackup('Post-sync backup');

                sendResponse({
                  success: true,
                  message: `Re-synced ${siteKeys.length} site(s) to IndexedDB and created backup`,
                  synced: siteKeys.length
                });
              } catch (err) {
                sendResponse({ success: false, error: err.message });
              }
            }).catch(err => sendResponse({ success: false, error: err.message }));
          } else {
            sendResponse({ success: false, error: 'Storage manager not ready' });
          }
          break;
        }

        // ----------------- Cloud Sync (GitHub Gist) -----------------
        case 'CLOUD_SET_TOKEN': {
          try {
            const r = await self.VantedgeCloudSync.setToken(message.token);
            sendResponse({ success: true, ...r });
          } catch (err) { sendResponse({ success: false, error: err.message }); }
          break;
        }

        case 'CLOUD_VERIFY': {
          try {
            const r = await self.VantedgeCloudSync.verifyToken();
            sendResponse({ success: true, ...r });
          } catch (err) { sendResponse({ success: false, error: err.message }); }
          break;
        }

        case 'CLOUD_PUSH_NOW': {
          try {
            const r = await self.VantedgeCloudSync.pushNow();
            sendResponse({ success: true, ...r });
          } catch (err) { sendResponse({ success: false, error: err.message }); }
          break;
        }

        case 'CLOUD_PULL_NOW': {
          try {
            const r = await self.VantedgeCloudSync.pullNow();
            sendResponse({ success: true, ...r });
          } catch (err) { sendResponse({ success: false, error: err.message }); }
          break;
        }

        case 'CLOUD_STATUS': {
          try {
            const r = await self.VantedgeCloudSync.getStatus();
            sendResponse({ success: true, ...r });
          } catch (err) { sendResponse({ success: false, error: err.message }); }
          break;
        }

        default:
          // Always respond, even for unknown message types
          console.warn(`Unknown message type: ${message.type}`);
          sendResponse({ success: false, error: `Unknown message type: ${message.type}` });
          break;
      }
    })();
    return true;
  });

  // Auto-push to Drive 5s after any synced storage key changes.
  // No-op if user hasn't signed in to Drive yet.
  if (browser?.storage?.onChanged) {
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const synced = self.VantedgeCloudSync?.SYNCED_STORAGE_KEYS || [];
      const touched = Object.keys(changes).some(k => synced.includes(k));
      if (touched) self.VantedgeCloudSync?.scheduleAutoPush(5000);
    });
  }

  // On worker startup, pull from Drive if remote is newer than local
  (async () => {
    try {
      await stateIsLoaded;
      if (self.VantedgeCloudSync) {
        await self.VantedgeCloudSync.pullIfNewer();
      }
    } catch (e) { /* signed out or first-run — ignore */ }
  })();

  // =================================================================
  // MINES — bet processing + analytics
  // Restored from the original implementation (it was removed in a perf commit
  // that left a no-op stub, which is why the Mines panel showed no data). The
  // capture pipeline (injected.js -> port) still emits MINES_BET_DATA; this
  // repopulates the heatmaps / advanced stats / predictions the popup reads.
  // Growth is capped and there is no per-tick work (only completed rounds).
  // =================================================================
  // Finished mines rounds kept per site — deep enough for the overlay's
  // heatmap to mean something without bloating storage (~350 bytes a round).
  const MINES_HISTORY_LIMIT = 500;

  function ensureMinesStatsShape() {
    const s = state.minesAdvancedStats || (state.minesAdvancedStats = {});
    if (typeof s.totalGames !== 'number') s.totalGames = 0;
    if (typeof s.wins !== 'number') s.wins = 0;
    if (typeof s.losses !== 'number') s.losses = 0;
    if (typeof s.totalProfit !== 'number') s.totalProfit = 0;
    if (typeof s.totalWagered !== 'number') s.totalWagered = 0;
    if (typeof s.currency !== 'string') s.currency = 'btc'; // stats saved before this field existed
    if (!s.streaks) s.streaks = { current: { type: null, count: 0 }, longest: { win: 0, loss: 0 } };
    if (!s.patterns) s.patterns = { clusters: [], safeZones: [], hotSpots: [] };
    if (!Array.isArray(s.gameHistory)) s.gameHistory = [];
    if (!s.gamesByMineCount) s.gamesByMineCount = {};
    return s;
  }

  function handleMinesBet(betData, site) {
    // Only record completed rounds (a finished game reports active:false).
    if (!betData || betData.active !== false) return;

    const siteKey = site || 'unknown';
    if (!state.minesResults[siteKey]) state.minesResults[siteKey] = [];
    // Dedup — don't double-count the same finished game.
    if (betData.id && state.minesResults[siteKey].some(g => g && g.id === betData.id)) return;

    const mineCount = betData.state?.minesCount || betData.state?.mineCount || 3;
    state.currentMineCount = mineCount;

    state.minesResults[siteKey].unshift(betData);
    // The overlay's heatmap, clusters and combo history all read this window,
    // so keep a session's worth of rounds. The emergency cleanup below still
    // cuts it back to 100 if storage ever runs tight.
    if (state.minesResults[siteKey].length > MINES_HISTORY_LIMIT) {
      state.minesResults[siteKey] = state.minesResults[siteKey].slice(0, MINES_HISTORY_LIMIT);
    }

    updateMinesAdvancedStats(betData, betData.payoutMultiplier > 0);

    const mines = betData.state?.mines;
    if (Array.isArray(mines) && mines.length > 0) {
      if (!state.minesHeatmaps[mineCount]) state.minesHeatmaps[mineCount] = new Array(25).fill(0);
      mines.forEach((mp) => {
        const position = parseInt(mp, 10);
        if (position >= 0 && position < 25) {
          state.minesHeatmaps[mineCount][position] = (state.minesHeatmaps[mineCount][position] || 0) + 1;
        }
      });
      analyzeMinesPatterns(mines, betData);
    }

    state.lastPlayedGame = 'Mines';
    saveToStorage();
  }

  function predictMinesSafePositions(mineCount) {
    const heatmap = state.minesHeatmaps[mineCount] || new Array(25).fill(0);
    const totalMinesPlaced = heatmap.reduce((sum, val) => sum + val, 0);
    const totalGames = totalMinesPlaced > 0 ? Math.round(totalMinesPlaced / mineCount) : 0;
    if (totalGames < 3) return [];
    return heatmap
      .map((count, index) => {
        const smoothedMineRate = (count + 1) / (totalGames + 2);
        return { position: index, safeProbability: Math.min(99.9, (1 - smoothedMineRate) * 100) };
      })
      .sort((a, b) => b.safeProbability - a.safeProbability)
      .slice(0, 5);
  }

  function updateMinesAdvancedStats(betData, isWin) {
    const stats = ensureMinesStatsShape();
    const mineCount = betData.state?.minesCount || betData.state?.mineCount || 3;

    stats.totalGames++;
    if (isWin) stats.wins++; else stats.losses++;

    // Stake × (multiplier − 1) — `payout` means gross return on some sites and
    // profit on others, so it can't be differenced against the stake.
    const gameProfit = self.VantedgeMoney.betProfit(betData);
    stats.totalProfit += gameProfit;
    stats.totalWagered += self.VantedgeMoney.betStake(betData);
    if (betData.currency) stats.currency = self.VantedgeMoney.curKey(betData.currency);

    const cur = stats.streaks.current;
    if (cur.type === null || (isWin && cur.type === 'win') || (!isWin && cur.type === 'loss')) {
      cur.type = isWin ? 'win' : 'loss';
      cur.count++;
    } else {
      if (cur.count > stats.streaks.longest[cur.type]) stats.streaks.longest[cur.type] = cur.count;
      cur.type = isWin ? 'win' : 'loss';
      cur.count = 1;
    }

    if (!stats.gamesByMineCount[mineCount]) stats.gamesByMineCount[mineCount] = [];

    let timestamp = new Date(betData.updatedAt || Date.now());
    if (isNaN(timestamp.getTime())) timestamp = new Date();

    const gameRecord = {
      id: betData.id,
      timestamp,
      isWin,
      mines: betData.state?.mines || [],
      rounds: betData.state?.rounds || [],
      profit: gameProfit,
      currency: stats.currency,
      mineCount
    };

    stats.gamesByMineCount[mineCount].unshift(gameRecord);
    if (stats.gamesByMineCount[mineCount].length > 50) {
      stats.gamesByMineCount[mineCount] = stats.gamesByMineCount[mineCount].slice(0, 50);
    }

    stats.gameHistory.unshift(gameRecord);
    if (stats.gameHistory.length > 50) stats.gameHistory.pop();

    stats.currentMineCount = mineCount;
  }

  function analyzeMinesPatterns(mines, betData) {
    const stats = ensureMinesStatsShape();
    stats.patterns.clusters = updateMinesClusters(stats.patterns.clusters, detectMinesClusters(mines));
    const safeFields = betData.state?.rounds?.map(round => round.field) || [];
    stats.patterns.safeZones = updateMinesSafeZones(stats.patterns.safeZones, safeFields);
    const mineCount = betData.state?.minesCount || betData.state?.mineCount || 3;
    stats.patterns.hotSpots = analyzeMinesHotSpots(state.minesHeatmaps[mineCount] || new Array(25).fill(0));
  }

  function detectMinesClusters(mines) {
    const clusters = [];
    const visited = new Set();
    mines.forEach(mine => {
      const pos = parseInt(mine, 10);
      if (visited.has(pos)) return;
      const cluster = findMinesCluster(pos, mines.map(Number), visited);
      if (cluster.length >= 2) {
        clusters.push({ positions: cluster, center: minesClusterCenter(cluster), density: cluster.length });
      }
    });
    return clusters;
  }

  function findMinesCluster(startPos, allMines, visited) {
    const cluster = [startPos];
    visited.add(startPos);
    minesNeighbors(startPos).forEach(neighbor => {
      if (!visited.has(neighbor) && allMines.includes(neighbor)) {
        cluster.push(...findMinesCluster(neighbor, allMines, visited));
      }
    });
    return cluster;
  }

  function minesNeighbors(position) {
    const row = Math.floor(position / 5), col = position % 5, neighbors = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = row + dr, nc = col + dc;
        if (nr >= 0 && nr < 5 && nc >= 0 && nc < 5) neighbors.push(nr * 5 + nc);
      }
    }
    return neighbors;
  }

  function minesClusterCenter(positions) {
    const tRow = positions.reduce((s, p) => s + Math.floor(p / 5), 0);
    const tCol = positions.reduce((s, p) => s + (p % 5), 0);
    return { row: tRow / positions.length, col: tCol / positions.length };
  }

  function minesClustersOverlap(c1, c2) {
    return c1.some(pos => c2.includes(pos));
  }

  function updateMinesClusters(existing, fresh) {
    fresh.forEach(nc => {
      const match = existing.find(c => minesClustersOverlap(c.positions, nc.positions));
      if (match) {
        match.frequency = (match.frequency || 1) + 1;
        match.lastSeen = Date.now();
      } else {
        existing.push({ ...nc, frequency: 1, firstSeen: Date.now(), lastSeen: Date.now() });
      }
    });
    return existing.slice(0, 20);
  }

  function updateMinesSafeZones(existing, newSafeFields) {
    newSafeFields.forEach(field => {
      const match = existing.find(zone => zone.position === field);
      if (match) {
        match.frequency++;
        match.lastSafe = Date.now();
      } else {
        existing.push({ position: field, frequency: 1, firstSafe: Date.now(), lastSafe: Date.now() });
      }
    });
    return existing.sort((a, b) => b.frequency - a.frequency).slice(0, 15);
  }

  function analyzeMinesHotSpots(heatmap) {
    const max = Math.max(...heatmap) || 1;
    return heatmap
      .map((count, index) => ({ position: index, count }))
      .filter(spot => spot.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
      .map(spot => ({
        position: spot.position,
        frequency: spot.count,
        intensity: spot.count / max,
        row: Math.floor(spot.position / 5),
        col: spot.position % 5
      }));
  }

  async function handleKenoBet(betData, site) {
    if (!betData || !betData.state || !Array.isArray(betData.state.drawnNumbers)) {
      console.warn('⚠️ Invalid Keno bet data received', betData);
      return;
    }

    betData.payoutMultiplier = parseFloat(betData.payoutMultiplier || 0);

    const sitePrefix = site || 'unknown';
    const siteKey = `${sitePrefix}-keno-session`;

    let siteOrigin;
    try {
      siteOrigin = new URL(site).origin;
    } catch (e) {
      console.warn('Invalid site URL:', site);
      siteOrigin = site || 'unknown';
    }

    // Check if a reset happened recently (within 2 seconds) - ignore bets to prevent race condition
    if (resetTimestamps[siteKey]) {
      const timeSinceReset = Date.now() - resetTimestamps[siteKey];
      if (timeSinceReset < 2000) {
        log(`🚫 [RESET] Ignoring bet received ${timeSinceReset}ms after reset for ${siteKey}`);
        return;
      } else {
        // Clear the reset timestamp after the grace period
        delete resetTimestamps[siteKey];
      }
    }

    // Debug log for high multipliers
    if (betData.payoutMultiplier >= 30) {
      log(`🎯 BG: Received HIGH multiplier ${betData.payoutMultiplier}x from ${siteOrigin}`);
      log(`   Strategy: ${betData.activeStrategy || 'NONE'}`);
      log(`   Site Key: ${siteKey}`);
    }

    if (lastKenoStrategy[siteOrigin]) {
      betData.strategyUsed = lastKenoStrategy[siteOrigin];
      delete lastKenoStrategy[siteOrigin];
    }

    if (betData.payoutMultiplier >= 30) {
      const activeKenoStrategy = betData.activeStrategy;

      if (activeKenoStrategy) {
        log(`   ✅ SAVING to legend stats (strategy: ${activeKenoStrategy})`);
        if (!state.legendStats) state.legendStats = {};
        if (!state.legendStats[siteKey]) {
          state.legendStats[siteKey] = { totalHits: 0, hitsByMultiplier: {}, hitsByStrategy: {}, recentHits: [] };
        }
        const legend = state.legendStats[siteKey];
        const multiplier = String(betData.payoutMultiplier);

        legend.totalHits = (legend.totalHits || 0) + 1;

        // Track both count and total payout for each multiplier
        // Migrate old format (number) to new format ({ count, totalPayout })
        if (!legend.hitsByMultiplier[multiplier]) {
          legend.hitsByMultiplier[multiplier] = { count: 0, totalPayout: 0 };
        } else if (typeof legend.hitsByMultiplier[multiplier] === 'number') {
          // Migrate old format to new format
          legend.hitsByMultiplier[multiplier] = {
            count: legend.hitsByMultiplier[multiplier],
            totalPayout: 0
          };
        }
        legend.hitsByMultiplier[multiplier].count = (legend.hitsByMultiplier[multiplier].count || 0) + 1;
        // Gross return = stake × multiplier. Derived rather than read from
        // `payout`, which some sites fill with profit instead of the return.
        legend.hitsByMultiplier[multiplier].totalPayout =
          (legend.hitsByMultiplier[multiplier].totalPayout || 0)
          + self.VantedgeMoney.betStake(betData) * (Number(betData.payoutMultiplier) || 0);
        legend.currency = self.VantedgeMoney.curKey(betData.currency);

        legend.hitsByStrategy[activeKenoStrategy] = (legend.hitsByStrategy[activeKenoStrategy] || 0) + 1;

        legend.recentHits.unshift({
          multiplier: betData.payoutMultiplier,
          strategy: activeKenoStrategy,
          amount: betData.amount || 0,  // amount + multiplier give the profit
          currency: self.VantedgeMoney.curKey(betData.currency),
          payout: betData.payout || 0,
          timestamp: new Date().toISOString()
        });
        if (legend.recentHits.length > 20) legend.recentHits.pop();

        // Save to sophisticated storage manager for persistence
        if (storageManagerReady) {
          const manager = self.VantEdgeStorageManager;
          if (manager) {
            manager.saveLegendStats(siteKey, legend).catch(err => {
              console.error('Failed to save legend stats to storage manager:', err);
            });
          }
        }
      } else {
        log(`   ❌ NOT SAVED: No strategy attached to bet data`);
      }
    }

    if (!state.kenoResults[siteKey]) state.kenoResults[siteKey] = [];
    if (state.kenoResults[siteKey].some(g => g.id === betData.id)) return;

    state.kenoResults[siteKey].unshift(betData);
    // Cap at 1500 (newest kept). All analysis reads <=1000 (stats), 500
    // (correlations), <=200 (hot groups); a 5000-cap just bloated every storage
    // write + onChanged payload, which is what made long sessions lag.
    if (state.kenoResults[siteKey].length > 1500) state.kenoResults[siteKey].length = 1500;

    // Lifetime bet count — independent of the 1500 buffer cap so the visible
    // counter keeps climbing after the buffer stops growing. The dedup guard
    // above already returned for repeat ids, so each real bet counts once.
    if (state.kenoLifetimeBets[siteKey] == null) {
      // First bet since this feature landed: seed from the buffer so existing
      // sessions don't reset to 1 (best available lower bound — true history
      // before now was never stored).
      state.kenoLifetimeBets[siteKey] = state.kenoResults[siteKey].length;
    } else {
      state.kenoLifetimeBets[siteKey]++;
    }
    state.kenoTotalBets[siteKey] = state.kenoLifetimeBets[siteKey];

    if (!state.kenoHotNumbers[siteKey]) state.kenoHotNumbers[siteKey] = new Array(40).fill(0);
    betData.state.drawnNumbers.forEach(num => {
      const pNum = parseInt(num, 10);
      if (pNum >= 1 && pNum <= 40) state.kenoHotNumbers[siteKey][pNum - 1]++;
    });

    processLegendStats(betData, siteOrigin);

    // OPTIMIZED: Always track strategy performance (lightweight)
    trackStrategyPerformance(betData, siteKey);
    trackBetSizingPerformance(betData, siteKey);

    // OPTIMIZED: Run heavy analytics only every 5 bets to reduce lag
    const totalBets = state.kenoTotalBets[siteKey] || 0;
    if (totalBets % 5 === 0) {
      updateMomentumData(siteKey);
      updateZoneAnalysis(siteKey);
      updateBiasDetection(siteKey);
    }

    state.lastPlayedGame = 'Keno';
    saveToStorage();
  }

  // =================================================================
  // ENHANCED PREDICTION TRACKING FUNCTIONS
  // =================================================================

  // Track which strategies are performing best
  function trackStrategyPerformance(betData, siteKey) {
    const strategy = betData.activeStrategy || betData.strategyUsed;
    if (!strategy) return;

    if (!state.kenoStrategyPerformance[siteKey]) {
      state.kenoStrategyPerformance[siteKey] = {};
    }

    if (!state.kenoStrategyPerformance[siteKey][strategy]) {
      state.kenoStrategyPerformance[siteKey][strategy] = {
        totalGames: 0,
        wins: 0,
        totalMultiplier: 0,
        maxMultiplier: 0,
        last20Results: []
      };
    }

    const perf = state.kenoStrategyPerformance[siteKey][strategy];
    perf.totalGames++;

    const isWin = betData.payoutMultiplier > 0;
    if (isWin) perf.wins++;

    perf.totalMultiplier += betData.payoutMultiplier || 0;
    perf.maxMultiplier = Math.max(perf.maxMultiplier, betData.payoutMultiplier || 0);

    // Track last 20 results for recent performance
    perf.last20Results.unshift({
      multiplier: betData.payoutMultiplier || 0,
      isWin: isWin
    });
    if (perf.last20Results.length > 20) perf.last20Results.length = 20;
  }

  // Calculate momentum (hot/cold streaks) for each number
  function updateMomentumData(siteKey) {
    const results = state.kenoResults[siteKey] || [];
    if (results.length < 10) return;

    if (!state.kenoMomentumData[siteKey]) {
      state.kenoMomentumData[siteKey] = new Array(40).fill(null).map(() => ({
        recentAppearances: 0,
        momentum: 1.0,
        trend: 'neutral' // 'heating', 'cooling', 'neutral', 'hot_streak'
      }));
    }

    const recentGames = Math.min(10, results.length);
    const historicalGames = results.length;

    for (let numIdx = 0; numIdx < 40; numIdx++) {
      const number = (numIdx + 1).toString();

      // Count appearances in last 10 games
      let recentCount = 0;
      for (let i = 0; i < recentGames; i++) {
        if (results[i]?.state?.drawnNumbers?.includes(number)) {
          recentCount++;
        }
      }

      // Count total historical appearances
      const historicalCount = state.kenoHotNumbers[siteKey]?.[numIdx] || 0;

      // Calculate frequencies
      const recentFreq = recentCount / recentGames;
      const historicalFreq = historicalCount / historicalGames;

      // Momentum = recent frequency / historical frequency
      // > 1 = heating up, < 1 = cooling down
      const momentum = historicalFreq > 0 ? recentFreq / historicalFreq : 1.0;

      // Determine trend
      let trend = 'neutral';
      if (recentCount >= 3) trend = 'hot_streak'; // 3+ in last 10 = hot streak
      else if (momentum > 1.3) trend = 'heating'; // 30% above average
      else if (momentum < 0.7) trend = 'cooling'; // 30% below average

      state.kenoMomentumData[siteKey][numIdx] = {
        recentAppearances: recentCount,
        momentum: momentum,
        trend: trend
      };
    }
  }

  // Analyze hot/cold zones on the 8x5 grid
  function updateZoneAnalysis(siteKey) {
    const hotNumbers = state.kenoHotNumbers[siteKey];
    if (!hotNumbers) return;

    // Define zones as 2x2 grids (20 total zones in 8x5 grid)
    const zones = [];
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 7; col++) {
        const numbers = [
          row * 8 + col + 1,
          row * 8 + col + 2,
          (row + 1) * 8 + col + 1,
          (row + 1) * 8 + col + 2
        ];

        const totalHeat = numbers.reduce((sum, num) => sum + (hotNumbers[num - 1] || 0), 0);

        zones.push({
          row: row,
          col: col,
          numbers: numbers,
          heat: totalHeat
        });
      }
    }

    // Sort by heat to find hottest zones
    zones.sort((a, b) => b.heat - a.heat);

    state.kenoZoneAnalysis[siteKey] = {
      zones: zones,
      hottestZone: zones[0],
      coldestZone: zones[zones.length - 1]
    };
  }

  // Detect if certain number ranges are biased (appearing more/less than expected)
  function updateBiasDetection(siteKey) {
    const results = state.kenoResults[siteKey] || [];
    if (results.length < 20) return;

    const recentGames = Math.min(20, results.length);
    const ranges = {
      '1-10': { count: 0, expected: 0 },
      '11-20': { count: 0, expected: 0 },
      '21-30': { count: 0, expected: 0 },
      '31-40': { count: 0, expected: 0 }
    };

    // Count appearances in last 20 games
    for (let i = 0; i < recentGames; i++) {
      const drawnNumbers = results[i]?.state?.drawnNumbers || [];
      drawnNumbers.forEach(num => {
        const n = parseInt(num);
        if (n >= 1 && n <= 10) ranges['1-10'].count++;
        else if (n >= 11 && n <= 20) ranges['11-20'].count++;
        else if (n >= 21 && n <= 30) ranges['21-30'].count++;
        else if (n >= 31 && n <= 40) ranges['31-40'].count++;
      });
    }

    // Expected: each range should have ~25% of drawn numbers
    // (20 numbers drawn per game, 4 ranges = 5 per range on average)
    const totalDrawn = recentGames * 20;
    const expectedPerRange = totalDrawn / 4;

    // Calculate bias (actual / expected)
    Object.keys(ranges).forEach(range => {
      ranges[range].expected = expectedPerRange;
      ranges[range].bias = ranges[range].count / expectedPerRange;
      ranges[range].deviation = ((ranges[range].bias - 1) * 100).toFixed(1); // % above/below expected
    });

    // Find most biased range
    const sortedRanges = Object.entries(ranges).sort((a, b) => b[1].bias - a[1].bias);
    const hottestRange = sortedRanges[0];

    state.kenoBiasDetection[siteKey] = {
      ranges: ranges,
      hottestRange: hottestRange[1].bias > 1.2 ? hottestRange[0] : null, // Only if >20% above expected
      lastUpdated: Date.now()
    };
  }

  // Track performance by spot count (4-spot, 6-spot, 8-spot, 10-spot)
  function trackBetSizingPerformance(betData, siteKey) {
    const spotCount = betData.state?.selectedNumbers?.length;
    if (!spotCount) return;

    if (!state.kenoBetSizingStats[siteKey]) {
      state.kenoBetSizingStats[siteKey] = {};
    }

    if (!state.kenoBetSizingStats[siteKey][spotCount]) {
      state.kenoBetSizingStats[siteKey][spotCount] = {
        totalGames: 0,
        wins: 0,
        totalMultiplier: 0,
        maxMultiplier: 0
      };
    }

    const stats = state.kenoBetSizingStats[siteKey][spotCount];
    stats.totalGames++;

    const isWin = betData.payoutMultiplier > 0;
    if (isWin) stats.wins++;

    stats.totalMultiplier += betData.payoutMultiplier || 0;
    stats.maxMultiplier = Math.max(stats.maxMultiplier, betData.payoutMultiplier || 0);
  }

  // Get AI recommendation for best strategy to use
  // Track last recommendation to force rotation
  let lastRecommendation = {};
  // Tracking for strategy pick frequency to prevent "sticking"
  let strategyFatigue = {};

  function analyzeRecentPatterns(siteKey) {
    const results = state.kenoResults[siteKey] || [];
    const recentGames = results.slice(0, Math.min(30, results.length)); // Last 30 games only

    // Calculate hot numbers from RECENT games only
    const recentHotNumbers = new Array(40).fill(0);
    let repeatsInLast5 = 0;

    recentGames.forEach((game, gIdx) => {
      game?.state?.drawnNumbers?.forEach(num => {
        const idx = parseInt(num, 10) - 1;
        if (idx >= 0 && idx < 40) {
          recentHotNumbers[idx]++;

          // Momentum detection: did this number hit in the previous game too?
          if (gIdx < 5 && recentGames[gIdx + 1]?.state?.drawnNumbers?.includes(num)) {
            repeatsInLast5++;
          }
        }
      });
    });

    // Calculate pattern indicators from RECENT data
    const maxHeat = Math.max(...recentHotNumbers, 1);
    const avgHeat = recentHotNumbers.reduce((a, b) => a + b, 0) / 40;

    // Hot concentration (are numbers concentrated or spread?)
    const hotNumbersCount = recentHotNumbers.filter(h => h > avgHeat * 1.5).length;
    const concentration = hotNumbersCount / 40;

    // Bias detection (Low 1-20 vs High 21-40)
    const lowCount = recentHotNumbers.slice(0, 20).reduce((a, b) => a + b, 0);
    const highCount = recentHotNumbers.slice(20, 40).reduce((a, b) => a + b, 0);
    const biasRatio = Math.max(lowCount, highCount) / Math.max(Math.min(lowCount, highCount), 1);
    const hasBias = biasRatio > 1.35;

    // Spread (opposite of concentration)
    const coldNumbersCount = recentHotNumbers.filter(h => h < avgHeat * 0.5).length;
    const spread = coldNumbersCount / 40;

    // Momentum strength (based on repeats)
    const momentum = Math.min(repeatsInLast5 / 25, 1); // Normalizes roughly to 0-1

    // Variance in recent draw sizes (how many numbers per game)
    const recentDraws = recentGames.map(r => r.state?.drawnNumbers?.length || 20);
    const avgDrawSize = recentDraws.reduce((a, b) => a + b, 0) / recentDraws.length;
    const variance = recentDraws.reduce((sum, size) => sum + Math.pow(size - avgDrawSize, 2), 0) / recentDraws.length;

    // Overdue potential (numbers that have been silent for a while)
    const overdueCount = recentHotNumbers.filter(h => h === 0).length;
    const overduePotential = overdueCount / 40;

    return {
      concentration,
      spread,
      variance,
      momentumStrength: momentum,
      overduePotential,
      hasBias,
      recentGamesAnalyzed: recentGames.length
    };
  }

  function scoreStrategyForPatterns(strategy, patterns) {
    let score = 0.5;

    switch (strategy) {
      case 'hot':
      case 'clusters':
        score = 0.6 + (patterns.concentration * 0.4);
        break;
      case 'cold':
      case 'antipattern':
        score = 0.6 + (patterns.spread * 0.4);
        break;
      case 'streak':
      case 'surge':
      case 'timeseries':
        score = 0.4 + (patterns.momentumStrength * 0.6);
        break;
      case 'zonehot':
      case 'positional':
      case 'hotzone':
      case 'sector':
        score = patterns.hasBias ? 0.85 : 0.35;
        break;
      case 'variance':
        score = 0.5 + (Math.min(patterns.variance / 12, 1) * 0.5);
        break;
      case 'cooling':
      case 'overdue':
        // Overdue/Cooling logic enhanced: works best when there's low concentration but high overdue potential
        score = 0.2 + (patterns.overduePotential * 0.8);
        break;
      case 'smart':
      case 'bayesian':
        score = 0.72;
        break;
      case 'entropy':
        score = 0.55 + (patterns.spread * 0.2) + (patterns.variance / 20 * 0.2);
        break;
      case 'progressive':
        score = 0.65;
        break;
      case 'random':
        score = 0.45; // Baseline
        break;
      case 'montecarlo':
        score = 0.68;
        break;
      default:
        score = 0.5;
    }

    return Math.min(score, 1.0);
  }

  function getBestStrategy(siteKey) {
    try {
      const results = state.kenoResults[siteKey] || [];
      if (results.length < 10) return null;

      const patterns = analyzeRecentPatterns(siteKey);
      const lastRec = lastRecommendation[siteKey];
      const gamesSinceChange = lastRec ? (results.length - lastRec.lastChanged) : 999;

      const currentPerf = lastRec ? (state.kenoStrategyPerformance[siteKey] || {})[lastRec.strategy] : null;
      let forceRotation = gamesSinceChange >= 30;

      if (lastRec && currentPerf && gamesSinceChange >= 10) {
        const recentLosingStreak = currentPerf.last20Results.slice(0, 8).every(r => !r.isWin);
        if (recentLosingStreak) forceRotation = true;
      }

      const allStrategies = ['hot', 'cold', 'smart', 'random', 'overdue', 'variance', 'positional', 'hotzone', 'sector', 'progressive', 'bayesian', 'montecarlo', 'entropy', 'antipattern', 'streak', 'zonehot', 'cooling'];
      const strategyScores = [];
      const perfData = state.kenoStrategyPerformance[siteKey] || {};

      for (const strategy of allStrategies) {
        if (forceRotation && lastRec && strategy === lastRec.strategy) continue;

        const patternScore = scoreStrategyForPatterns(strategy, patterns);
        const perf = perfData[strategy];
        let performanceScore = 0.5;

        if (perf && perf.totalGames >= 5) {
          const wr = perf.last20Results.length > 0 ? (perf.last20Results.filter(r => r.isWin).length / perf.last20Results.length) : 0;
          performanceScore = (wr * 0.4) + (Math.min(perf.totalMultiplier / Math.max(perf.totalGames, 1) / 100, 2) * 0.3) + 0.3;
        }

        const fatigue = (strategyFatigue[siteKey] && strategyFatigue[siteKey][strategy]) || 0;
        const isCurrent = lastRec && lastRec.strategy === strategy && !forceRotation;
        const finalScore = ((patternScore * 0.7) + (performanceScore * 0.3) - (fatigue * 0.05)) + (Math.random() * 0.05) + (isCurrent ? 0.25 : 0);

        strategyScores.push({ strategy, score: finalScore * 100, isCurrent });
      }

      strategyScores.sort((a, b) => b.score - a.score);
      let top = strategyScores[0];

      if (top && lastRec && !forceRotation && top.strategy !== lastRec.strategy) {
        const current = strategyScores.find(s => s.strategy === lastRec.strategy);
        if (current && (top.score - current.score) < 15) top = current;
      }

      if (top) {
        if (!strategyFatigue[siteKey]) strategyFatigue[siteKey] = {};
        allStrategies.forEach(s => {
          strategyFatigue[siteKey][s] = Math.max(0, (strategyFatigue[siteKey][s] || 0) + (s === top.strategy ? 0.2 : -0.1));
        });

        const changed = !lastRec || lastRec.strategy !== top.strategy;
        lastRecommendation[siteKey] = {
          strategy: top.strategy,
          gameCount: results.length,
          lastChanged: changed ? results.length : (lastRec ? lastRec.lastChanged : results.length)
        };
        return top;
      }
      return null;
    } catch (e) {
      console.error('AI Error:', e);
      return null;
    }
  }

  // Get optimal spot count recommendation
  function getBestSpotCount(siteKey) {
    const sizingData = state.kenoBetSizingStats[siteKey];
    if (!sizingData || Object.keys(sizingData).length === 0) {
      return 8; // Default recommendation
    }

    // Calculate score for each spot count
    const spotScores = [];

    Object.keys(sizingData).forEach(spotCount => {
      const stats = sizingData[spotCount];
      if (stats.totalGames < 3) return; // Need at least 3 games

      const winRate = stats.totalGames > 0 ? stats.wins / stats.totalGames : 0;
      const avgMultiplier = stats.totalGames > 0 ? stats.totalMultiplier / stats.totalGames : 0;

      // Score = weighted combination
      // 40% win rate, 60% avg multiplier (we want big wins!)
      const score = (winRate * 0.4) + (avgMultiplier / 100 * 0.6);

      spotScores.push({
        spotCount: parseInt(spotCount),
        score: score,
        winRate: winRate,
        avgMultiplier: avgMultiplier,
        maxMultiplier: stats.maxMultiplier,
        totalGames: stats.totalGames
      });
    });

    // Sort by score
    spotScores.sort((a, b) => b.score - a.score);

    return spotScores[0]?.spotCount || 8; // Return best spot count or default to 8
  }

  function getCombinations(arr, k) {
    const result = [];
    const n = arr.length;
    if (k > n || k <= 0) {
      return result;
    }

    const indices = Array.from({ length: k }, (_, i) => i);

    while (indices[0] <= n - k) {
      result.push(indices.map(i => arr[i]));

      let i = k - 1;
      while (i >= 0 && indices[i] === i + n - k) {
        i--;
      }

      if (i < 0) {
        break;
      }

      indices[i]++;
      for (let j = i + 1; j < k; j++) {
        indices[j] = indices[j - 1] + 1;
      }
    }
    return result;
  }

  function getCorrelationsWithBetsSince(siteKey, totalBets) {
    const kenoResults = state.kenoResults[siteKey] || [];
    if (kenoResults.length === 0) {
      return { correlations: {}, betsSinceDrop: {}, lastOccurrences: {}, totalBets: 0 };
    }

    // OPTIMIZED: Limit analysis scope to stay responsive
    const MAX_CORRELATION_GAMES = 500;
    const limitedResults = kenoResults.slice(0, MAX_CORRELATION_GAMES);
    const actualTotalBets = limitedResults.length;

    const correlations = { 2: {}, 3: {} }; // Removed heavy 4, 5, 6
    const lastOccurrences = { 2: {}, 3: {} };
    const betsSinceDrop = { 2: {}, 3: {} };
    const lastSeen = { 2: {}, 3: {} };

    for (let i = limitedResults.length - 1; i >= 0; i--) {
      const bet = limitedResults[i];
      const betIndex = actualTotalBets - 1 - i;
      if (!bet?.state?.drawnNumbers) continue;

      const drawnNumbers = bet.state.drawnNumbers
        .map(n => parseInt(n, 10))
        .filter(n => !isNaN(n))
        .sort((a, b) => a - b);

      if (drawnNumbers.length < 2) continue;

      // Only sizes 2 and 3 - 4+ is computationally explosive (20C4=4.8k, 20C5=15k, 20C6=38k)
      for (let size = 2; size <= 3; size++) {
        if (drawnNumbers.length < size) break;

        const combinations = getCombinations(drawnNumbers, size);

        for (const comboArray of combinations) {
          const comboKey = comboArray.join('-');

          correlations[size][comboKey] = (correlations[size][comboKey] || 0) + 1;

          if (lastSeen[size][comboKey] !== undefined) {
            const interval = betIndex - lastSeen[size][comboKey];
            if (!lastOccurrences[size][comboKey]) {
              lastOccurrences[size][comboKey] = [];
            }
            lastOccurrences[size][comboKey].push(interval);
          }
          lastSeen[size][comboKey] = betIndex;
        }
      }
    }

    for (const size in lastSeen) {
      for (const comboKey in lastSeen[size]) {
        betsSinceDrop[size][comboKey] = actualTotalBets - 1 - lastSeen[size][comboKey];
      }
    }

    state.kenoCorrelations = correlations;
    state.kenoLastOccurrences = lastOccurrences;
    state.kenoLastSeen = lastSeen;

    return { correlations, betsSinceDrop, lastOccurrences, totalBets: actualTotalBets };
  }

  let saveTimeout;
  // Keys owned by the overlay / cloud-sync, which write them to storage directly.
  // The background's in-memory copy of these can be stale (it only loads them at
  // startup), so it must NEVER persist them or it would clobber the user's
  // drag-drop strategy layout, overlay position, or cloud token.
  const OVERLAY_OWNED_KEYS = [
    'strategyOrder', 'sideDrawerStrategies', 'sideDrawerOpen', 'overlayPosition',
    'strategyInfoCollapsed', 'activeKenoStrategy', 'strategyToggles', 'layoutMode',
    'comboFavorites',
    'vantedge_github_token', 'vantedge_gist_id', 'vantedge_last_sync'
  ];
  function persistableState() {
    const payload = { ...state };
    OVERLAY_OWNED_KEYS.forEach(k => delete payload[k]);
    return payload;
  }

  // Last JSON written per key. The old save wrote the WHOLE state on every
  // bet, and Firefox fires storage.onChanged with old+new values for every key
  // set — changed or not — so each bet shipped all of it (1500-bet history,
  // correlations, legend stats…) into the page twice. Only write what changed.
  const lastSavedJSON = new Map();
  function toJSON(v) {
    try { return JSON.stringify(v); } catch (e) { return undefined; }
  }
  function rememberSaved(key, value) {
    const j = toJSON(value);
    if (j === undefined) lastSavedJSON.delete(key); else lastSavedJSON.set(key, j);
  }
  function changedState() {
    const payload = persistableState();
    const out = {};
    const jsons = {};
    Object.keys(payload).forEach(k => {
      const j = toJSON(payload[k]);
      if (j === undefined || lastSavedJSON.get(k) !== j) {
        out[k] = payload[k];
        jsons[k] = j;
      }
    });
    return { out, jsons };
  }
  async function writeChanged() {
    const { out, jsons } = changedState();
    if (!Object.keys(out).length) return;
    await browser.storage.local.set(out);
    Object.keys(jsons).forEach(k => {
      if (jsons[k] === undefined) lastSavedJSON.delete(k); else lastSavedJSON.set(k, jsons[k]);
    });
  }

  async function saveToStorage(immediate = false) {
    const payload = persistableState();
    // For critical operations like reset, save immediately without debounce
    if (immediate) {
      try {
        await browser.storage.local.set(payload);
        Object.keys(payload).forEach(k => rememberSaved(k, payload[k]));
        log('✅ Storage saved immediately');
      } catch (error) {
        if (error.message && error.message.includes('quota')) {
          console.warn('⚠️ Storage quota exceeded! Cleaning up old data...');
          cleanupStorageData();
          try {
            await browser.storage.local.set(persistableState());
            log('✅ Storage saved after cleanup');
          } catch (retryError) {
            console.error('❌ Still cannot save after cleanup:', retryError);
            throw retryError;
          }
        } else {
          console.error('Storage save error:', error);
          throw error;
        }
      }
      return;
    }

    // Normal debounced save for non-critical operations
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(async () => {
      try {
        await writeChanged();
      } catch (error) {
        if (error.message && error.message.includes('quota')) {
          console.warn('⚠️ Storage quota exceeded! Cleaning up old data...');
          cleanupStorageData();
          try {
            await browser.storage.local.set(persistableState());
            log('✅ Storage saved after cleanup');
          } catch (retryError) {
            console.error('❌ Still cannot save after cleanup:', retryError);
          }
        } else {
          console.error('Storage save error:', error);
        }
      }
    }, 500); // Debounced 500ms: coalesces rapid autobet writes so the (large)
             // full-state serialization + storage.onChanged payload to the page
             // fire ~2x/sec instead of ~10x/sec. Reset still saves immediately.
  }

  function cleanupStorageData() {
    log('🧹 Starting aggressive storage cleanup...');

    // EMERGENCY cleanup - keep minimal data to stay under quota
    // Reduce Keno game history to last 2000 games per site (normally keeps 5000)
    Object.keys(state.kenoResults || {}).forEach(key => {
      if (state.kenoResults[key] && state.kenoResults[key].length > 2000) {
        state.kenoResults[key] = state.kenoResults[key].slice(0, 2000);
        log(`📉 Emergency: Trimmed ${key} keno results to 2000 games`);
      }
    });

    // Clear very old Plinko data (keep only last 100 entries per site)
    Object.keys(state.seedResults || {}).forEach(key => {
      if (state.seedResults[key] && state.seedResults[key].length > 100) {
        state.seedResults[key] = state.seedResults[key].slice(0, 100);
        log(`📉 Emergency: Trimmed ${key} plinko results to 100 games`);
      }
    });

    // Clear old Mines data (keep only last 100 entries per site)
    Object.keys(state.minesResults || {}).forEach(key => {
      if (state.minesResults[key] && state.minesResults[key].length > 100) {
        state.minesResults[key] = state.minesResults[key].slice(0, 100);
        log(`📉 Emergency: Trimmed ${key} mines results to 100 games`);
      }
    });

    // Clear advanced mines stats if too large (keep last 50)
    if (state.minesAdvancedStats && state.minesAdvancedStats.gameHistory) {
      if (state.minesAdvancedStats.gameHistory.length > 50) {
        state.minesAdvancedStats.gameHistory = state.minesAdvancedStats.gameHistory.slice(0, 50);
        log('📉 Emergency: Trimmed mines advanced stats history to 50');
      }
    }

    // Clear correlation data to save space (can be regenerated)
    if (state.kenoCorrelations) {
      Object.keys(state.kenoCorrelations).forEach(size => {
        if (state.kenoCorrelations[size]) {
          // Keep only top 50 correlations per size
          const entries = Object.entries(state.kenoCorrelations[size]);
          if (entries.length > 50) {
            state.kenoCorrelations[size] = Object.fromEntries(
              entries.sort((a, b) => b[1] - a[1]).slice(0, 50)
            );
            log(`📉 Emergency: Trimmed correlation data (size ${size}) to top 50`);
          }
        }
      });
    }

    // Clear old correlation tracking data
    if (state.kenoLastOccurrences) {
      Object.keys(state.kenoLastOccurrences).forEach(size => {
        if (state.kenoLastOccurrences[size]) {
          const entries = Object.entries(state.kenoLastOccurrences[size]);
          if (entries.length > 50) {
            state.kenoLastOccurrences[size] = Object.fromEntries(entries.slice(0, 50));
            log(`📉 Emergency: Trimmed lastOccurrences (size ${size}) to 50`);
          }
        }
      });
    }

    if (state.kenoLastSeen) {
      Object.keys(state.kenoLastSeen).forEach(size => {
        if (state.kenoLastSeen[size]) {
          const entries = Object.entries(state.kenoLastSeen[size]);
          if (entries.length > 50) {
            state.kenoLastSeen[size] = Object.fromEntries(entries.slice(0, 50));
            log(`📉 Emergency: Trimmed lastSeen (size ${size}) to 50`);
          }
        }
      });
    }

    log('✅ Aggressive storage cleanup completed');
  }

  async function resetSiteStats(siteOrigin) {
    log(`🔄 [RESET] Resetting stats for origin: ${siteOrigin}`);

    const kenoKey = `${siteOrigin}-keno-session`;
    log(`🔑 [RESET] Using kenoKey: ${kenoKey}`);
    log(`📊 [RESET] Before reset - Total bets: ${state.kenoTotalBets?.[kenoKey] || 0}, Results: ${state.kenoResults?.[kenoKey]?.length || 0}`);

    // Set reset timestamp to block incoming bets for 2 seconds (prevents race condition)
    resetTimestamps[kenoKey] = Date.now();
    log(`⏰ [RESET] Set reset timestamp for ${kenoKey} - will ignore bets for 2 seconds`);

    const keysToRemove = [];

    // Initialize/clear Keno data completely
    if (!state.kenoResults) state.kenoResults = {};
    if (!state.kenoHotNumbers) state.kenoHotNumbers = {};
    if (!state.kenoTotalBets) state.kenoTotalBets = {};
    if (!state.kenoLifetimeBets) state.kenoLifetimeBets = {};
    if (!state.kenoCorrelations) state.kenoCorrelations = {};
    if (!state.kenoLastOccurrences) state.kenoLastOccurrences = {};
    if (!state.kenoLastSeen) state.kenoLastSeen = {};
    if (!state.kenoEnhancedState) state.kenoEnhancedState = {};
    if (!state.kenoStrategyPerformance) state.kenoStrategyPerformance = {};

    // Clear the site-specific data
    state.kenoResults[kenoKey] = [];
    state.kenoHotNumbers[kenoKey] = new Array(40).fill(0);
    state.kenoTotalBets[kenoKey] = 0;
    state.kenoLifetimeBets[kenoKey] = 0;
    delete state.kenoCorrelations[kenoKey];
    delete state.kenoLastOccurrences[kenoKey];
    delete state.kenoLastSeen[kenoKey];
    delete state.kenoEnhancedState[kenoKey];
    delete state.kenoStrategyPerformance[kenoKey];

    // Mines rounds are keyed by origin, so the same reset clears this site's
    // history — that's what the mines overlay reads. The cross-site mines
    // aggregates the popup shows are shared by every site and stay put.
    if (state.minesResults?.[siteOrigin]) state.minesResults[siteOrigin] = [];

    log(`📊 [RESET] After reset - Total bets: ${state.kenoTotalBets[kenoKey]}, Results: ${state.kenoResults[kenoKey].length}`);
    log(`✅ [RESET] Keno + mines data for ${siteOrigin} cleared in memory`);

    // Use saveToStorage with immediate=true, which has built-in quota cleanup
    try {
      log(`💾 [RESET] Saving to storage with quota cleanup...`);
      await saveToStorage(true);
      log('✅ [RESET] Reset data saved to storage successfully');
    } catch (error) {
      console.error('❌ [RESET] Failed to save reset data:', error);
      throw error;
    }

    // After storage is saved, notify all tabs on this origin to reset their overlay
    // For Winna: storage is at games.winna.com, but tabs are at winna.com
    const tabOrigin = siteOrigin.includes('games.winna.com') ? 'https://winna.com' : siteOrigin;

    browser.tabs.query({ url: `${tabOrigin}/*` }, (tabs) => {
      log(`📢 [RESET] Notifying ${tabs.length} tabs on ${tabOrigin} to reset overlay (data origin: ${siteOrigin})`);
      tabs.forEach(tab => {
        browser.tabs.sendMessage(tab.id, { type: 'RESET_OVERLAY_DATA' })
          .then(() => log(`✅ [RESET] Tab ${tab.id} notified`))
          .catch((err) => log(`⚠️ [RESET] Tab ${tab.id} notification failed:`, err.message));
      });
    });
  }

  async function resetAllStats() {
    log('Resetting all stats, preserving legend and user settings...');
    // Preserve legend stats + everything the overlay/cloud own (strategy layout,
    // overlay position, cloud token, …) across the wipe.
    const preserved = await browser.storage.local.get(['legendStats', ...OVERLAY_OWNED_KEYS]);

    const freshState = { seedResults: {}, allMultipliers: {}, betsSinceMultiplier: {}, lastOccurrenceMultiplier: {}, kenoResults: {}, kenoHotNumbers: {}, kenoCorrelations: {}, kenoLastOccurrences: {}, kenoLastSeen: {}, kenoTotalBets: {}, kenoEnhancedState: {}, minesResults: {}, minesHeatmaps: {}, currentMineCount: 3, minesAdvancedStats: { totalGames: 0, wins: 0, losses: 0, totalProfit: 0, totalWagered: 0, streaks: { current: { type: null, count: 0 }, longest: { win: 0, loss: 0 } }, patterns: { clusters: [], safeZones: [], hotSpots: [] }, gameHistory: [], gamesByMineCount: {}, currentMineCount: 3 }, lastPlayedGame: 'Plinko' };

    await browser.storage.local.clear();
    lastSavedJSON.clear();
    state = { ...freshState, legendStats: preserved.legendStats || {} };
    await browser.storage.local.set(state);
    Object.keys(state).forEach(k => rememberSaved(k, state[k]));

    // Restore the overlay/cloud-owned keys (the background never persists these
    // via saveToStorage, so write them back directly after the wipe).
    const toRestore = {};
    OVERLAY_OWNED_KEYS.forEach(k => { if (preserved[k] !== undefined) toRestore[k] = preserved[k]; });
    if (Object.keys(toRestore).length) await browser.storage.local.set(toRestore);
    log('All stats reset, user settings preserved.');
  }

  async function processLegendStats(betData, siteOrigin) {
    if (betData.payoutMultiplier > 30) {
      log(`Vantedge BG: High hit detected! ${betData.payoutMultiplier}x on ${siteOrigin}`);

      const siteKey = `${siteOrigin}-keno-session`;
      const newHit = {
        multiplier: parseFloat(betData.payoutMultiplier.toFixed(2)),
        strategy: betData.strategyUsed || 'manual',
        payout: betData.payout || 0,
        timestamp: new Date().toISOString(),
      };

      const result = await browser.storage.local.get('legendStats');
      const allLegendStats = result.legendStats || {};

      // Initialize site-specific stats if not exists
      if (!allLegendStats[siteKey]) {
        allLegendStats[siteKey] = {
          totalHits: 0,
          hitsByMultiplier: {},
          hitsByStrategy: {},
          recentHits: []
        };
      }

      const siteStats = allLegendStats[siteKey];

      // Update totalHits
      siteStats.totalHits++;

      // Update hitsByMultiplier - track both count and total payout
      // Migrate old format (number) to new format ({ count, totalPayout })
      const multiplierKey = Math.floor(newHit.multiplier).toString();
      if (!siteStats.hitsByMultiplier[multiplierKey]) {
        siteStats.hitsByMultiplier[multiplierKey] = { count: 0, totalPayout: 0 };
      } else if (typeof siteStats.hitsByMultiplier[multiplierKey] === 'number') {
        siteStats.hitsByMultiplier[multiplierKey] = {
          count: siteStats.hitsByMultiplier[multiplierKey],
          totalPayout: 0
        };
      }
      siteStats.hitsByMultiplier[multiplierKey].count = (siteStats.hitsByMultiplier[multiplierKey].count || 0) + 1;
      siteStats.hitsByMultiplier[multiplierKey].totalPayout = (siteStats.hitsByMultiplier[multiplierKey].totalPayout || 0) + (betData.payout || 0);

      // Update hitsByStrategy
      const strategy = newHit.strategy;
      siteStats.hitsByStrategy[strategy] = (siteStats.hitsByStrategy[strategy] || 0) + 1;

      // Add to recentHits (keep last 20)
      siteStats.recentHits.unshift(newHit);
      if (siteStats.recentHits.length > 20) {
        siteStats.recentHits = siteStats.recentHits.slice(0, 20);
      }

      allLegendStats[siteKey] = siteStats;

      log(`💎 Legend stats updated for ${siteOrigin}:`, siteStats);
      await browser.storage.local.set({ legendStats: allLegendStats });
    }
  }

  // Keyboard shortcut handler
  browser.commands.onCommand.addListener((command) => {
    if (command === 'toggle-overlay') {
      // Send message to the active tab to toggle the overlay
      browser.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          browser.tabs.sendMessage(tabs[0].id, { type: 'TOGGLE_OVERLAY' }, (response) => {
            if (browser.runtime.lastError) {
              log('Could not toggle overlay - not on a supported page or overlay not loaded');
            }
          });
        }
      });
    }
  });

  log('Vantedge: Service worker setup complete');
})();