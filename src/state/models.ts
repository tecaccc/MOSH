/**
 * AI Provider/Model 实体 store(08-28-ai-model-management)。
 *
 * 服务端状态模式:每次变更后重拉全量列表(SQLite 为唯一事实源,无乐观更新)。
 * 派生选择器为纯函数(selectChatModels 等),组件内 useMemo 消费。
 */
import {
  aiDeleteModel,
  aiDeleteProvider,
  aiGetDefaultModel,
  aiListModels,
  aiListProviders,
  aiSetDefaultModel,
  aiSyncModels,
  aiUpsertModel,
  aiUpsertProvider,
} from "../lib/ipc";
import type { AiDefaultModel, AiModel, AiProvider } from "../lib/types";
import { create } from "zustand";

interface ModelsState {
  providers: AiProvider[];
  models: AiModel[];
  /** null = 未加载或无默认。 */
  defaultModel: AiDefaultModel | null;
  /** 首次加载是否完成(设置页/选择器空态区分「加载中」与「真没有」)。 */
  loaded: boolean;
  /** 设置页当前编辑的 Provider id;null = 新增自定义草稿;undefined = 未选。 */
  selectedProviderId: string | null | undefined;

  load(): Promise<void>;
  selectProvider(id: string | null): void;
  upsertProvider(provider: AiProvider): Promise<AiProvider>;
  deleteProvider(providerId: string): Promise<void>;
  upsertModel(model: AiModel): Promise<void>;
  deleteModel(uniqueId: string): Promise<void>;
  syncModels(providerId: string): Promise<{ added: string[]; hidden: string[] }>;
  setDefaultModel(uniqueId: string): Promise<void>;
}

export const useModelsStore = create<ModelsState>()((set, get) => ({
  providers: [],
  models: [],
  defaultModel: null,
  loaded: false,
  selectedProviderId: undefined,

  load: async () => {
    try {
      const [providers, models, defaultModel] = await Promise.all([
        aiListProviders(),
        aiListModels(),
        aiGetDefaultModel(),
      ]);
      set({ providers, models, defaultModel, loaded: true });
    } catch (e) {
      // 非 Tauri 环境或命令失败:置空但标记已加载,避免 UI 卡「加载中」。
      console.error("[models] load failed:", e);
      set({ providers: [], models: [], defaultModel: null, loaded: true });
    }
  },

  selectProvider: (id) => set({ selectedProviderId: id }),

  upsertProvider: async (provider) => {
    const saved = await aiUpsertProvider(provider);
    await get().load();
    set({ selectedProviderId: saved.id });
    return saved;
  },

  deleteProvider: async (providerId) => {
    await aiDeleteProvider(providerId);
    await get().load();
    set({ selectedProviderId: undefined });
  },

  upsertModel: async (model) => {
    await aiUpsertModel(model);
    await get().load();
  },

  deleteModel: async (uniqueId) => {
    await aiDeleteModel(uniqueId);
    await get().load();
  },

  syncModels: async (providerId) => {
    const r = await aiSyncModels(providerId);
    await get().load();
    return r;
  },

  setDefaultModel: async (uniqueId) => {
    await aiSetDefaultModel(uniqueId);
    await get().load();
  },
}));

// ── 派生选择器(纯函数,组件 useMemo 消费)──

/** 可聊天模型:所属 provider 启用、自身 enabled 且未 hidden;按 provider 分组、组内 pinned 优先。 */
export function selectChatModels(
  providers: AiProvider[],
  models: AiModel[],
): { provider: AiProvider; models: AiModel[] }[] {
  const byProvider = new Map<string, AiModel[]>();
  for (const m of models) {
    if (!m.enabled || m.hidden) continue;
    const list = byProvider.get(m.provider_id) ?? [];
    list.push(m);
    byProvider.set(m.provider_id, list);
  }
  const out: { provider: AiProvider; models: AiModel[] }[] = [];
  for (const p of providers) {
    if (!p.enabled) continue;
    const list = byProvider.get(p.id);
    if (!list || list.length === 0) continue;
    list.sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.sort_order - b.sort_order || a.model_id.localeCompare(b.model_id));
    out.push({ provider: p, models: list });
  }
  return out;
}

/** 按 UniqueModelId 找模型 + 所属 provider。 */
export function findModelWithProvider(
  providers: AiProvider[],
  models: AiModel[],
  uniqueId: string | null | undefined,
): { provider: AiProvider; model: AiModel } | undefined {
  if (!uniqueId) return undefined;
  const model = models.find((m) => m.id === uniqueId);
  if (!model) return undefined;
  const provider = providers.find((p) => p.id === model.provider_id);
  return provider ? { provider, model } : undefined;
}

/** 模型显示名:name 非空用 name,否则 model_id。 */
export function modelDisplayName(m: AiModel): string {
  return m.name?.trim() || m.model_id;
}
