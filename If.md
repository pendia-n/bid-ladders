# BidLadders Proof of Concept

## English

### Product thesis

BidLadders is a product-level marketplace and discovery board for small internet businesses, including products with `$0` MRR. A seller lists one product, not an entire Stripe account or automatically an entire LLC. A buyer can discover the listing, make an offer, negotiate, complete due diligence, coordinate third-party escrow, and record the outcome inside the app.

The product combines two mechanics:

- Trust-oriented product data: the seller enters a product name and URL, then confirms the exact Stripe Product and Price IDs that belong to that listing.
- Outbid-style discovery: sellers can pay for a temporary higher position in a scarce homepage ranking.

The product name is only a search anchor. Confirmed Stripe IDs are the source-of-truth boundary for MRR. A single Stripe account may contain several products and must be filterable without attributing unrelated revenue to the listing.

### Homepage and catalog

The homepage contains exactly 330 visible positions. It is one global ranking rendered into two visual columns of 165 positions each:

```text
Left column      Right column
1                2
3                4
5                6
...              ...
329              330
```

There is no homepage pagination. Paid placements appear above free placements and are visibly labeled. Free listings fill remaining positions by earliest original listing time. Listings beyond rank 330 remain searchable and browsable on `/mrr`.

Paid ranking rules:

- When no paid rank exists, the first boost costs `$2`.
- When paid ranks exist, a seller chooses a paid position to beat and pays at least `$0.50` above that position's current bid.
- A listing can occupy only one rank.
- Equal bids use successful payment time, then listing ID, as deterministic tie-breakers.
- The initial proposed bid duration is seven days; the final duration must be displayed before payment.

### Seller path

The seller signs up with a unique username and strong password. Optional TOTP strengthens account security. The seller creates one product listing with:

- product URL;
- product name;
- short summary;
- asking price;
- operating costs;
- assets included in the sale;
- MRR state: unknown, `$0`, or verified;
- long description when MRR is `$0`.

Stripe verification is progressive. The seller can save a draft before connecting Stripe. To verify, the seller provides a restricted read-only Stripe key, BidLadders searches candidate Products and Prices, and the seller confirms exact Product and Price IDs. The key is never shown again after submission and must be encrypted at rest.

The listing is not automatically treated as an entity sale. The deal terms define which product assets transfer. The seller keeps other products and the legal entity unless a later signed agreement says otherwise.

### Buyer path

Buyers are first-class users, not anonymous contact forms. A buyer signs up with a unique username and strong password, may enable TOTP, and completes a buyer profile:

- legal or company name;
- role and authority to negotiate;
- country and timezone;
- acquisition budget range;
- whether buying personally or through a company;
- acceptance of buyer and confidentiality terms.

Formal KYC is deferred until the third-party escrow provider requires it. A buyer selects `Make an offer`, enters an offer amount and message, and opens a deal conversation with the seller.

### Deal workflow

BidLadders owns the deal record even when buyer and seller also use WhatsApp or email:

```text
Inquiry -> Offer -> Conversation -> NDA -> LOI -> Due diligence
       -> APA -> Escrow funded -> Asset transfer -> Accepted -> Completed
```

The app stores messages, offer history, files, document statuses, and system events in D1. External messaging is optional, but the offer, signed documents, escrow status, and completion confirmation must be recorded in BidLadders.

BidLadders does not hold acquisition funds in the Worker, Stripe balance, bank account, or crypto wallet in the MVP. The first deals use a named third-party escrow provider with manual concierge coordination. The app links the deal to escrow, records escrow status, and later records the success fee.

### Payments

Bid rank payments go directly to the BidLadders platform Stripe account. The Worker creates a Stripe Checkout Session, stores listing/rank/bid metadata, verifies the webhook, and idempotently activates the bid.

Stripe Connect is not required for listing or seller Stripe verification. Connect becomes relevant only if BidLadders later processes acquisition funds and routes payouts to sellers. Success fees begin as seller invoices or Checkout Sessions after a completed sale, with the fee obligation included in platform terms and deal documents.

Success-fee tiers:

- below `$10,000`: `8%`;
- `$10,000` to below `$50,000`: `3.5%`;
- `$50,000` or more: `1.7%`.

### Authentication and security

- Username must be unique.
- Password is hashed before storage in D1.
- Login issues a JWT signed with a secret generated outside the app and stored as a Worker secret.
- JWT expiry is 28 days from each successful sign-in.
- Seller and buyer sessions use the same authentication foundation but role-specific onboarding.
- TOTP is optional for normal use.
- Password reset is allowed only for accounts with TOTP enabled, and requires a valid TOTP challenge.
- Seller Stripe keys must be encrypted, redacted from logs, and never returned to the client.
- Webhook signatures, replay protection, idempotency, authorization, and rate limits are mandatory.

### MVP implementation boundary

The first Worker should deliver:

- sign up, sign in, JWT sessions, password hashing, optional TOTP;
- seller and buyer onboarding;
- listing draft and publish flow;
- free listings and `$0` MRR descriptions;
- Stripe product search and confirmed-ID mapping;
- MRR snapshot and verification status;
- 330-position two-column ladder and `/mrr` catalog search;
- paid rank Checkout Session and webhook;
- buyer offer and in-app deal chat stored in D1;
- responsive dashboard with a clear, entertaining ladder visual.

It should not yet build internal escrow, automatic legal advice, a full broker workflow, or an automated marketplace payout system.

## 中文

### 产品主张

BidLadders 是一个以具体产品为单位的小型互联网业务市场与曝光板，并允许 `$0` MRR 产品上架。卖家出售一个产品，而不是整个 Stripe 账户，也不默认出售整家 LLC。买家可以发现 listing、提出报价、协商、进行尽职调查、协调第三方 escrow，并在应用内记录结果。

产品结合两种机制：

- 信任型产品资料：卖家输入产品名称与网址，再确认该 listing 对应的准确 Stripe Product ID 与 Price ID。
- Outbid 风格曝光：卖家可以付费取得首页稀缺排名中的暂时较高位置。

产品名称只用于寻找候选项。已确认的 Stripe ID 才是 MRR 的真实归属边界。同一个 Stripe 账户可能有多个产品，系统必须支持筛选，不能把无关收入归给 listing。

### 首页与目录

首页准确显示 330 个位置。这是一个全局排名，以左右两个各 165 位的视觉栏显示：

```text
左栏             右栏
1                2
3                4
5                6
...              ...
329              330
```

首页不设分页。付费排名排在免费 listing 之前，并明确标示。免费 listing 按最早原始上架时间填补余下位置。第 330 名之后的 listing 仍可在 `/mrr` 搜寻及浏览。

付费排名规则：

- 没有付费排名时，首次提升费用为 `$2`。
- 已有付费排名后，卖家选择要超越的位置，并至少支付比该位置当前出价高 `$0.50`。
- 一个 listing 只能占一个排名。
- 同价时按成功付款时间，再按 listing ID 作为确定性排序。
- 初步建议排名有效期为七天；最终期限必须在付款前显示。

### 卖家流程

卖家以唯一用户名及强密码注册。可选 TOTP 加强账户安全。卖家为一个产品建立 listing，包括：

- 产品网址；
- 产品名称；
- 简短摘要；
- 叫价；
- 营运成本；
- 交易包含的资产；
- MRR 状态：未知、`$0` 或已验证；
- 当 MRR 为 `$0` 时的长篇说明。

Stripe 验证采用渐进式流程。卖家可以先保存草稿，再连接 Stripe。验证时卖家提供受限只读 Stripe key，BidLadders 搜寻候选 Product 与 Price，卖家确认准确的 Product ID 与 Price ID。提交后不会再次显示 key，并必须加密保存。

Listing 不会自动被视为出售法律实体。交易条款决定哪些产品资产转移。除非之后的签署协议另有规定，卖家保留其他产品及原有法律实体。

### 买家流程

买家是正式用户，不是匿名联系表单。买家以唯一用户名及强密码注册，可启用 TOTP，并完成买家资料：

- 个人法定姓名或公司名称；
- 职位及谈判授权；
- 国家与时区；
- 收购预算范围；
- 个人购买还是代表公司购买；
- 接受买家条款及保密规则。

正式 KYC 延迟到第三方 escrow 服务商要求时再进行。买家选择 `Make an offer`，输入报价与留言，然后与卖家开启交易对话。

### 交易流程

即使买卖双方同时使用 WhatsApp 或 email，BidLadders 仍拥有交易记录：

```text
询问 -> 报价 -> 对话 -> NDA -> LOI -> 尽职调查
    -> APA -> Escrow 入金 -> 资产转移 -> 验收 -> 完成
```

应用在 D1 保存消息、报价历史、文件、文件状态及系统事件。外部通讯可以使用，但报价、签署文件、escrow 状态及成交确认必须记录在 BidLadders。

MVP 不在 Worker、Stripe 余额、银行账户或加密钱包中代持收购资金。第一批交易由指定的第三方 escrow 服务商处理，并由平台人工协助。应用连接交易与 escrow，记录 escrow 状态，并在完成后记录成功交易费。

### 付款

竞价付款直接进入 BidLadders 平台自己的 Stripe 账户。Worker 建立 Stripe Checkout Session，保存 listing、排名及出价 metadata，验证 webhook，并以幂等方式激活出价。

上架或卖家 Stripe 验证不需要 Stripe Connect。只有当 BidLadders 未来直接处理收购资金并向卖家分账时，才需要 Connect。成功交易费初期通过卖家 invoice 或 Checkout Session 在成交后收取，并在平台条款及交易文件中规定收费义务。

成功交易费级距：

- 低于 `$10,000`：`8%`；
- `$10,000` 至低于 `$50,000`：`3.5%`；
- `$50,000` 或以上：`1.7%`。

### 身份验证与安全

- 用户名必须唯一。
- 密码必须在写入 D1 前进行哈希。
- 登录成功后签发 JWT，使用应用外生成并储存在 Worker Secret 的密钥签名。
- 每次成功登录的 JWT 有效期为 28 天。
- 买家及卖家共用身份基础，但使用不同 onboarding。
- TOTP 对正常使用是可选的。
- 只有启用 TOTP 的账户才可以重设密码，并且必须通过有效 TOTP 挑战。
- 卖家 Stripe key 必须加密、从日志中隐藏，且绝不能返回客户端。
- Webhook 签名、重放保护、幂等、授权及频率限制均为必需。

### MVP 实施边界

第一版 Worker 应提供：

- 注册、登录、JWT session、密码哈希、可选 TOTP；
- 卖家与买家 onboarding；
- listing 草稿与发布流程；
- 免费 listing 与 `$0` MRR 说明；
- Stripe 产品搜寻与确认 ID 映射；
- MRR 快照与验证状态；
- 330 位双栏阶梯及 `/mrr` 搜寻；
- 付费排名 Checkout Session 与 webhook；
- 买家报价及储存在 D1 的应用内交易聊天；
- 响应式、清晰并具有娱乐感的阶梯 dashboard。

暂不构建内部 escrow、自动法律意见、完整经纪服务或自动市场分账系统。
