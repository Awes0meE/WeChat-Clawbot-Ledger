import core from './index-core.ts';
import { createRestrictedHistoryTool } from './restricted-history.mjs';
import { resolveDeploymentProfile } from './deployment-profile.mjs';
import { HISTORY_TOOL_NAME } from './expense-history.mjs';

export default {
  ...core,
  register(api) {
    if (process.platform !== 'linux') throw new Error('This adapter requires the pinned Linux image');
    const deployment = resolveDeploymentProfile(api.pluginConfig, api.config);
    // This image uses the restricted dynamic tool; it declares no native MCP
    // server and must not register a native harness connection resolver.
    core.register({ ...api, registerMcpServerConnectionResolver() {} });
    api.registerTool((context) => createRestrictedHistoryTool({ config: api.config,
      pluginConfig: api.pluginConfig, context, deployment }), { name: HISTORY_TOOL_NAME });
  },
};
