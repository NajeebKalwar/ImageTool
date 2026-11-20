import type { ToolDefinition } from './schema';

export const TOOLS: readonly ToolDefinition[] = [
  {
    id: 'image-resizer',
    slug: '/image-resizer',
    title: 'Free Online Image Resizer & Converter',
    description: 'Resize, convert, and optimize images directly in your browser. Fast, free, and completely private with zero server uploads.',
    headline: 'Free Online Image Resizer & Converter',
    tagline: 'Change dimensions, adjust quality, and convert image formats locally on your computer. Your photos never leave your device.',
    category: 'resize',
    applicationCategory: 'MultimediaApplication',
    operatingSystem: 'Any (Web Browser)',
    howItWorks: {
      summary: 'Unlike traditional online image utilities that upload your sensitive images to a cloud server, ImageTool utilizes high-performance browser APIs—including Web Workers and OffscreenCanvas.',
      technicalDetails: 'When you select an image, its raw bytes are transferred to a background thread. The image is decoded, scaled using high-quality bicubic resampling, and re-encoded into your chosen format (WebP, JPEG, or PNG) without ever touching an external network endpoint.',
      privacyGuarantee: 'All image data stays strictly on your local device. No pixels, buffers, or metadata are ever transmitted to any third party or remote server.',
    },
    stepsHeading: 'Step-by-Step: How to Resize and Convert an Image',
    steps: [
      {
        title: 'Upload your image',
        description: 'Drag and drop your file or click the box to browse. Files up to 50 MB are supported.',
      },
      {
        title: 'Set your dimensions',
        description: 'Enter custom pixel dimensions or click one of the quick scale presets (25%, 50%, 75%, 200%). Keep aspect ratio locked to avoid distortion.',
      },
      {
        title: 'Select output format',
        description: 'Choose WebP for modern web performance, JPEG for photographs, or PNG for lossless transparency.',
      },
      {
        title: 'Click Resize & Convert',
        description: 'The Web Worker processes your image in milliseconds on a separate thread.',
      },
      {
        title: 'Download',
        description: 'Click download to save your optimized file directly to your downloads folder.',
      },
    ],
    featuresHeading: 'Supported Output Formats',
    features: [
      {
        title: 'WebP (Recommended)',
        description: 'Provides superior lossless and lossy compression. Produces files 25–35% smaller than comparable JPEGs at equivalent visual quality.',
      },
      {
        title: 'JPEG',
        description: 'Universally compatible standard for complex photographs. Best suited for high-color images where transparency is not required.',
      },
      {
        title: 'PNG',
        description: 'Lossless format with full alpha transparency support. Ideal for logos, icons, screenshots, and graphics with sharp text.',
      },
    ],
    faqHeading: 'Frequently Asked Questions',
    faqs: [
      {
        question: 'Are my photos uploaded to any server?',
        answer: 'No. ImageTool adheres to a strict privacy-first architecture (P-01 to P-04). All pixel manipulation and file encoding happen directly inside your web browser. No image data is sent across the internet.',
      },
      {
        question: 'What is the maximum image resolution supported?',
        answer: 'You can process images up to 25 million pixels (for example, 5000 × 5000 pixels) and up to 50 MB in file size.',
      },
      {
        question: 'What image formats can I upload?',
        answer: 'You can upload PNG, JPEG, WebP, AVIF, GIF, and SVG files supported by your browser.',
      },
      {
        question: 'Is ImageTool free to use?',
        answer: 'Yes, 100% free with no account creation, subscriptions, or watermarks required.',
      },
    ],
  },
] as const;

export function getAllTools(): readonly ToolDefinition[] {
  return TOOLS;
}

export function getToolBySlug(slug: string): ToolDefinition | undefined {
  return TOOLS.find((tool) => tool.slug === slug);
}

export function getToolById(id: string): ToolDefinition | undefined {
  return TOOLS.find((tool) => tool.id === id);
}
