/* ==========================================================================
   24Nav vertical profile
   Builds the planned vertical path and the altitude every waypoint should be
   reached at, draws it against distance with ATIS cloud decks and the 250 kt
   below 3000 ft envelope, and feeds the vertical guidance instrument.

   Gradients come from the pilot's selected climb and descent rates rather than
   from real-world figures. The planekit moves aircraft at 0.5442765 studs/sec
   per knot instead of the true 0.918650795, so an aircraft reading 280 kt
   crosses the ground at 280 * 0.592172785 = 166 kt:

     ft per NM = rate(fpm) / (indicated_kt * 0.592172785 / 60)

   The feed also slows aircraft linearly above 2000 ft, which makes the real
   gradients slightly steeper still.
   ========================================================================== */

window.Nav = window.Nav || {};

(() => {
  'use strict';

  const GAME_KNOT_TO_REAL = 0.592172785;
  const SPEED_LIMIT_ALT = 3000;
  const PAD = { top: 16, right: 14, bottom: 24, left: 48 };
  const COVER_LABEL = { FEW: 'FEW', SCT: 'SCT', BKN: 'BKN', OVC: 'OVC', VV: 'VV' };

  const profile = {
    svg: null,
    atis: { departure: null, arrival: null },
    note: '',
    built: null,

    init() {
      this.svg = document.getElementById('profileSvg');
      if (!this.svg) return;
      if (typeof ResizeObserver === 'function') {
        new ResizeObserver(() => this.render()).observe(this.svg.parentElement);
      } else {
        window.addEventListener('resize', () => this.render());
      }
    },

    /* --- gradients ------------------------------------------------------ */

    groundNmPerMinute() {
      const indicated = Number(window.Nav.route.planSpeedKt) || 280;
      return Math.max(0.5, indicated * GAME_KNOT_TO_REAL / 60);
    },

    climbGradient() {
      return (Number(window.Nav.route.climbVs) || 2500) / this.groundNmPerMinute();
    },

    descentGradient() {
      return (Number(window.Nav.route.descentVs) || 2000) / this.groundNmPerMinute();
    },

    formatAltitude(ft) {
      const value = Math.max(0, Math.round(Number(ft) || 0));
      if (value >= 1000) return `FL${String(Math.round(value / 100)).padStart(3, '0')}`;
      return `${value} ft`;
    },

    /* --- ATIS cloud parsing --------------------------------------------- */

    /**
     * Pulls cloud layers out of an ATIS body. Handles FEW/SCT/BKN/OVC plus
     * vertical visibility, and treats CAVOK/SKC/CLR/NCD/NSC as no cloud.
     * Heights are hundreds of feet in the report, returned as feet.
     */
    parseAtisClouds(text) {
      const body = String(text || '').toUpperCase();
      if (!body) return [];
      if (/\b(CAVOK|SKC|CLR|NCD|NSC)\b/.test(body)) return [];
      const layers = [];
      const pattern = /\b(FEW|SCT|BKN|OVC|VV)(\d{3})\b/g;
      let match = pattern.exec(body);
      while (match) {
        const baseFt = Number(match[2]) * 100;
        if (Number.isFinite(baseFt)) {
          layers.push({ cover: match[1], baseFt, topFt: baseFt + (match[1] === 'FEW' ? 800 : 2000) });
        }
        match = pattern.exec(body);
      }
      return layers.sort((a, b) => a.baseFt - b.baseFt);
    },

    setAtis(role, text) {
      if (role !== 'departure' && role !== 'arrival') return;
      this.atis[role] = { text: String(text || ''), layers: this.parseAtisClouds(text) };
      this.render();
    },

    ceilingFt(role) {
      const layers = this.atis[role]?.layers || [];
      const solid = layers.find((l) => l.cover === 'BKN' || l.cover === 'OVC' || l.cover === 'VV');
      return solid ? solid.baseFt : null;
    },

    /* --- path construction ---------------------------------------------- */

    /** Cumulative distance for every route node. */
    stations() {
      const nodes = window.Nav.route.nodes();
      let run = 0;
      return nodes.map((node, i) => {
        if (i > 0) run += window.Nav.geo.distanceNm(nodes[i - 1], node);
        return { name: node.name, role: node.role, kind: node.kind, d: run, altitude: node.altitude };
      });
    },

    /**
     * Anchors are the points the path must pass through: both ends on the
     * surface, plus any fix carrying an altitude constraint. A cruise plateau is
     * then placed in whichever segment can carry the most height, so a route
     * that cannot reach the filed level still climbs and descends through every
     * altitude the pilot asked for.
     */
    buildPath(stations, cruiseFt) {
      const climb = this.climbGradient();
      const descent = this.descentGradient();
      const total = stations.length ? stations[stations.length - 1].d : 0;
      if (total <= 0) return { points: [], total: 0, cruiseFt, note: '' };

      const anchors = [{ d: 0, alt: 0 }];
      for (const station of stations) {
        if (station.role === 'fix' && Number.isFinite(station.altitude) && station.altitude > 0) {
          anchors.push({ d: station.d, alt: station.altitude, fix: station.name });
        }
      }
      anchors.push({ d: total, alt: 0 });

      let best = { index: -1, peak: -Infinity, room: -Infinity, at: 0 };
      for (let i = 0; i < anchors.length - 1; i += 1) {
        const a = anchors[i];
        const b = anchors[i + 1];
        const span = b.d - a.d;
        if (span <= 0) continue;

        const climbDistance = (b.alt - a.alt + descent * span) / (climb + descent);
        const unclamped = a.alt + climb * climbDistance;
        const peak = Math.min(cruiseFt, Math.max(a.alt, b.alt, unclamped));
        const need = (peak - a.alt) / climb + (peak - b.alt) / descent;
        const room = span - need;

        if (peak > best.peak + 1 || (Math.abs(peak - best.peak) <= 1 && room > best.room)) {
          best = { index: i, peak, room, at: a.d + climbDistance };
        }
      }

      const points = [];
      for (let i = 0; i < anchors.length - 1; i += 1) {
        const a = anchors[i];
        const b = anchors[i + 1];
        points.push({ ...a });
        if (i !== best.index) continue;

        if (best.room > 0.05) {
          points.push({ d: a.d + (best.peak - a.alt) / climb, alt: best.peak, mark: 'TOC' });
          points.push({ d: b.d - (best.peak - b.alt) / descent, alt: best.peak, mark: 'TOD' });
        } else if (best.peak > Math.max(a.alt, b.alt) + 1) {
          // No level segment fits, so draw the achievable peak rather than a
          // level-off the aircraft could never hold.
          points.push({ d: best.at, alt: best.peak, mark: 'TOC' });
        }
      }
      points.push({ ...anchors[anchors.length - 1] });

      const achieved = Math.max(...points.map((p) => p.alt));
      const note = achieved < cruiseFt - 50
        ? `Too short for FL${String(Math.round(cruiseFt / 100)).padStart(3, '0')} at ${Math.round(window.Nav.route.climbVs)} fpm. Best is ${this.formatAltitude(achieved)}.`
        : '';

      return { points, total, cruiseFt: Math.max(achieved, 1000), note };
    },

    current() {
      if (!this.built) this.recompute();
      return this.built;
    },

    recompute() {
      const stations = this.stations();
      this.built = this.buildPath(stations, window.Nav.route.cruiseFl * 100);
      this.built.stations = stations;
      this.note = this.built.note;
      return this.built;
    },

    /** Altitude of the planned path at a given along-track distance. */
    altitudeAt(points, d) {
      if (!points?.length) return 0;
      if (d <= points[0].d) return points[0].alt;
      for (let i = 0; i < points.length - 1; i += 1) {
        const a = points[i];
        const b = points[i + 1];
        if (d < a.d || d > b.d) continue;
        if (b.d === a.d) return b.alt;
        return a.alt + (b.alt - a.alt) * ((d - a.d) / (b.d - a.d));
      }
      return points[points.length - 1].alt;
    },

    targetAt(d) {
      return this.altitudeAt(this.current().points, d);
    },

    /**
     * The altitude to be at over each route node, aligned index for index with
     * route.nodes(). A fix carrying a constraint reports it; everything else
     * reports the planned path, which on a direct route is set purely by the
     * selected climb and descent rates.
     */
    waypointTargets() {
      const built = this.recompute();
      return built.stations.map((station) => ({
        name: station.name,
        role: station.role,
        d: station.d,
        targetFt: Math.round(this.altitudeAt(built.points, station.d)),
        source: Number.isFinite(station.altitude) && station.altitude > 0 ? 'constraint' : 'computed',
      }));
    },

    /** Distance at which the path first passes above the speed-limit altitude. */
    limitCrossing(points) {
      return this.limitCrossings(points).out;
    },

    /**
     * The limit bites at both ends of a flight, so report the climb crossing and
     * the descent crossing. `back` is measured from the destination.
     */
    limitCrossings(points) {
      const at = (a, b) => {
        const t = (SPEED_LIMIT_ALT - a.alt) / (b.alt - a.alt);
        return a.d + (b.d - a.d) * t;
      };
      let out = null;
      let inbound = null;
      for (let i = 0; i < points.length - 1; i += 1) {
        const a = points[i];
        const b = points[i + 1];
        if (out === null && a.alt < SPEED_LIMIT_ALT && b.alt >= SPEED_LIMIT_ALT) out = at(a, b);
        if (a.alt >= SPEED_LIMIT_ALT && b.alt < SPEED_LIMIT_ALT) inbound = at(a, b);
      }
      const total = points.length ? points[points.length - 1].d : 0;
      return { out, inbound, back: inbound === null ? null : total - inbound };
    },

    /* --- render ---------------------------------------------------------- */

    render() {
      if (!this.svg) return;
      const el = window.Nav.svgEl;
      const box = this.svg.parentElement.getBoundingClientRect();
      const W = Math.max(320, Math.round(box.width));
      const H = Math.max(110, Math.round(box.height));
      this.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      window.Nav.svgClear(this.svg);

      const built = this.recompute();
      const stations = built.stations;
      const plotW = W - PAD.left - PAD.right;
      const plotH = H - PAD.top - PAD.bottom;
      const topFt = Math.max(6000, Math.ceil((built.cruiseFt * 1.18) / 5000) * 5000);
      const total = built.total;

      const X = (d) => PAD.left + (total > 0 ? (d / total) * plotW : 0);
      const Y = (alt) => PAD.top + plotH - (Math.max(0, alt) / topFt) * plotH;

      this.svg.appendChild(el('rect', {
        class: 'profile-ground', x: PAD.left, y: Y(0), width: plotW, height: PAD.bottom - 6,
      }));

      this.svg.appendChild(el('rect', {
        class: 'profile-limit',
        x: PAD.left, y: Y(SPEED_LIMIT_ALT), width: plotW, height: Y(0) - Y(SPEED_LIMIT_ALT),
      }));
      // The shaded band and the legend chip carry this, so no caption is drawn
      // inside the plot where it would fight the aircraft marker for the middle
      // of the strip.

      const decks = [
        { role: 'departure', x: PAD.left, width: plotW * 0.26 },
        { role: 'arrival', x: PAD.left + plotW * 0.74, width: plotW * 0.26 },
      ];
      for (const deck of decks) {
        for (const layer of this.atis[deck.role]?.layers || []) {
          if (layer.baseFt > topFt) continue;
          const y = Y(Math.min(layer.topFt, topFt));
          const height = Math.max(3, Y(layer.baseFt) - y);
          const solid = layer.cover === 'BKN' || layer.cover === 'OVC' || layer.cover === 'VV';
          this.svg.appendChild(el('rect', {
            class: `profile-band${solid ? ' profile-band--overcast' : ''}`,
            x: deck.x, y, width: deck.width, height, rx: 2,
          }));
          this.svg.appendChild(el('text', {
            class: 'profile-tick', x: deck.x + 4, y: y - 3,
          }, `${COVER_LABEL[layer.cover] || layer.cover} ${String(Math.round(layer.baseFt / 100)).padStart(3, '0')}`));
        }
      }

      const stepFt = topFt > 30000 ? 10000 : topFt > 12000 ? 5000 : 2000;
      for (let alt = 0; alt <= topFt; alt += stepFt) {
        const y = Y(alt);
        this.svg.appendChild(el('line', { class: 'profile-axis', x1: PAD.left, y1: y, x2: W - PAD.right, y2: y }));
        this.svg.appendChild(el('text', { class: 'profile-tick', x: PAD.left - 6, y: y + 3, 'text-anchor': 'end' },
          alt === 0 ? 'SFC' : `${Math.round(alt / 100)}`));
      }

      if (total <= 0) {
        this.svg.appendChild(el('text', { class: 'profile-tick', x: PAD.left + 8, y: PAD.top + 14 },
          'Select a departure and arrival to build the profile.'));
        return;
      }

      for (const station of stations) {
        const x = X(station.d);
        this.svg.appendChild(el('line', {
          class: 'profile-axis', x1: x, y1: PAD.top, x2: x, y2: Y(0),
          opacity: station.role === 'fix' ? 0.5 : station.kind === 'extension' ? 0.3 : 1,
        }));
        this.svg.appendChild(el('text', { class: 'profile-fix', x, y: H - 8 }, station.name));
      }

      this.svg.appendChild(el('polyline', {
        class: 'profile-path',
        points: built.points.map((p) => `${X(p.d)},${Y(p.alt)}`).join(' '),
      }));
      for (const point of built.points) {
        this.svg.appendChild(el('circle', { class: 'profile-node', cx: X(point.d), cy: Y(point.alt), r: 3 }));
        if (point.mark) {
          this.svg.appendChild(el('text', {
            class: 'profile-tick', x: X(point.d), y: Y(point.alt) - 7, 'text-anchor': 'middle',
          }, point.mark));
        }
      }

      // Altitude to be at over each waypoint, which is the number the vertical
      // guidance instrument is steering towards.
      for (const target of this.waypointTargets()) {
        if (target.role === 'departure' || target.role === 'arrival') continue;
        if (target.targetFt < 200) continue;
        this.svg.appendChild(el('text', {
          class: `profile-target${target.source === 'constraint' ? ' profile-target--hard' : ''}`,
          x: X(target.d), y: Y(target.targetFt) - 9, 'text-anchor': 'middle',
        }, this.formatAltitude(target.targetFt)));
      }

      const crossings = this.limitCrossings(built.points);
      for (const d of [crossings.out, crossings.inbound]) {
        if (d === null) continue;
        this.svg.appendChild(el('circle', {
          class: 'profile-node', cx: X(d), cy: Y(SPEED_LIMIT_ALT), r: 4, stroke: 'var(--warn)',
        }));
      }
      const limitNote = document.getElementById('limitNote');
      if (limitNote) {
        const parts = [];
        if (crossings.out !== null) parts.push(`first ${crossings.out.toFixed(1)} NM`);
        if (crossings.back !== null) parts.push(`last ${crossings.back.toFixed(1)} NM`);
        limitNote.textContent = parts.length ? `Applies over the ${parts.join(' and ')}` : '';
      }

      // Ownship, so the profile shows where the aircraft actually is against plan.
      const own = window.Nav.instruments?.vertical();
      if (own && Number.isFinite(own.alongNm)) {
        const x = X(Math.max(0, Math.min(total, own.alongNm)));
        const y = Y(own.altitude);
        this.svg.appendChild(el('line', {
          class: 'profile-own-link', x1: x, y1: y, x2: x, y2: Y(own.targetFt),
        }));
        this.svg.appendChild(el('circle', { class: 'profile-own', cx: x, cy: y, r: 4.5 }));
      }

      for (const role of ['departure', 'arrival']) {
        const ceiling = this.ceilingFt(role);
        if (ceiling === null) continue;
        if (built.cruiseFt > ceiling && built.cruiseFt < ceiling + 2000) {
          this.svg.appendChild(el('text', {
            class: 'profile-alert', x: W - PAD.right, y: PAD.top + 10, 'text-anchor': 'end',
          }, `CRUISE IN ${role === 'departure' ? 'DEP' : 'ARR'} DECK`));
        }
      }

      if (this.note) {
        this.svg.appendChild(el('text', {
          class: 'profile-alert', x: PAD.left + 6, y: PAD.top + 11,
        }, this.note.toUpperCase()));
      }
    },
  };

  window.Nav.profile = profile;
})();
