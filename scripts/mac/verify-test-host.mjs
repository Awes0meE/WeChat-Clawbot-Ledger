import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const docker = '/Applications/Docker.app/Contents/Resources/bin/docker';
const env = { ...process.env, PATH: `/Applications/Docker.app/Contents/Resources/bin:${process.env.PATH}` };
const compose = ['compose', '-f', 'deploy/docker/compose.test.yml'];
function run(args) {
  const result = spawnSync(docker, args, { cwd: root, env, encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) throw new Error(`CLAWBOT_TEST_HOST_CHECK_FAILED:${args[0]}`);
  return result.stdout;
}
function check(condition, label) {
  assert.ok(condition, `CLAWBOT_TEST_HOST_BOUNDARY:${label}`);
}
export function verifyTestHost({ requireHealthy = true, runtimeImage = 'clawbot-openclaw-test:p1' } = {}) {
const containers = {};
const mounts = {
  origin: { config: ['ledger-config', false], ledger: ['ledger-data', true], bootstrap: ['bootstrap', false] },
  openclaw: { openclaw: ['openclaw-state', true], codex: ['codex-state', true], receipts: ['receipts', true], secrets: ['secrets', false] },
};
for (const service of ['origin', 'openclaw']) {
  const id = run([...compose, 'ps', '-a', '-q', service]).trim();
  check(/^[0-9a-f]{64}$/.test(id), `${service}:single-container`);
  const c = JSON.parse(run(['inspect', id]))[0];
  containers[service] = c;
  check(c.Config.Labels['com.docker.compose.project'] === 'clawbot-test'
    && c.Config.Labels['com.docker.compose.service'] === service, `${service}:identity`);
  const expectedImage = service === 'origin'
    ? 'mayswind/ezbookkeeping@sha256:1043c95201f0432cd30328f6feb9a5b57359449400ea54fdf9a0c6138ab4c227'
    : runtimeImage;
  const image = JSON.parse(run(['image', 'inspect', expectedImage]))[0];
  check(c.Config.Image === expectedImage || (expectedImage === 'clawbot-openclaw-test:p1' && c.Config.Image === image.Id)
    || (service === 'openclaw' && c.Config.Image === 'clawbot-openclaw-test:p1' && c.Image === runtimeImage), `${service}:image-reference`);
  check(c.Image === image.Id && image.Architecture === 'arm64', `${service}:current-image`);
  if (requireHealthy) check(c.State.Running && c.State.Health?.Status === 'healthy', `${service}:healthy`);
  check(!c.State.Paused, `${service}:not-paused`);
  check(c.Config.User === '1000:1000', `${service}:unprivileged-user`);
  check(c.HostConfig.ReadonlyRootfs && !c.HostConfig.Privileged, `${service}:read-only-root`);
  check(c.HostConfig.CapDrop?.includes('ALL') && !(c.HostConfig.CapAdd?.length), `${service}:capabilities`);
  check(c.HostConfig.SecurityOpt?.includes('no-new-privileges:true'), `${service}:no-new-privileges`);
  check(!c.HostConfig.PublishAllPorts && !Object.keys(c.HostConfig.PortBindings ?? {}).length
    && Object.values(c.NetworkSettings.Ports ?? {}).every((v) => !v?.length), `${service}:no-published-ports`);
  check(!c.HostConfig.PidMode && c.HostConfig.IpcMode !== 'host'
    && c.HostConfig.NetworkMode !== 'host' && !(c.HostConfig.Devices?.length), `${service}:host-isolation`);
  const persistent = c.Mounts.filter((m) => m.Type !== 'tmpfs');
  check(persistent.length === Object.keys(mounts[service]).length, `${service}:mount-count`);
  for (const [directory, [name, writable]] of Object.entries(mounts[service])) {
    const target = `/var/lib/clawbot-test/${directory}`;
    const m = persistent.find((item) => item.Destination === target);
    check(m?.Type === 'volume' && m.Name === `clawbot-test_${name}` && m.RW === writable, `${service}:mount:${directory}`);
    const v = JSON.parse(run(['volume', 'inspect', m.Name]))[0];
    check(v.Labels?.['com.docker.compose.project'] === 'clawbot-test'
      && v.Labels?.['com.docker.compose.volume'] === name, `${service}:volume-owner:${directory}`);
  }
}
check(containers.openclaw.HostConfig.NetworkMode === `container:${containers.origin.Id}`, 'shared-origin-namespace');
const projectIds = run(['ps', '-a', '--no-trunc', '-q', '--filter', 'label=com.docker.compose.project=clawbot-test']).trim().split('\n').filter(Boolean).sort();
check(JSON.stringify(projectIds) === JSON.stringify(Object.values(containers).map((c) => c.Id).sort()), 'exact-project-services');
check(containers.origin.HostConfig.NetworkMode === 'clawbot-test_default', 'private-project-network');
const network = JSON.parse(run(['network', 'inspect', 'clawbot-test_default']))[0];
check(network.Driver === 'bridge' && network.Labels?.['com.docker.compose.project'] === 'clawbot-test', 'network-owner');
return { origin: containers.origin.Id, openclaw: containers.openclaw.Id,
  healthy: Object.values(containers).every((c) => c.State.Running && c.State.Health?.Status === 'healthy') };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const releasePath = new URL('../../release-runtime.json', import.meta.url);
  const runtimeImage = existsSync(releasePath) ? JSON.parse(readFileSync(releasePath)).runtimeImage : undefined;
  verifyTestHost({ runtimeImage });
  console.log(JSON.stringify({ result: 'CLAWBOT_TEST_HOST_ISOLATION_OK', services: ['origin', 'openclaw'], architecture: 'arm64', health: 'healthy', publishedPorts: 0, sharedLoopback: true }));

}
