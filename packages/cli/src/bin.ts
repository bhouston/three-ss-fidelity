#!/usr/bin/env node
import { constants, getPriority, setPriority } from 'node:os';
import { handleOpenCliRequest } from '@clidoc/core';
import { hideBin } from 'yargs/helpers';
import { cliDocument, runCli } from './index.js';

// Yield to normal-priority work without raising an already lower inherited priority.
try {
  const priority = process.platform === 'win32' ? constants.priority.PRIORITY_BELOW_NORMAL : 1;
  if (getPriority() < priority) setPriority(priority);
} catch (error) {
  console.warn('Unable to lower CLI CPU priority:', error);
}

const argv = hideBin(process.argv);
if (argv[0] === '__opencli') {
  const document = await cliDocument();
  await handleOpenCliRequest(argv, () => document);
} else {
  await runCli(argv);
}
