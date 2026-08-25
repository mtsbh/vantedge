if (typeof browser === 'undefined') {
  var browser = chrome;
}

const originalConsoleWarn = console.warn;
console.warn = function (...args) {
  const message = args.join(' ');
  if (message.includes('Not on supported site') || message.includes('Clearing display')) {
    return;
  }
  originalConsoleWarn.apply(console, args);
}

// Get the correct storage origin (matches overlay.js logic)
function getStorageOrigin(origin) {
  // Winna's game iframe is at games.winna.com, data stored there
  if (origin.includes('winna.com') && !origin.includes('games.winna.com')) {
    return 'https://games.winna.com';
  }
  return origin;
}

document.addEventListener('DOMContentLoaded', async () => {
  console.log('Popup DOM loaded, initializing...');

  let lastDataLoadTime = 0;
  let initialLoadDone = false;
  let currentKenoData = { correlations: {} };
  let currentViewingMineCount = 3;
  let heatmapUpdateInProgress = false;
  let mineCountData = {};
  let selectedNumbers = new Set();
  let correlationCache = new Map();
  let lastCorrelationHash = '';
  const MAX_KENO_ANALYSIS = 5000;

  const elements = {
    statsContainer: document.getElementById('statsContainer'),
    resultsTable: document.querySelector('#resultsTable tbody'),
    multipliersTable: document.querySelector('#multipliersTable tbody'),
    returnChart: document.getElementById('returnChart'),
    kenoTotalBets: document.getElementById('kenoTotalBets'),
    kenoNumberGrid: document.getElementById('kenoNumberGrid'),
    combinationDisplay: document.getElementById('combinationDisplay'),
    comboTabs: document.querySelectorAll('.combo-tab'),
    minesTotalGames: document.getElementById('minesTotalGames'),
    minesWinRate: document.getElementById('minesWinRate'),
    minesProfit: document.getElementById('minesProfit'),
    minesROI: document.getElementById('minesROI'),
    currentStreak: document.getElementById('currentStreak'),
    longestWinStreak: document.getElementById('longestWinStreak'),
    longestLossStreak: document.getElementById('longestLossStreak'),
    minesHeatmapGrid: document.getElementById('minesHeatmapGrid'),
    patternOverlay: document.getElementById('patternOverlay'),
    clusterList: document.getElementById('clusterList'),
    safeZoneList: document.getElementById('safeZoneList'),
    hotSpotList: document.getElementById('hotSpotList'),
    gameHistoryList: document.getElementById('gameHistoryList'),
    currentMineCountDisplay: document.getElementById('currentMineCountDisplay'),
    currentMineCountGames: document.getElementById('currentMineCountGames'),
    lastPlayedMineCount: document.getElementById('lastPlayedMineCount'),
    mineCountWinRate: document.getElementById('mineCountWinRate'),
    // ADDED FOR LEGEND
    legendTotalHits: document.getElementById('legendTotalHits'),
    legendRecentHits: document.getElementById('legendRecentHits'),
    legendStrategyTable: document.querySelector('#legendStrategyTable tbody'),
    legendMultiplierTable: document.querySelector('#legendMultiplierTable tbody'),
    resetButton: document.getElementById('resetButton'),
    // ADDED FOR BACKUP/RESTORE
    exportLegendButton: document.getElementById('exportLegendButton'),
    importLegendButton: document.getElementById('importLegendButton'),
    createBackupButton: document.getElementById('createBackupButton'),
    viewBackupsButton: document.getElementById('viewBackupsButton'),
    fixBackupsButton: document.getElementById('fixBackupsButton'),
    backupListContainer: document.getElementById('backupListContainer'),
    backupList: document.getElementById('backupList'),
    closeBackupsButton: document.getElementById('closeBackupsButton'),
    storageTotalSites: document.getElementById('storageTotalSites'),
    storageTotalBackups: document.getElementById('storageTotalBackups'),
    storageLastBackup: document.getElementById('storageLastBackup'),
    // Cloud sync
    cloudStatusText: document.getElementById('cloudStatusText'),
    cloudLastSyncText: document.getElementById('cloudLastSyncText'),
    cloudTokenInput: document.getElementById('cloudTokenInput'),
    cloudSaveTokenButton: document.getElementById('cloudSaveTokenButton'),
    cloudPushButton: document.getElementById('cloudPushButton'),
    cloudPullButton: document.getElementById('cloudPullButton'),
    cloudVerifyButton: document.getElementById('cloudVerifyButton')
  };

  function initializePopup() {
    setupEventListeners();
    initializeKenoNumberSelector();
    loadCollapsedState();

    openTab(null, 'Keno');

    loadData();

    setInterval(() => {
      if (Date.now() - lastDataLoadTime > 9000) {
        loadData();
      }
    }, 10000);

    window.addEventListener('focus', () => {
      console.log('Popup focused, refreshing data.');
      loadData();
    });

    console.log('âœ… Extension popup initialized successfully');
  }


  function setupEventListeners() {
    document.querySelectorAll('.tablinks').forEach(tab => {
      tab.addEventListener('click', (event) => {
        openTab(event, event.currentTarget.dataset.tab);
      });
    });

    if (elements.resetButton) {
      elements.resetButton.addEventListener('click', async () => {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.url) {
          alert("Could not determine the current site. Please make sure you are on a supported page.");
          return;
        }

        const siteHostname = new URL(tab.url).hostname;
        const siteOrigin = new URL(tab.url).origin;

        // Fix for Winna: use games.winna.com as storage origin (same as overlay)
        const storageOrigin = getStorageOrigin(siteOrigin);

        const confirmed = confirm(
          `Are you sure you want to reset all game statistics for ${siteHostname}?\n\n` +
          `Your persistent Legend Stats will NOT be affected.\n\n` + // EDITED
          'This action cannot be undone!'
        );
        if (confirmed) {
          performSiteReset(storageOrigin);
        }
      });
    }

    document.querySelectorAll('.collapsible-section .toggle-btn').forEach(button => {
      button.addEventListener('click', (event) => {
        const section = event.target.closest('.collapsible-section');
        if (section) toggleSection(section);
      });
    });


    elements.comboTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        elements.comboTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const comboSize = parseInt(tab.dataset.combo);
        displayHotCombinations(currentKenoData.correlations, comboSize);
      });
    });


    document.querySelectorAll('.mine-count-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const mineCount = parseInt(btn.dataset.mines);
        switchMineCountView(mineCount);
      });
    });

    // ADDED: Backup/Restore event listeners
    if (elements.exportLegendButton) {
      elements.exportLegendButton.addEventListener('click', handleExportLegend);
    }

    if (elements.importLegendButton) {
      elements.importLegendButton.addEventListener('click', () => {
        browser.tabs.create({ url: browser.runtime.getURL('import.html') });
        window.close();
      });
    }

    if (elements.createBackupButton) {
      elements.createBackupButton.addEventListener('click', handleCreateBackup);
    }

    if (elements.viewBackupsButton) {
      elements.viewBackupsButton.addEventListener('click', handleViewBackups);
    }

    if (elements.fixBackupsButton) {
      elements.fixBackupsButton.addEventListener('click', handleFixBackups);
    }

    if (elements.closeBackupsButton) {
      elements.closeBackupsButton.addEventListener('click', () => {
        elements.backupListContainer.style.display = 'none';
      });
    }

    // ----- Cloud Sync wiring -----
    if (elements.cloudSaveTokenButton && elements.cloudTokenInput) {
      elements.cloudSaveTokenButton.addEventListener('click', async () => {
        const token = elements.cloudTokenInput.value.trim();
        elements.cloudSaveTokenButton.disabled = true;
        elements.cloudSaveTokenButton.textContent = '⏳';
        try {
          const r = await browser.runtime.sendMessage({ type: 'CLOUD_SET_TOKEN', token });
          if (!r.success) throw new Error(r.error || 'failed to save token');
          elements.cloudTokenInput.value = '';   // don't keep the token in the field
          if (r.configured) {
            // Confirm it actually works before declaring success.
            const v = await browser.runtime.sendMessage({ type: 'CLOUD_VERIFY' });
            if (v.success && v.ok) alert(`✅ Token saved. Signed in as @${v.login}.`);
            else alert('Token saved, but verification failed: ' + (v.error || 'rejected'));
          } else {
            alert('Token cleared. Cloud sync is now off.');
          }
        } catch (e) {
          alert('Could not save token: ' + e.message);
        } finally {
          elements.cloudSaveTokenButton.disabled = false;
          elements.cloudSaveTokenButton.textContent = 'Save';
          if (typeof refreshCloudStatus === 'function') refreshCloudStatus();
        }
      });
    }
    if (elements.cloudVerifyButton) {
      elements.cloudVerifyButton.addEventListener('click', async () => {
        elements.cloudVerifyButton.disabled = true;
        elements.cloudVerifyButton.textContent = '⏳ Checking...';
        try {
          const r = await browser.runtime.sendMessage({ type: 'CLOUD_VERIFY' });
          if (!r.success || !r.ok) throw new Error(r.error || 'token rejected');
          alert(`✅ Token works. Signed in as @${r.login}.`);
        } catch (e) {
          alert('Token check failed: ' + e.message);
        } finally {
          elements.cloudVerifyButton.disabled = false;
          elements.cloudVerifyButton.textContent = '🔎 Verify';
        }
      });
    }
    if (elements.cloudPushButton) {
      elements.cloudPushButton.addEventListener('click', async () => {
        elements.cloudPushButton.disabled = true;
        elements.cloudPushButton.textContent = '⏳ Pushing...';
        try {
          const r = await browser.runtime.sendMessage({ type: 'CLOUD_PUSH_NOW' });
          if (!r.success) throw new Error(r.error);
          await refreshCloudStatus();
        } catch (e) { alert('Push failed: ' + e.message); }
        finally {
          elements.cloudPushButton.disabled = false;
          elements.cloudPushButton.textContent = '⬆ Push now';
        }
      });
    }
    if (elements.cloudPullButton) {
      elements.cloudPullButton.addEventListener('click', async () => {
        if (!confirm('Pull from Drive merges cloud legend stats into your local data (same as the 📥 Import button). Continue?')) return;
        elements.cloudPullButton.disabled = true;
        elements.cloudPullButton.textContent = '⏳ Pulling...';
        try {
          const r = await browser.runtime.sendMessage({ type: 'CLOUD_PULL_NOW' });
          if (!r.success) throw new Error(r.error);
          await refreshCloudStatus();
          alert(r.status === 'empty' ? 'Cloud is empty.' : `Restored ${r.restored || 0} key(s).`);
        } catch (e) { alert('Pull failed: ' + e.message); }
        finally {
          elements.cloudPullButton.disabled = false;
          elements.cloudPullButton.textContent = '⬇ Pull now';
        }
      });
    }
    refreshCloudStatus();

    browser.runtime.onMessage.addListener((message) => {
      if (['KENO_DATA_UPDATE', 'FORCE_POPUP_REFRESH', 'GAME_DATA_UPDATE', 'STORAGE_CHANGE_DETECTED'].includes(message.type)) {
        loadData();
      }
    });
  }

  async function refreshCloudStatus() {
    if (!elements.cloudStatusText) return;
    try {
      const r = await browser.runtime.sendMessage({ type: 'CLOUD_STATUS' });
      if (!r.success) throw new Error(r.error || 'no response');
      if (!r.tokenConfigured) {
        elements.cloudStatusText.textContent = '⚠ No token — paste one above';
        elements.cloudStatusText.style.color = '#e67e22';
      } else {
        elements.cloudStatusText.textContent = '✅ Ready';
        elements.cloudStatusText.style.color = '#27ae60';
      }
      if (r.lastSync) {
        const age = Date.now() - r.lastSync.ts;
        const min = Math.floor(age / 60000);
        const ago = min < 1 ? 'just now' : (min < 60 ? `${min}m ago` : `${Math.floor(min / 60)}h ago`);
        const icon = r.lastSync.status === 'ok' ? '✓' : (r.lastSync.status === 'empty' ? '∅' : '✗');
        elements.cloudLastSyncText.textContent = `${icon} ${r.lastSync.direction} ${ago}`;
      } else {
        elements.cloudLastSyncText.textContent = 'never';
      }
    } catch (e) {
      elements.cloudStatusText.textContent = 'error: ' + e.message;
    }
  }

  function openTab(evt, tabName) {
    document.querySelectorAll('.tabcontent').forEach(tab => tab.style.display = 'none');
    document.querySelectorAll('.tablinks').forEach(tab => tab.classList.remove('active'));

    const content = document.getElementById(tabName);
    if (content) content.style.display = 'block';

    const button = document.querySelector(`.tablinks[data-tab="${tabName}"]`);
    if (button) button.classList.add('active');
  }

  function performSiteReset(origin) {
    if (elements.resetButton) {
      elements.resetButton.textContent = 'Resetting...';
      elements.resetButton.disabled = true;
    }

    // This now messages the background script, which handles the complex reset logic
    browser.runtime.sendMessage({ type: 'RESET_SITE_STATS', origin: origin }, response => {
      if (browser.runtime.lastError) {
        console.error("Reset message failed:", browser.runtime.lastError.message);
        alert("Error communicating with the extension's background process.");
        if (elements.resetButton) {
          elements.resetButton.textContent = 'Reset Stats';
          elements.resetButton.disabled = false;
        }
        return;
      }

      if (!response || !response.success) {
        alert(`Error: Could not reset data for ${origin}.`);
      } else {
        clearDisplayedData();
        // Wait briefly for storage sync to propagate before reloading
        setTimeout(() => {
          loadData();
        }, 100);
        alert(`All data for ${new URL(origin).hostname} has been reset.`);
      }

      if (elements.resetButton) {
        elements.resetButton.textContent = 'Reset Stats';
        elements.resetButton.disabled = false;
      }
    });
  };

  const toggleSection = section => {
    section.classList.toggle('collapsed');
    const button = section.querySelector('.toggle-btn');
    button.textContent = section.classList.contains('collapsed') ? 'Show' : 'Hide';
    saveCollapsedState();
  };

  const saveCollapsedState = () => {
    const collapsedSections = {};
    document.querySelectorAll('.collapsible-section').forEach(section => {
      const headerId = section.querySelector('.section-header h3').textContent.trim();
      collapsedSections[headerId] = section.classList.contains('collapsed');
    });
    browser.storage.local.set({ collapsedSections });
  };

  const loadCollapsedState = () => {
    browser.storage.local.get(['collapsedSections'], result => {
      const collapsedSections = result.collapsedSections || {};
      document.querySelectorAll('.collapsible-section').forEach(section => {
        const headerId = section.querySelector('.section-header h3').textContent.trim();
        const button = section.querySelector('.toggle-btn');
        if (collapsedSections[headerId]) {
          section.classList.add('collapsed');
        }
        if (button) {
          button.textContent = section.classList.contains('collapsed') ? 'Show' : 'Hide';
        }
      });
    });
  };

  // =================================================================
  // COLOR UTILITIES
  // =================================================================

  function getHeatColor(intensity) {
    const hue = (1 - intensity) * 120;
    const saturation = 70;
    const lightness = Math.max(30, 70 - intensity * 40);
    return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
  }

  function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }

  function createHash(data) {
    return JSON.stringify(data).split('').reduce((a, b) => {
      a = ((a << 5) - a) + b.charCodeAt(0);
      return a & a;
    }, 0).toString();
  }


  // ======================
  // OPTIMIZED PLINKO FUNCTIONS
  // ======================

  const updateElement = (selector, value, className) => {
    const element = document.getElementById(selector);
    if (element) {
      if (value !== undefined) element.textContent = value;
      if (className !== undefined) element.className = className;
    }
  };

  // Stake-weighted P/L, same rule as the overlay: Σ stake × (multiplier − 1),
  // free ($0) bets excluded, currencies kept apart (see money.js).
  const calculateStats = (bets) => {
    const rollup = VantedgeMoney.summarize(bets);
    return {
      totalBets: bets.length,
      averageReturn: bets.length
        ? ((bets.reduce((sum, bet) => sum + (Number(bet.payoutMultiplier) || 0), 0) / bets.length) * 100).toFixed(2)
        : '0.00',
      profitLoss: rollup.pl,
      wagered: rollup.wagered,
      currency: rollup.cur,
      others: rollup.others
    };
  };

  const updateStats = stats => {
    const isHot = parseFloat(stats.averageReturn) > 100;
    updateElement('totalBets', stats.totalBets);
    updateElement('averageReturn', `${stats.averageReturn}%`, isHot ? 'hot' : 'cold');
    const pl = Number(stats.profitLoss) || 0;
    const cur = stats.currency || 'usd';
    let profitText = VantedgeMoney.fmtMoney(pl, cur);
    // Bets in other currencies ride alongside rather than being summed at an
    // invented rate.
    (stats.others || []).forEach(o => { profitText += ` · ${VantedgeMoney.fmtMoney(o.pl, o.cur)}`; });
    const eps = VantedgeMoney.curEpsilon(cur, pl);
    updateElement('profitLoss', profitText, pl > eps ? 'hot' : (pl < -eps ? 'cold' : ''));
    updateElement('status', isHot ? 'HOT' : 'COLD', isHot ? 'hot' : 'cold');
  };

  const updateHistoricalResults = results => {
    if (!elements.resultsTable) return;

    elements.resultsTable.innerHTML = results.slice(0, 10).map(bet => `
      <tr>
        <td>${bet.payoutMultiplier}</td>
        <td>${bet.amount} ${bet.currency.toUpperCase()}</td>
        <td>${bet.payout} ${bet.currency.toUpperCase()}</td>
        <td>${bet.state.risk}</td>
      </tr>
    `).join('');
  };

  const updateAllMultipliers = (multipliers, betsSince, lastOccurrence) => {
    if (!elements.multipliersTable) return;

    elements.multipliersTable.innerHTML = Object.entries(multipliers)
      .sort(([a], [b]) => parseFloat(b) - parseFloat(a))
      .map(([multiplier, count]) => `
        <tr>
          <td>${multiplier}</td>
          <td>${count}</td>
          <td>${betsSince[multiplier] || 0}</td>
          <td>${lastOccurrence[multiplier] !== undefined ? lastOccurrence[multiplier] : 'N/A'}</td>
        </tr>
      `).join('');
  };

  function createSimpleChart(canvas, data, labels, title) {
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    const padding = { top: 40, right: 20, bottom: 40, left: 60 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;

    ctx.clearRect(0, 0, width, height);

    const colors = {
      text: '#e0e0e0',
      line: '#4CAF50',
      grid: 'rgba(255, 255, 255, 0.1)'
    };

    ctx.fillStyle = colors.text;
    ctx.font = 'bold 16px Inter';
    ctx.textAlign = 'center';
    ctx.fillText(title, width / 2, padding.top / 2);

    const maxValue = Math.max(...data, 0);
    const minValue = Math.min(...data, 0);
    const range = maxValue - minValue;

    ctx.beginPath();
    ctx.strokeStyle = colors.text;
    ctx.lineWidth = 2;
    ctx.moveTo(padding.left, padding.top);
    ctx.lineTo(padding.left, height - padding.bottom);
    ctx.lineTo(width - padding.right, height - padding.bottom);
    ctx.stroke();

    const yAxisSteps = 5;
    for (let i = 0; i <= yAxisSteps; i++) {
      const y = padding.top + (chartHeight / yAxisSteps) * i;
      const value = maxValue - (range / yAxisSteps) * i;

      ctx.beginPath();
      ctx.strokeStyle = colors.grid;
      ctx.moveTo(padding.left, y);
      ctx.lineTo(width - padding.right, y);
      ctx.stroke();

      ctx.fillStyle = colors.text;
      ctx.fillText(value.toFixed(2), padding.left - 10, y);
    }

    ctx.beginPath();
    ctx.strokeStyle = colors.line;
    ctx.lineWidth = 2;

    const dataStep = Math.max(1, Math.floor(data.length / (chartWidth / 5)));
    for (let i = 0; i < data.length; i += dataStep) {
      const x = padding.left + (i / (data.length - 1)) * chartWidth;
      const y = height - padding.bottom - ((data[i] - minValue) / range) * chartHeight;

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();

    ctx.fillStyle = colors.text;
    ctx.font = '12px Inter';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    const xLabelStep = Math.max(1, Math.floor(labels.length / 5));
    for (let i = 0; i < labels.length; i += xLabelStep) {
      const x = padding.left + (i / (labels.length - 1)) * chartWidth;
      ctx.fillText(labels[i], x, height - padding.bottom + 10);
    }
  }

  const updateReturnChart = seedResults => {
    const returns = seedResults.reduce((acc, bet) => [...acc, (acc[acc.length - 1] || 0) + bet.payoutMultiplier - 1], []);
    const labels = returns.map((_, index) => (index + 1).toString());
    createSimpleChart(elements.returnChart, returns, labels, 'Cumulative Return');
  };

  // ======================
  // KENO NUMBER SELECTOR FUNCTIONS
  // ======================

  function initializeKenoNumberSelector() {
    const selectorGrid = document.getElementById('numberSelector');
    if (!selectorGrid) {
      return;
    }

    selectorGrid.innerHTML = '';

    for (let i = 1; i <= 40; i++) {
      const btn = document.createElement('button');
      btn.className = 'number-btn';
      btn.dataset.number = i;
      btn.textContent = i;
      btn.addEventListener('click', () => toggleNumberSelection(i, btn));
      selectorGrid.appendChild(btn);
    }

    setupNumberSelectorControls();
  }

  function toggleNumberSelection(number, btn) {
    if (selectedNumbers.has(number)) {
      selectedNumbers.delete(number);
      btn.classList.remove('selected');
    } else {
      selectedNumbers.add(number);
      btn.classList.add('selected');
    }
    updateSelectionDisplay();
  }

  function clearNumberSelection() {
    selectedNumbers.clear();
    document.querySelectorAll('.number-btn').forEach(btn => {
      btn.classList.remove('selected', 'highlighted');
    });
    updateSelectionDisplay();
  }

  function updateSelectionDisplay() {
    const countElement = document.getElementById('selectedCount');
    if (countElement) {
      countElement.textContent = `${selectedNumbers.size} numbers selected`;
    }
  }

  function setupNumberSelectorControls() {
    const clearBtn = document.getElementById('clearSelection');
    if (clearBtn) {
      clearBtn.addEventListener('click', clearNumberSelection);
    }

    const analyzeBtn = document.getElementById('analyzeSelection');
    if (analyzeBtn) {
      analyzeBtn.addEventListener('click', analyzeCurrentSelection);
    }

    const hotBtn = document.getElementById('selectHot');
    if (hotBtn) {
      hotBtn.addEventListener('click', selectHotNumbers);
    }

    const coldBtn = document.getElementById('selectCold');
    if (coldBtn) {
      coldBtn.addEventListener('click', selectColdNumbers);
    }
  }

  function analyzeCurrentSelection() {
    if (selectedNumbers.size === 0) {
      const analysisDiv = document.getElementById('selectionAnalysis');
      if (analysisDiv) {
        analysisDiv.style.display = 'none';
      }
      return;
    }

    const analysisDiv = document.getElementById('selectionAnalysis');
    if (analysisDiv) {
      analysisDiv.style.display = 'block';
      analysisDiv.classList.add('show');
    }

    const selectedNumbersSpan = document.getElementById('selectedNumbers');
    if (selectedNumbersSpan) {
      selectedNumbersSpan.textContent = Array.from(selectedNumbers).sort((a, b) => a - b).join(', ');
    }

    if (currentKenoData.hotNumbers) {
      let totalOccurrences = 0;
      Array.from(selectedNumbers).forEach(num => {
        totalOccurrences += currentKenoData.hotNumbers[num - 1] || 0;
      });

      const avgOccurrences = (totalOccurrences / selectedNumbers.size).toFixed(1);

      const totalOccurrencesSpan = document.getElementById('totalOccurrences');
      const avgOccurrencesSpan = document.getElementById('averageOccurrences');

      if (totalOccurrencesSpan) totalOccurrencesSpan.textContent = totalOccurrences;
      if (avgOccurrencesSpan) avgOccurrencesSpan.textContent = avgOccurrences;
    }
  }

  function selectHotNumbers() {
    clearNumberSelection();
    const hotNumbers = getCurrentHotNumbers(10);
    hotNumbers.forEach(num => {
      const btn = document.querySelector(`.number-btn[data-number="${num}"]`);
      if (btn) toggleNumberSelection(num, btn);
    });
  }

  function selectColdNumbers() {
    clearNumberSelection();
    const coldNumbers = getCurrentColdNumbers(10);
    coldNumbers.forEach(num => {
      const btn = document.querySelector(`.number-btn[data-number="${num}"]`);
      if (btn) toggleNumberSelection(num, btn);
    });
  }

  function getCurrentHotNumbers(count) {
    if (!currentKenoData.hotNumbers) return [];
    return currentKenoData.hotNumbers
      .map((occurrences, index) => ({ number: index + 1, occurrences }))
      .sort((a, b) => b.occurrences - a.occurrences)
      .slice(0, count)
      .map(item => item.number);
  }

  function getCurrentColdNumbers(count) {
    if (!currentKenoData.hotNumbers) return [];
    return currentKenoData.hotNumbers
      .map((occurrences, index) => ({ number: index + 1, occurrences }))
      .sort((a, b) => a.occurrences - b.occurrences)
      .slice(0, count)
      .map(item => item.number);
  }

  // ======================
  // OPTIMIZED KENO FUNCTIONS
  // ======================

  const calculateHeatScore = (count, betsSince, avgInterval, totalBets) => {
    if (count <= 0 || totalBets <= 0 || avgInterval <= 0) return 0;
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
  };


  const getTrendIndicator = (count, betsSince, avgInterval, totalBets) => {
    const expectedOccurrences = betsSince / avgInterval;
    const recentWindow = Math.max(Math.floor(totalBets * 0.2), 1);
    const recentFrequency = count / recentWindow;
    const overallFrequency = count / totalBets;
    const frequencyRatio = recentFrequency / overallFrequency;

    if (expectedOccurrences > 1.2 && frequencyRatio < 0.8) return '<span style="color: #FF4136;">▼▼</span>';
    if (expectedOccurrences > 1.1 && frequencyRatio < 0.9) return '<span style="color: #FF851B;">▼</span>';
    if (expectedOccurrences < 0.8 && frequencyRatio > 1.2) return '<span style="color: #2ECC40;">▲▲</span>';
    if (expectedOccurrences < 0.9 && frequencyRatio > 1.1) return '<span style="color: #01FF70;">▲</span>';
    if (Math.abs(1 - frequencyRatio) <= 0.1) return '<span style="color: #AAAAAA;">■</span>';
    return expectedOccurrences < 1 ? '<span style="color: #7FDBFF;">▲</span>' : '<span style="color: #FFDC00;">▼</span>';
  };

  const calculateKenoStats = (kenoResults, origin) => {

    const limitedResults = kenoResults.slice(0, MAX_KENO_ANALYSIS);

    const stats = {
      totalBets: kenoResults.length,
      hotNumbers: limitedResults.reduce((acc, bet) => {
        if (bet?.state?.drawnNumbers) {
          bet.state.drawnNumbers.forEach(num => {
            const parsedNum = parseInt(num);
            if (!isNaN(parsedNum) && parsedNum >= 1 && parsedNum <= 40) {
              acc[parsedNum - 1]++;
            }
          });
        }
        return acc;
      }, new Array(40).fill(0))
    };

    const resultsHash = createHash(limitedResults);
    if (resultsHash === lastCorrelationHash && correlationCache.has(resultsHash)) {
      const cachedCorrelations = correlationCache.get(resultsHash);
      updateKenoStats({ ...stats, correlations: cachedCorrelations });
      return stats;
    }

    browser.runtime.sendMessage({ type: 'ANALYZE_CORRELATIONS', kenoResults: limitedResults, origin: origin }, (response) => {
      if (browser.runtime.lastError) {
        console.error("Correlation error:", browser.runtime.lastError.message);
        updateKenoStats(stats);
        return;
      }

      if (response && response.type === 'CORRELATIONS_RESULT') {
        correlationCache.set(resultsHash, response.result);
        lastCorrelationHash = resultsHash;

        if (correlationCache.size > 5) {
          const firstKey = correlationCache.keys().next().value;
          correlationCache.delete(firstKey);
        }

        currentKenoData.correlations = response.result;
        updateKenoStats({ ...stats, correlations: response.result });
      } else {
        updateKenoStats(stats);
      }
    });

    return stats;
  };

  function displayHotCombinations(correlationsData, size) {
    if (!correlationsData || typeof correlationsData !== 'object' || !elements.combinationDisplay) {
      if (elements.combinationDisplay) {
        elements.combinationDisplay.innerHTML = '<p>No data available.</p>';
      }
      return;
    }

    const { correlations, betsSinceDrop, lastOccurrences } = correlationsData;
    if (!correlations || !betsSinceDrop || !lastOccurrences) {
      elements.combinationDisplay.innerHTML = '<p>No data available.</p>';
      return;
    }

    const totalBets = parseInt(elements.kenoTotalBets?.textContent || 0);
    const sizeCorrelations = correlations[size] || {};
    const sizeBetsSince = betsSinceDrop[size] || {};
    const sizeLastOccurrences = lastOccurrences[size] || {};

    const maxCombinationsToProcess = 100;
    const combinationEntries = Object.entries(sizeCorrelations).slice(0, maxCombinationsToProcess);

    const combinationsData = combinationEntries.map(([combo, count]) => {
      const betsSince = sizeBetsSince[combo] || totalBets;
      const lastOccurrence = sizeLastOccurrences[combo] || [];
      const avgInterval = lastOccurrence.length > 0
        ? lastOccurrence.reduce((sum, val) => sum + val, 0) / lastOccurrence.length
        : totalBets / count;
      const heatScore = calculateHeatScore(count, betsSince, avgInterval, totalBets);
      return { combo, count, betsSince, avgInterval, heatScore };
    });

    const validCombinations = combinationsData.filter(item =>
      Number.isFinite(item.heatScore) && item.heatScore > 0
    );

    if (validCombinations.length === 0) {
      elements.combinationDisplay.innerHTML = '<p>No valid combinations found.</p>';
      return;
    }

    const sortedCombinations = validCombinations.sort((a, b) => b.heatScore - a.heatScore);
    const maxHeatScore = Math.max(...sortedCombinations.map(item => item.heatScore));

    const highOccurrenceCombos = sortedCombinations.filter(item => item.count >= 3).slice(0, 10);
    const lowOccurrenceCombos = sortedCombinations.filter(item => item.count < 3).slice(0, 5);

    elements.combinationDisplay.innerHTML = `
      <h4>High Occurrence Combinations (3 or more)</h4>
      ${generateCombinationTable(highOccurrenceCombos, maxHeatScore, totalBets)}
      <h4>Low Occurrence Combinations (less than 3)</h4>
      ${generateCombinationTable(lowOccurrenceCombos, maxHeatScore, totalBets)}
    `;

    requestAnimationFrame(() => {
      document.querySelectorAll('.combination-table tr').forEach(row => {
        const numbers = row.getAttribute('data-numbers')?.split(',').map(Number) || [];

        row.addEventListener('mouseenter', () => {
          document.querySelectorAll('.number-cell').forEach((cell, index) => {
            if (numbers.includes(index + 1)) {
              cell.classList.add('highlighted');
            }
          });
        });

        row.addEventListener('mouseleave', () => {
          document.querySelectorAll('.number-cell').forEach(cell => {
            cell.classList.remove('highlighted');
          });
        });
      });
    });
  }

  function generateCombinationTable(combinations, maxHeatScore, totalBets) {
    const fragment = document.createDocumentFragment();
    const table = document.createElement('table');
    table.className = 'combination-table';

    table.innerHTML = `
      <thead>
        <tr>
          <th>Combo</th>
          <th>Count</th>
          <th>Since</th>
          <th>Avg</th>
          <th>Heat</th>
        </tr>
      </thead>
    `;

    const tbody = document.createElement('tbody');

    combinations.forEach(({ combo, count, betsSince, avgInterval, heatScore }) => {
      const normalizedIntensity = heatScore / maxHeatScore;
      const heatColor = getHeatColor(normalizedIntensity);
      const numbers = combo.split('-').map(Number);
      const trend = getTrendIndicator(count, betsSince, avgInterval, totalBets);

      const row = document.createElement('tr');
      row.setAttribute('data-numbers', numbers.join(','));
      row.innerHTML = `
        <td>${combo}</td>
        <td>${count}</td>
        <td>${betsSince}</td>
        <td>${avgInterval.toFixed(1)}</td>
        <td style="background-color: ${heatColor.replace(')', ', 0.1)')}; color: ${heatColor};">
          ${heatScore.toFixed(2)} ${trend} ${count < 3 ? '<span title="Limited data"> ⚠️</span>' : ''}
        </td>
      `;
      tbody.appendChild(row);
    });

    table.appendChild(tbody);
    return table.outerHTML;
  }

  const updateKenoStats = kenoData => {
    currentKenoData = kenoData;

    if (elements.kenoTotalBets) {
      elements.kenoTotalBets.textContent = kenoData.totalBets;
    }

    requestAnimationFrame(() => {
      updateKenoNumberGrid(kenoData.hotNumbers);

      const activeTab = document.querySelector('.combo-tab.active');
      if (activeTab && kenoData.correlations) {
        displayHotCombinations(kenoData.correlations, parseInt(activeTab.dataset.combo));
      }
    });
  };

  const updateKenoNumberGrid = hotNumbers => {
    const maxOccurrence = Math.max(...hotNumbers, 1);
    elements.kenoNumberGrid.innerHTML = hotNumbers.map((occurrences, index) => {
      const intensity = occurrences / maxOccurrence;
      const hue = intensity * 120;
      const lightness = 70 - intensity * 40;
      return `
        <div class="number-cell" style="background-color: hsl(${hue}, 70%, ${lightness}%); color: ${lightness > 50 ? '#000' : '#fff'}; text-shadow: 0 0 1px ${lightness > 50 ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)'};">
          <span class="number">${index + 1}</span>
          <span class="occurrences">${occurrences}</span>
        </div>
      `;
    }).join('');
  };

  // ADDED: New function for Legend stats
  function updateLegendStats(legendData) {
    if (!legendData || Object.keys(legendData).length === 0) {
      elements.legendTotalHits.textContent = '0';
      elements.legendRecentHits.innerHTML = '<p>No high-multiplier hits recorded yet.</p>';
      elements.legendStrategyTable.innerHTML = '';
      elements.legendMultiplierTable.innerHTML = '';
      return;
    }

    elements.legendTotalHits.textContent = legendData.totalHits || 0;

    // Populate Recent Hits
    if (legendData.recentHits && legendData.recentHits.length > 0) {
      elements.legendRecentHits.innerHTML = legendData.recentHits.map(hit => {
        // Profit on the hit — stake × (multiplier − 1), not the recorded payout,
        // which is a gross return on some sites and a profit on others. Hits
        // stored before the currency was recorded fall back to USD.
        const profit = VantedgeMoney.betProfit({
          amount: hit.amount, payoutMultiplier: hit.multiplier
        });
        const profitDisplay = profit ? ` (${VantedgeMoney.fmtMoney(profit, hit.currency)})` : '';
        return `
            <div class="pattern-item">
                <span><strong>${hit.multiplier}x</strong> via <em>${hit.strategy}</em>${profitDisplay}</span>
                <span style="font-size: 10px; color: var(--text-secondary);">${getTimeAgo(new Date(hit.timestamp))}</span>
            </div>
        `;
      }).join('');
    } else {
      elements.legendRecentHits.innerHTML = '<p>No recent high hits.</p>';
    }

    // Populate Hits by Strategy
    if (legendData.hitsByStrategy) {
      elements.legendStrategyTable.innerHTML = Object.entries(legendData.hitsByStrategy)
        .sort(([, a], [, b]) => b - a)
        .map(([strategy, count]) => `<tr><td>${strategy}</td><td>${count}</td></tr>`)
        .join('');
    }

    // Populate Hits by Multiplier
    if (legendData.hitsByMultiplier) {
      // Migrate old format (number) to new format ({ count, totalPayout })
      let needsMigration = false;
      const migrated = {};

      Object.entries(legendData.hitsByMultiplier).forEach(([multiplier, data]) => {
        if (typeof data === 'number') {
          // Old format - migrate to new format (old hits won't have payout data)
          migrated[multiplier] = { count: data, totalPayout: 0 };
          needsMigration = true;
        } else {
          migrated[multiplier] = data;
        }
      });

      // If we migrated data, save it back to storage
      if (needsMigration) {
        legendData.hitsByMultiplier = migrated;
        const currentSite = window.location.origin;
        browser.storage.local.get('legendStats', (result) => {
          const allLegendStats = result.legendStats || {};
          // Find current site key
          Object.keys(allLegendStats).forEach(siteKey => {
            if (siteKey.includes(currentSite) || currentSite.includes('moz-extension')) {
              allLegendStats[siteKey].hitsByMultiplier = migrated;
            }
          });
          browser.storage.local.set({ legendStats: allLegendStats });
        });
      }

      elements.legendMultiplierTable.innerHTML = Object.entries(migrated)
        .filter(([multiplier]) => !isNaN(parseFloat(multiplier)))  // skip stray non-numeric keys
        .sort(([a], [b]) => parseFloat(b) - parseFloat(a))
        .map(([multiplier, data]) => {
          const count = data.count || 0;
          const totalPayout = VantedgeMoney.fmtMoney(data.totalPayout || 0, legendData.currency, { signed: false });
          return `<tr><td>${multiplier}x</td><td>${count}</td><td>${totalPayout}</td></tr>`;
        })
        .join('');
    }
  }

  // ======================
  // MINES FUNCTIONS (OPTIMIZED)
  // ======================

  function switchMineCountView(mineCount) {
    if (heatmapUpdateInProgress || mineCount === currentViewingMineCount) {
      return;
    }

    console.log(`ðŸŽ¯ Switching to ${mineCount}-mine view`);

    currentViewingMineCount = mineCount;
    heatmapUpdateInProgress = true;

    document.querySelectorAll('.mine-count-btn').forEach(btn => {
      btn.classList.remove('active');
      if (parseInt(btn.dataset.mines) === mineCount) {
        btn.classList.add('active');
      }
    });

    if (elements.minesHeatmapGrid) {
      elements.minesHeatmapGrid.classList.add('updating-heatmap');
    }

    browser.runtime.sendMessage(
      { type: 'GET_HEATMAP_FOR_MINE_COUNT', mineCount: mineCount },
      (response) => {
        heatmapUpdateInProgress = false;
        if (elements.minesHeatmapGrid) {
          elements.minesHeatmapGrid.classList.remove('updating-heatmap');
        }
        if (response && response.heatmap) {
          updateMinesHeatmap(response.heatmap);
          updateCurrentMineCountDisplay(mineCount, response.totalGames);
          browser.runtime.sendMessage(
            { type: 'GET_PREDICTIONS', mineCount: mineCount },
            (predResponse) => {
              if (predResponse && predResponse.safePositions) {
                updatePredictionList(predResponse.safePositions, response.totalGames);
              }
            }
          );
        }
      }
    );
  }

  function updateCurrentMineCountDisplay(mineCount, totalGames) {
    if (elements.currentMineCountDisplay) {
      elements.currentMineCountDisplay.textContent = `${mineCount} Mine${mineCount !== 1 ? 's' : ''}`;
    }

    if (elements.currentMineCountGames) {
      elements.currentMineCountGames.textContent = totalGames || 0;
    }

    const currentGames = mineCountData[mineCount] || [];

    if (elements.lastPlayedMineCount) {
      if (currentGames.length > 0) {
        elements.lastPlayedMineCount.textContent = getTimeAgo(new Date(currentGames[0].timestamp));
      } else {
        elements.lastPlayedMineCount.textContent = 'Never';
      }
    }

    if (elements.mineCountWinRate) {
      if (currentGames.length > 0) {
        const wins = currentGames.filter(game => game.isWin).length;
        const winRate = ((wins / currentGames.length) * 100).toFixed(1);
        elements.mineCountWinRate.textContent = winRate + '%';
        elements.mineCountWinRate.className = `info-value ${winRate >= 50 ? 'win' : 'loss'}`;
      } else {
        elements.mineCountWinRate.textContent = '-';
      }
    }
  }

  function updateMineCountSelector(gamesByMineCount) {
    mineCountData = gamesByMineCount || {};

    document.querySelectorAll('.mine-count-btn').forEach(btn => {
      const mineCount = parseInt(btn.dataset.mines);
      const games = gamesByMineCount[mineCount] || [];

      btn.classList.remove('has-data', 'no-data');

      if (games.length > 0) {
        btn.classList.add('has-data');
        btn.title = `${games.length} games played with ${mineCount} mines`;
      } else {
        btn.classList.add('no-data');
        btn.title = `No games played with ${mineCount} mines yet`;
      }
    });
  }

  const updateEnhancedMinesStats = (advancedStats) => {
    if (!advancedStats) {
      advancedStats = getDefaultAdvancedStats();
    }
    updateBasicStats(advancedStats);
    updateStreakInfo(advancedStats.streaks);
    updateMineCountSelector(advancedStats.gamesByMineCount || {});
    updatePatternAnalysis(advancedStats.patterns);
    updateGameHistory(advancedStats.gameHistory);

    switchMineCountView(advancedStats.currentMineCount || 3);
  };

  const updateBasicStats = (stats) => {
    if (elements.minesTotalGames) elements.minesTotalGames.textContent = stats.totalGames || 0;

    const winRate = stats.totalGames > 0 ? ((stats.wins / stats.totalGames) * 100).toFixed(1) : 0;
    if (elements.minesWinRate) {
      elements.minesWinRate.textContent = `${winRate}%`;
      elements.minesWinRate.className = `stat-value ${parseFloat(winRate) >= 50 ? 'win' : 'loss'}`;
    }

    const profit = Number(stats.totalProfit) || 0;
    const cur = stats.currency || 'btc'; // stats saved before the field existed
    if (elements.minesProfit) {
      elements.minesProfit.textContent = VantedgeMoney.fmtMoney(profit, cur);
      elements.minesProfit.className = `stat-value ${profit >= 0 ? 'win' : 'loss'}`;
    }

    const roi = stats.totalWagered > 0 ? ((stats.totalProfit / stats.totalWagered) * 100).toFixed(1) : 0;
    if (elements.minesROI) {
      elements.minesROI.textContent = `${roi}%`;
      elements.minesROI.className = `stat-value ${parseFloat(roi) >= 0 ? 'win' : 'loss'}`;
    }
  };

  const updateStreakInfo = (streaks) => {
    if (!elements.currentStreak || !streaks) return;

    if (!streaks.current.type) {
      elements.currentStreak.textContent = 'No games played';
    } else {
      elements.currentStreak.textContent = `${streaks.current.count} ${streaks.current.type}${streaks.current.count > 1 ? 's' : ''}`;
      elements.currentStreak.className = `streak-indicator ${streaks.current.type}`;
    }

    if (elements.longestWinStreak) elements.longestWinStreak.textContent = streaks.longest.win || 0;
    if (elements.longestLossStreak) elements.longestLossStreak.textContent = streaks.longest.loss || 0;
  };

  const updateMinesHeatmap = heatmap => {
    if (!elements.minesHeatmapGrid) return;
    heatmap = heatmap && heatmap.length === 25 ? heatmap : new Array(25).fill(0);

    const maxOccurrences = Math.max(...heatmap, 1);
    const fragment = document.createDocumentFragment();

    heatmap.forEach((occurrences, index) => {
      const cell = document.createElement('div');
      cell.className = 'mine-cell';
      const intensity = occurrences / maxOccurrences;
      const color = getHeatColor(1 - intensity);

      cell.style.backgroundColor = occurrences > 0 ? color : '#333';
      cell.style.color = intensity > 0.5 ? '#fff' : '#000';
      cell.innerHTML = `<span class="number">${index + 1}</span><span class="occurrences">${occurrences}</span>`;
      fragment.appendChild(cell);
    });

    elements.minesHeatmapGrid.innerHTML = '';
    elements.minesHeatmapGrid.appendChild(fragment);
  };

  const updatePatternList = (element, items, type) => {
    if (!element) return;
    if (!items || items.length === 0) {
      element.innerHTML = `<div class="pattern-item">No ${type} detected</div>`;
      return;
    }
    element.innerHTML = items.slice(0, 5).map(item => `
          <div class="pattern-item">
              <span>${type === 'Clusters' ? item.positions.map(p => p + 1).join(', ') : `Pos ${item.position + 1}`}</span>
              <span class="${type === 'Safe Zones' ? 'win' : 'loss'}">Freq: ${item.frequency}</span>
          </div>
      `).join('');
  }

  const updatePatternAnalysis = (patterns) => {
    if (!patterns) return;
    updatePatternList(elements.clusterList, patterns.clusters, 'Clusters');
    updatePatternList(elements.safeZoneList, patterns.safeZones, 'Safe Zones');
    updatePatternList(elements.hotSpotList, patterns.hotSpots, 'Hot Spots');
  };

  const updateGameHistory = (gameHistory) => {
    if (!elements.gameHistoryList) return;
    if (!gameHistory || gameHistory.length === 0) {
      elements.gameHistoryList.innerHTML = '<div class="pattern-item">No games played yet</div>';
      return;
    }
    elements.gameHistoryList.innerHTML = gameHistory.slice(0, 15).map(game => `
      <div class="pattern-item">
        <div>
          <strong class="${game.isWin ? 'win' : 'loss'}">${game.isWin ? 'WIN' : 'LOSS'}</strong>
          <div style="font-size: 10px; color: var(--text-secondary);">${getTimeAgo(new Date(game.timestamp))} â€¢ ${game.mineCount} mines</div>
        </div>
        <div class="${game.isWin ? 'win' : 'loss'}">${VantedgeMoney.fmtMoney(game.profit, game.currency || 'btc')}</div>
      </div>
    `).join('');
  };

  const getTimeAgo = (date) => {
    const diffMs = Date.now() - date.getTime();
    if (isNaN(diffMs)) return 'a while ago';
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    return `${Math.floor(diffHours / 24)}d ago`;
  };

  const updatePredictionList = (safePositions, totalGames) => {
    const list = document.getElementById('predictionList');
    if (!list) return;

    if (!safePositions || safePositions.length === 0) {
      list.innerHTML = `<div class="safe-square">No Data</div>`;
      return;
    }
    list.innerHTML = safePositions.map(pos => {
      const prob = pos.safeProbability;
      const colorClass = prob > 90 ? 'high' : (prob > 70 ? '' : 'low');
      return `
        <div class="safe-square ${colorClass}" title="Safe: ${prob.toFixed(1)}% (based on ${totalGames} games)">
          <span>${pos.position + 1}</span>
          <span style="font-size: 10px;">${prob.toFixed(0)}%</span>
        </div>
      `;
    }).join('');
  };

  // ======================
  // SHARED FUNCTIONS
  // ======================

  const clearDisplayedData = () => {
    updateStats({ totalBets: 0, averageReturn: '0.00', profitLoss: 0, wagered: 0, currency: 'usd', others: [] });
    if (elements.resultsTable) elements.resultsTable.innerHTML = '';
    if (elements.multipliersTable) elements.multipliersTable.innerHTML = '';

    updateKenoStats({ totalBets: 0, hotNumbers: new Array(40).fill(0) });
    if (elements.combinationDisplay) elements.combinationDisplay.innerHTML = '';

    updateEnhancedMinesStats(null);
    console.log('âœ… All displayed data cleared');
  };

  const getDefaultAdvancedStats = () => ({
    totalGames: 0, wins: 0, losses: 0, totalProfit: 0, totalWagered: 0,
    streaks: { current: { type: null, count: 0 }, longest: { win: 0, loss: 0 } },
    patterns: { clusters: [], safeZones: [], hotSpots: [] },
    gameHistory: [], gamesByMineCount: {}, currentMineCount: 3
  });

  // ======================
  // DATA LOADING
  // ======================

  const loadData = debounce(async () => {
    lastDataLoadTime = Date.now();

    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      const isSupported = tab && (tab.url.includes('stake.') || tab.url.includes('rainbet.'));
      if (!isSupported) {
        clearDisplayedData();
        return;
      }

      const currentOrigin = new URL(tab.url).origin;
      const result = await browser.storage.local.get(null);

      // FIREFOX FIX: Detect game type from URL, not just storage
      const isKenoPage = tab.url.toLowerCase().includes('/keno');
      const isMinesPage = tab.url.toLowerCase().includes('/mines');
      const activeGame = isKenoPage ? 'Keno' : (isMinesPage ? 'Mines' : 'Keno'); // Default to Keno

      if (!initialLoadDone) {
        updateActiveTab(activeGame);
        initialLoadDone = true;
      }

      // Plinko code removed - no longer supported

      const storageOrigin = getStorageOrigin(currentOrigin);
      const kenoKey = `${storageOrigin}-keno-session`;
      if (result.kenoResults && result.kenoResults[kenoKey]?.length > 0) {
        calculateKenoStats(result.kenoResults[kenoKey], storageOrigin);
      } else {
        updateKenoStats({ totalBets: 0, hotNumbers: new Array(40).fill(0) });
      }

      updateEnhancedMinesStats(result.minesAdvancedStats);

      const legendKey = `${storageOrigin}-keno-session`;
      updateLegendStats(result.legendStats ? result.legendStats[legendKey] : null);

      updateStorageStats();

    } catch (error) {
      console.error('ðŸš¨ Data loading failed:', error);
      clearDisplayedData();
    }
  }, 500);

  const updateActiveTab = activeGame => {
    const tabButton = document.querySelector(`.tablinks[data-tab="${activeGame}"]`);
    if (tabButton) {
      openTab(null, activeGame);
    }
  };

  // ADDED: Backup/Restore handler functions
  async function handleExportLegend() {
    try {
      elements.exportLegendButton.textContent = 'Exporting...';
      elements.exportLegendButton.disabled = true;

      const response = await browser.runtime.sendMessage({ type: 'EXPORT_LEGEND_STATS' });

      if (response.success) {
        const blob = new Blob([response.data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `vantedge-legend-stats-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        alert('Legend stats exported successfully!');
      } else {
        alert('Export failed: ' + response.error);
      }
    } catch (error) {
      console.error('Export error:', error);
      alert('Export failed: ' + error.message);
    } finally {
      elements.exportLegendButton.textContent = '📤 Export';
      elements.exportLegendButton.disabled = false;
    }
  }

  async function handleCreateBackup() {
    try {
      elements.createBackupButton.textContent = 'Creating...';
      elements.createBackupButton.disabled = true;

      const response = await browser.runtime.sendMessage({
        type: 'CREATE_BACKUP',
        description: 'Manual backup'
      });

      if (response.success) {
        alert('Backup created successfully!');
        updateStorageStats(); // Update storage stats
      } else {
        alert('Backup failed: ' + response.error);
      }
    } catch (error) {
      console.error('Backup error:', error);
      alert('Backup failed: ' + error.message);
    } finally {
      elements.createBackupButton.textContent = '💾 Backup';
      elements.createBackupButton.disabled = false;
    }
  }

  async function handleViewBackups() {
    try {
      elements.viewBackupsButton.textContent = 'Loading...';
      elements.viewBackupsButton.disabled = true;

      const response = await browser.runtime.sendMessage({ type: 'GET_BACKUPS' });

      if (response.success) {
        displayBackupList(response.backups);
        elements.backupListContainer.style.display = 'block';
      } else {
        alert('Failed to load backups: ' + response.error);
      }
    } catch (error) {
      console.error('Load backups error:', error);
      alert('Failed to load backups: ' + error.message);
    } finally {
      elements.viewBackupsButton.textContent = '📋 Backups';
      elements.viewBackupsButton.disabled = false;
    }
  }

  async function handleFixBackups() {
    try {
      elements.fixBackupsButton.textContent = 'Fixing...';
      elements.fixBackupsButton.disabled = true;

      const response = await browser.runtime.sendMessage({ type: 'FORCE_SYNC_TO_INDEXEDDB' });

      if (response.success) {
        if (response.synced === 0) {
          alert('No legend stats found to sync. Play some games with strategies to build up your legend stats!');
        } else {
          alert(`✅ Fixed! Re-synced ${response.synced} site(s) to IndexedDB.\n\nYour backups should now show the correct data. Click "📋 Backups" to verify.`);
        }
        updateStorageStats(); // Refresh storage stats display
      } else {
        alert('Fix failed: ' + response.error);
      }
    } catch (error) {
      console.error('Fix backups error:', error);
      alert('Fix failed: ' + error.message);
    } finally {
      elements.fixBackupsButton.textContent = '🔧 Fix Empty Backups';
      elements.fixBackupsButton.disabled = false;
    }
  }

  function displayBackupList(backups) {
    if (!backups || backups.length === 0) {
      elements.backupList.innerHTML = '<p style="text-align: center; color: var(--text-secondary);">No backups available</p>';
      return;
    }

    elements.backupList.innerHTML = backups.map(backup => `
      <div style="background: rgba(255,255,255,0.05); padding: 6px; margin-bottom: 4px; border-radius: 3px; display: flex; justify-content: space-between; align-items: center;">
        <div style="flex: 1;">
          <div style="font-weight: 600; margin-bottom: 2px;">${backup.description}</div>
          <div style="font-size: 9px; color: var(--text-secondary);">
            ${new Date(backup.timestamp).toLocaleString()} • ${backup.statsCount} site(s)
          </div>
        </div>
        <button
          class="preset-btn"
          style="padding: 3px 8px; font-size: 9px; min-width: 60px;"
          onclick="handleRestoreBackup(${backup.id})"
        >Restore</button>
      </div>
    `).join('');
  }

  // Make restore function global so it can be called from onclick
  window.handleRestoreBackup = async function(backupId) {
    const confirmed = confirm('Are you sure you want to restore this backup? This will replace your current legend stats.');

    if (!confirmed) return;

    try {
      const response = await browser.runtime.sendMessage({
        type: 'RESTORE_BACKUP',
        backupId: backupId
      });

      if (response.success) {
        alert('Backup restored successfully!');
        elements.backupListContainer.style.display = 'none';
        loadData(); // Refresh the display
      } else {
        alert('Restore failed: ' + response.error);
      }
    } catch (error) {
      console.error('Restore error:', error);
      alert('Restore failed: ' + error.message);
    }
  };

  async function updateStorageStats() {
    try {
      const response = await browser.runtime.sendMessage({ type: 'GET_STORAGE_STATS' });

      if (response.success) {
        const stats = response.stats;
        elements.storageTotalSites.textContent = stats.totalSites || '0';
        elements.storageTotalBackups.textContent = stats.totalBackups || '0';
        elements.storageLastBackup.textContent = stats.lastBackup
          ? new Date(stats.lastBackup).toLocaleDateString()
          : 'Never';
      }
    } catch (error) {
      console.error('Failed to update storage stats:', error);
    }
  }

  initializePopup();
});