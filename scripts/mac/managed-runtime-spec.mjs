export const ORIGIN_IMAGE = 'mayswind/ezbookkeeping@sha256:1043c95201f0432cd30328f6feb9a5b57359449400ea54fdf9a0c6138ab4c227';
export function managedVolumeName(spec, role) {
  return `${spec.volumePrefix ?? spec.project}_${role}`;
}
export function managedRuntimeSpec({ profile, project, runtimeImage, guardImage, sourceCommit, cutoverId, sourceSnapshotSha256, importManifestSha256, volumeGeneration = null, recoverySourceManifestSha256 = null }) {
  const production = profile === 'production';
  if (!(production ? project === 'clawbot-production' : profile === 'rehearsal' && /^clawbot-rehearsal-[a-f0-9]{12}$/.test(project))
    || ![runtimeImage, guardImage].every((value) => /^sha256:[a-f0-9]{64}$/.test(value ?? ''))
    || !/^[a-f0-9]{40}$/.test(sourceCommit ?? '')
    || (volumeGeneration !== null && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(volumeGeneration))
    || (volumeGeneration === null ? recoverySourceManifestSha256 !== null : !/^[a-f0-9]{64}$/.test(recoverySourceManifestSha256 ?? ''))
    || (production && (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(cutoverId ?? '')
      || !/^[a-f0-9]{64}$/.test(sourceSnapshotSha256 ?? '') || !/^[a-f0-9]{64}$/.test(importManifestSha256 ?? '')))) throw new Error('CLAWBOT_MANAGED_SPEC_INVALID');
  const root = production ? '/var/lib/clawbot' : '/var/lib/clawbot-test', port = production ? 8888 : 18888;
  const mounts = production ? {
    origin: [['ledger-config', `${root}/config`, false], ['ledger-data', `${root}/ledger`, true]],
    openclaw: [['runtime-config', '/run/clawbot-runtime', false], ['guard-config', '/run/clawbot-guard', false],
      ['openclaw-state', `${root}/openclaw`, true], ['codex-state', `${root}/codex`, true],
      ['receipts', `${root}/receipts`, true], ['secrets', `${root}/secrets`, false]],
    guard: [['guard-config', '/run/clawbot-guard', false], ['tunnel-config', '/run/clawbot-tunnel', false]],
  } : {
    origin: [['ledger-config', `${root}/config`, false], ['ledger-data', `${root}/ledger`, true]],
    openclaw: [], guard: [['guard-config', '/run/clawbot-guard', false]],
  };
  const volumePrefix = volumeGeneration ? `${project}-recovery-${volumeGeneration}` : project;
  return { profile, project, root, port, sourceCommit, cutoverId, sourceSnapshotSha256, importManifestSha256, volumeGeneration, volumePrefix, recoverySourceManifestSha256,
    services: {
      origin: { image: ORIGIN_IMAGE, entrypoint: ['/ezbookkeeping/ezbookkeeping'],
        command: ['--conf-path', `${root}/config/ezbookkeeping.ini`, '--no-boot-log', 'server', 'run'],
        health: ['CMD-SHELL', `wget -q -O /dev/null http://127.0.0.1:${port}/healthz.json`], env: {}, mounts: mounts.origin },
      openclaw: { image: runtimeImage, entrypoint: ['node', production ? '/opt/clawbot/docker/entrypoint.mjs' : '/opt/clawbot-guard/rehearsal-gateway.mjs'],
        command: production ? ['gateway'] : [],
        health: ['CMD', 'node', production ? '/opt/clawbot/docker/health.mjs' : '/opt/clawbot-guard/rehearsal-health.mjs'],
        env: production ? { HOME: `${root}/openclaw`, CODEX_HOME: `${root}/codex` } : {}, mounts: mounts.openclaw },
      guard: { image: guardImage, entrypoint: ['node', '/opt/clawbot-guard/supervisor.mjs'], command: [production ? '--tunnel' : '--test-publisher'],
        health: ['CMD', 'node', '/opt/clawbot-guard/health.mjs'], env: {}, mounts: mounts.guard },
    } };
}
export function managedCompose(spec) {
  const services = {}, volumes = {};
  for (const [role, s] of Object.entries(spec.services)) {
    services[role] = { image: s.image, platform: 'linux/arm64', user: '1000:1000', read_only: true,
      cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'], restart: 'no',
      tmpfs: ['/tmp:rw,nosuid,nodev,size=128m,mode=1777'], entrypoint: s.entrypoint, command: s.command,
      ...(Object.keys(s.env).length ? { environment: s.env } : {}),
      volumes: s.mounts.map(([name, target, rw]) => ({ type: 'volume', source: name, target, read_only: !rw })),
      healthcheck: { test: s.health, interval: '2s', timeout: '3s', retries: 10 },
      logging: { driver: 'json-file', options: { 'max-size': '5m', 'max-file': '2' } },
      ...(role === 'origin' ? {} : { network_mode: 'service:origin', depends_on: { origin: { condition: 'service_healthy' } } }),
      ...(role === 'guard' ? { pid: 'service:origin' } : {}) };
    for (const [name] of s.mounts) volumes[name] = { external: true, name: managedVolumeName(spec, name) };
  }
  return { name: spec.project, services, volumes };
}

export function checkManagedContainer(spec, role, c, image, volumes) {
  const expected = spec.services[role];
  const equal = (a, b) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
  if (!expected || c.Config?.Labels?.['com.docker.compose.project'] !== spec.project
    || c.Config.Labels['com.docker.compose.service'] !== role || c.Config.Image !== expected.image
    || c.Image !== image.Id || image.Architecture !== 'arm64' || c.Config.User !== '1000:1000'
    || c.Config.WorkingDir !== image.Config.WorkingDir
    || (spec.profile === 'production' && role !== 'origin' && image.Config.Labels?.['org.opencontainers.image.revision'] !== spec.sourceCommit)
    || !equal(c.Config.Entrypoint, expected.entrypoint) || !equal(c.Config.Cmd, expected.command)
    || !equal(c.Config.Healthcheck?.Test, expected.health) || c.State?.Paused
    || !c.HostConfig.ReadonlyRootfs || c.HostConfig.Privileged || !equal(c.HostConfig.CapDrop, ['ALL'])
    || c.HostConfig.CapAdd?.length || !c.HostConfig.SecurityOpt?.includes('no-new-privileges:true')
    || c.HostConfig.PublishAllPorts || Object.keys(c.HostConfig.PortBindings ?? {}).length
    || Object.values(c.NetworkSettings?.Ports ?? {}).some((value) => value?.length)
    || c.HostConfig.Devices?.length || c.HostConfig.DeviceRequests?.length
    || c.HostConfig.IpcMode === 'host' || c.HostConfig.UTSMode === 'host' || c.HostConfig.CgroupnsMode === 'host'
    || !['no', ''].includes(c.HostConfig.RestartPolicy?.Name ?? '')
    || !equal(Object.keys(c.HostConfig.Tmpfs ?? {}), ['/tmp'])
    || c.HostConfig.LogConfig?.Type !== 'json-file'
    || c.HostConfig.LogConfig.Config?.['max-size'] !== '5m' || c.HostConfig.LogConfig.Config?.['max-file'] !== '2') return false;
  function envMap(entries = []) {
    const result = {};
    for (const entry of entries) {
      const at = entry.indexOf('='); if (at < 1 || Object.hasOwn(result, entry.slice(0, at))) throw new Error('Duplicate environment');
      result[entry.slice(0, at)] = entry.slice(at + 1);
    }
    return result;
  }
  try {
    const wanted = { ...envMap(image.Config.Env), ...expected.env }, actual = envMap(c.Config.Env);
    if (Object.keys(actual).length !== Object.keys(wanted).length || Object.entries(wanted).some(([k, v]) => actual[k] !== v)) return false;
  } catch { return false; }
  const persistent = c.Mounts.filter((m) => m.Type !== 'tmpfs');
  if (persistent.length !== expected.mounts.length) return false;
  for (const [name, path, rw] of expected.mounts) {
    const mount = persistent.find((m) => m.Destination === path), volume = volumes[managedVolumeName(spec, name)];
    if (mount?.Type !== 'volume' || mount.Name !== managedVolumeName(spec, name) || mount.RW !== rw
      || volume?.Driver !== 'local' || Object.keys(volume.Options ?? {}).length
      || volume?.Labels?.['clawbot.project'] !== spec.project || volume.Labels['clawbot.volume'] !== name
      || (volume?.Labels?.['clawbot.generation'] ?? null) !== spec.volumeGeneration
      || (spec.profile === 'production' && volume.Labels['clawbot.cutover'] !== spec.cutoverId)) return false;
  }
  if (role === 'origin') return !c.HostConfig.PidMode && c.HostConfig.NetworkMode === `${spec.project}_default`
    && Object.keys(c.NetworkSettings.Networks ?? {}).every((name) => name === `${spec.project}_default`);
  return /^container:[a-f0-9]{64}$/.test(c.HostConfig.NetworkMode)
    && (role === 'guard' ? /^container:[a-f0-9]{64}$/.test(c.HostConfig.PidMode) : !c.HostConfig.PidMode);
}
