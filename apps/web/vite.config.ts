import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 线上挂在 `https://xiaopingfeng.com/apps/` 下，开发时挂在 `/`。
 * 用 WEB_BASE 切，前端所有后端调用都从 import.meta.env.BASE_URL 取前缀
 * （见 src/net/base.ts），不再各写各的绝对路径。
 */
const base = process.env.WEB_BASE ?? '/';

export default defineConfig({
  base,
  plugins: [react()],
  build: {
    /**
     * 构建产物放 `static/` 而不是默认的 `assets/`。
     *
     * 后端早就有一个 `/assets/:id` 接口在发用户上传的图片。两边撞在一起时，
     * 上传接口先匹配到，把 index-xxx.js 当成图片 id 去查，查不到就 404——
     * 页面白屏，而且日志里只看得到一条"资源不存在"，看不出是路由撞了。
     */
    assetsDir: 'static',
  },
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://localhost:3001', ws: true },
      '/health': { target: 'http://localhost:3001' },
      '/assets': { target: 'http://localhost:3001' },
      '/kg': { target: 'http://localhost:3001' },
    },
  },
});
