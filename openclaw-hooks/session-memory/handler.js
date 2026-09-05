import { isAbsolute, join } from 'node:path';
import {
  createSessionMemoryGuard,
  loadVerifiedUpstreamHandler,
  UPSTREAM_VERIFICATION_ERROR,
} from './guard.mjs';

// This is the verified Windows npm-global installation layout, not a configurable override.
const appData = process.env.APPDATA;
if (process.platform !== 'win32' || typeof appData !== 'string' || !isAbsolute(appData)) {
  throw new Error(UPSTREAM_VERIFICATION_ERROR);
}

const upstreamHandler = await loadVerifiedUpstreamHandler({
  packageRoot: join(appData, 'npm', 'node_modules', 'openclaw'),
  expectedVersion: '2026.8.2',
  handlerSha256: 'ced466d871b0f850dcc9a9be41c8935c55d10c2c5f853892e9eb3a5715f2a420',
  descriptorSha256: '1b5b086ae8cad312e56691d4a1c473e44649a179efe2be76af9ba771e2bf55b8',
});

export default createSessionMemoryGuard(upstreamHandler);
