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

// --- CACHING VARIABLES ---
let cache = { 
    burn: {}, 
    wallet: { tokenPriceUsd: 0 }, // Initialize tokenPriceUsd to 0 to ensure it exists
    lastUpdated: 0 
};
const CACHE_DURATION_MS = 60000; // 1 minute

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

// --- UTILITY: EXPONENTIAL BACKOFF FOR API CALLS ---
async function exponentialBackoffFetch(url, options = {}, maxRetries = 5, category = "API") {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const res = await fetch(url, options);
            if (res.ok) return res;

            if (res.status === 429 || res.status >= 500) {
                // Rate limit or server error: retry with delay
                const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
                debugLog(category, `Attempt ${attempt + 1}: Received HTTP ${res.status}. Retrying in ${delay.toFixed(0)}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                continue; 
            }
            // Non-retryable error (e.g., 400, 404)
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

// --- LOGIC FUNCTIONS (Unchanged from previous versions) ---

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

// NOTE: All other helper functions (extractSolReceipts, fetchSolHistoricalPrices, 
// computeLifetimeUsd, computeTokenFlows) remain unchanged. 

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
    const from = Math.max(0, fromSec - 3600); const to = toSec + 3600;
    const url = new URL(`${COINGECKO_BASE}/coins/solana/market_chart/range`);
    url.searchParams.set("vs_currency", "usd"); url.searchParams.set("from", String(from)); url.searchParams.set("to", String(to));
    url.searchParams.set("x_cg_demo_api_key", COINGECKO_DEMO_KEY);

    try {
        const res = await exponentialBackoffFetch(url.toString(), {}, 5, "COINGECKO");
        const json = await res.json();
        return json.prices.map(([tMs, price]) => ({ tMs: Number(tMs), priceUsd: Number(price) }));
    } catch(e) {
        debugLog("COINGECKO", `Failed to fetch historical SOL prices: ${e.message}`, true);
        return [];
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


// --- ASYNC CACHING JOBS ---

/**
 * Job 1: Fetches Burn Data, Wallet Data, and SOL Historical Prices (The Heavy Lift).
 */
async function fetchAndCacheData() {
    debugLog("CACHE_MAIN", "Starting data fetch (Heavy Lift)...");
    
    let currentSupply, totalSol, lifetimeUsd, purchasedFromSource;

    try {
        // --- 1. BURN DATA ---
        currentSupply = await fetchCurrentTokenSupplyUi();
        const burned = TOKEN_TOTAL_SUPPLY - currentSupply;
        const burnedPercent = (burned / TOKEN_TOTAL_SUPPLY) * 100;
        
        cache.burn = { burnedAmount: burned, currentSupply, burnedPercent };
        debugLog("CACHE_MAIN", `Burn data calculated. Burned: ${burnedPercent.toFixed(2)}%`);

        // --- 2. WALLET DATA (HELIUS TXS) ---
        const txs = await fetchAllEnhancedTransactions(TRACKED_WALLET);
        const { receipts, totalSol: calculatedSol } = extractSolReceipts(txs, TRACKED_WALLET);
        totalSol = calculatedSol;
        debugLog("CACHE_MAIN", `Found ${txs.length} transactions and ${receipts.length} SOL receipts.`);

        // --- 3. SOL HISTORICAL PRICES (COINGECKO) ---
        if (receipts.length > 0) {
            const timestamps = receipts.map(r => r.timestamp);
            const prices = await fetchSolHistoricalPrices(Math.min(...timestamps), Math.max(...timestamps));
            lifetimeUsd = computeLifetimeUsd(receipts, prices);
            debugLog("CACHE_MAIN", `SOL lifetime USD calculated: $${lifetimeUsd.toFixed(2)}.`);
        } else {
            lifetimeUsd = 0;
        }

        const { purchasedFromSource: calculatedPurchased } = computeTokenFlows(txs, TRACKED_WALLET, TOKEN_MINT);
        purchasedFromSource = calculatedPurchased;

        // --- 4. CACHE STORAGE (Initial) ---
        // Preserve existing tokenPriceUsd if it exists, otherwise use 0
        const existingTokenPrice = cache.wallet.tokenPriceUsd || 0;
        
        cache.wallet = { 
            ctoFeesSol: totalSol, 
            ctoFeesUsd: lifetimeUsd, 
            purchasedFromSource, 
            tokenPriceUsd: existingTokenPrice 
        };
        cache.lastUpdated = Date.now();
        debugLog("CACHE_MAIN", "Heavy lift data successfully cached.");

    } catch (error) {
        debugLog("CACHE_MAIN", `Failed to update cache (Heavy Lift): ${error.message}`, true);
        cache.lastUpdated = Date.now(); 
    }
}

/**
 * Job 2: Fetches current ASDF price (The Staggered Lift).
 */
async function fetchJupiterPrice() {
    debugLog("CACHE_PRICE", "Starting Jupiter price fetch...");
    let tokenPriceUsd = 0;
    
    let jupUrl = `${JUP_PRICE_URL}?ids=${TOKEN_MINT}`;
    // Headers are needed if JUPITER_API_KEY were required by the endpoint
    const jupOptions = JUPITER_API_KEY ? { headers: { 'Authorization': `Bearer ${JUPITER_API_KEY}` } } : {};

    try {
        const jupRes = await exponentialBackoffFetch(jupUrl, jupOptions, 5, "JUPITER"); 
        const jupJson = await jupRes.json();
        tokenPriceUsd = jupJson.data?.[TOKEN_MINT]?.price || 0;
        
        if (tokenPriceUsd > 0) {
            debugLog("CACHE_PRICE", `Jupiter price successfully fetched: $${tokenPriceUsd.toFixed(10)}`);
        } else {
            debugLog("CACHE_PRICE", "Jupiter returned price 0 or invalid data.", true);
        }

    } catch (e) { 
        debugLog("CACHE_PRICE", `Failed to update Jupiter price: ${e.message}`, true);
    }
    
    // Update cache with new price and set the last update time again
    cache.wallet.tokenPriceUsd = tokenPriceUsd;
    cache.lastUpdated = Date.now();
}

// --- INITIALIZATION AND SCHEDULING ---

// 1. Initial Main Fetch
fetchAndCacheData(); 
// 2. Initial Price Fetch (Staggered 30 seconds after main job starts)
setTimeout(fetchJupiterPrice, 30000); 

// 3. Schedule Recurring Updates (Ensures only one run per minute)
setInterval(fetchAndCacheData, CACHE_DURATION_MS);
setInterval(fetchJupiterPrice, CACHE_DURATION_MS); // Price runs every minute, roughly 30s after main

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
    // Inject timestamp for the frontend status display
    res.json({ ...cache.burn, lastUpdated: cache.lastUpdated });
});

// Endpoint: Wallet Stats - serves cached data
app.get('/api/wallet', checkCache, (req, res) => {
    // Inject timestamp for the frontend status display
    res.json({ ...cache.wallet, lastUpdated: cache.lastUpdated });
});

app.listen(PORT, () => {
    debugLog("INIT", `Server running on port ${PORT}`);
});
