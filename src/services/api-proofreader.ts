import type { IProofreader } from './proofreader.ts';
import type {
  ProofreadResult,
  ProofreadCorrection,
  CorrectionType,
  ApiConfig,
  ApiType,
} from '../shared/types.ts';
import { logger } from './logger.ts';

// ─── Shared utilities ──────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;

function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function ensureHostPermission(apiUrl: string): Promise<void> {
  const origin = new URL(apiUrl).origin + '/*';
  const granted = await chrome.permissions.contains({ origins: [origin] });
  if (!granted) {
    throw new Error(
      `Permission not granted for ${new URL(apiUrl).origin}. Please test the connection in Settings first.`
    );
  }
}

// ─── Provider interface ────────────────────────────────────────────────────

export interface ApiTestResult {
  ok: boolean;
  message: string;
}

export interface ApiModel {
  id: string;
  displayName: string;
}

export interface ApiProvider {
  testConnection(config: ApiConfig): Promise<ApiTestResult>;
  fetchModels(config: ApiConfig): Promise<ApiModel[]>;
  createProofreader(config: ApiConfig): IProofreader;
}

// ─── Claude provider ───────────────────────────────────────────────────────

const ANTHROPIC_API_VERSION = '2023-06-01';

const PROOFREAD_TOOL = {
  name: 'report_corrections',
  description:
    'Report all proofreading corrections found in the text. Each correction must reference the exact original text from the input.',
  input_schema: {
    type: 'object' as const,
    properties: {
      corrections: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            originalText: {
              type: 'string',
              description: 'The exact original substring from the input that contains the error',
            },
            correctedText: {
              type: 'string',
              description: 'The corrected replacement text',
            },
            type: {
              type: 'string',
              enum: [
                'spelling',
                'grammar',
                'punctuation',
                'capitalization',
                'preposition',
                'missing-words',
              ],
              description: 'The error category',
            },
            explanation: {
              type: 'string',
              description: 'Brief explanation of the correction',
            },
          },
          required: ['originalText', 'correctedText'],
        },
      },
    },
    required: ['corrections'],
  },
};

interface ClaudeRawCorrection {
  originalText: string;
  correctedText: string;
  type?: string;
  explanation?: string;
}

function resolvePositions(
  text: string,
  claudeCorrections: ClaudeRawCorrection[]
): ProofreadCorrection[] {
  const corrections: ProofreadCorrection[] = [];
  const usedRanges: Array<[number, number]> = [];

  for (const raw of claudeCorrections) {
    const { originalText, correctedText, type, explanation } = raw;
    if (!originalText || originalText === correctedText) continue;

    let searchFrom = 0;
    let idx = -1;
    while ((idx = text.indexOf(originalText, searchFrom)) !== -1) {
      const end = idx + originalText.length;
      const overlaps = usedRanges.some(([s, e]) => idx < e && end > s);
      if (!overlaps) break;
      searchFrom = idx + 1;
    }
    if (idx === -1) continue;

    usedRanges.push([idx, idx + originalText.length]);
    corrections.push({
      startIndex: idx,
      endIndex: idx + originalText.length,
      correction: correctedText,
      type: type as CorrectionType | undefined,
      explanation,
    });
  }

  corrections.sort((a, b) => a.startIndex - b.startIndex);
  const filtered: ProofreadCorrection[] = [];
  let lastEnd = -1;
  for (const c of corrections) {
    if (c.startIndex >= lastEnd) {
      filtered.push(c);
      lastEnd = c.endIndex;
    }
  }

  return filtered;
}

function buildClaudeHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': ANTHROPIC_API_VERSION,
  };
  if (apiKey) {
    headers['x-api-key'] = apiKey;
  }
  return headers;
}

function parseApiError(response: Response, errorData: unknown): string {
  return (
    (errorData as { error?: { message?: string } })?.error?.message ??
    `HTTP ${response.status}: ${response.statusText}`
  );
}

async function testClaudeConnection(config: ApiConfig): Promise<ApiTestResult> {
  const { apiUrl, apiKey } = config;

  try {
    const response = await fetchWithTimeout(`${apiUrl}/v1/models`, {
      headers: buildClaudeHeaders(apiKey),
    });

    if (response.ok) {
      return { ok: true, message: 'Connection successful' };
    }

    const errorData = await response.json().catch(() => ({}));
    return { ok: false, message: parseApiError(response, errorData) };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return { ok: false, message: 'Connection timed out' };
    }
    const msg = error instanceof Error ? error.message : 'Connection failed';
    return { ok: false, message: msg };
  }
}

async function fetchClaudeModels(config: ApiConfig): Promise<ApiModel[]> {
  const { apiUrl, apiKey } = config;

  const response = await fetchWithTimeout(`${apiUrl}/v1/models`, {
    headers: buildClaudeHeaders(apiKey),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(parseApiError(response, errorData));
  }

  const data = await response.json();
  const models = (data.data ?? []) as Array<{
    id: string;
    display_name?: string;
  }>;
  return models.map((m) => ({
    id: m.id,
    displayName: m.display_name ?? m.id,
  }));
}

function createClaudeApiProofreader(config: ApiConfig): IProofreader {
  return {
    async proofread(text: string): Promise<ProofreadResult> {
      const { apiUrl, apiKey, selectedModel } = config;

      if (!selectedModel) {
        throw new Error('No AI model selected. Please choose a model in settings.');
      }

      await ensureHostPermission(apiUrl);

      const response = await fetchWithTimeout(`${apiUrl}/v1/messages`, {
        method: 'POST',
        headers: buildClaudeHeaders(apiKey),
        body: JSON.stringify({
          model: selectedModel,
          max_tokens: 2048,
          system:
            'You are a precise proofreading assistant. Detect the language of the input text automatically and identify grammar, spelling, punctuation, capitalization, preposition, and missing-word errors. Use the provided tool to report corrections. Only report real errors — not style preferences.',
          messages: [
            {
              role: 'user',
              content: `Proofread the following text and report all errors:\n\n${text}`,
            },
          ],
          tools: [PROOFREAD_TOOL],
          tool_choice: { type: 'any' },
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(parseApiError(response, errorData));
      }

      const data = await response.json();

      const toolUse = (
        data.content as Array<{
          type: string;
          name?: string;
          input?: unknown;
        }>
      )?.find((block) => block.type === 'tool_use' && block.name === 'report_corrections');

      if (!toolUse) {
        return { correctedInput: text, corrections: [] };
      }

      const rawCorrections: ClaudeRawCorrection[] =
        (toolUse.input as { corrections?: ClaudeRawCorrection[] })?.corrections ?? [];

      const corrections = resolvePositions(text, rawCorrections);

      let correctedInput = text;
      const sorted = [...corrections].sort((a, b) => b.startIndex - a.startIndex);
      for (const correction of sorted) {
        correctedInput =
          correctedInput.slice(0, correction.startIndex) +
          correction.correction +
          correctedInput.slice(correction.endIndex);
      }

      logger.info({ corrections: corrections.length }, 'Claude API proofreading completed');

      return { correctedInput, corrections };
    },

    destroy() {},
  };
}

const claudeProvider: ApiProvider = {
  testConnection: testClaudeConnection,
  fetchModels: fetchClaudeModels,
  createProofreader: createClaudeApiProofreader,
};

// ─── Provider registry ─────────────────────────────────────────────────────

const providers = new Map<ApiType, ApiProvider>([['claude', claudeProvider]]);

export function getApiProvider(type: ApiType): ApiProvider {
  const provider = providers.get(type);
  if (!provider) {
    throw new Error(`Unsupported API provider: ${type}`);
  }
  return provider;
}

export async function requestHostPermission(apiUrl: string): Promise<boolean> {
  try {
    const origin = new URL(apiUrl).origin + '/*';
    const has = await chrome.permissions.contains({ origins: [origin] });
    if (has) return true;
    return chrome.permissions.request({ origins: [origin] });
  } catch {
    return false;
  }
}
