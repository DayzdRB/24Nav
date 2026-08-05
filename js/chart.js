/* ==========================================================================
   24Nav chart
   Renders the enroute chart in the shared -600..600 map-unit space used across
   the 24RC vector charts. 1 map unit = 100 studs. Symbols and labels are drawn
   at a fixed on-screen size by counter-scaling against the current viewBox, so
   nothing balloons or shrinks as the chart is zoomed.
   ========================================================================== */

window.Nav = window.Nav || {};

(() => {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MAP_SPAN = 1200;
  const MAP_HALF = MAP_SPAN / 2;
  const STUDS_PER_MAP_UNIT = 100;
  const STUDS_PER_NM = 3307.14286;
  const MAP_UNITS_PER_NM = STUDS_PER_NM / STUDS_PER_MAP_UNIT;
  const MIN_VIEW = 12;
  const MAX_VIEW = MAP_SPAN * 1.4;
  const CLICK_SLOP_PX = 6;
  const MAX_EXTENSION_NM = 20;

  /* --- geometry ---------------------------------------------------------- */

  const geo = {
    MAP_UNITS_PER_NM,
    STUDS_PER_NM,

    /** Normalized 0..1 chart coordinate to map units. */
    fromNormalized(point) {
      return { x: point.x * MAP_SPAN - MAP_HALF, y: point.y * MAP_SPAN - MAP_HALF };
    },

    /** Live-feed stud position to map units. Feed -y is north, which already
        matches SVG's downward y, so no sign flip is needed. */
    fromStuds(position) {
      return { x: Number(position.x) / STUDS_PER_MAP_UNIT, y: Number(position.y) / STUDS_PER_MAP_UNIT };
    },

    distanceNm(a, b) {
      return Math.hypot(b.x - a.x, b.y - a.y) / MAP_UNITS_PER_NM;
    },

    bearing(from, to) {
      const east = to.x - from.x;
      const north = -(to.y - from.y);
      const deg = Math.atan2(east, north) * 180 / Math.PI;
      return ((deg % 360) + 360) % 360;
    },

    padHeading(value) {
      const rounded = Math.round(((Number(value) % 360) + 360) % 360) || 360;
      return String(rounded).padStart(3, '0');
    },
  };

  /* --- element helpers --------------------------------------------------- */

  function el(name, attrs = {}, text) {
    const node = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined) continue;
      node.setAttribute(key, String(value));
    }
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  /* --- chart ------------------------------------------------------------- */

  const chart = {
    svg: null,
    view: { x: -MAP_HALF, y: -MAP_HALF, w: MAP_SPAN, h: MAP_SPAN },
    points: {},
    airports: {},
    fixes: {},
    sectors: [],
    airportAssets: {},
    symbols: [],
    selectedName: null,
    measureEnabled: false,
    measure: null,
    pickHandlers: [],
    measureHandlers: [],
    layers: {},
    runwayAirports: [],

    init(data) {
      this.svg = document.getElementById('chartSvg');
      if (!this.svg) return;

      this.layers = {
        base: document.getElementById('layerBase'),
        airportGround: document.getElementById('layerAirportGround'),
        airportRunway: document.getElementById('layerAirportRunway'),
        grid: document.getElementById('layerGrid'),
        sectors: document.getElementById('layerSectors'),
        fixes: document.getElementById('layerFixes'),
        airports: document.getElementById('layerAirports'),
        route: document.getElementById('layerRoute'),
        extensions: document.getElementById('layerExtensions'),
        measure: document.getElementById('layerMeasure'),
        traffic: document.getElementById('layerTraffic'),
      };

      for (const [code, point] of Object.entries(data.AIRPORTS || {})) {
        this.airports[code] = { name: code, kind: 'airport', ...geo.fromNormalized(point) };
      }
      for (const [code, point] of Object.entries(data.WAYPOINTS || {})) {
        this.fixes[code] = { name: code, kind: 'fix', ...geo.fromNormalized(point) };
      }
      this.points = { ...this.fixes, ...this.airports };
      this.sectors = Array.isArray(data.AIRSPACE_SECTORS) ? data.AIRSPACE_SECTORS : [];
      this.airportAssets = data.AIRPORT_SVG_ASSETS || {};

      this.drawAirportGround();
      this.drawGrid();
      this.drawSectors();
      this.drawFixes();
      this.drawAirports();
      this.bindPointer();
      this.applyView();
      this.setLayer('grid', false);
    },

    /* --- viewport ------------------------------------------------------- */

    get scale() {
      return this.view.w / MAP_SPAN;
    },

    applyView() {
      const { x, y, w, h } = this.view;
      this.svg.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
      const k = this.scale;
      document.documentElement.style.setProperty('--k', k.toFixed(4));
      for (const entry of this.symbols) {
        entry.node.setAttribute('transform', `translate(${entry.x} ${entry.y}) scale(${k})`);
      }
      this.drawMeasure();
      this.drawRoute(window.Nav.route ? window.Nav.route.nodes() : []);
      this.drawExtensions();
      if (window.Nav.instruments) this.drawOwnship(window.Nav.instruments.state);
    },

    setView(next) {
      const w = Math.min(MAX_VIEW, Math.max(MIN_VIEW, next.w));
      const ratio = this.aspect();
      this.view = { x: next.x, y: next.y, w, h: w / ratio };
      this.applyView();
    },

    aspect() {
      const box = this.svg.getBoundingClientRect();
      if (!box.width || !box.height) return 1;
      return box.width / box.height;
    },

    fitTo(points) {
      const list = (points || []).filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y));
      if (list.length < 1) {
        this.setView({ x: -MAP_HALF, y: -MAP_HALF, w: MAP_SPAN });
        return;
      }
      const xs = list.map((p) => p.x);
      const ys = list.map((p) => p.y);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      const pad = Math.max(40, Math.max(maxX - minX, maxY - minY) * 0.22);
      const ratio = this.aspect();
      const width = Math.max(maxX - minX + pad * 2, (maxY - minY + pad * 2) * ratio);
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      this.setView({ x: cx - width / 2, y: cy - width / ratio / 2, w: width });
    },

    clientToMap(event) {
      const box = this.svg.getBoundingClientRect();
      const fx = (event.clientX - box.left) / box.width;
      const fy = (event.clientY - box.top) / box.height;
      return { x: this.view.x + fx * this.view.w, y: this.view.y + fy * this.view.h };
    },

    /* --- airport artwork ------------------------------------------------ */

    /**
     * Ground and apron artwork for every airport. Each of these files is
     * authored in the same -600..600 world viewBox as the coast layer, so every
     * one is a full-extent overlay needing no positioning.
     */
    drawAirportGround() {
      const layer = this.layers.airportGround;
      if (!layer) return;
      clear(layer);
      for (const [airport, files] of Object.entries(this.airportAssets)) {
        for (const file of files) {
          if (String(file).startsWith('RWY')) continue;
          layer.appendChild(el('image', {
            class: 'airport-ground',
            href: `maps/${airport}/${file}`,
            x: -MAP_HALF, y: -MAP_HALF, width: MAP_SPAN, height: MAP_SPAN,
            preserveAspectRatio: 'none',
          }));
        }
      }
    },

    /**
     * Runway markings only for the airports being used. Drawing all 44 at once
     * buries the chart in lines belonging to airports the pilot is not visiting.
     */
    setRunwayAirports(codes) {
      const wanted = [...new Set((codes || []).filter(Boolean))];
      if (wanted.join('|') === this.runwayAirports.join('|')) return;
      this.runwayAirports = wanted;
      const layer = this.layers.airportRunway;
      if (!layer) return;
      clear(layer);
      for (const airport of wanted) {
        for (const file of this.airportAssets[airport] || []) {
          if (!String(file).startsWith('RWY')) continue;
          layer.appendChild(el('image', {
            class: 'airport-runway',
            href: `maps/${airport}/${file}`,
            x: -MAP_HALF, y: -MAP_HALF, width: MAP_SPAN, height: MAP_SPAN,
            preserveAspectRatio: 'none',
          }));
        }
      }
    },

    /* --- static layers -------------------------------------------------- */

    drawGrid() {
      const layer = this.layers.grid;
      clear(layer);
      const step = 5 * MAP_UNITS_PER_NM;
      for (let r = step; r <= MAP_HALF * 1.5; r += step) {
        layer.appendChild(el('circle', { class: 'grid-line', cx: 0, cy: 0, r }));
      }
    },

    drawSectors() {
      const layer = this.layers.sectors;
      clear(layer);
      for (const sector of this.sectors) {
        const polygon = Array.isArray(sector.polygon) ? sector.polygon : [];
        if (polygon.length < 3) continue;
        layer.appendChild(el('polygon', {
          class: 'sector-shape',
          points: polygon.map((p) => `${p[0]},${p[1]}`).join(' '),
        }));
        const cx = polygon.reduce((sum, p) => sum + p[0], 0) / polygon.length;
        const cy = polygon.reduce((sum, p) => sum + p[1], 0) / polygon.length;
        // Counter-scaled, otherwise the frequency label grows into the airport
        // artwork as soon as the chart is zoomed in.
        const group = el('g', { class: 'sector-label' });
        group.appendChild(el('text', { class: 'sector-tag', y: 0 }, String(sector.label).toUpperCase()));
        if (sector.frequency) {
          group.appendChild(el('text', { class: 'sector-tag sector-tag--freq', y: 9 }, sector.frequency));
        }
        layer.appendChild(group);
        this.symbols.push({ node: group, x: cx, y: cy });
      }
    },

    drawFixes() {
      const layer = this.layers.fixes;
      clear(layer);
      for (const fix of Object.values(this.fixes)) {
        const group = el('g', { class: 'pick', 'data-name': fix.name, 'data-kind': 'fix', tabindex: '0', role: 'button' });
        // Invisible hit target. Without it only the 1.25px stroke is clickable,
        // which makes adding a waypoint a test of marksmanship.
        group.appendChild(el('circle', { class: 'pick-hit', cx: 0, cy: 0, r: 9 }));
        group.appendChild(el('polygon', { class: 'fix-symbol', points: '0,-4 4,0 0,4 -4,0' }));
        group.appendChild(el('text', { class: 'fix-name', x: 0, y: -7 }, fix.name));
        group.appendChild(el('title', {}, `${fix.name} (fix)`));
        layer.appendChild(group);
        this.symbols.push({ node: group, x: fix.x, y: fix.y });
      }
    },

    drawAirports() {
      const layer = this.layers.airports;
      clear(layer);
      for (const airport of Object.values(this.airports)) {
        const group = el('g', { class: 'pick', 'data-name': airport.name, 'data-kind': 'airport', tabindex: '0', role: 'button' });
        group.appendChild(el('circle', { class: 'pick-hit', cx: 0, cy: 0, r: 11 }));
        group.appendChild(el('circle', { class: 'apt-symbol', cx: 0, cy: 0, r: 4.5 }));
        group.appendChild(el('circle', { class: 'apt-symbol apt-symbol--core', cx: 0, cy: 0, r: 1.4 }));
        group.appendChild(el('text', { class: 'apt-name', x: 0, y: 14 }, airport.name));
        group.appendChild(el('title', {}, `${airport.name} (airport)`));
        layer.appendChild(group);
        this.symbols.push({ node: group, x: airport.x, y: airport.y });
      }
    },

    setLayer(name, visible) {
      const layer = this.layers[name];
      if (!layer) return;
      layer.style.display = visible ? '' : 'none';
    },

    /* --- route ---------------------------------------------------------- */

    setSelected(name) {
      this.selectedName = name || null;
      for (const entry of this.symbols) {
        const match = entry.node.dataset?.name === this.selectedName;
        if (match) entry.node.dataset.selected = 'true';
        else if (entry.node.dataset) delete entry.node.dataset.selected;
      }
    },

    drawRoute(nodes) {
      const layer = this.layers.route;
      if (!layer) return;
      clear(layer);
      const list = (nodes || []).filter((n) => Number.isFinite(n?.x));
      if (list.length < 1) return;

      if (list.length > 1) {
        layer.appendChild(el('polyline', {
          class: 'route-line',
          points: list.map((n) => `${n.x},${n.y}`).join(' '),
        }));
      }

      const k = this.scale;
      for (let i = 0; i < list.length - 1; i += 1) {
        const a = list[i];
        const b = list[i + 1];
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const heading = geo.bearing(a, b);
        const nm = geo.distanceNm(a, b);
        let angle = heading - 90;
        if (angle > 90 || angle < -90) angle += 180;
        const group = el('g', { transform: `translate(${mid.x} ${mid.y}) scale(${k}) rotate(${angle})` });
        group.appendChild(el('text', { class: 'route-leg-tag', y: -5 }, `${geo.padHeading(heading)}  ${nm.toFixed(1)} NM`));
        layer.appendChild(group);
      }

      for (const node of list) {
        const group = el('g', { transform: `translate(${node.x} ${node.y}) scale(${k})` });
        if (node.kind === 'airport') {
          // A thin open ring, so the airport symbol and its ground artwork stay
          // readable underneath instead of being covered by a filled disc.
          group.appendChild(el('circle', { class: 'route-ring', cx: 0, cy: 0, r: 8 }));
        } else if (node.kind === 'extension') {
          group.appendChild(el('rect', { class: 'route-node route-node--ext', x: -3.5, y: -3.5, width: 7, height: 7, transform: 'rotate(45)' }));
        } else {
          group.appendChild(el('rect', { class: 'route-node', x: -4, y: -4, width: 8, height: 8, transform: 'rotate(45)' }));
        }
        layer.appendChild(group);
      }
    },

    /* --- runway extensions ---------------------------------------------- */

    drawExtensions() {
      const layer = this.layers.extensions;
      if (!layer || !window.Nav.route) return;
      clear(layer);
      const k = this.scale;

      for (const role of ['departure', 'arrival']) {
        const geometry = window.Nav.route.extensionGeometry(role);
        if (!geometry) continue;
        const state = role === 'departure' ? window.Nav.route.depExt : window.Nav.route.arrExt;
        const nm = state.on ? state.nm : 0;
        const units = Math.max(0, nm) * MAP_UNITS_PER_NM;
        const tip = {
          x: geometry.origin.x + geometry.direction.x * units,
          y: geometry.origin.y + geometry.direction.y * units,
        };
        // Showing the whole 20 NM range at all times drags a long dotted line
        // across the chart, so the guide reaches a little past the handle and no
        // further. The drag itself is still allowed out to the full range.
        const guideNm = Math.min(MAX_EXTENSION_NM, Math.max(nm + 3, 6));
        const full = {
          x: geometry.origin.x + geometry.direction.x * guideNm * MAP_UNITS_PER_NM,
          y: geometry.origin.y + geometry.direction.y * guideNm * MAP_UNITS_PER_NM,
        };

        layer.appendChild(el('line', {
          class: 'ext-track', x1: geometry.origin.x, y1: geometry.origin.y, x2: full.x, y2: full.y,
        }));
        if (state.on) {
          layer.appendChild(el('line', {
            class: 'ext-live', x1: geometry.origin.x, y1: geometry.origin.y, x2: tip.x, y2: tip.y,
          }));
        }

        const handle = el('g', {
          class: 'ext-handle',
          'data-ext': role,
          'data-on': String(state.on),
          transform: `translate(${tip.x} ${tip.y}) scale(${k})`,
          tabindex: '0',
          role: 'button',
        });
        handle.appendChild(el('circle', { class: 'pick-hit', cx: 0, cy: 0, r: 12 }));
        handle.appendChild(el('rect', { class: 'ext-diamond', x: -5, y: -5, width: 10, height: 10, transform: 'rotate(45)' }));
        handle.appendChild(el('text', { class: 'ext-label', y: -11 },
          state.on ? `${geometry.runway} ${nm.toFixed(1)} NM` : `${geometry.runway} off`));
        handle.appendChild(el('title', {}, `Drag to set the ${role} runway extension`));
        layer.appendChild(handle);
      }
    },

    /* --- ownship -------------------------------------------------------- */

    drawOwnship(state) {
      const layer = this.layers.traffic;
      if (!layer) return;
      clear(layer);
      if (!state?.present) return;
      const k = this.scale;
      const group = el('g', {
        class: 'ownship',
        'data-ownship': 'true',
        'data-source': state.source,
        transform: `translate(${state.x} ${state.y}) scale(${k})`,
        tabindex: '0',
        role: 'button',
      });
      group.appendChild(el('circle', { class: 'pick-hit', cx: 0, cy: 0, r: 14 }));
      const body = el('g', { transform: `rotate(${Number(state.heading) || 0})` });
      body.appendChild(el('polygon', { class: 'ownship-symbol', points: '0,-9 6,7 0,4 -6,7' }));
      group.appendChild(body);
      group.appendChild(el('text', { class: 'ownship-label', y: -13 },
        `${state.callsign || 'OWN'}  ${Math.round(state.altitude)}`));
      group.appendChild(el('title', {}, 'Drag to move the aircraft'));
      layer.appendChild(group);
    },

    /* --- measure -------------------------------------------------------- */

    setMeasureEnabled(enabled) {
      this.measureEnabled = Boolean(enabled);
      if (!this.measureEnabled) {
        this.measure = null;
        this.drawMeasure();
      }
    },

    drawMeasure() {
      const layer = this.layers?.measure;
      if (!layer) return;
      clear(layer);
      const m = this.measure;
      if (!m || !m.end) return;

      const nm = geo.distanceNm(m.start, m.end);
      const outbound = geo.bearing(m.start, m.end);
      const inbound = (outbound + 180) % 360;
      const mid = { x: (m.start.x + m.end.x) / 2, y: (m.start.y + m.end.y) / 2 };
      const k = this.scale;
      let angle = outbound - 90;
      if (angle > 90 || angle < -90) angle += 180;

      layer.appendChild(el('line', {
        class: 'measure-line', x1: m.start.x, y1: m.start.y, x2: m.end.x, y2: m.end.y,
      }));
      for (const point of [m.start, m.end]) {
        const g = el('g', { transform: `translate(${point.x} ${point.y}) scale(${k})` });
        g.appendChild(el('circle', { class: 'measure-end', cx: 0, cy: 0, r: 4 }));
        layer.appendChild(g);
      }

      const startTag = el('g', { transform: `translate(${m.start.x} ${m.start.y}) scale(${k})` });
      startTag.appendChild(el('text', { class: 'measure-text measure-text--small', y: 18 }, geo.padHeading(outbound)));
      layer.appendChild(startTag);

      const endTag = el('g', { transform: `translate(${m.end.x} ${m.end.y}) scale(${k})` });
      endTag.appendChild(el('text', { class: 'measure-text measure-text--small', y: 18 }, geo.padHeading(inbound)));
      layer.appendChild(endTag);

      const midTag = el('g', { transform: `translate(${mid.x} ${mid.y}) scale(${k}) rotate(${angle})` });
      midTag.appendChild(el('text', { class: 'measure-text', y: -8 }, `${nm.toFixed(1)} NM`));
      layer.appendChild(midTag);

      for (const handler of this.measureHandlers) handler({ nm, outbound, inbound });
    },

    /* --- input ---------------------------------------------------------- */

    bindPointer() {
      const svg = this.svg;
      const pointers = new Map();
      let panFrom = null;
      let pinch = null;
      let drag = null;
      let downAt = null;

      svg.addEventListener('wheel', (event) => {
        event.preventDefault();
        const focus = this.clientToMap(event);
        const factor = Math.exp(event.deltaY * 0.0016);
        const w = Math.min(MAX_VIEW, Math.max(MIN_VIEW, this.view.w * factor));
        const applied = w / this.view.w;
        this.setView({
          x: focus.x - (focus.x - this.view.x) * applied,
          y: focus.y - (focus.y - this.view.y) * applied,
          w,
        });
      }, { passive: false });

      svg.addEventListener('pointerdown', (event) => {
        svg.setPointerCapture(event.pointerId);
        pointers.set(event.pointerId, event);
        downAt = { x: event.clientX, y: event.clientY };

        if (pointers.size === 2) {
          const [a, b] = [...pointers.values()];
          pinch = { distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), w: this.view.w };
          panFrom = null;
          return;
        }

        // Dragging a runway extension handle or the aircraft takes priority over
        // panning, so grabbing either does not slide the whole chart.
        const extHandle = event.target.closest?.('[data-ext]');
        if (extHandle && !this.measureEnabled) {
          drag = { kind: 'ext', role: extHandle.dataset.ext };
          return;
        }
        const own = event.target.closest?.('[data-ownship]');
        if (own && !this.measureEnabled) {
          drag = { kind: 'ownship' };
          return;
        }

        if (this.measureEnabled) {
          this.measure = { start: this.clientToMap(event), end: null, live: true };
          return;
        }
        panFrom = { map: this.clientToMap(event), view: { ...this.view } };
        svg.dataset.panning = 'true';
      });

      svg.addEventListener('pointermove', (event) => {
        if (!pointers.has(event.pointerId)) return;
        pointers.set(event.pointerId, event);

        if (pinch && pointers.size === 2) {
          const [a, b] = [...pointers.values()];
          const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
          if (distance > 0 && pinch.distance > 0) {
            const w = pinch.w * (pinch.distance / distance);
            const cx = this.view.x + this.view.w / 2;
            const cy = this.view.y + this.view.h / 2;
            const clamped = Math.min(MAX_VIEW, Math.max(MIN_VIEW, w));
            this.setView({ x: cx - clamped / 2, y: cy - clamped / this.aspect() / 2, w: clamped });
          }
          return;
        }

        if (drag?.kind === 'ext') {
          const geometry = window.Nav.route.extensionGeometry(drag.role);
          if (!geometry) return;
          const at = this.clientToMap(event);
          const projected = (at.x - geometry.origin.x) * geometry.direction.x
            + (at.y - geometry.origin.y) * geometry.direction.y;
          const nm = Math.max(0, Math.min(MAX_EXTENSION_NM, projected / MAP_UNITS_PER_NM));
          window.Nav.route.setExtensionFromDrag(drag.role, nm, false);
          return;
        }

        if (drag?.kind === 'ownship') {
          const at = this.clientToMap(event);
          window.Nav.instruments.setSimulated({ x: at.x, y: at.y });
          return;
        }

        if (this.measure?.live) {
          this.measure.end = this.clientToMap(event);
          this.drawMeasure();
          return;
        }

        if (!panFrom) return;
        const box = svg.getBoundingClientRect();
        const dx = (event.clientX - box.left) / box.width * panFrom.view.w;
        const dy = (event.clientY - box.top) / box.height * panFrom.view.h;
        this.setView({ x: panFrom.map.x - dx, y: panFrom.map.y - dy, w: panFrom.view.w });
      });

      const release = (event) => {
        pointers.delete(event.pointerId);
        if (pointers.size < 2) pinch = null;
        if (pointers.size > 0) return;

        if (drag?.kind === 'ext') {
          const state = drag.role === 'departure' ? window.Nav.route.depExt : window.Nav.route.arrExt;
          window.Nav.route.setExtensionFromDrag(drag.role, state.nm, true);
        }
        drag = null;
        panFrom = null;
        delete svg.dataset.panning;
        if (this.measure?.live) {
          this.measure.live = false;
          if (!this.measure.end) this.measure = null;
          this.drawMeasure();
        }
      };
      svg.addEventListener('pointerup', release);
      svg.addEventListener('pointercancel', release);

      const pick = (event) => {
        if (this.measureEnabled) return;
        // Measured in pixels rather than counting move events, because a plain
        // click can still emit several of them.
        if (downAt && Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y) > CLICK_SLOP_PX) return;
        if (event.target.closest?.('[data-ext],[data-ownship]')) return;
        const group = event.target.closest?.('.pick');
        if (!group) return;
        const point = this.points[group.dataset.name];
        if (!point) return;
        for (const handler of this.pickHandlers) handler(point, event);
      };
      svg.addEventListener('click', pick);
      svg.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const group = event.target.closest?.('.pick');
        if (!group) return;
        event.preventDefault();
        const point = this.points[group.dataset.name];
        if (point) for (const handler of this.pickHandlers) handler(point, event);
      });

      // Right-clicking a chart should not open a browser menu.
      svg.addEventListener('contextmenu', (event) => event.preventDefault());

      // Keep the viewBox aspect locked to the container. Without this the square
      // viewBox letterboxes inside a wide panel and the chart floats in dead
      // space, and the first measurement happens before layout has settled.
      const resync = () => this.setView({ ...this.view });
      if (typeof ResizeObserver === 'function') {
        new ResizeObserver(resync).observe(svg.parentElement || svg);
      }
      window.addEventListener('resize', resync);
    },

    onPick(handler) {
      this.pickHandlers.push(handler);
    },

    onMeasure(handler) {
      this.measureHandlers.push(handler);
    },
  };

  window.Nav.geo = geo;
  window.Nav.chart = chart;
  window.Nav.svgEl = el;
  window.Nav.svgClear = clear;
})();
