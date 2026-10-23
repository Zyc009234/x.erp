# x.erp

轻量级企业资源计划（ERP）系统，面向中小企业，可部署在 **飞牛 fnOS NAS** 或任意装有 Node.js 22+ 的机器上，通过浏览器多人同时使用。

## 功能

- 商品（编码、规格型号、安全库存）、库存（出入库流水、安全库存预警）
- 入库单 / 出库单：多行明细、扫码枪录入、作废冲回；A4 / 二等分（针式）/ A5 打印，带金额大写与签字栏
- 盘点单：建单时快照账面，扫码定位录入实盘数，审核后自动生成盘盈 / 盘亏；录入与审核权限分离；打印盘点表 / 盘点盈亏表
- 收发存汇总表：任意期间的期初、入库、出库、期末数量与金额，可打印、导出；点开商品查看明细账（逐笔结存）
- 成本核算：移动加权平均，入库自动重算单位成本，出库按当时成本计价
- Excel / CSV 导入商品和期初库存：下载模板 → 填写 → 预览校验 → 导入，任何一行出错都不会写入
- 销售单、采购单（审核 / 发货 / 入库 / 收付款）
- 客户、供应商往来与应收应付
- 财务收支流水、人事档案、经营报表
- 角色权限：预置仓库主管、仓管员、入库员、出库员、盘点员、商品专员、成本会计、只读查询、业务员，可新增自定义角色并逐项勾选权限（服务端校验）
- 功能模块可按需启用（默认只启用库存管理与商品管理，在 系统设置 → 常规设置 中开启其他模块）
- 操作日志
- 数据存于本地 SQLite，每日自动备份（保留 30 天），支持 JSON 备份导出 / 导入

## 专业版

以下功能需要专业版授权码（系统设置 → 专业版，可免费试用 15 天）：

- **多仓库 + 调拨单**：多个仓库 / 门店分开记库存，出入库单、盘点单、销售发货、采购入库按仓库进行，仓库之间开调拨单；收发存汇总与明细账可按仓库统计
- **批次 / 保质期**：按商品开启；入库记批号、生产日期、有效期（可按保质期天数自动计算），出库先到期先出（已过期批次不会自动发出，报损出库优先出过期批次），临期 / 过期提醒，批次随调拨走
- **条码标签打印**：Code 128 条码，40×30 / 50×30 / 60×40 热敏标签或 A4 不干胶，可带品名、规格、售价
- **补货建议**：按近期出库速度、到货周期、备货天数、安全库存与在途采购计算建议补货量，按供应商一键生成采购单

授权码一次购买、永久有效，签发后一年内发布的新版本可免费升级。授权码离线校验（Ed25519 签名），不联网、不收集数据。
未激活或升级期已过时，只是不能新建上述内容（新增仓库、调拨、开启批次、打印标签、补货建议）；已有的仓库、批次数据照常使用，不会锁住任何库存。

源码公开，专业版靠自觉付费，感谢支持持续开发。购买：<http://101.201.141.121/xerp/#pro>

发码方使用 `tools/license.js`（私钥保存在本机 `%USERPROFILE%\.xerp-license`，不在仓库里）：

```bash
node tools/license.js issue --to "客户名称" --years 1
```

日常发码推荐用订单后台：双击 `tools/订单后台.cmd`（或 `node tools/orders.js`），会在本机浏览器打开一个只监听 127.0.0.1 的页面：

- 填客户名称、微信、金额、付款方式，点「确认已收款，发码」，自动签发并生成可直接发给客户的微信消息
- 续费：在原订单上点「续费」，新授权码的免费升级期从旧截止日顺延
- 按客户 / 微信 / 电话 / 授权编号搜索；筛出 30 天内升级到期的客户，方便提醒续费；导出 CSV
- 订单存在 `%USERPROFILE%\.xerp-license\orders.json`，和私钥同目录，密钥备份工具会一起备份；用命令行签发的码启动时自动补进订单

## 目录

| 路径 | 说明 |
|---|---|
| `src/server.js` | 服务端：只依赖 Node.js 内置模块，数据库使用内置 `node:sqlite` |
| `src/index.html` | 前端单页应用（由服务端提供） |
| `src/client.js` | Windows 桌面客户端外壳（基于系统 Edge 内核的独立窗口） |
| `tools/license.js` | 专业版授权码签发工具（发码方使用） |
| `tools/orders.js` | 本机订单后台：订单记录、一键发码、续费、查询（发码方使用） |
| `fnos/` | 飞牛 fnOS 应用打包（manifest、生命周期脚本、安装向导） |

## 直接运行

需要 Node.js 22.13+（22.5–22.12 需加 `--experimental-sqlite`）：

```bash
node src/server.js --data ./data --port 8686
```

浏览器打开 `http://127.0.0.1:8686`，默认账号 `admin` / `admin123`，首次登录后请立即修改。

## Windows 安装版

从 [Releases](https://github.com/Zyc009234/x.erp/releases) 下载 `xerp-<版本>-windows-x64-setup.exe`（Windows 10 / 11 64 位），双击安装：

- 安装向导里设置端口（默认 8686）和管理员密码；自带 Node.js，不用另装任何东西
- 以后台服务运行（任务计划程序「x.erp」，SYSTEM 身份开机自启，崩溃自动重启），不用登录 Windows
- 自动在防火墙放行该端口，仅限同一局域网；局域网其他电脑访问 `http://本机IP:8686`
- 数据在 `C:\ProgramData\XERP`；覆盖安装新版即可升级，升级和卸载都不删数据

构建：`powershell -ExecutionPolicy Bypass -File windows\build-windows.ps1`（需要 x64 Node.js 22.13+ 和 Inno Setup 6：`winget install JRSoftware.InnoSetup`），产物为 `dist\xerp-<版本>-windows-x64-setup.exe`。

## 安卓客户端

下载 `xerp-<版本>-android.apk`（Android 7.0 及以上）安装。手机连上和服务端同一个 Wi-Fi，首次打开填写服务端地址，或点「自动查找」扫描局域网。

- 右下角扫码按钮：用摄像头扫商品条码 / 二维码（EAN-13/8、UPC、Code 128/39/93、ITF、Codabar、QR、Data Matrix），结果填进当前输入框并自动回车，开出入库单、盘点、搜索都能用；没有选中输入框时直接查这个商品的库存
- 导出的 CSV / 备份 / 导入模板会让你选择保存位置；导入时可从手机选文件；单据、标签可走手机的系统打印（打印机或另存 PDF）
- 返回键先关弹窗，再后退；设置页和登录页可以切换服务器

页面本身来自服务端，服务端升级后手机端界面自动更新，一般不用重装 App。

构建（不需要 Gradle / Android Studio）：`powershell -ExecutionPolicy Bypass -File android\build-android.ps1`，需要 JDK 17+ 和 Android SDK（`platforms;android-36`、`build-tools;36.1.0`）。签名密钥首次构建时生成在 `%USERPROFILE%\.xerp-android\`，请备份——换了密钥就不能覆盖安装升级。

## 离线使用

完全离线可用：服务端只用 Node.js 内置模块和内置 SQLite，前端用到的图表（Chart.js）和 Excel 导入（SheetJS）组件放在 `src/vendor/` 随程序发布，授权码离线校验。

## 飞牛 fnOS 应用

构建（Windows，需 Node.js；首次运行会自动下载官方 [fnpack](https://developer.fnnas.com/docs/cli/fnpack/)）：

```powershell
powershell -ExecutionPolicy Bypass -File fnos\build-fnos.ps1
```

产物为 `dist\xerp-<版本>.fpk`，在飞牛 Web 界面 → 应用中心 → 手动安装。

- 依赖飞牛官方运行环境 `nodejs_v22`（安装时自动安装），包本身为纯 JS，x86 / ARM 通用
- 安装向导中设置管理员密码
- 数据目录为应用数据目录（`/vol*/@appdata/xerp`），升级不丢失
- `fnos/fix-fpk.js` 用于修正 Windows 上 fnpack 打包后的文件权限与换行

发布新版本时修改 `fnos/pkg/manifest` 中的 `version` 与 `changelog`。

### 上架飞牛应用中心

参见 [官方上架文档](https://developer.fnnas.com/docs/quick-started/publish-application/)：目前通过飞牛官网的微信群联系社区主理人，加入“应用中心开发者先锋交流群”后提交 `.fpk`、图标、真实界面截图与测试材料。
