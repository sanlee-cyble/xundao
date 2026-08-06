import assert from "node:assert/strict";
import test from "node:test";
import { memoryTaskRepository } from "../src/task_repository.mjs";
import { createTaskOrchestrator } from "../src/task_orchestrator.mjs";

test("上传模糊 Excel 后进入等待澄清", async () => {
  const orchestrator = createTaskOrchestrator({
    taskRepository: memoryTaskRepository(),
    now: () => "2026-07-30T00:00:00.000Z",
  });
  const task = await orchestrator.createFromParsedWorkbook({
    id: "job-ambiguous",
    ownerUserId: "u1",
    parsed: { unresolvedCount: 1, unresolved: [{ id: "q1" }] },
  });
  assert.equal(task.state, "NEEDS_CLARIFICATION");
});

test("确认合同版本后才能开始采集", async () => {
  const repository = memoryTaskRepository();
  const orchestrator = createTaskOrchestrator({ taskRepository: repository });
  await orchestrator.createFromParsedWorkbook({
    id: "job-1",
    ownerUserId: "u1",
    parsed: { version: 3, unresolvedCount: 0 },
  });
  await assert.rejects(() => orchestrator.start("job-1", "u1"), /尚未确认/);
  const confirmed = await orchestrator.confirm("job-1", "u1", 3);
  assert.equal(confirmed.confirmedVersion, 3);
  const running = await orchestrator.start("job-1", "u1");
  assert.equal(running.state, "COLLECTING");
});
