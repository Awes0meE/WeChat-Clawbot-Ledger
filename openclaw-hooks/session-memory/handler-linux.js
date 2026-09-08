import { createSessionMemoryGuard, loadVerifiedUpstreamHandler, UPSTREAM_VERIFICATION_ERROR } from './guard.mjs';

// The fixed official Linux image installs the verified OpenClaw runtime in /app.
if (process.platform !== 'linux') throw new Error(UPSTREAM_VERIFICATION_ERROR);
const upstreamHandler = await loadVerifiedUpstreamHandler({
  packageRoot: '/app',
  expectedVersion: '2026.8.2',
  handlerSha256: 'ced466d871b0f850dcc9a9be41c8935c55d10c2c5f853892e9eb3a5715f2a420',
  descriptorSha256: '1b5b086ae8cad312e56691d4a1c473e44649a179efe2be76af9ba771e2bf55b8',
});
export default createSessionMemoryGuard(upstreamHandler);
