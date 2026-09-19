/**
 * 案例页补充：把最近的工程实践追加进中英双语案例（内容工作，零代码风险）
 * 用脚本追加而不是 shell heredoc —— 之前 heredoc 太长被截断过。
 */
import { readFileSync, writeFileSync } from 'node:fs'

const S = 'C:/Users/winner/Desktop/studio-site/src/content/projects/'
const log = []

const ZH = `
## 后期迭代：发布链路、性能门禁与自愈体系

前面写的是"功能怎么做的"，这一段写**"怎么保证它在真实运行中不塌"**——我认为后者更能说明工程素养。

### 一次真实的蓝绿发布与秒级回滚

线上商城实例的运行身份受系统限制、无法重启，新代码无法直接顶上去。于是我用自研零依赖网关（蓝绿加权 + 主动健康检查 + 会话粘性）解决了这个问题：

1. 新代码跑在备用端口 → 网关把权重切过去 → **经网关全链路回归**（健康/分类/列表/详情/登录/规格级加购/运费报价/下单/订单金额拆分/支付/订单列表）
2. 回归发现新实例的购物车**写入成功但读不回来**（读购物车直接 500）→ **立刻把权重切回旧实例**（零停机，几秒完成）
3. 定位根因：\`cartPayload(userId)\` 内部又查了一次购物车，而路由传入的是**购物车 id** → 拿购物车 id 当用户 id 去查 → 查不到就新建一辆空车（所以"写进去读不出来"），建车时还撞唯一约束（所以 500）。**一个参数语义错配同时解释了两个看似无关的症状。**
4. 修复后重新回归通过 → 再切到新版承接流量

**这条回滚能力不是纸面设计，是真救过一次场的。**

### 性能：场景化压测 + SLO 门禁 + 基线归档

不用"打满 QPS"的裸压，而是按真实业务比例施压（列表 50% / 详情 25% / 加购 15% / 购物车 10%），阶梯加压并按 SLO 判定通过与否（可直接接 CI）：

| 并发 | 吞吐 | P50 | P95 | P99 | 故障率 |
|---|---|---|---|---|---|
| 5 | 2,326 req/s | 1ms | 2ms | 5ms | 0.00% |
| 20 | 2,370 req/s | 7ms | 11ms | 15ms | 0.00% |
| 50 | 2,336 req/s | 19ms | 28ms | 29ms | 0.00% |

**这里有个我印象最深的教训**：第一版压测显示"错误率 15%"，看起来像严重故障。我没有急着优化服务，而是注意到**新旧实例的错误率几乎完全相同**（14.50% vs 15.14%）——真故障不可能两边一模一样。追下去发现是我的统计口径错了：把 HTTP 4xx（商品无货导致的合法拒绝）也算成了故障。修正为「只有 5xx 与网络失败计入故障率、4xx 单列为业务拒绝」后，故障率是 **0.00%**。

**先怀疑自己的测量，再怀疑被测对象。**

### 数据自愈：让"周期性重置"不再是定时炸弹

演示数据每 10 分钟重建，而依赖它的服务不会自动恢复，于是反复出现三类故障：商品变"无可售规格"（商城卖不出东西）、购物车留下悬空引用（加购 500）、商品图记录被清空（详情页图画廊消失）。

处理方式是**自愈而非人工救火**：一个每 2 分钟运行的数据巡检（幂等、开销极小）依次完成——补默认规格 → 清理悬空购物车行 → 对齐商品级库存 → 补齐商品图；再加一个每 3 分钟的服务守护。并且用**故障注入**验证：人为清空全部规格与商品图、制造悬空购物车行，一次巡检全部恢复，随后端到端 8/8 商品加购成功。

### 把工程状态写成可交接的文档

\`docs/STATUS.md\` 记录：线上拓扑与每个服务的真实状态、已上线能力清单、**7 项已知问题（含根因与下一步，未验证的明确标注为未验证）**、可复现的验证命令、性能基线、运维手册（重启/灰度/秒级回滚/诊断）、以及我自己总结的 8 条工程方法论。

**其中有一条是："报告里『未通过』比『全绿』更有信息量。"** 这份文档里我如实记录了自己的 5 个缺陷（含一次把外键约束静默关闭、一次把压测工具自己改坏），每个都写明根因与修复——我认为这比一份"全部通过"的报告更能说明问题。
`

const EN = `
## Later iterations: release path, performance gates and self-healing

The earlier sections describe *how the features were built*. This one describes **how I keep it from breaking in real operation** — which I think says more about engineering judgement.

### A real blue/green release with instant rollback

The live storefront instance ran under an identity I could not restart, so new code could not simply be deployed onto it. I solved this with the zero-dependency gateway I had built (blue/green weighting, active health checks, session stickiness):

1. New code on a spare port → shift the gateway weight → **full end-to-end regression through the gateway** (health / categories / listing / detail / login / SKU-level add-to-cart / shipping quote / checkout / order amount breakdown / payment / order list)
2. The regression found the new instance's cart **wrote successfully but read back empty** (and returned 500 on read) → **the weight was shifted straight back to the old instance** (zero downtime, a few seconds)
3. Root cause: \`cartPayload(userId)\` internally looked up the cart again, while the routes passed an already-resolved **cart id** → a cart id was used as a user id → lookup missed → a brand-new empty cart was created (hence "writes but reads empty"), and creating it hit a unique constraint (hence the 500). **A single parameter-semantics mismatch explained two unrelated-looking symptoms.**
4. After the fix the regression passed and the new version was promoted

**That rollback capability was not a paper design — it saved the deployment once.**

### Performance: scenario load testing with an SLO gate and archived baselines

Instead of a raw max-QPS test, traffic follows a realistic business mix (listing 50% / detail 25% / add-to-cart 15% / cart 10%), ramps in stages, and passes or fails an SLO gate that can be wired straight into CI:

| Concurrency | Throughput | P50 | P95 | P99 | Failure rate |
|---|---|---|---|---|---|
| 5 | 2,326 req/s | 1ms | 2ms | 5ms | 0.00% |
| 20 | 2,370 req/s | 7ms | 11ms | 15ms | 0.00% |
| 50 | 2,336 req/s | 19ms | 28ms | 29ms | 0.00% |

**The lesson I remember best from this work**: the first version reported a "15% error rate", which looked like a serious incident. Rather than optimise the service, I noticed that the **old and new instances had almost identical error rates** (14.50% vs 15.14%) — a real failure could not be identical on both. The cause was my own accounting: HTTP 4xx (legitimate out-of-stock rejections) were being counted as failures. Once only 5xx and network errors counted as failures and 4xx was reported separately as business rejections, the failure rate was **0.00%**.

**Suspect your own measurement before you suspect the system under test.**

### Self-healing: so that "periodic reset" stops being a time bomb

Demo data is rebuilt every 10 minutes, and the services that depend on it do not recover on their own. That produced three recurring failures: products becoming "no sellable variant" (the storefront could not sell anything), dangling cart references (500 on add-to-cart), and wiped product image rows (the detail gallery disappeared).

The response was **self-healing rather than firefighting**: a data patrol running every 2 minutes (idempotent and very cheap) fills missing SKUs → purges dangling cart rows → realigns product-level stock → restores product images, supported by a service watchdog every 3 minutes. It is verified by **fault injection**: deliberately wiping every SKU and image and creating a dangling cart row, then confirming one patrol run restores everything and 8/8 products can be added to the cart again.

### Writing the engineering state down as a handover document

\`docs/STATUS.md\` records the live topology and the true state of every service, the list of shipped capabilities, **seven known issues (each with root cause and next step, with unverified items explicitly marked as unverified)**, reproducible verification commands, the performance baseline, an operations runbook (restart / canary / instant rollback / diagnostics), and eight engineering principles I distilled from this work.

**One of them is: "in a report, an honest failure is worth more than an all-green summary."** The document records five defects of my own — including silently leaving foreign-key enforcement disabled, and breaking my own load-testing tool — each with its root cause and fix. I believe that says more than a report where everything passed.
`

try {
  const zf = S + 'furniture-admin.zh.mdx'
  let z = readFileSync(zf, 'utf8')
  if (!z.includes('后期迭代：发布链路')) { writeFileSync(zf, z + ZH, 'utf8'); log.push('中文案例页已追加"后期迭代"章节') }
  else log.push('中文案例页已包含该章节')
  const ef = S + 'furniture-admin.en.mdx'
  let e = readFileSync(ef, 'utf8')
  if (!e.includes('Later iterations: release path')) { writeFileSync(ef, e + EN, 'utf8'); log.push('英文案例页已追加同章节') }
  else log.push('英文案例页已包含该章节')
} catch (err) { log.push('写入失败: ' + err.message) }

console.log(log.map((x) => '   · ' + x).join('\n'))
