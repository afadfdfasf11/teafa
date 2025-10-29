// === satoshi_scanner_light.js ===
const fs = require('fs');
const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

// BitcoinJS + ECC
const bitcoin = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');
const { ECPairFactory } = require('ecpair');
const ECPair = ECPairFactory(ecc);

const SAVE_PATH = './satoshi_valid_wallets.json';
const PUSHPLUS_TOKEN = process.env.PUSHPLUS_TOKEN;

// 创建保存文件
if (!fs.existsSync(SAVE_PATH)) fs.writeFileSync(SAVE_PATH, '', 'utf-8');

// ===== 推送到微信 =====
async function pushToWeChat(message) {
  if (!PUSHPLUS_TOKEN) return console.warn('⚠️ 未设置 PUSHPLUS_TOKEN');
  try {
    await axios.post('https://www.pushplus.plus/send', {
      token: PUSHPLUS_TOKEN,
      title: '🎯 比特币地址命中余额！',
      content: message,
      template: 'txt'
    });
    console.log('✅ 已推送到微信');
  } catch (err) {
    console.error('❌ 推送失败:', err.message);
  }
}

// ===== 钱包生成 =====
function generateWallet() {
  const privateKey = crypto.randomBytes(32);
  const keyPair = ECPair.fromPrivateKey(privateKey);
  const { address } = bitcoin.payments.p2pkh({ pubkey: Buffer.from(keyPair.publicKey) });
  const wif = keyPair.toWIF();
  return { address, privateKey: privateKey.toString('hex'), wif };
}

// ===== API 配置 =====
const apiBases = [
  {
    name: "mempool.space",
    base: "https://mempool.space/api/address",
    parser: (d) => (d.chain_stats.funded_txo_sum - d.chain_stats.spent_txo_sum) / 1e8
  },
  {
    name: "blockstream.info",
    base: "https://blockstream.info/api/address",
    parser: (d) => (d.chain_stats.funded_txo_sum - d.chain_stats.spent_txo_sum) / 1e8
  },
  {
    name: "blockchain.info",
    base: "https://blockchain.info/rawaddr",
    parser: (d) => (d.final_balance || 0) / 1e8
  }
];

let apiIndex = 0;
const FAIL_LIMIT = 8;
const BLOCK_DURATION = 10 * 60 * 1000;
const apiStatus = apiBases.map(api => ({ ...api, failCount: 0, blockedUntil: 0 }));

function getAvailableApis() {
  const now = Date.now();
  return apiStatus.filter(api => api.blockedUntil <= now);
}

async function getBalance(address) {
  const available = getAvailableApis();
  if (available.length === 0) {
    console.error('⏳ 所有 API 暂时被封，等待恢复中...');
    await new Promise(res => setTimeout(res, 60000));
    return null;
  }

  const api = available[apiIndex % available.length];
  const url = `${api.base}/${address}`;
  apiIndex++;

  try {
    const { data } = await axios.get(url, { timeout: 10000 });
    const balance = api.parser(data);
    api.failCount = 0;
    return balance;
  } catch (err) {
    api.failCount++;
    console.warn(`⚠️ API [${api.name}] 失败 (${api.failCount})`);

    if (api.failCount >= FAIL_LIMIT) {
      api.blockedUntil = Date.now() + BLOCK_DURATION;
      console.error(`⛔ ${api.name} 暂停使用 ${BLOCK_DURATION / 60000} 分钟`);
    }

    return null;
  }
}

// ===== 动态延迟控制 =====
let baseDelay = 1500;
let maxDelay = 4000;
let currentDelay = baseDelay;

async function sleepDynamic(success) {
  if (!success) currentDelay = Math.min(currentDelay + 800, maxDelay);
  else currentDelay = Math.max(currentDelay - 400, baseDelay);
  await new Promise(res => setTimeout(res, currentDelay + Math.random() * 1500));
}

// ===== 主循环 =====
(async () => {
  console.log('🔥 启动 satoshi_scanner_light（轻量模式）');
  console.log('🚀 运行环境: 单线程 | 无代理 | 自动动态延迟\n');

  let total = 0, found = 0, failCount = 0;

  while (true) {
    total++;
    const wallet = generateWallet();
    const balance = await getBalance(wallet.address);

    if (balance === null) {
      failCount++;
      if (failCount % 10 === 0) console.warn(`⚠️ 连续失败 ${failCount} 次`);
      await sleepDynamic(false);
      continue;
    }

    failCount = 0;

    console.log(`[#${total}] 地址: ${wallet.address} | 余额: ${balance} BTC`);

    if (balance > 0) {
      found++;
      const info = { ...wallet, balance, timestamp: new Date().toISOString() };
      fs.appendFileSync(SAVE_PATH, JSON.stringify(info) + '\n');
      socket.emit('found', info);

      await pushToWeChat(
        `🎉 发现余额钱包！\n地址: ${wallet.address}\n余额: ${balance} BTC`
      );
    }

    await sleepDynamic(balance !== null);
  }
})();
