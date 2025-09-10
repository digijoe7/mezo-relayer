// index.js
import 'dotenv/config';
import express from 'express';
import { ethers } from 'ethers';

// --- ENV ---
const RPC        = process.env.RPC || 'https://mainnet.mezo.public.validationcloud.io';
const CHAIN_ID   = Number(process.env.CHAIN_ID || 31612);
const ORIGIN     = (process.env.ORIGIN || '').trim();  // e.g. https://mezo-plays-pokemon-smart.vercel.app
const PORT       = Number(process.env.PORT || 8787);

// accept RELAYER_PK or PRIVATE_KEY
const PK = (process.env.RELAYER_PK || process.env.PRIVATE_KEY || '').trim();
if (!PK)  throw new Error('Missing PRIVATE_KEY / RELAYER_PK in env');
if (!RPC) throw new Error('Missing RPC in env');

// --- Provider & signer ---
const provider = new ethers.providers.JsonRpcProvider(RPC, { chainId: CHAIN_ID, name: 'mezo' });
const relayer  = new ethers.Wallet(PK, provider);

// Minimal wallet ABI (only what we call)
const WABI = [
  'function relayMove(uint8 cmd, string memo)'
];

const app = express();
app.use(express.json({ limit: '256kb' }));

// CORS (tighten to your front-end)
app.use((req, res, next) => {
  if (ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', ORIGIN);
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*'); // fallback if ORIGIN not set
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Health
app.get('/', (_req, res) => {
  res.type('text/plain').send(`Mezo relayer up as ${relayer.address} on chain ${CHAIN_ID}`);
});
app.get('/health', (_req, res) => res.json({ ok: true, relayer: relayer.address, chainId: CHAIN_ID }));

// Core relay
app.post('/relay', async (req, res) => {
  try {
    const { wallet, cmd, memo = '', chainId } = req.body || {};
    if (!wallet || typeof cmd !== 'number') {
      return res.status(400).json({ error: 'wallet (address) and cmd (number) required' });
    }
    if (chainId && Number(chainId) !== CHAIN_ID) {
      return res.status(400).json({ error: `wrong chainId; expected ${CHAIN_ID}` });
    }

    // Build contract interface
    const w = new ethers.Contract(wallet, WABI, relayer);

    // Gas price & limit (lightweight)
    const fee = await provider.getFeeData();
    const gasPrice =
      fee.gasPrice ??
      fee.maxFeePerGas ??                      // if network returns EIP-1559 fields only
      ethers.BigNumber.from('20000000');      // 20 gwei fallback

    // Estimate, then pad ~25% + 20k (covers logs & refund ops inside wallet)
    let gasLimit;
    try {
      const est = await w.estimateGas.relayMove(cmd, String(memo), { gasPrice });
      gasLimit = est.mul(125).div(100).add(20000);
    } catch {
      gasLimit = ethers.BigNumber.from(120000); // safe fallback
    }

    // Send
    const tx = await w.relayMove(cmd, String(memo), { gasPrice, gasLimit });
    return res.json({ ok: true, hash: tx.hash, gasPrice: gasPrice.toString(), gasLimit: gasLimit.toString() });
  } catch (err) {
    console.error('relay error:', err);
    const msg = err?.error?.message || err?.data?.message || err?.reason || err?.message || String(err);
    return res.status(500).json({ error: msg });
  }
});

app.listen(PORT, () => {
  console.log(`Relayer listening on :${PORT} as ${relayer.address}`);
});
