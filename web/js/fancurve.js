/** Fan curve editor: draggable points on an SVG chart, matching upstream LACT semantics
 *  (x = temperature in °C, y = fan speed 0..1, at least two points, sorted, unique temperatures). */

import { clamp } from "./dom.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const PAD = { left: 46, right: 14, top: 14, bottom: 30 };
const MIN_POINTS = 2;
const MIN_GAP = 1;

function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    node.setAttribute(key, String(value));
  }
  return node;
}

export class FanCurveEditor {
  constructor(container, { curve, tempRange = [20, 115], onChange = null, currentTemp = null }) {
    this.container = container;
    this.tempRange = [...tempRange];
    this.onChange = onChange;
    this.currentTemp = currentTemp;
    this.points = Object.entries(curve || {})
      .map(([temp, speed]) => ({ temp: Number(temp), speed: Number(speed) }))
      .filter((point) => Number.isFinite(point.temp) && Number.isFinite(point.speed))
      .sort((a, b) => a.temp - b.temp);

    if (this.points.length < MIN_POINTS) {
      this.points = [
        { temp: 40, speed: 0.3 },
        { temp: 50, speed: 0.35 },
        { temp: 60, speed: 0.5 },
        { temp: 70, speed: 0.75 },
        { temp: 80, speed: 1 },
      ];
    }

    this.dragIndex = null;
    this.render();

    // While the page is being built this container is detached and reports a width
    // of 0, so the chart draws with the fallback width. The SVG is then stretched by
    // the layout to the real width, which compresses the curve and misaligns it with
    // the axis ticks. Re-draw whenever the container actually gets its real size (mount
    // and resize) instead of leaving it distorted until a drag-click fixes it.
    const resize = () => {
      const width = this.container.clientWidth;
      if (width > 0 && Math.abs(width - this.width) >= 8) this.render();
    };
    this.resizeObserver = new ResizeObserver(resize);
    this.resizeObserver.observe(container);
  }

  setTempRange(range) {
    if (!range || range.length !== 2) return;
    this.tempRange = [...range];
    this.render();
  }

  setCurrentTemp(temp) {
    this.currentTemp = temp;
    this.drawLiveMarkers();
  }

  toCurve() {
    const result = {};
    for (const point of this.points) result[Math.round(point.temp)] = Number(point.speed.toFixed(3));
    return result;
  }

  emit() {
    this.onChange?.(this.toCurve());
  }

  render() {
    const width = Math.max(this.container.clientWidth, 320);
    const height = 280;

    this.width = width;
    this.height = height;

    const svgEl = svg("svg", {
      class: "curve-svg",
      viewBox: `0 0 ${width} ${height}`,
      preserveAspectRatio: "none",
    });

    const [tempMin, tempMax] = this.tempRange;
    this.tempMin = tempMin;
    this.tempMax = Math.max(tempMax, tempMin + 1);

    this.plot = {
      x: PAD.left,
      y: PAD.top,
      w: Math.max(width - PAD.left - PAD.right, 10),
      h: Math.max(height - PAD.top - PAD.bottom, 10),
    };

    const defs = svg("defs");
    const gradient = svg("linearGradient", { id: "fan-curve-fill", x1: 0, y1: 0, x2: 0, y2: 1 });
    gradient.append(
      svg("stop", { offset: "0%", "stop-color": "#78aeff", "stop-opacity": "0.35" }),
      svg("stop", { offset: "100%", "stop-color": "#78aeff", "stop-opacity": "0" }),
    );
    defs.append(gradient);
    svgEl.append(defs);

    // grid + axes
    const grid = svg("g", { stroke: "rgba(128,128,140,0.28)", "stroke-width": 1 });

    for (let speed = 0; speed <= 1.0001; speed += 0.25) {
      const y = this.speedToY(speed);
      grid.append(svg("line", { x1: this.plot.x, y1: y, x2: this.plot.x + this.plot.w, y2: y }));
    }

    const tempStep = this.tempMax - this.tempMin > 60 ? 20 : 10;
    const firstTick = Math.ceil(this.tempMin / tempStep) * tempStep;

    for (let temp = firstTick; temp <= this.tempMax; temp += tempStep) {
      const x = this.tempToX(temp);
      grid.append(
        svg("line", {
          x1: x,
          y1: this.plot.y,
          x2: x,
          y2: this.plot.y + this.plot.h,
          stroke: "rgba(128,128,140,0.16)",
        }),
      );
    }

    svgEl.append(grid);

    const labels = svg("g", { fill: "#9a9aa3", "font-size": "10", "font-family": "ui-monospace, monospace" });

    for (let speed = 0; speed <= 1.0001; speed += 0.25) {
      const label = svg("text", {
        x: this.plot.x - 8,
        y: this.speedToY(speed) + 3,
        "text-anchor": "end",
      });
      label.textContent = `${Math.round(speed * 100)}%`;
      labels.append(label);
    }

    for (let temp = firstTick; temp <= this.tempMax; temp += tempStep) {
      const label = svg("text", {
        x: this.tempToX(temp),
        y: height - 10,
        "text-anchor": "middle",
      });
      label.textContent = `${temp}°`;
      labels.append(label);
    }

    svgEl.append(labels);

    // curve area + line
    const area = svg("path", { fill: "url(#fan-curve-fill)", stroke: "none" });
    const line = svg("path", { fill: "none", stroke: "#78aeff", "stroke-width": 2.2, "stroke-linejoin": "round" });

    const sorted = [...this.points].sort((a, b) => a.temp - b.temp);
    const pathData = sorted
      .map((point, index) => `${index === 0 ? "M" : "L"} ${this.tempToX(point.temp)} ${this.speedToY(point.speed)}`)
      .join(" ");

    line.setAttribute("d", pathData);
    area.setAttribute(
      "d",
      `${pathData} L ${this.tempToX(sorted[sorted.length - 1].temp)} ${this.plot.y + this.plot.h} L ${this.tempToX(sorted[0].temp)} ${this.plot.y + this.plot.h} Z`,
    );

    svgEl.append(area, line);

    // live marker layer (temperature + current speed)
    this.liveLayer = svg("g");
    svgEl.append(this.liveLayer);

    // draggable points
    this.pointLayer = svg("g");
    svgEl.append(this.pointLayer);

    this.points.forEach((point, index) => {
      const circle = svg("circle", {
        cx: this.tempToX(point.temp),
        cy: this.speedToY(point.speed),
        r: 7,
        fill: "#1e1e22",
        stroke: "#78aeff",
        "stroke-width": 2.4,
        class: "curve-point",
        "data-index": index,
      });
      circle.style.cursor = "grab";
      circle.addEventListener("pointerdown", (event) => this.startDrag(event, index));
      circle.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        this.removePoint(index);
      });
      const title = svg("title");
      title.textContent = `${Math.round(point.temp)}°C → ${Math.round(point.speed * 100)}% (right-click to remove)`;
      circle.append(title);
      this.pointLayer.append(circle);
    });

    svgEl.addEventListener("pointerdown", (event) => {
      if (event.target.closest(".curve-point")) return;
      this.addPointAt(event);
    });

    svgEl.addEventListener("pointermove", (event) => this.onPointerMove(event));
    svgEl.addEventListener("pointerup", () => this.endDrag());
    svgEl.addEventListener("pointercancel", () => this.endDrag());
    svgEl.addEventListener("pointerleave", () => {
      if (this.dragIndex !== null) this.endDrag();
    });

    this.container.replaceChildren(svgEl);
    this.svgEl = svgEl;
    this.drawLiveMarkers();
  }

  drawLiveMarkers() {
    if (!this.liveLayer) return;
    this.liveLayer.replaceChildren();

    if (this.currentTemp === null || this.currentTemp === undefined) return;
    if (this.currentTemp < this.tempMin || this.currentTemp > this.tempMax) return;

    const x = this.tempToX(this.currentTemp);
    this.liveLayer.append(
      svg("line", {
        x1: x,
        y1: this.plot.y,
        x2: x,
        y2: this.plot.y + this.plot.h,
        stroke: "#f5c211",
        "stroke-width": 1.4,
        "stroke-dasharray": "4 4",
        opacity: 0.9,
      }),
    );

    const speed = this.speedAt(this.currentTemp);
    const y = this.speedToY(speed);
    this.liveLayer.append(
      svg("line", {
        x1: this.plot.x,
        y1: y,
        x2: this.plot.x + this.plot.w,
        y2: y,
        stroke: "#57e389",
        "stroke-width": 1.4,
        "stroke-dasharray": "4 4",
        opacity: 0.9,
      }),
    );

    const label = svg("text", {
      x: x + 6,
      y: this.plot.y + 12,
      fill: "#f5c211",
      "font-size": "10.5",
      "font-family": "ui-monospace, monospace",
    });
    label.textContent = `${Math.round(this.currentTemp)}°C → ${Math.round(speed * 100)}%`;
    this.liveLayer.append(label);
  }

  speedAt(temp) {
    const sorted = [...this.points].sort((a, b) => a.temp - b.temp);
    if (temp <= sorted[0].temp) return sorted[0].speed;
    if (temp >= sorted[sorted.length - 1].temp) return sorted[sorted.length - 1].speed;

    for (let index = 0; index < sorted.length - 1; index += 1) {
      const left = sorted[index];
      const right = sorted[index + 1];
      if (temp >= left.temp && temp <= right.temp) {
        const ratio = (temp - left.temp) / Math.max(right.temp - left.temp, 0.001);
        return left.speed + (right.speed - left.speed) * ratio;
      }
    }
    return sorted[sorted.length - 1].speed;
  }

  tempToX(temp) {
    return this.plot.x + ((temp - this.tempMin) / (this.tempMax - this.tempMin)) * this.plot.w;
  }

  xToTemp(x) {
    return this.tempMin + ((x - this.plot.x) / this.plot.w) * (this.tempMax - this.tempMin);
  }

  speedToY(speed) {
    return this.plot.y + this.plot.h - speed * this.plot.h;
  }

  yToSpeed(y) {
    return clamp((this.plot.y + this.plot.h - y) / this.plot.h, 0, 1);
  }

  startDrag(event, index) {
    event.preventDefault();
    event.stopPropagation();
    this.dragIndex = index;
    event.target.setPointerCapture?.(event.pointerId);
    event.target.style.cursor = "grabbing";
  }

  onPointerMove(event) {
    if (this.dragIndex === null) return;
    const rect = this.svgEl.getBoundingClientRect();
    const scaleX = this.width / rect.width;
    const scaleY = this.height / rect.height;
    const x = (event.clientX - rect.left) * scaleX;
    const y = (event.clientY - rect.top) * scaleY;

    const point = this.points[this.dragIndex];
    const sorted = [...this.points].sort((a, b) => a.temp - b.temp);
    const position = sorted.indexOf(point);

    const lowerBound = position > 0 ? sorted[position - 1].temp + MIN_GAP : this.tempMin;
    const upperBound = position < sorted.length - 1 ? sorted[position + 1].temp - MIN_GAP : this.tempMax;

    point.temp = clamp(this.xToTemp(x), lowerBound, upperBound);
    point.speed = this.yToSpeed(y);
    this.emit();
    this.render();
    this.dragIndex = this.points.indexOf(point);
  }

  endDrag() {
    if (this.dragIndex === null) return;
    this.dragIndex = null;
    this.emit();
  }

  addPointAt(event) {
    const rect = this.svgEl.getBoundingClientRect();
    const x = (event.clientX - rect.left) * (this.width / rect.width);
    const y = (event.clientY - rect.top) * (this.height / rect.height);

    if (x < this.plot.x || x > this.plot.x + this.plot.w) return;
    if (y < this.plot.y || y > this.plot.y + this.plot.h) return;

    const temp = Math.round(this.xToTemp(x));
    const speed = this.yToSpeed(y);

    if (this.points.some((point) => Math.abs(point.temp - temp) < MIN_GAP)) return;

    this.points.push({ temp, speed });
    this.points.sort((a, b) => a.temp - b.temp);
    this.emit();
    this.render();
  }

  removePoint(index) {
    if (this.points.length <= MIN_POINTS) return;
    this.points.splice(index, 1);
    this.emit();
    this.render();
  }

  /** Used by the "reset to default" button. */
  setCurve(curve) {
    const points = Object.entries(curve || {})
      .map(([temp, speed]) => ({ temp: Number(temp), speed: Number(speed) }))
      .filter((point) => Number.isFinite(point.temp) && Number.isFinite(point.speed))
      .sort((a, b) => a.temp - b.temp);

    if (points.length < MIN_POINTS) return;
    this.points = points;
    this.render();
  }
}
