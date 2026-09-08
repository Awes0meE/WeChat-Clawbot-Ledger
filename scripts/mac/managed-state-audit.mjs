import assert from 'node:assert/strict';
import { MIGRATION_ROLES } from '../../deploy/docker/migration-format.mjs';
import { managedVolumeName } from './managed-runtime-spec.mjs';
export async function auditManagedState(spec, driver, { ledgerRotation = false, excludeOpenclaw = false, tunnelCredential = false } = {}) {
  assert.ok([ledgerRotation,excludeOpenclaw,tunnelCredential].filter(Boolean).length<=1);
  assert.ok(await driver.validateVolumes());
  const names = MIGRATION_ROLES.map(role => managedVolumeName(spec, role));
  const ids = (await driver.run(['ps', '-q'])).split('\n').filter(Boolean);
  if (ids.length) {
    const live = JSON.parse(await driver.run(['inspect', ...ids]));
    assert.ok(live.every(c => !c.Mounts.some(m => names.includes(m.Name))), 'State has a live consumer');
  }
  return JSON.parse(await driver.run(['run', '--rm', '--network', 'none', '--read-only', '--user', '0:0',
    '--cap-drop', 'ALL', '--cap-add', 'DAC_OVERRIDE', '--security-opt', 'no-new-privileges:true',
    ...MIGRATION_ROLES.flatMap(role => ['--mount', `type=volume,src=${managedVolumeName(spec, role)},dst=/state/${role},readonly`]),
    '--entrypoint', 'node', spec.services.openclaw.image, '/opt/clawbot/docker/nine-volume-audit.mjs',
    ...(ledgerRotation ? ['--exclude-ledger-rotation'] : []),
    ...(excludeOpenclaw ? ['--exclude-openclaw-state'] : []),
    ...(tunnelCredential ? ['--exclude-tunnel-credential'] : [])], 120000));
}
