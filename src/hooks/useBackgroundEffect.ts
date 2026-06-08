import { useRef, useCallback, useEffect, useState } from 'react';

export type BackgroundMode = 'none' | 'blur' | 'blur-heavy' | 'color-dark' | 'color-space';

interface BackgroundEffect {
  mode: BackgroundMode;
  processedStream: MediaStream | null;
  setMode: (mode: BackgroundMode) => void;
  startProcessing: (sourceStream: MediaStream) => void;
  stopProcessing: () => void;
}

const COLOR_MAP: Record<string, string> = {
  'color-dark': '#1a1a2e',
  'color-space': 'linear-gradient(135deg, #0f0c29, #302b63, #24243e)',
};

export function useBackgroundEffect(): BackgroundEffect {
  const [mode, setModeState] = useState<BackgroundMode>('none');
  const [processedStream, setProcessedStream] = useState<MediaStream | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const offscreenRef = useRef<HTMLCanvasElement | null>(null);
  const sourceVideoRef = useRef<HTMLVideoElement | null>(null);
  const animFrameRef = useRef<number>(0);
  const segmentationRef = useRef<unknown>(null);
  const activeSourceRef = useRef<MediaStream | null>(null);
  const modeRef = useRef<BackgroundMode>('none');

  useEffect(() => { modeRef.current = mode; }, [mode]);

  const stopProcessing = useCallback(() => {
    cancelAnimationFrame(animFrameRef.current);
    if (sourceVideoRef.current) {
      sourceVideoRef.current.srcObject = null;
      sourceVideoRef.current = null;
    }
    setProcessedStream(null);
    activeSourceRef.current = null;
  }, []);

  const renderFrame = useCallback(() => {
    const canvas = canvasRef.current;
    const video = sourceVideoRef.current;
    const seg = segmentationRef.current as { send?: (obj: { image: HTMLVideoElement }) => void } | null;
    if (!canvas || !video || video.readyState < 2) {
      animFrameRef.current = requestAnimationFrame(renderFrame);
      return;
    }

    const currentMode = modeRef.current;

    if (currentMode === 'none') {
      // Pass-through — just draw the source video
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      animFrameRef.current = requestAnimationFrame(renderFrame);
      return;
    }

    // Use segmentation if available, else CSS blur fallback
    if (seg?.send) {
      seg.send({ image: video });
      // result handled via onResults callback set during init
    } else {
      // Fallback: simple CSS filter on whole canvas
      const ctx = canvas.getContext('2d')!;
      const blurPx = currentMode === 'blur-heavy' ? '20px' : '10px';
      (ctx as CanvasRenderingContext2D & { filter: string }).filter = `blur(${blurPx})`;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      (ctx as CanvasRenderingContext2D & { filter: string }).filter = 'none';
    }

    animFrameRef.current = requestAnimationFrame(renderFrame);
  }, []);

  const startProcessing = useCallback(async (sourceStream: MediaStream) => {
    stopProcessing();
    activeSourceRef.current = sourceStream;

    const videoTrack = sourceStream.getVideoTracks()[0];
    if (!videoTrack) { setProcessedStream(sourceStream); return; }

    const settings = videoTrack.getSettings();
    const w = settings.width || 640;
    const h = settings.height || 480;

    // Setup canvases
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvasRef.current = canvas;

    const offscreen = document.createElement('canvas');
    offscreen.width = w; offscreen.height = h;
    offscreenRef.current = offscreen;

    // Setup source video element
    const vid = document.createElement('video');
    vid.srcObject = sourceStream;
    vid.autoplay = true;
    vid.playsInline = true;
    vid.muted = true;
    vid.width = w; vid.height = h;
    await vid.play().catch(() => {});
    sourceVideoRef.current = vid;

    // Try to load MediaPipe SelfieSegmentation
    try {
      const { SelfieSegmentation } = await import('@mediapipe/selfie_segmentation');
      const seg = new SelfieSegmentation({
        locateFile: (file: string) =>
          `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation@0.1/${file}`,
      });
      seg.setOptions({ modelSelection: 1, selfieMode: false });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      seg.onResults((results: any) => {
        const canvas2 = canvasRef.current;
        const offsc = offscreenRef.current;
        if (!canvas2 || !offsc) return;

        const currentMode = modeRef.current;
        const ctx = canvas2.getContext('2d')!;
        const octx = offsc.getContext('2d')!;

        ctx.clearRect(0, 0, canvas2.width, canvas2.height);

        if (currentMode === 'blur' || currentMode === 'blur-heavy') {
          const blurPx = currentMode === 'blur-heavy' ? '20px' : '10px';

          // Draw blurred background
          (ctx as CanvasRenderingContext2D & { filter: string }).filter = `blur(${blurPx})`;
          ctx.drawImage(results.image as CanvasImageSource, 0, 0, canvas2.width, canvas2.height);
          (ctx as CanvasRenderingContext2D & { filter: string }).filter = 'none';

          // Composite sharp person on top using segmentation mask
          octx.clearRect(0, 0, offsc.width, offsc.height);
          octx.drawImage(results.image as CanvasImageSource, 0, 0, offsc.width, offsc.height);
          octx.globalCompositeOperation = 'destination-in';
          octx.drawImage(results.segmentationMask, 0, 0, offsc.width, offsc.height);
          octx.globalCompositeOperation = 'source-over';
          ctx.drawImage(offsc, 0, 0);
        } else if (currentMode === 'color-dark' || currentMode === 'color-space') {
          // Virtual background color
          const bg = currentMode === 'color-dark' ? '#1a1a2e' : '#0f0c29';
          ctx.fillStyle = bg;
          ctx.fillRect(0, 0, canvas2.width, canvas2.height);

          octx.clearRect(0, 0, offsc.width, offsc.height);
          octx.drawImage(results.image as CanvasImageSource, 0, 0, offsc.width, offsc.height);
          octx.globalCompositeOperation = 'destination-in';
          octx.drawImage(results.segmentationMask, 0, 0, offsc.width, offsc.height);
          octx.globalCompositeOperation = 'source-over';
          ctx.drawImage(offsc, 0, 0);
        } else {
          ctx.drawImage(results.image as CanvasImageSource, 0, 0, canvas2.width, canvas2.height);
        }
      });

      await seg.initialize();
      segmentationRef.current = seg;
    } catch (e) {
      console.warn('[Background] MediaPipe unavailable, using CSS fallback', e);
      segmentationRef.current = null;
    }

    // Start render loop
    animFrameRef.current = requestAnimationFrame(renderFrame);

    // Capture canvas stream and expose it
    const outStream = canvas.captureStream(30);
    // Merge with audio tracks from original stream
    sourceStream.getAudioTracks().forEach((t) => outStream.addTrack(t));
    setProcessedStream(outStream);
  }, [stopProcessing, renderFrame]);

  const setMode = useCallback((m: BackgroundMode) => {
    setModeState(m);
    modeRef.current = m;
    if (m === 'none' && activeSourceRef.current) {
      // When disabling, revert to original stream
      setProcessedStream(activeSourceRef.current);
    }
  }, []);

  useEffect(() => () => stopProcessing(), [stopProcessing]);

  return { mode, processedStream, setMode, startProcessing, stopProcessing };
}

// Export color map for UI
export { COLOR_MAP };
