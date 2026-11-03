# 对外插件接口：能力包（packs）与通道（channels）

状态：**0.1.0 实现**。接口版本 `schemaVersion: 1`。本文是契约正文，
`src/shared/extension.ts`、`src/host/extensions.ts`、`tests/extensions.test.mjs`
是它的实现与可执行断言；示例 bundle 见
[`examples/butler-pack-example/`](../examples/butler-pack-example/README.md)。

本轮只对外承诺两类扩展：**能力包（packs）** 与 **通道（channels）**。
会话来源（sources）与 UI 插槽（slots）后置，不在 0.1.0 的对外契约内。

---

## 1. 设计原则（先读这一段）

1. **`schemaVersion: 1` 是硬门槛，不是建议。** pack manifest 与 channel adapter
   都必须显式携带 `schemaVersion: 1`。缺失或版本不符直接抛错，错误信息指出
   期望值；内核**不会**猜测、升级或静默降级。
2. **包只是可编辑的工作指引。** `tools` 是推荐不是白名单；`permissions` 是授权提示
   不是批准；`budget` 是重试建议不是硬预算；`cost_class` 是声明不是费用上限。
   包的 `boundary` 由内核生成（`PACK_BOUNDARY`），永远不从 manifest 读取。
3. **通道只是声明存在。** 注册 adapter 不会建立连接、不会读凭据、不会自动选择
   投递目标、不会调用 `send`，也不授予任何权限。注册 ≠ 接管投递。
4. **校验器是纯函数。** `validatePackManifest` / `validateChannelAdapter`
   无 I/O、无宿主服务、无副作用（不调用 `send`/`isReady`，不写文件，不发网络）。
5. **注册失败只影响注册方。** 管家的激活流程用 try/catch 包住扩展接口初始化；
   第三方注册失败只会让它自己拿不到能力，不会拖垮管家。

---

## 2. 快速开始（第三方 bundle）

### 2.1 声明服务依赖

```js
/** DSH bundle 入口（Host 侧）。 */
export const name = '@example/my-pack'

/** 管家激活后才有该服务；Cordis 会等它可用再调用 apply。 */
export const inject = ['butlerExtensions']

export function apply(ctx) {
  // 宽松查找：管家没装/未激活时得到 undefined，不影响本插件其余功能。
  const extensions = ctx.get('butlerExtensions', false)
  if (!extensions) return ctx.logger?.warn?.('[my-pack] 管家扩展服务不可用，本包不注册。')

  const disposers = [
    extensions.registerPack({
      schemaVersion: 1,
      id: 'my-weekly-review',
      title: '我的每周回顾',
      triggers: ['每周回顾', '周复盘'],
      instructions: '……写清步骤、产出与检查方法……',
      evidence: '……每条结论必须引用什么回执/路径……',
      permissions: '……哪些具体动作要先问用户（不是批准）……',
      tools: ['butler_note', 'butler_task'],
      budget: { maxAttempts: 2 },
      cost_class: 'free',
    }),
    extensions.registerChannel({
      schemaVersion: 1,
      id: 'my-outbox',
      title: '我的外发通道',
      isReady: () => false,
      async send(destination, payload) {
        return { ok: false, reason: '本通道未接真实投递' }
      },
    }),
  ]
  // 卸载本插件时释放注册；disposer 幂等。
  ctx.effect(() => () => { for (const dispose of disposers) dispose() }, 'my-pack: butler registrations')
}
```

> 顺序说明：`registerPack` / `registerChannel` 都是**同步**的，失败会当场抛错；
> 上面的示例先收集 disposer 再 `ctx.effect` 登记清理。若某个注册抛错，已成功的
> 那些应由调用方在 catch 里释放（示例 bundle 有完整写法）。

### 2.2 取类型（可选）

类型从包的公开子路径导入，运行时不需要安装管家：

```ts
import type {
  ButlerExtensionService,
  PackManifest,
  ButlerChannelAdapter,
} from '@dsh-external/dsh-butler/extension'

const extensions = ctx.get('butlerExtensions', false) as ButlerExtensionService | undefined
```

`package.json` 已在 `exports` 暴露：

```json
"./extension": { "types": "./lib/types/extension.d.ts", "default": "./lib/extension.js" }
```

第三方 bundle 需要类型时把 `@dsh-external/dsh-butler` 加进 `devDependencies`
（`workspace:` 协议亦可）；**运行时不要 import 管家**，只用 `ctx.get` 拿服务，
否则模块解析会依赖宿主的安装布局。

---

## 3. `butlerExtensions` 服务契约

Cordis 服务名：`'butlerExtensions'`（常量 `BUTLER_EXTENSIONS_SERVICE`）。
取得方式：`ctx.get('butlerExtensions', false)`（宽松查找）。服务对象是冻结的只读
投影，**不包含** `dispose`/`closed` 等宿主侧生命周期方法。

| 方法 | 参数 | 返回 | 错误 |
| --- | --- | --- | --- |
| `schemaVersion` | — | `1` | — |
| `registerPack(manifest)` | `PackManifest`（见第 4 节） | `() => void` 幂等 disposer | 条件见第 4.3 节；错误为 `Error`，信息以 `管家扩展：` 开头。同一实例内重复 id 抛错（含 id 与已有来源）；与内置 id 冲突在校验阶段抛错 |
| `registerChannel(adapter)` | `ButlerChannelAdapter`（见第 6 节） | `() => void` 幂等 disposer | 校验失败/重复 id 抛 `Error`；不调用 `send`/`isReady` |
| `list()` | — | `{ packs: ExtensionPackEntry[], channels: ExtensionChannelEntry[] }`；每次调用返回新的冻结快照 | 永不抛错 |

`list()` 的稳定字段名：

```ts
interface ButlerExtensionList {
  packs: Array<ResolvedPackManifest & {
    source: 'extension'
    enabled: true
    boundary: PackBoundary   // 内核生成，等于 PACK_BOUNDARY
  }>
  channels: Array<ResolvedChannelAdapter & {
    source: 'extension'
  }>
}
```

`ResolvedPackManifest` 把可选字段补全为：`tools: []`、`budget: {}`、
`cost_class: 'unknown'`；`triggers` 可为空数组。

**注册生命周期**：注册返回幂等 disposer；调用后包/通道立即从 `list()`、包读模型
（`listPacks()` / `packsSummary()` / `getPack()` / `matchPacks()` / 指令段）中消失。
管家插件卸载时，宿主侧注册表整体 dispose，所有注册清空。注册**不持久化**：
重新加载插件后需要在 `apply` 里重新注册。

---

## 4. 能力包 manifest（`schemaVersion: 1`）

### 4.1 字段与上限

| 字段 | 必填 | 类型 / 范围 | 说明 |
| --- | --- | --- | --- |
| `schemaVersion` | 是 | 字面量 `1` | 缺失或非 1 抛错 |
| `id` | 是 | `^[a-z][a-z0-9-]{1,31}$`（2..32 字符） | 不得与内核内置 id 冲突（见 4.3） |
| `title` | 是 | 字符串，1..64 字符 | 展示名 |
| `triggers` | 是 | 数组，0..32 项；每项 1..32 字符 | 字面关键词；为空表示只能按 id 主动查看 |
| `instructions` | 是 | 字符串，1..8000 字符 | 工作指引正文（提示词预算的主要来源） |
| `evidence` | 是 | 字符串，1..2000 字符 | 证据要求 |
| `permissions` | 是 | 字符串，1..2000 字符 | 授权提示，**不是批准** |
| `tools` | 否 | 数组，≤24 项；每项 1..160 字符 | 工具推荐，**不是白名单** |
| `budget` | 否 | `{ maxAttempts?: 1..10 整数, note?: 1..500 字符 }` | 重试建议，**不是硬预算** |
| `cost_class` | 否 | `free` \| `local` \| `paid` \| `unknown`，默认 `unknown` | 服务类别声明，**不是费用上限** |

另外：

- 字段值会 `trim()`；`instructions` 等文本字段的空白字符串按“空”拒绝。
- manifest **不接受未声明字段**（例如把 `cost_class` 写成 `costClass` 会报错并列出
  允许字段），避免拼写错误被静默忽略。`budget` 也只接受 `maxAttempts` / `note`。
- 校验通过后的对象是**冻结**的，注册表存的就是它；`list()` 不会把可变引用交出去。
- `boundary` **不是** manifest 字段。注册后的 `PackView.boundary` 来自内核常量
  `PACK_BOUNDARY`；`source` 为 `'extension'`、`enabled` 为 `true`。

### 4.2 校验错误（示例）

错误类型统一为 `Error`，消息以 `管家扩展：` 开头，说明字段与期望值：

```text
管家扩展：能力包 manifest 缺少 schemaVersion；必须显式写 schemaVersion: 1（当前唯一支持的版本）。
管家扩展：能力包 manifest 的 schemaVersion 必须是 1，收到 数字（2）；版本不匹配不做静默降级。
管家扩展：能力包 manifest 的 instructions 太长了：8001 个字符，上限 8000。
管家扩展：能力包 manifest 的 cost_class 必须是 free、local、paid 或 unknown，收到 字符串（"cheap"）。
管家扩展：能力包 manifest 的 budget.maxAttempts 必须在 1..10 之间，收到 0。
管家扩展：能力包 manifest 含 schemaVersion 1 未声明的字段 "costClass"；……
管家扩展：能力包 id "daily" 已被内核内置包占用（来源：builtin）；扩展包不能复用内置 id，请换一个 id。
管家扩展：能力包 id "my-pack" 已在本注册表注册（已有来源：extension），不能重复注册；先调用上一次注册返回的 disposer 释放它。
```

### 4.3 校验顺序与冲突

1. 必须是普通对象（非 `null`/数组/函数）；
2. `schemaVersion` 存在且等于 1；
3. 无未声明字段；
4. `id` 格式 + 不与内核内置 id 冲突；
5. 其余字段逐个校验（第一个失败即抛）；
6. 注册表检查同实例重复 id（校验通过后）——报错含 id 与已有来源
   （`extension`）。

内置 id 的权威来源是 `src/host/packs.ts` 的 `BUILTIN_PACK_IDS`；
`src/shared/packs.ts` 的 `KERNEL_PACK_IDS` 是供“无宿主校验”使用的快照，
测试断言两者一致。新增内置包时两处都要更新。

---

## 5. 与既有包读模型的合并语义

扩展包通过宿主侧 `setExtensionPackSource()` 钩子接入 `src/host/packs.ts` 的读模型
（由 `installButlerExtensions` 接线，卸载时解除）。因此：

| 读接口 | 扩展包行为 |
| --- | --- |
| `listPacks()` / `getPack()` | 返回 `source: 'extension'`、`enabled: true`、`boundary` 来自 `PACK_BOUNDARY` |
| `packsSummary()` | 同上，另有有界 `guidance`（`instructions` 截到 4000 字符，超长置 `truncated`） |
| `enabledPacks()` / `matchPacks()` | 扩展包始终启用；按字面触发词命中 |
| `packInstructions(request?)` | 目录行总包含扩展包 id；传入 `request` 时，只有命中触发词的扩展包才展开正文（与内置包同规则，避免第三方文本无条件占提示词）；不传 `request` 时全部展开 |
| `butler_pack show` | 可读取完整声明（`show` 不受提示词截断影响） |

**优先级（同 id 冲突）：用户 Markdown 包 > 扩展包 > 内置包。**

- 用户 `vault/packs/<id>.md` 覆盖扩展包：读模型显示用户包（`source: 'user'`），
  扩展包内容不出现在提示词；注册表本身仍保留该注册（`list()` 可见），卸载用户
  文件后扩展包重新可见。
- 扩展包与内置 id 冲突**不允许**：注册校验阶段直接拒绝，不会悄悄替换内置包。
- 扩展包的启用状态**跟随注册生命周期**，不受 `state/packs.json` 控制。
  `setPackEnabled(extensionId, …)` 会抛错（信息说明应释放注册或用同 id 用户包覆盖），
  不会假装开关成功。

---

## 6. 通道适配器（`schemaVersion: 1`）

### 6.1 字段

| 成员 | 必填 | 类型 | 说明 |
| --- | --- | --- | --- |
| `schemaVersion` | 是 | 字面量 `1` | |
| `id` | 是 | 与 pack id 同规则：`^[a-z][a-z0-9-]{1,31}$` | 同一注册表内唯一 |
| `title` | 是 | 1..64 字符 | 展示名 |
| `isReady()` | 是 | 函数（返回 `boolean`） | 只读就绪报告；**校验与注册表都不会调用它** |
| `send(destination, payload)` | 是 | 函数，返回 `Promise<{ ok: boolean; receiptId?: string; reason?: string }>` | **校验与注册表都不会调用它** |
| `limits` | 否 | 普通对象（纯声明） | 内核不解释、不展示语义、不执行 |

`destination` 形如 `{ id: string; kind: string }`；`payload` 形如 `{ text: string }`。
校验只检查**存在性与类型**（`isReady`/`send` 是函数），不检查签名细节，也不校验
`isReady` 的返回类型——调用方自行防御。

校验通过的 adapter 记录是冻结的，但 `send`/`isReady` 保持原函数引用（不复制、
不包装）。注册表 `list().channels` 中每项为
`{ ...adapter 声明字段, source: 'extension' }`。

### 6.2 语义边界（重要）

- **只注册，不投递。** 管家不会调用适配器的 `send`，不会为了“测试”调用 `isReady`，
  不会替它选择目标，不会读凭据，不会建立连接，也不会把提醒/消息自动路由过去。
- **不授予权限。** 注册不改变原生权限、精确动作审批、预算或任何执行门。
- **没有默认投递目标。** 真正的投递必须由拥有该适配器的宿主按自己的授权发起。
- **失败自担。** 适配器自己的错误、凭据、限流由适配器负责；管家只记录它“存在”。
- 通道清单目前只通过服务 `list()` 暴露（工作台/概览的通道展示不在本轮范围）。

---

## 7. 生命周期与卸载

```text
管家 apply
  ├─ createButlerExtensions()                注册表实例
  ├─ ctx.provide('butlerExtensions', api)    发布只读服务
  ├─ setExtensionPackSource(...)             接入包读模型
  └─ ctx.effect(() => installation.stop)     卸载时反向清理
       ├─ disposeService()                    服务消失
       ├─ detachPackSource()                  读模型恢复“无扩展”
       └─ registry.dispose()                  所有注册清空

第三方 apply
  └─ ctx.effect(() => disposer)              第三方卸载时释放自己的注册
```

- 两个注册表实例完全独立：`list()` 互不可见，`dispose()` 互不影响。
- disposer 幂等；disposer 不会误删“同 id 重新注册后的新条目”。
- 注册表关闭后 `registerPack`/`registerChannel` 抛错（消息含“注册表已关闭”）。
- 宿主不支持 `ctx.provide` 时：扩展接口 `active: false`、服务不发布、只记 warn；
  管家其余功能照常。
- 服务发布失败时同理：`problem` 字段带原因，`stop()` 仍安全。

---

## 8. 示例 bundle

[`examples/butler-pack-example/`](../examples/butler-pack-example/README.md)：

- `package.json`：`dsh.bundle.patch` 指向随包 `cordis.patch.yml`；
- `cordis.patch.yml`：只插入一行 `id: butler-pack-example`；
- `index.js`：注册 `example-weekly-review` 能力包与 `example-outbox` 通道
  （`isReady: () => false`、`send` 明确失败——只演示注册契约，不接真实投递）；
- 安装：`plugin_manager install_bundle target=examples/butler-pack-example`，
  启用后 `butler_pack list` 可见 `source: 'extension'`，卸载后立即消失。

---

## 9. 错误与测试契约

- 所有校验/注册类错误：`Error` + 消息前缀 `管家扩展：`，包含字段名、收到的值与
  期望值/范围。绝不静默忽略。
- 未声明字段（pack manifest、`budget`）直接拒绝；channel adapter 允许携带实现
  自用的额外属性（类实例常见），只校验声明字段。
- `tests/extensions.test.mjs` 覆盖：版本门槛、各字段上下限、未知字段、重复/内置
  id、disposer、用户包优先级、双实例隔离、服务发布/卸载、`ctx.provide` 缺失、
  示例 bundle 的注册与卸载、内置 id 快照一致性。

```powershell
$env:DSH_CHECKOUT='C:\Users\申俊超\dsh-harness'
$env:DSH_PROFILE_DIR='C:\Users\申俊超\.dsh\profiles\desktop'
node scripts/build.mjs --typecheck
node --test tests/*.test.mjs
```

---

## 10. 已知限制 / 非目标

1. **通道不接管投递**：注册只声明存在；提醒/消息仍走既有原生投递路径。未来若要
   让扩展通道真正投递，需要单独的授权与目标选择机制，不属于 `schemaVersion: 1`。
2. **不持久化**：注册只活在插件加载周期内；重启/重载后由第三方 `apply` 重新注册。
   `state/packs.json` 不记录扩展包开关。
3. **扩展包受用户覆盖**：同 id 用户 Markdown 包优先，且不会报错（这是有意的所有者
   优先规则）；扩展包作者应使用足够唯一的 id 前缀。
4. **不校验行为**：`send` 签名、`isReady` 返回类型只做存在性/函数类型检查；内核
   不调用它们，行为正确性由适配器与宿主负责。
5. **提示词展开规则**：带 `request` 时扩展包只有命中字面触发词才展开正文；`show`
   始终能读到完整声明。`instructions` 上限 8000 字符是单包上限，不保证总提示词
   预算；过多扩展包会触发既有 12000 字符的提示词预览降级。
6. **非目标**：会话来源（sources）、UI 插槽（slots）、通道投递路由、权限授予、
   凭据管理、跨插件同 id 合并。这些不在 0.1.0 对外承诺内。
7. **类型获取**：第三方通过 `package.json` 的 `devDependencies` +
   `@dsh-external/dsh-butler/extension` 子路径拿类型；运行时只依赖 Cordis 服务查找，
   不 import 管家（避免宿主模块解析布局耦合）。
