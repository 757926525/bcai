import React, { useState } from 'react';
import { Database, Dices, Download, HardDrive, Image as ImageIcon, SlidersHorizontal } from 'lucide-react';
import { ORIGINAL_IMAGE_MODELS } from '../data/models';
import { ExternalProvider, GeneratedImageCard } from '../types';
import { formatDateTime, uid } from '../utils/format';

interface ImageWorkspaceProps {
  isAdmin: boolean;
  bucketConnected: boolean;
  workersAiProvider?: ExternalProvider;
  onSaveImageToDb: (card: GeneratedImageCard, target?: 'db' | 'bucket') => Promise<void>;
}

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

export const ImageWorkspace: React.FC<ImageWorkspaceProps> = ({
  isAdmin,
  bucketConnected,
  workersAiProvider,
  onSaveImageToDb,
}) => {
  const [prompt, setPrompt] = useState('');
  const [negativePrompt, setNegativePrompt] = useState('');
  const [modelId, setModelId] = useState(ORIGINAL_IMAGE_MODELS[0].id);
  const [size, setSize] = useState('1024x1024');
  const [steps, setSteps] = useState(ORIGINAL_IMAGE_MODELS[0].defaultSteps);
  const [guidance, setGuidance] = useState(7.5);
  const [seed, setSeed] = useState('');
  const [translate, setTranslate] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(true);
  const [busy, setBusy] = useState(false);
  const [cards, setCards] = useState<GeneratedImageCard[]>([]);

  const selectedModel = ORIGINAL_IMAGE_MODELS.find((m) => m.id === modelId) || ORIGINAL_IMAGE_MODELS[0];

  const handleModelChange = (id: string) => {
    setModelId(id);
    const m = ORIGINAL_IMAGE_MODELS.find((x) => x.id === id);
    if (m) setSteps(m.defaultSteps);
  };

  const handleGenerate = async () => {
    const clean = prompt.trim();
    if (!clean || busy) return;
    setBusy(true);
    const cardId = uid();
    const now = new Date().toISOString();
    setCards((prev) => [
      {
        id: cardId,
        prompt: clean,
        negativePrompt: negativePrompt.trim(),
        finalPrompt: clean,
        modelId,
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
          model: modelId,
          steps,
          guidance,
          seed: seed.trim() ? Number(seed.trim()) : undefined,
          width: w,
          height: h,
          translate,
          accountId: workersAiProvider?.source === 'custom' ? workersAiProvider.accountId : undefined,
          apiKey: workersAiProvider?.source === 'custom' ? workersAiProvider.apiKey : undefined,
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
      try {
        finalPrompt = decodeURIComponent(res.headers.get('x-final-prompt') || clean);
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

  return (
    <div className="flex-1 overflow-y-auto px-3 sm:px-5 py-4 sm:py-6">
      <div className="max-w-5xl mx-auto space-y-5">
        {/* Prompt & Negative Prompt & Settings Card */}
        <div className="rounded-xl border wb-border wb-panel p-3.5 sm:p-5 space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-3.5">
            {/* Positive Prompt */}
            <div className="lg:col-span-7 space-y-1.5">
              <label className="text-xs font-semibold wb-ink block">正向画面描述词（Prompt）</label>
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
                placeholder="输入不希望画面出现的元素（如：模糊, 水印, 文字, 多余手指, 畸形...；SDXL/DreamShaper 模型生效）"
                className="w-full min-h-[104px] rounded-lg border wb-border wb-bg p-3 text-sm wb-ink placeholder:opacity-50 focus:outline-none"
              />
            </div>
          </div>

          {/* Toggle Drawing Settings Header */}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t wb-border">
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="h-9 px-2.5 rounded-lg text-xs font-medium wb-muted hover:wb-ink inline-flex items-center gap-1.5"
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              <span>{showAdvanced ? '收起绘图参数设置区' : '展开绘图参数设置区'}</span>
            </button>

            <label className="inline-flex items-center gap-2 min-h-[36px] text-xs sm:text-sm wb-ink cursor-pointer">
              <input
                type="checkbox"
                checked={translate}
                onChange={(e) => setTranslate(e.target.checked)}
                className="rounded accent-blue-600"
              />
              <span>中英自动翻译正/负向提示词</span>
            </label>
          </div>

          {/* Settings Zone */}
          {showAdvanced && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 p-3 rounded-lg wb-bg border wb-border">
              <label className="flex flex-col gap-1 text-xs wb-muted">
                <span>绘图模型（Workers AI 免费）</span>
                <select
                  value={modelId}
                  onChange={(e) => handleModelChange(e.target.value)}
                  className="h-10 px-2.5 rounded-lg border wb-border wb-panel text-xs sm:text-sm wb-ink"
                >
                  {ORIGINAL_IMAGE_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex flex-col gap-1 text-xs wb-muted">
                <span>分辨率尺寸</span>
                <select
                  value={size}
                  disabled={!selectedModel.supportsCustomSize}
                  onChange={(e) => setSize(e.target.value)}
                  className="h-10 px-2.5 rounded-lg border wb-border wb-panel text-xs sm:text-sm wb-ink disabled:opacity-50"
                >
                  <option value="1024x1024">1024 × 1024（方）</option>
                  <option value="768x1024">768 × 1024（竖）</option>
                  <option value="1024x768">1024 × 768（横）</option>
                  <option value="512x512">512 × 512（快）</option>
                </select>
              </label>

              <label className="flex flex-col gap-1 text-xs wb-muted">
                <span className="tabular-nums">采样步数 Steps：{steps}</span>
                <input
                  type="range"
                  min={1}
                  max={selectedModel.maxSteps}
                  value={steps}
                  onChange={(e) => setSteps(Number(e.target.value))}
                  className="h-10 accent-blue-600"
                />
              </label>

              <label className="flex flex-col gap-1 text-xs wb-muted">
                <span className="tabular-nums">
                  引导系数 CFG：{guidance.toFixed(1)}
                  {!selectedModel.supportsNegativePrompt ? ' (SDXL生效)' : ''}
                </span>
                <input
                  type="range"
                  min={1}
                  max={20}
                  step={0.5}
                  disabled={!selectedModel.supportsNegativePrompt}
                  value={guidance}
                  onChange={(e) => setGuidance(Number(e.target.value))}
                  className="h-10 accent-blue-600 disabled:opacity-40"
                />
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
              <span>{busy ? '正在绘制…' : '立即生成图像'}</span>
            </button>
            <p className="text-xs wb-muted leading-relaxed">
              {selectedModel.supportsNegativePrompt
                ? '当前模型完整支持负向提示词、自定义宽高与 CFG 引导系数；支持 Ctrl+Enter 快捷生成。'
                : 'FLUX.1 schnell 极速 4 步出图；如需负向提示词与尺寸控制，可切换 SDXL 1.0 / SDXL Lightning。'}
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
                <div className="aspect-square wb-code flex items-center justify-center overflow-hidden">
                  {c.loading ? (
                    <span className="text-xs wb-muted">正在绘制画面…</span>
                  ) : c.error ? (
                    <div className="p-4 text-center text-xs text-red-600 dark:text-red-400 break-words">{c.error}</div>
                  ) : (
                    <img
                      src={c.url}
                      alt={c.finalPrompt}
                      referrerPolicy="no-referrer"
                      className="w-full h-full object-cover"
                    />
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
                      生成时间 {formatDateTime(c.createdAt)}
                      {c.seed ? ` · Seed ${c.seed}` : ''}
                    </p>
                  </div>
                  {!c.loading && !c.error && (
                    <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t wb-border">
                      <a
                        href={c.url}
                        download={`bcai-${Date.now()}.png`}
                        className="inline-flex items-center gap-1 wb-accent-text hover:underline font-medium min-h-[32px]"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>下载图</span>
                      </a>
                      {isAdmin && (
                        <div className="flex items-center gap-2.5">
                          <button
                            type="button"
                            disabled={c.savedToDb}
                            onClick={() => handleSave(c, 'db')}
                            className="inline-flex items-center gap-1 wb-ink hover:wb-accent-text disabled:text-emerald-600 font-medium min-h-[32px]"
                          >
                            <Database className="w-3.5 h-3.5" />
                            <span>{c.savedToDb ? '已存D1' : '存数据库'}</span>
                          </button>
                          {bucketConnected && (
                            <button
                              type="button"
                              disabled={c.savedToBucket}
                              onClick={() => handleSave(c, 'bucket')}
                              className="inline-flex items-center gap-1 wb-ink hover:wb-accent-text disabled:text-emerald-600 font-medium min-h-[32px]"
                            >
                              <HardDrive className="w-3.5 h-3.5" />
                              <span>{c.savedToBucket ? '已存桶' : '存存储桶'}</span>
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
    </div>
  );
};
