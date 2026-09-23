import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // 纯前端 BYOK 方案没有服务端依赖，因此可以完全静态导出。
  // 这样部署到任意静态托管（Cloudflare Pages / Vercel / 对象存储）都能直接跑，
  // 也不需要为每次部署准备 Node 运行时。
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
};

export default nextConfig;
