import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeAnalyticsProperties } from "../src/analytics_service.mjs";

test("埋点清除凭据字段", () => {
  const clean = sanitizeAnalyticsProperties({
    token: "secret",
    cookie: "secret",
    password: "secret",
    apiKey: "secret",
    taskCount: 3,
  });
  assert.deepEqual(clean, { taskCount: 3 });
});
