// Fixed cloudflared 2026.8.3 JSON event shape. Do not classify arbitrary text
// or forward raw logs: they may contain identifiers, addresses or credentials.
export function classifyTunnelEvent(event) {
  if(!event||Array.isArray(event)||event.event!==0||!Number.isInteger(event.connIndex)||event.connIndex<0||event.connIndex>255)return null;
  if(event.level==='info'&&event.message==='Registered tunnel connection')return 'registration-accepted';
  if(!['error','warn'].includes(event.level))return null;
  if(event.message==='Register tunnel error from server side') {
    if(event.error==='Unauthorized: Invalid tunnel secret')return 'credential-rejected';
    if(event.error==='Unauthorized: Failed to get tunnel')return 'tunnel-unavailable';
    return 'registration-failed';
  }
  if(['Unable to establish connection with Cloudflare edge','Failed to dial a quic connection'].includes(event.message))return 'transport-unavailable';
  return null;
}
export function tunnelLogReader(accept) {
  let pending='',discard=false;
  return chunk=>{
    let start=0;
    while(start<chunk.length) {
      const end=chunk.indexOf('\n',start),part=chunk.slice(start,end<0?chunk.length:end);
      if(!discard) {
        if(pending.length+part.length>16384){pending='';discard=true;}
        else pending+=part;
      }
      if(end<0)break;
      if(!discard) {
        let event;try{event=classifyTunnelEvent(JSON.parse(pending));}catch{}
        if(event)accept(event);
      }
      pending='';discard=false;start=end+1;
    }
  };
}
export function observeTunnelChild(child,isCurrent,now=Date.now) {
  let authorization='not-checked',authorizationObservedAt=null,diagnostic='awaiting-registration',diagnosticObservedAt=null;
  const read=tunnelLogReader(event=>{
    if(!isCurrent())return;
    const at=now();diagnostic=event;diagnosticObservedAt=at;
    if(event==='registration-accepted'||event==='credential-rejected') {
      authorization=event==='registration-accepted'?'last-registration-accepted':'credential-rejected';authorizationObservedAt=at;
    }
    // A network error or unknown registration rejection is not evidence that
    // an earlier explicit credential rejection has recovered.
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data',chunk=>{if(isCurrent())read(chunk);});
  return ()=>({authorization,authorizationObservedAt,diagnostic,diagnosticObservedAt});
}
