# x.erp 云备份服务

付费云服务端，独立于客户端部署，不随安装包分发。

- `server.js`：HTTP API + 后台 + 购买页，只用 Node.js 内置模块和 `node:sqlite`
- `xerp-cloud.service`：systemd 单元示例
- 数据目录：`/var/lib/xerp-cloud`（`cloud.db`、`blobs/`、`admin.pw`）
- 默认监听 `127.0.0.1:8095`，由 Caddy 的 `/xerp-cloud/*` 反代

首次部署：

```bash
mkdir -p /opt/xerp-cloud
cp server.js /opt/xerp-cloud/
cp xerp-cloud.service /etc/systemd/system/
echo -n '后台密码' | node /opt/xerp-cloud/server.js setpw
systemctl daemon-reload
systemctl enable --now xerp-cloud
```

后台：`https://www.zhaoyoucai.xyz/xerp-cloud/admin`（用户名 `admin`）

可选在线支付（易支付协议）：设置 `EPAY_URL`、`EPAY_PID`、`EPAY_KEY` 环境变量后重启。
