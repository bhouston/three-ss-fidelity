import { fileURLToPath } from 'node:url';
import { fromYargs } from '@clidoc/yargs';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { fileCommands } from 'yargs-file-commands';

// Commands are the files in ./commands (list, render, compare, ...).
async function loadCommands() {
  const commandsDir = fileURLToPath(new URL('./commands', import.meta.url));
  return fileCommands({ commandDirs: [commandsDir], validation: true });
}

/** OpenCLI document of this CLI (clidoc), served by `cli __opencli`. */
export async function cliDocument() {
  return fromYargs(await loadCommands(), { title: 'ss-fidelity', binary: 'cli', version: '0.1.0' });
}

export async function runCli(argv = hideBin(process.argv)): Promise<void> {
  await yargs(argv)
    .scriptName('cli')
    .usage('$0 <command>')
    .command(await loadCommands())
    .strictCommands()
    .demandCommand(1)
    .help()
    .parseAsync();
}
