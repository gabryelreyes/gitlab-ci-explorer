#!/usr/bin/env node
import { runCli } from './cli-lib.js';

const { code, out } = runCli(process.argv.slice(2));
(code === 0 ? process.stdout : process.stderr).write(`${out}\n`);
process.exitCode = code;
