const $ = (id) => document.getElementById(id);
function text(tag, value, className) { const node = document.createElement(tag); node.textContent = value; if (className) node.className = className; return node; }
const names = { origin: '账本服务', openclaw: '微信记账代理（测试）' };
let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    const response = await fetch('/status.json', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error();
    const state = await response.json();
    const age = Date.now() - Date.parse(state.updatedAt);
    const fresh = Number.isFinite(age) && age >= 0 && age < 20000;
    const good = fresh && state.boundaryHealthy === true;
    $('overall').textContent = good ? '隔离测试服务运行正常' : fresh ? '开发环境有服务待恢复' : '正在等待新状态';
    $('overall-dot').classList.toggle('good', good);
    $('stage').textContent = state.phase ?? '正在读取开发进度';
    if (state.migration) {
      $('migration-title').textContent = state.migration.title;
      $('migration-detail').textContent = state.migration.detail;
      $('migration-updated').textContent = `人工进度更新：${new Date(state.migration.updatedAt).toLocaleString('zh-CN', { hour12: false })}（服务健康以实时卡片为准）`;
    } else {
      $('migration-title').textContent = 'Mac 交接前准备已完成';
      $('migration-detail').textContent = '当前迁移进度记录不可用，不能据此判断正式服务的接管情况。';
      $('migration-updated').textContent = '迁移进度等待同步';
    }
    $('power').textContent = state.acPower === true ? '电源已连接' : state.acPower === false ? '使用电池' : '暂不可用';
    $('disk').textContent = Number.isFinite(state.immediatelyFreeBytes) ? `${(state.immediatelyFreeBytes / 2 ** 30).toFixed(1)} GiB` : '—';
    const hours = Math.floor((state.uptimeSeconds ?? 0) / 3600);
    $('uptime').textContent = hours >= 24 ? `${Math.floor(hours / 24)} 天 ${hours % 24} 小时` : `${hours} 小时`;
    $('production').textContent = state.productionHost ?? '尚未远程核验';
    const states = { healthy: '身份与运行检查通过', maintenance: '维护中，自动恢复暂停', 'waiting-for-docker': '等待 Docker',
      'stopped-low-disk': '空间不足，已停服务', 'low-disk-no-restart': '空间偏低，暂停恢复', recovering: '正在恢复',
      'recovery-backoff': '等待下一次恢复检查', 'another-operation': '备份或维护操作进行中',
      'identity-or-recovery-needs-attention': '身份或恢复异常，需要核验', stale: '守护状态过期', unavailable: '守护状态暂不可用' };
    $('host-state').textContent = states[state.hostState] ?? '正在读取守护状态';
    const observation = state.observation;
    $('observation').textContent = !fresh ? '状态已过期，无法确认当前监控结果' : observation?.status === 'recording'
      ? `日常监控 · 当前看板版本连续健康 ${(observation.continuousMs / 3600000).toFixed(2)} 小时 · 已采样 ${observation.samples} 次 · 中断 ${observation.gaps} 次 · 非健康采样 ${observation.unhealthy} 次`
      : observation?.status === 'budget-reached' ? '采样已达到保留预算，请归档后开启下一轮' : '连续采样不可用，需要核验记录';
    $('backup').textContent = state.backup?.status === 'verified-locally'
      ? `最近一次完整离线恢复已通过：${new Date(state.backup.checkedAt).toLocaleString('zh-CN', { hour12: false })} · 已验证副本 ${state.backup.verifiedCopies} 份`
      : '尚未找到已完成恢复验证的备份';
    const auth = state.modelAuthorization;
    const authStates = { 'credentials-present': '本地模型凭据存在，云端调用未验证', 'login-required': '需要在本机完成模型登录',
      'runtime-unavailable': '官方模型运行时不可用，需要检查', unknown: '授权状态无法确认',
      stale: '授权检查已过期，等待重新核验', 'inspection-unavailable': '暂时无法取得授权状态' };
    const authWarnings = { 'reauthorization-required': '上游记录了需要重新授权的故障', 'temporarily-unavailable': '上游暂时不可用',
      'rate-limited': '上游限流，等待后再试', 'billing-unavailable': '上游账单状态需要处理',
      'expiry-metadata-needs-verification': '到期信息待核验，可能仍支持自动刷新', 'profile-needs-inspection': '有授权记录需要检查' };
    $('model-authorization').textContent = [authStates[auth?.state] ?? '等待授权检查',
      ...(auth?.warnings ?? []).map(w => authWarnings[w] ?? '授权状态需要检查')].join('；');
    $('model-authorization-updated').textContent = (auth?.observedAt
      ? `最近检查 ${new Date(auth.observedAt).toLocaleString('zh-CN', { hour12: false })}` : '尚无可用检查结果')
      + (auth?.checking ? ' · 正在检查' : ' · 每 5 分钟检查一次');
    const ledger = state.ledgerAuthorization;
    const ledgerStates = { 'accepted-read-only': '授权检查通过', 'credential-unavailable': '本地凭据不可用',
      'credential-rejected': '授权被拒绝，需要重新授权', 'credential-expired': '授权已过期',
      'credential-type-mismatch': '凭据类型不匹配', 'interactive-auth-required': '需要交互登录',
      'credential-missing': '缺少凭据', 'api-token-disabled': '账本已禁用此类令牌',
      'rate-limited': '请求受限，稍后重试', 'source-denied': '连接来源被拒绝',
      'service-unavailable': '账本服务暂不可用', 'unrecognized-response': '返回状态无法确认',
      'request-timeout': '检查超时', 'transport-unavailable': '暂时无法连接账本',
      'credential-configuration-mismatch': '两种授权配置不一致', 'endpoint-mismatch': '查询连接地址不一致',
      'required-tool-unavailable': '历史查询工具不可用' };
    for (const [role, label] of [['http', '账本连接'], ['mcp', '历史查询连接']]) {
      const description = !fresh ? '状态已过期，当前授权无法确认'
        : ledger?.state === 'stale' ? '检查已过期，等待重新核验'
        : ledger?.state === 'observed' ? ledgerStates[ledger[role]?.state] ?? '授权状态无法确认'
        : '暂时无法取得授权状态';
      $('ledger-' + role + '-authorization').textContent = label + '：' + description
        + (fresh && ledger?.state === 'observed' && ledger[role]?.sessionCleanup === 'not-confirmed' ? '；检查会话清理未确认' : '');
    }
    $('ledger-authorization-updated').textContent = (ledger?.observedAt
      ? `最近检查 ${new Date(ledger.observedAt).toLocaleString('zh-CN', { hour12: false })}` : '尚无可用检查结果')
      + (ledger?.checking ? ' · 正在检查' : ' · 每 5 分钟检查一次');
    const weixin = state.weixinAuthorization;
    $('weixin-authorization').textContent = !fresh ? '状态已过期，当前微信接收配置无法确认'
      : weixin?.state === 'not-enabled' ? '未启用真实微信接收'
      : weixin?.state === 'stale' ? '配置检查已过期，等待重新核验' : '暂时无法确认微信接收配置';
    $('weixin-authorization-updated').textContent = (weixin?.observedAt
      ? `最近检查 ${new Date(weixin.observedAt).toLocaleString('zh-CN', { hour12: false })}` : '尚无可用检查结果')
      + (weixin?.checking ? ' · 正在检查' : ' · 每 5 分钟检查一次');
    $('updated').textContent = state.updatedAt ? `最近采样 ${new Date(state.updatedAt).toLocaleTimeString('zh-CN', { hour12: false })}${fresh ? '' : ' · 数据已过期'}` : '等待首次采样';
    const cards = state.services.map((service) => {
      const card = text('article', '', 'service');
      const header = text('header', '');
      header.append(text('h3', names[service.name] ?? '服务'));
      const healthy = service.running && service.health === 'healthy' && service.readOnly && service.publishedPorts === 0;
      header.append(text('span', healthy ? '健康' : service.running ? '正在检查' : '已停止', `status${healthy ? '' : ' bad'}`));
      const list = text('dl', '');
      for (const [label, value] of [['CPU', service.cpu], ['内存', service.memory], ['重启次数', service.restarts], ['对外端口', service.publishedPorts]]) {
        const group = text('div', ''); group.append(text('dt', label), text('dd', String(value))); list.append(group);
      }
      card.append(header, list, text('p', service.readOnly ? '只读系统 · 业务数据独立保存' : '运行权限需要检查', 'details'));
      return card;
    });
    $('services').replaceChildren(...(cards.length ? cards : [text('article', 'Docker 暂不可用，或测试容器尚未启动。', 'service')]));
  } catch {
    $('overall').textContent = '无法读取状态页面服务'; $('overall-dot').classList.remove('good');
    $('model-authorization').textContent = '状态连接中断，当前授权情况无法确认';
    $('observation').textContent = '状态连接中断，当前监控结果无法确认';
    $('ledger-http-authorization').textContent = '账本连接：状态连接中断，当前授权无法确认';
    $('ledger-mcp-authorization').textContent = '历史查询连接：状态连接中断，当前授权无法确认';
    $('weixin-authorization').textContent = '状态连接中断，当前微信接收配置无法确认';
  }
  finally { polling = false; }
}
setInterval(() => { $('clock').textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false }); }, 1000);
poll(); setInterval(poll, 5000);
