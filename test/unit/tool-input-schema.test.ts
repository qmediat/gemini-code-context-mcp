import { readFileSync } from 'node:fs';
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
        expect(inputSchema).not.toHaveProperty('$defs');
        expect(JSON.stringify(inputSchema)).not.toContain('"$ref"');
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

  it('keeps the published contract: an object takes no unnamed key, an integer no safe-integer ceiling', () => {
    const visit = (node: unknown, seen: Record<string, unknown>[]): Record<string, unknown>[] => {
      if (Array.isArray(node)) for (const item of node) visit(item, seen);
      else if (node && typeof node === 'object') {
        seen.push(node as Record<string, unknown>);
        for (const value of Object.values(node)) visit(value, seen);
      }
      return seen;
    };
    const nodes = TOOLS.flatMap((tool) => visit(buildToolInputSchema(tool), []));
    const objects = nodes.filter((node) => node.type === 'object');
    expect(objects.length).toBeGreaterThanOrEqual(TOOLS.length);
    expect(objects.every((node) => node.additionalProperties === false)).toBe(true);
    expect(nodes.some((node) => node.maximum === Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(nodes.some((node) => 'maximum' in node && node.maximum === undefined)).toBe(false);
    expect(nodes.some((node) => node.type === 'integer')).toBe(true);
  });

  it('publishes the inputSchema of 1.22.1 for every tool, key for key', () => {
    // The fixture is the zod-3 build's output: a Zod release that writes a schema differently turns this red.
    const published = JSON.parse(
      readFileSync(new URL('../fixtures/tools-input-schema-1.22.1.json', import.meta.url), 'utf8'),
    ) as Record<string, unknown>;
    expect(TOOLS.map((tool) => tool.name).sort()).toEqual(Object.keys(published).sort());
    for (const tool of TOOLS) {
      expect(JSON.parse(JSON.stringify(buildToolInputSchema(tool))), tool.name).toEqual(
        published[tool.name],
      );
    }
  });

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
