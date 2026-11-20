/**
 * Tool Content Schema
 *
 * Single source of truth for tool metadata, SEO/AEO copy, step-by-step
 * instructions, feature highlights, FAQs, and Schema.org structured data.
 */

export interface ToolStep {
  title: string;
  description: string;
}

export interface ToolFaq {
  question: string;
  answer: string;
}

export interface ToolFeature {
  title: string;
  description: string;
}

export interface HowItWorksSection {
  summary: string;
  technicalDetails: string;
  privacyGuarantee: string;
}

export type ToolCategory = 'resize' | 'convert' | 'compress' | 'ai';

export interface ToolDefinition {
  id: string;
  slug: string; // root-relative pathname, e.g. '/image-resizer'
  title: string; // page title without brand suffix (e.g. 'Free Online Image Resizer & Converter')
  description: string; // unique search snippet
  headline: string; // H1 headline
  tagline: string; // Direct answer-first summary
  category: ToolCategory;
  applicationCategory: string; // Schema.org applicationCategory (e.g. 'MultimediaApplication')
  operatingSystem: string; // Schema.org operatingSystem
  howItWorks: HowItWorksSection;
  stepsHeading?: string;
  steps: ToolStep[];
  featuresHeading?: string;
  features: ToolFeature[];
  faqHeading?: string;
  faqs: ToolFaq[];
}
