import { useEffect, useRef } from 'react';
import { useViewport } from '@xyflow/react';

/**
 * Atmospheric depth field behind the graph. Purely decorative and calm: its
 * only state-driven behaviour is brightness, which follows the number of
 * agents actually running. Disabled in low-power and reduced-motion modes.
 */
export function Starfield({ activity, enabled }: { activity: number; enabled: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const vp = useViewport();
  const vpRef = useRef(vp);
  vpRef.current = vp;
  const actRef = useRef(activity);
  actRef.current = activity;

  useEffect(() => {
    const cv = ref.current;
    if (!cv || !enabled) return;
    const ctx = cv.getContext('2d')!;
    let w = 0;
    let h = 0;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const resize = () => {
      w = cv.clientWidth;
      h = cv.clientHeight;
      cv.width = w * dpr;
      cv.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(cv);
    const rand = (a: number, b: number) => a + Math.random() * (b - a);
    const stars = Array.from({ length: 260 }, () => ({ x: Math.random(), y: Math.random(), z: rand(0.15, 1), tw: rand(0, Math.PI * 2), hue: Math.random() < 0.15 ? (Math.random() < 0.5 ? 20 : 190) : 230 }));
    let glow = 0;
    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min(64, now - last) / 1000;
      last = now;
      glow += (Math.min(1, actRef.current / 4) - glow) * Math.min(1, dt * 1.5);
      ctx.clearRect(0, 0, w, h);
      const { x: vx, y: vy, zoom } = vpRef.current;
      for (const s of stars) {
        s.tw += dt * (0.4 + s.z);
        const px = (((s.x * w + vx * s.z * 0.08) % w) + w) % w;
        const py = (((s.y * h + vy * s.z * 0.08) % h) + h) % h;
        const a = (0.18 + 0.5 * s.z) * (0.75 + 0.25 * Math.sin(s.tw)) * (0.7 + 0.5 * glow);
        const r = (0.35 + s.z * 0.9) * Math.min(1.6, Math.max(0.7, zoom));
        ctx.fillStyle = `hsla(${s.hue}, 90%, 85%, ${a})`;
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [enabled]);

  return (
    <div className="atmos" aria-hidden>
      <div className="atmos-nebula" style={{ opacity: 0.55 + Math.min(0.45, activity * 0.1) }} />
      {enabled && <canvas ref={ref} className="atmos-stars" />}
    </div>
  );
}
