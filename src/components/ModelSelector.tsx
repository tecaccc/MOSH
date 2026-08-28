/**
 * AI 模型选择器(聊天工具条 / 设置页默认模型共用)。
 *
 * 交互(简化借鉴 Cherry Studio ModelSelector):搜索 + 置顶区 + 按提供商
 * 分组 + 能力点标 + 直达设置页管理。选中回调 UniqueModelId。
 */
import { AiEntityIcon, CAPABILITY_LABELS, effectiveCapabilities, type ModelCapability } from "../lib/aiIcons";
import type { AiModel, AiProvider } from "../lib/types";
import { useAppStore } from "../state/store";
import { modelDisplayName, selectChatModels, useModelsStore } from "../state/models";
import { toast } from "../state/toast";
import { useEffect, useMemo, useRef, useState } from "react";
import styles from "./ModelSelector.module.css";

const CAP_GLYPHS: Record<ModelCapability, string> = {
  vision: "👁",
  reasoning: "🧠",
  tools: "🔧",
  embedding: "_vectors_",
};

/** 能力点标行(模型行内联渲染)。 */
function CapabilityDots({ model }: { model: AiModel }) {
  const caps = effectiveCapabilities(model.capabilities, model.model_id);
  if (caps.length === 0) return null;
  return (
    <span className={styles.caps}>
      {caps.map((c) => (
        <span key={c} className={styles.cap} title={CAPABILITY_LABELS[c]}>
          {CAP_GLYPHS[c]}
        </span>
      ))}
    </span>
  );
}

export interface AiModelSelectorProps {
  /** 当前选中 UniqueModelId;null = 未选(显示「选择模型」)。 */
  value: string | null;
  onChange: (uniqueId: string) => void;
  /** 触发按钮里的图标尺寸。 */
  size?: number;
  /** 弹层锄向:"up" 向上弹(聊天工具条,输入框下方),"down" 向下弹(设置页)。 */
  placement?: "up" | "down";
  disabled?: boolean;
  /** 触发按钮额外类名(场景微调宽度/背景)。 */
  triggerClassName?: string;
}

export default function AiModelSelector({
  value,
  onChange,
  size = 18,
  placement = "down",
  disabled = false,
  triggerClassName = "",
}: AiModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const providers = useModelsStore((s) => s.providers);
  const models = useModelsStore((s) => s.models);
  const loaded = useModelsStore((s) => s.loaded);
  const load = useModelsStore((s) => s.load);
  const upsertModel = useModelsStore((s) => s.upsertModel);
  const openSettings = useAppStore((s) => s.openSettings);

  // 打开时确保数据新鲜(幂等;非 Tauri 环境静默置空)。
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  // 点外 / Esc 关闭。
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const selected = useMemo(
    () => models.find((m) => m.id === value),
    [models, value],
  );
  const selectedProvider = useMemo<AiProvider | undefined>(
    () => (selected ? providers.find((p) => p.id === selected.provider_id) : undefined),
    [providers, selected],
  );

  // 分组(置顶区独立于 provider 分组)。
  const groups = useMemo(() => selectChatModels(providers, models), [providers, models]);
  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!q) return groups;
    const match = (m: AiModel, p: AiProvider) =>
      m.model_id.toLowerCase().includes(q) ||
      (m.name ?? "").toLowerCase().includes(q) ||
      p.name.toLowerCase().includes(q);
    return groups
      .map((g) => ({ ...g, models: g.models.filter((m) => match(m, g.provider)) }))
      .filter((g) => g.models.length > 0);
  }, [groups, q]);
  const pinned = useMemo(
    () => (q ? [] : groups.flatMap((g) => g.models).filter((m) => m.pinned)),
    [groups, q],
  );
  const total = filtered.reduce((n, g) => n + g.models.length, 0);

  const pick = (m: AiModel) => {
    onChange(m.id);
    setOpen(false);
    setQuery("");
  };

  const togglePin = async (m: AiModel) => {
    try {
      await upsertModel({ ...m, pinned: !m.pinned });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const triggerLabel = selected
    ? `${modelDisplayName(selected)}${selectedProvider ? ` | ${selectedProvider.name}` : ""}`
    : "选择模型";

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        type="button"
        className={`${styles.trigger} ${triggerClassName}`}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        title={triggerLabel}
      >
        {selected ? (
          <AiEntityIcon
            modelId={selected.model_id}
            providerId={selected.provider_id}
            presetId={selectedProvider?.preset_id ?? undefined}
            size={size}
          />
        ) : null}
        <span className={styles.triggerLabel}>{triggerLabel}</span>
        <span className={styles.caret}>{open ? "▴" : "▾"}</span>
      </button>

      {open ? (
        <div className={`${styles.popover} ${placement === "up" ? styles.placeUp : ""}`} role="listbox">
          <input
            className={styles.search}
            type="text"
            value={query}
            placeholder="搜索模型 / 提供商…"
            onChange={(e) => setQuery(e.currentTarget.value)}
            autoFocus
          />

          <div className={styles.list}>
            {loaded && total === 0 ? (
              <div className={styles.empty}>
                {models.length === 0
                  ? "暂无模型:请先在设置中添加提供商并同步"
                  : "没有匹配的模型"}
              </div>
            ) : null}

            {pinned.length > 0 ? (
              <>
                <div className={styles.groupTitle}>📌 置顶</div>
                {pinned.map((m) => (
                  <Row
                    key={`pin-${m.id}`}
                    model={m}
                    provider={providers.find((p) => p.id === m.provider_id)}
                    selected={m.id === value}
                    onPick={() => pick(m)}
                    onTogglePin={() => void togglePin(m)}
                  />
                ))}
              </>
            ) : null}

            {filtered.map((g) => (
              <div key={g.provider.id}>
                <div className={styles.groupTitle} title={g.provider.name}>
                  <AiEntityIcon
                    providerId={g.provider.id}
                    presetId={g.provider.preset_id ?? undefined}
                    providerName={g.provider.name}
                    size={14}
                  />
                  <span className={styles.groupName}>{g.provider.name}</span>
                </div>
                {g.models.map((m) => (
                  <Row
                    key={m.id}
                    model={m}
                    provider={g.provider}
                    selected={m.id === value}
                    onPick={() => pick(m)}
                    onTogglePin={() => void togglePin(m)}
                  />
                ))}
              </div>
            ))}
          </div>

          <button
            type="button"
            className={styles.manage}
            onClick={() => {
              setOpen(false);
              openSettings("ai");
            }}
          >
            ⚙ 管理模型…
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Row({
  model,
  provider,
  selected,
  onPick,
  onTogglePin,
}: {
  model: AiModel;
  provider?: AiProvider;
  selected: boolean;
  onPick: () => void;
  onTogglePin: () => void;
}) {
  return (
    <div
      className={`${styles.row} ${selected ? styles.rowSelected : ""}`}
      role="option"
      aria-selected={selected}
      onClick={onPick}
    >
      <AiEntityIcon
        modelId={model.model_id}
        providerId={model.provider_id}
        presetId={provider?.preset_id ?? undefined}
        size={16}
      />
      <span className={styles.rowName} title={model.model_id}>
        {modelDisplayName(model)}
      </span>
      <CapabilityDots model={model} />
      <button
        type="button"
        className={`${styles.pinBtn} ${model.pinned ? styles.pinActive : ""}`}
        title={model.pinned ? "取消置顶" : "置顶"}
        onClick={(e) => {
          e.stopPropagation();
          onTogglePin();
        }}
      >
        {model.pinned ? "★" : "☆"}
      </button>
    </div>
  );
}
