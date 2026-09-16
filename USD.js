const { RestClientV5 } = require('bybit-api');
const fs = require('fs');
const path = require('path');
const https = require('https');
require('dotenv').config({ path: path.join(__dirname, '.env') });
// 只写入代码，不在本地运行验证；交由 GitHub Actions 校验。
// 依赖：bybit-api、dotenv。id.txt 每行一个 Telegram 用户 ID。
// 同一个 BOT_TOKEN 只运行一个实例，不要同时启用 webhook。

const dataDir = path.resolve(process.env.DATA_DIR || __dirname);
const idFile = path.join(dataDir, 'id.txt');
const offsetFile = path.join(dataDir, 'telegram-offset.json');
const token = process.env.BOT_TOKEN;
const key = process.env.key || process.env.API_KEY;
const secret = process.env.secret || process.env.API_SECRET;
const startedAt = Math.floor(Date.now() / 1000);
let stopping = false;
let activeRequest;
let client;

function safeError(error) {
  let message = String(error.message || error);
  for (const value of [token, key, secret]) {
    if (value) message = message.split(value).join('[REDACTED]');
  }
  return message.slice(0, 500);
}

function telegram(method, parameters = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(parameters);
    const request = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (response) => {
      let result = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { result += chunk; });
      response.on('error', reject);
      response.on('end', () => {
        try {
          const payload = JSON.parse(result);
          if (response.statusCode !== 200 || !payload.ok) {
            const error = new Error(`Telegram ${payload.error_code || response.statusCode}: ${payload.description || '请求失败'}`);
            error.code = payload.error_code || response.statusCode;
            error.retryAfter = payload.parameters?.retry_after;
            reject(error);
          } else resolve(payload.result);
        } catch (error) { reject(error); }
      });
    });
    activeRequest = request;
    const timer = setTimeout(() => request.destroy(new Error('Telegram 请求超时')), 45000);
    request.on('close', () => {
      clearTimeout(timer);
      if (activeRequest === request) activeRequest = undefined;
    });
    request.on('error', reject);
    request.end(body);
  });
}

function readAllowedIds() {
  const ids = fs.readFileSync(idFile, 'utf8').replace(/^\uFEFF/, '')
    .split(/\r?\n/).map((line) => line.split('#')[0].trim()).filter(Boolean);
  if (!ids.length || ids.some((id) => !/^[1-9]\d*$/.test(id))) {
    throw new Error('id.txt 必须每行一个有效用户 ID，且不能为空');
  }
  return new Set(ids);
}

function readOffset() {
  try {
    const { offset } = JSON.parse(fs.readFileSync(offsetFile, 'utf8'));
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('消息进度文件无效');
    return offset;
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
}

function saveOffset(offset) {
  const temporary = `${offsetFile}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ offset }), { mode: 0o600 });
  fs.renameSync(temporary, offsetFile);
}

async function reply(chatId, text) {
  try {
    await telegram('sendMessage', { chat_id: chatId, text });
  } catch (error) {
    // 回复失败不能导致重复下单。
    console.error('Telegram 回复失败:', safeError(error));
  }
}

async function handleUpdate(update, bot) {
  const message = update.message;
  if (!message?.from || message.from.is_bot || !message.chat) return;
  // 重启前积压的交易指令不执行。
  if (!Number.isFinite(message.date) || message.date < startedAt) return;
  let allowedIds;
  try {
    allowedIds = readAllowedIds(); // 白名单修改无需重启。
  } catch (error) {
    console.error('白名单读取失败，本次指令不执行:', safeError(error));
    return;
  }
  if (!allowedIds.has(String(message.from.id))) return;
  const command = /^\/(buy|sell)(?:@([A-Za-z0-9_]+))?$/i.exec((message.text || '').trim());
  if (command?.[2] && command[2].toLowerCase() !== bot.username.toLowerCase()) return;
  if (!command) {
    await reply(message.chat.id, '该功能暂未开发。支持 /buy 和 /sell。');
    return;
  }

  const side = command[1].toLowerCase() === 'buy' ? 'Buy' : 'Sell';
  const orderLinkId = `tg-${bot.id}-${update.update_id}`;
  let response;
  try {
    response = await client.submitOrder({
      category: 'spot',
      symbol: 'USDTUSD',
      side,
      orderType: 'Market',
      qty: '1',
      marketUnit: 'baseCoin', // 买卖均为 1 USDT，而不是 1 USD。
      orderLinkId,
    });
  } catch (error) {
    console.error(`订单 ${orderLinkId} 请求异常:`, safeError(error));
    await reply(message.chat.id, `订单请求异常，结果待确认。请先在 Bybit 核实，避免重复提交。\n订单标识：${orderLinkId}`);
    return;
  }
  if (response.retCode !== 0) {
    console.error(`订单 ${orderLinkId} 被拒绝:`, response.retCode, safeError(response.retMsg || '未知错误'));
    await reply(message.chat.id, `下单未成功：${response.retCode} ${safeError(response.retMsg || '未知错误')}\n订单标识：${orderLinkId}`);
    return;
  }
  console.log('订单请求已受理:', { side, orderLinkId, orderId: response.result?.orderId });
  await reply(message.chat.id, `Bybit 测试网订单请求已受理（不代表已成交）。\nUSDTUSD ${side === 'Buy' ? '买入' : '卖出'} 1 USDT\n订单 ID：${response.result?.orderId || '未返回'}\n订单标识：${orderLinkId}`);
}

async function buynsell() {
  if (!token || !key || !secret) throw new Error('请配置 BOT_TOKEN、key/secret（或 API_KEY/API_SECRET）');
  fs.mkdirSync(dataDir, { recursive: true });
  readAllowedIds();
  let offset = readOffset();
  client = new RestClientV5({ testnet: true, key, secret });
  const bot = await telegram('getMe');
  const webhook = await telegram('getWebhookInfo');
  if (webhook.url) throw new Error('当前机器人已配置 webhook，请先移除 webhook 后使用轮询');
  console.log(`@${bot.username} 已启动；Bybit 测试网；白名单：${idFile}`);

  while (!stopping) {
    let updates;
    try {
      updates = await telegram('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] });
    } catch (error) {
      if (stopping) break;
      if ([401, 404, 409].includes(error.code)) throw error;
      console.error('Telegram 轮询失败:', safeError(error));
      const waitUntil = Date.now() + Math.max(5, Number(error.retryAfter) || 5) * 1000;
      while (!stopping && Date.now() < waitUntil) await new Promise((resolve) => setTimeout(resolve, 500));
      continue;
    }
    for (const update of updates) {
      if (stopping) break;
      if (update.update_id < offset) continue;
      // 先持久化再执行，避免崩溃后重放订单；若此后崩溃，该条可能未执行。
      // 写入失败直接退出，不允许在无法保存进度时下单。
      offset = update.update_id + 1;
      saveOffset(offset);
      await handleUpdate(update, bot);
    }
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    if (activeRequest) activeRequest.destroy(new Error('服务停止'));
  });
}

buynsell().catch((error) => {
  console.error('机器人停止:', safeError(error));
  process.exitCode = 1;
});
