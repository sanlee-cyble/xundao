import assert from "node:assert/strict";
import test from "node:test";
import { classifyPgyLoginProbe } from "../src/pgy_collect_core.mjs";

test("登录页即使残留 Cookie 也不能判定为已连接", () => {
  assert.deepEqual(
    classifyPgyLoginProbe({
      url: "https://pgy.xiaohongshu.com/login",
      text: "扫码登录",
      cookieCount: 5,
    }),
    { authenticated: false, reason: "蒲公英要求重新登录" },
  );
});

test("蒲公英域名且存在会话 Cookie 时判定为可恢复", () => {
  assert.deepEqual(
    classifyPgyLoginProbe({
      url: "https://pgy.xiaohongshu.com/solar/pre-trade/blogger",
      text: "博主广场",
      cookieCount: 3,
    }),
    { authenticated: true, reason: "蒲公英登录态有效" },
  );
});
