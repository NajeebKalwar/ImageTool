/**
 * On-Device LangChain System & User Prompt Planner for Background Removal.
 *
 * Uses @langchain/core/prompts (ChatPromptTemplate) to structure a system prompt
 * and user instruction into LangChain SystemMessage + HumanMessage objects,
 * then deterministically routes model selection (MODNet vs BiRefNet-lite) and
 * mask refinement parameters completely on-device with zero network egress.
 */

import {
  ChatPromptTemplate,
  HumanMessagePromptTemplate,
  SystemMessagePromptTemplate,
} from '@langchain/core/prompts';
import type { BaseMessage } from '@langchain/core/messages';
import type { SubjectCategory } from '../stores/bgremover.store';

export const DEFAULT_BG_REMOVER_SYSTEM_PROMPT = `You are the ImageTool On-Device Background Removal Director.
Your role is to translate the user's subject description and cutout goal into optimal local segmentation & mask refinement settings:
1. Model Routing:
   - Select 'birefnet-lite' for architecture, stone arches, pillars, buildings, monuments, vehicles, products, objects, fine hair, fur, or cluttered scenes.
   - Select 'modnet' for human portraits, selfies, headshots, or flat stickers/logos.
2. Mask Refinement:
   - Crisp edges (logos, stickers, architecture, products): threshold 10-30%, edgeSoftness 0-1px.
   - Soft edges (hair, fur, natural portraits): threshold 0-5%, edgeSoftness 1-3px.
Privacy Constraint: Execute routing 100% locally in-browser; zero image pixels or prompts leave the device.`;

export interface BackgroundPromptPlanInput {
  systemPrompt: string;
  userPrompt: string;
  fallbackModelId?: 'modnet' | 'birefnet-lite';
  fallbackSubjectCategory?: SubjectCategory;
}

export interface BackgroundPromptPlanResult {
  messages: BaseMessage[];
  modelId: 'modnet' | 'birefnet-lite';
  subjectCategory: SubjectCategory;
  threshold: number;
  edgeSoftness: number;
  reasoning: string;
}

/**
 * Compiles the system prompt and user instruction via LangChain ChatPromptTemplate.
 */
export async function formatBackgroundRemoverMessages(
  systemPrompt: string,
  userPrompt: string,
): Promise<BaseMessage[]> {
  const prompt = ChatPromptTemplate.fromMessages([
    SystemMessagePromptTemplate.fromTemplate('{systemPrompt}'),
    HumanMessagePromptTemplate.fromTemplate('{userPrompt}'),
  ]);

  const effectiveSystem = systemPrompt.trim() || DEFAULT_BG_REMOVER_SYSTEM_PROMPT;
  const effectiveUser = userPrompt.trim() || 'Automatically segment the main foreground subject.';

  return prompt.formatMessages({
    systemPrompt: effectiveSystem,
    userPrompt: effectiveUser,
  });
}

const ARCHITECTURE_OBJECT_PATTERN =
  /\b(arch|arches|pillar|pillars|column|columns|building|buildings|monument|statue|temple|stone|sky|product|products|bottle|shoe|shoes|car|vehicle|furniture|chair|table|architecture|object|objects|landmark|bridge)\b/i;

const FINE_EDGE_PATTERN =
  /\b(hair|fur|pet|pets|cat|dog|animal|lace|feather|feathers|tree|trees|leaves|flower|flowers|intricate|whiskers|fluffy)\b/i;

const PORTRAIT_PATTERN =
  /\b(portrait|portraits|person|people|selfie|selfies|face|faces|human|man|woman|boy|girl|headshot|avatar|model)\b/i;

const GRAPHIC_PATTERN =
  /\b(logo|logos|sticker|stickers|icon|icons|graphic|graphics|badge|vector|illustration|drawing|sketch|text|cartoon)\b/i;

/**
 * Evaluates LangChain System + User prompt directives locally to configure
 * model selection and post-processing refinement settings.
 */
export async function planBackgroundRemovalFromPrompt({
  systemPrompt,
  userPrompt,
  fallbackModelId = 'modnet',
  fallbackSubjectCategory = 'auto',
}: BackgroundPromptPlanInput): Promise<BackgroundPromptPlanResult> {
  const messages = await formatBackgroundRemoverMessages(systemPrompt, userPrompt);

  const sysText = systemPrompt.trim();
  const userText = userPrompt.trim();

  let modelId: 'modnet' | 'birefnet-lite' = fallbackModelId;
  let subjectCategory: SubjectCategory = fallbackSubjectCategory;
  let threshold = 0;
  let edgeSoftness = 0;
  const reasons: string[] = [];

  // 1. Check explicit system prompt directives first (e.g. "force birefnet-lite", "always use modnet")
  const forceBirefnet = /\b(always\s+use|force|override(?:\s+to)?|default(?:\s+to)?)\s+birefnet(?:-lite)?\b/i.test(sysText);
  const forceModnet = /\b(always\s+use|force|override(?:\s+to)?|default(?:\s+to)?)\s+modnet\b/i.test(sysText);

  // 2. Analyze user prompt intent for subject routing
  if (userText) {
    if (FINE_EDGE_PATTERN.test(userText)) {
      subjectCategory = 'fine-edge';
      modelId = 'birefnet-lite';
      threshold = 0;
      edgeSoftness = 1;
      reasons.push('Fine edges/hair/fur detected -> BiRefNet-lite');
    } else if (ARCHITECTURE_OBJECT_PATTERN.test(userText)) {
      subjectCategory = 'product';
      modelId = 'birefnet-lite';
      threshold = 10;
      edgeSoftness = 0;
      reasons.push('Objects/architecture detected -> BiRefNet-lite');
    } else if (GRAPHIC_PATTERN.test(userText)) {
      subjectCategory = 'graphic';
      modelId = 'modnet';
      threshold = 25;
      edgeSoftness = 0;
      reasons.push('Graphics/logos detected -> MODNet with crisp threshold');
    } else if (PORTRAIT_PATTERN.test(userText)) {
      subjectCategory = 'portrait';
      modelId = 'modnet';
      threshold = 0;
      edgeSoftness = 1;
      reasons.push('Portrait/person detected -> MODNet');
    }
  }

  // Apply explicit system prompt model overrides if present
  if (forceBirefnet) {
    modelId = 'birefnet-lite';
    reasons.push('System prompt override -> BiRefNet-lite');
  } else if (forceModnet) {
    modelId = 'modnet';
    reasons.push('System prompt override -> MODNet');
  }

  // 3. Parse refinement cues from user prompt or explicit system prompt numeric rules
  if (/\b(crisp|sharp|hard\s+edge|clean\s+fringe|no\s+halo)\b/i.test(userText)) {
    threshold = Math.max(threshold, 20);
    edgeSoftness = 0;
    reasons.push(`Crisp edge cue -> threshold ${threshold}%`);
  }
  if (/\b(soft|feather|smooth|blend|gentle)\b/i.test(userText)) {
    edgeSoftness = Math.max(edgeSoftness, 2);
    reasons.push(`Soft edge cue -> feather ${edgeSoftness}px`);
  }

  const sysThresholdMatch = sysText.match(/\bthreshold\s*[:=]\s*(\d{1,3})\b/i);
  if (sysThresholdMatch) {
    threshold = Math.min(100, Math.max(0, Number(sysThresholdMatch[1])));
    reasons.push(`System prompt threshold=${threshold}%`);
  }

  const sysSoftnessMatch = sysText.match(/\b(?:edgeSoftness|softness|feather)\s*[:=]\s*(\d{1,2})\b/i);
  if (sysSoftnessMatch) {
    edgeSoftness = Math.min(20, Math.max(0, Number(sysSoftnessMatch[1])));
    reasons.push(`System prompt softness=${edgeSoftness}px`);
  }

  if (reasons.length === 0) {
    reasons.push(`Using ${modelId === 'birefnet-lite' ? 'BiRefNet-lite' : 'MODNet'} with natural matte`);
  }

  return {
    messages,
    modelId,
    subjectCategory,
    threshold,
    edgeSoftness,
    reasoning: reasons.join(' • '),
  };
}
