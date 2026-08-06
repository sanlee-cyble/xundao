import fs from "node:fs/promises";
import path from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;

export function expiresAtForJob(createdAt, days = 7) {
  const timestamp = new Date(createdAt).getTime();
  if (!Number.isFinite(timestamp)) throw new Error("任务创建时间无效");
  return new Date(timestamp + Number(days) * DAY_MS).toISOString();
}

export function isExpired(expiresAt, now = new Date().toISOString()) {
  return new Date(expiresAt).getTime() <= new Date(now).getTime();
}

export function assertRetainedPath(filePath, allowedRoots) {
  const resolved = path.resolve(filePath);
  const allowed = allowedRoots.some((root) => {
    const normalizedRoot = `${path.resolve(root)}${path.sep}`;
    return resolved.startsWith(normalizedRoot);
  });
  if (!allowed) throw new Error(`拒绝清理保留目录之外的路径：${resolved}`);
  return resolved;
}

export async function deleteExpiredArtifacts(job, { allowedRoots, removeImpl = fs.rm } = {}) {
  const paths = [...new Set([
    job.inputPath,
    job.resultsPath,
    job.outputPath,
    job.taskPath,
    job.runDir,
  ].filter(Boolean))];
  const resolvedPaths = paths.map((item) => assertRetainedPath(item, allowedRoots));
  const runDirectory = job.runDir ? path.resolve(job.runDir) : "";
  const targets = resolvedPaths.filter((item) => !runDirectory || item === runDirectory || !item.startsWith(`${runDirectory}${path.sep}`));
  for (const target of targets) await removeImpl(target, { recursive: true, force: true });
  return targets;
}

export async function sweepExpiredTasks(
  tasks,
  {
    isExpiredFn = (task) => isExpired(task.expiresAt),
    deleteTask,
    markExpired,
    onError = () => {},
  } = {},
) {
  if (typeof deleteTask !== "function" || typeof markExpired !== "function") {
    throw new Error("七天清理器缺少删除或标记实现");
  }
  const expiredTasks = Array.from(tasks || []).filter(isExpiredFn);
  let deleted = 0;
  let failed = 0;
  for (const task of expiredTasks) {
    try {
      await deleteTask(task);
      await markExpired(task);
      deleted += 1;
    } catch (error) {
      failed += 1;
      onError(error, task);
    }
  }
  return { expired: expiredTasks.length, deleted, failed };
}
