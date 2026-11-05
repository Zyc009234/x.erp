# x.erp Docker 镜像：群晖、威联通、Unraid、绿联、极空间等任何能跑 Docker 的机器都能用
#   docker run -d --name xerp -p 8686:8686 -v ./xerp-data:/data --restart unless-stopped ghcr.io/zyc009234/xerp
# 数据全部在 /data（数据库、每日自动备份、日志），升级镜像不丢数据。
FROM node:22-alpine

WORKDIR /app
COPY src/server.js src/index.html ./
COPY src/vendor ./vendor

# XERP_PLAT：匿名统计里标记为 Docker 安装；TZ：单据日期、每日备份按北京时间
ENV NODE_ENV=production \
    XERP_PLAT=docker \
    TZ=Asia/Shanghai

# 用 root 运行：NAS 上挂载的共享文件夹属主各不相同，用普通用户经常写不进去
VOLUME /data
EXPOSE 8686
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:8686/api/ping >/dev/null || exit 1

CMD ["node", "server.js", "--data", "/data", "--port", "8686"]
