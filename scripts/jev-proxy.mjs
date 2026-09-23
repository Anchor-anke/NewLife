#!/usr/bin/env node
/**
 * Jev 的本地转发代理（走 Vercel AI Gateway）。
 *
 * 为什么需要它：官方端点 api.typesafe.ai 有 CORS 白名单，拒绝浏览器直连，
 * 而本应用是纯浏览器 BYOK 架构。AI Gateway（ai-gateway.vercel.sh）是
 * 免排队的替代通道，SystemOne 协议挂在 `/v1/evaluate`，模型标识是
 * `typesafe-ai/jev`（以上均实测确认）。
 *
 * 这个代理做三件事：
 *   1. 把应用的 POST /v1/systemone 转成网关的 POST /v1/evaluate；
 *   2. 把请求体里的 model 改写成网关的模型标识（应用发的是 jev-latest）；
 *   3. 注入网关 Key 并补上 CORS 头。
 *
 * 真实 Key 只存在代理侧（环境变量或 --key），**不进浏览器**——应用设置页
 * 的 Key 栏随便填一个占位符即可。
 *
 * 用法：
 *   AI_GATEWAY_API_KEY=vck_... npm run jev:proxy
 *   node scripts/jev-proxy.mjs --key vck_... [--port 8790]
 *
 * 然后在应用的设置页把 Jev 接口地址填成 http://127.0.0.1:8790 。
 */

import { createServer } from 'node:http';

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};

const PORT = Number(argValue('--port', 8790));
// 只绑本机回环：这个进程持有真实 Key，不能暴露给局域网
const HOST = '127.0.0.1';
const UPSTREAM = 'https://ai-gateway.vercel.sh';
const UPSTREAM_PATH = '/v1/evaluate';
const MODEL = argValue('--model', 'typesafe-ai/jev');
const API_KEY = argValue('--key', process.env.AI_GATEWAY_API_KEY ?? process.env.TYPESAFE_API_KEY ?? '');

if (!API_KEY.trim()) {
  console.error('缺少 API Key：请用 AI_GATEWAY_API_KEY=vck_... 环境变量或 --key 参数提供。');
  process.exit(1);
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Max-Age': '86400',
};

const server = createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, CORS_HEADERS);
    response.end();
    return;
  }

  if (request.method !== 'POST' || !request.url?.endsWith('/v1/systemone')) {
    response.writeHead(404, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'only POST /v1/systemone is proxied' } }));
    return;
  }

  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const startedAt = Date.now();

  // 改写模型标识：应用发的是 jev-latest，网关只认带供应商前缀的完整 slug
  let upstreamBody = Buffer.concat(chunks);
  try {
    const parsed = JSON.parse(upstreamBody.toString('utf8'));
    if (parsed && typeof parsed === 'object') {
      parsed.model = MODEL;
      upstreamBody = Buffer.from(JSON.stringify(parsed));
    }
  } catch {
    // 解析失败就按原样转发，让上游返回它自己的错误
  }

  try {
    const upstream = await fetch(`${UPSTREAM}${UPSTREAM_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Key 由代理注入，浏览器发来的占位符在这里被覆盖
        Authorization: `Bearer ${API_KEY}`,
      },
      body: upstreamBody,
    });

    const text = await upstream.text();
    console.log(`[jev-proxy] ${upstream.status} ${Date.now() - startedAt}ms`);
    response.writeHead(upstream.status, {
      ...CORS_HEADERS,
      'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
    });
    response.end(text);
  } catch (error) {
    // 上游不可达要如实透传给应用：客户端会把 5xx 归类成可操作的提示
    console.error(`[jev-proxy] 上游请求失败：${error.message}`);
    response.writeHead(502, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: `上游不可达：${error.message}` } }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Jev 转发代理已启动：http://${HOST}:${PORT} → ${UPSTREAM}${UPSTREAM_PATH}`);
  console.log(`模型改写为：${MODEL}`);
  console.log(`设置页的 Jev 接口地址填：http://${HOST}:${PORT}`);
  console.log('应用里的 Key 栏随便填——真实 Key 只在这个代理进程里。');
});
