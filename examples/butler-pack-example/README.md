# 示例 bundle：`@dsh-external/butler-pack-example`

这是一个**可安装的 DSH bundle 示例**，演示如何通过管家的对外接口
（`butlerExtensions`，`schemaVersion: 1`）注册能力包与通道适配器。它只依赖管家，
不依赖任何平台 SDK，也不建立连接。

完整契约见管家仓库 [`docs/extension-api.md`](../../docs/extension-api.md)。

## 它注册了什么

| 类型 | id | 说明 |
| --- | --- | --- |
| 能力包 | `example-weekly-review` | 每周回顾的四步工作流 + 证据要求；触发词命中时才展开进提示词，也可以 `butler_pack show` 查看 |
| 通道适配器 | `example-outbox` | **只声明、不投递**：`isReady()` 恒为 `false`，`send()` 明确返回失败并说明原因 |

两者都带 `schemaVersion: 1`。校验失败时管家抛 `Error`，信息以「管家扩展：」开头并
指出期望值，本示例会清掉半注册状态后放弃，不影响其他插件。

## 安装（本机开发用法）

```powershell
# 在 DSH 会话里（插件页 / plugin_manager）：
#   install_bundle  target=E:\opendots\dsh-butler\examples\butler-pack-example
```

安装后需要启用该 bundle（或重新加载宿主）。Cordis Loader 会按
`cordis.patch.yml` 插入一行 `id: butler-pack-example`。

> 注意：本示例没有自己的 `lib/` 构建产物，`index.js` 就是入口；如果你把它拷到
> 别的目录，保持 `index.js`、`cordis.patch.yml`、`package.json` 三个文件在一起。

## 装好之后怎么验证

1. `butler_pack {action:"list"}`：能看见 `example-weekly-review`，`source` 为
   `"extension"`（工作台能力包行会显示「扩展注册」）。
2. `butler_pack {action:"show", id:"example-weekly-review"}`：返回四步回顾工作流、
   证据与授权提示；`boundary` 来自内核，不是本 bundle 写的。
3. 触发词命中（例如对管家说“做一下每周回顾”）时，该包说明会进入提示词；不命中时
   只出现在目录里，不占提示词空间。
4. 通道只出现在运行时清单
   （`ctx.get('butlerExtensions', false).list().channels`）里；**没有任何投递发生**，
   因为本示例的适配器从未被调用，也没有任何真实通道被接管。

## 卸载 / 重载

禁用或卸载本 bundle 时，`ctx.effect` 注册的清理函数会释放两个注册：

- 包立刻从 `listPacks()` / `packsSummary()` / 提示词指令段中消失；
- 通道从运行时清单消失。

不需要手工改 `vault/packs/` 或 `state/packs.json`。如果想让**同名 id** 的自己版本
长期生效，可以写 `vault/packs/example-weekly-review.md`——用户 Markdown 包优先级
高于扩展注册包，卸载 bundle 后它仍在。

## 边界（务必读）

- **注册 ≠ 投递。** 通道适配器注册只是让管家知道它存在；管家不会调用 `send`，
  不会替它选目标，不读它的凭据，也不授予任何权限。真正的投递由拥有该适配器的
  宿主按自己的授权执行。
- **包只是建议。** `tools` 是推荐、`permissions` 是提示、`budget` 是重试建议、
  `cost_class` 是服务类别声明；它们不是白名单、批准、硬预算或费用上限。
- **不是持久化配置。** 注册的生命周期等于本 bundle 的加载周期；每次重新加载都要
  重新 `apply` 注册。
- **幂等性靠 disposer。** 同一实例内同 id 重复注册会报错；本示例在
  `ctx.effect` 里逆序释放，重复启用不会叠加。
- **类型提示可选。** 若想获得 `ButlerExtensionService` 等类型，可在本示例的
  `devDependencies` 里加 `@dsh-external/dsh-butler`，然后
  `import type { ButlerExtensionService } from '@dsh-external/dsh-butler/extension'`；
  运行时不需要该依赖。
