// index.js
// Minimal Mezo relayer with dynamic gas estimation and safety checks.
// Env vars: RPC, PRIVATE_KEY, CHAIN_ID (defaults to 31612)

import 'dotenv/config';
import express from 'express';
import { ethers } from 'ethers';

// --- config from env ---
const RPC       = process.env.RPC?.trim();
const PK        = process.env.PRIVATE_KEY?.trim();
const CHAIN_ID  = Number(process.env.CHAIN_ID || 31612);
const PORT      = Number(process.env.PORT || 8787);

if (!RPC) throw new Error('Missing RPC in .env');
if (!PK)  throw new Error('Missing PRIVATE_KEY in .env');

// --- provider & signer (ethers v5) ---
const provider = new ethers.providers.JsonRpcProvider(RPC, { chainId: CHAIN_ID, name: 'mezo' });
const relayer  = new ethers.Wallet(PK, provider);

// --- minimal ABI for GasTankWallet ---
const WABI = [
  'function relayer() view returns (address)',
  'function relayMove(uint8 cmd, string memo)',
  // estimateGas.relayMove(...)
];

// --- http server ---
const app = express();
app.use(express.json());

// very open CORS – lock down if you like
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// health / info
app.get('/health', async (_req, res) => {
  try {
    const bal = await provider.getBalance(relayer.address);
    const net = await provider.getNetwork();
    res.json({
      ok: true,
      chainId: net.chainId,
      address: relayer.address,
      balance: ethers.utils.formatUnits(bal, 18),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// main relay endpoint
app.post('/relay', async (req, res) => {
  try {
    let { wallet, cmd, memo = '', chainId } = req.body || {};

    if (!wallet || !ethers.utils.isAddress(wallet)) {
      return res.status(400).json({ error: 'Invalid wallet address' });
    }
    if (cmd === undefined || cmd === null) {
      return res.status(400).json({ error: 'Missing cmd' });
    }
    cmd = Number(cmd);
    if (Number.isNaN(cmd) || cmd < 0 || cmd > 255) {
      return res.status(400).json({ error: 'cmd must be 0..255' });
    }
    if (chainId && Number(chainId) !== CHAIN_ID) {
      return res.status(400).json({ error: `Wrong chainId (got ${chainId}, need ${CHAIN_ID})` });
    }

    const net = await provider.getNetwork();
    if (net.chainId !== CHAIN_ID) {
      return res.status(500).json({ error: `Provider on wrong chain (${net.chainId}), expected ${CHAIN_ID}` });
    }

    const walletContract = new ethers.Contract(wallet, WABI, relayer);

    // --- dynamic gas estimate with buffer ---
    const est = await walletContract.estimateGas.relayMove(cmd, memo, { from: relayer.address });
    // +25% safety + 40k overhead for refund/accounting
    const gasLimit = est.mul(125).div(100).add(ethers.BigNumber.from(40000));

    // fee policy (modest tip, tame max fee)
    const fee = await provider.getFeeData();
    const tip = ethers.BigNumber.from('1000000000'); // 1 gwei
    const maxFeePerGas = fee.maxFeePerGas ? fee.maxFeePerGas.mul(110).div(100) : tip;

    // ensure relayer balance can front the max cost
    const need = gasLimit.mul(maxFeePerGas);
    const have = await provider.getBalance(relayer.address);
    if (have.lt(need)) {
      return res.status(402).json({
        error: 'Relayer low balance',
        have: ethers.utils.formatUnits(have, 18),
        need: ethers.utils.formatUnits(need, 18),
        hint: 'Top up relayer or lower gas settings',
      });
    }

    // --- send the tx ---
    const tx = await walletContract.relayMove(cmd, memo, {
      gasLimit,
      maxPriorityFeePerGas: tip,
      maxFeePerGas,
    });

    console.log(`[relay] ${relayer.address} -> wallet ${wallet} cmd=${cmd} gasLimit=${gasLimit.toString()} tx=${tx.hash}`);
    res.json({ ok: true, hash: tx.hash });

  } catch (e) {
    console.error('relay error:', e);
    // unwrap ethers error bodies if present
    const body = e?.body ? (() => { try { return JSON.parse(e.body); } catch { return null; } })() : null;
    res.status(500).json({ error: e?.reason || e?.message || String(e), node: body?.error?.message });
  }
});

// start
app.listen(PORT, () => {
  console.log(`Relayer listening on :${PORT} as ${relayer.address}`);
});
