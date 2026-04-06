const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// --- UTILITY: DEBUG LOGGING ---
function debugLog(category, message, isError = false) {
    const timestamp = new Date().toISOString();
    const logFunc = isError ? console.error : console.log;
    logFunc(`[${timestamp}] [${category.toUpperCase()}] ${message}`);
}

// --- FILE SYSTEM CONFIG ---
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');

const RENDER_DISK_PATH = '/var/data';
const DATA_DIR = fsSync.existsSync(RENDER_DISK_PATH) ? RENDER_DISK_PATH : path.join(__dirname, 'data');
if (!fsSync.existsSync(DATA_DIR)) fsSync.mkdirSync(DATA_DIR);

const HISTORICAL_SOL_PRICE_FILE = path.join(DATA_DIR, 'historical_sol_prices.json');
const CACHE_FILE = path.join(DATA_DIR, 'cache.json');

// --- CACHE TIMING ---
const DATA_REFRESH_MS = 2 * 60 * 60 * 1000;   // 2 hours: Burn + Wallet (heavy lift)
const PRICE_REFRESH_MS = 30 * 60 * 1000;       // 30 minutes: SOL + ASDF spot prices
const HISTORICAL_CACHE_MS = 6 * 60 * 60 * 1000; // 6 hours: CoinGecko historical prices

// --- CACHE STATE ---
let cache = {
    burn: {},
    wallet: {},
    prices: { tokenPriceUsd: 0, solPriceUsd: 0 },
    dataLastUpdated: 0,
    pricesLastUpdated: 0
};
let dataFetchInProgress = false;
let priceFetchInProgress = false;

// --- CONFIGURATION & VALIDATION ---
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const JUPITER_API_KEY = process.env.JUPITER_API_KEY || "";

if (!HELIUS_API_KEY) {
    debugLog("INIT", "FATAL: HELIUS_API_KEY environment variable is not set.", true);
    process.exit(1);
}

const TOKEN_MINT = "9zB5wRarXMj86MymwLumSKA1Dx35zPqqKfcZtK1Spump";
const TOKEN_TOTAL_SUPPLY = 1_000_000_000;
const TRACKED_WALLET = "vcGYZbvDid6cRUkCCqcWpBxow73TLpmY6ipmDUtrTF8";
const PURCHASE_SOURCE_ADDRESS = "DuhRX5JTPtsWU5n44t8tcFEfmzy2Eu27p4y6z8Rhf2bb";

const HELIUS_RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const HELIUS_ENHANCED_BASE = "https://api-mainnet.helius-rpc.com/v0";
const COINGECKO_DEMO_KEY = process.env.COINGECKO_API_KEY || "CG-KsYLbF8hxVytbPTNyLXe7vWA";
const COINGECKO_BASE = "https://api.coingecko.com/api/v3";
const JUP_PRICE_URL = "https://lite-api.jup.ag/price/v3";

// Middleware
app.use(cors());
app.use(express.json());

// --- DISK CACHE PERSISTENCE ---

async function saveCacheToDisk() {
    try {
        await fs.writeFile(CACHE_FILE, JSON.stringify(cache));
        debugLog("DISK_CACHE", "Cache persisted to disk.");
    } catch (e) {
        debugLog("DISK_CACHE", `Failed to persist cache: ${e.message}`, true);
    }
}

function loadCacheFromDisk() {
    try {
        if (!fsSync.existsSync(CACHE_FILE)) return false;
        const raw = fsSync.readFileSync(CACHE_FILE, 'utf8');
        const loaded = JSON.parse(raw);
        if (loaded && loaded.dataLastUpdated) {
            cache = loaded;
            debugLog("DISK_CACHE", `Cache restored from disk. Data age: ${((Date.now() - cache.dataLastUpdated) / 60000).toFixed(0)}min, Price age: ${((Date.now() - cache.pricesLastUpdated) / 60000).toFixed(0)}min`);
            return true;
        }
    } catch (e) {
        debugLog("DISK_CACHE", `Failed to load cache from disk: ${e.message}`, true);
    }
    return false;
}

// --- UTILITY: EXPONENTIAL BACKOFF FOR API CALLS ---
async function exponentialBackoffFetch(url, options = {}, maxRetries = 5, category = "API") {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const res = await fetch(url, options);
            if (res.ok) return res;

            if (res.status === 429 || res.status >= 500) {
                const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
                debugLog(category, `Attempt ${attempt + 1}: HTTP ${res.status}. Retrying in ${delay.toFixed(0)}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
            }
            throw new Error(`API failed with non-retryable status: ${res.status}`);

        } catch (error) {
            if (attempt === maxRetries - 1) {
                throw new Error(`API failed after ${maxRetries} attempts: ${error.message}`);
            }
            const delay = Math.pow(2, attempt) * 500 + Math.random() * 500;
            debugLog(category, `Attempt ${attempt + 1}: Network error (${error.message}). Retrying in ${delay.toFixed(0)}ms...`, true);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    throw new Error(`${category} failed after ${maxRetries} attempts.`);
}

// --- PRICE FETCHING ---

async function fetchCurrentSolPrice() {
    const url = `${COINGECKO_BASE}/simple/price?ids=solana&vs_currencies=usd&x_cg_demo_api_key=${COINGECKO_DEMO_KEY}`;
    const res = await exponentialBackoffFetch(url, {}, 5, "COINGECKO_SOL");
    const json = await res.json();
    const price = json?.solana?.usd || 0;
    if (price <= 0) throw new Error("SOL price not found or zero.");
    debugLog("COINGECKO_SOL", `Current SOL price: $${price.toFixed(2)}`);
    return price;
}

async function fetchJupiterTokenPrice(mint) {
    const jupUrl = `${JUP_PRICE_URL}?ids=${mint}`;
    const jupOptions = JUPITER_API_KEY ? { headers: { 'Authorization': `Bearer ${JUPITER_API_KEY}` } } : {};

    const jupRes = await exponentialBackoffFetch(jupUrl, jupOptions, 5, "JUPITER");
    const jupJson = await jupRes.json();

    const tokenPriceUsd = jupJson?.[mint]?.usdPrice || 0;
    if (tokenPriceUsd <= 0) throw new Error("ASDF price returned 0 or structure invalid.");
    debugLog("JUPITER", `ASDF price: $${tokenPriceUsd.toFixed(10)}`);
    return tokenPriceUsd;
}

// --- DATA FETCHING ---

async function fetchCurrentTokenSupplyUi() {
    const body = { jsonrpc: "2.0", id: "burn-supply", method: "getTokenSupply", params: [TOKEN_MINT] };
    const res = await exponentialBackoffFetch(HELIUS_RPC_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, 5, "HELIUS_RPC");
    const json = await res.json();
    const { uiAmount, uiAmountString } = json.result.value;
    return typeof uiAmount === "number" ? uiAmount : parseFloat(uiAmountString);
}

async function fetchAllEnhancedTransactions(address, maxPages = 20) {
    const all = [];
    let before = undefined;
    for (let page = 0; page < maxPages; page++) {
        const url = new URL(`${HELIUS_ENHANCED_BASE}/addresses/${address}/transactions`);
        url.searchParams.set("api-key", HELIUS_API_KEY);
        if (before) url.searchParams.set("before", before);

        const res = await exponentialBackoffFetch(url.toString(), {}, 5, "HELIUS_TXS");
        const batch = await res.json();

        if (!Array.isArray(batch) || batch.length === 0) break;
        all.push(...batch);

        const last = batch[batch.length - 1];
        if (!last || !last.signature || batch.length < 90) break;
        before = last.signature;
    }
    return all;
}

function extractSolReceipts(transactions, wallet) {
    const receipts = [];
    let totalLamports = 0n;
    for (const tx of transactions) {
        const ts = tx.timestamp;
        for (const nt of (tx.nativeTransfers || [])) {
            if (nt.toUserAccount !== wallet) continue;
            const rawAmt = nt.amount;
            if (rawAmt == null) continue;
            const lamports = BigInt(rawAmt.toString());
            if (lamports <= 0n) continue;
            totalLamports += lamports;
            receipts.push({ lamports: lamports.toString(), timestamp: ts });
        }
    }
    return { receipts, totalSol: Number(totalLamports) / 1e9 };
}

async function fetchSolHistoricalPrices(fromSec, toSec) {
    let cachedData = null;
    try {
        const stats = await fs.stat(HISTORICAL_SOL_PRICE_FILE);
        if (Date.now() - stats.mtimeMs < HISTORICAL_CACHE_MS) {
            const rawData = await fs.readFile(HISTORICAL_SOL_PRICE_FILE, 'utf8');
            cachedData = JSON.parse(rawData);
            debugLog("COINGECKO_CACHE", "Serving historical prices from disk cache.");
            return cachedData;
        }
    } catch (e) {
        // File doesn't exist or failed to parse
    }

    debugLog("COINGECKO_CACHE", "Fetching new historical prices from CoinGecko...");
    const from = Math.max(0, fromSec - 3600);
    const to = toSec + 3600;
    const url = new URL(`${COINGECKO_BASE}/coins/solana/market_chart/range`);
    url.searchParams.set("vs_currency", "usd");
    url.searchParams.set("from", String(from));
    url.searchParams.set("to", String(to));
    url.searchParams.set("x_cg_demo_api_key", COINGECKO_DEMO_KEY);

    try {
        const res = await exponentialBackoffFetch(url.toString(), {}, 5, "COINGECKO");
        const json = await res.json();
        const prices = json.prices.map(([tMs, price]) => ({ tMs: Number(tMs), priceUsd: Number(price) }));
        await fs.writeFile(HISTORICAL_SOL_PRICE_FILE, JSON.stringify(prices));
        debugLog("COINGECKO_CACHE", "Historical prices fetched and cached to disk.");
        return prices;
    } catch (e) {
        debugLog("COINGECKO", `Failed to fetch historical SOL prices: ${e.message}`, true);
        return cachedData || [];
    }
}

function computeLifetimeUsd(receipts, priceSeries) {
    if (!receipts.length || !priceSeries.length) return 0;
    let totalUsd = 0;
    const nearestPrice = (targetMs) => {
        let best = priceSeries[0].priceUsd;
        let bestDiff = Math.abs(targetMs - priceSeries[0].tMs);
        for (let i = 1; i < priceSeries.length; i++) {
            const diff = Math.abs(targetMs - priceSeries[i].tMs);
            if (diff < bestDiff) { bestDiff = diff; best = priceSeries[i].priceUsd; }
        }
        return best;
    };
    for (const r of receipts) {
        const tMs = r.timestamp * 1000;
        const solAmount = Number(r.lamports) / 1e9;
        totalUsd += solAmount * nearestPrice(tMs);
    }
    return totalUsd;
}

function computeTokenFlows(transactions, wallet, mint) {
    let purchasedFromSource = 0;
    for (const tx of transactions) {
        for (const tt of (tx.tokenTransfers || [])) {
            if (tt.mint !== mint || tt.toUserAccount !== wallet) continue;
            const amt = tt.tokenAmount == null ? 0 : Number(tt.tokenAmount);
            if (!Number.isFinite(amt) || amt <= 0) continue;
            if ((tt.fromUserAccount || "") === PURCHASE_SOURCE_ADDRESS) {
                purchasedFromSource += amt;
            }
        }
    }
    return { purchasedFromSource };
}


// --- CACHE REFRESH JOBS ---

async function refreshData() {
    if (dataFetchInProgress) {
        debugLog("CACHE_DATA", "Skipping: previous data fetch still in progress.");
        return;
    }
    dataFetchInProgress = true;
    debugLog("CACHE_DATA", "Starting data refresh (burn + wallet)...");

    try {
        // 1. Burn data
        const currentSupply = await fetchCurrentTokenSupplyUi();
        const burned = TOKEN_TOTAL_SUPPLY - currentSupply;
        const burnedPercent = (burned / TOKEN_TOTAL_SUPPLY) * 100;

        // 2. Wallet transaction history
        const txs = await fetchAllEnhancedTransactions(TRACKED_WALLET);
        const { receipts, totalSol } = extractSolReceipts(txs, TRACKED_WALLET);

        let lifetimeUsd = 0;
        if (receipts.length > 0) {
            const timestamps = receipts.map(r => r.timestamp);
            const prices = await fetchSolHistoricalPrices(Math.min(...timestamps), Math.max(...timestamps));
            lifetimeUsd = computeLifetimeUsd(receipts, prices);
        }

        const { purchasedFromSource } = computeTokenFlows(txs, TRACKED_WALLET, TOKEN_MINT);

        // 3. Store — prices are managed separately, never overwritten here
        cache.burn = { burnedAmount: burned, currentSupply, burnedPercent };
        cache.wallet = { ctoFeesSol: totalSol, ctoFeesUsd: lifetimeUsd, purchasedFromSource };
        cache.dataLastUpdated = Date.now();

        debugLog("CACHE_DATA", `Data refresh complete. Burned: ${burnedPercent.toFixed(2)}%, CTO Fees: ${totalSol.toFixed(2)} SOL`);
        await saveCacheToDisk();

    } catch (error) {
        debugLog("CACHE_DATA", `Data refresh failed: ${error.message}`, true);
        // Do NOT update dataLastUpdated on failure — stale data is better than no timestamp
    } finally {
        dataFetchInProgress = false;
    }
}

async function refreshPrices() {
    if (priceFetchInProgress) {
        debugLog("CACHE_PRICE", "Skipping: previous price fetch still in progress.");
        return;
    }
    priceFetchInProgress = true;
    debugLog("CACHE_PRICE", "Starting price refresh (SOL + ASDF)...");

    try {
        const [tokenPriceUsd, solPriceUsd] = await Promise.all([
            fetchJupiterTokenPrice(TOKEN_MINT).catch(e => {
                debugLog("JUPITER", `Price fetch failed: ${e.message}`, true);
                return cache.prices.tokenPriceUsd; // Keep previous on failure
            }),
            fetchCurrentSolPrice().catch(e => {
                debugLog("COINGECKO_SOL", `Price fetch failed: ${e.message}`, true);
                return cache.prices.solPriceUsd; // Keep previous on failure
            })
        ]);

        cache.prices = { tokenPriceUsd, solPriceUsd };
        cache.pricesLastUpdated = Date.now();

        debugLog("CACHE_PRICE", `Prices updated. ASDF: $${tokenPriceUsd.toFixed(10)}, SOL: $${solPriceUsd.toFixed(2)}`);
        await saveCacheToDisk();

    } catch (error) {
        debugLog("CACHE_PRICE", `Price refresh failed: ${error.message}`, true);
    } finally {
        priceFetchInProgress = false;
    }
}


// --- INITIALIZATION ---

async function initialize() {
    // Try to restore cache from disk first for instant availability
    const restored = loadCacheFromDisk();

    if (restored) {
        // Check if cached data is still fresh enough
        const dataAge = Date.now() - cache.dataLastUpdated;
        const priceAge = Date.now() - cache.pricesLastUpdated;

        if (dataAge > DATA_REFRESH_MS) {
            debugLog("INIT", "Disk cache data is stale, refreshing...");
            refreshData(); // Fire and forget — disk cache serves in the meantime
        } else {
            debugLog("INIT", `Disk cache data is fresh (${(dataAge / 60000).toFixed(0)}min old). Next refresh in ${((DATA_REFRESH_MS - dataAge) / 60000).toFixed(0)}min.`);
        }

        if (priceAge > PRICE_REFRESH_MS) {
            debugLog("INIT", "Disk cache prices are stale, refreshing...");
            refreshPrices();
        } else {
            debugLog("INIT", `Disk cache prices are fresh (${(priceAge / 60000).toFixed(0)}min old). Next refresh in ${((PRICE_REFRESH_MS - priceAge) / 60000).toFixed(0)}min.`);
        }
    } else {
        // No disk cache — must fetch everything
        debugLog("INIT", "No disk cache found. Fetching all data...");
        await refreshData();
        await refreshPrices();
    }

    // Schedule recurring refreshes
    setInterval(refreshData, DATA_REFRESH_MS);
    setInterval(refreshPrices, PRICE_REFRESH_MS);

    debugLog("INIT", `Scheduled: data every ${DATA_REFRESH_MS / 60000}min, prices every ${PRICE_REFRESH_MS / 60000}min.`);
}

initialize();


// --- API ROUTES ---

function checkCache(req, res, next) {
    if (cache.dataLastUpdated === 0) {
        return res.status(503).json({ error: "Service unavailable, initializing data cache." });
    }
    next();
}

app.get('/', (req, res) => {
    const dataAge = Date.now() - cache.dataLastUpdated;
    const priceAge = Date.now() - cache.pricesLastUpdated;
    res.json({
        status: 'ok',
        message: 'ASDF Tracker Backend is running.',
        dataAge: `${(dataAge / 1000).toFixed(0)}s`,
        priceAge: `${(priceAge / 1000).toFixed(0)}s`,
        nextDataRefresh: `${Math.max(0, (DATA_REFRESH_MS - dataAge) / 60000).toFixed(0)}min`,
        nextPriceRefresh: `${Math.max(0, (PRICE_REFRESH_MS - priceAge) / 60000).toFixed(0)}min`
    });
});

app.get('/api/burn', checkCache, (req, res) => {
    res.json({
        ...cache.burn,
        lastUpdated: cache.dataLastUpdated
    });
});

app.get('/api/wallet', checkCache, (req, res) => {
    res.json({
        ...cache.wallet,
        ...cache.prices,
        lastUpdated: Math.max(cache.dataLastUpdated, cache.pricesLastUpdated)
    });
});

app.listen(PORT, () => {
    debugLog("INIT", `Server running on port ${PORT}`);
});
