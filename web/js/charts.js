/** Canvas line chart for the historical series. Hand-rolled: no chart library, no dependencies. */

const MAX_POINTS = 600;

export class LineChart {
  constructor(canvas, { color = "#78aeff", unit = "", format = (v) => v.toFixed(0), min = null, max = null } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.color = color;
    this.unit = unit;
    this.format = format;
    this.min = min;
    this.max = max;
    this.data = [];

    this.resizeObserver = new ResizeObserver(() => this.draw());
    this.resizeObserver.observe(canvas);
    this.draw();
  }

  setColor(color) {
    this.color = color;
    this.draw();
  }

  setData(data) {
    this.data = data.slice(-MAX_POINTS);
    this.draw();
  }

  push(value) {
    this.data.push(value);
    if (this.data.length > MAX_POINTS) this.data.shift();
    this.draw();
  }

  clear() {
    this.data = [];
    this.draw();
  }

  draw() {
    const { canvas, ctx } = this;
    if (!ctx || !canvas.isConnected) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;

    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const style = getComputedStyle(document.body);
    const gridColor = style.getPropertyValue("--border") || "rgba(255,255,255,0.09)";
    const dimColor = style.getPropertyValue("--faint") || "#85858e";

    const padLeft = 40;
    const padRight = 8;
    const padTop = 8;
    const padBottom = 16;
    const plotWidth = Math.max(width - padLeft - padRight, 1);
    const plotHeight = Math.max(height - padTop - padBottom, 1);

    const values = this.data.filter((value) => Number.isFinite(value));
    let lo = this.min;
    let hi = this.max;

    if (lo === null || hi === null) {
      const dataMin = values.length ? Math.min(...values) : 0;
      const dataMax = values.length ? Math.max(...values) : 1;
      const span = Math.max(dataMax - dataMin, 1);
      lo = this.min ?? dataMin - span * 0.1;
      hi = this.max ?? dataMax + span * 0.1;
    }

    if (hi - lo < 0.0001) hi = lo + 1;

    const toX = (index) => padLeft + (index / Math.max(MAX_POINTS - 1, 1)) * plotWidth;
    const toY = (value) => padTop + plotHeight - ((value - lo) / (hi - lo)) * plotHeight;

    // horizontal grid
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    ctx.font = "10px ui-monospace, monospace";
    ctx.fillStyle = dimColor;

    const steps = 4;
    const offset = MAX_POINTS - this.data.length;

    for (let index = 0; index <= steps; index += 1) {
      const value = lo + ((hi - lo) * index) / steps;
      const y = toY(value);
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(width - padRight, y);
      ctx.stroke();

      ctx.fillText(this.format(value), 2, y + 3);
    }

    if (this.data.length < 2) {
      ctx.fillStyle = dimColor;
      ctx.font = "11px system-ui, sans-serif";
      ctx.fillText("collecting…", padLeft + 8, padTop + 16);
      return;
    }

    // area + line
    const points = this.data.map((value, index) => [toX(offset + index), toY(value)]);

    const gradient = ctx.createLinearGradient(0, padTop, 0, padTop + plotHeight);
    gradient.addColorStop(0, `${this.color}55`);
    gradient.addColorStop(1, `${this.color}00`);

    ctx.beginPath();
    ctx.moveTo(points[0][0], padTop + plotHeight);
    for (const [x, y] of points) ctx.lineTo(x, y);
    ctx.lineTo(points[points.length - 1][0], padTop + plotHeight);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.beginPath();
    points.forEach(([x, y], index) => (index === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 1.8;
    ctx.lineJoin = "round";
    ctx.stroke();

    const [lastX, lastY] = points[points.length - 1];
    ctx.beginPath();
    ctx.arc(lastX, lastY, 2.6, 0, Math.PI * 2);
    ctx.fillStyle = this.color;
    ctx.fill();
  }

  destroy() {
    this.resizeObserver.disconnect();
  }
}

/** One-line sparkline for cramped places (process rows, profile rows). */
export function sparkline(canvas, values, color = "#78aeff") {
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 120;
  const height = canvas.clientHeight || 24;

  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  if (values.length < 2) return;

  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = Math.max(hi - lo, 1);

  ctx.beginPath();
  values.forEach((value, index) => {
    const x = (index / (values.length - 1)) * width;
    const y = height - ((value - lo) / span) * height;
    index === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });

  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.stroke();
}
