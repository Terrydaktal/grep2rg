#!/usr/bin/env node
import { runGrep } from '../src/grep-runtime.mjs';

// This entry point consumes GNU grep argv verbatim, including --help/--version.
process.exitCode = await runGrep(process.argv.slice(2));
