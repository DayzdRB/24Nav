/* ==========================================================================
   24Nav route
   Owns the route model: endpoints, runways, runway extension legs, the ordered
   fix list, climb and descent rates, and the filed flight-plan fields. Renders
   the route strip and builds the ATC24 /createflightplan command.
   ========================================================================== */

window.Nav = window.Nav || {};

(() => {
  'use strict';

  const STORE_KEY = '24nav.route.v2';
  const MAX_EXTENSION_NM = 20;

  const route = {
    departure: 'IRFD',
    arrival: 'IPPH',
    departureRunway: '',
    arrivalRunway: '',
    fixes: [],
    cruiseFl: 100,

    // Climb and descent rates drive the vertical profile and every waypoint
    // altitude target, so they live in the route rather than in the profile.
    climbVs: 2500,
    descentVs: 2000,
    planSpeedKt: 280,

    depExt: { on: false, nm: 1 },
    arrExt: { on: false, nm: 2 },

    plan: {
      ingameCallsign: '',
      filedCallsign: '',
      aircraft: '',
      flightRules: 'IFR',
      robloxName: '',
    },

    selection: null,
    listeners: [],

    runwaySource: { departure: 'track', arrival: 'track' },
    runwayManual: { departure: false, arrival: false },

    /* --- lookups -------------------------------------------------------- */

    point(code) {
      return window.Nav.chart.points[code] || null;
    },

    runwaysFor(code) {
      const all = window.ATC24_RUNWAY_DATA || {};
      return Array.isArray(all[code]) ? all[code] : [];
    },

    runwayGeometry(code, label) {
      const list = this.runwaysFor(code);
      const wanted = String(label || '').trim().toUpperCase();
      return list.find((r) => String(r.label).toUpperCase() === wanted) || null;
    },

    /** 07L and 25R are the two ends of the same strip. */
    reciprocal(label) {
      const match = /^(\d{1,2})([LCR]?)$/.exec(String(label || '').trim().toUpperCase());
      if (!match) return '';
      const number = ((Number(match[1]) + 18 - 1) % 36) + 1;
      const side = match[2] === 'L' ? 'R' : match[2] === 'R' ? 'L' : match[2];
      return String(number).padStart(2, '0') + side;
    },

    /** Unit vector pointing along a runway heading in map space. */
    headingVector(heading) {
      const radians = (Number(heading) || 0) * Math.PI / 180;
      return { x: Math.sin(radians), y: -Math.cos(radians) };
    },

    /**
     * Runway extension geometry, matching the FlightBrief and DHL behaviour.
     * The departure leg starts at the far end of the runway and runs out along
     * the departure heading. The arrival leg starts at the landing threshold and
     * runs back down the approach.
     */
    extensionGeometry(role) {
      const departure = role === 'departure';
      const code = departure ? this.departure : this.arrival;
      const label = departure ? this.departureRunway : this.arrivalRunway;
      const geometry = this.runwayGeometry(code, label);
      if (!geometry) return null;
      const vector = this.headingVector(geometry.heading);

      if (departure) {
        const other = this.runwayGeometry(code, this.reciprocal(geometry.label));
        if (!other) return null;
        return { role, origin: { x: other.x, y: other.y }, direction: vector, runway: geometry.label };
      }
      return {
        role,
        origin: { x: geometry.x, y: geometry.y },
        direction: { x: -vector.x, y: -vector.y },
        runway: geometry.label,
      };
    },

    /**
     * Endpoint position. This is the threshold of the runway in use, not the
     * airport reference point: you line up on 25L and you land on 33, so every
     * distance, heading and final approach is measured from the threshold.
     * IBAR and IUFO have no runway data, so those fall back to the airport point.
     */
    endpointNode(role) {
      const code = role === 'departure' ? this.departure : this.arrival;
      const label = role === 'departure' ? this.departureRunway : this.arrivalRunway;
      const airport = this.point(code);
      if (!airport) return null;
      const runway = this.runwayGeometry(code, label);
      if (!runway) {
        return { ...airport, role, altitude: 0, runway: null, label: code };
      }
      return {
        name: code,
        kind: 'airport',
        role,
        altitude: 0,
        runway: runway.label,
        heading: runway.heading,
        x: runway.x,
        y: runway.y,
        label: `${code}/${runway.label}`,
      };
    },

    extensionPoint(role) {
      const state = role === 'departure' ? this.depExt : this.arrExt;
      if (!state.on) return null;
      const geometry = this.extensionGeometry(role);
      if (!geometry) return null;
      const units = state.nm * window.Nav.geo.MAP_UNITS_PER_NM;
      return {
        name: `${geometry.runway}+${state.nm.toFixed(1)}`,
        label: `${geometry.runway}+${state.nm.toFixed(1)} NM`,
        kind: 'extension',
        role: role === 'departure' ? 'depExt' : 'arrExt',
        runway: geometry.runway,
        x: geometry.origin.x + geometry.direction.x * units,
        y: geometry.origin.y + geometry.direction.y * units,
      };
    },

    /* --- geometry ------------------------------------------------------- */

    nodes() {
      const list = [];
      const dep = this.endpointNode('departure');
      if (dep) list.push(dep);

      const depExt = this.extensionPoint('departure');
      if (depExt) list.push({ ...depExt, altitude: null });

      for (const fix of this.fixes) {
        const point = this.point(fix.name);
        if (point) list.push({ ...point, label: point.name, role: 'fix', altitude: fix.altitude });
      }

      const arrExt = this.extensionPoint('arrival');
      if (arrExt) list.push({ ...arrExt, altitude: null });

      const arr = this.endpointNode('arrival');
      if (arr) list.push(arr);
      return list;
    },

    legs() {
      const nodes = this.nodes();
      const out = [];
      for (let i = 0; i < nodes.length - 1; i += 1) {
        out.push({
          index: i,
          from: nodes[i],
          to: nodes[i + 1],
          nm: window.Nav.geo.distanceNm(nodes[i], nodes[i + 1]),
          heading: window.Nav.geo.bearing(nodes[i], nodes[i + 1]),
        });
      }
      return out;
    },

    totalNm() {
      return this.legs().reduce((sum, leg) => sum + leg.nm, 0);
    },

    /** Only named fixes go in the filed route. Extensions are local geometry. */
    routeString() {
      return this.fixes.map((f) => f.name).join(' ') || 'DCT';
    },

    isDirect() {
      return this.fixes.length === 0;
    },

    /* --- flight plan command -------------------------------------------- */

    flightLevel() {
      return String(Math.round(this.cruiseFl)).padStart(3, '0');
    },

    command() {
      const clean = (value, fallback = 'N/A') => {
        const text = String(value || '').trim().replace(/\s+/g, ' ');
        return text || fallback;
      };
      return [
        '/createflightplan',
        `ingamecallsign:${clean(this.plan.ingameCallsign)}`,
        `callsign:${clean(this.plan.filedCallsign || this.plan.ingameCallsign)}`,
        `aircraft:${clean(this.plan.aircraft)}`,
        `flightrules:${clean(this.plan.flightRules, 'IFR').toUpperCase()}`,
        `departing:${clean(this.departure)}`,
        `arriving:${clean(this.arrival)}`,
        `flightlevel:${this.flightLevel()}`,
        `ingamename:${clean(this.plan.robloxName)}`,
        `route:${this.routeString()}`,
      ].join(' ');
    },

    missingPlanFields() {
      const missing = [];
      if (!String(this.plan.ingameCallsign).trim()) missing.push('in-game callsign');
      if (!String(this.plan.aircraft).trim()) missing.push('aircraft');
      if (!String(this.plan.robloxName).trim()) missing.push('Roblox username');
      if (!this.departureRunway) missing.push('departure runway');
      if (!this.arrivalRunway) missing.push('arrival runway');
      return missing;
    },

    /* --- mutation ------------------------------------------------------- */

    setEndpoint(role, code) {
      if (!this.point(code)) return;
      const changed = code !== (role === 'departure' ? this.departure : this.arrival);
      if (role === 'departure') this.departure = code;
      else this.arrival = code;
      // A manual runway belongs to the airport it was chosen at, so moving to a
      // different airport releases it. Staying put keeps the pilot's choice.
      if (changed) this.runwayManual[role] = false;
      this.refreshRunway(role, changed);
      this.commit();
    },

    /**
     * Chooses a runway the way a pilot would, in priority order:
     *
     *   1. The runway the ATIS says is in use.
     *   2. Into wind, if the ATIS reports a wind direction.
     *   3. Only as a last resort, whichever end points nearest the route track.
     *
     * The old code went straight to step 3, which is wrong: it picked IRFD 07L
     * for a flight to IPPH purely because IPPH lies to the north-east, sending
     * the departure out over LAVNO when the field may well be operating the 25s
     * towards MOGTA. Destination bearing has nothing to do with runway choice.
     */
    chooseRunway(code, role) {
      const list = this.runwaysFor(code);
      if (!list.length) return { label: '', source: 'none' };

      const nearestTo = (target) => {
        let best = list[0];
        let bestDelta = 361;
        for (const runway of list) {
          const delta = Math.abs(((Number(runway.heading) - target + 540) % 360) - 180);
          if (delta < bestDelta) {
            bestDelta = delta;
            best = runway;
          }
        }
        return best.label;
      };

      const atis = window.Nav.live?.atisFor?.(code) || null;

      const inUse = role === 'departure' ? atis?.departureRunways : atis?.arrivalRunways;
      for (const label of inUse || []) {
        if (this.runwayGeometry(code, label)) return { label, source: 'atis' };
      }

      const wind = Number(atis?.wind?.direction);
      if (Number.isFinite(wind)) {
        // Into wind, so the runway heading matches the direction it blows from.
        return { label: nearestTo(wind), source: 'wind' };
      }

      const other = role === 'departure' ? this.point(this.arrival) : this.point(this.departure);
      const here = this.point(code);
      if (!other || !here) return { label: list[0].label, source: 'first' };
      const track = role === 'departure'
        ? window.Nav.geo.bearing(here, other)
        : window.Nav.geo.bearing(other, here);
      return { label: nearestTo(track), source: 'track' };
    },

    defaultRunway(code, role) {
      return this.chooseRunway(code, role).label;
    },

    /** Re-picks a runway unless the pilot has chosen one by hand. */
    refreshRunway(role, force = false) {
      const code = role === 'departure' ? this.departure : this.arrival;
      if (this.runwayManual[role] && !force) return false;
      const chosen = this.chooseRunway(code, role);
      const current = role === 'departure' ? this.departureRunway : this.arrivalRunway;
      this.runwaySource[role] = chosen.source;
      if (chosen.label === current) return false;
      if (role === 'departure') this.departureRunway = chosen.label;
      else this.arrivalRunway = chosen.label;
      return true;
    },

    setRunway(role, label) {
      if (role === 'departure') this.departureRunway = String(label || '');
      else this.arrivalRunway = String(label || '');
      // Chosen by hand, so nothing may quietly override it.
      this.runwayManual[role] = true;
      this.runwaySource[role] = 'manual';
      this.commit();
    },

    setExtension(role, patch) {
      const state = role === 'departure' ? this.depExt : this.arrExt;
      if ('on' in patch) state.on = Boolean(patch.on);
      if ('nm' in patch) {
        const value = Number(patch.nm);
        state.nm = Number.isFinite(value)
          ? Math.min(MAX_EXTENSION_NM, Math.max(0, Math.round(value * 10) / 10))
          : state.nm;
      }
      this.commit();
    },

    /** Drag handler contract shared with the chart. */
    setExtensionFromDrag(role, nm, final = false) {
      const state = role === 'departure' ? this.depExt : this.arrExt;
      if (nm < 0.15) {
        state.nm = 0;
        if (final) {
          state.on = false;
          state.nm = role === 'departure' ? 1 : 2;
        }
      } else {
        state.on = true;
        state.nm = Math.min(MAX_EXTENSION_NM, Math.round(nm * 10) / 10);
      }
      this.commit();
    },

    swapEndpoints() {
      const dep = this.departure;
      this.departure = this.arrival;
      this.arrival = dep;
      this.fixes.reverse();
      this.runwayManual.departure = false;
      this.runwayManual.arrival = false;
      this.refreshRunway('departure', true);
      this.refreshRunway('arrival', true);
      this.commit();
    },

    setCruise(fl) {
      const value = Number(fl);
      if (!Number.isFinite(value)) return;
      this.cruiseFl = Math.min(450, Math.max(10, Math.round(value / 10) * 10));
      this.commit();
    },

    setVerticalSpeed(which, value) {
      const number = Number(value);
      if (!Number.isFinite(number)) return;
      const clamped = Math.min(6000, Math.max(300, Math.round(number / 100) * 100));
      if (which === 'climb') this.climbVs = clamped;
      if (which === 'descent') this.descentVs = clamped;
      this.commit();
    },

    setPlanSpeed(value) {
      const number = Number(value);
      if (!Number.isFinite(number)) return;
      this.planSpeedKt = Math.min(600, Math.max(80, Math.round(number / 5) * 5));
      this.commit();
    },

    setPlanField(field, value) {
      if (!(field in this.plan)) return;
      this.plan[field] = String(value || '');
      this.commit();
    },

    /**
     * Adds a fix to the route. `mode` mirrors the two actions on the chart
     * popover: 'anchor' inserts relative to the currently selected route point,
     * 'end' always appends. After an insert the anchor moves to the new fix so
     * clicking several fixes in a row builds the route in order.
     */
    addPoint(point, mode = 'anchor') {
      if (!point) return;

      const anchored = mode === 'anchor' ? this.selection : null;
      const at = anchored?.type === 'fix' ? Math.min(this.fixes.length, anchored.index + 1)
        : anchored?.type === 'departure' ? 0
        : this.fixes.length;

      const before = this.fixes[at - 1]?.name;
      const after = this.fixes[at]?.name;
      const touchesEndpoint = (at === 0 && point.name === this.departure)
        || (at === this.fixes.length && point.name === this.arrival);
      const duplicate = point.name === before || point.name === after || touchesEndpoint;

      if (duplicate && !window.confirm(`${point.name} is already next to this position. Add it again?`)) return;

      this.fixes.splice(at, 0, { name: point.name, altitude: null });
      this.selection = { type: 'fix', index: at };
      return this.commit();
    },

    /** Anchor selection, set by clicking a route point on the chart or a row. */
    setAnchor(anchor) {
      this.selection = anchor;
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
      const digits = String(value).replace(/[^\d]/g, '');
      if (!digits) {
        fix.altitude = null;
      } else {
        const number = Number(digits);
        // Three digits or fewer reads as a flight level, more reads as feet.
        fix.altitude = digits.length <= 3 ? number * 100 : number;
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
          departureRunway: this.departureRunway,
          arrivalRunway: this.arrivalRunway,
          fixes: this.fixes,
          cruiseFl: this.cruiseFl,
          climbVs: this.climbVs,
          descentVs: this.descentVs,
          planSpeedKt: this.planSpeedKt,
          depExt: this.depExt,
          arrExt: this.arrExt,
          plan: this.plan,
        }));
      } catch (error) {
        // Storage can be blocked. The route still works for this session.
      }
    },

    restore() {
      let saved = null;
      try {
        saved = JSON.parse(window.localStorage.getItem(STORE_KEY) || 'null');
      } catch (error) {
        saved = null;
      }
      if (saved) {
        if (this.point(saved.departure)) this.departure = saved.departure;
        if (this.point(saved.arrival)) this.arrival = saved.arrival;
        if (Number.isFinite(Number(saved.cruiseFl))) this.cruiseFl = Number(saved.cruiseFl);
        if (Number.isFinite(Number(saved.climbVs))) this.climbVs = Number(saved.climbVs);
        if (Number.isFinite(Number(saved.descentVs))) this.descentVs = Number(saved.descentVs);
        if (Number.isFinite(Number(saved.planSpeedKt))) this.planSpeedKt = Number(saved.planSpeedKt);
        if (Array.isArray(saved.fixes)) {
          this.fixes = saved.fixes
            .filter((f) => this.point(f?.name))
            .map((f) => ({ name: f.name, altitude: Number.isFinite(Number(f.altitude)) ? Number(f.altitude) : null }));
        }
        for (const [key, target] of [['depExt', this.depExt], ['arrExt', this.arrExt]]) {
          const value = saved[key];
          if (!value) continue;
          target.on = Boolean(value.on);
          if (Number.isFinite(Number(value.nm))) {
            target.nm = Math.min(MAX_EXTENSION_NM, Math.max(0, Number(value.nm)));
          }
        }
        if (saved.plan && typeof saved.plan === 'object') {
          for (const field of Object.keys(this.plan)) {
            if (typeof saved.plan[field] === 'string') this.plan[field] = saved.plan[field];
          }
        }
        if (this.runwayGeometry(this.departure, saved.departureRunway)) {
          this.departureRunway = saved.departureRunway;
        }
        if (this.runwayGeometry(this.arrival, saved.arrivalRunway)) {
          this.arrivalRunway = saved.arrivalRunway;
        }
      }
      if (!this.departureRunway) this.refreshRunway('departure', true);
      if (!this.arrivalRunway) this.refreshRunway('arrival', true);
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
        if (type === 'depExt' || type === 'arrExt') return;
        route.select(type === 'fix' ? { type, index: Number(leg.dataset.selectIndex) } : { type });
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
      const targets = window.Nav.profile.waypointTargets();
      this.list.innerHTML = '';
      this.empty.classList.toggle('u-hidden', route.fixes.length > 0);

      let fixIndex = -1;
      nodes.forEach((node, i) => {
        const isFix = node.role === 'fix';
        if (isFix) fixIndex += 1;
        const localIndex = fixIndex;
        const isExtension = node.kind === 'extension';
        const selected = route.selection?.type === node.role
          && (!isFix || route.selection.index === localIndex);

        const item = document.createElement('li');
        const row = document.createElement('div');
        row.className = `leg${isFix ? '' : ' leg--endpoint'}${isExtension ? ' leg--extension' : ''}`;
        row.dataset.selectType = node.role;
        row.dataset.selectIndex = String(isFix ? localIndex : -1);
        if (!isExtension) {
          row.setAttribute('role', 'button');
          row.tabIndex = 0;
        }
        if (selected) row.setAttribute('aria-current', 'true');

        const pin = document.createElement('span');
        pin.className = 'leg__pin';
        pin.textContent = node.role === 'departure' ? 'DEP'
          : node.role === 'arrival' ? 'ARR'
          : isExtension ? 'EXT'
          : String(localIndex + 1);

        const body = document.createElement('span');
        const name = document.createElement('span');
        name.className = 'leg__name';
        name.textContent = node.label || node.name;
        const meta = document.createElement('span');
        meta.className = 'leg__meta';
        const inbound = legs[i - 1];
        const target = targets[i];
        const parts = [];
        if (inbound) parts.push(`${window.Nav.geo.padHeading(inbound.heading)}\u00B0 ${inbound.nm.toFixed(1)} NM`);
        else parts.push(node.kind === 'airport' ? 'Airport' : 'Fix');
        if (target && target.targetFt > 0) {
          parts.push(`${target.source === 'constraint' ? 'AT' : 'plan'} ${window.Nav.profile.formatAltitude(target.targetFt)}`);
        }
        meta.textContent = parts.join('   ');
        body.appendChild(name);
        body.appendChild(meta);

        const tail = document.createElement('span');
        tail.className = 'leg__tail';
        if (isFix) {
          const alt = document.createElement('input');
          alt.className = 'leg__alt u-data';
          alt.dataset.alt = String(localIndex);
          alt.placeholder = target ? String(Math.round(target.targetFt / 100)).padStart(3, '0') : 'FL';
          alt.value = node.altitude ? String(Math.round(node.altitude / 100)).padStart(3, '0') : '';
          alt.setAttribute('aria-label', `Altitude constraint at ${node.name}`);
          const drop = document.createElement('button');
          drop.type = 'button';
          drop.className = 'leg__drop';
          drop.dataset.drop = String(localIndex);
          drop.title = `Remove ${node.name}`;
          drop.setAttribute('aria-label', `Remove ${node.name}`);
          drop.textContent = '\u00D7';
          tail.appendChild(alt);
          tail.appendChild(drop);
        }

        row.appendChild(pin);
        row.appendChild(body);
        row.appendChild(tail);
        item.appendChild(row);
        this.list.appendChild(item);
      });
    },
  };

  window.Nav.route = route;
  window.Nav.strip = strip;
})();
