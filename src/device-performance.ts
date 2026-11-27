type ConnectionHints = { saveData?: boolean; effectiveType?: string };
type DeviceNavigator = Navigator & { deviceMemory?: number; connection?: ConnectionHints };

const root = document.documentElement;
let started = false;
let rafId = 0;
let frameTimes: number[] = [];
let goodWindows = 0;
let lowPerformance = false;
let lastEvaluation = 0;
let lastFrame = 0;
let lastChange = 0;

function getStaticDeviceTier(): 'low' | 'balanced' | 'high' {
  const nav = navigator as DeviceNavigator;
  const cores = typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : undefined;
  const memory = typeof nav.deviceMemory === 'number' ? nav.deviceMemory : undefined;
  const connection = nav.connection;
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  const constrainedNetwork = connection?.saveData === true || connection?.effectiveType === 'slow-2g' || connection?.effectiveType === '2g';

  if (reducedMotion || constrainedNetwork || (cores !== undefined && cores <= 4) || (memory !== undefined && memory <= 4)) return 'low';
  if ((cores !== undefined && cores >= 8) && (memory === undefined || memory >= 8)) return 'high';
  return 'balanced';
}

// Estimate the browser's delivered frame cadence; the exact physical panel refresh
// rate and processor model are intentionally not guessed because browsers hide them.
function getFrameHealth(samples: number[]): { droppedRatio: number; estimatedFps: number } | null {
  if (samples.length < 45) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const baselineSamples = sorted.filter(value => value >= 4 && value <= 35);
  if (baselineSamples.length < 20) return null;
  const baseline = baselineSamples[Math.floor(baselineSamples.length * 0.2)];
  if (!Number.isFinite(baseline) || baseline <= 0) return null;
  const dropped = samples.filter(value => value > Math.max(baseline * 1.8, baseline + 8)).length;
  return { droppedRatio: dropped / samples.length, estimatedFps: Math.round(1000 / baseline) };
}

function applyTier(tier: 'low' | 'balanced' | 'high') {
  const nextLow = tier === 'low';
  if (lowPerformance !== nextLow) {
    lowPerformance = nextLow;
    root.classList.toggle('masenet-low-performance', nextLow);
    root.dataset.masenetPerformance = tier;
    lastChange = performance.now();
  } else {
    root.dataset.masenetPerformance = tier;
  }
}

function onFrame(now: number) {
  if (!started || document.visibilityState === 'hidden') return;
  if (lastFrame > 0) {
    const delta = now - lastFrame;
    if (delta > 0 && delta < 250) frameTimes.push(delta);
  }
  lastFrame = now;

  if (!lastEvaluation) lastEvaluation = now;
  if (now - lastEvaluation >= 2200) {
    const health = getFrameHealth(frameTimes);
    const staticTier = getStaticDeviceTier();
    if (staticTier === 'low') {
      applyTier('low');
      goodWindows = 0;
    } else if (health && health.droppedRatio >= 0.18) {
      applyTier('low');
      goodWindows = 0;
    } else if (health && health.droppedRatio <= 0.06) {
      goodWindows += 1;
      if (goodWindows >= 3 && now - lastChange > 6500) applyTier(staticTier);
    } else {
      goodWindows = 0;
      if (!lowPerformance) applyTier(staticTier);
    }
    frameTimes = [];
    lastEvaluation = now;
  }
  rafId = window.requestAnimationFrame(onFrame);
}

function handleVisibility() {
  if (document.visibilityState === 'hidden') {
    if (rafId) window.cancelAnimationFrame(rafId);
    rafId = 0;
    lastFrame = 0;
    frameTimes = [];
    lastEvaluation = 0;
  } else if (started && !rafId) {
    lastFrame = 0;
    lastEvaluation = 0;
    rafId = window.requestAnimationFrame(onFrame);
  }
}

export function startAdaptiveDevicePerformance() {
  if (started || typeof window === 'undefined' || typeof navigator === 'undefined') return;
  started = true;
  const initialTier = getStaticDeviceTier();
  applyTier(initialTier);
  document.addEventListener('visibilitychange', handleVisibility, { passive: true });
  if (document.visibilityState !== 'hidden') rafId = window.requestAnimationFrame(onFrame);

  const motionPreference = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  const onMotionChange = () => {
    if (motionPreference?.matches) applyTier('low');
    else {
      goodWindows = 0;
      lastEvaluation = 0;
    }
  };
  motionPreference?.addEventListener?.('change', onMotionChange);
}
