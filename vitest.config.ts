import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.ts'],
    globalSetup: ['./tests/global-setup.ts'],
    // Checks every successful tool result against the tool's own outputSchema, the way the
    // MCP SDK checks it on the wire. See tests/validate-tool-output.ts.
    setupFiles: ['./tests/validate-tool-output.ts'],
  },
});
