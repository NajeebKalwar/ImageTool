import type { ToolDefinition } from './schema';
import {
  BACKGROUND_REMOVAL_BENCHMARKS,
  COMPRESSION_BENCHMARKS,
  CONVERSION_BENCHMARKS,
  UPSCALING_BENCHMARKS,
} from './benchmarks';

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
    benchmarks: COMPRESSION_BENCHMARKS,
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
  {
    id: 'background-remover',
    slug: '/background-remover',
    title: 'Free Online Background Remover',
    description: 'Remove image backgrounds automatically in your browser using local AI segmentation. 100% private, free, and runs on your device.',
    headline: 'Free Online Background Remover',
    tagline: 'Isolate subjects and cut out photo backgrounds in seconds with client-side AI. Your photos never leave your device.',
    category: 'ai',
    applicationCategory: 'MultimediaApplication',
    operatingSystem: 'Any (Web Browser with WebGPU or WebAssembly)',
    howItWorks: {
      summary: 'ImageTool runs advanced machine learning segmentation models (BiRefNet-lite and MODNet) directly inside your web browser using WebGPU hardware acceleration with WebAssembly fallback.',
      technicalDetails: 'When you select an image, the model weights are loaded from your browser cache into an isolated Web Worker. Neural network inference computes a precise alpha matte matrix that separates foreground subjects from the background in real time.',
      privacyGuarantee: '100% On-Device Inference (P-01 to P-04). Model weights may be fetched once and cached in IndexedDB, but your image bytes are NEVER sent over the network.',
    },
    stepsHeading: 'Step-by-Step: How to Remove an Image Background',
    steps: [
      {
        title: 'Choose an image',
        description: 'Upload any portrait, product photo, or graphic up to 50 MB.',
      },
      {
        title: 'Select an AI model',
        description: 'Choose BiRefNet-lite for maximum hair and edge quality, or MODNet for ultra-fast processing.',
      },
      {
        title: 'Click Remove Background',
        description: 'The neural network runs in a background Web Worker without freezing your interface.',
      },
      {
        title: 'Preview and inspect',
        description: 'Test your cutout against transparent, white, black, or custom color backdrops.',
      },
      {
        title: 'Download transparent PNG',
        description: 'Save the full-resolution cut-out with clean transparency directly to your device.',
      },
    ],
    featuresHeading: 'On-Device AI Advantages',
    features: [
      {
        title: 'Complete Data Privacy',
        description: 'Personal photos and proprietary product imagery never touch cloud servers or third-party APIs.',
      },
      {
        title: 'Hardware Accelerated',
        description: 'Leverages your device GPU via modern WebGPU standards for near-native neural inference speeds.',
      },
      {
        title: 'IndexedDB Model Caching',
        description: 'Model weights are saved locally after first run, enabling instantaneous offline reloads.',
      },
    ],
    benchmarks: BACKGROUND_REMOVAL_BENCHMARKS,
    faqHeading: 'Frequently Asked Questions',
    faqs: [
      {
        question: 'Do my pictures get uploaded to an AI cloud API?',
        answer: 'No. Unlike Remove.bg or Canva, all neural network weights run locally inside your web browser. Zero image pixels are sent across the network.',
      },
      {
        question: 'Which model should I choose?',
        answer: 'BiRefNet-lite is recommended for complex portraits with fine hair or furry pets. MODNet is recommended for faster performance on laptops and mobile devices.',
      },
      {
        question: 'Does this work without an internet connection?',
        answer: 'Yes! Once model weights are downloaded to your browser IndexedDB cache, background removal works completely offline.',
      },
      {
        question: 'What are the commercial use rights of these AI models?',
        answer: 'ImageTool exclusively deploys models with permissive commercial licenses (BiRefNet-lite is MIT, MODNet is Apache-2.0). All output images belong 100% to you.',
      },
    ],
  },
  {
    id: 'image-upscaler',
    slug: '/image-upscaler',
    title: 'Free Online AI Image Upscaler & Enhancer',
    description: 'Enlarge and upscale images up to 4x using browser-native AI super-resolution with zero-seam tiled processing. 100% private, free, and runs on your device.',
    headline: 'Free Online AI Image Upscaler & Enhancer',
    tagline: 'Increase image resolution 2x or 4x without losing sharpness. On-device neural super-resolution that never uploads your photos.',
    category: 'ai',
    applicationCategory: 'MultimediaApplication',
    operatingSystem: 'Any (Web Browser with WebGPU or WebAssembly)',
    howItWorks: {
      summary: 'ImageTool uses state-of-the-art vision models (Swin2SR Real-World and Real-ESRGAN Compact) to intelligently reconstruct missing pixels and photographic textures directly in your browser.',
      technicalDetails: 'High-resolution images are partitioned into overlapping tiles processed with WebGPU acceleration. A 2D cosine-window seam blending algorithm recombines tiles into a single seamless output, avoiding GPU out-of-memory errors and visible grid lines.',
      privacyGuarantee: '100% On-Device Inference (P-01 to P-04). Image pixels and intermediate neural tensors remain strictly inside your browser memory. No data is ever transmitted to cloud servers.',
    },
    stepsHeading: 'Step-by-Step: How to Upscale an Image with AI',
    steps: [
      {
        title: 'Upload your image',
        description: 'Drag and drop any PNG, JPEG, or WebP photo up to 50 MB.',
      },
      {
        title: 'Choose scale factor',
        description: 'Select 2x (200%) or 4x (400%) magnification depending on your output target.',
      },
      {
        title: 'Select an AI model',
        description: 'Choose Swin2SR for photo restoration or Real-ESRGAN Compact for graphics and high-speed scaling.',
      },
      {
        title: 'Click Upscale Image',
        description: 'The Web Worker executes tiled neural processing with live tile progress.',
      },
      {
        title: 'Compare & Download',
        description: 'Use the interactive split slider to inspect restored fine details before downloading your high-res image.',
      },
    ],
    featuresHeading: 'Super-Resolution Features & Reliability',
    features: [
      {
        title: 'Tiled Processing Engine',
        description: 'Prevents browser GPU crashes on large inputs by processing tiles and feathering overlap seams.',
      },
      {
        title: 'Instant Job Cancellation',
        description: 'Cancel in-flight upscaling immediately without freezing the browser tab.',
      },
      {
        title: 'Zero Seam Artifacts',
        description: 'Cosine bell curve weight normalization eliminates visible tile boundaries and grid artifacts.',
      },
      {
        title: 'Permissive Open-Source AI',
        description: 'Powered by Apache-2.0 and BSD licensed architectures suitable for personal and commercial use.',
      },
    ],
    benchmarks: UPSCALING_BENCHMARKS,
    faqHeading: 'Frequently Asked Questions',
    faqs: [
      {
        question: 'How does browser-based AI upscaling work without cloud servers?',
        answer: 'We execute quantized ONNX neural networks directly inside your browser using WebGPU for graphics compute or WASM. Your device handles all the computing.',
      },
      {
        question: 'Why does the upscaler use tiled processing?',
        answer: 'Upscaling a 2000×2000 photo to 8000×8000 requires processing hundreds of millions of neural activations. Tiled processing processes 256×256 chunks with overlap, allowing smooth rendering even on consumer laptops.',
      },
      {
        question: 'Can I cancel an upscale if it takes too long?',
        answer: 'Yes! You can click Cancel at any point. ImageTool aborts the Web Worker task cleanly and frees all allocated memory.',
      },
      {
        question: 'Are there image size limits for upscaling?',
        answer: 'To protect your device memory, recommended input is up to 6–12 Megapixels for 4x scaling (output up to 64 Megapixels). The tool will warn you if an image is exceptionally large.',
      },
    ],
  },
  {
    id: 'image-compressor',
    slug: '/image-compressor',
    title: 'Free Online Image Compressor',
    description: 'Compress and shrink JPEG, PNG, and WebP images up to 85% directly in your browser. 100% private, fast, and completely free.',
    headline: 'Free Online Image Compressor',
    tagline: 'Reduce photo file size with visually lossless quality. On-device compression that never uploads your images.',
    category: 'compress',
    applicationCategory: 'MultimediaApplication',
    operatingSystem: 'Any (Web Browser)',
    howItWorks: {
      summary: 'ImageTool compresses images directly on your computer using native Web Worker threads and modern image compression encoders.',
      technicalDetails: 'Your image is decoded into raw pixel data and re-compressed using configurable quality quantization and entropy coding (WebP lossy/lossless or JPEG). All processing occurs in local RAM with zero data leaving your device.',
      privacyGuarantee: '100% Local Processing (P-01 to P-04). Your sensitive photos, documents, and screenshots are never sent over the internet.',
    },
    stepsHeading: 'Step-by-Step: How to Compress an Image',
    steps: [
      {
        title: 'Upload your image',
        description: 'Drag and drop any JPEG, PNG, WebP, or AVIF image up to 50 MB.',
      },
      {
        title: 'Choose compression level',
        description: 'Select Balanced (80%), High Quality (90%), or Maximum Savings (55%), or adjust the custom quality slider.',
      },
      {
        title: 'Choose format & optional downscaling',
        description: 'Convert to WebP for maximum compression, or preserve JPEG/PNG. Optionally constrain maximum width.',
      },
      {
        title: 'Click Compress Image Now',
        description: 'The background Web Worker encodes your image in milliseconds.',
      },
      {
        title: 'Download compressed image',
        description: 'Save the optimized image directly to your downloads folder.',
      },
    ],
    featuresHeading: 'Why Choose Local ImageTool Compression?',
    features: [
      {
        title: 'Up to 85% File Size Reduction',
        description: 'WebP compression produces files drastically smaller than JPEG with indistinguishable visual fidelity.',
      },
      {
        title: 'Zero Cloud Upload Latency',
        description: 'Compress instantly on your local CPU without waiting for multi-megabyte uploads over slow internet.',
      },
      {
        title: 'Confidentiality Guaranteed',
        description: 'Personal documents, confidential receipts, and family photos remain completely secure and private.',
      },
    ],
    benchmarks: COMPRESSION_BENCHMARKS,
    faqHeading: 'Frequently Asked Questions',
    faqs: [
      {
        question: 'How much can I reduce my image size?',
        answer: 'Typically, converting high-resolution JPEGs or PNGs to optimized WebP reduces file size by 65% to 85% with no visible loss in image quality.',
      },
      {
        question: 'Are my images stored or analyzed?',
        answer: 'Never. ImageTool runs 100% inside your browser memory. We have no backend image servers, no cloud queues, and zero tracking pixels.',
      },
      {
        question: 'Does this compress animated GIFs?',
        answer: 'ImageTool currently focuses on static photos and graphics (PNG, JPEG, WebP, AVIF) to achieve the highest possible compression ratios.',
      },
    ],
  },
  {
    id: 'webp-converter',
    slug: '/webp-converter',
    title: 'Free Online WebP Converter',
    description: 'Convert PNG and JPEG to WebP, or convert WebP to PNG and JPEG. Fast, local batch format conversion with zero cloud uploads.',
    headline: 'Free Online WebP Converter',
    tagline: 'Batch convert image formats locally in your web browser. Save web bandwidth with zero cloud processing.',
    category: 'convert',
    applicationCategory: 'MultimediaApplication',
    operatingSystem: 'Any (Web Browser)',
    howItWorks: {
      summary: 'WebP is the modern image format of the web, delivering 25–35% smaller file sizes than JPEG while supporting full alpha transparency.',
      technicalDetails: 'ImageTool leverages browser-native Canvas and Web Worker codecs to perform ultra-fast batch format transcoding directly on your CPU without server bottlenecks.',
      privacyGuarantee: '100% Private (P-01 to P-04). Batch convert hundreds of images safely with zero bytes uploaded to third-party servers.',
    },
    stepsHeading: 'Step-by-Step: How to Convert to or from WebP',
    steps: [
      {
        title: 'Choose conversion direction',
        description: 'Select "Convert TO WebP" (from PNG/JPG) or "Convert FROM WebP" (to PNG/JPG).',
      },
      {
        title: 'Select one or more images',
        description: 'Drag and drop multiple files to convert them simultaneously in a batch queue.',
      },
      {
        title: 'Adjust quality settings',
        description: 'Fine-tune lossy WebP/JPEG quality (default 85%) or export lossless PNGs.',
      },
      {
        title: 'Download individual files or all at once',
        description: 'Download converted files with one click directly to your computer.',
      },
    ],
    featuresHeading: 'WebP Converter Advantages',
    features: [
      {
        title: 'Batch Conversion',
        description: 'Convert multiple images simultaneously in background Web Worker threads.',
      },
      {
        title: 'Bidirectional Support',
        description: 'Convert to WebP for modern web performance, or convert legacy WebP images back to PNG and JPEG.',
      },
      {
        title: 'Instant Local Speed',
        description: 'No upload waiting, no file size limitations, and zero subscription paywalls.',
      },
    ],
    benchmarks: CONVERSION_BENCHMARKS,
    faqHeading: 'Frequently Asked Questions',
    faqs: [
      {
        question: 'Why should I convert my images to WebP?',
        answer: 'WebP is supported by all modern browsers (Chrome, Safari, Firefox, Edge). It provides superior compression compared to JPEG and supports transparency like PNG, significantly speeding up website loading times.',
      },
      {
        question: 'Can I convert WebP files back to PNG or JPG?',
        answer: 'Yes! Select "Convert FROM WebP" to convert any WebP image back to PNG (for transparency) or JPEG (for universal legacy compatibility).',
      },
      {
        question: 'Is there a limit on how many files I can convert?',
        answer: 'Because all processing happens on your own computer, there are no artificial limits or daily credits. You can convert as many images as you need.',
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
