const $ = id => document.getElementById(id);
const hostStates = { healthy: '运行正常', disabled: '尚未启用', maintenance: '正在维护',
  'waiting-for-docker': '等待 Docker 恢复', 'another-operation': '后台任务进行中', 'host-needs-attention': '生产宿主需要检查',
  'stopped-low-disk': '空间不足，服务已停止', 'low-disk-no-restart': '空间偏低，暂停恢复', 'healthy-low-disk': '服务运行中，空间偏低',
  'guard-unready': '公网连接守护未就绪', 'recovery-backoff': '等待下一次恢复检查', 'storage-fault': '存储故障待核验',
  'storage-fault-latched': '存储故障待核验', 'identity-needs-attention': '服务身份或连接需要核验',
  'activation-needs-attention': '启用条件需要核验', 'recovery-needs-attention': '服务恢复需要检查',
  'inspection-unavailable': '暂时无法确认生产状态', checking: '正在检查生产状态' };
const models = { 'credentials-present': '本地凭据存在，云端调用未验证', 'login-required': '需要完成模型登录',
  'runtime-unavailable': '官方模型运行时不可用', unknown: '授权状态无法确认', stale: '授权检查已过期',
  'inspection-unavailable': '暂时无法取得授权状态' };
const warnings = { 'reauthorization-required': '需要重新授权', 'temporarily-unavailable': '上游暂时不可用', 'rate-limited': '上游限流',
  'billing-unavailable': '账单状态需要处理', 'expiry-metadata-needs-verification': '到期信息待核验', 'profile-needs-inspection': '授权记录需要检查' };
const ledgerStates = { 'accepted-read-only': '授权检查通过', 'credential-unavailable': '本地凭据不可用',
  'credential-rejected': '授权被拒绝', 'credential-expired': '授权已过期', 'credential-type-mismatch': '凭据类型不匹配',
  'interactive-auth-required': '需要交互登录', 'credential-missing': '缺少凭据', 'api-token-disabled': '此类令牌已禁用',
  'rate-limited': '请求受限，稍后重试', 'source-denied': '连接来源被拒绝', 'service-unavailable': '账本暂不可用',
  'unrecognized-response': '返回状态无法确认', 'request-timeout': '检查超时', 'transport-unavailable': '暂时无法连接账本',
  'credential-configuration-mismatch': '两种授权配置不一致', 'endpoint-mismatch': '连接地址不一致', 'required-tool-unavailable': '历史查询工具不可用' };
const weixinStates = { 'not-enabled': '未启用微信接收', 'runtime-disabled': '微信接收已禁用', 'login-required': '需要完成微信登录',
  'reauthorization-required': '微信明确要求重新授权', 'awaiting-poll': '正在等待首次轮询', 'poll-timeout': '本次轮询超时',
  'transport-unavailable': '微信网络暂不可用', 'response-unrecognized': '微信返回状态无法确认', 'api-unavailable': '微信接口暂不可用',
  'message-processing-failed': '消息处理失败，需要检查', 'not-running': '微信接收器未运行', unknown: '微信授权无法确认',
  'poll-stale': '最近轮询状态已过期', 'last-poll-accepted': '最近一次轮询被微信接受', 'gateway-unavailable': '无法取得接收器实时状态',
  'inspection-unavailable': '暂时无法取得微信状态', stale: '微信检查已过期' };
const tunnelStates = { 'not-started': '公网连接尚未启动', 'awaiting-registration': '等待公网连接注册', 'registration-accepted': '最近一次注册已被接受',
  'credential-rejected': '公网连接凭据被拒绝', 'tunnel-unavailable': '无法取得指定的公网连接', 'registration-failed': '公网连接注册失败',
  'transport-unavailable': '公网连接网络暂不可用' };
function unavailable(message) {
  $('overall-dot').classList.remove('good');
  for (const id of ['overall', 'host-state', 'model', 'ledger-http', 'ledger-mcp', 'weixin', 'weixin-time', 'tunnel']) $(id).textContent = message;
  for (const id of ['power', 'disk', 'uptime']) $(id).textContent = '—';
  $('services').replaceChildren();
  $('updated').textContent = '暂无当前采样'; $('authorization-updated').textContent = '授权状态等待重新核验';
}
function node(tag, value, className) { const n = document.createElement(tag); n.textContent = value; if (className) n.className = className; return n; }
function attentionReason(state) {
  if (['login-required', 'reauthorization-required'].includes(state.weixinAuthorization?.state)) return '微信需要重新登录';
  if (state.modelAuthorization?.state === 'login-required'
    || state.modelAuthorization?.warnings?.includes('reauthorization-required')) return '模型需要重新授权';
  if (state.modelAuthorization?.warnings?.some(w => ['temporarily-unavailable', 'rate-limited', 'billing-unavailable'].includes(w))) return '模型服务暂不可用，查看下方详情';
  if (state.tunnelAuthorization?.authorization === 'credential-rejected') return '公网隧道授权被拒绝';
  if (state.tunnelAuthorization?.state === 'observed'
    && ['transport-unavailable', 'registration-failed', 'tunnel-unavailable'].includes(state.tunnelAuthorization.diagnostic)) return '公网连接需要检查';
  if (['transport-unavailable', 'message-processing-failed', 'response-unrecognized'].includes(state.weixinAuthorization?.state)) return '微信连接需要检查';
  if (state.ledgerAuthorization?.state === 'observed'
    && ['http', 'mcp'].some(role => ['credential-rejected', 'credential-expired', 'credential-unavailable', 'credential-missing'].includes(state.ledgerAuthorization[role]?.state))) return '账本授权需要处理';
  return '';
}
let polling = false;
async function poll() {
  if (polling) return; polling = true;
  try {
    const response = await fetch('/status.json', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw Error(); const state = await response.json(), age = Date.now() - Date.parse(state.updatedAt);
    if (state.profile !== 'production' || !Number.isFinite(age) || age < 0 || age >= 20000) {
      unavailable('状态已过期或尚未就绪，当前情况无法确认'); return;
    }
    const attention = attentionReason(state);
    $('overall').textContent = !state.boundaryHealthy ? hostStates[state.state] ?? '状态待确认' : attention ? '需要处理' : '运行正常';
    $('overall-dot').classList.toggle('good', state.boundaryHealthy === true && !attention);
    const servicesStillRunning = state.services?.length === 3 && state.services.every(service => service.running === true);
    $('host-state').textContent = attention || (state.boundaryHealthy ? '微信记账与账本网页服务已启动'
      : state.state === 'maintenance' ? '正在备份或更新，完成后恢复服务'
      : state.state === 'another-operation' && servicesStillRunning ? '服务仍在运行，状态检查稍后刷新' : '展开运行详情查看连接情况');
    $('power').textContent = state.acPower === true ? '已插电' : state.acPower === false ? '使用电池' : '暂不可用';
    $('disk').textContent = Number.isFinite(state.immediatelyFreeBytes) ? `${(state.immediatelyFreeBytes / 2 ** 30).toFixed(1)} GiB` : '—';
    $('uptime').textContent = Number.isFinite(state.uptimeSeconds) ? `${Math.floor(state.uptimeSeconds / 3600)} 小时` : '—';
    const names = { origin: '账本', openclaw: '微信记账', guard: '公网访问' };
    $('services').replaceChildren(...(state.services ?? []).map(service => {
      let label = service.health === 'healthy' && service.running ? '运行中' : service.running ? '正在启动' : '已停止';
      let detail = service.running ? '等待连接检查' : '等待服务恢复';
      if (service.running && service.name === 'origin') {
        const ledger = state.ledgerAuthorization;
        if (ledger?.state === 'observed' && ledger.http?.state === 'accepted-read-only') { label = '连接正常'; detail = '本机保存账本数据'; }
        else detail = ledgerStates[ledger?.http?.state] ?? '正在核验账本连接';
      }
      if (service.running && service.name === 'openclaw') {
        if (state.weixinAuthorization?.state === 'last-poll-accepted') { label = '接收正常'; detail = '最近一次微信连接成功'; }
        else if (['login-required', 'reauthorization-required'].includes(state.weixinAuthorization?.state)) { label = '需要登录'; detail = '微信授权需要更新'; }
        else detail = weixinStates[state.weixinAuthorization?.state] ?? '正在核验微信连接';
      }
      if (service.running && service.name === 'guard') {
        const tunnel = state.tunnelAuthorization;
        if (tunnel?.state === 'observed' && tunnel.publisherRunning && tunnel.diagnostic === 'registration-accepted'
          && tunnel.authorization !== 'credential-rejected') { label = '隧道已连接'; detail = '通过 Cloudflare 访问账本'; }
        else detail = tunnel?.state === 'observed' ? tunnelStates[tunnel.diagnostic] ?? '正在核验公网连接' : '正在核验公网连接';
      }
      const card = node('article', '', 'service'); card.append(node('h3', names[service.name] ?? '服务'), node('p', label, 'service-state'), node('small', detail));
      return card;
    }));
    const model = state.modelAuthorization;
    $('model').textContent = [models[model?.state] ?? '授权状态无法确认', ...(model?.warnings ?? []).map(w => warnings[w] ?? '授权记录需要检查')].join('；');
    const ledger = state.ledgerAuthorization;
    for (const [role, label] of [['http', '账本连接'], ['mcp', '历史查询连接']]) $('ledger-' + role).textContent = label + '：'
      + (ledger?.state === 'observed' ? ledgerStates[ledger[role]?.state] ?? '授权状态无法确认' : ledger?.state === 'stale' ? '检查已过期' : '暂时无法取得授权状态')
      + (ledger?.state === 'observed' && ledger[role]?.sessionCleanup === 'not-confirmed' ? '；检查会话清理未确认' : '');
    const weixin = state.weixinAuthorization;
    $('weixin').textContent = weixinStates[weixin?.state] ?? '微信状态无法确认';
    $('weixin-time').textContent = weixin?.state === 'last-poll-accepted' && weixin.pollObservedAt
      ? `最近成功轮询 ${new Date(weixin.pollObservedAt).toLocaleString('zh-CN', { hour12: false })}` : '当前没有可确认的近期成功轮询';
    const tunnel = state.tunnelAuthorization;
    $('tunnel').textContent = tunnel?.state === 'observed'
      ? (tunnelStates[tunnel.diagnostic] ?? '公网连接状态无法确认') + (tunnel.authorization === 'credential-rejected' && tunnel.diagnostic !== 'credential-rejected' ? '；仍需处理此前的凭据拒绝' : '')
      : tunnel?.state === 'stale' ? '公网连接检查已过期' : '暂时无法取得公网连接状态';
    $('updated').textContent = `最近采样 ${new Date(state.updatedAt).toLocaleTimeString('zh-CN', { hour12: false })}`;
    $('authorization-updated').textContent = state.authorizationChecking ? '后台正在检查授权，页面继续刷新' : '授权每 5 分钟检查；真实微信与公网验收另行记录';
  } catch { unavailable('状态连接中断，当前情况无法确认'); }
  finally { polling = false; }
}
setInterval(() => { $('clock').textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false }); }, 1000);
poll(); setInterval(poll, 5000);
