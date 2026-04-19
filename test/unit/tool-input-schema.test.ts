import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { TOOLS } from '../../src/tools/index.js';
import { buildToolInputSchema } from '../../src/tools/registry.js';

describe('tools/list inputSchema conformance', () => {
  for (const tool of TOOLS) {
    describe(tool.name, () => {
      const inputSchema = buildToolInputSchema(tool);

      it('has "object" at the root (MCP spec requirement)', () => {
        expect(inputSchema.type).toBe('object');
      });

      it('does not wrap the schema in a $ref / definitions envelope', () => {
        expect(inputSchema).not.toHaveProperty('$ref');
        expect(inputSchema).not.toHaveProperty('definitions');
      });

      it('exposes a properties object', () => {
        expect(inputSchema.properties).toBeTypeOf('object');
        expect(inputSchema.properties).not.toBeNull();
      });
    });
  }

  it('produces a tools/list response that passes the SDK validator', () => {
    const payload = {
      tools: TOOLS.map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: buildToolInputSchema(tool),
      })),
    };

    const parsed = ListToolsResultSchema.safeParse(payload);
    if (!parsed.success) {
      // Surface the exact SDK-side rejection so a regression reads clearly in CI.
      throw new Error(
        `ListToolsResultSchema rejected payload: ${JSON.stringify(parsed.error.issues, null, 2)}`,
      );
    }
    expect(parsed.success).toBe(true);
  });
});
