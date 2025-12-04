const express = require('express');
const cors = require('cors');
// Use require for node-fetch
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// --- CACHING VARIABLES ---
let cache = { burn: {}, wallet: {}, lastUpdated: 0 };
const CACHE_DURATION_MS = 60000; // 1 minute

// --- CONFIGURATION & VALIDATION ---
const HELIUS_API_KEY = process.env.HELIUS_API_KEY; 

// CRITICAL CHECK: Ensure the Helius API key is available
if (!HELIUS_API_KEY) {
    console.error("FATAL: HELIUS_API_KEY environment variable is not set.");
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

// --- LOGIC FUNCTIONS (Unchanged from previous versions) ---

async function fetchCurrentTokenSupplyUi() {
    const body = { jsonrpc: "2.0", id: "burn-supply", method: "getTokenSupply", params: [TOKEN_MINT] };
    const res = await fetch(HELIUS_RPC_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`getTokenSupply failed: HTTP ${res.status}`);
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
        const res = await fetch(url.toString());
        if (!res.ok) { console.warn(`Helius fetch failed on page ${page}: HTTP ${res.status}`); break; } 
        const batch = await res.json();
        if (!Array.isArray(batch) || batch.length === 0) break;
        all.push(...batch);
        const last = batch[batch.length - 1];
        if (!last || !last.signature) break;
        before = last.signature;
        if (batch.length < 90) break;
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
    const from = Math.max(0, fromSec - 3600); const to = toSec + 3600;
    const url = new URL(`${COINGECKO_BASE}/coins/solana/market_chart/range`);
    url.searchParams.set("vs_currency", "usd"); url.searchParams.set("from", String(from)); url.searchParams.set("to", String(to));
    url.searchParams.set("x_cg_demo_api_key", COINGECKO_DEMO_KEY);

    const res = await fetch(url.toString());
    if (!res.ok) { console.warn(`CoinGecko fetch failed: HTTP ${res.status}`); return []; }
    const json = await res.json();
    return json.prices.map(([tMs, price]) => ({ tMs: Number(tMs), priceUsd: Number(price) }));
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

// --- NEW: CACHING & FETCHING JOB ---

async function fetchAndCacheData() {
    console.log(`[Cache] Starting data fetch: ${new Date().toISOString()}`);
    
    let currentSupply, totalSol, lifetimeUsd, purchasedFromSource, tokenPriceUsd;

    try {
        // --- 1. BURN DATA ---
        currentSupply = await fetchCurrentTokenSupplyUi();
        const burned = TOKEN_TOTAL_SUPPLY - currentSupply;
        const burnedPercent = (burned / TOKEN_TOTAL_SUPPLY) * 100;
        
        cache.burn = { burnedAmount: burned, currentSupply, burnedPercent };

        // --- 2. WALLET DATA (HEAVY LIFT) ---
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

        // --- 3. TOKEN PRICE (FIXING USD VALUE) ---
        // This is where the price for ASDF is fetched (used for "Sacrificed" USD value)
        try {
            const jupRes = await fetch(`${JUP_PRICE_URL}?ids=${TOKEN_MINT}`);
            if (jupRes.ok) {
                const jupJson = await jupRes.json();
                tokenPriceUsd = jupJson.data?.[TOKEN_MINT]?.price || 0;
            } else {
                console.warn(`Jupiter fetch failed (HTTP ${jupRes.status}). Price set to 0.`);
                tokenPriceUsd = 0;
            }
        } catch (e) { 
            console.error("Jupiter fetch failed:", e.message); 
            tokenPriceUsd = 0;
        }

        // --- 4. CACHE STORAGE ---
        cache.wallet = { 
            ctoFeesSol: totalSol, 
            ctoFeesUsd: lifetimeUsd, 
            purchasedFromSource, 
            tokenPriceUsd 
        };
        cache.lastUpdated = Date.now();
        console.log(`[Cache] Data fetch complete. Next update in ${CACHE_DURATION_MS / 1000}s.`);

    } catch (error) {
        console.error("[Cache] Failed to update cache:", error.message);
        // If the fetch fails, keep the old cache data, but update timestamp to allow re-run
        cache.lastUpdated = Date.now(); 
    }
}

// Start the initial fetch immediately
fetchAndCacheData(); 
// Schedule recurring updates every minute
setInterval(fetchAndCacheData, CACHE_DURATION_MS);

// --- API ROUTES ---

// Middleware to check if cache is ready
function checkCache(req, res, next) {
    if (cache.lastUpdated === 0) {
        // If initial fetch hasn't completed yet
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
        cacheAge: `${(cacheAge / 1000).toFixed(0)} seconds old`
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
    console.log(`Server running on port ${PORT}`);
});
