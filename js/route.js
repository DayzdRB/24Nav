/* ==========================================================================
   24Nav route
   Holds the route model, renders the route strip, and keeps the chart, the
   readouts and the vertical profile in step. Departure and arrival are
   endpoints; everything between them is an ordered list of fixes.
   ========================================================================== */

window.Nav = window.Nav || {};

(() => {
  'use strict';

  const STORE_KEY = '24nav.route.v1';

  const route = {
    departure: 'IRFD',
    arrival: 'IPPH',
    fixes: [],
    cruiseFl: 100,
    selection: null,
    listeners: [],

    /* --- model ---------------------------------------------------------- */

    point(code) {
      return window.Nav.chart.points[code] || null;
    },

    nodes() {
      const list = [];
      const dep = this.point(this.departure);
      if (dep) list.push({ ...dep, role: 'departure', altitude: 0 });
      for (const fix of this.fixes) {
        const point = this.point(fix.name);
        if (point) list.push({ ...point, role: 'fix', altitude: fix.altitude });
      }
      const arr = this.point(this.arrival);
      if (arr) list.push({ ...arr, role: 'arrival', altitude: 0 });
      return list;
    },

    legs() {
      const nodes = this.nodes();
      const out = [];
      for (let i = 0; i < nodes.length - 1; i += 1) {
        const a = nodes[i];
        const b = nodes[i + 1];
        out.push({
          from: a,
          to: b,
          nm: window.Nav.geo.distanceNm(a, b),
          heading: window.Nav.geo.bearing(a, b),
        });
      }
      return out;
    },

    totalNm() {
      return this.legs().reduce((sum, leg) => sum + leg.nm, 0);
    },

    routeString() {
      return this.fixes.map((f) => f.name).join(' ') || 'DCT';
    },

    /* --- mutation ------------------------------------------------------- */

    setEndpoint(role, code) {
      if (!this.point(code)) return;
      if (role === 'departure') this.departure = code;
      if (role === 'arrival') this.arrival = code;
      this.commit();
    },

    swapEndpoints() {
      const dep = this.departure;
      this.departure = this.arrival;
      this.arrival = dep;
      this.fixes.reverse();
      this.commit();
    },

    setCruise(fl) {
      const value = Number(fl);
      if (!Number.isFinite(value)) return;
      this.cruiseFl = Math.min(450, Math.max(10, Math.round(value / 10) * 10));
      this.commit();
    },

    /** Insert a picked chart point according to the current selection. */
    addPoint(point) {
      if (!point) return;

      if (this.selection?.type === 'departure' && point.kind === 'airport') {
        this.departure = point.name;
        this.selection = null;
        this.commit();
        return;
      }
      if (this.selection?.type === 'arrival' && point.kind === 'airport') {
        this.arrival = point.name;
        this.selection = null;
        this.commit();
        return;
      }

      const at = this.selection?.type === 'fix' ? this.selection.index + 1
        : this.selection?.type === 'departure' ? 0
        : this.fixes.length;

      const before = this.fixes[at - 1]?.name;
      const after = this.fixes[at]?.name;
      const touchesEndpoint = (at === 0 && point.name === this.departure)
        || (at === this.fixes.length && point.name === this.arrival);
      const duplicate = point.name === before || point.name === after || touchesEndpoint;

      if (duplicate && !window.confirm(`${point.name} is already next to this position. Add it again?`)) return;

      this.fixes.splice(at, 0, { name: point.name, altitude: null });
      this.selection = { type: 'fix', index: at };
      this.commit();
    },

    removeFix(index) {
      if (index < 0 || index >= this.fixes.length) return;
      this.fixes.splice(index, 1);
      if (this.selection?.type === 'fix' && this.selection.index >= this.fixes.length) {
        this.selection = null;
      }
      this.commit();
    },

    setFixAltitude(index, value) {
      const fix = this.fixes[index];
      if (!fix) return;
      const clean = String(value).trim();
      if (!clean) {
        fix.altitude = null;
      } else {
        const number = Number(clean.replace(/[^\d]/g, ''));
        if (!Number.isFinite(number) || number <= 0) {
          fix.altitude = null;
        } else {
          // Three digits or fewer is read as a flight level, anything more as feet.
          fix.altitude = clean.replace(/[^\d]/g, '').length <= 3 ? number * 100 : number;
        }
      }
      this.commit();
    },

    select(selection) {
      const same = JSON.stringify(this.selection) === JSON.stringify(selection);
      this.selection = same ? null : selection;
      this.commit();
    },

    clear() {
      this.fixes = [];
      this.selection = null;
      this.commit();
    },

    /* --- plumbing ------------------------------------------------------- */

    onChange(handler) {
      this.listeners.push(handler);
    },

    commit() {
      this.save();
      for (const handler of this.listeners) handler(this);
    },

    save() {
      try {
        window.localStorage.setItem(STORE_KEY, JSON.stringify({
          departure: this.departure,
          arrival: this.arrival,
          fixes: this.fixes,
          cruiseFl: this.cruiseFl,
        }));
      } catch (error) {
        // Storage can be blocked. The route still works for this session.
      }
    },

    restore() {
      try {
        const raw = window.localStorage.getItem(STORE_KEY);
        if (!raw) return;
        const saved = JSON.parse(raw);
        if (this.point(saved.departure)) this.departure = saved.departure;
        if (this.point(saved.arrival)) this.arrival = saved.arrival;
        if (Number.isFinite(Number(saved.cruiseFl))) this.cruiseFl = Number(saved.cruiseFl);
        if (Array.isArray(saved.fixes)) {
          this.fixes = saved.fixes
            .filter((f) => this.point(f?.name))
            .map((f) => ({ name: f.name, altitude: Number.isFinite(Number(f.altitude)) ? Number(f.altitude) : null }));
        }
      } catch (error) {
        // Ignore malformed storage and start with the default route.
      }
    },
  };

  /* --- rail rendering --------------------------------------------------- */

  const strip = {
    list: null,
    empty: null,

    init() {
      this.list = document.getElementById('strip');
      this.empty = document.getElementById('stripEmpty');
      this.list.addEventListener('click', (event) => {
        const drop = event.target.closest('[data-drop]');
        if (drop) {
          event.stopPropagation();
          route.removeFix(Number(drop.dataset.drop));
          return;
        }
        const leg = event.target.closest('[data-select-type]');
        if (!leg) return;
        const type = leg.dataset.selectType;
        const index = Number(leg.dataset.selectIndex);
        route.select(type === 'fix' ? { type, index } : { type });
      });
      this.list.addEventListener('change', (event) => {
        const input = event.target.closest('[data-alt]');
        if (!input) return;
        route.setFixAltitude(Number(input.dataset.alt), input.value);
      });
    },

    render() {
      const legs = route.legs();
      const nodes = route.nodes();
      this.list.innerHTML = '';
      this.empty.classList.toggle('u-hidden', route.fixes.length > 0);

      nodes.forEach((node, i) => {
        const isFix = node.role === 'fix';
        const fixIndex = i - 1;
        const selected = route.selection?.type === node.role
          && (!isFix || route.selection.index === fixIndex);

        const item = document.createElement('li');
        const button = document.createElement('div');
        button.className = `leg${isFix ? '' : ' leg--endpoint'}`;
        button.setAttribute('role', 'button');
        button.tabIndex = 0;
        button.dataset.selectType = node.role;
        button.dataset.selectIndex = String(isFix ? fixIndex : -1);
        if (selected) button.setAttribute('aria-current', 'true');

        const pin = document.createElement('span');
        pin.className = 'leg__pin';
        pin.textContent = node.role === 'departure' ? 'DEP' : node.role === 'arrival' ? 'ARR' : String(fixIndex + 1);

        const body = document.createElement('span');
        const name = document.createElement('span');
        name.className = 'leg__name';
        name.textContent = node.name;
        const meta = document.createElement('span');
        meta.className = 'leg__meta';
        const inbound = legs[i - 1];
        meta.textContent = inbound
          ? `${window.Nav.geo.padHeading(inbound.heading)}\u00B0  ${inbound.nm.toFixed(1)} NM`
          : node.kind === 'airport' ? 'Airport' : 'Fix';
        body.appendChild(name);
        body.appendChild(meta);

        const tail = document.createElement('span');
        if (isFix) {
          const alt = document.createElement('input');
          alt.className = 'leg__alt u-data';
          alt.dataset.alt = String(fixIndex);
          alt.placeholder = 'FL';
          alt.value = node.altitude ? String(Math.round(node.altitude / 100)).padStart(3, '0') : '';
          alt.setAttribute('aria-label', `Altitude constraint at ${node.name}`);
          const drop = document.createElement('button');
          drop.type = 'button';
          drop.className = 'leg__drop';
          drop.dataset.drop = String(fixIndex);
          drop.title = `Remove ${node.name}`;
          drop.setAttribute('aria-label', `Remove ${node.name}`);
          drop.textContent = '\u00D7';
          tail.appendChild(alt);
          tail.appendChild(drop);
        }

        button.appendChild(pin);
        button.appendChild(body);
        button.appendChild(tail);
        item.appendChild(button);
        this.list.appendChild(item);
      });
    },
  };

  window.Nav.route = route;
  window.Nav.strip = strip;
})();
