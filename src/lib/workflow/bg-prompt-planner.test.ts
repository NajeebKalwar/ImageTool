import { describe, it, expect } from 'vitest';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import {
  DEFAULT_BG_REMOVER_SYSTEM_PROMPT,
  formatBackgroundRemoverMessages,
  planBackgroundRemovalFromPrompt,
} from './bg-prompt-planner';

describe('LangChain Background Remover System Prompt Planner', () => {
  it('formats system and human messages via ChatPromptTemplate', async () => {
    const messages = await formatBackgroundRemoverMessages(
      'Custom system role',
      'Keep the stone arch and remove the sky',
    );

    expect(messages).toHaveLength(2);
    expect(messages[0]).toBeInstanceOf(SystemMessage);
    expect(messages[1]).toBeInstanceOf(HumanMessage);
    expect(messages[0].content).toBe('Custom system role');
    expect(messages[1].content).toBe('Keep the stone arch and remove the sky');
  });

  it('routes architectural/object prompt to birefnet-lite with product guidance', async () => {
    const plan = await planBackgroundRemovalFromPrompt({
      systemPrompt: DEFAULT_BG_REMOVER_SYSTEM_PROMPT,
      userPrompt: 'Keep the golden stone arch and pillar, remove the blue sky',
    });

    expect(plan.modelId).toBe('birefnet-lite');
    expect(plan.subjectCategory).toBe('product');
    expect(plan.threshold).toBe(10);
    expect(plan.reasoning).toContain('BiRefNet-lite');
  });

  it('routes portrait prompt with soft edges to modnet and feathering', async () => {
    const plan = await planBackgroundRemovalFromPrompt({
      systemPrompt: DEFAULT_BG_REMOVER_SYSTEM_PROMPT,
      userPrompt: 'Portrait selfie with soft feathered edges',
    });

    expect(plan.modelId).toBe('modnet');
    expect(plan.subjectCategory).toBe('portrait');
    expect(plan.edgeSoftness).toBe(2);
  });

  it('respects explicit system prompt model and threshold overrides', async () => {
    const plan = await planBackgroundRemovalFromPrompt({
      systemPrompt: 'Always use birefnet-lite. threshold: 35 edgeSoftness: 3',
      userPrompt: 'Just cut out my headshot',
    });

    expect(plan.modelId).toBe('birefnet-lite');
    expect(plan.threshold).toBe(35);
    expect(plan.edgeSoftness).toBe(3);
  });
});
