import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const UPSTREAM_VERIFICATION_ERROR = 'CLAWBOT_SESSION_MEMORY_UPSTREAM_VERIFICATION_FAILED';

export function createSessionMemoryGuard(upstreamHandler) {
  return function sessionMemory(event) {
    if (event.context?.agentId === 'bookkeeper') return;
    return upstreamHandler(event);
  };
}

export async function loadVerifiedUpstreamHandler({
  packageRoot,
  expectedVersion,
  handlerSha256,
  descriptorSha256,
}) {
  try {
    const packageInfo = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    if (packageInfo.name !== 'openclaw' || packageInfo.version !== expectedVersion) {
      throw new Error(UPSTREAM_VERIFICATION_ERROR);
    }
    const hookRoot = join(packageRoot, 'dist', 'bundled', 'session-memory');
    const handlerPath = join(hookRoot, 'handler.js');
    const [handlerBytes, descriptorBytes] = await Promise.all([
      readFile(handlerPath),
      readFile(join(hookRoot, 'HOOK.md')),
    ]);
    const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
    if (digest(handlerBytes) !== handlerSha256 || digest(descriptorBytes) !== descriptorSha256) {
      throw new Error(UPSTREAM_VERIFICATION_ERROR);
    }
    const upstream = await import(pathToFileURL(handlerPath).href);
    if (typeof upstream.default !== 'function') throw new Error(UPSTREAM_VERIFICATION_ERROR);
    return upstream.default;
  } catch {
    // Never forward filesystem paths, parser errors, or upstream exception details.
    throw new Error(UPSTREAM_VERIFICATION_ERROR);
  }
}
