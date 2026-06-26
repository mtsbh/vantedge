/**
 * VantEdge Storage Manager
 * Sophisticated persistent storage system for legend stats
 * Uses IndexedDB for robust persistence that survives extension reinstalls
 */

class VantEdgeStorageManager {
    constructor() {
        this.dbName = 'VantEdgeLegendDB';
        this.dbVersion = 1;
        this.db = null;
        this.syncEnabled = false;

        // Auto-backup configuration
        this.autoBackupInterval = 24 * 60 * 60 * 1000; // 24 hours
        this.maxBackups = 10;
        this.lastBackupTime = 0;
    }

    /**
     * Initialize the storage system
     */
    async init() {
        try {
            await this.initIndexedDB();
            await this.initSync();
            await this.migrateFromLocalStorage();
            await this.startAutoBackup();
            console.log('VantEdge Storage Manager initialized successfully');
            return true;
        } catch (error) {
            console.error('Failed to initialize storage manager:', error);
            return false;
        }
    }

    /**
     * Initialize IndexedDB
     */
    initIndexedDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);

            request.onerror = () => {
                console.error('IndexedDB error:', request.error);
                reject(request.error);
            };

            request.onsuccess = (event) => {
                this.db = event.target.result;
                console.log('IndexedDB opened successfully');
                resolve();
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                // Legend Stats store
                if (!db.objectStoreNames.contains('legendStats')) {
                    const legendStore = db.createObjectStore('legendStats', { keyPath: 'siteKey' });
                    legendStore.createIndex('timestamp', 'timestamp', { unique: false });
                    legendStore.createIndex('totalHits', 'totalHits', { unique: false });
                }

                // Backups store
                if (!db.objectStoreNames.contains('backups')) {
                    const backupStore = db.createObjectStore('backups', { keyPath: 'id', autoIncrement: true });
                    backupStore.createIndex('timestamp', 'timestamp', { unique: false });
                    backupStore.createIndex('version', 'version', { unique: false });
                }

                // Metadata store
                if (!db.objectStoreNames.contains('metadata')) {
                    db.createObjectStore('metadata', { keyPath: 'key' });
                }

                console.log('IndexedDB schema created/upgraded');
            };
        });
    }

    /**
     * Initialize Chrome Storage Sync (if available)
     */
    async initSync() {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
            this.syncEnabled = true;
            console.log('Chrome Storage Sync enabled');
        } else if (typeof browser !== 'undefined' && browser.storage && browser.storage.sync) {
            this.syncEnabled = true;
            console.log('Browser Storage Sync enabled');
        } else {
            console.log('Storage Sync not available');
        }
    }

    /**
     * Migrate existing data from browser.storage.local to IndexedDB
     */
    async migrateFromLocalStorage() {
        try {
            const browserAPI = typeof browser !== 'undefined' ? browser : chrome;
            const result = await browserAPI.storage.local.get('legendStats');
            if (result.legendStats && Object.keys(result.legendStats).length > 0) {
                console.log('Migrating legend stats from local storage to IndexedDB...');
                for (const [siteKey, stats] of Object.entries(result.legendStats)) {
                    await this.saveLegendStats(siteKey, stats);
                }
                console.log('Migration completed successfully');
                await this.createBackup('Migration backup');
            }
        } catch (error) {
            console.error('Migration error:', error);
        }
    }

    /**
     * Save legend stats for a specific site
     */
    async saveLegendStats(siteKey, stats) {
        if (!this.db) {
            throw new Error('Database not initialized');
        }

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['legendStats'], 'readwrite');
            const store = transaction.objectStore('legendStats');

            const data = {
                siteKey: siteKey,
                ...stats,
                timestamp: new Date().toISOString(),
                lastUpdated: Date.now()
            };

            const request = store.put(data);

            request.onsuccess = async () => {
                // Also save to browser.storage.local for backward compatibility
                await this.syncToBrowserStorage(siteKey, stats);

                // Sync to cloud if enabled
                if (this.syncEnabled) {
                    await this.syncToCloud(siteKey, stats);
                }

                resolve();
            };

            request.onerror = () => {
                console.error('Error saving legend stats:', request.error);
                reject(request.error);
            };
        });
    }

    /**
     * Load legend stats for a specific site
     */
    async loadLegendStats(siteKey) {
        if (!this.db) {
            throw new Error('Database not initialized');
        }

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['legendStats'], 'readonly');
            const store = transaction.objectStore('legendStats');
            const request = store.get(siteKey);

            request.onsuccess = () => {
                const result = request.result;
                if (result) {
                    // Remove internal fields before returning
                    const { siteKey: _, timestamp: __, lastUpdated: ___, ...stats } = result;
                    resolve(stats);
                } else {
                    resolve(null);
                }
            };

            request.onerror = () => {
                console.error('Error loading legend stats:', request.error);
                reject(request.error);
            };
        });
    }

    /**
     * Load all legend stats
     */
    async loadAllLegendStats() {
        if (!this.db) {
            throw new Error('Database not initialized');
        }

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['legendStats'], 'readonly');
            const store = transaction.objectStore('legendStats');
            const request = store.getAll();

            request.onsuccess = () => {
                const results = request.result;
                const statsMap = {};

                results.forEach(result => {
                    const { siteKey, timestamp, lastUpdated, ...stats } = result;
                    statsMap[siteKey] = stats;
                });

                resolve(statsMap);
            };

            request.onerror = () => {
                console.error('Error loading all legend stats:', request.error);
                reject(request.error);
            };
        });
    }

    /**
     * Sync to browser.storage.local for backward compatibility
     */
    async syncToBrowserStorage(siteKey, stats) {
        const browserAPI = typeof browser !== 'undefined' ? browser : chrome;
        const result = await browserAPI.storage.local.get('legendStats');
        const legendStats = result.legendStats || {};
        legendStats[siteKey] = stats;
        await browserAPI.storage.local.set({ legendStats });
    }

    /**
     * Sync to Chrome Storage Sync (cross-device)
     */
    async syncToCloud(siteKey, stats) {
        if (!this.syncEnabled) return;

        const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

        try {
            // Chrome Storage Sync has 8KB per item limit, so we need to be careful
            const syncKey = `legend_${siteKey}`;
            const syncData = {
                totalHits: stats.totalHits || 0,
                hitsByMultiplier: stats.hitsByMultiplier || {},
                hitsByStrategy: stats.hitsByStrategy || {},
                // Only store last 5 recent hits to save space
                recentHits: (stats.recentHits || []).slice(0, 5),
                timestamp: new Date().toISOString()
            };

            const dataStr = JSON.stringify(syncData);
            if (dataStr.length < 7000) { // Leave buffer for safety
                browserAPI.storage.sync.set({ [syncKey]: syncData });
                console.log(`Synced ${siteKey} to cloud storage`);
            } else {
                console.warn(`Data for ${siteKey} too large for sync storage`);
            }
        } catch (error) {
            console.error('Error syncing to cloud:', error);
        }
    }

    /**
     * Create a versioned backup
     */
    async createBackup(description = 'Manual backup') {
        if (!this.db) {
            throw new Error('Database not initialized');
        }

        try {
            // Get all current legend stats
            const allStats = await this.loadAllLegendStats();

            return new Promise((resolve, reject) => {
                const transaction = this.db.transaction(['backups'], 'readwrite');
                const store = transaction.objectStore('backups');

                const backup = {
                    version: this.dbVersion,
                    timestamp: new Date().toISOString(),
                    timestampMs: Date.now(),
                    description: description,
                    data: allStats,
                    statsCount: Object.keys(allStats).length
                };

                const request = store.add(backup);

                request.onsuccess = async () => {
                    console.log('Backup created successfully:', backup.timestamp);

                    // Clean up old backups
                    await this.cleanupOldBackups();

                    // Update last backup time
                    this.lastBackupTime = Date.now();
                    await this.setMetadata('lastBackupTime', this.lastBackupTime);

                    resolve(request.result);
                };

                request.onerror = () => {
                    console.error('Error creating backup:', request.error);
                    reject(request.error);
                };
            });
        } catch (error) {
            console.error('Backup creation failed:', error);
            throw error;
        }
    }

    /**
     * Restore from a backup
     */
    async restoreFromBackup(backupId) {
        if (!this.db) {
            throw new Error('Database not initialized');
        }

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['backups', 'legendStats'], 'readwrite');
            const backupStore = transaction.objectStore('backups');
            const legendStore = transaction.objectStore('legendStats');

            const request = backupStore.get(backupId);

            request.onsuccess = async () => {
                const backup = request.result;

                if (!backup) {
                    reject(new Error('Backup not found'));
                    return;
                }

                try {
                    // Clear current legend stats
                    const clearRequest = legendStore.clear();

                    clearRequest.onsuccess = async () => {
                        // Restore backup data
                        for (const [siteKey, stats] of Object.entries(backup.data)) {
                            await this.saveLegendStats(siteKey, stats);
                        }

                        console.log('Backup restored successfully:', backup.timestamp);
                        resolve(backup);
                    };

                    clearRequest.onerror = () => {
                        reject(clearRequest.error);
                    };
                } catch (error) {
                    console.error('Error during restore:', error);
                    reject(error);
                }
            };

            request.onerror = () => {
                console.error('Error loading backup:', request.error);
                reject(request.error);
            };
        });
    }

    /**
     * Get all backups
     */
    async getAllBackups() {
        if (!this.db) {
            throw new Error('Database not initialized');
        }

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['backups'], 'readonly');
            const store = transaction.objectStore('backups');
            const index = store.index('timestamp');
            const request = index.openCursor(null, 'prev'); // Newest first

            const backups = [];

            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    const { data, ...metadata } = cursor.value;
                    backups.push(metadata);
                    cursor.continue();
                } else {
                    resolve(backups);
                }
            };

            request.onerror = () => {
                console.error('Error loading backups:', request.error);
                reject(request.error);
            };
        });
    }

    /**
     * Delete old backups, keeping only the most recent ones
     */
    async cleanupOldBackups() {
        const backups = await this.getAllBackups();

        if (backups.length > this.maxBackups) {
            const toDelete = backups.slice(this.maxBackups);

            return new Promise((resolve) => {
                const transaction = this.db.transaction(['backups'], 'readwrite');
                const store = transaction.objectStore('backups');

                toDelete.forEach(backup => {
                    store.delete(backup.id);
                });

                transaction.oncomplete = () => {
                    console.log(`Cleaned up ${toDelete.length} old backups`);
                    resolve();
                };
            });
        }
    }

    /**
     * Export legend stats as JSON file
     */
    async exportToJSON() {
        const allStats = await this.loadAllLegendStats();

        const exportData = {
            version: this.dbVersion,
            exportDate: new Date().toISOString(),
            legendStats: allStats,
            metadata: {
                totalSites: Object.keys(allStats).length,
                totalHits: Object.values(allStats).reduce((sum, site) => sum + (site.totalHits || 0), 0)
            }
        };

        return JSON.stringify(exportData, null, 2);
    }

    /**
     * Import legend stats from JSON
     */
    async importFromJSON(jsonString) {
        try {
            const importData = JSON.parse(jsonString);

            if (!importData.legendStats) {
                throw new Error('Invalid import format: missing legendStats');
            }

            // Create backup before import
            await this.createBackup('Pre-import backup');

            // Import all legend stats
            for (const [siteKey, stats] of Object.entries(importData.legendStats)) {
                await this.saveLegendStats(siteKey, stats);
            }

            console.log('Import completed successfully');
            return {
                success: true,
                sitesImported: Object.keys(importData.legendStats).length
            };
        } catch (error) {
            console.error('Import failed:', error);
            throw error;
        }
    }

    /**
     * Start automatic backup system
     */
    async startAutoBackup() {
        // Get last backup time
        this.lastBackupTime = await this.getMetadata('lastBackupTime') || 0;

        // Check if backup is needed
        const timeSinceLastBackup = Date.now() - this.lastBackupTime;

        if (timeSinceLastBackup >= this.autoBackupInterval) {
            await this.createBackup('Automatic backup');
        }

        // Schedule next auto-backup check (every hour)
        setInterval(async () => {
            const timeSinceLastBackup = Date.now() - this.lastBackupTime;

            if (timeSinceLastBackup >= this.autoBackupInterval) {
                console.log('Creating automatic backup...');
                await this.createBackup('Automatic backup');
            }
        }, 60 * 60 * 1000); // Check every hour
    }

    /**
     * Set metadata
     */
    async setMetadata(key, value) {
        if (!this.db) return;

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['metadata'], 'readwrite');
            const store = transaction.objectStore('metadata');
            const request = store.put({ key, value });

            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Get metadata
     */
    async getMetadata(key) {
        if (!this.db) return null;

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['metadata'], 'readonly');
            const store = transaction.objectStore('metadata');
            const request = store.get(key);

            request.onsuccess = () => {
                const result = request.result;
                resolve(result ? result.value : null);
            };
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Get storage statistics
     */
    async getStorageStats() {
        const allStats = await this.loadAllLegendStats();
        const backups = await this.getAllBackups();

        return {
            totalSites: Object.keys(allStats).length,
            totalHits: Object.values(allStats).reduce((sum, site) => sum + (site.totalHits || 0), 0),
            totalBackups: backups.length,
            lastBackup: backups.length > 0 ? backups[0].timestamp : null,
            syncEnabled: this.syncEnabled,
            databaseSize: await this.getDatabaseSize()
        };
    }

    /**
     * Estimate database size
     */
    async getDatabaseSize() {
        if (navigator.storage && navigator.storage.estimate) {
            const estimate = await navigator.storage.estimate();
            return {
                usage: estimate.usage,
                quota: estimate.quota,
                percentage: ((estimate.usage / estimate.quota) * 100).toFixed(2)
            };
        }
        return null;
    }
}

// Make the class available globally for background script
// Use globalThis which works in both window context (popup) and service worker context (background)
// In service workers: self and globalThis are available (but not window)
// In regular scripts: window, self, and globalThis are all available
if (typeof globalThis !== 'undefined') {
    globalThis.VantEdgeStorageManager = VantEdgeStorageManager;
} else if (typeof self !== 'undefined') {
    self.VantEdgeStorageManager = VantEdgeStorageManager;
}
