function percent(part, total) {
  return total ? Number(((part / total) * 100).toFixed(1)) : 0;
}

export function profilePerformance(jobs = [], {
  ownerUserId,
  now = new Date().toISOString(),
  days = 7,
} = {}) {
  const since = new Date(new Date(now).getTime() - Number(days) * 24 * 60 * 60 * 1000).getTime();
  const own = jobs.filter((job) => (
    job.ownerUserId === ownerUserId
    && new Date(job.createdAt).getTime() >= since
    && !job.deletedAt
  ));
  const completed = own.filter((job) => job.status === "done" || job.state === "COMPLETED").length;
  const failed = own.filter((job) => job.status === "failed" || job.state === "FAILED").length;
  const creators = own.reduce((sum, job) => sum + Number(job.progress?.total || job.creators?.length || 0), 0);
  return {
    windowDays: days,
    taskCount: own.length,
    completed,
    failed,
    completionRate: percent(completed, completed + failed),
    creatorCount: creators,
    downloadsReady: own.filter((job) => job.status === "done").length,
  };
}
