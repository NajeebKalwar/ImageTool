/**
 * Pre-configured Compound Workflow Recipes for ImageTool.
 *
 * Each recipe orchestrates multiple discrete image processing tools
 * into a turnkey, 100% on-device pipeline.
 */

import type { WorkflowRecipe } from './types';

export const WORKFLOW_RECIPES: readonly WorkflowRecipe[] = [
  {
    id: 'ecommerce-studio',
    title: 'E-Commerce Product Studio',
    badge: 'Turnkey Studio',
    description:
      'Isolates product with BiRefNet-lite, centers on square 1200×1200 canvas with solid white padding, and encodes to fast WebP.',
    icon: '🛍️',
    steps: [
      {
        id: 'bg-1',
        tool: 'remove_background',
        name: 'AI Background Cutout',
        description: 'Isolate product using BiRefNet-lite high-precision model',
        params: { modelId: 'birefnet-lite' },
      },
      {
        id: 'resize-2',
        tool: 'resize_image',
        name: 'Studio Square Canvas',
        description: 'Pad to 1200×1200 px with clean #FFFFFF background',
        params: { width: 1200, height: 1200, fit: 'contain', backgroundColor: '#ffffff' },
      },
      {
        id: 'compress-3',
        tool: 'compress_image',
        name: 'WebP Optimization',
        description: 'Encode to lightweight 85% WebP for fast page loading',
        params: { format: 'webp', quality: 85 },
      },
    ],
  },
  {
    id: 'social-avatar',
    title: 'Social Avatar & Profile Pic',
    badge: 'Portrait Pack',
    description:
      'Cuts out portrait with MODNet, softens hair edges, centers on 600×600 canvas, and exports transparent PNG.',
    icon: '👤',
    steps: [
      {
        id: 'bg-1',
        tool: 'remove_background',
        name: 'Portrait Segmentation',
        description: 'Segment person using MODNet portrait matting',
        params: { modelId: 'modnet' },
      },
      {
        id: 'refine-2',
        tool: 'refine_mask',
        name: 'Edge Feathering',
        description: 'Apply 2px softness and 5% threshold to smooth hair borders',
        params: { threshold: 5, edgeSoftness: 2 },
      },
      {
        id: 'resize-3',
        tool: 'resize_image',
        name: 'Square Crop',
        description: 'Center-crop to 600×600 px avatar dimensions',
        params: { width: 600, height: 600, fit: 'cover' },
      },
      {
        id: 'compress-4',
        tool: 'compress_image',
        name: 'PNG Export',
        description: 'Save as crisp lossless PNG',
        params: { format: 'png', quality: 100 },
      },
    ],
  },
  {
    id: 'print-restorer',
    title: 'High-Res Print & Upscale',
    badge: 'Super-Resolution',
    description:
      'Removes background with BiRefNet-lite, applies 2x Swin2SR super-resolution, and prepares for high-DPI print.',
    icon: '🖼️',
    steps: [
      {
        id: 'bg-1',
        tool: 'remove_background',
        name: 'AI Background Cutout',
        description: 'Isolate intricate details using BiRefNet-lite',
        params: { modelId: 'birefnet-lite' },
      },
      {
        id: 'upscale-2',
        tool: 'upscale_image',
        name: '2x Super-Resolution',
        description: 'Restore details and double resolution with Swin2SR',
        params: { scale: '2' },
      },
      {
        id: 'compress-3',
        tool: 'compress_image',
        name: 'Lossless Print Export',
        description: 'Export as full-resolution transparent PNG',
        params: { format: 'png', quality: 100 },
      },
    ],
  },
  {
    id: 'sticker-maker',
    title: 'Crisp Graphic & Sticker',
    badge: 'Vector-like Cutout',
    description:
      'Cuts out badges, stickers, and illustrations with razor-sharp 30% threshold cutoff to prevent blurry fringes.',
    icon: '🎨',
    steps: [
      {
        id: 'bg-1',
        tool: 'remove_background',
        name: 'Artwork Matting',
        description: 'Extract graphic shapes with MODNet',
        params: { modelId: 'modnet' },
      },
      {
        id: 'refine-2',
        tool: 'refine_mask',
        name: 'Crisp Threshold Cutoff',
        description: 'Eliminate soft fringe blending with 30% threshold',
        params: { threshold: 30, edgeSoftness: 0 },
      },
      {
        id: 'compress-3',
        tool: 'compress_image',
        name: 'High-Quality WebP',
        description: 'Export at 95% quality WebP with transparent alpha',
        params: { format: 'webp', quality: 95 },
      },
    ],
  },
] as const;

export function getRecipeById(id: string): WorkflowRecipe | undefined {
  return WORKFLOW_RECIPES.find((r) => r.id === id);
}
