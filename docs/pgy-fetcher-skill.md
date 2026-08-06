# 蒲公英达人表现数据获取流程

这个文档是本项目的可复用操作流程，不是独立安装到 Codex 的全局 Skill。

## 目标

用户只提供小红书达人昵称和小红书号时，通过蒲公英站内搜索定位达人，并在人工登录授权后监听蒲公英页面请求，批量沉淀达人表现数据。

## 稳定路线

1. 从 Excel 抽取达人名单，生成 `data/creators.json`。
2. 使用 Playwright 启动持久化 Chrome 用户目录 `.pgy-browser-profile/`。
3. 用户在打开的 Chrome 中人工登录蒲公英。
4. 工具监听 `pgy.xiaohongshu.com` 的 XHR/Fetch JSON 响应。
5. 对响应进行达人昵称/小红书号和表现指标关键词打分。
6. 将候选接口与原始 JSON 保存到 `raw/capture-*`。
7. 将命中的达人字段映射到 `data/mapped_results.json`。
8. 导出 `outputs/蒲公英达人表现数据_采集结果.xlsx`。

## 命令

```bash
npm run extract
npm run login
npm run capture
npm run summarize
npm run map
npm run export
```

如果当前页面已有搜索框，可尝试：

```bash
npm run auto-capture
```

## 合规边界

只使用已有账号权限能正常访问的数据；不绕过验证码；不破解加密签名；不使用账号池；请求频率控制在人类可接受的范围内；保留原始 JSON 证据，避免不可追溯的数据回填。
