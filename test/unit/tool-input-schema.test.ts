import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { TOOLS } from '../../src/tools/index.js';
import { buildToolInputSchema } from '../../src/tools/registry.js';

describe('tools/list inputSchema conformance', () => {
  for (const tool of TOOLS) {
    describe(tool.name, () => {
      it('has "object" at the root (MCP spec requirement)', () => {
        const inputSchema = buildToolInputSchema(tool);
        expect(inputSchema.type).toBe('object');
      });

      it('does not wrap the schema in a $ref / definitions envelope', () => {
        const inputSchema = buildToolInputSchema(tool);
        expect(inputSchema).not.toHaveProperty('$ref');
        expect(inputSchema).not.toHaveProperty('definitions');
      });

      it('emits a well-formed `properties` (object or undefined per MCP spec)', () => {
        // MCP's `ToolSchema.inputSchema.properties` is optional (valid `type:
        // "object"` schemas can rely solely on `additionalProperties`, e.g.
        // a `z.record(...)` root). We accept undefined OR a plain object;
        // arrays and null are rejected.
        const inputSchema = buildToolInputSchema(tool);
        const props = inputSchema.properties;
        const ok =
          props === undefined ||
          (typeof props === 'object' && props !== null && !Array.isArray(props));
        expect(ok).toBe(true);
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
  });
});
