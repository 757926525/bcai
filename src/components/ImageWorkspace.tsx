import React, { useEffect, useMemo, useState } from 'react';
import {
  Check,
  Copy,
  Database,
  Dices,
  Download,
  HardDrive,
  Image as ImageIcon,
  Maximize2,
  Plus,
  RotateCcw,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import {
  DEFAULT_EXTERNAL_IMAGE_PROVIDERS,
  IMAGE_STYLE_PRESETS,
  ORIGINAL_IMAGE_MODELS,
} from '../data/models';
import {
  ExternalImageProvider,
  ExternalProvider,
  GeneratedImageCard,
  ImageProviderType,
} from '../types';
import { formatDateTime, loadLocalJson, saveLocalJson, uid } from '../utils/format';

interface ImageWorkspaceProps {
  isAdmin: boolean;
  bucketConnected: boolean;
  workersAiProvider?: ExternalProvider;
  onSaveImageToDb: (card: GeneratedImageCard, target?: 'db' | 'bucket') => Promise<void>;
}

const LS_IMG_PROVIDERS = 'bcai.imageProviders.v1';

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result || ''));
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

const NEGATIVE_PRESETS = [
  'low quality, blurry, watermark, text, deformed, bad anatomy',
  '模糊, 低分辨率, 水印, 文字, 多余手指, 畸形肢体, 过曝',
];

const QUICK_SIZES: Array<{ value: string; label: string }> = [
  { value: '1024x1024', label: '1:1 方图 (1024×1024)' },
  { value: '1280x720', label: '16:9 横屏壁纸 (1280×720)' },
  { value: '720x1280', label: '9:16 竖屏海报 (720×1280)' },
  { value: '1024x768', label: '4:3 标准横图 (1024×768)' },
  { value: '768x1024', label: '3:4 标准竖图 (768×1024)' },
  { value: '512x512', label: '1:1 极速预览 (512×512)' },
];

export const ImageWorkspace: React.FC<ImageWorkspaceProps> = ({
  isAdmin,
  bucketConnected,
  workersAiProvider,
  onSaveImageToDb,
}) => {
  const [prompt, setPrompt] = useState('');
  const [negativePrompt, setNegativePrompt] = useState('');
  const [modelId, setModelId] = useState(ORIGINAL_IMAGE_MODELS[0].id);
  const [stylePreset, setStylePreset] = useState<string>('none');
  const [enhanceMode, setEnhanceMode] = useState<'enhance' | 'translate' | 'none'>('enhance');
  const [size, setSize] = useState('1024x1024');
  const [steps, setSteps] = useState(ORIGINAL_IMAGE_MODELS[0].defaultSteps);
  const [guidance, setGuidance] = useState(7.5);
  const [seed, setSeed] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(true);
  const [showExternalPanel, setShowExternalPanel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cards, setCards] = useState<GeneratedImageCard[]>([]);
  const [lightboxCard, setLightboxCard] = useState<GeneratedImageCard | null>(null);
  const [copiedPromptId, setCopiedPromptId] = useState<string | null>(null);

  const [externalImageProviders, setExternalImageProviders] = useState<ExternalImageProvider[]>(() => {
    const saved = loadLocalJson<ExternalImageProvider[]>(LS_IMG_PROVIDERS, []);
    return saved.length > 0 ? saved : DEFAULT_EXTERNAL_IMAGE_PROVIDERS;
  });

  useEffect(() => {
    saveLocalJson(LS_IMG_PROVIDERS, externalImageProviders);
  }, [externalImageProviders]);

  // Combined model options (built-in Pollinations zero-key + CF Workers AI + external endpoints)
  const externalModelOptions = useMemo(
    () =>
      externalImageProviders
        .filter((p) => p.enabled && p.modelId.trim())
        .map((p) => ({
          id: `ext:${p.id}::${p.modelId}`,
          rawModelId: p.modelId,
          provider: p,
          name: `${p.name} · ${p.modelId}`,
          providerType: p.providerType,
          defaultSteps: p.providerType === 'siliconflow' ? 20 : 24,
          maxSteps: 40,
          supportsCustomSize: true,
          supportsNegativePrompt: true,
          supportsGuidance: p.providerType !== 'openai-image',
          requiresKey: true,
          quotaSummary: p.apiKey ? '外接凭证已填写 · 直接可用' : '需在上方「外接绘图 API 配置」中填写免费 Key',
        })),
    [externalImageProviders]
  );

  const builtinPollinations = useMemo(
    () => ORIGINAL_IMAGE_MODELS.filter((m) => m.providerType === 'pollinations'),
    []
  );
  const builtinWorkers = useMemo(
    () => ORIGINAL_IMAGE_MODELS.filter((m) => m.providerType === 'workers-ai'),
    []
  );

  const selectedBuiltin = ORIGINAL_IMAGE_MODELS.find((m) => m.id === modelId);
  const selectedExternal = externalModelOptions.find((m) => m.id === modelId);
  const selectedMeta = selectedExternal || selectedBuiltin || ORIGINAL_IMAGE_MODELS[0];

  const handleModelChange = (id: string) => {
    setModelId(id);
    const b = ORIGINAL_IMAGE_MODELS.find((x) => x.id === id);
    if (b) {
      setSteps(b.defaultSteps);
      return;
    }
    const ext = externalModelOptions.find((x) => x.id === id);
    if (ext) {
      setSteps(ext.defaultSteps);
    }
  };

  const handleUpdateExternalProvider = (id: string, patch: Partial<ExternalImageProvider>) => {
    setExternalImageProviders((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  };

  const handleAddExternalProvider = () => {
    const next: ExternalImageProvider = {
      id: `img-custom-${uid()}`,
      name: '自定义绘图接口',
      providerType: 'openai-image',
      baseUrl: 'https://api.openai.com/v1/images/generations',
      apiKey: '',
      modelId: 'dall-e-3',
      enabled: true,
    };
    setExternalImageProviders((prev) => [...prev, next]);
  };

  const handleDeleteExternalProvider = (id: string) => {
    setExternalImageProviders((prev) => prev.filter((p) => p.id !== id));
    if (selectedExternal?.provider.id === id) {
      setModelId(ORIGINAL_IMAGE_MODELS[0].id);
    }
  };

  const handleGenerate = async () => {
    const clean = prompt.trim();
    if (!clean || busy) return;

    const extProvider = selectedExternal?.provider;
    if (extProvider && !extProvider.apiKey.trim()) {
      setShowExternalPanel(true);
    }

    setBusy(true);
    const cardId = uid();
    const now = new Date().toISOString();
    const effectiveModelName = extProvider ? selectedExternal.rawModelId : selectedMeta.id;
    const effectiveProviderType: ImageProviderType = extProvider
      ? extProvider.providerType
      : selectedMeta.providerType;

    setCards((prev) => [
      {
        id: cardId,
        prompt: clean,
        negativePrompt: negativePrompt.trim(),
        finalPrompt: clean,
        modelId,
        providerType: effectiveProviderType,
        stylePreset,
        size,
        guidance,
        seed: seed.trim() || undefined,
        url: '',
        createdAt: now,
        loading: true,
      },
      ...prev,
    ]);

    const [w, h] = size.split('x').map(Number);

    try {
      const res = await fetch('/api/image', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: clean,
          negativePrompt: negativePrompt.trim(),
          model: effectiveModelName,
          providerType: effectiveProviderType,
          baseUrl: extProvider?.baseUrl,
          stylePreset,
          enhanceMode,
          translate: enhanceMode !== 'none',
          steps,
          guidance,
          seed: seed.trim() ? Number(seed.trim()) : undefined,
          width: w,
          height: h,
          accountId: !extProvider && workersAiProvider?.source === 'custom' ? workersAiProvider.accountId : undefined,
          apiKey: extProvider
            ? extProvider.apiKey.trim()
            : workersAiProvider?.source === 'custom'
            ? workersAiProvider.apiKey
            : undefined,
        }),
      });

      if (!res.ok) {
        let msg = `生成失败 (HTTP ${res.status})`;
        try {
          const j = await res.json();
          if (j?.error) msg = j.error;
        } catch {
          // ignore
        }
        throw new Error(msg);
      }

      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      const dataUrl = await blobToDataUrl(blob);
      let finalPrompt = clean;
      let finalNegative = negativePrompt.trim();
      try {
        finalPrompt = decodeURIComponent(res.headers.get('x-final-prompt') || clean);
        const negHdr = res.headers.get('x-final-negative');
        if (negHdr) finalNegative = decodeURIComponent(negHdr);
      } catch {
        // keep clean
      }

      setCards((prev) =>
        prev.map((c) =>
          c.id === cardId
            ? {
                ...c,
                url: objUrl,
                dataUrl,
                finalPrompt,
                negativePrompt: finalNegative,
                loading: false,
              }
            : c
        )
      );
    } catch (err: any) {
      setCards((prev) =>
        prev.map((c) =>
          c.id === cardId
            ? {
                ...c,
                loading: false,
                error: err?.message || '图像生成失败',
              }
            : c
        )
      );
    } finally {
      setBusy(false);
    }
  };

  const handleRemixCard = (c: GeneratedImageCard) => {
    setPrompt(c.prompt);
    setNegativePrompt(c.negativePrompt || '');
    if (c.modelId) handleModelChange(c.modelId);
    if (c.stylePreset) setStylePreset(c.stylePreset);
    if (c.size) setSize(c.size);
    if (typeof c.guidance === 'number') setGuidance(c.guidance);
    if (c.seed) setSeed(c.seed);
  };

  const handleSave = async (card: GeneratedImageCard, target: 'db' | 'bucket') => {
    await onSaveImageToDb(card, target);
    setCards((prev) =>
      prev.map((c) =>
        c.id === card.id
          ? {
              ...c,
              savedToDb: target === 'db' ? true : c.savedToDb,
              savedToBucket: target === 'bucket' ? true : c.savedToBucket,
            }
          : c
      )
    );
  };

  const handleCopyPrompt = (id: string, text: string) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopiedPromptId(id);
      setTimeout(() => setCopiedPromptId(null), 1500);
    });
  };

  return (
    <div className="flex-1 overflow-y-auto px-3 sm:px-5 py-4 sm:py-6">
      <div className="max-w-5xl mx-auto space-y-5">
        {/* Prompt & Negative Prompt & Settings Card */}
        <div className="rounded-xl border wb-border wb-panel p-3.5 sm:p-5 space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-3.5">
            {/* Positive Prompt */}
            <div className="lg:col-span-7 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <label className="text-xs font-semibold wb-ink">正向画面描述词（Prompt）</label>
                <span className="text-[11px] wb-muted">支持中文输入，自动英文摄影/插画精度增强</span>
              </div>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    handleGenerate();
                  }
                }}
                placeholder="描述你想要的画面，例如：清晨薄雾里的山间茶园，柔和的侧逆光，电影级光影质感"
                className="w-full min-h-[104px] rounded-lg border wb-border wb-bg p-3 text-sm wb-ink placeholder:opacity-50 focus:outline-none"
              />
            </div>

            {/* Negative Prompt */}
            <div className="lg:col-span-5 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <label className="text-xs font-semibold wb-ink">负向提示词（Negative Prompt · 排除元素）</label>
                <button
                  type="button"
                  onClick={() =>
                    setNegativePrompt((prev) => (prev ? `${prev}, ${NEGATIVE_PRESETS[0]}` : NEGATIVE_PRESETS[0]))
                  }
                  className="text-[11px] wb-accent-text hover:underline whitespace-nowrap"
                >
                  填入常用排除词
                </button>
              </div>
              <textarea
                value={negativePrompt}
                onChange={(e) => setNegativePrompt(e.target.value)}
                placeholder="输入不希望画面出现的元素（如：模糊, 水印, 文字, 多余手指, 畸形...）"
                className="w-full min-h-[104px] rounded-lg border wb-border wb-bg p-3 text-sm wb-ink placeholder:opacity-50 focus:outline-none"
              />
            </div>
          </div>

          {/* Toolbar Row: Drawing Params + AI Enhancement + External Image Endpoints */}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t wb-border">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                className="h-9 px-2.5 rounded-lg border wb-border text-xs font-medium wb-ink hover:opacity-80 inline-flex items-center gap-1.5"
              >
                <SlidersHorizontal className="w-3.5 h-3.5" />
                <span>{showAdvanced ? '收起参数区' : '展开参数区'}</span>
              </button>

              <button
                type="button"
                onClick={() => setShowExternalPanel((v) => !v)}
                className={`h-9 px-2.5 rounded-lg border text-xs font-medium inline-flex items-center gap-1.5 ${
                  showExternalPanel ? 'border-blue-600 wb-tint wb-accent-text' : 'wb-border wb-ink hover:opacity-80'
                }`}
              >
                <Settings2 className="w-3.5 h-3.5" />
                <span>外接免费绘图 API ({externalImageProviders.filter((p) => p.apiKey.trim()).length}/{externalImageProviders.length})</span>
              </button>
            </div>

            <div className="flex items-center gap-2 text-xs">
              <span className="wb-muted inline-flex items-center gap-1">
                <Sparkles className="w-3.5 h-3.5 wb-accent-text" />
                <span>AI 精准提示词优化：</span>
              </span>
              <select
                value={enhanceMode}
                onChange={(e) => setEnhanceMode(e.target.value as 'enhance' | 'translate' | 'none')}
                className="h-9 px-2.5 rounded-lg border wb-border wb-bg text-xs wb-ink"
              >
                <option value="enhance">AI 智能润色扩展 + 英文精度翻译（推荐）</option>
                <option value="translate">仅忠实直译英文（不增改细节）</option>
                <option value="none">关闭（原词直传引擎）</option>
              </select>
            </div>
          </div>

          {/* External Image Providers Management Panel */}
          {showExternalPanel && (
            <div className="rounded-xl border border-blue-200 dark:border-blue-900/70 wb-bg p-3.5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-xs font-semibold wb-ink">外接免费 / 兼容绘图 AI 端点配置</div>
                  <p className="text-[11px] wb-muted mt-0.5">
                    内置 Pollinations FLUX 系列免 Key 开箱即用；也可在此填写硅基流动 Kolors（免费中文绘图）、Hugging Face FLUX.1-dev 或 Together/OpenAI 兼容接口密钥，保存后自动加入下方模型选区。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleAddExternalProvider}
                  className="h-8 px-2.5 rounded-lg wb-accent text-xs font-medium inline-flex items-center gap-1 shrink-0"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>添加接口</span>
                </button>
              </div>

              <div className="space-y-2.5">
                {externalImageProviders.map((ep) => (
                  <div
                    key={ep.id}
                    className="rounded-lg border wb-border wb-panel p-2.5 grid grid-cols-1 md:grid-cols-12 gap-2 items-center text-xs"
                  >
                    <div className="md:col-span-3 flex items-center gap-2 min-w-0">
                      <input
                        type="checkbox"
                        checked={ep.enabled}
                        onChange={(e) => handleUpdateExternalProvider(ep.id, { enabled: e.target.checked })}
                        className="accent-blue-600 shrink-0"
                      />
                      <input
                        type="text"
                        value={ep.name}
                        onChange={(e) => handleUpdateExternalProvider(ep.id, { name: e.target.value })}
                        placeholder="渠道名称"
                        className="w-full h-8 px-2 rounded border wb-border wb-bg wb-ink font-medium"
                      />
                    </div>
                    <select
                      value={ep.providerType}
                      onChange={(e) =>
                        handleUpdateExternalProvider(ep.id, {
                          providerType: e.target.value as ExternalImageProvider['providerType'],
                        })
                      }
                      className="md:col-span-2 h-8 px-2 rounded border wb-border wb-bg wb-ink"
                    >
                      <option value="siliconflow">硅基流动 SiliconFlow</option>
                      <option value="huggingface">Hugging Face</option>
                      <option value="openai-image">OpenAI Images 兼容</option>
                    </select>
                    <input
                      type="text"
                      value={ep.modelId}
                      onChange={(e) => handleUpdateExternalProvider(ep.id, { modelId: e.target.value })}
                      placeholder="模型 ID"
                      className="md:col-span-2 h-8 px-2 rounded border wb-border wb-bg font-mono wb-ink"
                    />
                    <input
                      type="text"
                      value={ep.baseUrl}
                      onChange={(e) => handleUpdateExternalProvider(ep.id, { baseUrl: e.target.value })}
                      placeholder="接口 Base URL"
                      className="md:col-span-2 h-8 px-2 rounded border wb-border wb-bg font-mono wb-ink"
                    />
                    <div className="md:col-span-3 flex items-center gap-1.5">
                      <input
                        type="password"
                        value={ep.apiKey}
                        onChange={(e) => handleUpdateExternalProvider(ep.id, { apiKey: e.target.value })}
                        placeholder="输入免费 Token / API Key"
                        className="flex-1 min-w-0 h-8 px-2 rounded border wb-border wb-bg font-mono wb-ink"
                      />
                      {ep.id.startsWith('img-custom-') && (
                        <button
                          type="button"
                          onClick={() => handleDeleteExternalProvider(ep.id)}
                          className="w-8 h-8 rounded border wb-border flex items-center justify-center wb-muted hover:text-red-600 shrink-0"
                          title="删除"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Settings Zone */}
          {showAdvanced && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3 p-3 rounded-lg wb-bg border wb-border">
              <label className="sm:col-span-2 flex flex-col gap-1 text-xs wb-muted">
                <span>绘图 AI 引擎与模型</span>
                <select
                  value={modelId}
                  onChange={(e) => handleModelChange(e.target.value)}
                  className="h-10 px-2.5 rounded-lg border wb-border wb-panel text-xs sm:text-sm wb-ink"
                >
                  <optgroup label="内置免 Key 免费引擎（无需密钥 · 即开即用）">
                    {builtinPollinations.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Cloudflare Workers AI 免费绘图（需配置 CF 凭证或 Pages env.AI）">
                    {builtinWorkers.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </optgroup>
                  {externalModelOptions.length > 0 && (
                    <optgroup label="外接免费 / 兼容绘图接口">
                      {externalModelOptions.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </label>

              <label className="flex flex-col gap-1 text-xs wb-muted">
                <span>画面风格预设</span>
                <select
                  value={stylePreset}
                  onChange={(e) => setStylePreset(e.target.value)}
                  className="h-10 px-2.5 rounded-lg border wb-border wb-panel text-xs sm:text-sm wb-ink"
                >
                  {IMAGE_STYLE_PRESETS.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex flex-col gap-1 text-xs wb-muted">
                <span>画幅比例与分辨率</span>
                <select
                  value={size}
                  disabled={!selectedMeta.supportsCustomSize}
                  onChange={(e) => setSize(e.target.value)}
                  className="h-10 px-2.5 rounded-lg border wb-border wb-panel text-xs sm:text-sm wb-ink disabled:opacity-50"
                >
                  {QUICK_SIZES.map((sz) => (
                    <option key={sz.value} value={sz.value}>
                      {sz.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex flex-col gap-1 text-xs wb-muted">
                <span className="tabular-nums">
                  {selectedMeta.supportsGuidance ? `步数 ${steps} · CFG ${guidance.toFixed(1)}` : `采样步数 Steps：${steps}`}
                </span>
                <div className="flex items-center gap-2 h-10">
                  <input
                    type="range"
                    min={1}
                    max={selectedMeta.maxSteps}
                    value={steps}
                    onChange={(e) => setSteps(Number(e.target.value))}
                    className="flex-1 accent-blue-600"
                    title={`采样步数: ${steps}`}
                  />
                  {selectedMeta.supportsGuidance && (
                    <input
                      type="number"
                      min={1}
                      max={20}
                      step={0.5}
                      value={guidance}
                      onChange={(e) => setGuidance(Number(e.target.value))}
                      className="w-14 h-9 px-1.5 rounded-lg border wb-border wb-panel text-xs font-mono wb-ink text-center"
                      title="引导系数 CFG"
                    />
                  )}
                </div>
              </label>

              <div className="flex flex-col gap-1 text-xs wb-muted">
                <span>随机种子 Seed（留空随机）</span>
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={seed}
                    onChange={(e) => setSeed(e.target.value.replace(/[^\d]/g, ''))}
                    placeholder="随机"
                    className="flex-1 min-w-0 h-10 px-2.5 rounded-lg border wb-border wb-panel text-xs font-mono wb-ink"
                  />
                  <button
                    type="button"
                    onClick={() => setSeed(String(Math.floor(Math.random() * 99999999)))}
                    className="w-10 h-10 rounded-lg border wb-border wb-panel flex items-center justify-center hover:opacity-80 shrink-0"
                    title="生成随机 Seed"
                  >
                    <Dices className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <button
              type="button"
              onClick={handleGenerate}
              disabled={busy || !prompt.trim()}
              className="h-11 px-5 rounded-lg wb-accent text-sm font-medium inline-flex items-center gap-2 disabled:opacity-50 whitespace-nowrap"
            >
              <ImageIcon className="w-4 h-4" />
              <span>{busy ? '正在高质量绘制…' : '立即生成图像'}</span>
            </button>
            <p className="text-xs wb-muted leading-relaxed">
              {selectedMeta.quotaSummary} · 支持 Ctrl+Enter 快捷生成
            </p>
          </div>
        </div>

        {/* Gallery */}
        {cards.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {cards.map((c) => (
              <div
                key={c.id}
                className="rounded-xl border wb-border wb-panel overflow-hidden flex flex-col"
              >
                <div className="aspect-square wb-code flex items-center justify-center overflow-hidden relative group">
                  {c.loading ? (
                    <div className="flex flex-col items-center gap-2 text-xs wb-muted">
                      <span className="w-5 h-5 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
                      <span>正在优化描述词并绘制画面…</span>
                    </div>
                  ) : c.error ? (
                    <div className="p-4 text-center text-xs text-red-600 dark:text-red-400 break-words">{c.error}</div>
                  ) : (
                    <>
                      <img
                        src={c.url}
                        alt={c.finalPrompt}
                        referrerPolicy="no-referrer"
                        onClick={() => setLightboxCard(c)}
                        className="w-full h-full object-cover cursor-zoom-in transition-transform duration-200 group-hover:scale-[1.02]"
                      />
                      <button
                        type="button"
                        onClick={() => setLightboxCard(c)}
                        className="absolute top-2 right-2 w-8 h-8 rounded-lg bg-slate-950/65 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                        title="大图高清查看"
                      >
                        <Maximize2 className="w-3.5 h-3.5" />
                      </button>
                    </>
                  )}
                </div>
                <div className="p-3 space-y-2 text-xs flex-1 flex flex-col justify-between">
                  <div>
                    <p className="wb-ink line-clamp-2" title={c.finalPrompt}>
                      {c.finalPrompt}
                    </p>
                    {c.negativePrompt && (
                      <p className="wb-muted text-[11px] line-clamp-1 mt-0.5">
                        负向词: {c.negativePrompt}
                      </p>
                    )}
                    <p className="wb-muted mt-1 tabular-nums text-[11px]">
                      {formatDateTime(c.createdAt)}
                      {c.size ? ` · ${c.size}` : ''}
                      {c.seed ? ` · Seed ${c.seed}` : ''}
                    </p>
                  </div>
                  {!c.loading && !c.error && (
                    <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t wb-border">
                      <div className="flex items-center gap-2.5">
                        <a
                          href={c.url}
                          download={`bcai-${Date.now()}.png`}
                          className="inline-flex items-center gap-1 wb-accent-text hover:underline font-medium min-h-[32px]"
                        >
                          <Download className="w-3.5 h-3.5" />
                          <span>下载</span>
                        </a>
                        <button
                          type="button"
                          onClick={() => handleRemixCard(c)}
                          className="inline-flex items-center gap-1 wb-ink hover:wb-accent-text font-medium min-h-[32px]"
                          title="把该图的提示词、模型、风格、比例与 Seed 一键填回上方参数区"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                          <span>复用重绘</span>
                        </button>
                      </div>
                      {isAdmin && (
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            disabled={c.savedToDb}
                            onClick={() => handleSave(c, 'db')}
                            className="inline-flex items-center gap-1 wb-ink hover:wb-accent-text disabled:text-emerald-600 font-medium min-h-[32px]"
                          >
                            <Database className="w-3.5 h-3.5" />
                            <span>{c.savedToDb ? '已存D1' : '存库'}</span>
                          </button>
                          {bucketConnected && (
                            <button
                              type="button"
                              disabled={c.savedToBucket}
                              onClick={() => handleSave(c, 'bucket')}
                              className="inline-flex items-center gap-1 wb-ink hover:wb-accent-text disabled:text-emerald-600 font-medium min-h-[32px]"
                            >
                              <HardDrive className="w-3.5 h-3.5" />
                              <span>{c.savedToBucket ? '已存桶' : '存桶'}</span>
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* High-res Lightbox Modal */}
      {lightboxCard && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-3 sm:p-6"
          onClick={() => setLightboxCard(null)}
        >
          <div
            className="w-full max-w-4xl max-h-[92vh] rounded-2xl border wb-border wb-panel shadow-2xl overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b wb-border">
              <div className="text-xs sm:text-sm font-semibold wb-ink truncate">
                高清图像详情 · {lightboxCard.modelId} {lightboxCard.size ? `(${lightboxCard.size})` : ''}
              </div>
              <button
                type="button"
                onClick={() => setLightboxCard(null)}
                className="w-8 h-8 rounded-lg flex items-center justify-center wb-muted hover:bg-black/5 dark:hover:bg-white/5"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-auto bg-slate-900/90 flex items-center justify-center p-3">
              <img
                src={lightboxCard.url}
                alt={lightboxCard.finalPrompt}
                className="max-w-full max-h-[64vh] object-contain rounded-lg shadow-lg"
              />
            </div>
            <div className="p-4 border-t wb-border space-y-2 text-xs">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <div className="wb-muted font-medium">最终生效提示词：</div>
                  <div className="wb-ink font-mono break-words">{lightboxCard.finalPrompt}</div>
                  {lightboxCard.negativePrompt && (
                    <div className="wb-muted font-mono break-words">负向词：{lightboxCard.negativePrompt}</div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => handleCopyPrompt(lightboxCard.id, lightboxCard.finalPrompt)}
                  className="h-8 px-3 rounded-lg border wb-border wb-ink inline-flex items-center gap-1 shrink-0"
                >
                  {copiedPromptId === lightboxCard.id ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedPromptId === lightboxCard.id ? '已复制' : '复制提示词'}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
