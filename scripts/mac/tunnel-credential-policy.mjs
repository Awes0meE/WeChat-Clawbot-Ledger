import assert from 'node:assert/strict';
import { managedVolumeName } from './managed-runtime-spec.mjs';
export function tunnelCredentialArgs(spec,action) {
  assert.equal(spec.profile,'production');assert.match(spec.services.openclaw.image,/^sha256:[a-f0-9]{64}$/);
  assert.ok(['inspect','apply','verify-saved'].includes(action));
  return ['run','--rm','-i','--network','none','--log-driver','none','--read-only','--user','1000:1000',
    '--cap-drop','ALL','--security-opt','no-new-privileges:true',
    '--mount',`type=volume,src=${managedVolumeName(spec,'tunnel-config')},dst=/run/clawbot-tunnel${action==='apply'?'':',readonly'}`,
    '--mount',`type=volume,src=${managedVolumeName(spec,'guard-config')},dst=/run/clawbot-guard,readonly`,
    '--entrypoint','node',spec.services.openclaw.image,'/opt/clawbot/docker/import-tunnel-credential.mjs',action];
}
