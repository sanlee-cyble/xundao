# 寻达本地团队交付指南

这份指南用于让每位同事把自己的电脑作为寻达服务器：代码来自同一个 GitHub 仓库，账号、蒲公英登录态、任务数据和导出文件只保存在各自电脑中。

## 一、准备环境

推荐 macOS 或 Linux，并准备：

- Git；
- Node.js 22 或更高版本；
- Python 3.9 或更高版本；
- Google Chrome；
- 有权使用的蒲公英账号。

首次安装依赖需要访问 npm 和 Python 软件源。寻达使用 Node 内置 SQLite，本地运行无需另装数据库。

## 二、克隆与安装

```bash
git clone git@github.com:sanlee-cyble/xundao.git
cd xundao
npm run setup:local
```

安装脚本会执行 `npm ci`、在项目内创建 `.venv`、安装 Python 依赖，并由 `.env.local.example` 生成本机专用的 `.env.local`。这些本机文件都已排除在 Git 提交范围外。

## 三、启动本地服务器

```bash
npm run web:local
```

浏览器打开 [http://127.0.0.1:8731](http://127.0.0.1:8731)。终端窗口需保持运行；按 `Control + C` 停止服务器。

可用下面的命令检查服务：

```bash
curl http://127.0.0.1:8731/healthz
```

返回内容包含 `"ok": true` 即表示本地服务器已就绪。

## 四、首次使用

1. 首次打开页面时创建本机寻达管理员，密码至少 12 位。
2. 进入「个人中心」，点击「连接或重新连接蒲公英」。
3. 在站内登录画面完成蒲公英登录，然后点击「确认已登录并保存」。
4. 回到工作台创建小批量测试任务，确认检索、采集和 Excel 下载链路。

每台电脑都必须独立完成这一步。仓库不会携带任何人的 Cookie、浏览器资料、蒲公英连接密文或寻达账号数据库。

## 五、可选模型配置

编辑 `.env.local`，按需填写 `QWEN_API_KEY` 和 `DEEPSEEK_API_KEY`。Qwen 用于理解任务和字段语义，DeepSeek 用于证据文本及推荐理由；留空时相关模型能力不可用，蒲公英原始取数、确定性公式和 Excel 主链路仍可运行。

修改配置后重启 `npm run web:local`。

## 六、拉取更新

先停止本地服务器，再执行：

```bash
git pull --ff-only
npm run setup:local
npm run web:local
```

`data/`、`runs/`、`outputs/`、`.pgy-browser-profile/` 和 `.env.local` 不会被 Git 覆盖，因此更新代码不会带走本机登录态和任务数据。重要导出文件仍应由使用者自行备份。

## 七、Docker 方式

Windows 或希望隔离运行环境的同事可以参考 `.env.example` 和 `docker-compose.yml`。复制配置、设置本机密码与加密密钥后运行：

```bash
cp .env.example .env
docker compose up --build
```

本地 HTTP 使用时需在 `.env` 设置 `COOKIE_SECURE=false`。Compose 会把端口限制在 `127.0.0.1:8731`，数据保存在 Docker volumes 中。
