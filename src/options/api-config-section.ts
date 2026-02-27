import { debounce } from '../shared/utils/debounce.ts';
import { setStorageValue } from '../shared/utils/storage.ts';
import { STORAGE_KEYS } from '../shared/constants.ts';
import { requestHostPermission } from '../services/api-proofreader.ts';
import { logger } from '../services/logger.ts';
import type { ModelSource, ApiConfig } from '../shared/types.ts';
import type {
  ApiTestConnectionResponse,
  ApiFetchModelsResponse,
} from '../shared/messages/issues.ts';

export interface ApiConfigSectionOptions {
  initialModelSource: ModelSource;
  initialApiConfig: ApiConfig;
  onModelSourceChange: (source: ModelSource) => void;
}

export interface ApiConfigSectionControls {
  getCurrentModelSource(): ModelSource;
  getCurrentApiConfig(): ApiConfig;
  destroy(): void;
}

export function setupApiConfigSection(options: ApiConfigSectionOptions): ApiConfigSectionControls {
  let currentModelSource = options.initialModelSource;
  let currentApiConfig = structuredClone(options.initialApiConfig);
  const cleanups: Array<() => void> = [];

  const saveApiConfig = debounce(async (config: ApiConfig) => {
    await setStorageValue(STORAGE_KEYS.API_CONFIG, structuredClone(config)).catch((err) => {
      logger.error({ err }, 'Failed to save API config');
    });
  }, 500);

  const apiConfigSection = document.querySelector<HTMLElement>('#apiConfigSection');
  const localModelStatus = document.querySelector<HTMLElement>('#localModelStatus');
  const apiUrlInput = document.querySelector<HTMLInputElement>('#apiUrl');
  const apiKeyInput = document.querySelector<HTMLInputElement>('#apiKey');
  const toggleApiKeyBtn = document.querySelector<HTMLButtonElement>('#toggleApiKey');
  const testConnectionBtn = document.querySelector<HTMLButtonElement>('#testConnectionBtn');
  const fetchModelsBtn = document.querySelector<HTMLButtonElement>('#fetchModelsBtn');
  const connectionStatus = document.querySelector<HTMLSpanElement>('#connectionStatus');
  const modelSelectField = document.querySelector<HTMLElement>('#modelSelectField');
  const selectedModelSelect = document.querySelector<HTMLSelectElement>('#selectedModel');

  if (apiUrlInput) apiUrlInput.value = currentApiConfig.apiUrl;
  if (apiKeyInput) apiKeyInput.value = currentApiConfig.apiKey;

  if (currentApiConfig.selectedModel && selectedModelSelect) {
    const label = currentApiConfig.selectedModelDisplayName || currentApiConfig.selectedModel;
    selectedModelSelect.innerHTML = `<option value="${currentApiConfig.selectedModel}">${label}</option>`;
  }

  // ── Status display with timer cleanup ──────────────────────────────────

  let statusTimer: ReturnType<typeof setTimeout> | null = null;

  const showConnectionStatus = (msg: string, type: 'success' | 'error', autoDismissMs = 4000) => {
    if (!connectionStatus) return;
    if (statusTimer) clearTimeout(statusTimer);
    connectionStatus.textContent = msg;
    connectionStatus.className = `connection-status visible ${type}`;
    statusTimer = setTimeout(() => {
      connectionStatus.className = 'connection-status';
      statusTimer = null;
    }, autoDismissMs);
  };

  // ── Source toggle ──────────────────────────────────────────────────────

  const sourceRadios = Array.from(
    document.querySelectorAll<HTMLInputElement>('input[name="modelSource"]')
  );

  const onSourceChange = async (event: Event) => {
    const radio = event.target as HTMLInputElement;
    if (!radio.checked) return;
    currentModelSource = radio.value as ModelSource;
    await setStorageValue(STORAGE_KEYS.MODEL_SOURCE, currentModelSource);
    apiConfigSection?.toggleAttribute('hidden', currentModelSource !== 'api');
    localModelStatus?.toggleAttribute('hidden', currentModelSource === 'api');
    options.onModelSourceChange(currentModelSource);
  };

  sourceRadios.forEach((radio) => radio.addEventListener('change', onSourceChange));
  cleanups.push(() =>
    sourceRadios.forEach((radio) => radio.removeEventListener('change', onSourceChange))
  );

  // ── Form fields ────────────────────────────────────────────────────────

  const onApiUrlInput = () => {
    if (!apiUrlInput) return;
    currentApiConfig = { ...currentApiConfig, apiUrl: apiUrlInput.value };
    void saveApiConfig(currentApiConfig);
  };

  const onApiKeyInput = () => {
    if (!apiKeyInput) return;
    currentApiConfig = { ...currentApiConfig, apiKey: apiKeyInput.value };
    void saveApiConfig(currentApiConfig);
  };

  const onToggleApiKey = () => {
    if (!apiKeyInput) return;
    const isPassword = apiKeyInput.type === 'password';
    apiKeyInput.type = isPassword ? 'text' : 'password';
    if (toggleApiKeyBtn) toggleApiKeyBtn.textContent = isPassword ? 'Hide' : 'Show';
  };

  apiUrlInput?.addEventListener('input', onApiUrlInput);
  apiKeyInput?.addEventListener('input', onApiKeyInput);
  toggleApiKeyBtn?.addEventListener('click', onToggleApiKey);
  cleanups.push(() => {
    apiUrlInput?.removeEventListener('input', onApiUrlInput);
    apiKeyInput?.removeEventListener('input', onApiKeyInput);
    toggleApiKeyBtn?.removeEventListener('click', onToggleApiKey);
  });

  // ── Test connection ────────────────────────────────────────────────────

  const onTestConnection = async () => {
    if (!testConnectionBtn) return;
    testConnectionBtn.disabled = true;
    testConnectionBtn.textContent = 'Testing…';
    connectionStatus?.classList.remove('visible');

    try {
      const granted = await requestHostPermission(currentApiConfig.apiUrl);
      if (!granted) {
        showConnectionStatus('Host permission denied by user', 'error');
        return;
      }

      const response = await new Promise<ApiTestConnectionResponse>((resolve, reject) => {
        chrome.runtime.sendMessage({ type: 'proofly:api-test-connection' }, (res) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(res as ApiTestConnectionResponse);
          }
        });
      });
      showConnectionStatus(
        response.ok ? 'Connected' : response.message,
        response.ok ? 'success' : 'error'
      );
    } catch (err) {
      showConnectionStatus(err instanceof Error ? err.message : 'Connection failed', 'error');
    } finally {
      testConnectionBtn.disabled = false;
      testConnectionBtn.textContent = 'Test connection';
    }
  };

  testConnectionBtn?.addEventListener('click', onTestConnection);
  cleanups.push(() => testConnectionBtn?.removeEventListener('click', onTestConnection));

  // ── Fetch models ───────────────────────────────────────────────────────

  const onFetchModels = async () => {
    if (!fetchModelsBtn) return;
    fetchModelsBtn.disabled = true;
    fetchModelsBtn.textContent = 'Fetching…';

    try {
      const granted = await requestHostPermission(currentApiConfig.apiUrl);
      if (!granted) {
        showConnectionStatus('Host permission denied by user', 'error');
        return;
      }

      const response = await new Promise<ApiFetchModelsResponse>((resolve, reject) => {
        chrome.runtime.sendMessage({ type: 'proofly:api-fetch-models' }, (res) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(res as ApiFetchModelsResponse);
          }
        });
      });

      if (response.ok && response.models && selectedModelSelect && modelSelectField) {
        selectedModelSelect.innerHTML = response.models
          .map(
            (m) =>
              `<option value="${m.id}" ${m.id === currentApiConfig.selectedModel ? 'selected' : ''}>${m.displayName}</option>`
          )
          .join('');
        modelSelectField.removeAttribute('hidden');
        showConnectionStatus(`${response.models.length} models loaded`, 'success');

        if (!currentApiConfig.selectedModel && response.models[0]) {
          const first = response.models[0];
          currentApiConfig = {
            ...currentApiConfig,
            selectedModel: first.id,
            selectedModelDisplayName: first.displayName,
          };
          selectedModelSelect.value = first.id;
          void saveApiConfig(currentApiConfig);
        }
      } else if (!response.ok) {
        showConnectionStatus(response.message ?? 'Failed to fetch models', 'error');
      }
    } catch (err) {
      showConnectionStatus(err instanceof Error ? err.message : 'Failed to fetch models', 'error');
    } finally {
      fetchModelsBtn.disabled = false;
      fetchModelsBtn.textContent = 'Fetch models';
    }
  };

  fetchModelsBtn?.addEventListener('click', onFetchModels);
  cleanups.push(() => fetchModelsBtn?.removeEventListener('click', onFetchModels));

  // ── Model select ───────────────────────────────────────────────────────

  const onModelChange = () => {
    if (!selectedModelSelect) return;
    const selectedOption = selectedModelSelect.selectedOptions[0];
    currentApiConfig = {
      ...currentApiConfig,
      selectedModel: selectedModelSelect.value,
      selectedModelDisplayName: selectedOption?.textContent ?? selectedModelSelect.value,
    };
    void saveApiConfig(currentApiConfig);
  };

  selectedModelSelect?.addEventListener('change', onModelChange);
  cleanups.push(() => selectedModelSelect?.removeEventListener('change', onModelChange));

  return {
    getCurrentModelSource: () => currentModelSource,
    getCurrentApiConfig: () => structuredClone(currentApiConfig),
    destroy() {
      if (statusTimer) clearTimeout(statusTimer);
      saveApiConfig.cancel();
      cleanups.forEach((fn) => fn());
      cleanups.length = 0;
    },
  };
}
