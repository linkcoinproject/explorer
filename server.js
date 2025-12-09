require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const pkg = require('./package.json');
const cache = require('./cache');

const app = express();

// Configuration from environment
const config = {
    port: process.env.PORT || 3000,
    electrsApi: process.env.ELECTRS_API || 'https://lnc-api.s3na.xyz',
    explorerName: process.env.EXPLORER_NAME || 'DedooExplorer',
    coinName: process.env.COIN_NAME || 'Coin',
    coinTicker: process.env.COIN_TICKER || 'COIN',
    coinTagline: process.env.COIN_TAGLINE || 'A blockchain explorer',
    logoUrl: process.env.LOGO_URL || '/img/logo.png',
    websiteUrl: process.env.WEBSITE_URL || '',
    githubUrl: process.env.GITHUB_URL || '',
    telegramUrl: process.env.TELEGRAM_URL || '',
    twitterUrl: process.env.TWITTER_URL || '',
    discordUrl: process.env.DISCORD_URL || '',
    // Mining/Consensus
    algorithm: process.env.ALGORITHM || 'SHA256',
    diffAdjustment: process.env.DIFF_ADJUSTMENT || 'DGW3',
    blockTime: parseInt(process.env.BLOCK_TIME) || 120,
    softwareName: pkg.name,
    version: pkg.version
};

const PORT = config.port;
const ELECTRS_API = config.electrsApi;

// Initialize cache with Electrs API URL and start Update Manager
cache.setElectrsApi(ELECTRS_API);
cache.initDatabase();
cache.startUpdateManager();

// View engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Make config available to all views
app.locals.config = config;

// Helper functions
const formatHash = (hash, length = 16) => {
    if (!hash) return '';
    return hash.length > length ? `${hash.slice(0, length / 2)}...${hash.slice(-length / 2)}` : hash;
};

const formatNumber = (num) => {
    if (num === undefined || num === null) return '0';
    return num.toLocaleString();
};

const formatBytes = (bytes) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

const formatTimeAgo = (timestamp) => {
    const now = Math.floor(Date.now() / 1000);
    const diff = now - timestamp;

    if (diff < 60) return `${diff} seconds ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)} minutes ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} hours ago`;
    return `${Math.floor(diff / 86400)} days ago`;
};

const formatDate = (timestamp) => {
    return new Date(timestamp * 1000).toLocaleString();
};

const formatHashrate = (hashrate) => {
    if (hashrate >= 1e18) return (hashrate / 1e18).toFixed(2) + ' EH/s';
    if (hashrate >= 1e15) return (hashrate / 1e15).toFixed(2) + ' PH/s';
    if (hashrate >= 1e12) return (hashrate / 1e12).toFixed(2) + ' TH/s';
    if (hashrate >= 1e9) return (hashrate / 1e9).toFixed(2) + ' GH/s';
    if (hashrate >= 1e6) return (hashrate / 1e6).toFixed(2) + ' MH/s';
    if (hashrate >= 1e3) return (hashrate / 1e3).toFixed(2) + ' KH/s';
    return hashrate.toFixed(2) + ' H/s';
};

const formatDifficulty = (diff) => {
    if (diff >= 1e12) return (diff / 1e12).toFixed(2) + 'T';
    if (diff >= 1e9) return (diff / 1e9).toFixed(2) + 'B';
    if (diff >= 1e6) return (diff / 1e6).toFixed(2) + 'M';
    if (diff >= 1e3) return (diff / 1e3).toFixed(2) + 'K';
    return diff.toFixed(2);
};

// Make helpers available to all views
app.locals.formatHash = formatHash;
app.locals.formatNumber = formatNumber;
app.locals.formatBytes = formatBytes;
app.locals.formatTimeAgo = formatTimeAgo;
app.locals.formatDate = formatDate;
app.locals.formatHashrate = formatHashrate;
app.locals.formatDifficulty = formatDifficulty;

// API helper - for detail pages that need fresh data or data not in cache
// User actions should NOT trigger API calls for live data (use cache instead)
const fetchFromElectrs = async (endpoint) => {
    // First check immutable cache for tx/block details
    const cacheKey = endpoint;
    const cached = cache.getImmutable(cacheKey);
    if (cached !== undefined) {
        return cached;
    }

    // Fetch from Electrs
    const data = await cache.fetchFromElectrs(endpoint);

    // Cache immutable data (tx/block by hash)
    if (endpoint.match(/^\/(tx|block)\/[a-f0-9]{64}/)) {
        cache.setImmutable(cacheKey, data);
    }

    return data;
};

// ============ PAGES ============

// Dashboard - reads from cache (Update Manager keeps it fresh)
app.get('/', async (req, res) => {
    try {
        // Get data from cache (populated by Update Manager)
        let dashboardData = cache.getDashboard();

        // Fallback if cache empty (first load before Update Manager runs)
        if (!dashboardData) {
            console.log('[Dashboard] Cache empty, forcing update...');
            await cache.updateManager();
            dashboardData = cache.getDashboard();
        }

        // Still no data? Use emergency fallback
        if (!dashboardData) {
            const blocks = await cache.fetchFromElectrs('/blocks');
            const tipHeight = await cache.fetchFromElectrs('/blocks/tip/height');
            dashboardData = {
                tipHeight,
                hashrate: 0,
                avgBlockTime: 120,
                mempoolCount: 0,
                difficulty: blocks[0]?.difficulty || 0,
                supply: 0,
                blockReward: 0,
                blocks: blocks.slice(0, 15)
            };
        }

        res.render('index', {
            title: 'Dashboard',
            blocks: dashboardData.blocks,
            tipHeight: dashboardData.tipHeight,
            mempoolCount: dashboardData.mempoolCount,
            difficulty: dashboardData.difficulty,
            avgBlockTime: dashboardData.avgBlockTime,
            hashrate: dashboardData.hashrate,
            supply: dashboardData.supply,
            blockReward: dashboardData.blockReward,
            page: 'dashboard'
        });
    } catch (error) {
        res.render('error', { title: 'Error', message: 'Failed to load dashboard', error: error.message, page: 'error' });
    }
});

// Blocks list - page 1 from cache, other pages from Electrs
app.get('/blocks', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        let blocks, tipHeight;

        // Page 1: use cache if available
        if (page === 1) {
            blocks = cache.getBlocks();
            tipHeight = cache.getTipHeight();
        }

        // Fallback or other pages: fetch from Electrs
        if (!blocks || !tipHeight) {
            tipHeight = await fetchFromElectrs('/blocks/tip/height');
            const startHeight = tipHeight - ((page - 1) * 25);
            blocks = await fetchFromElectrs(`/blocks/${startHeight}`);
        }

        const totalPages = Math.ceil((tipHeight + 1) / 25);

        res.render('blocks', {
            title: 'Blocks',
            blocks,
            currentPage: page,
            totalPages,
            tipHeight,
            page: 'blocks'
        });
    } catch (error) {
        res.render('error', { title: 'Error', message: 'Failed to load blocks', error: error.message, page: 'error' });
    }
});

// Block detail
app.get('/block/:hash', async (req, res) => {
    try {
        const { hash } = req.params;
        const txPage = parseInt(req.query.txPage) || 0;

        const [block, transactions] = await Promise.all([
            fetchFromElectrs(`/block/${hash}`),
            fetchFromElectrs(`/block/${hash}/txs/${txPage * 25}`)
        ]);

        // Get previous and next block hashes
        let prevBlock = null, nextBlock = null;
        if (block.previousblockhash) {
            prevBlock = block.previousblockhash;
        }
        // Try to get next block
        try {
            const nextBlockHash = await fetchFromElectrs(`/block-height/${block.height + 1}`);
            nextBlock = nextBlockHash;
        } catch (e) {
            // No next block
        }

        const totalTxPages = Math.ceil(block.tx_count / 25);

        res.render('block', {
            title: `Block ${block.height}`,
            block,
            transactions,
            txPage,
            totalTxPages,
            prevBlock,
            nextBlock,
            page: 'blocks'
        });
    } catch (error) {
        res.render('error', { title: 'Error', message: 'Block not found', error: error.message, page: 'error' });
    }
});

// Transactions list (mempool + recent)
app.get('/transactions', async (req, res) => {
    try {
        const mempool = await fetchFromElectrs('/mempool/recent').catch(() => []);

        // Get recent confirmed transactions from latest blocks
        const blocks = await fetchFromElectrs('/blocks');
        let recentTxs = [];

        for (const block of blocks.slice(0, 5)) {
            try {
                const txs = await fetchFromElectrs(`/block/${block.id}/txs/0`);
                recentTxs = recentTxs.concat(txs.map(tx => ({
                    ...tx,
                    block_height: block.height,
                    block_time: block.timestamp
                })));
                if (recentTxs.length >= 25) break;
            } catch (e) {
                continue;
            }
        }

        res.render('transactions', {
            title: 'Transactions',
            mempool,
            recentTxs: recentTxs.slice(0, 25),
            page: 'transactions'
        });
    } catch (error) {
        res.render('error', { title: 'Error', message: 'Failed to load transactions', error: error.message, page: 'error' });
    }
});

// Transaction detail
app.get('/tx/:txid', async (req, res) => {
    try {
        const { txid } = req.params;
        const tx = await fetchFromElectrs(`/tx/${txid}`);

        // Calculate totals
        let totalInput = 0, totalOutput = 0;
        tx.vin.forEach(vin => {
            if (vin.prevout && vin.prevout.value) {
                totalInput += vin.prevout.value;
            }
        });
        tx.vout.forEach(vout => {
            totalOutput += vout.value || 0;
        });

        res.render('transaction', {
            title: `Transaction ${formatHash(txid)}`,
            tx,
            totalInput,
            totalOutput,
            page: 'transactions'
        });
    } catch (error) {
        res.render('error', { title: 'Error', message: 'Transaction not found', error: error.message, page: 'error' });
    }
});

// Address detail
app.get('/address/:address', async (req, res) => {
    try {
        const { address } = req.params;
        const page = parseInt(req.query.page) || 0;
        const utxoPage = parseInt(req.query.utxo_page) || 0;

        // Fetch address info and transactions
        const [addressInfo, txsData] = await Promise.all([
            fetchFromElectrs(`/address/${address}`),
            fetchFromElectrs(`/address/${address}/txs?start_index=${page * 25}&limit=25`)
        ]);

        // Fetch UTXOs with pagination (separate try-catch for graceful degradation)
        let utxos = [];
        let totalUtxos = 0;
        let utxoError = null;
        try {
            const utxoData = await fetchFromElectrs(`/address/${address}/utxo?start_index=${utxoPage * 25}&limit=25`);
            utxos = utxoData.utxos || utxoData || [];
            totalUtxos = utxoData.total || utxos.length;
        } catch (err) {
            utxoError = err.message;
            // If UTXOs fail, still show address with empty UTXOs
        }

        // Handle different response formats
        const transactions = txsData.transactions || txsData;
        const totalTxs = txsData.total || addressInfo.chain_stats?.tx_count || 0;

        // Calculate balance
        const chainStats = addressInfo.chain_stats || {};
        const mempoolStats = addressInfo.mempool_stats || {};
        const confirmedBalance = (chainStats.funded_txo_sum || 0) - (chainStats.spent_txo_sum || 0);
        const pendingBalance = (mempoolStats.funded_txo_sum || 0) - (mempoolStats.spent_txo_sum || 0);

        res.render('address', {
            title: `Address ${formatHash(address)}`,
            address,
            addressInfo,
            transactions,
            utxos,
            totalUtxos,
            utxoPage,
            utxoError,
            confirmedBalance,
            pendingBalance,
            totalTxs,
            currentPage: page,
            totalPages: Math.ceil(totalTxs / 25),
            page: 'address'
        });
    } catch (error) {
        res.render('error', { title: 'Error', message: 'Address not found', error: error.message, page: 'error' });
    }
});

// Statistics page
app.get('/statistics', async (req, res) => {
    try {
        // Get live data from cache
        const dashboardData = cache.getDashboard();

        // Use cache data or defaults
        const tipHeight = dashboardData?.tipHeight || 0;
        const avgBlockTime = dashboardData?.avgBlockTime || 120;
        const hashrate = dashboardData?.hashrate || 0;
        const difficulty = dashboardData?.difficulty || 0;
        const blockReward = dashboardData?.blockReward || cache.getBlockReward() || 0;

        res.render('statistics', {
            title: 'Statistics',
            tipHeight,
            avgBlockTime,
            hashrate,
            difficulty,
            blockReward,
            page: 'statistics'
        });
    } catch (error) {
        res.render('error', { title: 'Error', message: 'Failed to load statistics', error: error.message, page: 'error' });
    }
});

// Search handler
app.get('/search', async (req, res) => {
    const query = req.query.q?.trim();

    if (!query) {
        return res.redirect('/');
    }

    // Check if it's a block height (number only)
    if (/^\d+$/.test(query)) {
        try {
            const blockHash = await fetchFromElectrs(`/block-height/${query}`);
            return res.redirect(`/block/${blockHash}`);
        } catch (e) {
            // Not a valid block height
        }
    }

    // Check if it's a block hash (64 hex chars)
    if (/^[a-fA-F0-9]{64}$/.test(query)) {
        try {
            await fetchFromElectrs(`/block/${query}`);
            return res.redirect(`/block/${query}`);
        } catch (e) {
            // Try as transaction
            try {
                await fetchFromElectrs(`/tx/${query}`);
                return res.redirect(`/tx/${query}`);
            } catch (e2) {
                // Not found
            }
        }
    }

    // Try as address
    try {
        await fetchFromElectrs(`/address/${query}`);
        return res.redirect(`/address/${query}`);
    } catch (e) {
        // Not found
    }

    res.render('error', {
        title: 'Not Found',
        message: 'No results found',
        error: `Could not find block, transaction, or address matching: ${query}`,
        page: 'search'
    });
});

// ============ LIVE DATA API ============

// GET /api/dashboard - Get live dashboard data FROM CACHE (no Electrs call)
app.get('/api/dashboard', async (req, res) => {
    try {
        // Read from cache (populated by Update Manager every 10s)
        let dashboardData = cache.getDashboard();

        // Fallback if cache empty
        if (!dashboardData) {
            await cache.updateManager();
            dashboardData = cache.getDashboard();
        }

        if (!dashboardData) {
            return res.status(503).json({ error: 'Data not ready, please wait...' });
        }

        res.json({
            tipHeight: dashboardData.tipHeight,
            hashrate: dashboardData.hashrate,
            avgBlockTime: dashboardData.avgBlockTime,
            mempoolCount: dashboardData.mempoolCount,
            difficulty: dashboardData.difficulty,
            supply: dashboardData.supply,
            blockReward: dashboardData.blockReward,
            blocks: dashboardData.blocks,
            updatedAt: dashboardData.updatedAt,
            isFresh: cache.isCacheFresh()
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /api/blocks/recent - Get recent blocks FROM CACHE
app.get('/api/blocks/recent', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;

        // For page 1, use cache
        if (page === 1) {
            const blocks = cache.getBlocks();
            const tipHeight = cache.getTipHeight();

            if (blocks && tipHeight) {
                return res.json({
                    blocks: blocks.slice(0, 25),
                    tipHeight,
                    currentPage: 1,
                    totalPages: Math.ceil((tipHeight + 1) / 25),
                    isFresh: cache.isCacheFresh()
                });
            }
        }

        // For other pages or if cache empty, fetch from Electrs
        const tipHeight = await fetchFromElectrs('/blocks/tip/height');
        const startHeight = tipHeight - ((page - 1) * 25);
        const blocks = await fetchFromElectrs(`/blocks/${startHeight}`);

        res.json({
            blocks,
            tipHeight,
            currentPage: page,
            totalPages: Math.ceil((tipHeight + 1) / 25)
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============ STATS API ============

// GET /api/stats/daily-tx - Get daily transaction counts
app.get('/api/stats/daily-tx', (req, res) => {
    const days = Math.min(parseInt(req.query.days) || 7, 90);
    const data = cache.getDailyTxCounts(days);
    res.json(data);
});

// GET /api/stats/block-size - Get daily average block sizes
app.get('/api/stats/block-size', (req, res) => {
    const days = Math.min(parseInt(req.query.days) || 7, 90);
    const data = cache.getDailyBlockSizes(days);
    res.json(data);
});

// GET /api/stats/block-reward - Get current block reward
app.get('/api/stats/block-reward', async (req, res) => {
    try {
        let reward = cache.getLatestBlockReward();
        if (!reward) {
            // Fetch from latest block
            const blocks = await fetchFromElectrs('/blocks');
            if (blocks && blocks[0]) {
                reward = await getBlockReward(blocks[0].id);
            }
        }
        res.json({
            reward: reward || 0,
            rewardCoins: reward ? (reward / 100000000).toFixed(8) : '0'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /api/stats/daily - Get all daily stats
app.get('/api/stats/daily', (req, res) => {
    const days = Math.min(parseInt(req.query.days) || 7, 90);
    const data = cache.getDailyStats(days);
    res.json(data);
});

// GET /api/stats/cache-info - Get cache statistics
app.get('/api/stats/cache-info', (req, res) => {
    res.json(cache.getCacheInfo());
});

// ============ PUBLIC API ============

// GET /api/getdifficulty - Returns current difficulty
app.get('/api/getdifficulty', async (req, res) => {
    try {
        const blocks = await fetchFromElectrs('/blocks');
        const difficulty = blocks[0]?.difficulty || 0;
        res.send(difficulty.toString());
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /api/getblockcount - Returns current block height
app.get('/api/getblockcount', async (req, res) => {
    try {
        const height = await fetchFromElectrs('/blocks/tip/height');
        res.send(height.toString());
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /api/getblockhash?index=N - Returns block hash at height N
app.get('/api/getblockhash', async (req, res) => {
    try {
        const index = req.query.index;
        if (!index) {
            return res.status(400).json({ error: 'index parameter required' });
        }
        const hash = await fetchFromElectrs(`/block-height/${index}`);
        res.send(hash);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /api/getblock?hash=X - Returns block information
app.get('/api/getblock', async (req, res) => {
    try {
        const hash = req.query.hash;
        if (!hash) {
            return res.status(400).json({ error: 'hash parameter required' });
        }
        const block = await fetchFromElectrs(`/block/${hash}`);

        // Get previous block hash
        let previousblockhash = null;
        if (block.height > 0) {
            try {
                previousblockhash = await fetchFromElectrs(`/block-height/${block.height - 1}`);
            } catch (e) { }
        }

        // Get next block hash
        let nextblockhash = null;
        try {
            nextblockhash = await fetchFromElectrs(`/block-height/${block.height + 1}`);
        } catch (e) { }

        // Get transaction IDs
        const txs = await fetchFromElectrs(`/block/${hash}/txids`);

        res.json({
            hash: block.id,
            confirmations: block.confirmations || 1,
            strippedsize: block.size,
            size: block.size,
            weight: block.weight,
            height: block.height,
            version: block.version,
            versionHex: block.version?.toString(16).padStart(8, '0'),
            merkleroot: block.merkle_root,
            tx: txs,
            time: block.timestamp,
            mediantime: block.mediantime || block.timestamp,
            nonce: block.nonce,
            bits: block.bits?.toString(16),
            difficulty: block.difficulty,
            previousblockhash,
            nextblockhash
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /api/getrawtransaction?txid=X&decrypt=0|1 - Returns raw or decoded transaction
app.get('/api/getrawtransaction', async (req, res) => {
    try {
        const { txid, decrypt } = req.query;
        if (!txid) {
            return res.status(400).json({ error: 'txid parameter required' });
        }

        if (decrypt === '0' || !decrypt) {
            // Return raw hex
            const hex = await fetchFromElectrs(`/tx/${txid}/hex`);
            res.send(hex);
        } else {
            // Return decoded transaction
            const tx = await fetchFromElectrs(`/tx/${txid}`);
            res.json({
                hex: tx.hex || '',
                txid: tx.txid,
                hash: tx.txid,
                size: tx.size,
                vsize: tx.weight ? Math.ceil(tx.weight / 4) : tx.size,
                version: tx.version,
                locktime: tx.locktime,
                vin: tx.vin.map(vin => ({
                    txid: vin.txid,
                    vout: vin.vout,
                    scriptSig: vin.scriptsig ? { hex: vin.scriptsig } : undefined,
                    coinbase: vin.is_coinbase ? vin.scriptsig : undefined,
                    sequence: vin.sequence
                })),
                vout: tx.vout.map(vout => ({
                    value: vout.value / 1e8,
                    n: vout.n,
                    scriptPubKey: {
                        hex: vout.scriptpubkey,
                        type: vout.scriptpubkey_type,
                        addresses: vout.scriptpubkey_address ? [vout.scriptpubkey_address] : []
                    }
                })),
                blockhash: tx.status?.block_hash,
                confirmations: tx.status?.confirmed ? 1 : 0,
                time: tx.status?.block_time,
                blocktime: tx.status?.block_time
            });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /api/getnetworkhashps - Returns estimated network hashrate
app.get('/api/getnetworkhashps', async (req, res) => {
    try {
        const blocks = await fetchFromElectrs('/blocks');
        const difficulty = blocks[0]?.difficulty || 0;
        // Estimate hashrate: difficulty * 2^32 / block_time
        const avgBlockTime = blocks.length > 1
            ? (blocks[0].timestamp - blocks[blocks.length - 1].timestamp) / (blocks.length - 1)
            : config.blockTime;
        const hashrate = Math.round((difficulty * Math.pow(2, 32)) / avgBlockTime);
        res.send(hashrate.toString());
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============ EXTENDED API ============

// GET /ext/getmoneysupply - Returns current money supply
app.get('/ext/getmoneysupply', async (req, res) => {
    try {
        const supplyData = await fetchFromElectrs('/blockchain/getsupply');
        const supply = supplyData.total_amount_float || supplyData.total_amount / 1e8 || 0;
        res.send(supply.toString());
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /ext/getaddress/:hash - Returns address information
app.get('/ext/getaddress/:hash', async (req, res) => {
    try {
        const { hash } = req.params;
        const [addressInfo, txsData] = await Promise.all([
            fetchFromElectrs(`/address/${hash}`),
            fetchFromElectrs(`/address/${hash}/txs`)
        ]);

        const chainStats = addressInfo.chain_stats || {};
        const received = (chainStats.funded_txo_sum || 0) / 1e8;
        const sent = (chainStats.spent_txo_sum || 0) / 1e8;
        const balance = received - sent;

        // Format last transactions
        const lastTxs = txsData.slice(0, 100).map(tx => ({
            addresses: tx.txid,
            type: tx.vin?.some(vin => vin.prevout?.scriptpubkey_address === hash) ? 'vin' : 'vout'
        }));

        res.json({
            address: hash,
            sent: sent,
            received: received,
            balance: balance.toFixed(8),
            last_txs: lastTxs
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /ext/getaddresstxs/:hash/:start/:length - Returns paginated transactions for address
app.get('/ext/getaddresstxs/:hash/:start/:length', async (req, res) => {
    try {
        const { hash, start, length } = req.params;
        const startIdx = parseInt(start) || 0;
        const limit = Math.min(parseInt(length) || 50, 100);

        const [addressInfo, txsData] = await Promise.all([
            fetchFromElectrs(`/address/${hash}`),
            fetchFromElectrs(`/address/${hash}/txs?start_index=${startIdx}&limit=${limit}`)
        ]);

        const txs = (txsData.transactions || txsData).slice(0, limit);
        const chainStats = addressInfo.chain_stats || {};
        let runningBalance = ((chainStats.funded_txo_sum || 0) - (chainStats.spent_txo_sum || 0)) / 1e8;

        const result = txs.map(tx => {
            let sent = 0, received = 0;

            // Calculate sent/received for this address
            tx.vin?.forEach(vin => {
                if (vin.prevout?.scriptpubkey_address === hash) {
                    sent += (vin.prevout.value || 0) / 1e8;
                }
            });
            tx.vout?.forEach(vout => {
                if (vout.scriptpubkey_address === hash) {
                    received += (vout.value || 0) / 1e8;
                }
            });

            const txBalance = runningBalance;
            runningBalance -= (received - sent);

            return {
                timestamp: tx.status?.block_time || 0,
                txid: tx.txid,
                sent: sent,
                received: received,
                balance: txBalance
            };
        });

        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /ext/gettx/:hash - Returns transaction information
app.get('/ext/gettx/:hash', async (req, res) => {
    try {
        const { hash } = req.params;
        const [tx, tipHeight] = await Promise.all([
            fetchFromElectrs(`/tx/${hash}`),
            fetchFromElectrs('/blocks/tip/height')
        ]);

        const confirmations = tx.status?.confirmed
            ? tipHeight - tx.status.block_height + 1
            : 0;

        // Format vin/vout
        const vin = tx.vin.map(v => ({
            addresses: v.is_coinbase ? 'coinbase' : (v.prevout?.scriptpubkey_address || 'unknown'),
            amount: v.is_coinbase ? 0 : (v.prevout?.value || 0)
        }));

        const vout = tx.vout.map(v => ({
            addresses: v.scriptpubkey_address || 'unknown',
            amount: v.value || 0
        }));

        const total = tx.vout.reduce((sum, v) => sum + (v.value || 0), 0);

        res.json({
            active: 'tx',
            tx: {
                txid: tx.txid,
                vin,
                vout,
                total,
                timestamp: tx.status?.block_time || 0,
                blockhash: tx.status?.block_hash || null,
                blockindex: tx.status?.block_height || null
            },
            confirmations,
            blockcount: tipHeight
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /ext/getbalance/:hash - Returns address balance
app.get('/ext/getbalance/:hash', async (req, res) => {
    try {
        const { hash } = req.params;
        const addressInfo = await fetchFromElectrs(`/address/${hash}`);

        const chainStats = addressInfo.chain_stats || {};
        const balance = ((chainStats.funded_txo_sum || 0) - (chainStats.spent_txo_sum || 0)) / 1e8;

        res.send(balance.toString());
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /ext/getlasttxs/:min/:start/:length - Returns recent large transactions
app.get('/ext/getlasttxs/:min/:start/:length', async (req, res) => {
    try {
        const { min, start, length } = req.params;
        const minAmount = (parseFloat(min) || 0) * 1e8;
        const startIdx = parseInt(start) || 0;
        const limit = Math.min(parseInt(length) || 100, 100);

        // Get recent blocks and their transactions
        const blocks = await fetchFromElectrs('/blocks');
        const result = [];

        for (const block of blocks) {
            if (result.length >= startIdx + limit) break;

            try {
                const txs = await fetchFromElectrs(`/block/${block.id}/txs/0`);
                for (const tx of txs) {
                    const total = tx.vout.reduce((sum, v) => sum + (v.value || 0), 0);
                    if (total >= minAmount) {
                        result.push({
                            blockindex: block.height,
                            blockhash: block.id,
                            txid: tx.txid,
                            recipients: tx.vout.length,
                            amount: total / 1e8,
                            timestamp: block.timestamp
                        });
                    }
                }
            } catch (e) {
                continue;
            }
        }

        res.json(result.slice(startIdx, startIdx + limit));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /ext/getbasicstats - Returns basic coin statistics
app.get('/ext/getbasicstats', async (req, res) => {
    try {
        const [tipHeight, supplyData] = await Promise.all([
            fetchFromElectrs('/blocks/tip/height'),
            fetchFromElectrs('/blockchain/getsupply').catch(() => ({ total_amount_float: 0 }))
        ]);

        res.json({
            block_count: tipHeight,
            money_supply: supplyData.total_amount_float || supplyData.total_amount / 1e8 || 0
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /ext/getsummary - Returns network summary
app.get('/ext/getsummary', async (req, res) => {
    try {
        const [blocks, tipHeight, supplyData] = await Promise.all([
            fetchFromElectrs('/blocks'),
            fetchFromElectrs('/blocks/tip/height'),
            fetchFromElectrs('/blockchain/getsupply').catch(() => ({ total_amount_float: 0 }))
        ]);

        const difficulty = blocks[0]?.difficulty || 0;
        const avgBlockTime = blocks.length > 1
            ? (blocks[0].timestamp - blocks[blocks.length - 1].timestamp) / (blocks.length - 1)
            : config.blockTime;
        const hashrate = (difficulty * Math.pow(2, 32)) / avgBlockTime;

        res.json({
            difficulty,
            supply: supplyData.total_amount_float || supplyData.total_amount / 1e8 || 0,
            hashrate: formatHashrate(hashrate),
            blockcount: tipHeight
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /info - API documentation page
app.get('/info', (req, res) => {
    res.render('info', {
        title: 'Public API',
        page: 'info'
    });
});

// ============ FALLBACK API PROXY ============

app.get('/api/*', async (req, res) => {
    try {
        const endpoint = req.path.replace('/api', '');
        const data = await fetchFromElectrs(endpoint);
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Error handler
app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).render('error', {
        title: 'Error',
        message: 'Internal Server Error',
        error: err.message,
        page: 'error'
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 ${config.explorerName} running at http://localhost:${PORT}`);
    console.log(`📡 Connected to electrs at ${ELECTRS_API}`);
});
