// CommonJS version (no "type": "module" needed)
require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');

// ---- Mezo Mainnet ----
const RPC = 'https://mainnet.mezo.public.validationcloud.io';
const CHAIN_ID = 31612; // 0x7B7C

const app = express();
app.use(express.json());

// (Dev) open CORS; tighten to your domain in prod.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); // e.g., 'https://your-frontend.tld'
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// Minimal ABI for the wallet
const WABI = [
  'function relayMove(uint8 cmd, string memo)',
  'function relayer() view returns (address)'
];

if (!process.env.RELAYER_PK || !process.env.RELAYER_PK.startsWith('0x')) {
  console.error('Missing RELAYER_PK in .env');
  process.exit(1);
}

// Ethers v5 provider/signer
const provider = new ethers.providers.JsonRpcProvider(RPC, { chainId: CHAIN_ID, name: 'mezo' });
const signer = new ethers.Wallet(process.env.RELAYER_PK, provider);

app.get('/health', async (_req, res) => {
  try {
    const n = await provider.getNetwork();
    res.json({ ok: true, chainId: n.chainId, relayer: signer.address });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

app.post('/relay', async (req, res) => {
  try {
    const { wallet, cmd, memo, chainId } = req.body || {};
    if (!wallet || cmd === undefined) throw new Error('bad params');
    if (Number(chainId) !== CHAIN_ID) throw new Error('wrong chainId');

    const w = new ethers.Contract(wallet, WABI, signer);

    // Safety: only relay if this server is authorized on that wallet
    const r = (await w.relayer()).toLowerCase();
    if (r !== signer.address.toLowerCase()) {
      throw new Error('relayer not authorized on wallet');
    }

    const tx = await w.relayMove(cmd, String(memo || ''), { gasLimit: 500000 });
    res.json({ hash: tx.hash });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: e?.message || String(e) });
  }
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`Relayer listening on :${PORT} as ${signer.address}`);
});
