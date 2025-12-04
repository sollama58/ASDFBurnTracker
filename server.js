const express = require('express');
const cors = require('cors');
// Use require for node-fetch to be compatible with common practices
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIGURATION & VALIDATION ---
const HELIUS_API_KEY = process.env.HELIUS_API_KEY; 

// CRITICAL CHECK: Ensure the Helius API key is available
if (!HELIUS_API_KEY) {
    console.error("FATAL: HELIUS_API_KEY environment variable is not set.");
    // Exit the process to prevent the server from running in an unusable state
    process.exit(1); 
}

const TOKEN_MINT = "9zB5wRarXMj86MymwLumSKA1Dx35zPqqKfcZtK1Spump";
const TOKEN_TOTAL_SUPPLY = 1_000_000_000;
const TRACKED_WALLET = "vcGYZbvDid6cRUkCCqcWpBxow73TLpmY6ipmDUtrTF8";
const PURCHASE_SOURCE_ADDRESS = "DuhRX5JTPtsWU5n44t8tcFEfmzy2Eu27p4y6z8Rhf2bb";

const HELIUS_RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const HELIUS_ENHANCED_BASE = "https://api-mainnet.helius-rpc.com/v0";
// Fallback to demo key if not explicitly set for CoinGecko (less critical)
const COINGECKO_DEMO_KEY = process.env.COINGECKO_API_KEY || "CG-KsYLbF8hxVytbPTNyLXe7vWA"; 
const COINGECKO_BASE = "https://api.coingecko.com/api/v3";
const JUP_PRICE_URL = "https://lite-api.jup.ag/price/v3";

// Middleware
app.use(cors()); // Allows your frontend to talk to this backend
app.use(express.json());

// --- LOGIC FUNCTIONS (Unchanged, relies on global HELIUS_API_KEY) ---

async function fetchCurrentTokenSupplyUi() {
    const body = {
        jsonrpc: "2.0",
        id: "burn-supply",
        method: "getTokenSupply",
        params: [TOKEN_MINT]
    };
    const res = await fetch(HELIUS_RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`getTokenSupply failed: HTTP ${res.status}`);
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

        const res = await fetch(url.toString());
        if (!res.ok) {
            console.warn(`Helius fetch failed on page ${page}: HTTP ${res.status}`);
            break;
        } 

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
    const receipts = [];
    let totalLamports = 0n;
    for (const tx of transactions) {
        const ts = tx.timestamp;
        const transfers = tx.nativeTransfers || [];
        for (const nt of transfers) {
            if (nt.toUserAccount !== wallet) continue;
            const rawAmt = nt.amount;
            if (rawAmt == null) continue;
            const lamports = BigInt(rawAmt.toString());
            if (lamports <= 0n) continue;
            totalLamports += lamports;
            receipts.push({ lamports: lamports.toString(), timestamp: ts });
        }
    }
    const totalSol = Number(totalLamports) / 1e9;
    return { receipts, totalSol };
}

async function fetchSolHistoricalPrices(fromSec, toSec) {
    const from = Math.max(0, fromSec - 3600);
    const to = toSec + 3600;
    const url = new URL(`${COINGECKO_BASE}/coins/solana/market_chart/range`);
    url.searchParams.set("vs_currency", "usd");
    url.searchParams.set("from", String(from));
    url.searchParams.set("to", String(to));
    url.searchParams.set("x_cg_demo_api_key", COINGECKO_DEMO_KEY);

    const res = await fetch(url.toString());
    if (!res.ok) {
         console.warn(`CoinGecko fetch failed: HTTP ${res.status}`);
         return [];
    }
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

// --- API ROUTES ---

// Status Route: Check if the server is alive
app.get('/', (req, res) => {
    res.send({ status: 'ok', message: 'ASDF Tracker Backend is running.' });
});

// Endpoint: Burn Stats
app.get('/api/burn', async (req, res) => {
    try {
        const currentSupply = await fetchCurrentTokenSupplyUi();
        const burned = TOKEN_TOTAL_SUPPLY - currentSupply;
        const burnedPercent = (burned / TOKEN_TOTAL_SUPPLY) * 100;
        res.json({ burnedAmount: burned, currentSupply, burnedPercent });
    } catch (error) {
        console.error("Burn API Error:", error.message);
        res.status(500).json({ error: "Failed to fetch burn stats", details: error.message });
    }
});

// Endpoint: Wallet Stats
app.get('/api/wallet', async (req, res) => {
    try {
        const txs = await fetchAllEnhancedTransactions(TRACKED_WALLET);
        const { receipts, totalSol } = extractSolReceipts(txs, TRACKED_WALLET);
        
        let lifetimeUsd = 0;
        if (receipts.length > 0) {
            const timestamps = receipts.map(r => r.timestamp);
            const prices = await fetchSolHistoricalPrices(Math.min(...timestamps), Math.max(...timestamps));
            lifetimeUsd = computeLifetimeUsd(receipts, prices);
        }

        const { purchasedFromSource } = computeTokenFlows(txs, TRACKED_WALLET, TOKEN_MINT);

        let tokenPriceUsd = 0;
        try {
            const jupRes = await fetch(`${JUP_PRICE_URL}?ids=${TOKEN_MINT}`);
            if (jupRes.ok) {
                const jupJson = await jupRes.json();
                tokenPriceUsd = jupJson.data?.[TOKEN_MINT]?.price || 0;
            } else {
                 console.warn(`Jupiter fetch failed: HTTP ${jupRes.status}`);
            }
        } catch (e) { 
            console.error("Jupiter fetch failed", e.message); 
        }

        res.json({ ctoFeesSol: totalSol, ctoFeesUsd: lifetimeUsd, purchasedFromSource, tokenPriceUsd });
    } catch (error) {
        console.error("Wallet API Error:", error.message);
        res.status(500).json({ error: "Failed to fetch wallet stats", details: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
