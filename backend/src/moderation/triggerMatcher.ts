import type { ModerationTrigger } from '../db/repositories/moderationTriggerRepository.js';

export interface TriggerMatchResult {
  trigger: ModerationTrigger;
  matchedPattern: string;
  strategy: 'exact-substring' | 'normalized-substring';
}

export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]/g, '');
}

export function findTriggeredRule(messageText: string, triggers: ModerationTrigger[]): TriggerMatchResult | null {
  const text = (messageText || '').trim();
  if (!text) return null;

  const lowerText = text.toLowerCase();
  const normalizedText = normalizeForMatch(text);

  for (const trigger of triggers) {
    if (!trigger.enabled) continue;
    const pattern = (trigger.pattern || '').trim();
    if (!pattern) continue;

    const lowerPattern = pattern.toLowerCase();
    if (lowerText.includes(lowerPattern)) {
      return {
        trigger,
        matchedPattern: pattern,
        strategy: 'exact-substring'
      };
    }

    const normalizedPattern = normalizeForMatch(pattern);
    if (normalizedPattern && normalizedText.includes(normalizedPattern)) {
      return {
        trigger,
        matchedPattern: pattern,
        strategy: 'normalized-substring'
      };
    }
  }

  return null;
}

export function parseDurationMs(duration: string | null | undefined): number {
  if (!duration) return 15 * 60 * 1000;
  const normalized = duration.trim().toLowerCase();
  const m = normalized.match(/^(\d+)([smhd])$/);
  if (!m) return 15 * 60 * 1000;

  const n = parseInt(m[1], 10);
  const unit = m[2];
  const multiplier = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return n * multiplier;
}
