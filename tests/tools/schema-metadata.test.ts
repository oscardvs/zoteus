import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { ZodTypeAny } from 'zod';
import { tools } from '../../src/tools/index.js';

/**
 * Every argument and every mirrored field a tool advertises has to say what it is.
 *
 * Two directory listings score a server on exactly this (Smithery's quality breakdown, and
 * the OpenAI/ChatGPT directory review), and both read the schemas off `tools/list` rather
 * than the prose description: an argument with no `description` is invisible there however
 * well the tool paragraph explains it. It had been 4 of 31 tools for the arguments and 0 of
 * 31 for the output schemas.
 */

/** The object shape `schema` carries once optional/array/preprocess wrappers are peeled. */
function properties(schema: ZodTypeAny, depth = 0): Array<[string, ZodTypeAny]> {
  if (depth > 10) return [];
  if (schema instanceof z.ZodObject) return Object.entries(schema.shape as Record<string, ZodTypeAny>);
  const def = schema._def as { innerType?: ZodTypeAny; schema?: ZodTypeAny; type?: ZodTypeAny; options?: ZodTypeAny[] };
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable || schema instanceof z.ZodDefault) {
    return def.innerType ? properties(def.innerType, depth + 1) : [];
  }
  if (schema instanceof z.ZodEffects) return def.schema ? properties(def.schema, depth + 1) : [];
  if (schema instanceof z.ZodArray) return def.type ? properties(def.type, depth + 1) : [];
  if (schema instanceof z.ZodUnion) return (def.options ?? []).flatMap((o) => properties(o, depth + 1));
  return [];
}

/** Every property path under `schema` whose own schema carries no description. */
function undescribed(schema: ZodTypeAny, path = '', depth = 0): string[] {
  if (depth > 10) return [];
  const out: string[] = [];
  for (const [key, value] of properties(schema, depth)) {
    const here = path ? `${path}.${key}` : key;
    if (!value.description?.trim()) out.push(here);
    out.push(...undescribed(value, here, depth + 1));
  }
  return out;
}

describe('every tool advertises complete schemas', () => {
  it.each(tools.map((t) => [t.name, t] as const))('%s describes every input property', (_name, def) => {
    const missing = undescribed(z.object(def.inputSchema));
    expect(missing).toEqual([]);
  });

  it.each(tools.map((t) => [t.name, t] as const))('%s declares an output schema', (_name, def) => {
    expect(def.outputSchema).toBeDefined();
    // An object schema, because `structuredContent` is a JSON object and the SDK validates
    // it against this one.
    expect(properties(def.outputSchema!).length).toBeGreaterThan(0);
  });

  it.each(tools.map((t) => [t.name, t] as const))('%s describes every output property', (_name, def) => {
    expect(undescribed(def.outputSchema!)).toEqual([]);
  });

  it('covers every registered tool', () => {
    expect(tools.length).toBe(31);
  });
});
