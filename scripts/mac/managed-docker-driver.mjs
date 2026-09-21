import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { statfsSync } from 'node:fs';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { checkManagedContainer, managedVolumeName } from './managed-runtime-spec.mjs';
import { storageDecision } from './runtime-controller.mjs';
import { diagnosticError, containerDiagnostics } from './host-diagnostics.mjs';
const exec = promisify(execFile), docker = '/Applications/Docker.app/Contents/Resources/bin/docker';
export function managedDockerDriver(spec, composePath, { latchStorageFault, validateRehearsalInputs, onDiagnostic,
  execute = exec, clock = Date.now } = {}) {
  const env = { ...process.env, PATH: `/Applications/Docker.app/Contents/Resources/bin:${process.env.PATH}` };
  const compose = ['compose', '-f', composePath];
  let lastView;
  const observe = event => { try { onDiagnostic?.(event); } catch {} };
  function commandPhase(args) {
    const commands = new Set(['info', 'ps', 'inspect', 'image', 'volume', 'network', 'exec', 'run', 'stop', 'rm', 'compose', 'stats']);
    const subcommands = new Set(['inspect', 'ls', 'create', 'rm']);
    return `docker.${commands.has(args[0]) ? args[0] : 'other'}${subcommands.has(args[1]) ? `.${args[1]}` : ''}`;
  }
  async function run(args, timeout = 20000, phase = commandPhase(args)) {
    const started = clock(); observe({ event: 'command-start', phase });
    try {
      const result = await execute(docker, args, { env, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 });
      const elapsedMs = clock() - started;
      if (elapsedMs >= 2500) observe({ event: 'command-slow', phase, elapsedMs });
      return result.stdout.trim();
    } catch (cause) {
      const diagnostic = diagnosticError(cause, { elapsedMs: clock() - started, timeoutMs: timeout });
      observe({ event: 'command-failed', phase, error: diagnostic });
      throw Object.assign(new Error('CLAWBOT_DOCKER_OPERATION_FAILED'), { diagnostic });
    }
  }
  const json = async (args, phase) => JSON.parse(await run(args, 20000, phase));
  const helper = (mounts, script, args = []) => ['run', '--rm', '--network', 'none', '--read-only', '--user', '1000:1000',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', ...mounts.flatMap(([name, target]) =>
      ['--mount', `type=volume,src=${managedVolumeName(spec, name)},dst=${target},readonly`]),
    '--entrypoint', 'node', spec.services.openclaw.image, ...script, ...args];
  return {
    run,
    async createStopped() {
      // Initial provisioning is separate from auto-recovery. Never adopt or
      // recreate an existing/partial project while preparing its first run.
      if (await run(['ps', '-a', '-q', '--filter', `label=com.docker.compose.project=${spec.project}`])
        || await run(['network', 'ls', '--format', '{{.Name}}', '--filter', `name=^${spec.project}_default$`])) throw new Error('CLAWBOT_INITIAL_RUNTIME_EXISTS');
      for (const [role, service] of Object.entries(spec.services)) {
        const image = (await json(['image', 'inspect', service.image]))[0];
        if (image.Architecture !== 'arm64' || (spec.profile === 'production' && role !== 'origin'
          && (image.Id !== service.image || image.Config.Labels?.['org.opencontainers.image.revision'] !== spec.sourceCommit))) throw new Error('CLAWBOT_INITIAL_IMAGE_IDENTITY');
      }
      if (!await this.validateInputs() || storageDecision(await this.storage()) !== 'ok') throw new Error('CLAWBOT_INITIAL_INPUTS');
      await run([...compose, 'create', '--no-build', '--pull', 'never', '--no-recreate'], 60000);
      const view = await this.inspect();
      if (!view.identityValid || !view.namespaceValid || Object.values(view.running).some(Boolean)) throw new Error('CLAWBOT_INITIAL_BOUNDARY');
      return view;
    },
    async validateVolumes(phase = 'volumes.identity') {
      try {
        const roles = new Set(Object.values(spec.services).flatMap((service) => service.mounts.map(([name]) => name)));
        for (const role of roles) {
          const name = managedVolumeName(spec, role), v = (await json(['volume', 'inspect', name], phase))[0];
          if (v.Name !== name || v.Driver !== 'local' || Object.keys(v.Options ?? {}).length
            || v.Labels?.['clawbot.project'] !== spec.project || v.Labels['clawbot.volume'] !== role
            || (v.Labels['clawbot.generation'] ?? null) !== spec.volumeGeneration
            || (spec.profile === 'production' && v.Labels['clawbot.cutover'] !== spec.cutoverId)) return false;
        }
        return true;
      } catch (error) { observe({ event: 'volume-inspection-failed', phase, error: error.diagnostic ?? diagnosticError(error) }); return false; }
    },
    async inspect() {
      try { await run(['info', '--format', '{{.ServerVersion}}']); }
      catch { return { available: false, trusted: {} }; }
      const view = { available: true, identityValid: true, namespaceValid: false, healthy: false, trusted: {}, ready: {}, running: {}, diagnostics: {} };
      try {
        const ids = (await run(['ps', '-a', '-q', '--filter', `label=com.docker.compose.project=${spec.project}`])).split('\n').filter(Boolean);
        const containers = ids.length ? await json(['inspect', ...ids]) : [];
        const volumes = {}, images = {}, members = {};
        for (const service of Object.values(spec.services)) {
          images[service.image] ??= (await json(['image', 'inspect', service.image]))[0];
          for (const [name] of service.mounts) {
            const id = managedVolumeName(spec, name);
            volumes[id] ??= (await json(['volume', 'inspect', id]))[0];
          }
        }
        for (const role of ['origin', 'openclaw', 'guard']) {
          const matches = containers.filter((c) => c.Config.Labels['com.docker.compose.service'] === role);
          if (matches.length !== 1) { view.identityValid = false; continue; }
          const c = matches[0]; members[role] = c;
          view.diagnostics[role] = containerDiagnostics(c);
          if (checkManagedContainer(spec, role, c, images[spec.services[role].image], volumes)) view.trusted[role] = c.Id;
          else view.identityValid = false;
          view.running[role] = c.State.Running;
          view.ready[role] = c.State.Running && c.State.Health?.Status === 'healthy';
        }
        if (containers.length !== 3) view.identityValid = false;
        const net = (await json(['network', 'inspect', `${spec.project}_default`]))[0];
        if (net.Driver !== 'bridge' || net.Labels?.['com.docker.compose.project'] !== spec.project
          || Object.keys(net.Containers ?? {}).some((id) => id !== members.origin?.Id)) view.identityValid = false;
        const ns = `container:${members.origin?.Id}`;
        view.namespaceValid = members.openclaw?.HostConfig.NetworkMode === ns && members.guard?.HostConfig.NetworkMode === ns
          && members.guard?.HostConfig.PidMode === ns;
        view.healthy = ['origin', 'openclaw', 'guard'].every((role) => view.ready[role]);
      } catch (error) { view.identityValid = false; observe({ event: 'inspection-failed', phase: 'runtime.identity', error: error.diagnostic ?? diagnosticError(error) }); }
      lastView = view; return view;
    },
    async validateInputs() {
      if (!await this.validateVolumes()) return false;
      if (spec.profile === 'rehearsal') return validateRehearsalInputs?.() ?? false;
      const mounts = [['ledger-config', `${spec.root}/config`], ['runtime-config', '/run/clawbot-runtime'],
        ['guard-config', '/run/clawbot-guard'], ['tunnel-config', '/run/clawbot-tunnel']];
      const roles = new Set(Object.values(spec.services).flatMap((service) => service.mounts.map(([name]) => name)));
      if (spec.volumeGeneration) {
        const binding = { project: spec.project, sourceCommit: spec.sourceCommit, cutoverId: spec.cutoverId,
          importManifestSha256: spec.importManifestSha256, volumeGeneration: spec.volumeGeneration,
          recoverySourceManifestSha256: spec.recoverySourceManifestSha256 };
        if (await run(helper([...roles].map(role => [role, `/generation/${role}`]),
          ['/opt/clawbot/docker/verify-generation-receipts.mjs'], [JSON.stringify(binding)])) !== 'CLAWBOT_RECOVERY_GENERATION_COMPLETE') return false;
      }
      mounts.push(...[...roles].map((role) => [role, `/proof/${role}`]));
      return await run(helper(mounts, ['/opt/clawbot/docker/production-preflight.mjs'],
        [spec.cutoverId, spec.sourceSnapshotSha256, spec.sourceCommit, spec.importManifestSha256])) === 'CLAWBOT_PRODUCTION_INPUTS_OK';
    },
    async stop(role, id) {
      // Recheck the specific ID before signalling, including after any earlier
      // stop changed namespace liveness. Never stop by a broad process match.
      if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid container identity');
      const view = await this.inspect();
      if (view.trusted[role] !== id) throw new Error('Container identity changed before stop');
      if (view.running[role]) await run(['stop', '--time', '20', id], 25000, `lifecycle.stop.${role}`);
    },
    async retireStopped({ allowPartial = false } = {}) {
      const view = await this.inspect();
      if (!view.available || (!allowPartial && (!view.identityValid || !view.namespaceValid))
        || Object.values(view.running).some(Boolean)) throw Error('CLAWBOT_RETIRE_REQUIRES_STOPPED_IDENTITY');
      const ids = (await run(['ps', '-a', '-q', '--no-trunc', '--filter', `label=com.docker.compose.project=${spec.project}`])).split('\n').filter(Boolean).sort();
      if (JSON.stringify(ids) !== JSON.stringify(Object.values(view.trusted).sort())) throw Error('CLAWBOT_RETIRE_UNKNOWN_MEMBER');
      for (const role of ['guard', 'openclaw', 'origin']) {
        const id = view.trusted[role]; if (!id) continue;
        const current = await this.inspect();
        if (current.trusted[role] !== id || current.running[role]) throw Error('CLAWBOT_RETIRE_MEMBER_CHANGED');
        // No force removal, no volume deletion and no signal to a running app.
        await run(['rm', id]);
      }
      if (await run(['ps', '-a', '-q', '--filter', `label=com.docker.compose.project=${spec.project}`])) throw Error('CLAWBOT_RETIRE_NEW_MEMBER');
      const name = `${spec.project}_default`;
      if (await run(['network', 'ls', '--format', '{{.Name}}', '--filter', `name=^${name}$`])) {
        const network = (await json(['network', 'inspect', name]))[0];
        if (network.Driver !== 'bridge' || network.Labels?.['com.docker.compose.project'] !== spec.project
          || Object.keys(network.Containers ?? {}).length) throw Error('CLAWBOT_RETIRE_NETWORK_IN_USE');
        await run(['network', 'rm', name]);
      }
    },
    async start(role, recreate) {
      if (!['origin', 'openclaw', 'guard'].includes(role) || !lastView?.identityValid) throw new Error('Unverified managed start');
      await run([...compose, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', ...(recreate ? ['--force-recreate'] : []), role], 45000, `lifecycle.start.${role}`);
    },
    async requireReady(role) {
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        const view = await this.inspect();
        if (!view.identityValid) throw new Error('Runtime identity changed during readiness');
        if (view.ready[role]) return;
        await delay(1000);
      }
      throw new Error('Runtime readiness timeout');
    },
    async storage() {
      try {
        if (!await this.validateVolumes('storage.volume-identity')) return { error: 'STORAGE_IDENTITY_INVALID' };
        observe({ event: 'command-start', phase: 'storage.host-free' });
        const host = statfsSync(homedir());
        const free = await run(helper([['ledger-data', `${spec.root}/ledger`]], ['--input-type=module', '-e',
          'import{statfsSync}from"node:fs";const s=statfsSync(process.argv[1]);console.log(s.bavail*s.bsize)', `${spec.root}/ledger`]), 20000, 'storage.volume-free');
        return { hostFreeBytes: host.bavail * host.bsize, volumeFreeBytes: Number(free) };
      } catch (error) {
        const diagnostic = error.diagnostic ?? diagnosticError(error);
        observe({ event: 'storage-failed', phase: 'storage.sample', error: diagnostic });
        return { error: 'STORAGE_UNAVAILABLE', diagnostic };
      }
    },
    async diagnosticStats() {
      if (!lastView?.identityValid) return undefined;
      const roles = ['origin', 'openclaw', 'guard'], ids = roles.map(role => lastView.trusted[role]);
      const rows = (await run(['stats', '--no-stream', '--format', '{{json .}}', ...ids], 5000, 'resources.docker-stats')).split('\n').filter(Boolean).map(JSON.parse);
      const result = {};
      for (const [index, role] of roles.entries()) {
        const row = rows.find(r => r.ID === ids[index] || (typeof r.ID === 'string' && r.ID.length >= 12 && ids[index].startsWith(r.ID)));
        if (row) result[role] = { cpuPercent: parseFloat(row.CPUPerc), memoryPercent: parseFloat(row.MemPerc), pids: Number(row.PIDs), memoryUsage: row.MemUsage };
      }
      return result;
    },
    async latchStorageFault() { if (!latchStorageFault) throw new Error('Missing storage latch'); await latchStorageFault(); },
  };
}
