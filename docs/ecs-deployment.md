# 寻达 ECS 部署方案

本文档用于把当前本地全栈应用部署到阿里云 ECS。推荐第一阶段使用 Docker Compose：一台 ECS 运行 Web 服务、Playwright 采集进程和 PostgreSQL；稳定后再把 PostgreSQL 迁移到阿里云 RDS，把导出文件迁移到 OSS。

## 架构

```text
用户浏览器
  -> Nginx / HTTPS
  -> xundao app container :8731
  -> PostgreSQL container 或 RDS PostgreSQL
  -> Playwright headless Chromium
  -> runs / outputs / profile 持久化卷
```

## ECS 建议规格

- 测试：2 vCPU / 4 GB
- 小团队正式：4 vCPU / 8 GB
- 多任务并发采集：8 GB 起步
- 系统盘：80 GB 起步，开启自动快照

安全组只开放：

- `22`：SSH，仅限固定办公 IP
- `80/443`：Web 访问
- 不对公网开放 `8731`、PostgreSQL 端口

## 文件说明

- `Dockerfile`：应用镜像，基于 Playwright 官方镜像，包含 Chromium 依赖。
- `docker-compose.yml`：应用 + PostgreSQL。
- `.env.example`：ECS 环境变量模板。
- `deploy/postgres/schema.sql`：PostgreSQL 初始化 schema。
- `deploy/nginx/xundao.conf`：Nginx 反向代理示例。
- `deploy/systemd/xundao.service`：Docker Compose 守护服务。
- `scripts/ecs-bootstrap.sh`：ECS 初始化脚本。

## 部署步骤

1. 准备 ECS。

建议使用 Ubuntu 22.04/24.04 或 Alibaba Cloud Linux。把项目放到：

```bash
/opt/xundao
```

2. 准备环境变量。

```bash
cd /opt/xundao
cp .env.example .env
vim .env
```

至少修改：

```bash
POSTGRES_PASSWORD=一个强密码
AUTH_REQUIRED=true
BOOTSTRAP_ADMIN_EMAIL=管理员邮箱
BOOTSTRAP_ADMIN_PASSWORD=至少12位强密码
PGY_CONNECTION_ENCRYPTION_KEY=由密钥管理器生成的随机密钥
QWEN_API_KEY=千问API密钥
DEEPSEEK_API_KEY=DeepSeek API密钥
COOKIE_SECURE=true
LETSENCRYPT_EMAIL=证书通知邮箱
TASK_RETENTION_CLEANUP_ENABLED=true
```

正式环境必须开启 `AUTH_REQUIRED` 和 `COOKIE_SECURE`，并使用 HTTPS。首个管理员只在数据库内不存在该邮箱时自动创建；登录后应立即修改初始密码。数据表现和用户管理由 `admin` 角色保护，不再依赖共享管理密钥。

3. 启动。

```bash
chmod +x scripts/ecs-bootstrap.sh
DOMAIN=你的域名 bash scripts/ecs-bootstrap.sh
```

域名必须已解析到 ECS 公网 IP；脚本会安装 Certbot、签发证书并把 HTTP 自动跳转到 HTTPS。若仅做临时 IP/HTTP 联调，必须在 `.env` 设置 `COOKIE_SECURE=false` 后使用 `DOMAIN=_`；该模式不能用于正式账号或团队生产环境。

4. 查看状态。

```bash
docker compose ps
docker compose logs -f app
curl http://127.0.0.1:8731/healthz
```

## 蒲公英连接

产品不会把蒲公英账号直接作为寻达身份，也不承诺未经验证的 OAuth/SSO。每个寻达用户拥有独立的浏览器资料目录；首次人工完成蒲公英登录后，系统用 AES-GCM 加密保存 storageState，并在失效前复用。

ECS 使用无头 Chromium，但个人中心会把当前用户的蒲公英登录画面安全地显示在寻达站内，不需要上传明文 Cookie 或跳转到服务器桌面：

1. 用户登录寻达，进入「个人中心」。
2. 点击「连接或重新连接蒲公英」。
3. 直接点击站内登录画面操作蒲公英，出现二维码后扫码完成授权；需要时点击「刷新登录画面」。
4. 点击「确认已登录并保存」。
5. 服务先验证登录态，再按当前寻达用户加密保存；采集时自动恢复和验活，失效后任务进入「需处理」而不是使用其他用户的状态。

团队共用主账号时，由管理员先完成上述个人连接，再进入“数据表现 → 团队蒲公英连接”选择授权角色并发布；系统只复制 AES-GCM 密文，采集时个人连接优先、共享连接兜底，普通媒介不能读取或撤销共享登录态。管理员撤销后会关闭使用中的共享上下文并删除工作区密文副本。

`PGY_LOGIN_HEADLESS=true` 是 ECS 默认值。生产环境不得用 `PGY_STORAGE_STATE_PATH` 上传或共享明文 storageState；该变量只保留给本地单用户调试。若蒲公英将登录交互改成站内截图无法完成的形式，noVNC 可作为临时运维兜底，但必须继续按寻达用户隔离连接。

## 使用 RDS PostgreSQL

如果使用阿里云 RDS PostgreSQL，把 `.env` 改为：

```bash
DATABASE_URL=postgres://用户名:密码@RDS内网地址:5432/xundao
DATABASE_SSL=false
```

同时可以在 `docker-compose.yml` 中移除 `db` 服务，或保留但不再使用。RDS 需要把 ECS 内网 IP 加入白名单。

首次使用 RDS 时执行：

```bash
psql "$DATABASE_URL" -f deploy/postgres/schema.sql
```

## 留存与备份策略

- PostgreSQL 容器版：定期 `pg_dump`，并开启 ECS 云盘快照。
- RDS 版：开启 RDS 自动备份和必要的 PITR。
- 任务文件和输出默认保存 7 天，生产环境由 `TASK_RETENTION_CLEANUP_ENABLED=true` 自动清理；不要把任务目录纳入长期备份。
- 用户表、审计事件和不含凭据的配置可以进入数据库备份。
- 蒲公英连接密文可备份，但加密密钥必须放在独立的密钥管理器中；两者不能存放在同一备份包。

## 数据埋点与查看权限

产品会把关键行为写入 `analytics_events` 表，包括页面访问、运行检索、结果筛选、勾选达人、候选池导入、Excel 上传、开始采集、采集完成和下载 Excel。埋点只记录行为路径、数量、耗时、类目、粉丝量级和任务状态，不记录蒲公英密码、Cookie、请求头或完整登录态。

产品内查看入口为顶部导航的「管理后台」。只有 `admin` 角色能够访问 `/api/admin/*`；普通媒介账号即使直接请求接口也会收到 403。管理员只能看到聚合任务与连接健康状态，不能查看 Cookie、API Key、密码或完整 storageState。

工程或数据同学可以直接查 PostgreSQL：

```bash
docker compose exec db psql -U xundao -d xundao
SELECT event_name, count(*) FROM analytics_events GROUP BY event_name ORDER BY count(*) DESC;
```

## 常用运维命令

```bash
docker compose logs -f app
docker compose restart app
docker compose exec db psql -U xundao -d xundao
systemctl status xundao
systemctl restart xundao
nginx -t && systemctl reload nginx
```

## 生产化下一步

第一阶段先保证 ECS 可用。之后建议继续拆分：

- Web/API 进程与采集 Worker 进程分离。
- 引入 Redis/Tair 做任务队列和并发锁。
- Excel 和原始采集文件迁到 OSS。
- 将 Web/API 与 Playwright Worker 分离，并为同一用户的蒲公英连接增加并发锁。
- 增加登录态主动健康检查和到期通知。
- 将任务产物迁到带 7 天生命周期规则的 OSS。
