// Paste this into browser DevTools console on any Stake/Rainbet page
// to recover your old legend stats before they're lost

(async function recoverLegendStats() {
    const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

    return new Promise((resolve) => {
        browserAPI.storage.local.get('legendStats', (result) => {
            if (result.legendStats) {
                console.log('✅ Found legend stats in storage!');
                console.log(result.legendStats);

                // Create export format
                const exportData = {
                    version: 1,
                    exportDate: new Date().toISOString(),
                    legendStats: result.legendStats,
                    metadata: {
                        totalSites: Object.keys(result.legendStats).length,
                        totalHits: Object.values(result.legendStats)
                            .reduce((sum, site) => sum + (site.totalHits || 0), 0)
                    }
                };

                // Create download
                const blob = new Blob([JSON.stringify(exportData, null, 2)],
                    { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `recovered-legend-stats-${new Date().toISOString().split('T')[0]}.json`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);

                console.log('📥 Downloaded recovered-legend-stats.json');
                console.log('Total sites:', exportData.metadata.totalSites);
                console.log('Total hits:', exportData.metadata.totalHits);

                resolve(exportData);
            } else {
                console.log('❌ No legend stats found in storage');
                resolve(null);
            }
        });
    });
})();
