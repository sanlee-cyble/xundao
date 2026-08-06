# 寻达

本项目提供“找达人 + 蒲公英表现采集 + Excel 回填”的团队工作台。采集基于人工授权的蒲公英官方登录态，不保存账号密码。

## 同事本地部署

每位同事都可以从私有 GitHub 仓库克隆代码，把自己的电脑作为本地服务器。首次安装：

```bash
git clone https://github.com/sanlee-cyble/xundao.git
cd xundao
npm run setup:local
npm run web:local
```

同事需先被添加为私有仓库协作者，并在 GitHub CLI、GitHub Desktop 或 Git 凭据管理器中登录有权账号。随后打开 `http://127.0.0.1:8731`，创建本机管理员，并在「个人中心」独立完成蒲公英登录授权。完整步骤、更新方式和 Docker 方案见 [寻达本地团队交付指南](docs/local-team-setup.md)。仓库不包含任何现有 Cookie、浏览器资料、寻达数据库、真实任务文件或模型密钥。

## 产品与开发规划

- [完整产品与技术方案](docs/product/01-寻达-Agent-LUI达人工作台-产品与技术方案.md)
- [分阶段开发执行计划](docs/superpowers/plans/2026-07-29-xunda-agent-lui-workbench.md)

## 当前交付

默认首页采用统一 LUI。左侧以“新建任务 + 可搜索的最近 7 天会话”组织工作，管理后台和个人中心固定在底部；工作区采用视口内弹性布局。用户在同一个输入框中选择“采集数据”或“寻找达人”，上传 Excel、粘贴蒲公英链接或描述任务；系统先形成字段合同，只针对真正影响结果的缺失口径进行自然语言追问，确认后才允许采集。

已完成本机依赖安装时，也可直接启动：

```bash
npm run web
```

打开：

`http://localhost:8731`

当前工作台已实现：

- 统一 LUI、可展开/折叠的固定左侧导航、Excel 附件/拖放、蒲公英链接粘贴、寻找达人入口和会话式任务记录；新建任务会清除上一任务的文件、意图和采集配置。
- Excel 输入兼容三种批量方式：字段模板内含链接、字段模板与对话中另贴链接、仅含链接的 Excel 配合自然语言说明；超过 10 位达人时必须通过 Excel 导入。
- 完整字段合同：合作/日常、图文/视频/图文+视频、30/90 天、全流量/仅自然流量、数据视图均进入唯一键；V1 字段能力库由真实接口证据生成，并记录蒲公英原始名称、前端路径、请求定义、响应 JSON 路径、空值语义和校准状态。
- 全量字段库作为 Agent 与采集器之间的内部合同，不要求业务人员逐项勾选；Excel 解析器、确定性规则和模型共同把用户表头转换为蒲公英口径。
- 只粘贴少量链接且未说明字段时，系统会追问“全量采集”或“补充要求”，不会沿用上一个任务的配置。
- 一个任务同时执行多个动态口径组，不再用单一品牌模板隐式覆盖口径。
- 会话中的执行过程来自服务器真实事件：逐达人、逐口径展示采集、接口受阻后的任务级原生页面切换、检查点恢复、模型核验和 Excel 导出；任务级调整不修改共享采集器，不影响其他任务。
- 无模板任务导出的主数据表使用蒲公英原生两级表头：第一层保留数据表现、笔记类型、内容形式、周期、流量和视图，第二层使用“曝光中位数、阅读中位数、中位点赞量”等平台字段名；寻达运行状态单列在“采集说明”工作表。
- 已完成任务可从 7 天历史记录直接固化为模板；固化模板可增删字段，并把 Excel 中缺少的选定字段自动追加到输出表。
- Qwen 白名单工具调用、DeepSeek 证据文本、公式字段和人工字段四条独立处理路径。
- Qwen 的字段工具按本次候选动态生成 `capabilityId` 枚举；任务确认和启动都会阻止未进入字段库、未完成前端对齐或缺少请求/响应路径的字段。
- 采集器按单元格保留字段合同键、请求签名和值状态；DeepSeek 的每个填充值都必须引用可反查的证据包，单格审计失败只影响该单元格。
- 合作、授权等业务事实字段不交给模型猜测；证据不足时保持空白。
- 按任务、达人、口径组保存检查点；口径签名变化时自动失效旧缓存。
- 寻达账号、管理员/媒介角色、HttpOnly 会话 Cookie、用户级任务和候选池隔离。
- 每个用户独立的蒲公英浏览器资料目录，以及 AES-GCM 加密的连接状态。
- 管理员可显式把自己的已保存蒲公英连接共享给指定角色；个人连接优先，未授权用户无法使用、查看或管理共享登录态。
- 个人中心、角色保护的管理后台、敏感字段清洗后的产品埋点。
- 蒲公英连接在个人中心以可点击的站内登录画面完成授权，可在服务重启后恢复并在采集前自动验活；失效任务进入“需处理”并允许重新连接后重试。
- 任务创建后保存 7 天；生产环境可自动清理，用户也可复制或提前删除。
- SQLite 本地运行、PostgreSQL 团队部署和旧富士/美德乐模板兼容。

核心边界：模型负责理解、澄清、解释和证据文本；程序负责字段合同、取数计划、蒲公英请求、公式、校验、写入、权限和状态变化。未确认的字段合同不能进入采集。

### 富士模板

保留原有的粉丝数、互动数、图文/视频报价、阅读/互动中位数、完播率和粉丝画像等字段。找达人候选池导出默认使用此模板。

### 美德乐模板

上传美德乐项目执行表后，工作台会采集并回填：

- 小红书主页链接、粉丝数（万）、视频类合作笔记近 90 天全流量曝光/阅读中位数。
- 发现页、搜索页、关注页、博主个人页、附近页和其他六类曝光来源。
- 按规模口径的视频类合作笔记近 90 天仅自然流曝光/阅读、视频笔记一口价。
- 下单价 `报价 × 1.1`、实际花费 `下单价 × 1.02`、CPC `报价 ÷ 自然流阅读`，均以 Excel 公式写入。
- DeepSeek 生成的 80–120 字客观推荐理由。服务会校验字数、必要数据维度和禁止推断词；缺少 API Key 时不会用静态文案冒充模型结果。

原表中 CPC 位于 Y 列，Z 列是备注，因此系统按表头回填 Y 列并保留 Z 列。

美德乐模板固定使用蒲公英“数据表现 → 合作笔记 → 视频 → 近 90 日 → 按规模”口径：L/S 与曝光来源读取“全流量”（`advertiseSwitch=1`）的历史中位数；T/U 读取“仅自然流量”（`advertiseSwitch=0`）的历史中位数；CPC 固定为报价除以 U 列自然流阅读。若页面无法完成任一切换，任务会失败而不会回退到其他口径。

### 智能 Excel

智能 Excel 不再假设所有字段都是视频。系统优先读取父级合并表头和子级表头，并允许同一表中同时出现“合作笔记 90 天全流量”“合作笔记 90 天仅自然流量”“日常笔记 30 天全流量”“近 16 篇原始数据”等口径；仍缺少内容类型或其他关键维度时，LUI 会合并同类问题，用户确认后生成新合同版本。

## 模型配置

团队环境通过变量注入密钥，不要把密钥写入代码、数据库、浏览器或 Git：

```bash
export QWEN_API_KEY="your-qwen-key"
export QWEN_MODEL="qwen3.7-max"
export DEEPSEEK_API_KEY="your-deepseek-key"
export DEEPSEEK_MODEL="deepseek-v4-pro"
npm run web
```

Qwen 用于意图和字段语义候选，只能调用白名单工具；DeepSeek 用于推荐理由、非蒲公英字段证据审计和异常解释。模型失败不会改变字段合同、公式或蒲公英原始值。

本地使用 CSV 中的 Qwen Key 时：

```bash
export QWEN_API_KEY_FILE="/path/to/qwen-key.csv"
npm run web:with-qwen-csv
```

本地也可以从 PDF 临时读取 DeepSeek 密钥启动，不会把密钥写入项目文件：

```bash
export DEEPSEEK_KEY_PDF="/path/to/key-document.pdf"
npm run web:with-deepseek-pdf
```

Qwen 和 DeepSeek 的地址、模型与超时均可通过 `.env.example` 中的变量覆盖。

## 团队账号与留存

寻达默认启用账号登录。首次在 `localhost` 启动且数据库尚无可用管理员时，页面会引导创建管理员，并把旧本地任务和蒲公英连接迁移到该账号；仅显式设置 `AUTH_REQUIRED=false` 才进入开发免登录模式。团队部署建议用环境变量预置管理员：

```bash
AUTH_REQUIRED=true
BOOTSTRAP_ADMIN_EMAIL=admin@example.com
BOOTSTRAP_ADMIN_PASSWORD=至少12位强密码
COOKIE_SECURE=true
TASK_RETENTION_DAYS=7
TASK_RETENTION_CLEANUP_ENABLED=true
PGY_CONNECTION_ENCRYPTION_KEY=至少16位、由密钥管理器提供
```

首个管理员只在数据库中不存在同邮箱账号时创建。密码使用 scrypt 哈希，会话数据库只保存 token 哈希。管理员可创建或停用媒介账号；普通媒介只能访问自己的任务、候选池和蒲公英连接。

如团队共用一个蒲公英主账号，管理员先在个人中心完成连接和保存，再到“数据表现 → 团队蒲公英连接”选择授权角色并共享；媒介发起采集时会自动回退到该连接，但无法读取 Cookie、加密文件路径或撤销共享。管理员可随时撤销并删除工作区加密副本。

本地免登录模式会在 `data/.pgy-connection.key` 自动生成仅供本机使用的 0600 加密密钥；团队环境不会自动降级，必须从密钥管理器注入 `PGY_CONNECTION_ENCRYPTION_KEY`。连接状态只在内存中解密，不会在任务目录写出明文 storageState；升级启动时会移除旧版本遗留的同名明文临时文件，不影响 Excel、证据和任务记录。

发布前自动验证：

```bash
npm run test:release

# 另起 AUTH_REQUIRED=true 的临时服务后
XUNDAO_SMOKE_BASE_URL=http://127.0.0.1:8732 \
XUNDAO_SMOKE_ADMIN_EMAIL=admin@example.com \
XUNDAO_SMOKE_ADMIN_PASSWORD='your-test-password' \
npm run smoke:team
```

当前自动化基线为 105 项全量测试、73 项集成测试和 16 条隔离团队 HTTP 链路；Qwen3.7-Max 与 DeepSeek V4-Pro 另有真实最小连通测试，模型结果仍须通过程序白名单、证据和输出校验。

## ECS 部署

项目包含 Docker Compose + PostgreSQL 的 ECS 部署包：

- `Dockerfile`
- `docker-compose.yml`
- `.env.example`
- `deploy/nginx/xundao.conf`
- `deploy/systemd/xundao.service`
- `deploy/postgres/schema.sql`
- `scripts/ecs-bootstrap.sh`

部署步骤见：[docs/ecs-deployment.md](docs/ecs-deployment.md)。

## 快速开始

Excel 解析与回填使用声明在 `requirements.txt` 中的 OpenPyXL，Docker、ECS 和普通团队工作站均可独立运行，不依赖 Codex 私有运行时。完整团队功能从 `npm run web` 启动；以下命令仅用于底层采集器调试。

```bash
npm run extract
npm run login
```

在打开的 Chrome 中完成蒲公英登录后，关闭这个独立 Chrome 窗口，避免用户目录被占用。然后运行：

```bash
npm run capture
```

在浏览器中手动搜索 1-2 个测试达人，工具会自动保存相关 XHR/Fetch JSON 响应到 `raw/capture-*`。

如果当前页面已有可识别搜索框，可尝试自动搜索：

```bash
npm run auto-capture
```

监听完成后生成候选接口、映射结果和 Excel：

```bash
npm run pipeline
```

输出文件：

`outputs/蒲公英达人表现数据_采集结果.xlsx`

## 为什么先监听再批量

蒲公英公开可用 API 不存在，且历史开源项目显示接口通常需要多个后台接口共同拼出完整达人表现数据。直接让 Agent 点 1000 次页面不稳定，旧式固定 Cookie 或硬编码签名也容易失效。本项目先基于真实登录态捕获可用接口，再进入批量请求和 Excel 回填。

## 文件说明

- `src/extract_creators.py`：从 Excel 抽取账号昵称和小红书号。
- `src/pgy_session.mjs`：启动持久化 Chrome，监听蒲公英接口响应。
- `src/summarize_capture.mjs`：汇总候选接口。
- `src/map_results.py`：从已捕获 JSON 中启发式映射目标字段。
- `src/export_workbook.mjs`：导出采集结果 Excel。
- `src/template_profiles.mjs`：富士/美德乐模板注册表。
- `src/medela_workbook.mjs`：美德乐 Excel 识别、公式回填与可视校验。
- `src/recommendation_service.mjs`：DeepSeek 推荐理由生成与真实性约束。
- `docs/pgy-fetcher-skill.md`：可复用操作流程。
