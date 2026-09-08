import test from 'node:test';
import assert from 'node:assert/strict';
import { managedRuntimeSpec, managedCompose, checkManagedContainer, managedVolumeName } from '../../../scripts/mac/managed-runtime-spec.mjs';
import { activationMatches } from '../../../scripts/mac/managed-host-release.mjs';
function fixture(volumeGeneration = null) {
  const spec = managedRuntimeSpec({ profile: 'production', project: 'clawbot-production', runtimeImage: `sha256:${'a'.repeat(64)}`,
    guardImage: `sha256:${'b'.repeat(64)}`, sourceCommit: 'c'.repeat(40), sourceSnapshotSha256: 'd'.repeat(64), importManifestSha256: 'e'.repeat(64),
    cutoverId: '11111111-2222-3333-4444-555555555555', volumeGeneration,
    recoverySourceManifestSha256: volumeGeneration ? 'f'.repeat(64) : null });
  const role = 'openclaw', s = spec.services[role], volumes = {};
  for (const [name] of s.mounts) volumes[managedVolumeName(spec, name)] = { Driver: 'local', Options: null,
    Labels: { 'clawbot.project': spec.project, 'clawbot.volume': name, 'clawbot.cutover': spec.cutoverId,
      ...(volumeGeneration ? { 'clawbot.generation': volumeGeneration } : {}) } };
  const image = { Id: s.image, Architecture: 'arm64', Config: { WorkingDir: '/app', Env: ['PATH=/usr/bin'], Labels: { 'org.opencontainers.image.revision': spec.sourceCommit } } };
  const c = { Image: s.image, Config: { Image: s.image, User: '1000:1000', WorkingDir: '/app',
    Labels: { 'com.docker.compose.project': spec.project, 'com.docker.compose.service': role },
    Entrypoint: s.entrypoint, Cmd: s.command, Healthcheck: { Test: s.health },
    Env: ['PATH=/usr/bin', ...Object.entries(s.env).map(([k, v]) => `${k}=${v}`)] }, State: { Paused: false },
    HostConfig: { ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'], CapAdd: [], SecurityOpt: ['no-new-privileges:true'],
      Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=128m,mode=1777' }, LogConfig: { Type: 'json-file', Config: { 'max-size': '5m', 'max-file': '2' } },
      NetworkMode: `container:${'e'.repeat(64)}`, PidMode: '', RestartPolicy: { Name: 'no' } }, NetworkSettings: { Ports: {} },
    Mounts: s.mounts.map(([name, Destination, RW]) => ({ Type: 'volume', Name: managedVolumeName(spec, name), Destination, RW })) };
  return { spec, c, image, volumes, valid: () => checkManagedContainer(spec, role, c, image, volumes) };
}
test('Production three-service descriptor has external state and no port publication or automatic Docker restart', () => {
  const { spec } = fixture(), compose = managedCompose(spec);
  assert.equal(compose.services.guard.pid, 'service:origin');
  assert.ok(Object.values(compose.services).every((s) => !s.ports && s.restart === 'no' && s.read_only));
  assert.equal(Object.keys(compose.volumes).length, 9);
  assert.ok(Object.values(compose.volumes).every((v) => v.external));
  assert.throws(() => managedRuntimeSpec({ ...spec, profile: 'rehearsal' }), /SPEC_INVALID/);
});
test('explicit recovery generations preserve old volume names and require matching volume labels and enable gates', () => {
  const generation = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', old = fixture(), next = fixture(generation);
  assert.ok(old.valid()); assert.ok(next.valid());
  const names = Object.values(managedCompose(old.spec).volumes).map(v => v.name);
  assert.ok(Object.values(managedCompose(next.spec).volumes).every(v => !names.includes(v.name)));
  const gate = { version: 1, enabled: true, project: old.spec.project, sourceCommit: old.spec.sourceCommit,
    cutoverId: old.spec.cutoverId, sourceSnapshotSha256: old.spec.sourceSnapshotSha256, importManifestSha256: old.spec.importManifestSha256 };
  assert.ok(activationMatches(gate, old.spec)); assert.equal(activationMatches(gate, next.spec), false);
  assert.equal(activationMatches({ ...gate, volumeGeneration: generation }, next.spec), false);
  assert.ok(activationMatches({ ...gate, volumeGeneration: generation, recoverySourceManifestSha256: 'f'.repeat(64) }, next.spec));
  delete next.volumes[Object.keys(next.volumes)[0]].Labels['clawbot.generation'];
  assert.equal(next.valid(), false);
  const mixed = fixture(generation); mixed.c.Mounts[0].Name = old.c.Mounts[0].Name; assert.equal(mixed.valid(), false);
});
test('Runtime boundary rejects altered commands, secrets, volumes, capabilities, injected environment and older release images', () => {
  assert.ok(fixture().valid());
  for (const mutate of [
    (f) => f.c.Config.Cmd = ['shell'],
    (f) => f.c.Config.Env.push('NODE_OPTIONS=--import=/tmp/evil.mjs'),
    (f) => f.c.Config.Healthcheck.Test = ['CMD', 'true'],
    (f) => f.c.Mounts.find((m) => m.Destination.endsWith('/secrets')).RW = true,
    (f) => f.c.Mounts[0].Type = 'bind',
    (f) => f.volumes[Object.keys(f.volumes)[0]].Options = { device: '/tmp/elsewhere' },
    (f) => f.c.HostConfig.CapAdd = ['SYS_ADMIN'],
    (f) => f.c.HostConfig.PortBindings = { '8888/tcp': [{ HostPort: '8888' }] },
    (f) => f.image.Config.Labels['org.opencontainers.image.revision'] = 'f'.repeat(40),
    (f) => f.c.HostConfig.RestartPolicy.Name = 'always',
  ]) { const f = fixture(); mutate(f); assert.equal(f.valid(), false); }
});
