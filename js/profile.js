/* ==========================================================================
   24Nav vertical profile
   Draws the planned vertical path against distance, with cloud decks read from
   live ATIS and the 250 kt below 3000 ft envelope shaded as a hard boundary.
   Altitude constraints entered on a fix bend the path through that fix.
   ========================================================================== */

window.Nav = window.Nav || {};

(() => {
  'use strict';

  /*
   * Gradients are derived from the game's own physics, not from real-world
   * numbers. The planekit moves aircraft at 0.5442765 studs/sec per knot
   * instead of the true 0.918650795, so an aircraft reading 250 kt crosses the
   * ground at 250 * 0.592172785 = 148 kt. That leaves roughly two and a half
   * times longer to climb per nautical mile than a real aircraft gets.
   *
   *   ft per NM = rate(fpm) / (indicated_kt * 0.592172785 / 60)
   *
   * Climb   3000 fpm at 250 kt indicated -> 1216 ft/NM
   * Descent 2500 fpm at 280 kt indicated ->  905 ft/NM
   *
   * The feed also slows aircraft linearly above 2000 ft, which makes the real
   * gradients slightly steeper still. Tune these two numbers against how you
   * actually fly rather than treating them as fixed.
   */
  const GAME_KNOT_TO_REAL = 0.592172785;
  const CLIMB_FT_PER_NM = Math.round(3000 / (250 * GAME_KNOT_TO_REAL / 60));
  const DESCENT_FT_PER_NM = Math.round(2500 / (280 * GAME_KNOT_TO_REAL / 60));
  const SPEED_LIMIT_ALT = 3000;
  const SPEED_LIMIT_KT = 250;
  const PAD = { top: 16, right: 14, bottom: 24, left: 48 };

  const COVER_LABEL = { FEW: 'FEW', SCT: 'SCT', BKN: 'BKN', OVC: 'OVC', VV: 'VV' };

  const profile = {
    svg: null,
    atis: { departure: null, arrival: null },
    note: '',

    init() {
      this.svg = document.getElementById('profileSvg');
      if (!this.svg) return;
      if (typeof ResizeObserver === 'function') {
        new ResizeObserver(() => this.render()).observe(this.svg.parentElement);
      } else {
        window.addEventListener('resize', () => this.render());
      }
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
        return { name: node.name, role: node.role, d: run, altitude: node.altitude };
      });
    },

    /**
     * Anchors are the points the path must pass through: both ends on the
     * surface, plus any fix carrying an altitude constraint. A cruise plateau is
     * then inserted into the longest segment that has room for it.
     */
    buildPath(stations, cruiseFt) {
      const total = stations.length ? stations[stations.length - 1].d : 0;
      if (total <= 0) return { points: [], total: 0, cruiseFt, note: '' };

      const anchors = [{ d: 0, alt: 0 }];
      for (const station of stations) {
        if (station.role === 'fix' && Number.isFinite(station.altitude) && station.altitude > 0) {
          anchors.push({ d: station.d, alt: station.altitude, fix: station.name });
        }
      }
      anchors.push({ d: total, alt: 0 });

      // The cruise plateau goes in whichever segment can carry the most height.
      // Ties are broken by the longest level section. Constraints are never
      // discarded, so a route that cannot reach the filed level still climbs
      // and descends through every altitude the pilot asked for.
      let best = { index: -1, peak: -Infinity, room: -Infinity, at: 0 };
      for (let i = 0; i < anchors.length - 1; i += 1) {
        const a = anchors[i];
        const b = anchors[i + 1];
        const span = b.d - a.d;
        if (span <= 0) continue;

        const climbDistance = (b.alt - a.alt + DESCENT_FT_PER_NM * span) / (CLIMB_FT_PER_NM + DESCENT_FT_PER_NM);
        const unclamped = a.alt + CLIMB_FT_PER_NM * climbDistance;
        const peak = Math.min(cruiseFt, Math.max(a.alt, b.alt, unclamped));
        const need = (peak - a.alt) / CLIMB_FT_PER_NM + (peak - b.alt) / DESCENT_FT_PER_NM;
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
          points.push({ d: a.d + (best.peak - a.alt) / CLIMB_FT_PER_NM, alt: best.peak, mark: 'TOC' });
          points.push({ d: b.d - (best.peak - b.alt) / DESCENT_FT_PER_NM, alt: best.peak, mark: 'TOD' });
        } else if (best.peak > Math.max(a.alt, b.alt) + 1) {
          // No level segment fits. Draw the achievable peak instead of a
          // level-off the aircraft could never hold.
          points.push({ d: best.at, alt: best.peak, mark: 'TOC' });
        }
      }
      points.push({ ...anchors[anchors.length - 1] });

      const achieved = Math.max(...points.map((p) => p.alt));
      const note = achieved < cruiseFt - 50
        ? `Too short for FL${String(Math.round(cruiseFt / 100)).padStart(3, '0')}. Best achievable is about FL${String(Math.round(achieved / 1000) * 10).padStart(3, '0')}.`
        : '';

      return { points, total, cruiseFt: Math.max(achieved, 1000), note };
    },

    /** Altitude of the planned path at a given distance. */
    altitudeAt(points, d) {
      for (let i = 0; i < points.length - 1; i += 1) {
        const a = points[i];
        const b = points[i + 1];
        if (d < a.d || d > b.d) continue;
        if (b.d === a.d) return b.alt;
        return a.alt + (b.alt - a.alt) * ((d - a.d) / (b.d - a.d));
      }
      return points.length ? points[points.length - 1].alt : 0;
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
      const H = Math.max(120, Math.round(box.height));
      this.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      window.Nav.svgClear(this.svg);

      const stations = this.stations();
      const cruiseFt = window.Nav.route.cruiseFl * 100;
      const built = this.buildPath(stations, cruiseFt);
      this.note = built.note;

      const plotW = W - PAD.left - PAD.right;
      const plotH = H - PAD.top - PAD.bottom;
      const topFt = Math.max(6000, Math.ceil((built.cruiseFt * 1.18) / 5000) * 5000);
      const total = built.total;

      const X = (d) => PAD.left + (total > 0 ? (d / total) * plotW : 0);
      const Y = (alt) => PAD.top + plotH - (Math.max(0, alt) / topFt) * plotH;

      /* surface */
      this.svg.appendChild(el('rect', {
        class: 'profile-ground', x: PAD.left, y: Y(0), width: plotW, height: PAD.bottom - 6,
      }));

      /* speed-limit envelope */
      this.svg.appendChild(el('rect', {
        class: 'profile-limit',
        x: PAD.left, y: Y(SPEED_LIMIT_ALT), width: plotW, height: Y(0) - Y(SPEED_LIMIT_ALT),
      }));
      // Centred, because both ends of the strip belong to the cloud decks.
      this.svg.appendChild(el('text', {
        class: 'profile-alert', x: PAD.left + plotW / 2, y: Y(SPEED_LIMIT_ALT) - 5,
        'text-anchor': 'middle',
      }, `${SPEED_LIMIT_KT} KT MAX BELOW ${SPEED_LIMIT_ALT}`));

      /* cloud decks, departure over the first quarter and arrival over the last */
      const decks = [
        { role: 'departure', x: PAD.left, width: plotW * 0.26 },
        { role: 'arrival', x: PAD.left + plotW * 0.74, width: plotW * 0.26 },
      ];
      for (const deck of decks) {
        const layers = this.atis[deck.role]?.layers || [];
        for (const layer of layers) {
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

      /* altitude axis */
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

      /* fix ticks */
      for (const station of stations) {
        const x = X(station.d);
        this.svg.appendChild(el('line', {
          class: 'profile-axis', x1: x, y1: PAD.top, x2: x, y2: Y(0),
          opacity: station.role === 'fix' ? 0.5 : 1,
        }));
        this.svg.appendChild(el('text', { class: 'profile-fix', x, y: H - 8 }, station.name));
      }

      /* planned path */
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

      /* speed-limit crossings, marked on the plot and named in the legend so the
         numbers do not fight the cloud labels for the same corner */
      const crossings = this.limitCrossings(built.points);
      for (const d of [crossings.out, crossings.inbound]) {
        if (d === null) continue;
        this.svg.appendChild(el('circle', {
          class: 'profile-node', cx: X(d), cy: Y(SPEED_LIMIT_ALT), r: 4,
          stroke: 'var(--warn)',
        }));
      }
      const limitNote = document.getElementById('limitNote');
      if (limitNote) {
        const parts = [];
        if (crossings.out !== null) parts.push(`first ${crossings.out.toFixed(1)} NM`);
        if (crossings.back !== null) parts.push(`last ${crossings.back.toFixed(1)} NM`);
        limitNote.textContent = parts.length ? `Applies over the ${parts.join(' and ')}` : '';
      }

      /* cloud penetration caution: cruise sitting inside a solid deck */
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
