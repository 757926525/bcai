import React, { useState } from 'react';
import { Database, Download, Image as ImageIcon } from 'lucide-react';
import { ORIGINAL_IMAGE_MODELS } from '../data/models';
import { ExternalProvider, GeneratedImageCard } from '../types';
import { formatDateTime, uid } from '../utils/format';

interface ImageWorkspaceProps {
  accessPassword?: string;
  workersAiProvider?: ExternalProvider;
  onSaveImageToDb: (card: GeneratedImageCard) => Promise<void>;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result || ''));
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export const ImageWorkspace: React.FC<ImageWorkspaceProps> = ({
  accessPassword,
  workersAiProvider,
  onSaveImageToDb,
}) => {
  const [prompt, setPrompt] = useState('');
  const [modelId, setModelId] = useState(ORIGINAL_IMAGE_MODELS[0].id);
  const [size, setSize] = useState('1024x1024');
  const [steps, setSteps] = useState(ORIGINAL_IMAGE_MODELS[0].defaultSteps);
  const [translate, setTranslate] = useState(true);
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
        finalPrompt: clean,
        modelId,
        url: '',
        createdAt: now,
        loading: true,
      },
      ...prev,
    ]);

    const [w, h] = size.split('x').map(Number);

    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (accessPassword) headers['x-access-password'] = encodeURIComponent(accessPassword);

      const res = await fetch('/api/image', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          prompt: clean,
          model: modelId,
          steps,
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

  const handleSaveDb = async (card: GeneratedImageCard) => {
    await onSaveImageToDb(card);
    setCards((prev) => prev.map((c) => (c.id === card.id ? { ...c, savedToDb: true } : c)));
  };

  return (
    <div className="flex-1 overflow-y-auto px-4 py-6">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Controls */}
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-4">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                handleGenerate();
              }
            }}
            placeholder="描述你想要的画面，例如：清晨薄雾里的山间茶园，柔和的侧逆光，胶片质感"
            className="w-full min-h-[88px] rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-3 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:border-blue-600"
          />

          <div className="flex flex-wrap items-end gap-4">
            <label className="flex flex-col gap-1 text-xs text-slate-500 dark:text-slate-400">
              <span>绘图模型（Workers AI 内置免费）</span>
              <select
                value={modelId}
                onChange={(e) => handleModelChange(e.target.value)}
                className="h-9 px-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 text-sm text-slate-900 dark:text-slate-100"
              >
                {ORIGINAL_IMAGE_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-xs text-slate-500 dark:text-slate-400">
              <span>分辨率尺寸</span>
              <select
                value={size}
                disabled={!selectedModel.supportsCustomSize}
                onChange={(e) => setSize(e.target.value)}
                className="h-9 px-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 text-sm text-slate-900 dark:text-slate-100 disabled:opacity-50"
              >
                <option value="1024x1024">1024 × 1024</option>
                <option value="768x1024">768 × 1024（竖）</option>
                <option value="1024x768">1024 × 768（横）</option>
                <option value="512x512">512 × 512</option>
              </select>
            </label>

            <label className="flex flex-col gap-1 text-xs text-slate-500 dark:text-slate-400 min-w-[130px]">
              <span className="tabular-nums">采样步数：{steps}</span>
              <input
                type="range"
                min={1}
                max={selectedModel.maxSteps}
                value={steps}
                onChange={(e) => setSteps(Number(e.target.value))}
                className="h-9 accent-blue-600"
              />
            </label>

            <label className="inline-flex items-center gap-2 h-9 text-sm text-slate-700 dark:text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={translate}
                onChange={(e) => setTranslate(e.target.checked)}
                className="rounded border-slate-300 accent-blue-600"
              />
              <span>中文提示词自动译为英文</span>
            </label>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <button
              type="button"
              onClick={handleGenerate}
              disabled={busy || !prompt.trim()}
              className="h-10 px-5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium inline-flex items-center gap-2 disabled:opacity-50"
            >
              <ImageIcon className="w-4 h-4" />
              <span>{busy ? '正在绘制…' : '生成图片'}</span>
            </button>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {selectedModel.supportsCustomSize
                ? '生成后可一键保存到 Cloudflare D1 / 本地数据库并记录生成时间。'
                : 'FLUX.1 schnell 使用固定尺寸 4 步极速出图；生成后可存入 D1 数据库。'}
            </p>
          </div>
        </div>

        {/* Gallery */}
        {cards.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {cards.map((c) => (
              <div
                key={c.id}
                className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden flex flex-col"
              >
                <div className="aspect-square bg-slate-100 dark:bg-slate-950 flex items-center justify-center overflow-hidden">
                  {c.loading ? (
                    <span className="text-xs text-slate-500">正在绘制画面…</span>
                  ) : c.error ? (
                    <div className="p-4 text-center text-xs text-red-600 dark:text-red-400">{c.error}</div>
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
                    <p className="text-slate-700 dark:text-slate-200 line-clamp-2" title={c.finalPrompt}>
                      {c.finalPrompt}
                    </p>
                    <p className="text-slate-400 dark:text-slate-500 mt-1 tabular-nums">
                      生成时间 {formatDateTime(c.createdAt)}
                    </p>
                  </div>
                  {!c.loading && !c.error && (
                    <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
                      <a
                        href={c.url}
                        download={`aimx-${Date.now()}.png`}
                        className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400 hover:underline font-medium"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>下载图片</span>
                      </a>
                      <button
                        type="button"
                        disabled={c.savedToDb}
                        onClick={() => handleSaveDb(c)}
                        className="inline-flex items-center gap-1 text-slate-700 dark:text-slate-300 hover:text-blue-600 disabled:text-emerald-600 font-medium"
                      >
                        <Database className="w-3.5 h-3.5" />
                        <span>{c.savedToDb ? '已入库' : '存至数据库'}</span>
                      </button>
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
