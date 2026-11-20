import { describe, expect, it } from 'vitest';
import { getToolBySlug } from '../content/tools';
import {
  buildFaqSchema,
  buildHowToSchema,
  buildWebApplicationSchema,
  generateToolJsonLd,
} from './json-ld';

describe('JSON-LD schema generation', () => {
  const siteUrl = 'https://imagetool.example';
  const tool = getToolBySlug('/image-resizer');

  it('retrieves the tool definition', () => {
    expect(tool).toBeDefined();
    expect(tool?.id).toBe('image-resizer');
  });

  if (!tool) return;

  it('generates valid WebApplication schema', () => {
    const schema = buildWebApplicationSchema(tool, siteUrl);

    expect(schema['@context']).toBe('https://schema.org');
    expect(schema['@type']).toBe('WebApplication');
    expect(schema.name).toBe('Free Online Image Resizer & Converter | ImageTool');
    expect(schema.url).toBe('https://imagetool.example/image-resizer');
    expect(schema.offers).toEqual({
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'USD',
    });
  });

  it('generates HowTo schema that strictly mirrors tool.steps', () => {
    const schema = buildHowToSchema(tool, siteUrl);

    expect(schema['@type']).toBe('HowTo');
    const steps = schema.step as Array<{ position: number; name: string; text: string }>;
    expect(steps).toHaveLength(tool.steps.length);

    tool.steps.forEach((s, idx) => {
      expect(steps[idx].position).toBe(idx + 1);
      expect(steps[idx].name).toBe(s.title);
      expect(steps[idx].text).toBe(s.description);
    });
  });

  it('generates FAQPage schema that strictly mirrors tool.faqs', () => {
    const schema = buildFaqSchema(tool);

    expect(schema['@type']).toBe('FAQPage');
    const entities = schema.mainEntity as Array<{
      name: string;
      acceptedAnswer: { text: string };
    }>;
    expect(entities).toHaveLength(tool.faqs.length);

    tool.faqs.forEach((f, idx) => {
      expect(entities[idx].name).toBe(f.question);
      expect(entities[idx].acceptedAnswer.text).toBe(f.answer);
    });
  });

  it('generates all three schemas without duplication', () => {
    const schemas = generateToolJsonLd(tool, siteUrl);

    expect(schemas).toHaveLength(3);
    const types = schemas.map((s) => s['@type']);
    expect(types).toEqual(['WebApplication', 'HowTo', 'FAQPage']);
  });
});
