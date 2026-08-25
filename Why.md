# BidLadders: Why It Exists

## English

### The problem

Small software products are difficult to sell when they have little or no revenue. Traditional marketplaces tend to reward established revenue, charge before demand is proven, or bury new listings behind pagination and opaque promotion. Revenue-verification products improve trust, but verification alone does not create discovery. Paid-ranking products create attention, but attention alone does not prove the quality or financial state of what is being promoted.

BidLadders combines these missing halves:

- product-level revenue verification for credibility;
- a visible bid ladder for discovery;
- free listing and free MRR recording, including products with $0 MRR;
- a clear path for small products to compete using either evidence or a paid placement.

### Why product-level verification matters

One company may operate several products through one Stripe account. A marketplace should not force the founder to sell the entire company or pretend that all account revenue belongs to one listing. BidLadders treats each listing as one product or startup.

The seller enters the product name and URL, authorizes restricted read-only Stripe access, and confirms the exact Stripe Product and Price IDs discovered by the system. The name is a search anchor; the confirmed IDs are the accounting boundary. This allows `Lipstick Digital` to be listed independently even if the same Stripe account also contains `OnlineKisser` and `Sext999`.

### Why allow $0 MRR

Potential exists before revenue, but it cannot be presented as verified traction. BidLadders therefore permits $0-MRR listings while requiring a complete description, product status, ownership details, assets included, operating costs, and buyer opportunity. Listings with verified MRR may keep the long description optional, although basic product information remains mandatory.

### Why the ladder exists

The homepage is scarce inventory: exactly 330 visible products, displayed as one global ordered list across two visual ladders of 165 positions each. There is no homepage pagination. The layout makes ranking understandable and gives paid promotion an explicit market price.

Free listings are ordered by listing time. Paid listings rank above free listings and are clearly labeled. When no paid rank exists, the first boost costs $2. Once paid ranks exist, a seller chooses a position to beat and must bid at least $0.50 more than the current bid at that position. Listings outside the top 330 remain discoverable on `/mrr` through search and browsing.

### Business thesis

BidLadders does not need transaction volume on day one to monetize. Paid rank bids can generate early revenue while the marketplace develops liquidity. Completed acquisitions add a second revenue stream through success fees:

- Sale price below $10,000: 8%
- Sale price from $10,000 to below $50,000: 3.5%
- Sale price of $50,000 or more: 1.7%

The thesis should be tested, not assumed. The first proof is whether founders will connect Stripe, complete a listing, and pay to improve rank. The second proof is whether qualified buyers contact sellers and close transactions.

## 中文

### 要解决的问题

小型软件产品在收入很低或尚未产生收入时，通常很难出售。传统交易市场往往偏向已有稳定收入的项目、在需求尚未验证前先收费，或者把新项目埋在分页与不透明的推广机制中。收入验证平台能增加可信度，却不一定带来曝光；付费排名平台能制造曝光，却无法证明项目质量与真实财务状况。

BidLadders 把两者结合起来：

- 以产品为单位验证收入，建立可信度；
- 以公开竞价阶梯提供曝光；
- 免费上架及免费记录 MRR，并允许 $0 MRR 产品；
- 让小产品可以凭证据或付费排名获得机会。

### 为什么必须按产品验证

一家公司可能用同一个 Stripe 账户经营多个产品。市场不应强迫创办人出售整家公司，也不应把账户内全部收入错误归到一个项目。BidLadders 的每个 listing 只代表一个产品或 startup。

卖家填写产品名称与网址，授权受限的 Stripe 只读访问，并确认系统找到的准确 Stripe Product ID 与 Price ID。产品名称只用于初步搜寻，最终确认的 ID 才是收入归属边界。因此，即使同一个 Stripe 账户内还有 `OnlineKisser` 和 `Sext999`，卖家仍可独立上架 `Lipstick Digital`。

### 为什么允许 $0 MRR

产品可以在收入产生前具有潜力，但潜力不能伪装成已验证的市场表现。因此，BidLadders 允许 $0 MRR listing，但卖家必须完整填写产品说明、开发状态、所有权、交易包含的资产、营运成本与买家机会。已有验证 MRR 的 listing 可选择不填写长篇说明，但基本产品资料仍为必填。

### 为什么使用竞价阶梯

首页是稀缺展示位：只显示 330 个产品，以同一个全局排名分布在左右两个视觉阶梯中，每边 165 个位置。首页不设分页。这个设计让排名规则一目了然，也让付费曝光形成公开价格。

免费 listing 按上架时间排序。付费 listing 排在免费 listing 之前，并清楚标示为付费排名。没有任何付费排名时，首次提升排名收费 $2；已有付费排名后，卖家选择希望超越的位置，并至少比该位置当前出价高 $0.50。未进入前 330 名的 listing 仍可在 `/mrr` 页面被搜寻及浏览。

### 商业假设

BidLadders 不必等到第一笔收购交易完成才开始变现。付费排名可成为早期收入来源；当市场出现成交后，再通过成功交易费建立第二条收入线：

- 成交价低于 $10,000：8%
- 成交价为 $10,000 至低于 $50,000：3.5%
- 成交价为 $50,000 或以上：1.7%

这些是假设，不是事实。第一阶段必须验证创办人是否愿意连接 Stripe、完成 listing 并付费提升排名；第二阶段才验证是否有合格买家联络卖家并完成交易。
