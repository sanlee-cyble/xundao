import { randomUUID } from "node:crypto";
import { expiresAtForJob } from "./retention_service.mjs";
import { transitionTask } from "./task_state_machine.mjs";
import { assertTaskContractExecutable } from "./field_execution_gate.mjs";

function contractFromParsed(parsed = {}) {
  return parsed.taskContract || {
    version: Number(parsed.version || 1),
    confirmedVersion: Number(parsed.confirmedVersion || 0),
    unresolvedCount: Number(parsed.unresolvedCount || 0),
    unresolved: parsed.unresolved || [],
    scopeGroups: parsed.scopeGroups || [],
    columns: parsed.columns || [],
  };
}

function lifecycleView(task) {
  const contract = task.taskContract || {};
  return {
    ...task,
    version: Number(contract.version || task.version || 1),
    confirmedVersion: Number(contract.confirmedVersion || task.confirmedVersion || 0),
    unresolvedCount: Number(contract.unresolvedCount || task.unresolvedCount || 0),
  };
}

export function createTaskOrchestrator({
  taskRepository,
  retentionDays = 7,
  now = () => new Date().toISOString(),
} = {}) {
  if (!taskRepository) throw new Error("任务编排器缺少 taskRepository");

  async function owned(id, ownerUserId) {
    const task = await taskRepository.getById(id, ownerUserId);
    if (!task) throw new Error("任务不存在或无权访问");
    return lifecycleView(task);
  }

  return {
    async createFromParsedWorkbook({ id = randomUUID(), ownerUserId, parsed = {}, source = {} }) {
      const createdAt = now();
      const taskContract = contractFromParsed(parsed);
      let task = {
        id,
        ownerUserId,
        state: "DRAFT",
        taskContract,
        createdAt,
        updatedAt: createdAt,
        expiresAt: expiresAtForJob(createdAt, retentionDays),
        source,
      };
      task = transitionTask(lifecycleView(task), "PARSING", { type: "task.parse_started", at: createdAt });
      task = transitionTask(
        task,
        taskContract.unresolvedCount > 0 ? "NEEDS_CLARIFICATION" : "READY_TO_CONFIRM",
        {
          type: taskContract.unresolvedCount > 0
            ? "clarification.requested"
            : "task.ready_to_confirm",
          at: createdAt,
        },
      );
      return await taskRepository.create(task);
    },

    async get(id, ownerUserId) {
      return await owned(id, ownerUserId);
    },

    async confirm(id, ownerUserId, version) {
      const task = await owned(id, ownerUserId);
      if (task.state !== "READY_TO_CONFIRM") throw new Error("当前任务不能确认");
      if (Number(version) !== task.version) throw new Error("确认版本与当前字段合同不一致");
      assertTaskContractExecutable(task.taskContract);
      const confirmedAt = now();
      const taskContract = {
        ...task.taskContract,
        confirmedVersion: task.version,
        confirmedAt,
      };
      await taskRepository.saveContract(id, ownerUserId, taskContract);
      await taskRepository.saveConfirmation(id, ownerUserId, {
        confirmedVersion: task.version,
        confirmedAt,
        confirmedBy: ownerUserId,
      });
      const confirmed = transitionTask(
        { ...task, taskContract, confirmedVersion: task.version },
        "CONFIRMED",
        { type: "task.confirmed", at: confirmedAt },
      );
      await taskRepository.updateState(id, ownerUserId, confirmed.state);
      return lifecycleView({ ...await owned(id, ownerUserId), taskContract });
    },

    async start(id, ownerUserId) {
      const task = await owned(id, ownerUserId);
      assertTaskContractExecutable(task.taskContract);
      const running = transitionTask(task, "COLLECTING", {
        type: "task.collection_started",
        at: now(),
      });
      await taskRepository.updateState(id, ownerUserId, running.state);
      return lifecycleView({ ...task, ...running });
    },

    async retry(id, ownerUserId) {
      const task = await owned(id, ownerUserId);
      const target = task.confirmedVersion === task.version ? "COLLECTING" : "PARSING";
      const retried = transitionTask(task, target, { type: "task.retried", at: now() });
      await taskRepository.updateState(id, ownerUserId, retried.state);
      return retried;
    },

    async remove(id, ownerUserId) {
      const task = await owned(id, ownerUserId);
      const deleted = transitionTask(task, "DELETED", { type: "task.deleted", at: now() });
      await taskRepository.updateState(id, ownerUserId, deleted.state);
      return deleted;
    },
  };
}
