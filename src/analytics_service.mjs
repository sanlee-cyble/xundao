export function sanitizeAnalyticsProperties(value, depth = 0) {
  if (depth > 4) return "[truncated]";
  if (value === null || value === undefined) return value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.length > 500 ? `${value.slice(0, 500)}...` : value;
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeAnalyticsProperties(item, depth + 1));
  }
  if (typeof value !== "object") return String(value);
  const blocked = /cookie|token|password|passwd|secret|authorization|storageState|headers|credential|sessionData|apiKey/i;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !blocked.test(key))
      .slice(0, 80)
      .map(([key, item]) => [key, sanitizeAnalyticsProperties(item, depth + 1)]),
  );
}

export const AGENT_ANALYTICS_EVENTS = Object.freeze([
  "clarification_requested",
  "clarification_resolved",
  "task_confirmed",
  "scope_group_completed",
  "validation_failed",
  "model_call_completed",
  "model_call_failed",
  "pgy_connection_expired",
  "pgy_connection_required",
  "collect_job_attention",
  "task_expired",
]);
