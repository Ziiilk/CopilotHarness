import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const stateDirectoryName = ".copilot-harness";
const stateFileName = "state.json";
const lockFileName = "state.lock";
const lockTimeoutMs = 5000;
const staleLockMs = 30000;

export function statePath(workspaceRoot) {
  return path.join(path.resolve(workspaceRoot), stateDirectoryName, stateFileName);
}

export async function loadState(workspaceRoot) {
  try {
    const content = await readFile(statePath(workspaceRoot), "utf8");
    return JSON.parse(content);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function saveState(workspaceRoot, state) {
  const target = statePath(workspaceRoot);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return state;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireLock(workspaceRoot) {
  const directory = path.dirname(statePath(workspaceRoot));
  const lockPath = path.join(directory, lockFileName);
  await mkdir(directory, { recursive: true });
  const deadline = Date.now() + lockTimeoutMs;

  while (Date.now() < deadline) {
    try {
      const token = randomUUID();
      const handle = await open(lockPath, "wx");
      await handle.writeFile(`${token}\n`, "utf8");
      return async () => {
        await handle.close();
        const owner = await readFile(lockPath, "utf8").catch(() => null);
        if (owner?.trim() === token) {
          await unlink(lockPath).catch((error) => {
            if (error.code !== "ENOENT") throw error;
          });
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const lockStat = await stat(lockPath).catch(() => null);
      if (lockStat && Date.now() - lockStat.mtimeMs > staleLockMs) {
        const stalePath = `${lockPath}.stale.${randomUUID()}`;
        await rename(lockPath, stalePath).then(() => unlink(stalePath)).catch(() => {});
        continue;
      }
      await delay(10);
    }
  }

  throw new Error(`Timed out waiting for harness state lock in ${workspaceRoot}.`);
}

export async function updateState(workspaceRoot, update) {
  const root = path.resolve(workspaceRoot);
  const release = await acquireLock(root);
  try {
    const current = await loadState(root);
    const next = await update(current);
    if (next !== undefined) await saveState(root, next);
    return next;
  } finally {
    await release();
  }
}
