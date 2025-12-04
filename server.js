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

// --- FILE SYSTEM CONFIG (Needed for Historical Cache) ---
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');

const RENDER_DISK_PATH = '/var/data';
const DATA_DIR = fsSync.existsSync(RENDER_DISK_PATH) ? RENDER_DISK_PATH : path.join(__dirname, 'data');
if (!fsSync.existsSync(DATA_DIR)) fsSync.mkdirSync(DATA_DIR);

const HISTORICAL_SOL_PRICE_FILE = path.join(DATA_DIR, 'historical_sol_prices.json');
const HISTORICAL_CACHE_DURATION_MS = 6 * 60 * 60 * 1000; // 6 hours

// --- CACHING VARIABLES ---
let cache = { 
    burn: {}, 
    wallet: { tokenPriceUsd: 0, solPriceUsd: 0 }, 
    forecast: { totalVolume: 0, totalFees: 0, totalWinnings: 0, totalLifetimeUsers: 0 }, 
    lastUpdated: 0 
};
const FAST_CACHE_MS = 60000; // 1 minute: Burn/Wallet/Forecast Stats
const SLOW_CACHE_MS = 10 * 60000; // 10 minutes: Price Updates (SOL & ASDF)
let cacheCycleCount = 0; // Tracks cycles for the 10-minute check

// --- CONFIGURATION & VALIDATION ---
const HELIUS_API_KEY = process.env.HELIUS_API_KEY; 
const JUPITER_API_KEY = process.env.JUPITER_API_KEY || ""; 
const ASDFORECAST_API_URL = "https://asdforecast.onrender.com"; 

if (!HELIUS_API_KEY) {
    debugLog("INIT", "FATAL: HELIUS_API_KEY environment variable is not set.", true);
    process.exit(1); 
}

const TOKEN_MINT = "9zB5wRarXMj86MymwLumSKA1Dx35zPqqKfcZtK1Spump"; // ASDF Contract Address
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

// --- UTILITY: EXPONENTIAL BACKOFF FOR API CALLS ---
async function exponentialBackoffFetch(url, options = {}, maxRetries = 5, category = "API") {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const res = await fetch(url, options);
            if (res.ok) return res;

            if (res.status === 429 || res.status >= 500) {
                const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
                debugLog(category, `Attempt ${attempt + 1}: Received HTTP ${res.status}. Retrying in ${delay.toFixed(0)}ms...`);
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
}

// --- PRICE FETCHING LOGIC ---

async function fetchCurrentSolPrice() {
    try {
        const url = `${COINGECKO_BASE}/simple/price?ids=solana&vs_currencies=usd&x_cg_demo_api_key=${COINGECKO_DEMO_KEY}`;
        const res = await exponentialBackoffFetch(url, {}, 5, "COINGECKO_SOL");
        const json = await res.json();
        const price = json?.solana?.usd || 0;

        if (price > 0) {
            debugLog("COINGECKO_SOL", `Current SOL price fetched: $${price.toFixed(2)}`);
            return price;
        }
        throw new Error("SOL price not found or zero.");
    } catch (e) {
        debugLog("COINGECKO_SOL", `Failed to fetch SOL price: ${e.message}`, true);
        return 0;
    }
}

async function fetchJupiterTokenPrice(mint) {
    let tokenPriceUsd = 0;
    let jupUrl = `${JUP_PRICE_URL}?ids=${mint}`;
    debugLog("JUPITER", `Requesting Jupiter URL: ${jupUrl}`);
    
    const jupOptions = JUPITER_API_KEY ? { headers: { 'Authorization': `Bearer ${JUPITER_API_KEY}` } } : {};

    try {
        const jupRes = await exponentialBackoffFetch(jupUrl, jupOptions, 5, "JUPITER"); 
        const jupJson = await jupRes.json();
        
        const tokenData = jupJson?.[mint];
        tokenPriceUsd = tokenData?.usdPrice || 0;
        
        if (tokenPriceUsd > 0) {
            debugLog("JUPITER", `Price successfully fetched for ${mint}: $${tokenPriceUsd.toFixed(10)}`);
        } else {
            debugLog("JUPITER", `Price returned 0 or structure invalid.`, true);
        }

    } catch (e) { 
        debugLog("JUPITER", `Failed to update price: ${e.message}`, true);
    }
    return tokenPriceUsd;
}

// --- LOGIC FUNCTIONS (Unchanged helper functions omitted for brevity) ---
async function fetchCurrentTokenSupplyUi() {
    const body = { jsonrpc: "2.0", id: "burn-supply", method: "getTokenSupply", params: [TOKEN_MINT] };
    const res = await exponentialBackoffFetch(HELIUS_RPC_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, 5, "HELIUS_RPC");
    const json = await res.json();
    const { uiAmount, uiAmountString } = json.result.value;
    return typeof uiAmount === "number" ? uiAmount : parseFloat(uiAmountString);
}

async function fetchAllEnhancedTransactions(address, maxPages = 20) {
    const all = []; let before = undefined;
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
    const receipts = []; let totalLamports = 0n;
    for (const tx of transactions) {
        const ts = tx.timestamp; const transfers = tx.nativeTransfers || [];
        for (const nt of transfers) {
            if (nt.toUserAccount !== wallet) continue;
            const rawAmt = nt.amount; if (rawAmt == null) continue;
            const lamports = BigInt(rawAmt.toString()); if (lamports <= 0n) continue;
            totalLamports += lamports;
            receipts.push({ lamports: lamports.toString(), timestamp: ts });
        }
    }
    const totalSol = Number(totalLamports) / 1e9;
    return { receipts, totalSol };
}

async function fetchSolHistoricalPrices(fromSec, toSec) {
    let cachedData = null;
    try {
        const stats = await fs.stat(HISTORICAL_SOL_PRICE_FILE);
        if (Date.now() - stats.mtimeMs < HISTORICAL_CACHE_DURATION_MS) {
            const rawData = await fs.readFile(HISTORICAL_SOL_PRICE_FILE, 'utf8');
            cachedData = JSON.parse(rawData);
            debugLog("COINGECKO_CACHE", "Serving historical prices from local cache.");
            return cachedData;
        }
    } catch (e) {
        // File doesn't exist or failed to parse, proceed to fetch
    }

    debugLog("COINGECKO_CACHE", "Fetching new historical prices from CoinGecko...");
    const from = Math.max(0, fromSec - 3600); const to = toSec + 3600;
    const url = new URL(`${COINGECKO_BASE}/coins/solana/market_chart/range`);
    url.searchParams.set("vs_currency", "usd"); url.searchParams.set("from", String(from)); url.searchParams.set("to", String(to));
    url.searchParams.set("x_cg_demo_api_key", COINGECKO_DEMO_KEY);

    try {
        const res = await exponentialBackoffFetch(url.toString(), {}, 5, "COINGECKO");
        const json = await res.json();
        const prices = json.prices.map(([tMs, price]) => ({ tMs: Number(tMs), priceUsd: Number(price) }));
        
        await fs.writeFile(HISTORICAL_SOL_PRICE_FILE, JSON.stringify(prices));
        debugLog("COINGECKO_CACHE", "Successfully fetched and cached new historical prices.");
        return prices;
    } catch(e) {
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
        const priceUsd = nearestPrice(tMs);
        const solAmount = Number(r.lamports) / 1e9;
        totalUsd += solAmount * priceUsd;
    }
    return totalUsd;
}

function computeTokenFlows(transactions, wallet, mint) {
    let purchasedFromSource = 0;
    for (const tx of transactions) {
        const tokenTransfers = tx.tokenTransfers || [];
        for (const tt of tokenTransfers) {
            if (tt.mint !== mint) continue;
            if (tt.toUserAccount !== wallet) continue;
            const rawAmt = tt.tokenAmount;
            const amt = rawAmt == null ? 0 : Number(rawAmt);
            if (!Number.isFinite(amt) || amt <= 0) continue;
            if ((tt.fromUserAccount || "") === PURCHASE_SOURCE_ADDRESS) {
                purchasedFromSource += amt;
            }
        }
    }
    return { purchasedFromSource };
}

async function fetchASDForecastStats() {
    try {
        const statsUrl = `${ASDFORECAST_API_URL}/api/state`; 
        debugLog("FORECAST_API", `Fetching stats from: ${statsUrl}`);

        const res = await exponentialBackoffFetch(statsUrl, {}, 5, "FORECAST_API");
        const json = await res.json();
        
        const platformStats = json.platformStats || {};

        const stats = {
            totalVolume: platformStats.totalVolume || 0,
            totalFees: platformStats.totalFees || 0,
            totalWinnings: platformStats.totalWinnings || 0,
            totalLifetimeUsers: platformStats.totalLifetimeUsers || 0,
        };
        debugLog("FORECAST_API", `ASDForecast stats retrieved. Users: ${stats.totalLifetimeUsers}`);
        return stats;

    } catch (error) {
        debugLog("FORECAST_API", `Failed to fetch ASDForecast stats: ${error.message}`, true);
        return { totalVolume: 0, totalFees: 0, totalWinnings: 0, totalLifetimeUsers: 0 };
    }
}


// --- ASYNC CACHING JOBS ---

/**
 * Executes every 1 minute. Handles heavy lift and aggregation.
 */
async function fetchAndCacheData() {
    debugLog("CACHE_MAIN", "Starting data fetch (Heavy Lift & Aggregation)...");
    
    let currentSupply, totalSol, lifetimeUsd, purchasedFromSource;

    try {
        // --- 1. BURN DATA ---
        currentSupply = await fetchCurrentTokenSupplyUi();
        const burned = TOKEN_TOTAL_SUPPLY - currentSupply;
        const burnedPercent = (burned / TOKEN_TOTAL_SUPPLY) * 100;
        cache.burn = { burnedAmount: burned, currentSupply, burnedPercent };

        // --- 2. WALLET DATA (HELIUS TXS & COINGECKO HISTORICAL) ---
        const txs = await fetchAllEnhancedTransactions(TRACKED_WALLET);
        const { receipts, totalSol: calculatedSol } = extractSolReceipts(txs, TRACKED_WALLET);
        totalSol = calculatedSol;

        if (receipts.length > 0) {
            const timestamps = receipts.map(r => r.timestamp);
            const prices = await fetchSolHistoricalPrices(Math.min(...timestamps), Math.max(...timestamps));
            lifetimeUsd = computeLifetimeUsd(receipts, prices);
        } else {
            lifetimeUsd = 0;
        }

        const { purchasedFromSource: calculatedPurchased } = computeTokenFlows(txs, TRACKED_WALLET, TOKEN_MINT);
        purchasedFromSource = calculatedPurchased;
        
        // --- 3. ASDFORECAST FEES (CROSS SERVICE) ---
        const forecastStats = await fetchASDForecastStats();
        
        // --- 4. CACHE STORAGE ---
        cache.wallet = { 
            ctoFeesSol: totalSol, 
            ctoFeesUsd: lifetimeUsd, 
            purchasedFromSource, 
            tokenPriceUsd: cache.wallet.tokenPriceUsd, // Keep existing slow cache price
            solPriceUsd: cache.wallet.solPriceUsd // Keep existing slow cache price
        };
        
        cache.forecast = forecastStats;
        cache.lastUpdated = Date.now();
        debugLog("CACHE_MAIN", "Heavy lift data successfully cached.");

    } catch (error) {
        debugLog("CACHE_MAIN", `Failed to update cache (Heavy Lift): ${error.message}`, true);
        cache.lastUpdated = Date.now(); 
    }
}

/**
 * Executes every 10 minutes. Updates only SOL and ASDF spot prices.
 */
async function fetchTokenPriceStaggered() {
    
    // Check if it's the 1st cycle (timeSinceInit < 2 min) or a 10-minute multiple (10m / 1m = 10 cycles)
    // We run it on cycle 0 and every 10th cycle thereafter.
    if (cacheCycleCount % 10 !== 0) {
        debugLog("CACHE_PRICE", `Skipping price update on cycle ${cacheCycleCount}. Next in ${10 - (cacheCycleCount % 10)} min.`);
        return;
    }

    debugLog("CACHE_PRICE", "Starting 10-minute price fetch (SOL & ASDF)...");
    
    // Fetch ASDF price using reliable Jupiter API
    const tokenPriceUsd = await fetchJupiterTokenPrice(TOKEN_MINT);
    // Fetch SOL price using reliable CoinGecko API
    const solPriceUsd = await fetchCurrentSolPrice();

    cache.wallet.tokenPriceUsd = tokenPriceUsd;
    cache.wallet.solPriceUsd = solPriceUsd;
    cache.lastUpdated = Date.now(); // Update timestamp to show fresh price data
    debugLog("CACHE_PRICE", `ASDF Price: $${tokenPriceUsd.toFixed(10)}, SOL Price: $${solPriceUsd.toFixed(2)}`);
}


// --- INITIALIZATION AND SCHEDULING ---

// 1. Initial Main Fetch (Sets up initial wallet/burn stats)
fetchAndCacheData(); 

// 2. Initial Price Fetch (Staggered 30 seconds after main job starts for initial prices)
// Note: We MUST run this immediately on the first cycle.
setTimeout(() => {
    fetchTokenPriceStaggered();
    cacheCycleCount++; // Immediately increment after first staggered run
    
    // Start recurring price checker after initial stagger
    setInterval(() => {
        fetchTokenPriceStaggered();
        cacheCycleCount++;
    }, FAST_CACHE_MS);

}, 30000); 

// 3. Schedule Recurring Heavy Lift (Every 1 minute)
setInterval(fetchAndCacheData, FAST_CACHE_MS);


// --- API ROUTES ---

// Middleware to check if cache is ready
function checkCache(req, res, next) {
    if (cache.lastUpdated === 0) {
        debugLog("API_STATUS", "Serving 503: Cache initializing.");
        return res.status(503).json({ error: "Service unavailable, initializing data cache." });
    }
    next();
}

// Status Route: Check if the server is alive
app.get('/', (req, res) => {
    const cacheAge = Date.now() - cache.lastUpdated;
    res.send({ 
        status: 'ok', 
        message: 'ASDF Tracker Backend is running and serving cached data.',
        cacheAge: `${(cacheAge / 1000).toFixed(0)} seconds old`,
        lastPrice: cache.wallet.tokenPriceUsd
    });
});

// Endpoint: Burn Stats - serves cached data
app.get('/api/burn', checkCache, (req, res) => {
    res.json({ ...cache.burn, ...cache.forecast, lastUpdated: cache.lastUpdated });
});

// Endpoint: Wallet Stats - serves cached data
app.get('/api/wallet', checkCache, (req, res) => {
    res.json({ ...cache.wallet, lastUpdated: cache.lastUpdated });
});

app.listen(PORT, () => {
    debugLog("INIT", `Server running on port ${PORT}`);
});
