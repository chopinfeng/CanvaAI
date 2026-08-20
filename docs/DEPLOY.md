# 部署

目标：把应用挂到 `https://<你的域名>/apps/` 下面。
两条路：**Cloudflare Containers**（见下）或者**自己的服务器**（往下翻）。

## 先说清楚三件事

**1. 这不是静态站点。** 它要有一个**常驻的 Node 进程**——WebSocket、Yjs 权威副本、
Agent 宿主都活在里面。只把 `dist/` 传上去会得到一个能打开、但画布空白、
AI 永远"连接中"的页面。

**2. 它没有登录。** 谁打开这个 URL，谁就能驱动 Agent，烧的是你的 DeepSeek 额度，
也能读到别人房间的画布（房间名就是 URL 参数，猜得到）。公网放出去之前
至少加一道 HTTP Basic（`deploy/nginx-apps.conf` 里注释着现成的两行）。

**3. 知识图谱数据是 CC BY-NC-SA 4.0。** 非商业用途可以公开部署，
署名要留（页面右下角已经带了）。要商用得换一份数据。

## 路线 A：Cloudflare Containers

Workers 和 Pages 跑不了这个应用（没有常驻进程、没有文件系统、不支持原生模块），
但 **Containers 可以**——它就是给"跑一个现成的 Node 服务"用的。

### 一条必须知道的事：容器磁盘是临时的

容器一停（`sleepAfter` 到点、部署、崩溃）本地磁盘就抹掉重来。
照原样搬上去，表现是"隔一阵回来，画布空了、学了几个月的掌握度也没了"，
**而且不报任何错**。

所以房间快照和学习记录都改走 `BlobStore`（`apps/server/src/blobs.ts`）：
本地跑用文件，云上用 R2。四个 R2 变量必须配齐，缺一个就退回本地磁盘
并在日志里吼一声（`blobs.r2_incomplete`）——半配上的状态最危险：
以为存在云上，其实写在一块随时会被抹掉的盘上。

### 为什么按房间路由

`deploy/cloudflare/worker.ts` 用 `getContainer(env.CANVAI, room)` 做亲和性。
这条不能改成 `getRandom()`：权威副本是容器**内存里**那份 Yjs 文档，
分流的话同一个房间的两个人会落在两个容器上，各自维护一份，各自都觉得自己是对的。
表现是"我画的他看不见"，而两边日志都完全正常。

### 步骤

```bash
# 1) 建一个 R2 桶存快照和学习记录
npx wrangler r2 bucket create canvai

# 2) 在 R2 控制台建一对 S3 API Token（读写这个桶），然后灌进去
cd deploy/cloudflare
npx wrangler secret put DEEPSEEK_API_KEY
npx wrangler secret put R2_ACCOUNT_ID
npx wrangler secret put R2_BUCKET            # canvai
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY

# 3) 构建镜像并部署（wrangler 会自己 docker build + push）
npx wrangler deploy

# 4) 把 <你的域名>/apps/* 指到这个 Worker
#    控制台 → Workers → canvai → Routes → 加 <你的域名>/apps/*
```

需要 Workers 付费方案（Containers 不在免费额度里），本机要有 Docker。

### 上线后自检

```bash
BASE=https://<你的域名>/apps
curl -s $BASE/health                    # {"ok":true,...}
curl -s $BASE/kg/stats | head -c 60     # 10685 节点
```

然后打开 `$BASE/?room=demo` 画一笔——这一步同时验证 WebSocket、Yjs 同步和 Agent。
**再开一个浏览器进同一个房间**，确认两边看到的是同一张画：这是在验证房间亲和性，
分流坏掉的话恰恰就是这里露馅。

---

## 路线 B：自己的服务器

### 步骤

```bash
# 1) 服务器上拉代码
git clone <本仓库地址> /srv/canvai
cd /srv/canvai && pnpm install --frozen-lockfile

# 2) 构建前端。WEB_BASE 必须和 BASE_PATH 对上，否则页面加载不到自己的 js
WEB_BASE=/apps/ pnpm build:web

# 3) 图谱数据（CC BY-NC-SA，不在仓库里，现拉）
npx tsx apps/server/scripts/fetch-kg.ts --full

# 4) 密钥
cat > .env <<'EOF'
DEEPSEEK_API_KEY=sk-xxx
EOF
chmod 600 .env

# 5) 起服务
sudo cp deploy/canvai.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now canvai
curl -s localhost:3001/apps/health

# 6) 挂到站点下
#    把 deploy/nginx-apps.conf 里的 location 块并进你站点的 server 段
sudo nginx -t && sudo systemctl reload nginx
```

## 前缀这件事只有一个来源

`BASE_PATH=/apps` 一处配置，三个地方跟着走：

| 谁 | 怎么用 |
|---|---|
| 服务端路由 | 请求进来先剥掉前缀，下面所有路由照旧按根路径写 |
| WebSocket | `path: ${basePath}/ws` —— ws 库是拿原始 URL 匹配的，不跟着改就永远握不上手 |
| 前端 | 构建时 `WEB_BASE` 注入成 `import.meta.env.BASE_URL`，所有后端调用从它取前缀 |

nginx 那边**不要**再剥一次（`proxy_pass` 后面别写路径），剥两次就全站 404。

## 上线后自检

```bash
BASE=https://<你的域名>/apps
curl -s $BASE/health                      # {"ok":true,"agent":"deepseek-chat",...}
curl -s $BASE/kg/stats | head -c 80       # 节点数应该是 10685
curl -sI $BASE/ | grep -i cache-control   # index.html 必须 no-cache
```

最后打开 `$BASE/?room=demo`，画一笔看 AI 会不会接话——那一步同时验证了
WebSocket、Yjs 同步和 Agent 三条链路。知识图谱页在 `$BASE/?view=kg`。

## 踩过的坑

- **构建产物目录叫 `static/` 不是 `assets/`。** 后端有个 `/assets/:id` 接口在发
  用户上传的图片，撞在一起时上传接口先匹配到，把 `index-xxx.js` 当图片 id 去查，
  查不到就 404 —— 页面白屏，日志里只有一条"资源不存在"，看不出是路由撞了。
- **`index.html` 绝不能缓存。** 它里面写着当前该加载哪个 hash 的 js，
  缓存住就等于永远发旧版本。带 hash 的那些反过来可以 immutable。
- **`proxy_read_timeout` 要调大。** 辅导时一个回合会阻塞着等学生思考，
  默认 60 秒会被 nginx 掐断，表现成"老师问完就没声了"。
