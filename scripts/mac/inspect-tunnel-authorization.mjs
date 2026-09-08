import assert from 'node:assert/strict';
import { join,resolve } from 'node:path';
import { readManagedHostRelease } from './managed-host-release.mjs';
import { managedDockerDriver } from './managed-docker-driver.mjs';
import { inspectTunnelAuthorization } from './tunnel-authorization-inspection.mjs';
try {
  assert.equal(process.argv.length,3);
  const host=resolve(process.argv[2]),{spec}=readManagedHostRelease(host);
  const driver=managedDockerDriver(spec,join(host,'compose.json'));
  async function inspect() {
    const view=await driver.inspect();
    if(view.identityValid&&view.running.guard)view.guardStartedAt=await driver.run(['inspect','--format','{{.State.StartedAt}}',view.trusted.guard]);
    return view;
  }
  const report=await inspectTunnelAuthorization({inspect,readStatus:async id=>
    JSON.parse(await driver.run(['exec',id,'node','-e',
      'const f=require("node:fs"),p="/tmp/clawbot-guard-status.json",s=f.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.size>8192)throw Error();process.stdout.write(f.readFileSync(p,"utf8"))']))});
  console.log(JSON.stringify(report));
  if(report.state!=='observed')process.exitCode=2;
}catch{console.log(JSON.stringify({version:1,state:'inspection-unavailable',remoteVerified:false}));process.exitCode=1;}
