import assert from 'node:assert/strict';
import { updateTunnelCredential } from './tunnel-credential-update.mjs';
try {
  const action=process.argv[2];assert.equal(process.argv.length,3);
  let input='';for await(const chunk of process.stdin){input+=chunk;assert.ok(input.length<=16384);}
  const {candidateText,review,target}=JSON.parse(input);
  const result=await updateTunnelCredential({root:'/run/clawbot-tunnel',guardRoot:'/run/clawbot-guard',target,candidateText,action,review});
  console.log(JSON.stringify(result));
}catch{console.error('CLAWBOT_TUNNEL_CREDENTIAL_UPDATE_REFUSED_MAINTENANCE_REQUIRED');process.exitCode=1;}
