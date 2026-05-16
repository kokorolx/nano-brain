import type { GlobalOptions } from '../types.js';
import { runSetupWizard } from '../wizard.js';

export async function handleSetup(globalOpts: GlobalOptions, _args: string[]): Promise<void> {
  await runSetupWizard(globalOpts.configPath, process.cwd());
}
