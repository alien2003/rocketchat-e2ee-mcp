/**
 * Waits for the compose stack and provisions throwaway test users + PATs into .local/stack.json.
 * Usage: node scripts/rc-bootstrap.ts
 */
import { bootstrapStack } from '../test/support/bootstrap.ts';

bootstrapStack().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
