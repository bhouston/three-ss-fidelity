#!/usr/bin/env node
import { handleOpenCliRequest } from '@clidoc/core';
import { hideBin } from 'yargs/helpers';
import { cliDocument, runCli } from './index.js';

const argv = hideBin(process.argv);
const document = await cliDocument();
if (!(await handleOpenCliRequest(argv, () => document))) await runCli(argv);
