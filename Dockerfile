# CanvaAI 容器镜像。
#
# 两阶段：前端在构建阶段编译成静态文件，运行阶段只留 Node + 服务端 + dist。
# 不用 `npm start` 那种"到了线上再装依赖"的做法——镜像要能离线起来，
# 而且容器冷启动只有 2-3 秒的预算，装依赖根本来不及。

FROM node:22-slim AS build
WORKDIR /app

RUN corepack enable

# 先只拷贝依赖清单，让这一层能被缓存住。
# 改一行业务代码就重装一遍 node_modules 的话，每次构建都要几分钟。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
COPY apps/mcp/package.json apps/mcp/
COPY packages/protocol/package.json packages/protocol/
COPY packages/canvas-core/package.json packages/canvas-core/
COPY packages/agent/package.json packages/agent/
COPY packages/knowledge/package.json packages/knowledge/
RUN pnpm install --frozen-lockfile

COPY . .

# WEB_BASE 必须和 worker.ts 里的 BASE_PATH 对上，否则页面加载不到自己的 js
RUN WEB_BASE=/apps/ pnpm --filter @canvai/web build

# 知识图谱数据烤进镜像：它是只读的，而且容器磁盘是临时的——
# 放在这儿开机即用，不用每次冷启动都去 Hugging Face 拉 12MB。
# 数据是 CC BY-NC-SA 4.0，非商业用途，镜像不要对外分发。
RUN node --import tsx apps/server/scripts/fetch-kg.ts --full || \
    echo "图谱没拉到，先起着——/kg/stats 会说明怎么补"

# ---- 运行阶段 ----
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production

RUN corepack enable

COPY --from=build /app /app

ENV PORT=8080
ENV BASE_PATH=/apps
ENV WEB_DIST=/app/apps/web/dist
ENV DATA_DIR=/app/data

EXPOSE 8080

# 直接 exec node，不要包一层 shell：
# 容器停机时 Cloudflare 发 SIGTERM，被 shell 挡住的话进程收不到，
# 15 分钟后被 SIGKILL——那 15 分钟里最后一次快照永远存不下去。
CMD ["node", "--import", "tsx", "apps/server/src/index.ts"]
