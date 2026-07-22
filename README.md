# Key · Pool · Account · Proxy 数据流演示台

一个**可视化 LLM API 网关请求链路**的操作台 Demo。

真实的网关（One API / New API / claude-relay 这类）里，一次调用要穿过四层实体：

```text
                 绑定(priority/weight)      路由策略            出口
  client ──api key──▶  Key  ──────────────▶  Pool  ─────────▶  Account  ─────▶  Proxy  ──▶  upstream
                        │                     │                  │                │
                   限流/配额/模型白名单    成员+权重+重试     供应商凭证/健康度    落地 IP/地区
```

这四层里任何一层出问题（密钥超配额、池里没有健康成员、账号被上游 429、代理挂掉），
表现出来都只是客户端收到一个错误码。这个 Demo 把整条链路摊开画在画布上，
让「请求到底卡在哪一跳」变成肉眼可见的事情：

- 后端是一个**流量模拟器**，按 tick 生成请求、执行真实的路由/重试/熔断逻辑，通过 WebSocket 推送每一条 trace；
- 前端用 React Flow 把拓扑画成四列有向图，**请求经过的节点会脉冲、边上会跑粒子**，底部是实时请求流；
- 所有实体都可以在右侧检查器里**编辑**，边可以**拖拽建立/删除**，改动立刻影响下一秒的模拟结果。

没有任何真实的上游调用，也没有真实凭证——全部是本地内存里的模拟数据。

---

## 快速开始

```bash
pnpm install          # 安装 workspace 依赖
pnpm dev              # 同时启动模拟器 (127.0.0.1:8787) 和前端 (127.0.0.1:5173)
```

打开 <http://127.0.0.1:5173> 即可。模拟器默认就是**运行中**的（`rps=7, chaos=0.02`），
所以页面一加载就有流量在跑。

单独启动：

```bash
pnpm dev:server       # 只跑 Node 模拟器（tsx watch）
pnpm dev:web          # 只跑 Vite 前端（/api 与 /ws 会代理到 8787）
pnpm typecheck        # shared + server + web 三个包的 tsc --noEmit
pnpm build            # 构建前端产物
```

模拟器端口可用环境变量覆盖：`PORT=9000 HOST=0.0.0.0 pnpm dev:server`
（改端口后记得同步 `web/vite.config.ts` 里的 `SERVER_ORIGIN`）。

---

## 目录结构

```text
.
├── shared/src/                 # 前后端共用的纯 TypeScript，无运行时依赖
│   ├── types.ts                #   领域模型：KeyEntity / PoolEntity / AccountEntity / ProxyEntity
│   │                           #   RequestTrace / SimConfig / GlobalStats / HealthStatus …
│   ├── protocol.ts             #   线协议：ServerEvent 联合类型 + REST 路由清单
│   ├── constants.ts            #   中英文标签、模型列表、画布几何、TICK_MS、缓冲区大小
│   └── utils.ts                #   edgeId() / createMetrics() / formatMs() / clamp() …
│
├── server/src/                 # Node 模拟器（express 4 + ws）
│   ├── index.ts                #   HTTP 路由 + WebSocket 广播 + 生命周期
│   ├── simulator.ts            #   核心：按 tick 生成流量、routeRequest 全链路、重试/熔断/指标
│   ├── store.ts                #   GraphStore：增删改查、绑定校验、状态重算
│   ├── seed.ts                 #   种子拓扑：7 密钥 / 6 池 / 16 账号 / 7 代理
│   └── rng.ts                  #   可复现的 mulberry32 随机数
│
└── web/src/                    # React 18 前端（Vite 6 + @xyflow/react 12 + zustand 5）
    ├── App.tsx                 #   应用外壳：栅格布局、WebSocket 生命周期、全局快捷键、错误边界
    ├── lib/                    #   数据层
    │   ├── store.ts            #     zustand store（唯一状态源）+ trace 批处理
    │   ├── api.ts              #     REST 封装
    │   ├── socket.ts           #     自动重连 WebSocket（500ms → 5s 退避）
    │   ├── graph.ts            #     GraphState → React Flow 节点/边 + dagre 自动布局
    │   └── format.ts           #     状态/结果/供应商的中文标签与图标
    ├── components/             #   UI 原子组件（StatusDot / Sparkline / MetricBar / Gauge / 表单…）
    ├── nodes/                  #   四种节点卡片 + NodeShell 共用外壳
    ├── edges/                  #   FlowEdge：贝塞尔连线 + 流量粒子
    ├── canvas/                 #   FlowCanvas：React Flow 装配、拖拽连线、自动布局
    ├── panels/                 #   TopBar / Palette / Inspector / TraceLog
    └── styles/theme.css        #   全部设计令牌（CSS 变量），组件不允许硬编码颜色
```

---

## 界面布局

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ TopBar   品牌 · 连接状态 · 全局指标 · 模拟器开关/注入/重置/参数                │ 48px
├───────────┬──────────────────────────────────────────────┬───────────────────┤
│ Palette   │  FlowCanvas                                  │  Inspector        │
│ 概览      │    key ▸ pool ▸ account ▸ proxy 四列有向图     │  选中实体的        │
│ 筛选      │    节点脉冲 / 边上跑粒子 / 链路高亮            │  全部可编辑字段    │
│ 状态图例  │                                              │  + 指标 + 备注     │
│ 图例/新建 │                                              │  未选中时显示系统概览 │ 1fr
├───────────┴──────────────────────────────────────────────┴───────────────────┤
│ TraceLog  最近 60 条请求流 · 选中 trace 的逐跳轨迹与尝试记录 · 事件日志         │ 220px
└──────────────────────────────────────────────────────────────────────────────┘
  220px                          1fr                             320px
```

窗口 < 1280px 时左侧 Palette 收成 64px 图标栏；< 1024px 时 Inspector 变成覆盖在画布上的抽屉，
选中节点时滑出、点击空白处（或右上角 ×）收起。

### 四列分别是什么

| 列 | 颜色 | 实体 | 承担的职责 |
| --- | --- | --- | --- |
| Key | 琥珀 | `KeyEntity` | 客户端凭证。持有 RPM 限流、Token 配额、模型白名单、流量权重；通过 `bindings`（`priority` + `weight`）指向一个或多个池 |
| Pool | 紫 | `PoolEntity` | 路由池。持有成员账号列表、路由策略、粘滞会话、最大重试次数、并发上限、备用池 `failoverPoolId` |
| Account | 青 | `AccountEntity` | 上游账号。真正持有供应商凭证（Anthropic / OpenAI / Gemini / Bedrock / Azure / DeepSeek），有自己的限流、配额、健康度与熔断状态 |
| Proxy | 翠绿 | `ProxyEntity` | 出口代理。决定落地 IP 与地区（HTTP / HTTPS / SOCKS5，住宅/机房/移动），可被多个账号复用 |

边只允许从左往右建立：`key → pool`、`pool → account`、`account → proxy`。
从节点右侧的把手拖到下一列节点左侧的把手即可绑定；选中一条边按 `Delete` / `Backspace` 即可解绑。
池的 `failoverPoolId` 会额外画一条虚线（标签「故障转移」）。

### 四条基数约束（cardinality）

三条链路边各有**固定且被服务端强制**的基数，顶栏的四枚徽标对应下面四条规则：

| 关系 | 基数 | 权威存储 | 含义 |
| --- | --- | --- | --- |
| Key ↔ Pool | **多对多** | `KeyEntity.bindings` | 一个密钥可绑定多个池，一个池也可被多个密钥绑定 |
| Pool → Account | **一对多** | `PoolEntity.members`（唯一真源） | 一个池独占持有多个账号 |
| Account → Pool | **至多一个** | 同上（`account.poolId` 仅为派生反向引用） | 一个账号至多归属一个池，`0` 也是合法状态（未分配 / 未分配账号不接收任何流量） |
| Account → Proxy | **多对一** | `AccountEntity.proxyId` | 一个账号至多绑定一个代理，一个代理可被多个账号共用 |

核心不变式：**任一账号至多属于一个池**。`PoolEntity.members` 是唯一真源，
`AccountEntity.poolId` 只是由 `store.syncAccountPoolRefs()` 在每次改动后重算的派生字段——
`PATCH /api/entities/account` 会忽略客户端传入的 `poolId`，归属只能通过 bind/unbind
或对池的 `members` 打补丁来改变。把一个池的连线拖到别的池已持有的账号上，是一次**迁移**
（整体从旧池移到新池）而不是报错；未分配账号（`poolId=null`，如种子里的 `acc_free_1`）
是合法且有意义的零状态，加入某个池之前不参与任何调度。

### 七种健康状态

`healthy` 健康 · `degraded` 降级 · `throttled` 限流 · `exhausted` 配额耗尽 ·
`cooldown` 熔断冷却 · `disabled` 已停用 · `offline` 离线。

状态由服务端每 tick 重算（`store.recomputeStatus`），规则大致是：
手动停用 → `disabled`；代理 `health.alive=false` → `offline`；账号在熔断窗口内 → `cooldown`；
配额用尽 → `exhausted`；RPM 触顶 → `throttled`；池里没有可服务成员 → `offline`，
不足半数 → `degraded`；滚动错误率 > 20% 或延迟超过基线 2.5 倍 → `degraded`。

---

## 六种路由策略

池按 `strategy` 在**可用成员**（启用 + 状态可服务 + 不在本次重试黑名单里）之间选账号。
每一跳选择的理由都会写进 `trace.path[].reason`，在底部的 trace 详情里能直接读到。

| 策略 | 值 | 行为 | 适用场景 |
| --- | --- | --- | --- |
| 轮询 | `round-robin` | 游标在**成员列表**上前进（持久化在池上），从游标位置起找第一个可用成员 | 成员能力相同，追求绝对均摊 |
| 权重 | `weighted` | 按 `member.weight` 占比抽样，理由里带命中百分比 | 大小号混用、灰度放量 |
| 最低延迟 | `least-latency` | 取 `health.latencyMs` 最小的成员 | 跨区多账号，优先就近 |
| 最少使用 | `least-used` | 取 `metrics.requests` 最小的成员 | 配额均衡消耗 |
| 优先级故障转移 | `priority-failover` | 按 `member.priority` 升序取第一个可用成员 | 主备结构，主号活着就不用备号 |
| 随机 | `random` | 均匀随机 | 打散上游侧的会话亲和 |

### 一次请求的完整判定顺序

1. **密钥闸门**：停用或已过期（`expiresAt`）→ `key-disabled` (403)；RPM 或并发触顶 → `key-rate-limited` (429)；
   配额耗尽 → `key-quota-exceeded` (402)。
2. **选池**：`bindings` 按 `priority` 升序、`weight` 降序排列，取第一个「启用、可服务且未超过 `maxConcurrency`」的池。
   全都不可用时，若开启了故障转移，则溢出到某个池的 `failoverPoolId`（trace 里会出现两个 pool 跳）；
   否则 → `pool-unavailable` (503)。没绑任何池 → `no-pool` (503)。
3. **选账号**：按策略挑一个候选（池开启 `stickySession` 时优先复用该密钥上次命中的账号）。
   候选只排除「停用 / 离线 / 熔断中」的成员——限流与配额是上游给出的 429/402，要先选中再被拒绝，
   这样重试才有东西可以转移。池内没有可用成员时同样尝试溢出到备用池，仍然没有 → `no-account` (503)。
4. **账号闸门**：RPM 或并发触顶 → `account-rate-limited` (429)；配额耗尽 → `account-quota-exceeded` (402)。
5. **出口**：账号绑了代理就走代理，代理不可达 / 丢包命中 / 并发触顶 → `proxy-error` (503)。
6. **上游调用**：按 `reliability`、`chaos`、`latencyScale` 掷骰子；失败 → `upstream-error` (502)，
   耗时超过 8s → `timeout` (504)；成功 → 200 并累加 token 用量。
7. **重试**：`account-rate-limited` / `account-quota-exceeded` / `upstream-error` / `proxy-error` / `timeout`
   是可重试结果，在同一个池内换一个没试过的账号，最多重试 `pool.maxRetries` 次。
   每次尝试（包括最后成功的那次）都会记进 `trace.attempts`。
8. **熔断**：账号连续失败 3 次即进入 8 秒冷却（`cooldown`），期间不参与选路，冷却结束自动恢复。

> `trace.poolId / accountId / proxyId` 记录的是**最后一次**尝试的实体，
> 完整过程在 `trace.path`（逐跳）和 `trace.attempts`（逐次尝试）里。

---

## 模拟器参数

顶栏右侧的滑块面板（`SlidersHorizontal` 图标）对应 `SimConfig`：

| 参数 | 范围 | 含义 |
| --- | --- | --- |
| `running` | on/off | 主开关。关掉后不再自动生成流量，但仍可手动注入 |
| `rps` | 0 – 80 | 全局目标请求数/秒，按各密钥的 `trafficWeight` 分配 |
| `chaos` | 0 – 50% | 在账号/代理固有可靠性之上叠加的额外失败概率 |
| `latencyScale` | 0.25 – 3× | 全链路模拟延迟的倍率 |
| `failoverEnabled` | on/off | 关掉后：池内不再重试、也不再溢出到备用池，失败立即返回 |
| `rateLimitEnabled` | on/off | 关掉后：不再检查密钥 / 池 / 账号 / 代理的 RPM 与并发上限 |

默认拓扑在默认参数下一分钟内可以观察到的现象：

- `合作伙伴沙箱`（RPM 150、配额只剩 10 万 token）很快翻成 `exhausted` / `throttled`（402 / 429）；
- `acc_ant_3`（Anthropic 团队号 EU）在 30 秒左右耗尽 Token 配额变成 `exhausted`；
- 走「香港 · 中转（故障）」代理的 `acc_bed_1` 会不断 `proxy-error` → 熔断 `cooldown` → 恢复；
- `备用池 Claude` 长期停在 `degraded`；
- 最低延迟池会在 DeepSeek 和 Gemini 之间来回摆动；
- `实验池 · 均摊`（`least-used`）与 `影子池 · 随机`（`random`）分别演示剩下的两种策略。

把 `rps` 拉到 40+ 或 `chaos` 拉到 20%+，还能额外看到 `no-account`、`pool-unavailable` 和跨池溢出。

---

## 快捷键

| 按键 | 作用 |
| --- | --- |
| `Space` | 启动 / 暂停流量模拟器 |
| `I` | 立刻注入 5 条请求（模拟器暂停时也有效，适合单步观察） |
| `L` | 收起 / 展开底部实时请求流 |
| `M` | 显示 / 隐藏画布小地图 |
| `Esc` | 取消选中，并清除画布上高亮的链路 |
| `Delete` / `Backspace` | 删除选中的节点（连同其全部关联）或选中的边（解绑） |

输入框、下拉框、文本域获得焦点时快捷键自动失效。

其他交互：点击底部任意一条请求 → 该请求走过的节点和边在画布上高亮；
点击画布空白处 → 取消高亮；右下角有「自动布局 / 适应视图 / 小地图」。

---

## API

REST 前缀 `/api`，WebSocket 路径 `/ws`，服务监听 `127.0.0.1:8787`。
Vite dev server 会把这两个路径代理过去，所以前端始终用同源相对路径请求。

### REST

| 方法 | 路径 | 请求体 | 响应 |
| --- | --- | --- | --- |
| `GET` | `/api/state` | — | `{ state, config, stats }` |
| `POST` | `/api/entities/:kind` | `Partial<Entity>` | `201` + 新建的 `Entity` |
| `PATCH` | `/api/entities/:kind/:id` | `Partial<Entity>` | 更新后的 `Entity` |
| `DELETE` | `/api/entities/:kind/:id` | — | `{ ok: true }`，同时解除全部关联 |
| `POST` | `/api/entities/:id/move` | `{ position: { x, y } }` | `Entity` |
| `POST` | `/api/bind` | `{ source: { kind, id }, target: { kind, id } }` | `{ ok: true }` |
| `POST` | `/api/unbind` | 同上 | `{ ok: true }` |
| `POST` | `/api/sim` | `Partial<SimConfig>` | 完整的 `SimConfig` |
| `POST` | `/api/inject` | `{ keyId?, count?, model? }` | `{ traces: RequestTrace[] }` |
| `POST` | `/api/reset` | — | `{ state, config, stats }` |
| `GET` | `/api/traces?limit=n` | — | `{ traces: RequestTrace[] }` |

`:kind` 用单数：`key` / `pool` / `account` / `proxy`。PATCH 的字段是白名单过滤的，
未知字段静默忽略，`rateLimit` / `quota` / `health` 走深合并，`failoverPoolId` 不允许指向自己。
非法请求返回 `{ error: "中文说明" }`，进程不会因为坏输入退出。

```bash
# 看一眼当前拓扑
curl -s http://127.0.0.1:8787/api/state | jq '.state.pools[] | {name, strategy, members: (.members|length)}'

# 暂停模拟器，然后手工打一条请求，观察它的逐跳轨迹
curl -s -X POST http://127.0.0.1:8787/api/sim    -H 'content-type: application/json' -d '{"running":false}'
curl -s -X POST http://127.0.0.1:8787/api/inject -H 'content-type: application/json' -d '{"count":1}' \
  | jq '.traces[0] | {outcome, statusCode, path: [.path[] | "\(.kind):\(.name) — \(.reason)"]}'

# 把某个池切成权重路由
curl -s -X PATCH http://127.0.0.1:8787/api/entities/pool/pool_main \
  -H 'content-type: application/json' -d '{"strategy":"weighted"}'
```

### WebSocket 事件

连接后服务端立刻推一帧 `snapshot`，之后是增量事件（全部是 JSON 文本帧）：

```ts
type ServerEvent =
  | { type: 'snapshot'; state: GraphState; config: SimConfig; stats: GlobalStats }
  | { type: 'patch';    entities: Entity[] }        // 字段有变化的实体，4 次/秒
  | { type: 'removed';  ids: string[] }
  | { type: 'trace';    trace: RequestTrace }       // 每 tick 最多 10 条（inject 必发）
  | { type: 'stats';    stats: GlobalStats }        // 每 tick 一次，4 次/秒
  | { type: 'config';   config: SimConfig }
  | { type: 'log';      level: 'info' | 'warn' | 'error'; message: string; at: number }
```

前端把 trace 攒 100ms 批量入 store，因此边上的粒子和节点脉冲最多有一帧的延迟；
断线后按 500ms → 5s 指数退避自动重连，顶栏的连接指示灯会跟着变。

---

## 一些实现上的取舍

- **服务端是唯一状态源**。前端所有修改都走 REST，服务端回推 `patch`；
  唯一的乐观更新是拖拽位置（本地立即生效 + 120ms 防抖写回），否则拖动会跟手很差。
- **指标是滚动估算**，不是精确统计：`rpm` 是平滑后的一位小数，`inFlight` 由利特尔法则推导，
  `metrics.history` 固定 40 个桶（每模拟秒滚动一次），`stats.timeline` 保留 60 个点。
- **zustand v5 的选择器必须返回稳定引用**。store 里所有派生数据都用 `useMemo` 或
  `useNodePulse` / `useEdgePulse` 这类返回原始值的 hook，避免选择器里现造数组导致无限重渲染。
- **样式全部来自 `theme.css` 的 CSS 变量**。节点/边/面板通过 `data-kind` 拿到 `--accent`，
  通过 `data-status` 拿到 `--status-color`，没有任何硬编码颜色。
- **尊重 `prefers-reduced-motion`**：边上的粒子会退化成一次短暂的整条路径闪烁，
  节点脉冲与过渡动画全部关闭。
