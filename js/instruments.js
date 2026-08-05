/* ==========================================================================
   24Nav guidance instruments
   Lateral guidance tells the pilot which way to turn to regain the planned
   track. Vertical guidance tells the pilot to climb or descend to make the
   altitude the plan wants over the next waypoint, and reports the rate needed
   against the rate selected.

   Both read one ownship record. Until the relay is connected that record comes
   from the draggable marker on the chart, so the instruments can be flown and
   checked. Nav.instruments.update() replaces it with live feed data.
   ========================================================================== */

window.Nav = window.Nav || {};

(() => {
  'use strict';

  const XTK_FULL_SCALE_NM = 2;
  const DEVIATION_FULL_SCALE_FT = 1000;
  const ON_COURSE_DEG = 2;
  const ON_PROFILE_FT = 200;
  const LEVEL_FPM = 150;
  const INTERCEPT_DEG_PER_NM = 18;
  const MAX_INTERCEPT_DEG = 40;

  const dom = {};

  const instruments = {
    state: {
      present: false,
      source: 'simulated',
      x: 0,
      y: 0,
      altitude: 0,
      heading: 0,
      speed: 0,
      callsign: '',
    },

    init() {
      for (const id of [
        'navLateral', 'navLateralBar', 'navLateralDiamond', 'navLateralCall',
        'navLateralDtk', 'navLateralTrack', 'navLateralXtk', 'navLateralNext',
        'navVertical', 'navVerticalBar', 'navVerticalDiamond', 'navVerticalCall',
        'navVerticalTarget', 'navVerticalBy', 'navVerticalDev', 'navVerticalReq',
        'simAltitude', 'simHeading', 'simEnable', 'navSource',
      ]) {
        dom[id] = document.getElementById(id);
      }

      dom.simEnable?.addEventListener('click', () => {
        if (this.state.present && this.state.source === 'simulated') {
          this.clear();
          return;
        }
        // Drop the marker at the start of the route so it has somewhere to be.
        const nodes = window.Nav.route.nodes();
        const start = nodes[0];
        const next = nodes[1] || nodes[0];
        if (!start) return;
        this.setSimulated({
          x: start.x + (next.x - start.x) * 0.18,
          y: start.y + (next.y - start.y) * 0.18,
          altitude: 2000,
          heading: window.Nav.geo.bearing(start, next),
          speed: window.Nav.route.planSpeedKt,
          callsign: window.Nav.route.plan.ingameCallsign || 'OWN',
        });
      });

      dom.simAltitude?.addEventListener('input', () => {
        this.setSimulated({ altitude: Number(dom.simAltitude.value) });
      });
      dom.simHeading?.addEventListener('input', () => {
        this.setSimulated({ heading: Number(dom.simHeading.value) });
      });
    },

    /* --- ownship input --------------------------------------------------- */

    /** One aircraft record straight off the 24data feed. */
    update(aircraft) {
      if (!aircraft?.position) return this.clear();
      const point = window.Nav.geo.fromStuds(aircraft.position);
      this.state = {
        present: true,
        source: 'live',
        x: point.x,
        y: point.y,
        altitude: Number(aircraft.altitude) || 0,
        heading: Number(aircraft.heading) || 0,
        speed: Number(aircraft.speed) || 0,
        callsign: String(aircraft.displayCallsign || aircraft.filedCallsign || aircraft.realCallsign || ''),
      };
      this.render();
      window.Nav.chart.drawOwnship(this.state);
      window.Nav.profile.render();
    },

    setSimulated(patch) {
      this.state = { ...this.state, ...patch, present: true, source: 'simulated' };
      this.render();
      window.Nav.chart.drawOwnship(this.state);
      window.Nav.profile.render();
    },

    clear() {
      this.state = { ...this.state, present: false };
      this.render();
      window.Nav.chart.drawOwnship(this.state);
      window.Nav.profile.render();
    },

    /* --- geometry -------------------------------------------------------- */

    signedDifference(target, current) {
      return ((Number(target) - Number(current) + 540) % 360) - 180;
    },

    /**
     * Finds the leg the aircraft is flying and how far along it. Prefers a leg
     * the aircraft is actually beside rather than the nearest endpoint, so a
     * route that doubles back does not jump to the wrong leg.
     */
    activeLeg() {
      const legs = window.Nav.route.legs();
      if (!legs.length || !this.state.present) return null;
      const own = this.state;
      let best = null;

      legs.forEach((leg, index) => {
        const dx = leg.to.x - leg.from.x;
        const dy = leg.to.y - leg.from.y;
        const lengthSq = dx * dx + dy * dy;
        if (lengthSq <= 0) return;
        const raw = ((own.x - leg.from.x) * dx + (own.y - leg.from.y) * dy) / lengthSq;
        const t = Math.max(0, Math.min(1, raw));
        const px = leg.from.x + dx * t;
        const py = leg.from.y + dy * t;
        const perp = Math.hypot(own.x - px, own.y - py);
        const inside = raw >= 0 && raw <= 1;
        const score = perp + (inside ? 0 : 400);
        if (!best || score < best.score) best = { leg, index, t, perp, px, py, score, inside };
      });
      return best;
    },

    /** Distance from the departure to the start of a leg. */
    distanceToLegStart(index) {
      const legs = window.Nav.route.legs();
      let run = 0;
      for (let i = 0; i < index && i < legs.length; i += 1) run += legs[i].nm;
      return run;
    },

    lateral() {
      const active = this.activeLeg();
      if (!active) return null;
      const own = this.state;
      const leg = active.leg;

      // Sign of the cross-track: positive means the aircraft is right of course.
      const dx = leg.to.x - leg.from.x;
      const dy = leg.to.y - leg.from.y;
      // Screen space has y increasing downward, so for a track vector
      // (sin H, -cos H) a positive cross product puts the aircraft right of
      // course. Getting this backwards commands the turn in the wrong direction.
      const cross = dx * (own.y - leg.from.y) - dy * (own.x - leg.from.x);
      const side = cross > 0 ? 1 : -1;
      const xtkNm = (active.perp / window.Nav.geo.MAP_UNITS_PER_NM) * side;

      // Steer back towards the track, more aggressively the further off it is.
      const correction = Math.max(-MAX_INTERCEPT_DEG, Math.min(MAX_INTERCEPT_DEG, -xtkNm * INTERCEPT_DEG_PER_NM));
      const desired = (leg.heading + correction + 360) % 360;
      const turnDeg = this.signedDifference(desired, own.heading);

      return {
        legIndex: active.index,
        dtk: leg.heading,
        desired,
        track: own.heading,
        xtkNm,
        turnDeg,
        instruction: Math.abs(turnDeg) <= ON_COURSE_DEG ? 'On course'
          : turnDeg > 0 ? 'Turn right' : 'Turn left',
        toName: leg.to.name,
        toNm: leg.nm * (1 - active.t),
        alongNm: this.distanceToLegStart(active.index) + leg.nm * active.t,
      };
    },

    /**
     * Vertical guidance steers to the planned path, not to the next waypoint's
     * altitude. On a direct route the next waypoint is the destination at the
     * surface, so steering to it would demand a descent while the aircraft is
     * still below its cruise climb. The target is instead the next vertex on the
     * profile ahead of the aircraft: top of climb while climbing, an altitude
     * constraint or top of descent later, the runway at the end.
     */
    vertical() {
      const lateral = this.lateral();
      if (!lateral) return null;
      const own = this.state;
      const built = window.Nav.profile.current();
      const points = built.points || [];
      if (!points.length) return null;

      const targetFt = window.Nav.profile.targetAt(lateral.alongNm);
      const deviationFt = own.altitude - targetFt;

      const ahead = points.find((point) => point.d > lateral.alongNm + 0.01) || points[points.length - 1];
      const toGoNm = Math.max(0, ahead.d - lateral.alongNm);

      // Name the vertex. Marked vertices are top of climb or descent; otherwise
      // it is whichever route point sits at that distance.
      let label = ahead.mark || '';
      if (!label) {
        const station = (built.stations || [])
          .filter((s) => s.d >= ahead.d - 0.05)
          .sort((a, b) => a.d - b.d)[0];
        label = station?.name || 'END';
      }

      const minutes = toGoNm / window.Nav.profile.groundNmPerMinute();
      const requiredVs = minutes > 0.05 ? (ahead.alt - own.altitude) / minutes : 0;

      // The call follows the rate needed to make the next vertex, not the raw
      // deviation. An aircraft sitting below a descending profile does not need
      // to climb just because it is under the line: the line is coming down to
      // meet it. The bar still shows the deviation.
      const climbing = requiredVs > 0;
      const selectedVs = climbing ? window.Nav.route.climbVs : window.Nav.route.descentVs;

      return {
        altitude: own.altitude,
        targetFt,
        deviationFt,
        nextName: label,
        nextTargetFt: ahead.alt,
        toGoNm,
        requiredVs,
        selectedVs,
        alongNm: lateral.alongNm,
        instruction: Math.abs(requiredVs) <= LEVEL_FPM ? 'Maintain'
          : climbing ? 'Climb' : 'Descend',
      };
    },

    /* --- render ---------------------------------------------------------- */

    render() {
      if (!dom.navLateral) return;
      const lateral = this.lateral();
      const vertical = this.vertical();
      const live = this.state.source === 'live';

      if (dom.navSource) {
        dom.navSource.textContent = !this.state.present ? 'No aircraft'
          : live ? 'Live feed' : 'Simulated';
        dom.navSource.dataset.state = !this.state.present ? 'none' : live ? 'live' : 'sim';
      }
      if (dom.simEnable) {
        dom.simEnable.textContent = this.state.present && !live ? 'Remove marker' : 'Drop marker';
        dom.simEnable.disabled = live;
      }
      if (dom.simAltitude && document.activeElement !== dom.simAltitude) {
        dom.simAltitude.value = String(Math.round(this.state.altitude));
      }
      if (dom.simHeading && document.activeElement !== dom.simHeading) {
        dom.simHeading.value = String(Math.round(this.state.heading));
      }

      const idle = !lateral || !vertical;
      dom.navLateral.dataset.state = idle ? 'idle' : 'active';
      dom.navVertical.dataset.state = idle ? 'idle' : 'active';

      if (idle) {
        dom.navLateralCall.textContent = 'No guidance';
        dom.navLateralDtk.textContent = '---';
        dom.navLateralTrack.textContent = '---';
        dom.navLateralXtk.textContent = '--';
        dom.navLateralNext.textContent = '--';
        dom.navLateralDiamond.style.setProperty('--offset', '0');
        dom.navVerticalCall.textContent = 'No guidance';
        dom.navVerticalTarget.textContent = '--';
        dom.navVerticalBy.textContent = '--';
        dom.navVerticalDev.textContent = '--';
        dom.navVerticalReq.textContent = '--';
        dom.navVerticalDiamond.style.setProperty('--offset', '0');
        return;
      }

      const turn = Math.round(Math.abs(lateral.turnDeg));
      dom.navLateralCall.textContent = lateral.instruction === 'On course'
        ? 'On course' : `${lateral.instruction} ${turn}\u00B0`;
      dom.navLateral.dataset.call = lateral.instruction === 'On course' ? 'ok'
        : lateral.instruction === 'Turn right' ? 'right' : 'left';
      dom.navLateralDtk.textContent = `${window.Nav.geo.padHeading(lateral.dtk)}\u00B0`;
      dom.navLateralTrack.textContent = `${window.Nav.geo.padHeading(lateral.track)}\u00B0`;
      dom.navLateralXtk.textContent = `${Math.abs(lateral.xtkNm).toFixed(2)} NM ${lateral.xtkNm >= 0 ? 'R' : 'L'}`;
      dom.navLateralNext.textContent = `${lateral.toName}  ${lateral.toNm.toFixed(1)} NM`;

      // Diamond sits on the side the course is, which is the opposite side to
      // the aircraft's own displacement. That is how a real deviation bar reads.
      const lateralOffset = Math.max(-1, Math.min(1, -lateral.xtkNm / XTK_FULL_SCALE_NM));
      dom.navLateralDiamond.style.setProperty('--offset', lateralOffset.toFixed(3));

      dom.navVerticalCall.textContent = vertical.instruction === 'Maintain'
        ? 'Maintain' : `${vertical.instruction} ${Math.abs(Math.round(vertical.requiredVs))} fpm`;
      dom.navVertical.dataset.call = vertical.instruction === 'Maintain' ? 'ok'
        : vertical.instruction === 'Climb' ? 'up' : 'down';
      dom.navVerticalTarget.textContent = `${vertical.nextName} ${window.Nav.profile.formatAltitude(vertical.nextTargetFt)}`;
      dom.navVerticalBy.textContent = `${vertical.toGoNm.toFixed(1)} NM`;
      dom.navVerticalDev.textContent = `${vertical.deviationFt >= 0 ? '+' : ''}${Math.round(vertical.deviationFt)} ft`;
      // Required against selected in one row, because the comparison is the
      // whole point of the readout.
      dom.navVerticalReq.textContent = `${Math.round(vertical.requiredVs) >= 0 ? '+' : ''}${Math.round(vertical.requiredVs)} of ${Math.round(vertical.selectedVs)}`;

      // Required rate beyond what the pilot selected is worth flagging.
      const strained = Math.abs(vertical.requiredVs) > vertical.selectedVs * 1.25
        && Math.abs(vertical.deviationFt) > ON_PROFILE_FT;
      dom.navVerticalReq.dataset.strained = String(strained);

      const verticalOffset = Math.max(-1, Math.min(1, -vertical.deviationFt / DEVIATION_FULL_SCALE_FT));
      dom.navVerticalDiamond.style.setProperty('--offset', verticalOffset.toFixed(3));
    },
  };

  window.Nav.instruments = instruments;
})();
