/**
 * AI 模型设置分区(08-28-ai-model-management)。
 *
 * 双栏:`AiProviderColumn`(提供商栏,由 SettingsView 放进 aside)+ `AiSettingsPane`
 * (配置区)。两栏经 models store 的 selectedProviderId 联动(null = 新增自定义草稿)。
 */
import AiModelSelector from "./ModelSelector";
import {
  AiEntityIcon,
  CAPABILITY_LABELS,
  MODEL_CAPABILITIES,
  effectiveCapabilities,
  inferCapabilities,
  type ModelCapability,
} from "../lib/aiIcons";
import { PROVIDER_PRESETS, presetOf, type ProviderPreset } from "../lib/aiPresets";
import { useDialogStore } from "../state/dialog";
import { testAiConnection } from "../lib/ipc";
import type { AiModel, AiProvider } from "../lib/types";
import { modelDisplayName, useModelsStore } from "../state/models";
import { toast } from "../state/toast";
import { useEffect, useMemo, useState } from "react";
import styles from "./AiSettings.module.css";

// ── 提供商栏 ──

/** 从预置一键添加:建 provider + 默认模型行,选中并进入编辑。 */
async function addFromPreset(preset: ProviderPreset) {
  const store = useModelsStore.getState();
  try {
    const provider = await store.upsertProvider({
      id: preset.key,
      preset_id: preset.key,
      name: preset.name,
      base_url: preset.baseUrl,
      api_key: "",
      enabled: true,
      sort_order: 0,
      created_at: "",
    });
    if (preset.defaultModel) {
      await store.upsertModel({
        id: `${preset.key}::${preset.defaultModel}`,
        provider_id: preset.key,
        model_id: preset.defaultModel,
        name: null,
        capabilities: inferCapabilities(preset.defaultModel),
        context_window: null,
        notes: null,
        pinned: false,
        enabled: true,
        hidden: false,
        sort_order: 1,
      });
    }
    useModelsStore.getState().selectProvider(provider.id);
    toast.success(`已添加 ${preset.name},请填写 API Key`);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e));
  }
}

export function AiProviderColumn() {
  const providers = useModelsStore((s) => s.providers);
  const models = useModelsStore((s) => s.models);
  const loaded = useModelsStore((s) => s.loaded);
  const load = useModelsStore((s) => s.load);
  const selectedProviderId = useModelsStore((s) => s.selectedProviderId);
  const selectProvider = useModelsStore((s) => s.selectProvider);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  // 首次进入:自动选中第一个(无 provider 则停在预置区)。
  useEffect(() => {
    if (loaded && selectedProviderId === undefined && providers.length > 0) {
      selectProvider(providers[0].id);
    }
  }, [loaded, selectedProviderId, providers, selectProvider]);

  const modelCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const x of models) {
      if (!x.enabled || x.hidden) continue;
      m.set(x.provider_id, (m.get(x.provider_id) ?? 0) + 1);
    }
    return m;
  }, [models]);

  const addedPresetKeys = new Set(
    providers.map((p) => p.preset_id ?? p.id).filter((k) => presetOf(k)),
  );
  const unaddedPresets = PROVIDER_PRESETS.filter((p) => !addedPresetKeys.has(p.key));

  return (
    <>
      <div className={styles.plLabel}>
        已添加
        <span className={styles.plLabelSub}>{providers.length} 家</span>
      </div>
      <div className={styles.plItems}>
        {providers.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`${styles.plItem}${selectedProviderId === p.id ? ` ${styles.plActive}` : ""}`}
            onClick={() => selectProvider(p.id)}
          >
            <AiEntityIcon providerId={p.id} presetId={p.preset_id ?? undefined} providerName={p.name} size={18} />
            <span className={styles.plName}>{p.name}</span>
            {!p.enabled ? <span className={styles.plOff} title="已停用">停</span> : null}
            <span className={styles.plCount} title="可用模型数">
              {modelCount.get(p.id) ?? 0}
            </span>
          </button>
        ))}
        {loaded && providers.length === 0 ? (
          <div className={styles.plEmpty}>从下方预置开始添加</div>
        ) : null}
      </div>

      <div className={styles.plLabel}>
        添加预置
        <span className={styles.plLabelSub}>官方地址预填</span>
      </div>
      <div className={styles.presetGrid}>
        {unaddedPresets.map((p) => (
          <button key={p.key} type="button" className={styles.presetChip} onClick={() => void addFromPreset(p)} title={p.baseUrl}>
            <AiEntityIcon providerId={p.key} size={16} />
            <span className={styles.presetName}>{p.name}</span>
          </button>
        ))}
        {unaddedPresets.length === 0 ? <div className={styles.plEmpty}>全部已添加</div> : null}
      </div>

      <button type="button" className={styles.customAdd} onClick={() => selectProvider(null)}>
        ＋ 自定义提供商
      </button>
    </>
  );
}

// ── 配置区 ──

export function AiSettingsPane() {
  const providers = useModelsStore((s) => s.providers);
  const models = useModelsStore((s) => s.models);
  const loaded = useModelsStore((s) => s.loaded);
  const defaultModel = useModelsStore((s) => s.defaultModel);
  const selectedProviderId = useModelsStore((s) => s.selectedProviderId);
  const upsertProvider = useModelsStore((s) => s.upsertProvider);
  const deleteProvider = useModelsStore((s) => s.deleteProvider);
  const syncModels = useModelsStore((s) => s.syncModels);
  const setDefaultModel = useModelsStore((s) => s.setDefaultModel);

  const provider = useMemo(
    () => (selectedProviderId ? providers.find((p) => p.id === selectedProviderId) : undefined),
    [providers, selectedProviderId],
  );
  const providerModels = useMemo(
    () =>
      models
        .filter((m) => m.provider_id === provider?.id)
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.sort_order - b.sort_order || a.model_id.localeCompare(b.model_id)),
    [models, provider?.id],
  );

  // 表单(provider 切换时重灌;草稿时空表单)。
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [manualModelId, setManualModelId] = useState("");

  useEffect(() => {
    setName(provider?.name ?? "");
    setBaseUrl(provider?.base_url ?? "");
    setApiKey(provider?.api_key ?? "");
    setEnabled(provider?.enabled ?? true);
  }, [provider?.id]); // eslint-disable-line react-hooks/exhaustive-deps -- 切换 provider 时重灌表单

  if (!loaded) {
    return <div className={styles.loading}>加载中…</div>;
  }

  if (!provider && selectedProviderId !== null) {
    return (
      <div className={styles.loading}>
        左侧选择或添加一个提供商开始配置;预置项自动预填官方接口地址。
      </div>
    );
  }

  const isCustom = !provider?.preset_id;
  const dirty =
    !!provider &&
    (provider.name !== name.trim() ||
      provider.base_url !== baseUrl.trim() ||
      provider.api_key !== apiKey.trim() ||
      provider.enabled !== enabled);

  async function onSave() {
    if (!name.trim() || !baseUrl.trim()) {
      toast.error("名称与接口地址不能为空");
      return;
    }
    setSaving(true);
    try {
      const input: AiProvider = {
        id: provider?.id ?? "", // 空 id → 后端生成 custom-*
        preset_id: provider?.preset_id ?? null,
        name: name.trim(),
        base_url: baseUrl.trim(),
        api_key: apiKey.trim(),
        enabled,
        sort_order: provider?.sort_order ?? 0,
        created_at: provider?.created_at ?? "",
      };
      const saved = await upsertProvider(input);
      toast.success(`已保存 ${saved.name}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function onTest() {
    const model = providerModels.find((m) => m.enabled && !m.hidden) ?? providerModels[0];
    if (!baseUrl.trim()) {
      toast.error("请先填写接口地址");
      return;
    }
    if (!model) {
      toast.error("请先添加模型(可点「同步模型」)");
      return;
    }
    setTesting(true);
    try {
      const reply = await testAiConnection(baseUrl.trim(), apiKey.trim(), model.model_id);
      toast.success(`连接成功:${modelDisplayName(model)}${reply ? ` · ${reply}` : ""}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  }

  async function onSync() {
    if (!provider) return;
    setSyncing(true);
    try {
      const r = await syncModels(provider.id);
      const parts: string[] = [];
      if (r.added.length > 0) parts.push(`新增 ${r.added.length}`);
      if (r.hidden.length > 0) parts.push(`下架 ${r.hidden.length}`);
      toast.success(`同步完成${parts.length > 0 ? `:${parts.join("，")}` : ",无变化"}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  }

  async function onDelete() {
    if (!provider) return;
    const ok = await useDialogStore.getState().confirm({
      title: "删除提供商",
      message: `将删除「${provider.name}」及其全部模型（含已保存配置），不可恢复。`,
      danger: true,
      confirmText: "删除",
    });
    if (!ok) return;
    try {
      await deleteProvider(provider.id);
      toast.success("已删除");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  /** 默认模型切换(选择器/模型行共用):失败可见，不静默。 */
  async function onDefaultModelChange(id: string) {
    try {
      await setDefaultModel(id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function onAddManualModel() {
    if (!provider) return;
    const mid = manualModelId.trim();
    if (!mid) return;
    try {
      await useModelsStore.getState().upsertModel({
        id: `${provider.id}::${mid}`,
        provider_id: provider.id,
        model_id: mid,
        name: null,
        capabilities: inferCapabilities(mid),
        context_window: null,
        notes: null,
        pinned: false,
        enabled: true,
        hidden: false,
        sort_order: 0,
      });
      setManualModelId("");
      toast.success(`已添加 ${mid}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className={styles.pane}>
      {/* —— 连接配置 —— */}
      <div className={styles.sectionTitle}>
        {provider ? provider.name : "新增自定义提供商"}
        {provider?.preset_id ? <span className={styles.presetBadge}>预置</span> : null}
      </div>

      <Row label="提供商名称" hint={isCustom ? "命中已知品牌会显示对应图标" : undefined}>
        <input className={styles.input} value={name} onChange={(e) => setName(e.target.value)} placeholder="My Provider" />
      </Row>
      <Row label="接口地址" hint="OpenAI 兼容端点,如 https://api.example.com/v1">
        <input className={styles.input} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" />
      </Row>
      <Row label="API Key" hint="仅存本地数据库,不上传">
        <input
          className={styles.input}
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-…"
          autoComplete="off"
        />
      </Row>
      <Row label="启用" hint="停用后聊天选择器不再列出其模型">
        <label className={styles.switch}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span>{enabled ? "已启用" : "已停用"}</span>
        </label>
      </Row>

      <div className={styles.actions}>
        <button type="button" className={styles.btn} onClick={() => void onSave()} disabled={saving || (!dirty && !!provider)}>
          {saving ? "保存中…" : provider ? (dirty ? "保存修改" : "已保存") : "创建"}
        </button>
        {provider ? (
          <>
            <button type="button" className={styles.btn} onClick={() => void onTest()} disabled={testing}>
              {testing ? "测试中…" : "测试连接"}
            </button>
            <button type="button" className={`${styles.btn} ${styles.danger}`} onClick={() => void onDelete()}>
              删除提供商
            </button>
          </>
        ) : null}
      </div>

      {provider ? (
        <>
          {/* —— 默认模型 —— */}
          <div className={styles.divider} />
          <Row label="默认模型" hint="聊天输入框未临时切换时使用;可在聊天框内随时更换">
            <AiModelSelector
              value={defaultModel?.model.id ?? null}
              onChange={(id) => void onDefaultModelChange(id)}
              size={16}
            />
          </Row>

          {/* —— 模型列表 —— */}
          <div className={styles.divider} />
          <div className={styles.modelsHead}>
            <div className={styles.sectionTitle}>模型({providerModels.length})</div>
            <button type="button" className={styles.btn} onClick={() => void onSync()} disabled={syncing || !baseUrl.trim()}>
              {syncing ? "同步中…" : "同步模型"}
            </button>
          </div>
          <div className={styles.modelList}>
            {providerModels.length === 0 ? (
              <div className={styles.empty}>
                暂无模型:点「同步模型」从接口拉取,或在下方手动添加
              </div>
            ) : (
              providerModels.map((m) => (
                <ModelRow key={m.id} model={m} provider={provider} isDefault={defaultModel?.model.id === m.id} />
              ))
            )}
          </div>

          <div className={styles.manualAdd}>
            <input
              className={styles.input}
              value={manualModelId}
              onChange={(e) => setManualModelId(e.target.value)}
              placeholder="手动添加模型 id,如 gpt-4o-mini"
              onKeyDown={(e) => {
                if (e.key === "Enter") void onAddManualModel();
              }}
            />
            <button type="button" className={styles.btn} onClick={() => void onAddManualModel()} disabled={!manualModelId.trim()}>
              添加
            </button>
          </div>
        </>
      ) : (
        <div className={styles.empty}>保存后即可同步模型列表并设为默认</div>
      )}
    </div>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.row}>
      <div className={styles.rowLabel}>
        <span className={styles.rowName}>{label}</span>
        {hint ? <span className={styles.rowHint}>{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

/** 模型行 + 展开编辑(名称/能力/上下文)。 */
function ModelRow({
  model,
  provider,
  isDefault,
}: {
  model: AiModel;
  provider: AiProvider;
  isDefault: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [caps, setCaps] = useState<ModelCapability[]>([]);
  const [ctx, setCtx] = useState("");
  const upsertModel = useModelsStore((s) => s.upsertModel);
  const deleteModel = useModelsStore((s) => s.deleteModel);
  const setDefaultModel = useModelsStore((s) => s.setDefaultModel);

  const startEdit = () => {
    setName(model.name ?? "");
    setCaps(effectiveCapabilities(model.capabilities, model.model_id));
    setCtx(model.context_window?.toString() ?? "");
    setEditing(true);
  };

  // 启停/置顶/设默认：失败可见（基线模式：try/catch + toast.error）。
  async function onToggleEnabled(next: boolean) {
    try {
      await upsertModel({ ...model, enabled: next });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function onTogglePin() {
    try {
      await upsertModel({ ...model, pinned: !model.pinned });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function onSetDefault() {
    try {
      await setDefaultModel(model.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function onDeleteModel() {
    const ok = await useDialogStore.getState().confirm({
      title: "删除模型",
      message: `将删除模型「${modelDisplayName(model)}」（${model.model_id}），不可恢复。`,
      danger: true,
      confirmText: "删除",
    });
    if (!ok) return;
    try {
      await deleteModel(model.id);
      toast.success("已删除");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  const saveEdit = async () => {
    try {
      await upsertModel({
        ...model,
        name: name.trim() || null,
        capabilities: caps,
        context_window: ctx.trim() ? Number(ctx) || null : null,
      });
      setEditing(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const shownCaps = effectiveCapabilities(model.capabilities, model.model_id);

  return (
    <div className={`${styles.modelItem} ${model.hidden ? styles.modelHidden : ""}`}>
      <div className={styles.modelLine}>
        <AiEntityIcon
          modelId={model.model_id}
          providerId={provider.id}
          presetId={provider.preset_id ?? undefined}
          size={16}
        />
        <button
          type="button"
          className={`${styles.modelName} ${isDefault ? styles.modelDefault : ""}`}
          title={isDefault ? "当前默认模型,点击可查看" : "设为默认模型"}
          onClick={() => void onSetDefault()}
        >
          {modelDisplayName(model)}
          {isDefault ? <span className={styles.defaultBadge}>默认</span> : null}
        </button>
        <span className={styles.modelId} title={model.model_id}>
          {model.model_id}
        </span>
        <span className={styles.caps}>
          {shownCaps.map((c) => (
            <span key={c} className={styles.cap} title={CAPABILITY_LABELS[c]}>
              {c === "vision" ? "👁" : c === "reasoning" ? "🧠" : c === "tools" ? "🔧" : "𝐯"}
            </span>
          ))}
        </span>
        <label className={styles.switch} title={model.enabled ? "点击停用" : "点击启用"}>
          <input
            type="checkbox"
            checked={model.enabled}
            onChange={(e) => void onToggleEnabled(e.target.checked)}
          />
        </label>
        <button
          type="button"
          className={styles.miniBtn}
          title={model.pinned ? "取消置顶" : "置顶"}
          onClick={() => void onTogglePin()}
        >
          {model.pinned ? "★" : "☆"}
        </button>
        <button type="button" className={styles.miniBtn} title="编辑" onClick={editing ? () => setEditing(false) : startEdit}>
          ✏
        </button>
        <button
          type="button"
          className={`${styles.miniBtn} ${styles.dangerText}`}
          title="删除"
          onClick={() => void onDeleteModel()}
        >
          🗑
        </button>
      </div>

      {editing ? (
        <div className={styles.editBox}>
          <div className={styles.editRow}>
            <span className={styles.editLabel}>显示名</span>
            <input className={styles.input} value={name} onChange={(e) => setName(e.target.value)} placeholder={model.model_id} />
          </div>
          <div className={styles.editRow}>
            <span className={styles.editLabel}>能力</span>
            <div className={styles.capChecks}>
              {MODEL_CAPABILITIES.map((c) => (
                <label key={c} className={styles.capCheck}>
                  <input
                    type="checkbox"
                    checked={caps.includes(c)}
                    onChange={(e) =>
                      setCaps((prev) => (e.target.checked ? [...prev, c] : prev.filter((x) => x !== c)))
                    }
                  />
                  {CAPABILITY_LABELS[c]}
                </label>
              ))}
            </div>
          </div>
          <div className={styles.editRow}>
            <span className={styles.editLabel}>上下文窗口</span>
            <input
              className={styles.input}
              type="number"
              value={ctx}
              onChange={(e) => setCtx(e.target.value)}
              placeholder="如 128000"
            />
            <button type="button" className={styles.btn} onClick={() => void saveEdit()}>
              保存
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
