# 部署

目标：把应用挂到 `https://xiaopingfeng.com/apps/` 下面。

## 先说清楚三件事

**1. 这不是静态站点。** 它要有一个**常驻的 Node 进程**——WebSocket、Yjs 权威副本、
Agent 宿主都活在里面。只把 `dist/` 传上去会得到一个能打开、但画布空白、
AI 永远"连接中"的页面。

**2. 它没有登录。** 谁打开这个 URL，谁就能驱动 Agent，烧的是你的 DeepSeek 额度，
也能读到别人房间的画布（房间名就是 URL 参数，猜得到）。公网放出去之前
至少加一道 HTTP Basic（`deploy/nginx-apps.conf` 里注释着现成的两行）。

**3. 知识图谱数据是 CC BY-NC-SA 4.0。** 非商业用途可以公开部署，
署名要留（页面右下角已经带了）。要商用得换一份数据。

## 步骤

```bash
# 1) 服务器上拉代码
git clone https://github.com/chopinfeng/CanvaAI /srv/canvai
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
#    把 deploy/nginx-apps.conf 里的 location 块并进 xiaopingfeng.com 的 server 段
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
BASE=https://xiaopingfeng.com/apps
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
