import { rebindReleaseUpdateData, verifyReleaseUpdateData } from './release-update-data.mjs';
try {
  const [action, before, after] = process.argv.slice(2);
  if (!['rebind', 'verify'].includes(action)) throw Error();
  const args = ['/source', '/generation', JSON.parse(before), JSON.parse(after)];
  if (action === 'rebind') rebindReleaseUpdateData(...args); else verifyReleaseUpdateData(...args);
  console.log('CLAWBOT_RELEASE_UPDATE_DATA_VERIFIED');
} catch { console.error('CLAWBOT_RELEASE_UPDATE_DATA_REFUSED'); process.exitCode = 1; }
