// Keep test output readable: the code under test logs to stderr; tests that check logging install their own sink.
import { setLogLevel } from '../../src/logger.ts';

setLogLevel(process.env.RC_MCP_LOG_LEVEL === 'debug' ? 'debug' : 'silent');
