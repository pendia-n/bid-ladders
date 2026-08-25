# BidLadders: What Happens After Build and Deployment

## English

### Principle

Deployment is the beginning of validation, not completion. The sequence below is designed to test demand before building regulated or operationally expensive infrastructure.

### Phase 0: Before accepting public money

- Freeze the written definitions of listing, verified MRR, paid rank, bid duration, displacement, refund, success fee, and completed sale.
- Decide what is transferred in a normal asset sale: domain, source code, repositories, customer data where lawful, social accounts, documentation, trademarks, and support obligations.
- Obtain legal review for marketplace terms, privacy, Stripe credential handling, paid-ranking disclosures, success-fee enforceability, sanctions/KYC exposure, and whether marketplace or broker rules apply in target jurisdictions.
- Confirm that the chosen Stripe integration and product use comply with Stripe's current terms.
- Do not accept or hold acquisition funds before the escrow model is approved.

### Phase 1: Private deployed alpha

- Deploy one Cloudflare Worker with D1 and static assets to a staging or access-controlled domain.
- Seed fewer than 20 consented test listings; never fabricate sellers, MRR, bids, or completed sales.
- Test one Stripe account containing multiple products and prove that only confirmed Product and Price IDs contribute to each listing's MRR.
- Test $0-MRR requirements, stale verification, revoked keys, annual plans, discounts, refunds, failed invoices, multiple currencies, and deleted Stripe products.
- Test all 330 rank positions with generated test records, including ties, expired bids, displaced bids, and free-list ordering.
- Verify mobile and desktop rendering of the two ladders and confirm that `/` has no pagination while `/mrr` searches the full catalog.
- Add audit logs, backups, restore tests, webhook replay protection, abuse limits, monitoring, and incident alerts.

Exit condition: the product can calculate and explain one listing's MRR, reproduce the rank deterministically, and recover from a failed webhook without manual database surgery.

### Phase 2: Concierge marketplace beta

- Recruit 20 to 50 real founders manually.
- Review every listing before publication.
- Keep listing and verification free.
- Enable small paid-rank bids only after price, duration, expiration, and refund terms are visible.
- Manually qualify buyer inquiries and observe where due diligence fails.
- Record activation, Stripe-connection completion, listing completion, paid-boost conversion, qualified inquiries, seller response time, and deals entering diligence.

Exit condition: founders voluntarily complete verification, some pay for rank, and buyers initiate credible conversations. Page views alone are not validation.

### Phase 3: Learn escrow before automating it

Learn and document these concepts:

- escrow transaction creation and party identity;
- buyer funding methods and chargeback risk;
- inspection period and acceptance criteria;
- asset-transfer checklist;
- domain and repository transfer;
- customer-data transfer and privacy obligations;
- dispute evidence and arbitration process;
- cancellation and refund rules;
- fee allocation among buyer, seller, BidLadders, and escrow provider;
- supported countries, currencies, minimum amounts, KYC/KYB, sanctions screening, and payout timing.

Then compare licensed third-party providers using their current contracts and APIs. Run the first several transactions as a manual concierge process. BidLadders should create a deal record and link to the provider; the provider should hold and release funds.

Do not build an internal escrow wallet as the next feature. Holding customer money can change the legal and compliance category of the business.

Exit condition: at least one test transaction and several real transactions complete with a written checklist, clear responsibility, and reconciled fees.

### Phase 4: Public launch

- Move from an access-controlled domain to the production domain.
- Publish fees, ranking methodology, verification methodology, sponsored labels, privacy terms, marketplace terms, prohibited products, complaints, and takedown procedures.
- Add seller identity and ownership checks proportionate to deal risk.
- Add buyer saved searches and listing alerts on `/mrr`.
- Publish only truthful marketplace numbers: live listings, currently verified listings, qualified inquiries, deals in diligence, and completed sales.
- Keep the 330-position homepage rule; improve discovery on `/mrr` instead of adding homepage pagination.

### Phase 5: Automate only proven bottlenecks

Prioritize automation based on observed manual work:

1. Stripe Connect onboarding if restricted-key support causes abandonment or support risk.
2. Automated verification refresh and seller alerts.
3. Escrow API creation and status synchronization.
4. Deal-room checklists and signed asset-purchase documents.
5. Success-fee invoicing and reconciliation.
6. Fraud scoring and moderation queues.

Do not prioritize recommendation algorithms, complex auctions, native mobile apps, or internal escrow until actual usage proves they are needed.

### Decision gates

Continue investing when founders connect real data, buyers initiate qualified inquiries, paid ranks renew, and deals progress through diligence. Rework positioning if listings grow but buyer inquiries do not. Rework trust and onboarding if founders start but do not connect Stripe. Stop expanding transaction infrastructure if there are no credible deals; improve supply quality and buyer acquisition first.

## 中文

### 原则

部署只是验证的开始，不代表产品已经完成。以下次序的目标，是在投入受监管或营运成本高昂的基础设施前先验证真实需求。

### 阶段 0：公开收款前

- 固定 listing、已验证 MRR、付费排名、竞价期限、被超越、退款、成功交易费及成交的书面定义。
- 明确一般资产交易包含什么：域名、源代码、代码库、在合法情况下可转移的客户资料、社交账户、文件、商标及售后责任。
- 就市场条款、隐私、Stripe 凭证处理、付费排名披露、成功交易费可执行性、制裁与 KYC 风险，以及目标地区是否适用市场或经纪法规取得法律审查。
- 确认 Stripe 集成及产品用途符合 Stripe 当时有效的条款。
- Escrow 模式获批准前，不得接收或代持收购资金。

### 阶段 1：私人部署 Alpha

- 用一个 Cloudflare Worker、D1 与静态资源部署到 staging 或受访问控制的域名。
- 只加入少于 20 个已获同意的测试 listing；不得伪造卖家、MRR、出价或成交。
- 用一个包含多个产品的 Stripe 账户测试，证明每个 listing 的 MRR 只来自卖家确认的 Product ID 与 Price ID。
- 测试 $0 MRR 必填资料、验证过期、密钥撤销、年费计划、折扣、退款、失败账单、多币种及已删除 Stripe 产品。
- 用测试资料覆盖全部 330 个排名位置，包括同价、竞价到期、被超越及免费 listing 排序。
- 检查手机与桌面双阶梯，并确认 `/` 没有分页，而 `/mrr` 可搜寻完整目录。
- 加入审计记录、备份、恢复测试、webhook 重放保护、滥用限制、监控及事故警报。

离开条件：系统能计算及解释单一 listing 的 MRR、确定性重现排名，并在 webhook 失败后恢复，而不需直接手改数据库。

### 阶段 2：人工协助的市场 Beta

- 人工邀请 20 至 50 位真实创办人。
- 每个 listing 发布前人工审核。
- 继续免费上架及免费验证。
- 只有在价格、期限、到期与退款条款可见后，才启用小额付费排名。
- 人工筛选买家询问，并观察尽职调查在哪些环节失败。
- 记录启动率、Stripe 连接完成率、listing 完成率、付费提升转化率、合格询问、卖家响应时间及进入尽调的交易。

离开条件：创办人自愿完成验证、部分卖家愿意付费提升排名，并且买家开始真实而可信的交易对话。单纯页面浏览量不算验证。

### 阶段 3：先学会 Escrow，再自动化

必须学习并记录：

- escrow 交易建立及买卖双方身份；
- 买家付款方式与拒付风险；
- 验收期限与接收标准；
- 资产转移清单；
- 域名与代码库转移；
- 客户资料转移及隐私责任；
- 争议证据与仲裁流程；
- 取消及退款规则；
- 买家、卖家、BidLadders 与 escrow 服务商之间的费用分配；
- 支持国家、币种、最低金额、KYC/KYB、制裁筛查及放款时间。

之后根据服务商当时有效的合约与 API 比较有牌照的第三方 escrow 服务。最初数笔交易采用人工 concierge 流程。BidLadders 只建立交易记录并连接服务商，由服务商持有及释放资金。

下一步不应自行开发内部 escrow 钱包。代持客户资金可能改变公司的法律与合规类别。

离开条件：至少一笔测试交易及数笔真实交易依照书面清单完成，责任清楚，费用能够对账。

### 阶段 4：公开上线

- 从受控制域名迁移到正式生产域名。
- 发布费用、排名方法、验证方法、赞助标签、隐私条款、市场条款、禁售产品、投诉及下架程序。
- 按交易风险加入卖家身份与所有权检查。
- 在 `/mrr` 加入买家收藏搜寻及 listing 通知。
- 只公开真实市场数字：当前 listing、当前已验证 listing、合格询问、尽调中交易及已完成交易。
- 保留首页 330 个位置的规则；改善 `/mrr` 搜寻，而不是为首页增加分页。

### 阶段 5：只自动化已被证明的瓶颈

按实际人工工作量决定自动化优先级：

1. 如果 restricted key 导致放弃或客服风险，改用 Stripe Connect onboarding。
2. 自动更新验证并通知卖家。
3. 通过 escrow API 建立交易并同步状态。
4. 交易资料室清单及签署资产购买协议。
5. 成功交易费开票及对账。
6. 欺诈评分及审核队列。

在真实使用证明有需要前，不应优先开发推荐算法、复杂拍卖、原生手机应用或内部 escrow。

### 决策关卡

当创办人愿意连接真实资料、买家发起合格询问、付费排名续费，并且交易持续进入尽调时，才继续扩大投资。如果 listing 增长但没有买家询问，应重做市场定位；如果创办人开始上架却不连接 Stripe，应改善信任与 onboarding；如果没有可信交易，不应扩张交易基础设施，应先改善供给质量及买家获取。
