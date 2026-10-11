import {
  createBashToolDefinition,
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { withGrepWrapper } from "../src/grep-wrapper.mjs";

function enabledForProvider(provider: string | undefined): boolean {
  const configured = process.env.GREP2RG_PI_PROVIDERS;
  const providers = configured === undefined
    ? ["qwen-r9700"]
    : configured.split(",").map((value) => value.trim()).filter(Boolean);
  return provider !== undefined && providers.includes(provider);
}

// Only the model's registered bash tool receives this hook. User !/!! commands
// use Pi's independent user_bash execution path.
export default function grep2rg(pi: ExtensionAPI) {
  const native = createBashToolDefinition(process.cwd());
  pi.registerTool({
    ...native,
    execute: (id, params, signal, onUpdate, ctx) => {
      // Read settings and provider on every invocation so /settings and model
      // changes immediately take effect, including project trust decisions.
      const settings = SettingsManager.create(ctx.cwd, process.env.PI_CODING_AGENT_DIR, {
        projectTrusted: ctx.isProjectTrusted(),
      });
      const shellPath = settings.getShellPath();
      const delegate = createBashToolDefinition(ctx.cwd, {
        shellPath,
        commandPrefix: settings.getShellCommandPrefix(),
        spawnHook: enabledForProvider(ctx.model?.provider)
          ? (context) => withGrepWrapper(context, shellPath)
          : undefined,
      });
      return delegate.execute(id, params, signal, onUpdate, ctx);
    },
  });
}
