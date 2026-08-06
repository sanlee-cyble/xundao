import fs from "node:fs/promises";
import path from "node:path";

export function nextPendingScopes(groups, checkpoints = {}, expectedSignatures = {}) {
  return groups.filter((group) => {
    const checkpoint = checkpoints[group.id];
    if (checkpoint?.status !== "COMPLETED") return true;
    const expected = expectedSignatures[group.id];
    return Boolean(expected && checkpoint.requestSignature !== expected);
  });
}

export function checkpointKey(jobId, creatorId, groupId) {
  return `${jobId}/${creatorId}/${groupId}`;
}

export async function readCheckpoints(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

export async function writeCheckpoint(filePath, { jobId, creatorId, groupId, ...checkpoint }) {
  const current = await readCheckpoints(filePath);
  current[checkpointKey(jobId, creatorId, groupId)] = {
    ...checkpoint,
    jobId,
    creatorId,
    groupId,
    updatedAt: checkpoint.updatedAt || new Date().toISOString(),
  };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
  return current[checkpointKey(jobId, creatorId, groupId)];
}

export function checkpointsForCreator(checkpoints, jobId, creatorId) {
  const prefix = `${jobId}/${creatorId}/`;
  return Object.fromEntries(
    Object.entries(checkpoints)
      .filter(([key]) => key.startsWith(prefix))
      .map(([, value]) => [value.groupId, value]),
  );
}
