# x.erp

轻量级企业资源计划（ERP）系统，面向中小企业，可部署在 **飞牛 fnOS NAS** 或任意装有 Node.js 22+ 的机器上，通过浏览器多人同时使用。

## 功能

- 商品、库存（出入库流水、安全库存预警）
- 销售单、采购单（审核 / 发货 / 入库 / 收付款）
- 客户、供应商往来与应收应付
- 财务收支流水、人事档案、经营报表
- 多账号（管理员 / 业务员）、操作日志
- 数据存于本地 SQLite，每日自动备份（保留 30 天），支持 JSON 备份导出 / 导入

## 目录

| 路径 | 说明 |
|---|---|
| `src/server.js` | 服务端：只依赖 Node.js 内置模块，数据库使用内置 `node:sqlite` |
| `src/index.html` | 前端单页应用（由服务端提供） |
| `src/client.js` | Windows 桌面客户端外壳（基于系统 Edge 内核的独立窗口） |
| `fnos/` | 飞牛 fnOS 应用打包（manifest、生命周期脚本、安装向导） |

## 直接运行

需要 Node.js 22.13+（22.5–22.12 需加 `--experimental-sqlite`）：

```bash
node src/server.js --data ./data --port 8686
```

浏览器打开 `http://127.0.0.1:8686`，默认账号 `admin` / `admin123`，首次登录后请立即修改。

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
