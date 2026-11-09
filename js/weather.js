/* VNMY — погода на сцене: лёгкий canvas-слой без зависимостей */
import { prefersReducedMotion } from './util.js';

const PRESETS = {
  rain: { count: 90, speed: [7, 12], len: [8, 18], width: 1.1, drift: -0.9, color: 'rgba(200,220,255,.45)' },
  snow: { count: 55, speed: [0.4, 1.2], len: [1.6, 3.2], width: 1.6, drift: 0.35, color: 'rgba(255,255,255,.75)' },
  dust: { count: 40, speed: [0.15, 0.5], len: [1, 2.2], width: 1.2, drift: 0.15, color: 'rgba(255,235,200,.35)' },
  petals: { count: 26, speed: [0.5, 1.1], len: [4, 7], width: 3.2, drift: 0.6, color: 'rgba(255,205,220,.55)' },
};

export class WeatherLayer {
  constructor(canvasHost) {
    this.host = canvasHost;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'weather-canvas';
    this.ctx = this.canvas.getContext('2d');
    this.kind = 'none';
    this.particles = [];
    this.raf = 0;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.reduced = prefersReducedMotion();
    this._resize = () => this.resize();
    this.onVisibility = () => (document.hidden ? this.stop() : this.start());
    window.addEventListener('resize', this._resize);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.host.append(this.canvas);
  }

  setKind(kind) {
    if (kind === this.kind) return;
    this.kind = kind in PRESETS ? kind : 'none';
    this.host.dataset.weather = this.kind;
    this.host.classList.toggle('is-visible', this.kind !== 'none');
    if (this.reduced) this.host.classList.add('is-reduced');
    if (this.kind === 'none') {
      this.stop();
      this.particles = [];
      this.clear();
      return;
    }
    this.resize();
    this.seed();
    this.start();
  }

  resize() {
    const rect = this.host.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    this.w = rect.width;
    this.h = rect.height;
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (this.kind !== 'none') this.seed();
  }

  seed() {
    const cfg = PRESETS[this.kind];
    const density = this.reduced ? Math.round(cfg.count * 0.4) : cfg.count;
    this.particles = Array.from({ length: density }, () => this.spawn(cfg, true));
  }

  spawn(cfg, anywhere = false) {
    const rand = (a, b) => a + Math.random() * (b - a);
    return {
      x: Math.random() * this.w,
      y: anywhere ? Math.random() * this.h : -rand(4, 40),
      vx: cfg.drift * rand(0.6, 1.4),
      vy: rand(cfg.speed[0], cfg.speed[1]),
      len: rand(cfg.len[0], cfg.len[1]),
      w: cfg.width * rand(0.7, 1.3),
      a: rand(0.35, 1),
      sway: Math.random() * Math.PI * 2,
    };
  }

  /** k — длительность кадра в долях 1/60 с: скорость не зависит от частоты экрана. */
  step(k = 1) {
    const cfg = PRESETS[this.kind];
    if (!cfg) return;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.strokeStyle = cfg.color;
    ctx.fillStyle = cfg.color;
    ctx.lineCap = 'round';
    for (const p of this.particles) {
      p.y += p.vy * k;
      p.x += (p.vx + (this.kind === 'snow' || this.kind === 'petals' ? Math.sin(p.sway += 0.03 * k) * 0.35 : 0)) * k;
      if (p.y > this.h + 20 || p.x < -30 || p.x > this.w + 30) {
        Object.assign(p, this.spawn(cfg));
      }
      if (this.kind === 'rain') {
        ctx.globalAlpha = p.a * 0.8;
        ctx.lineWidth = p.w;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + p.vx * 1.6, p.y + p.len);
        ctx.stroke();
      } else {
        ctx.globalAlpha = p.a * 0.7;
        const bob = this.kind === 'petals' ? Math.sin(p.sway * 1.4) : 0;
        ctx.beginPath();
        ctx.ellipse(p.x + bob, p.y, p.w, this.kind === 'petals' ? p.len * 0.7 : p.len, bob * 0.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  /** «Меньше анимации»: погоду не рисуем вовсе, чтобы не мельтешило. */
  setReduced(reduced) {
    this.reduced = !!reduced;
    this.host.classList.toggle('is-reduced', this.reduced);
    if (this.reduced) {
      this.stop();
      this.clear();
      return;
    }
    if (this.kind !== 'none') {
      this.resize();
      this.seed();
      this.start();
    }
  }

  start() {
    if (this.raf || this.kind === 'none' || this.reduced) return;
    let last = 0;
    const loop = (time) => {
      // после паузы вкладки кадр не «прыгает»: шаг ограничен тремя кадрами
      const k = last ? Math.min(3, Math.max(0, (time - last) / (1000 / 60))) : 1;
      last = time;
      this.step(k);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  clear() {
    this.ctx.clearRect(0, 0, this.w || 0, this.h || 0);
  }

  destroy() {
    this.stop();
    window.removeEventListener('resize', this._resize);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.canvas.remove();
  }
}
