export const TASK_STATES = Object.freeze([
  "DRAFT",
  "PARSING",
  "NEEDS_CLARIFICATION",
  "READY_TO_CONFIRM",
  "CONFIRMED",
  "COLLECTING",
  "NEEDS_ATTENTION",
  "VALIDATING",
  "EXPORTING",
  "COMPLETED",
  "FAILED",
  "EXPIRED",
  "DELETED",
]);

const ALLOWED = Object.freeze({
  DRAFT: ["PARSING", "DELETED"],
  PARSING: ["NEEDS_CLARIFICATION", "READY_TO_CONFIRM", "FAILED"],
  NEEDS_CLARIFICATION: ["PARSING", "DELETED"],
  READY_TO_CONFIRM: ["CONFIRMED", "PARSING", "DELETED"],
  CONFIRMED: ["COLLECTING", "PARSING", "DELETED"],
  COLLECTING: ["NEEDS_ATTENTION", "VALIDATING", "FAILED"],
  NEEDS_ATTENTION: ["COLLECTING", "VALIDATING", "FAILED", "DELETED"],
  VALIDATING: ["NEEDS_ATTENTION", "EXPORTING", "FAILED"],
  EXPORTING: ["COMPLETED", "FAILED"],
  COMPLETED: ["EXPIRED", "DELETED"],
  FAILED: ["PARSING", "COLLECTING", "VALIDATING", "DELETED"],
  EXPIRED: ["DELETED"],
  DELETED: [],
});

export function transitionTask(task, target, event = {}) {
  if (!TASK_STATES.includes(target)) throw new Error(`未知任务状态：${target}`);
  if (target === "READY_TO_CONFIRM" && Number(task.unresolvedCount) > 0) {
    throw new Error(`仍有 ${task.unresolvedCount} 个未解决问题`);
  }
  if (target === "COLLECTING" && Number(task.confirmedVersion) !== Number(task.version)) {
    throw new Error("任务合同尚未确认");
  }
  if (!(ALLOWED[task.state] || []).includes(target)) {
    throw new Error(`非法状态转换：${task.state} → ${target}`);
  }
  return {
    ...task,
    state: target,
    updatedAt: event.at || new Date().toISOString(),
    lastEvent: event.type || `task.${target.toLowerCase()}`,
  };
}
