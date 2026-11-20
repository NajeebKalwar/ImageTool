import type { ToolDefinition } from '../content/schema';
import { siteConfig } from '../site.config';

/**
 * Builds Schema.org WebApplication structured data for a tool.
 */
export function buildWebApplicationSchema(
  tool: ToolDefinition,
  siteUrl: URL | string,
): Record<string, unknown> {
  const canonicalUrl = new URL(tool.slug, siteUrl).href;

  return {
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: `${tool.title} | ${siteConfig.name}`,
    description: tool.description,
    url: canonicalUrl,
    applicationCategory: tool.applicationCategory,
    operatingSystem: tool.operatingSystem,
    browserRequirements: 'Requires JavaScript. Requires HTML5 Canvas.',
    offers: {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'USD',
    },
  };
}

/**
 * Builds Schema.org HowTo structured data derived directly from the tool's visible steps.
 * Guarantees zero drift between visible DOM text and search crawler metadata.
 */
export function buildHowToSchema(
  tool: ToolDefinition,
  siteUrl: URL | string,
): Record<string, unknown> {
  const canonicalUrl = new URL(tool.slug, siteUrl).href;

  return {
    '@context': 'https://schema.org',
    '@type': 'HowTo',
    name: tool.stepsHeading || `How to use ${tool.headline}`,
    description: tool.tagline,
    url: canonicalUrl,
    step: tool.steps.map((step, index) => ({
      '@type': 'HowToStep',
      position: index + 1,
      name: step.title,
      text: step.description,
    })),
  };
}

/**
 * Builds Schema.org FAQPage structured data derived directly from the tool's visible FAQs.
 * Guarantees zero drift between visible DOM text and search crawler metadata.
 */
export function buildFaqSchema(tool: ToolDefinition): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: tool.faqs.map((faq) => ({
      '@type': 'Question',
      name: faq.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: faq.answer,
      },
    })),
  };
}

/**
 * Generates the full array of JSON-LD schemas for a tool page.
 */
export function generateToolJsonLd(
  tool: ToolDefinition,
  siteUrl: URL | string,
): Array<Record<string, unknown>> {
  const schemas: Array<Record<string, unknown>> = [
    buildWebApplicationSchema(tool, siteUrl),
  ];

  if (tool.steps.length > 0) {
    schemas.push(buildHowToSchema(tool, siteUrl));
  }

  if (tool.faqs.length > 0) {
    schemas.push(buildFaqSchema(tool));
  }

  return schemas;
}
