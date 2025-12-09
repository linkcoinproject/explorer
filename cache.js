/**
 * Cache and Update Manager for DedooExplorer
 * 
 * Architecture:
 * - Update Manager: Background process that fetches from Electrs every 10 seconds
 * - Memory Cache (LRU): Primary data source for all display
 * - SQLite: Historical statistics only (for charts)
 * 
 * User requests NEVER trigger Electrs API calls (except fallback when cache empty)
 */

const { LRUCache } = require('lru-cache');
const Database = require('better-sqlite3');
const path = require('path');
const axios = require('axios');

// === CONFIGURATION ===
const UPDATE_INTERVAL = 10 * 1000; // 10 seconds
let ELECTRS_API = 'http://127.0.0.1:50010';

// === LRU MEMORY CACHE ===
// This is the PRIMARY data source for display
const liveCache = new LRUCache({
    max: 100,
    ttl: 60 * 1000, // 60 seconds TTL (but data refreshed every 10s)
});

// Cache for immutable data (tx/block details by hash)
const immutableCache = new LRUCache({
    max: 1000,
    ttl: 60 * 60 * 1000, // 1 hour
});

// === SQLITE FOR STATISTICS ONLY ===
let db = null;
const DB_PATH = path.join(__dirname, 'data', 'stats.db');

// === LIVE DATA KEYS ===
const LIVE_KEYS = {
    DASHBOARD: 'live:dashboard',
    BLOCKS: 'live:blocks',
    TIP_HEIGHT: 'live:tipHeight',
    MEMPOOL: 'live:mempool',
    BLOCK_REWARD: 'live:blockReward',
};

// === INITIALIZATION ===

function setElectrsApi(url) {
    ELECTRS_API = url;
}

function initDatabase() {
    try {
        const fs = require('fs');
        const dataDir = path.join(__dirname, 'data');
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }

        db = new Database(DB_PATH);
        db.pragma('journal_mode = WAL');

        // Statistics tables only
        db.exec(`
            CREATE TABLE IF NOT EXISTS daily_stats (
                date TEXT PRIMARY KEY,
                tx_count INTEGER DEFAULT 0,
                block_count INTEGER DEFAULT 0,
                total_size INTEGER DEFAULT 0,
                avg_block_size REAL DEFAULT 0,
                updated_at INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS blocks_history (
                height INTEGER PRIMARY KEY,
                hash TEXT,
                timestamp INTEGER,
                tx_count INTEGER,
                size INTEGER,
                block_reward INTEGER DEFAULT 0,
                date TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_blocks_date ON blocks_history(date);
        `);

        // Cleanup old data (keep 90 days)
        const ninetyDaysAgo = Math.floor(Date.now() / 1000) - (90 * 24 * 60 * 60);
        const ninetyDaysAgoDate = new Date(ninetyDaysAgo * 1000).toISOString().split('T')[0];
        db.prepare('DELETE FROM blocks_history WHERE timestamp < ?').run(ninetyDaysAgo);
        db.prepare('DELETE FROM daily_stats WHERE date < ?').run(ninetyDaysAgoDate);

        console.log('[Cache] SQLite initialized for statistics:', DB_PATH);
        return true;
    } catch (error) {
        console.error('[Cache] SQLite init error:', error.message);
        return false;
    }
}

// === MEMORY CACHE FUNCTIONS ===

function getLive(key) {
    return liveCache.get(key);
}

function setLive(key, value) {
    liveCache.set(key, value);
}

function getImmutable(key) {
    return immutableCache.get(key);
}

function setImmutable(key, value) {
    immutableCache.set(key, value);
}

// === API CALL HELPER (for Update Manager and fallback) ===

async function fetchFromElectrs(endpoint) {
    try {
        const response = await axios.get(`${ELECTRS_API}${endpoint}`, { timeout: 10000 });
        return response.data;
    } catch (error) {
        console.error(`[Electrs] API Error ${endpoint}:`, error.message);
        throw error;
    }
}

// === UPDATE MANAGER ===

let updateManagerRunning = false;
let lastUpdateTime = 0;

async function updateManager() {
    if (updateManagerRunning) return;
    updateManagerRunning = true;

    try {
        console.log('[UpdateManager] Fetching fresh data from Electrs...');

        // Fetch all live data from Electrs
        const [blocks, tipHeight, mempool, supplyData] = await Promise.all([
            fetchFromElectrs('/blocks'),
            fetchFromElectrs('/blocks/tip/height'),
            fetchFromElectrs('/mempool/recent').catch(() => []),
            fetchFromElectrs('/blockchain/getsupply').catch(() => ({ total_amount_float: 0 }))
        ]);

        // Calculate stats
        const avgBlockTime = blocks.length > 1
            ? Math.round((blocks[0].timestamp - blocks[blocks.length - 1].timestamp) / (blocks.length - 1))
            : 120;

        const latestDifficulty = blocks[0]?.difficulty || 0;
        const hashrate = (latestDifficulty * Math.pow(2, 32)) / avgBlockTime;

        // Get block reward from latest coinbase
        let blockReward = getLive(LIVE_KEYS.BLOCK_REWARD);
        if (!blockReward && blocks[0]) {
            try {
                const txs = await fetchFromElectrs(`/block/${blocks[0].id}/txs/0`);
                if (txs && txs[0] && txs[0].vin[0]?.is_coinbase) {
                    blockReward = txs[0].vout.reduce((sum, vout) => sum + (vout.value || 0), 0);
                    // Cache tx data as immutable
                    setImmutable(`tx:${txs[0].txid}`, txs[0]);
                }
            } catch (e) {
                console.error('[UpdateManager] Block reward fetch error:', e.message);
            }
        }

        // Store in memory cache
        const dashboardData = {
            tipHeight,
            hashrate,
            avgBlockTime,
            mempoolCount: mempool.length,
            difficulty: latestDifficulty,
            supply: supplyData.total_amount_float || 0,
            blockReward: blockReward || 0,
            blocks: blocks.slice(0, 15),
            updatedAt: Date.now()
        };

        setLive(LIVE_KEYS.DASHBOARD, dashboardData);
        setLive(LIVE_KEYS.BLOCKS, blocks);
        setLive(LIVE_KEYS.TIP_HEIGHT, tipHeight);
        setLive(LIVE_KEYS.MEMPOOL, mempool);
        if (blockReward) setLive(LIVE_KEYS.BLOCK_REWARD, blockReward);

        lastUpdateTime = Date.now();

        // Save to SQLite for statistics (async, non-blocking)
        saveBlocksToStats(blocks);

        console.log(`[UpdateManager] Updated - Height: ${tipHeight}, Blocks: ${blocks.length}`);

    } catch (error) {
        console.error('[UpdateManager] Error:', error.message);
    } finally {
        updateManagerRunning = false;
    }
}

// Start Update Manager
let updateInterval = null;

function startUpdateManager() {
    if (updateInterval) return;

    console.log('[UpdateManager] Starting with 10s interval');

    // Initial fetch
    updateManager();

    // Schedule regular updates
    updateInterval = setInterval(updateManager, UPDATE_INTERVAL);
}

function stopUpdateManager() {
    if (updateInterval) {
        clearInterval(updateInterval);
        updateInterval = null;
        console.log('[UpdateManager] Stopped');
    }
}

// === STATISTICS FUNCTIONS (SQLite) ===

function saveBlocksToStats(blocks) {
    if (!db || !blocks || !blocks.length) return;

    try {
        const insert = db.prepare(`
            INSERT OR IGNORE INTO blocks_history 
            (height, hash, timestamp, tx_count, size, date)
            VALUES (?, ?, ?, ?, ?, ?)
        `);

        const insertMany = db.transaction((blocks) => {
            for (const block of blocks) {
                const date = new Date(block.timestamp * 1000).toISOString().split('T')[0];
                insert.run(block.height, block.id, block.timestamp, block.tx_count || 0, block.size || 0, date);
            }
        });

        insertMany(blocks);

        // Update daily stats for today
        const today = new Date().toISOString().split('T')[0];
        updateDailyStats(today);

    } catch (error) {
        // Ignore errors - statistics are not critical
    }
}

function updateDailyStats(date) {
    if (!db) return;

    try {
        const stats = db.prepare(`
            SELECT 
                COUNT(*) as block_count,
                SUM(tx_count) as tx_count,
                SUM(size) as total_size,
                AVG(size) as avg_block_size
            FROM blocks_history 
            WHERE date = ?
        `).get(date);

        if (stats && stats.block_count > 0) {
            db.prepare(`
                INSERT OR REPLACE INTO daily_stats 
                (date, tx_count, block_count, total_size, avg_block_size, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(date, stats.tx_count || 0, stats.block_count, stats.total_size || 0, stats.avg_block_size || 0, Math.floor(Date.now() / 1000));
        }
    } catch (error) {
        // Ignore errors
    }
}

function getDailyStats(days = 7) {
    if (!db) return [];
    try {
        return db.prepare(`
            SELECT * FROM daily_stats 
            ORDER BY date DESC 
            LIMIT ?
        `).all(days).reverse();
    } catch (e) {
        return [];
    }
}

function getDailyTxCounts(days = 7) {
    return getDailyStats(days).map(s => ({
        date: s.date,
        count: s.tx_count || 0
    }));
}

function getDailyBlockSizes(days = 7) {
    return getDailyStats(days).map(s => ({
        date: s.date,
        avgSize: Math.round(s.avg_block_size || 0)
    }));
}

// === PUBLIC API FOR SERVER ===

// Get dashboard data (from cache, never triggers API)
function getDashboard() {
    return getLive(LIVE_KEYS.DASHBOARD);
}

// Get blocks (from cache)
function getBlocks() {
    return getLive(LIVE_KEYS.BLOCKS);
}

// Get tip height
function getTipHeight() {
    return getLive(LIVE_KEYS.TIP_HEIGHT);
}

// Get mempool
function getMempool() {
    return getLive(LIVE_KEYS.MEMPOOL);
}

// Get block reward
function getBlockReward() {
    return getLive(LIVE_KEYS.BLOCK_REWARD);
}

// Get last update time
function getLastUpdateTime() {
    return lastUpdateTime;
}

// Check if cache is fresh (within 30s)
function isCacheFresh() {
    return Date.now() - lastUpdateTime < 30000;
}

// === EXPORTS ===

module.exports = {
    // Configuration
    setElectrsApi,
    initDatabase,

    // Update Manager
    startUpdateManager,
    stopUpdateManager,
    updateManager,

    // Live Cache (for display)
    getDashboard,
    getBlocks,
    getTipHeight,
    getMempool,
    getBlockReward,
    getLastUpdateTime,
    isCacheFresh,

    // Immutable Cache (tx/block by hash)
    getImmutable,
    setImmutable,

    // Statistics (SQLite - for charts)
    getDailyStats,
    getDailyTxCounts,
    getDailyBlockSizes,

    // Direct Electrs access (for fallback only)
    fetchFromElectrs,

    // Keys
    LIVE_KEYS
};
