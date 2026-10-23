// =============================================================================
// Vantedge — GitHub Gist Cloud Sync (per-user token)
// =============================================================================
//
// Optional backup/sync of your Legend Stats to a single PRIVATE GitHub Gist.
// Each user supplies their OWN GitHub token — nothing is baked into the build,
// so the public source contains no secrets and every install syncs to its own
// gist.
//
// SETUP (each user, one time):
//   1. https://github.com/settings/tokens/new
//   2. Note: "Vantedge sync"   Expiration: your choice
//      Scopes: check ONLY  ☑ gist   (no repo / account access)
//   3. Generate → copy the token (starts with `ghp_` or `github_pat_`)
//   4. Paste it into the extension popup → "Cloud Sync" → token field → Save.
//
// The token is stored only in this browser's local extension storage
// (browser.storage.local, key below) and is never committed or shared. Revoke
// it any time from the GitHub link above.
//
// =============================================================================

// Identifying string in the Gist description — used to find your sync gist
// among any other gists on the account.
const GIST_DESCRIPTION = 'Vantedge legend stats sync';
const GIST_FILENAME = 'vantedge-legend-stats.json';

const GIST_ID_KEY = 'vantedge_gist_id';        // cached gist id
const LAST_SYNC_KEY = 'vantedge_last_sync';    // { ts, direction, status }
const TOKEN_KEY = 'vantedge_github_token';     // per-user gist-scope PAT (local only)

const SYNCED_STORAGE_KEYS = ['legendStats'];

(function () {
    const api = (typeof browser !== 'undefined') ? browser : chrome;

    async function getToken() {
        const r = await api.storage.local.get(TOKEN_KEY);
        return (r[TOKEN_KEY] || '').trim();
    }

    async function setToken(token) {
        const t = (token || '').trim();
        if (t) await api.storage.local.set({ [TOKEN_KEY]: t });
        else await api.storage.local.remove(TOKEN_KEY);
        return { ok: true, configured: !!t };
    }

    async function tokenConfigured() {
        return !!(await getToken());
    }

    async function gh(url, opts = {}) {
        const token = await getToken();
        if (!token) throw new Error('GitHub token not configured');
        const headers = Object.assign({
            'Authorization': 'Bearer ' + token,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28'
        }, opts.headers || {});
        const r = await fetch(url, Object.assign({}, opts, { headers }));
        if (r.status === 401) throw new Error('TOKEN_INVALID (revoked or wrong scopes)');
        if (!r.ok) {
            const text = await r.text().catch(() => '');
            throw new Error(`GitHub API ${r.status}: ${text.slice(0, 200)}`);
        }
        return r;
    }

    // ---- Find / get / create the sync gist --------------------------------

    async function findSyncGist() {
        // Cached ID? Verify it still exists.
        const cached = await api.storage.local.get(GIST_ID_KEY);
        if (cached[GIST_ID_KEY]) {
            try {
                const r = await gh('https://api.github.com/gists/' + cached[GIST_ID_KEY]);
                const j = await r.json();
                if (j.id) return j;
            } catch (e) { /* fall through to search */ }
        }
        // Search the token owner's gists (auto-paginated, up to 1000)
        let page = 1;
        while (page < 11) {
            const r = await gh(`https://api.github.com/gists?per_page=100&page=${page}`);
            const list = await r.json();
            if (!Array.isArray(list) || list.length === 0) break;
            const match = list.find(g => g.description === GIST_DESCRIPTION);
            if (match) {
                await api.storage.local.set({ [GIST_ID_KEY]: match.id });
                // Fetch full gist (list endpoint doesn't include file contents)
                const full = await gh('https://api.github.com/gists/' + match.id);
                return await full.json();
            }
            if (list.length < 100) break;
            page++;
        }
        return null;
    }

    async function createSyncGist(payload) {
        const r = await gh('https://api.github.com/gists', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                description: GIST_DESCRIPTION,
                public: false,
                files: { [GIST_FILENAME]: { content: JSON.stringify(payload, null, 2) } }
            })
        });
        const j = await r.json();
        if (j.id) await api.storage.local.set({ [GIST_ID_KEY]: j.id });
        return j;
    }

    async function updateSyncGist(gistId, payload) {
        const r = await gh('https://api.github.com/gists/' + gistId, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                files: { [GIST_FILENAME]: { content: JSON.stringify(payload, null, 2) } }
            })
        });
        return await r.json();
    }

    async function downloadFromCloud() {
        const gist = await findSyncGist();
        if (!gist) return null;
        const file = gist.files?.[GIST_FILENAME];
        if (!file) return null;

        // If gist file is large (>1MB), GitHub returns truncated=true + a
        // raw_url to fetch from. Use that path for safety.
        let content = file.content || '';
        if (file.truncated && file.raw_url) {
            const r = await fetch(file.raw_url, {
                headers: { 'Authorization': 'Bearer ' + (await getToken()) }
            });
            if (r.ok) content = await r.text();
        }
        if (!content) return null;
        try {
            return {
                data: JSON.parse(content),
                modifiedTime: gist.updated_at
            };
        } catch (e) {
            throw new Error('Remote gist is corrupt: ' + e.message);
        }
    }

    async function uploadToCloud(payload) {
        const existing = await findSyncGist();
        if (existing?.id) return await updateSyncGist(existing.id, payload);
        return await createSyncGist(payload);
    }

    // ---- Payload shape (matches the popup's 📤 Export button) -------------

    async function buildExportPayload() {
        const manager = self.VantEdgeStorageManager;
        if (manager) {
            try {
                const jsonStr = await manager.exportToJSON();
                return JSON.parse(jsonStr);
            } catch (e) { /* fall through */ }
        }
        const result = await api.storage.local.get('legendStats');
        const legendStats = result.legendStats || {};
        return {
            version: 1,
            exportDate: new Date().toISOString(),
            legendStats,
            metadata: {
                totalSites: Object.keys(legendStats).length,
                totalHits: Object.values(legendStats).reduce((s, v) => s + (v.totalHits || 0), 0)
            }
        };
    }

    async function applyImportPayload(payload) {
        if (!payload || !payload.legendStats || typeof payload.legendStats !== 'object') {
            throw new Error('Cloud file has no legendStats');
        }
        const existing = await api.storage.local.get('legendStats');
        const merged = { ...(existing.legendStats || {}), ...payload.legendStats };
        await api.storage.local.set({ legendStats: merged });

        const manager = self.VantEdgeStorageManager;
        if (manager) {
            for (const [siteKey, stats] of Object.entries(payload.legendStats)) {
                try { await manager.saveLegendStats(siteKey, stats); }
                catch (e) { /* non-fatal */ }
            }
        }
        return Object.keys(payload.legendStats).length;
    }

    // ---- Public API -------------------------------------------------------

    async function pushNow() {
        const payload = await buildExportPayload();
        await uploadToCloud(payload);
        const stamp = {
            ts: Date.now(), direction: 'push', status: 'ok',
            sites: payload.metadata?.totalSites || 0,
            hits: payload.metadata?.totalHits || 0
        };
        await api.storage.local.set({ [LAST_SYNC_KEY]: stamp });
        return stamp;
    }

    async function pullNow() {
        const remote = await downloadFromCloud();
        if (!remote) {
            const stamp = { ts: Date.now(), direction: 'pull', status: 'empty' };
            await api.storage.local.set({ [LAST_SYNC_KEY]: stamp });
            return stamp;
        }
        const restored = await applyImportPayload(remote.data);
        const stamp = { ts: Date.now(), direction: 'pull', status: 'ok', restored };
        await api.storage.local.set({ [LAST_SYNC_KEY]: stamp });
        return stamp;
    }

    async function pullIfNewer() {
        const remote = await downloadFromCloud();
        if (!remote) return { status: 'empty' };
        const local = await api.storage.local.get(LAST_SYNC_KEY);
        const lastTs = local[LAST_SYNC_KEY]?.ts || 0;
        const remoteTs = new Date(remote.modifiedTime).getTime();
        if (remoteTs > lastTs) {
            const restored = await applyImportPayload(remote.data);
            const stamp = { ts: Date.now(), direction: 'pull', status: 'ok', restored };
            await api.storage.local.set({ [LAST_SYNC_KEY]: stamp });
            return stamp;
        }
        return { status: 'up-to-date' };
    }

    let pushTimer = null;
    function scheduleAutoPush(delayMs = 5000) {
        if (pushTimer) clearTimeout(pushTimer);
        pushTimer = setTimeout(async () => {
            pushTimer = null;
            try {
                if (!(await tokenConfigured())) return;   // no token set → skip silently
                await pushNow();
            } catch (e) {
                console.warn('☁️ Vantedge: auto-sync failed:', e.message);
                await api.storage.local.set({
                    [LAST_SYNC_KEY]: { ts: Date.now(), direction: 'push', status: 'error', error: e.message }
                });
            }
        }, delayMs);
    }

    // Verify the baked-in token by hitting /user (cheap, doesn't write anything)
    async function verifyToken() {
        try {
            const r = await gh('https://api.github.com/user');
            const j = await r.json();
            return { ok: true, login: j.login };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    }

    async function getStatus() {
        const last = await api.storage.local.get(LAST_SYNC_KEY);
        return {
            tokenConfigured: await tokenConfigured(),
            lastSync: last[LAST_SYNC_KEY] || null
        };
    }

    self.VantedgeCloudSync = {
        pushNow, pullNow, pullIfNewer,
        scheduleAutoPush,
        getStatus, verifyToken, setToken,
        SYNCED_STORAGE_KEYS,
        tokenConfigured
    };
})();
