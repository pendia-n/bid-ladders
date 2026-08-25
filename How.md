# BidLadders: How It Should Be Built

## English

### Product architecture

Build BidLadders as a Cloudflare-native application with a deliberately small operational surface:

- Cloudflare Workers: application routes, API, authentication checks, ranking logic, Stripe synchronization, and webhook handling.
- Workers Static Assets or Cloudflare Pages: the web interface.
- D1: users, listings, Stripe resource mappings, MRR snapshots, bids, ranks, inquiries, deals, and audit events.
- R2: listing screenshots, logos, due-diligence files, and export bundles. Private transaction documents must use signed, expiring access URLs.
- Queues: asynchronous Stripe synchronization, email delivery, image processing, and retryable webhook work.
- Cron Triggers: scheduled MRR refresh, expired-access cleanup, ranking snapshots, and stale-listing checks.
- Turnstile: signup, listing, inquiry, and bid abuse protection.
- Worker Secrets: Stripe platform credentials, email credentials, encryption keys, and escrow-provider credentials. Seller restricted keys must be encrypted at rest and never returned to the browser after submission.

Use one Worker deployment initially. Split services only after traffic or security boundaries justify the added complexity.

### Product-level Stripe verification

The Stripe workflow should mimic the useful verification outcome of TrustMRR without assuming that one Stripe account equals one listed product:

1. The seller creates a listing with a product name and URL.
2. The seller supplies a Stripe restricted key with only the minimum read permissions needed. Stripe Connect OAuth can replace manual keys later.
3. The Worker queries Stripe Products and Prices and searches for likely matches using the submitted name.
4. The seller confirms the exact matching Product and Price IDs. Fuzzy name matching must never finalize attribution automatically.
5. BidLadders stores the confirmed IDs and calculates MRR only from subscriptions and invoices attributable to those IDs.
6. The system stores time-stamped MRR snapshots and displays verification time, status, and methodology.
7. If identifiers disappear, permissions are revoked, or data becomes stale, the listing loses its current verified status rather than retaining an old badge indefinitely.

MRR rules must be documented before implementation: active versus trialing subscriptions, annual-plan normalization, discounts, refunds, failed payments, multiple currencies, taxes, one-time payments, and subscription changes. One-time revenue must not be labeled MRR.

### Ranking and the two-ladder interface

There is one ranking, not two independent markets. The ordered positions are rendered into two columns:

```text
Left ladder     Right ladder
1               2
3               4
5               6
...             ...
329             330
```

Homepage ranking rules:

- Maximum 330 visible listings; 165 positions per ladder.
- No pagination on `/`.
- Paid listings first, ordered by valid bid amount descending; deterministic tie-breaker: earlier successful payment, then listing ID.
- Free listings fill remaining positions, ordered by original listing time ascending.
- If no paid position exists, the first valid boost is $2.
- Otherwise, a seller chooses a paid position to beat; minimum payment is that position's bid plus $0.50.
- A listing cannot occupy multiple positions.
- Paid status, bid amount, payment time, and rank changes must be auditable.
- Listings outside rank 330 remain available on `/mrr`, where search and filters are allowed.

Define the bid duration before launch. A practical MVP is a fixed seven-day placement; permanent bids create stale rankings and weak repeat revenue. State expiration and displacement rules before accepting payment.

### Marketplace and deal flow

The first version should facilitate introductions rather than pretend to be a full broker or escrow company:

1. Buyer sends an inquiry through BidLadders.
2. Seller accepts or rejects contact.
3. Parties exchange due-diligence information in a recorded deal room.
4. BidLadders creates or links an escrow transaction with a licensed third-party provider.
5. Buyer funds escrow directly with the provider.
6. Seller transfers the agreed assets under a written asset-purchase agreement.
7. Buyer confirms acceptance or follows the escrow dispute process.
8. The escrow provider disburses funds, and BidLadders records the completed sale and collects the disclosed success fee through an agreed mechanism.

Do not hold buyer funds in the Worker, Stripe balance, company bank account, or a crypto wallet unless legal counsel confirms the required licensing and operating model.

### Core data model

Minimum entities:

- `users`
- `listings`
- `stripe_connections`
- `stripe_product_mappings`
- `mrr_snapshots`
- `rank_bids`
- `ranking_snapshots`
- `inquiries`
- `deal_rooms`
- `escrow_transactions`
- `audit_events`

Every money movement, verification change, and rank change needs an immutable audit event. Keep public listing data separate from encrypted credentials and private due-diligence documents.

### Security and compliance baseline

- Request the least Stripe permissions possible.
- Encrypt seller keys using a key unavailable to D1 itself.
- Redact credentials from logs, analytics, errors, and support tools.
- Verify Stripe and escrow webhook signatures and make handlers idempotent.
- Rate-limit listing creation, search, inquiries, bids, and synchronization.
- Publish Terms, Privacy Policy, ranking disclosures, fee disclosures, refund rules, prohibited listings, and a takedown process.
- Avoid copying TrustMRR or outbid.lol branding, text, layout, or trade dress. Reimplement only general marketplace, verification, and ranking concepts.

## 中文

### 产品架构

BidLadders 应采用 Cloudflare 原生架构，并尽量缩小初期营运复杂度：

- Cloudflare Workers：应用路由、API、身份检查、排名逻辑、Stripe 同步及 webhook。
- Workers Static Assets 或 Cloudflare Pages：网页界面。
- D1：用户、listing、Stripe 资源映射、MRR 快照、出价、排名、查询、交易及审计记录。
- R2：产品截图、Logo、尽职调查文件及导出资料包。私人交易文件必须通过有期限的签名网址访问。
- Queues：异步 Stripe 同步、邮件、图片处理及 webhook 重试。
- Cron Triggers：定时更新 MRR、清理过期权限、保存排名快照及检查过期 listing。
- Turnstile：防止注册、上架、询问及竞价滥用。
- Worker Secrets：平台 Stripe 凭证、邮件凭证、加密密钥及 escrow 服务凭证。卖家的 Stripe restricted key 必须加密保存，提交后不得再传回浏览器。

初期只部署一个 Worker。只有在流量或安全边界确实需要时才拆分服务。

### 产品级 Stripe 验证

Stripe 流程应复制 TrustMRR 有价值的“验证结果”，但不能假设一个 Stripe 账户只对应一个产品：

1. 卖家用产品名称及网址建立 listing。
2. 卖家提供只有最低必要读取权限的 Stripe restricted key；未来可改用 Stripe Connect OAuth。
3. Worker 查询 Stripe Products 与 Prices，并以卖家填写的名称寻找可能匹配项。
4. 卖家确认准确的 Product ID 与 Price ID。模糊名称匹配绝不能自动完成收入归属。
5. BidLadders 保存确认后的 ID，只计算可归属于这些 ID 的 subscriptions 与 invoices。
6. 系统保存带时间戳的 MRR 快照，并公开验证时间、状态及计算方法。
7. 若 ID 消失、权限被撤销或资料过期，listing 应失去当前已验证状态，而不是永久保留旧徽章。

开发前必须明确 MRR 规则，包括 active 与 trialing、年费方案月度化、折扣、退款、失败付款、多币种、税项、一次性付款及订阅变更。一次性收入不得标示为 MRR。

### 排名与双阶梯界面

系统只有一个全局排名，不是两个独立市场。排名按以下方式显示为左右两栏：

```text
左阶梯          右阶梯
1               2
3               4
5               6
...             ...
329             330
```

首页规则：

- 最多显示 330 个 listing，每边 165 个位置。
- `/` 首页不设分页。
- 付费 listing 优先，并按有效出价从高至低排列；同价时先比较成功付款时间，再比较 listing ID。
- 免费 listing 填补剩余位置，并按原始上架时间从早到晚排列。
- 没有付费位置时，首次有效提升费用为 $2。
- 已有付费位置后，卖家选择希望超越的位置，最低付款为该位置出价加 $0.50。
- 同一个 listing 不得占据多个位置。
- 付费状态、出价、付款时间与排名变化必须可审计。
- 第 330 名之后的 listing 仍显示于 `/mrr`，该页面可提供搜寻及筛选。

上线前必须规定付费排名期限。MVP 建议采用固定七天；永久竞价会令排名僵化，也削弱重复收入。收款前必须清楚说明到期与被超越规则。

### 市场与交易流程

第一版应协助买卖双方建立联系，而不是假装自己已经是完整经纪商或 escrow 公司：

1. 买家通过 BidLadders 发出询问。
2. 卖家接受或拒绝联络。
3. 双方在有记录的交易资料室交换尽职调查资料。
4. BidLadders 通过有牌照的第三方 escrow 服务建立或连接交易。
5. 买家直接向 escrow 服务商付款。
6. 卖家依照书面资产购买协议转移约定资产。
7. 买家确认接收，或按 escrow 争议流程处理。
8. Escrow 服务商放款，BidLadders 记录成交，并按已披露机制收取成功交易费。

除非法律顾问确认所需牌照及营运模式，否则不得用 Worker、Stripe 余额、公司银行账户或加密钱包代为持有买家资金。

### 核心数据模型

最低限度应包括：

- `users`
- `listings`
- `stripe_connections`
- `stripe_product_mappings`
- `mrr_snapshots`
- `rank_bids`
- `ranking_snapshots`
- `inquiries`
- `deal_rooms`
- `escrow_transactions`
- `audit_events`

每一笔资金、验证状态与排名变化都应产生不可变审计事件。公开 listing 资料必须与加密凭证及私人尽调文件分开保存。

### 安全与合规底线

- Stripe 权限必须最小化。
- 卖家密钥必须以 D1 无法直接取得的密钥加密。
- 日志、分析、错误及客服工具不得出现凭证。
- 验证 Stripe 与 escrow webhook 签名，并确保重复事件不会重复执行。
- 限制上架、搜寻、询问、出价及同步频率。
- 发布服务条款、隐私政策、排名披露、费用披露、退款规则、禁售项目及下架程序。
- 不复制 TrustMRR 或 outbid.lol 的品牌、文字、页面设计或整体商业外观，只重新实现通用的市场、验证与排名概念。
