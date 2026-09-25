# 元数据与代码定位

Markdown 正文是事实描述的唯一来源。元数据放在 frontmatter 的 `knowledge` 下；不另存结论 JSON、逐文件哈希或完成度账本。以下格式用于单仓和跨仓，按仓库标识组织路径。

## 字段

| 字段 | 要求与含义 |
|---|---|
| id | 必填；稳定且在当前知识集合唯一，如 `orders.flow.create`；移动文档不改变 id |
| kind | 必填；index、flow、overview、module、rule、interface、data、runbook |
| aliases | 实质文档填写有助检索的真实业务别名或技术标识；没有额外别名可省略，不堆无关关键词 |
| covers | 实质文档必填非空列表；具体写出正文回答的行为或问题，不用“架构”“业务”代替 |
| entrypoints | flow 必填非空列表；每项含 repo、path，存在明确符号时加 symbol；标明本页流程或片段从哪里开始 |
| scope | 实质文档必填；映射 `仓库标识: [文件或目录]`，表示调查相关范围，不表示其内部所有行为已覆盖 |
| sources | 实质文档必填；映射 `仓库标识: [关键依据文件]`；每个文件实际用于支撑正文，不是所有读过的文件 |
| related | 可选；关联知识 id 列表，用于表达子流程、公共规则和相关主题；正文仍说明关系并提供可解析的导航 |
| checked_commits | 可选；映射 `仓库标识: Git提交`，只记实际核对过的提交，作为下次调查线索 |

index 只要求 id、kind；所属层级、仓库映射和输出边界在索引正文说明。不要在每篇文档重复仓库路径注册表。非流程文档无需强造 entrypoints；其关键实现放 sources 和正文代码定位。

## 单仓示例

以下是格式示例，不是某个实际项目的知识；路径和符号必须替换为真实调查结果。

```yaml
---
knowledge:
  id: orders.flow.create
  kind: flow
  aliases: [下单, 创建订单, "POST /orders"]
  covers:
    - 创建订单的校验、持久化与事件发布顺序
    - 发布事件失败后订单保留的状态
  entrypoints:
    - repo: orders
      path: src/http/orders.ts
      symbol: createOrder
  scope:
    orders: [src/http/orders.ts, src/orders, tests/orders]
  sources:
    orders: [src/http/orders.ts, src/orders/create.ts, tests/orders/create.test.ts]
---
```

即使只有一个仓库，也明确标识为 `orders`，后续系统层能准确引用它。id 统一为 `{仓库标识}.{kind}.{topic}`，topic 段与文件名中的 topic 一致（短横线连接）；DDL 文档为 `{仓库标识}.data.ddl.{schema}`。只用小写字母、数字、点和短横线，不沿用各项目分散的历史命名。

## 跨仓示例

```yaml
---
knowledge:
  id: commerce.flow.order-payment
  kind: flow
  aliases: [订单支付, 支付结果未回写]
  covers:
    - 从创建订单到接收支付结果的跨服务链路
    - 两侧如何通过订单标识关联消息
  entrypoints:
    - repo: orders
      path: src/http/orders.ts
      symbol: createOrder
  scope:
    orders: [src/orders, src/events, src/http/orders.ts, config]
    payments: [src/consumers, src/payments, config]
  sources:
    orders: [src/http/orders.ts, src/orders/create.ts, src/events/payment-result.ts]
    payments: [src/consumers/order-created.ts, src/payments/execute.ts]
  related: [orders.flow.create, payments.flow.execute, orders.flow.apply-payment-result]
---
```

scope/sources 的仓库标识在索引仓库表中解析。sources 只列实际读取且有依据的文件。不可访问的仓库可以在索引和外部边界中出现，但不能填虚构路径或核对版本；尚未调查的后续链路保持缺口。

## 正文如何落到代码

单仓优先使用相对当前 Markdown 文件的真实链接，再给出符号和职责：

```markdown
[createOrder](../../../src/http/orders.ts) 接收 HTTP 输入并调用订单应用服务。
```

跨仓使用 `仓库标识 + 仓库相对路径 + 符号` 作为便携定位，例如 ``payments:src/consumers/order-created.ts :: handleOrderCreated``。这是定位文本，不是假装能点击的 URI。Agent 先查索引的仓库映射，再在已提供的 checkout 搜索符号。已有真实代码托管地址时可附可用链接，不猜远程地址或分支。

正文各关键步骤必须说明代码负责什么。sources 提供文件级依据，不能代替结论旁的定位。行号可补充，但不作为唯一定位方式；不要复制大段源码充当知识。

related 中的 id 必须能找到对应文档；未建文档记入待调查表，不填悬空关联。索引链接必须存在，维护文档移动时同步更新链接。

## 范围和检查位置

scope 使用仓库相对字面量文件/目录，不使用 glob、个人机器绝对路径或越过仓库的 `..`。涵盖相关入口、调用方、状态读写、配置和测试；不要只跟踪引用片段，也不要惯性填整个仓库。Git 枚举遵守忽略规则，同时保留已跟踪文件和未忽略的新文件。

checked_commits 只辅助选择 Git 差异范围，不证明语义正确，不替代本次工作区核对。不知道上次提交时省略，直接调查当前代码。审查包含未提交修改时，在正文证据边界或维护记录说明；不能把 HEAD 当作这些修改的准确版本。只读审查、未调查的仓库和未核对的文档不推进检查位置。

不填 `confidence: 100%`、`coverage: complete` 或自动 `reviewed: true`。已发现、已调查、尚未查清在索引明确区分；字段齐全只证明文档有结构。
