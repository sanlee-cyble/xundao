import assert from "node:assert/strict";
import test from "node:test";
import {
  createSessionToken,
  hashPassword,
  hashSessionToken,
  requireRole,
  verifyPassword,
} from "../src/auth_service.mjs";
import {
  parseCookies,
  sessionCookie,
} from "../src/auth_http.mjs";

test("密码使用哈希验证", async () => {
  const encoded = await hashPassword("StrongPassword!23");
  assert.notEqual(encoded, "StrongPassword!23");
  assert.equal(await verifyPassword("StrongPassword!23", encoded), true);
  assert.equal(await verifyPassword("wrong", encoded), false);
});

test("媒介用户不能访问管理员接口", () => {
  assert.throws(
    () => requireRole({ role: "media", status: "active" }, "admin"),
    /无管理员权限/,
  );
});

test("会话只保存哈希且 Cookie 为 HttpOnly", () => {
  const token = createSessionToken();
  assert.notEqual(hashSessionToken(token), token);
  const cookie = sessionCookie(token, { secure: true });
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/);
  assert.equal(parseCookies(`${cookie}; other=value`).xundao_session, token);
});
