/* ==========================================================================
   24Nav app
   Boots the page, wires the chart to the route model, builds the ATC24 command,
   and owns the caution and warning layer. Live traffic arrives in a later step
   and feeds Nav.alerts.evaluate() and Nav.instruments.update() with the same
   aircraft records the relay broadcasts.
   ========================================================================== */

window.Nav = window.Nav || {};

(() => {
  'use strict';

  const SOUND_KEY = '24nav.sound';
  const PROFILE_KEY = '24nav.profile';
  const OVERSPEED_KT = 250;
  const OVERSPEED_ALT = 3000;
  const GAME_KNOT_TO_REAL = 0.592172785;

  const dom = {};

  /* --- sound ------------------------------------------------------------- */

  const sound = {
    chime: null,
    warning: null,
    armed: false,

    enabled() {
      try {
        return window.localStorage.getItem(SOUND_KEY) !== 'off';
      } catch (error) {
        return true;
      }
    },

    /**
     * The two clips have shipped under different names depending on whether they
     * were renamed on upload, and a missing file fails silently inside the play
     * promise. Try each candidate in turn so the chime does not go quiet just
     * because a filename differs.
     */
    loadOne(candidates, volume) {
      const audio = new Audio();
      audio.preload = 'auto';
      audio.volume = volume;
      let index = 0;
      const attach = () => {
        if (index >= candidates.length) {
          console.warn('24Nav: no audio file found among', candidates.join(', '));
          return;
        }
        audio.src = candidates[index];
        index += 1;
      };
      audio.addEventListener('error', attach);
      attach();
      return audio;
    },

    load() {
      this.chime = this.loadOne([
        'assets/audio/cabin-chime.mp3',
        'assets/audio/audio_aircraft-cabin-chime.mp3',
        'assets/audio/aircraft-cabin-chime.mp3',
      ], 0.9);
      this.warning = this.loadOne([
        'assets/audio/master-warning.mp3',
        'assets/audio/audio_777-master-warning.mp3',
        'assets/audio/777-master-warning.mp3',
      ], 0.85);
    },

    stop(which) {
      const audio = which === 'warning' ? this.warning : this.chime;
      if (!audio) return;
      try {
        audio.pause();
        audio.currentTime = 0;
      } catch (error) {
        // Nothing to stop.
      }
    },

    play(which) {
      if (!this.enabled()) return;
      const audio = which === 'warning' ? this.warning : this.chime;
      if (!audio) return;
      audio.currentTime = 0;
      const attempt = audio.play();
      if (attempt?.catch) attempt.catch(() => this.armOnGesture(which));
    },

    /** Browsers block audio until the page has been interacted with. Hold the
        sound and release it on the first real gesture instead of losing it. */
    armOnGesture(which) {
      if (this.armed) return;
      this.armed = true;
      const release = () => {
        this.armed = false;
        window.removeEventListener('pointerdown', release);
        window.removeEventListener('keydown', release);
        this.play(which);
      };
      window.addEventListener('pointerdown', release, { once: true });
      window.addEventListener('keydown', release, { once: true });
    },
  };

  /* --- caution and warning ---------------------------------------------- */

  const alerts = {
    key: null,
    text: '',
    acknowledged: false,

    /**
     * Conditions are held by a stable key rather than by their message text.
     * The text carries a live airspeed that changes every update, so keying off
     * it would restart the warning tone several times a second.
     */
    set(key, text) {
      if (this.key === key) {
        this.text = text;
        return this.render();
      }
      this.key = key;
      this.text = text;
      this.acknowledged = false;
      sound.play('warning');
      this.render();
    },

    clear() {
      if (!this.key) return;
      this.key = null;
      this.text = '';
      this.acknowledged = false;
      sound.stop('warning');
      this.render();
    },

    /** Pressing the caution button cancels the tone and the flash, exactly like
        acknowledging a master caution. The lamp stays lit while the condition
        is still true. */
    acknowledge() {
      if (!this.key || this.acknowledged) return;
      this.acknowledged = true;
      sound.stop('warning');
      this.render();
    },

    render() {
      if (!dom.caution) return;
      const state = !this.key ? 'clear' : this.acknowledged ? 'acked' : 'active';
      dom.caution.dataset.state = state;
      dom.caution.disabled = !this.key;
      dom.cautionTitle.textContent = this.key ? 'Overspeed' : 'Caution';
      dom.cautionDetail.textContent = this.key
        ? (this.acknowledged ? this.text : `${this.text}  ${'\u2014'}  press to acknowledge`)
        : 'No active alerts';
    },

    /**
     * Evaluates one live aircraft record. `speed` is the airspeed the pilot
     * reads on the flight deck, so the limit is checked against that rather
     * than the derived real-knot value.
     */
    evaluate(aircraft) {
      if (!aircraft) return this.clear();
      const speed = Number(aircraft.speed);
      const altitude = Number(aircraft.altitude);
      if (aircraft.isOnGround === true || !Number.isFinite(speed) || !Number.isFinite(altitude)) {
        return this.clear();
      }
      if (speed > OVERSPEED_KT && altitude < OVERSPEED_ALT) {
        return this.set('overspeed', `${Math.round(speed)} kt at ${Math.round(altitude)} ft`);
      }
      return this.clear();
    },
  };

  /* --- render ------------------------------------------------------------ */

  function renderReadouts() {
    const route = window.Nav.route;
    const nm = route.totalNm();
    const nodes = route.nodes();

    dom.readoutRoute.textContent = nodes.length >= 2
      ? `${route.departure} ${route.routeString()} ${route.arrival}`.replace(/\s+/g, ' ')
      : 'No route';
    dom.readoutDistance.textContent = `${nm.toFixed(1)} NM`;
    dom.readoutCruise.textContent = `FL${route.flightLevel()}`;

    // Block time on the game's distance scale. An aircraft indicating 280 kt
    // crosses the ground at 280 * 0.592172785 = 166 kt, so real-world cruise
    // figures would understate every leg by a factor of about 1.7.
    if (nm > 0) {
      const groundKt = Math.max(40, route.planSpeedKt * GAME_KNOT_TO_REAL);
      const minutes = Math.round((nm / groundKt) * 60) + 3;
      dom.readoutEte.textContent = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    } else {
      dom.readoutEte.textContent = '--:--';
    }
  }

  function renderCommand() {
    const route = window.Nav.route;
    dom.planCommand.textContent = route.command();
    const missing = route.missingPlanFields();
    dom.planMissing.textContent = missing.length
      ? `Still needed: ${missing.join(', ')}. The command works without them but ATC24 may reject it.`
      : 'Ready to paste into the ATC24 flight plan page.';
    dom.planMissing.dataset.state = missing.length ? 'warn' : 'ok';
  }

  function syncControls() {
    const route = window.Nav.route;
    dom.departure.value = route.departure;
    dom.arrival.value = route.arrival;
    populateRunways('departure', route.departure, route.departureRunway);
    populateRunways('arrival', route.arrival, route.arrivalRunway);
    if (document.activeElement !== dom.cruise) dom.cruise.value = String(route.cruiseFl);
    if (document.activeElement !== dom.climbVs) dom.climbVs.value = String(route.climbVs);
    if (document.activeElement !== dom.descentVs) dom.descentVs.value = String(route.descentVs);
    if (document.activeElement !== dom.planSpeed) dom.planSpeed.value = String(route.planSpeedKt);

    for (const [role, button, input, state] of [
      ['departure', dom.depExtOn, dom.depExtNm, route.depExt],
      ['arrival', dom.arrExtOn, dom.arrExtNm, route.arrExt],
    ]) {
      const available = Boolean(route.extensionGeometry(role));
      button.setAttribute('aria-pressed', String(state.on && available));
      button.disabled = !available;
      input.disabled = !state.on || !available;
      if (document.activeElement !== input) input.value = state.nm.toFixed(1);
    }

    for (const [field, node] of [
      ['ingameCallsign', dom.planIngame],
      ['filedCallsign', dom.planFiled],
      ['aircraft', dom.planAircraft],
      ['robloxName', dom.planRoblox],
    ]) {
      if (document.activeElement !== node) node.value = route.plan[field];
    }
    if (document.activeElement !== dom.planRules) dom.planRules.value = route.plan.flightRules;
  }

  function atisCard(role, code) {
    const report = window.Nav.live.atisFor(code);
    const card = document.createElement('div');
    card.className = 'atis';
    card.dataset.role = role;

    const head = document.createElement('div');
    head.className = 'atis__head';
    const title = document.createElement('span');
    title.className = 'atis__code';
    title.textContent = code;
    const letter = document.createElement('span');
    letter.className = 'atis__letter';
    letter.textContent = report?.letter ? `INFO ${String(report.letter).toUpperCase()}` : 'NO REPORT';
    head.appendChild(title);
    head.appendChild(letter);
    card.appendChild(head);

    const tag = document.createElement('span');
    tag.className = 'u-label';
    tag.textContent = role === 'departure' ? 'Departure' : 'Arrival';
    card.appendChild(tag);

    if (!report) {
      const empty = document.createElement('p');
      empty.className = 'atis__empty';
      empty.textContent = window.Nav.live.state === 'open'
        ? 'The relay has not received a report for this airport yet.'
        : 'Connect the relay on the Live tab to receive ATIS.';
      card.appendChild(empty);
      return card;
    }

    const rows = document.createElement('dl');
    rows.className = 'atis__rows';
    const wind = report.wind
      ? `${report.wind.direction}/${String(report.wind.speed).padStart(2, '0')}${report.wind.gust ? `G${report.wind.gust}` : ''}`
      : '--';
    for (const [label, value] of [
      ['Wind', wind],
      ['QNH', report.qnh ? `Q${report.qnh}` : '--'],
      ['Dep rwy', (report.departureRunways || []).join(', ') || '--'],
      ['Arr rwy', (report.arrivalRunways || []).join(', ') || '--'],
    ]) {
      const wrap = document.createElement('div');
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.className = 'u-data';
      dd.textContent = value;
      wrap.appendChild(dt);
      wrap.appendChild(dd);
      rows.appendChild(wrap);
    }
    card.appendChild(rows);

    // Cloud layers are not in the relay's parsed output, so they come from the
    // report body here and feed straight into the vertical profile.
    const layers = window.Nav.profile.parseAtisClouds(report.content);
    const clouds = document.createElement('div');
    clouds.className = 'atis__clouds';
    if (!layers.length) {
      const chip = document.createElement('span');
      chip.className = 'cloud-chip cloud-chip--clear';
      chip.textContent = 'No cloud reported';
      clouds.appendChild(chip);
    } else {
      for (const layer of layers) {
        const chip = document.createElement('span');
        const solid = layer.cover === 'BKN' || layer.cover === 'OVC' || layer.cover === 'VV';
        chip.className = `cloud-chip${solid ? ' cloud-chip--solid' : ''}`;
        chip.textContent = `${layer.cover} ${window.Nav.profile.formatAltitude(layer.baseFt)}`;
        clouds.appendChild(chip);
      }
    }
    card.appendChild(clouds);

    const details = document.createElement('details');
    details.className = 'atis__raw';
    const summary = document.createElement('summary');
    summary.textContent = 'Full report';
    const pre = document.createElement('pre');
    pre.textContent = report.content || '';
    details.appendChild(summary);
    details.appendChild(pre);
    card.appendChild(details);
    return card;
  }

  function renderAtis() {
    const route = window.Nav.route;
    dom.atisCards.replaceChildren(
      atisCard('departure', route.departure),
      atisCard('arrival', route.arrival)
    );
  }

  function renderLive() {
    const live = window.Nav.live;
    const summary = live.summary();

    dom.linkState.textContent = summary.label;
    dom.linkState.dataset.state = summary.state;

    const lines = [
      ['Relay', summary.label],
      ['Upstream', summary.upstreamOk ? 'Connected' : summary.upstreamState],
      ['Aircraft seen', summary.counts ? String(summary.counts.aircraftMain ?? 0) : '--'],
      ['ATIS held', summary.counts ? String(summary.counts.atis ?? 0) : '--'],
      ['Tracking', live.trackQuery || 'Nothing'],
      ['Match', summary.hasAircraft ? 'Aircraft found' : summary.tracking ? 'No match yet' : '--'],
    ];
    dom.relayStatus.replaceChildren(...lines.map(([label, value]) => {
      const row = document.createElement('div');
      row.className = 'status__row';
      const dt = document.createElement('span');
      dt.className = 'u-label';
      dt.textContent = label;
      const dd = document.createElement('span');
      dd.className = 'u-data';
      dd.textContent = value;
      row.appendChild(dt);
      row.appendChild(dd);
      return row;
    }));

    const plan = live.flightPlan;
    dom.filedPlan.replaceChildren();
    if (plan) {
      const box = document.createElement('div');
      box.className = 'filed__box';
      const title = document.createElement('span');
      title.className = 'u-label';
      title.textContent = 'Filed plan on the network';
      const text = document.createElement('code');
      text.className = 'u-data filed__text';
      text.textContent = [
        plan.realCallsign || plan.callsign || '?',
        `${plan.departure || '?'} to ${plan.arrival || '?'}`,
        plan.flightLevel ? `FL${plan.flightLevel}` : '',
        plan.aircraft || '',
        plan.route && plan.route !== 'N/A' ? plan.route : 'DCT',
      ].filter(Boolean).join('  \u00B7  ');
      const load = document.createElement('button');
      load.type = 'button';
      load.className = 'tool';
      load.textContent = 'Load into planner';
      load.addEventListener('click', () => {
        const result = window.Nav.live.adoptFlightPlan();
        dom.atisNote.textContent = '';
        if (result.unknown.length) {
          dom.chartHint.innerHTML = `Loaded the filed plan. <b>${result.unknown.join(', ')}</b> ${result.unknown.length === 1 ? 'is not' : 'are not'} in the chart database and ${result.unknown.length === 1 ? 'was' : 'were'} skipped.`;
        }
      });
      box.appendChild(title);
      box.appendChild(text);
      box.appendChild(load);
      dom.filedPlan.appendChild(box);
    }

    if (document.activeElement !== dom.relayUrl) dom.relayUrl.value = live.url;
    if (document.activeElement !== dom.trackQuery) dom.trackQuery.value = live.trackQuery;
  }

  function renderAll() {
    const route = window.Nav.route;
    window.Nav.chart.setRunwayAirports([route.departure, route.arrival]);
    window.Nav.strip.render();
    window.Nav.chart.drawRoute(route.nodes());
    window.Nav.chart.drawExtensions();
    window.Nav.chart.setSelected(
      route.selection?.type === 'fix' ? route.fixes[route.selection.index]?.name
      : route.selection?.type === 'departure' ? route.departure
      : route.selection?.type === 'arrival' ? route.arrival
      : null
    );
    window.Nav.profile.render();
    window.Nav.instruments.render();
    renderAtis();
    renderLive();
    renderReadouts();
    renderCommand();
    syncControls();
    updateHint();
  }

  function updateHint() {
    const route = window.Nav.route;
    if (window.Nav.chart.measureEnabled) {
      dom.chartHint.innerHTML = '<b>Measure</b> is on. Drag between any two points for distance and reciprocal headings.';
      return;
    }
    if (route.selection?.type === 'fix') {
      const name = route.fixes[route.selection.index]?.name;
      dom.chartHint.innerHTML = `<b>${name}</b> is the insertion point. Click a fix to add it after ${name}.`;
      return;
    }
    if (route.selection?.type) {
      dom.chartHint.innerHTML = `<b>${route.selection.type === 'departure' ? 'Departure' : 'Arrival'}</b> is the insertion point. Click a fix on the chart.`;
      return;
    }
    dom.chartHint.innerHTML = '<b>Click a fix</b> and choose where it goes. Click a route point first to insert after it.';
  }

  /* --- add-waypoint popover --------------------------------------------- */

  /**
   * Clicking a chart symbol asks where it should go rather than guessing, which
   * is how the DHL dispatch map behaves. The insertion anchor is whichever route
   * point is selected, set either by clicking it on the chart or by picking a row
   * in the route strip.
   */
  const addFlow = {
    pending: null,

    open(point, event) {
      this.pending = point;
      const airport = point.kind === 'airport';
      const anchor = window.Nav.route.selection;
      const anchorName = anchor?.type === 'fix' ? window.Nav.route.fixes[anchor.index]?.name
        : anchor?.type === 'departure' ? window.Nav.route.departure
        : anchor?.type === 'arrival' ? window.Nav.route.arrival
        : null;

      dom.addTitle.textContent = point.name;
      dom.addFixActions.hidden = airport;
      dom.addAirportActions.hidden = !airport;

      if (airport) {
        dom.addMsg.textContent = 'Set this airport as the departure or the arrival.';
      } else if (anchorName && anchor.type !== 'arrival') {
        dom.addMsg.textContent = `Insert after ${anchorName}, or place it at the end of the route.`;
        dom.addToRoute.textContent = `Insert after ${anchorName}`;
      } else {
        dom.addMsg.textContent = 'Choose where this fix should be added. Select a route point first to insert after it.';
        dom.addToRoute.textContent = 'Add to route';
      }

      dom.addPopover.hidden = false;
      this.place(event);
      window.setTimeout(() => {
        const first = airport ? dom.setDeparture : dom.addToRoute;
        first.focus({ preventScroll: true });
      }, 0);
    },

    /** Keeps the panel inside the chart, whether opened by pointer or keyboard. */
    place(event) {
      const host = dom.chart.getBoundingClientRect();
      let x = event?.clientX;
      let y = event?.clientY;
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        const rect = event?.target?.getBoundingClientRect?.();
        x = rect ? rect.left + rect.width / 2 : host.left + host.width / 2;
        y = rect ? rect.top + rect.height / 2 : host.top + host.height / 2;
      }
      const width = dom.addPopover.offsetWidth || 240;
      const height = dom.addPopover.offsetHeight || 150;
      dom.addPopover.style.left = `${Math.max(8, Math.min(host.width - width - 8, x - host.left + 12))}px`;
      dom.addPopover.style.top = `${Math.max(8, Math.min(host.height - height - 8, y - host.top + 12))}px`;
    },

    close() {
      this.pending = null;
      dom.addPopover.hidden = true;
    },

    commit(mode) {
      const point = this.pending;
      this.close();
      if (!point) return;
      if (point.kind === 'airport') {
        window.Nav.route.setEndpoint(mode, point.name);
        return;
      }
      window.Nav.route.addPoint(point, mode);
    },
  };

  /* --- controls --------------------------------------------------------- */

  function populateSelects() {
    const codes = Object.keys(window.Nav.chart.airports).sort();
    for (const select of [dom.departure, dom.arrival]) {
      select.innerHTML = '';
      for (const code of codes) {
        const option = document.createElement('option');
        option.value = code;
        option.textContent = code;
        select.appendChild(option);
      }
    }
  }

  function populateRunways(role, code, selected) {
    const node = role === 'departure' ? dom.departureRunway : dom.arrivalRunway;
    const list = window.Nav.route.runwaysFor(code);
    const signature = `${code}:${list.map((r) => r.label).join(',')}`;
    if (node.dataset.signature !== signature) {
      node.dataset.signature = signature;
      node.innerHTML = '';
      if (!list.length) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'No data';
        node.appendChild(option);
      }
      for (const runway of list) {
        const option = document.createElement('option');
        option.value = runway.label;
        option.textContent = `${runway.label}  ${window.Nav.geo.padHeading(runway.heading)}\u00B0`;
        node.appendChild(option);
      }
    }
    node.disabled = !list.length;
    if (selected) node.value = selected;
  }

  async function copyCommand() {
    const text = window.Nav.route.command();
    const done = (ok) => {
      dom.planCopy.textContent = ok ? 'Copied' : 'Copy failed';
      window.setTimeout(() => { dom.planCopy.textContent = 'Copy'; }, 1600);
    };
    try {
      await navigator.clipboard.writeText(text);
      done(true);
    } catch (error) {
      // Clipboard access is blocked in some contexts, so fall back to a
      // throwaway textarea selection.
      try {
        const scratch = document.createElement('textarea');
        scratch.value = text;
        scratch.setAttribute('readonly', 'readonly');
        scratch.style.position = 'fixed';
        scratch.style.opacity = '0';
        document.body.appendChild(scratch);
        scratch.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(scratch);
        done(ok);
      } catch (fallbackError) {
        done(false);
      }
    }
  }

  function bindControls() {
    const route = window.Nav.route;

    dom.departure.addEventListener('change', () => route.setEndpoint('departure', dom.departure.value));
    dom.arrival.addEventListener('change', () => route.setEndpoint('arrival', dom.arrival.value));
    dom.departureRunway.addEventListener('change', () => route.setRunway('departure', dom.departureRunway.value));
    dom.arrivalRunway.addEventListener('change', () => route.setRunway('arrival', dom.arrivalRunway.value));
    dom.cruise.addEventListener('change', () => route.setCruise(dom.cruise.value));
    dom.climbVs.addEventListener('change', () => route.setVerticalSpeed('climb', dom.climbVs.value));
    dom.descentVs.addEventListener('change', () => route.setVerticalSpeed('descent', dom.descentVs.value));
    dom.planSpeed.addEventListener('change', () => route.setPlanSpeed(dom.planSpeed.value));
    dom.swap.addEventListener('click', () => route.swapEndpoints());

    dom.depExtOn.addEventListener('click', () => route.setExtension('departure', { on: !route.depExt.on }));
    dom.arrExtOn.addEventListener('click', () => route.setExtension('arrival', { on: !route.arrExt.on }));
    dom.depExtNm.addEventListener('change', () => route.setExtension('departure', { nm: dom.depExtNm.value }));
    dom.arrExtNm.addEventListener('change', () => route.setExtension('arrival', { nm: dom.arrExtNm.value }));

    for (const [field, node, event] of [
      ['ingameCallsign', dom.planIngame, 'input'],
      ['filedCallsign', dom.planFiled, 'input'],
      ['aircraft', dom.planAircraft, 'input'],
      ['robloxName', dom.planRoblox, 'input'],
      ['flightRules', dom.planRules, 'change'],
    ]) {
      node.addEventListener(event, () => route.setPlanField(field, node.value));
    }
    dom.planCopy.addEventListener('click', copyCommand);

    const tabs = [dom.tabRoute, dom.tabPlan, dom.tabAtis, dom.tabLive];
    for (const tab of tabs) {
      tab.addEventListener('click', () => {
        dom.rail.dataset.tab = tab.dataset.tab;
        for (const other of tabs) other.setAttribute('aria-selected', String(other === tab));
      });
    }

    // --- live relay -------------------------------------------------------
    const live = window.Nav.live;
    dom.relayConnect.addEventListener('click', () => {
      live.setUrl(dom.relayUrl.value);
      live.reconnect(true);
    });
    dom.relayProbe.addEventListener('click', async () => {
      live.setUrl(dom.relayUrl.value);
      dom.relayProbe.textContent = 'Testing';
      const result = await live.probe();
      dom.relayProbe.textContent = 'Test';
      dom.atisNote.textContent = '';
      if (!result) {
        dom.chartHint.innerHTML = '<b>Relay unreachable.</b> Check the address, and that ALLOWED_ORIGINS on Render includes this site.';
      }
    });
    dom.trackStart.addEventListener('click', () => live.setTrack(dom.trackQuery.value));
    dom.trackStop.addEventListener('click', () => live.setTrack(''));
    dom.trackFromPlan.addEventListener('click', () => {
      const query = route.plan.ingameCallsign || route.plan.robloxName;
      if (!query) {
        dom.chartHint.innerHTML = 'Fill in an <b>in-game callsign</b> or Roblox username on the Plan tab first.';
        return;
      }
      dom.trackQuery.value = query;
      live.setTrack(query);
    });

    // --- ATIS -------------------------------------------------------------
    dom.atisRunways.addEventListener('click', () => {
      const applied = live.adoptAtisRunways();
      dom.atisNote.textContent = applied.length
        ? `Runways set from ATIS: ${applied.join(', ')}.`
        : 'No usable runway in the current reports. The ATIS runway may not exist in the runway database.';
      dom.atisNote.dataset.state = applied.length ? 'ok' : 'warn';
    });
    dom.atisRefresh.addEventListener('click', async () => {
      await live.bootstrap();
      renderAtis();
      dom.atisNote.textContent = 'Reread the relay ATIS cache.';
      dom.atisNote.dataset.state = 'ok';
    });

    // --- master caution ---------------------------------------------------
    dom.caution.addEventListener('click', () => window.Nav.alerts.acknowledge());

    // --- add-waypoint popover --------------------------------------------
    dom.addToRoute.addEventListener('click', () => addFlow.commit('anchor'));
    dom.addToEnd.addEventListener('click', () => addFlow.commit('end'));
    dom.setDeparture.addEventListener('click', () => addFlow.commit('departure'));
    dom.setArrival.addEventListener('click', () => addFlow.commit('arrival'));
    dom.addCancel.addEventListener('click', () => addFlow.close());

    // Clicking away closes it, but not when the click lands on another symbol,
    // because that click is about to open the panel again.
    document.addEventListener('pointerdown', (event) => {
      if (dom.addPopover.hidden) return;
      if (dom.addPopover.contains(event.target)) return;
      if (event.target.closest?.('.pick')) return;
      addFlow.close();
    });

    const toggle = (button, name) => {
      button.addEventListener('click', () => {
        const next = button.getAttribute('aria-pressed') !== 'true';
        button.setAttribute('aria-pressed', String(next));
        window.Nav.chart.setLayer(name, next);
      });
    };
    toggle(dom.toggleGround, 'airportGround');
    toggle(dom.toggleRunways, 'airportRunway');
    toggle(dom.toggleFixes, 'fixes');
    toggle(dom.toggleSectors, 'sectors');
    toggle(dom.toggleGrid, 'grid');

    dom.toggleMeasure.addEventListener('click', () => {
      const next = dom.toggleMeasure.getAttribute('aria-pressed') !== 'true';
      dom.toggleMeasure.setAttribute('aria-pressed', String(next));
      window.Nav.chart.setMeasureEnabled(next);
      updateHint();
    });

    dom.resetView.addEventListener('click', () => {
      const nodes = route.nodes();
      window.Nav.chart.fitTo(nodes.length ? nodes : Object.values(window.Nav.chart.airports));
    });

    dom.railToggle.addEventListener('click', () => {
      const next = dom.rail.dataset.open !== 'true';
      dom.rail.dataset.open = String(next);
      dom.railToggle.setAttribute('aria-expanded', String(next));
    });

    dom.profileCollapse.addEventListener('click', () => {
      const open = dom.app.dataset.profile !== 'collapsed';
      dom.app.dataset.profile = open ? 'collapsed' : 'open';
      dom.profileCollapse.textContent = open ? 'Show' : 'Hide';
      dom.profileCollapse.setAttribute('aria-expanded', String(!open));
      try {
        window.localStorage.setItem(PROFILE_KEY, open ? 'collapsed' : 'open');
      } catch (error) {
        // Not worth failing the toggle over.
      }
      if (!open) window.Nav.profile.render();
    });

    // Panning a chart with the right button should not raise a context menu.
    for (const node of document.querySelectorAll('.chart__svg, .profile__svg')) {
      node.addEventListener('contextmenu', (event) => event.preventDefault());
    }

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (!dom.addPopover.hidden) {
        addFlow.close();
        return;
      }
      if (route.selection) route.select(null);
      if (window.Nav.chart.measureEnabled) dom.toggleMeasure.click();
    });
  }

  /* --- boot ------------------------------------------------------------- */

  function pass(name) {
    const node = document.querySelector(`[data-test="${name}"]`);
    if (node) node.dataset.state = 'pass';
  }

  const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

  async function boot() {
    for (const id of [
      'app', 'boot', 'bootStatus', 'bootEnter', 'rail', 'railToggle',
      'tabRoute', 'tabPlan',
      'departure', 'arrival', 'departureRunway', 'arrivalRunway', 'swap',
      'cruise', 'climbVs', 'descentVs', 'planSpeed',
      'depExtOn', 'depExtNm', 'arrExtOn', 'arrExtNm',
      'planIngame', 'planFiled', 'planAircraft', 'planRules', 'planRoblox',
      'planCommand', 'planCopy', 'planMissing',
      'toggleGround', 'toggleRunways', 'toggleFixes', 'toggleSectors',
      'toggleGrid', 'toggleMeasure', 'resetView',
      'chartHint', 'readoutRoute', 'readoutDistance', 'readoutEte', 'readoutCruise',
      'profileCollapse', 'profilePlot',
      'tabAtis', 'tabLive', 'atisCards', 'atisNote', 'atisRunways', 'atisRefresh',
      'relayUrl', 'relayConnect', 'relayProbe', 'relayStatus', 'filedPlan',
      'trackQuery', 'trackStart', 'trackStop', 'trackFromPlan',
      'caution', 'cautionTitle', 'cautionDetail', 'linkState', 'chart',
      'addPopover', 'addTitle', 'addMsg', 'addFixActions', 'addAirportActions',
      'addToRoute', 'addToEnd', 'setDeparture', 'setArrival', 'addCancel',
    ]) {
      dom[id] = document.getElementById(id);
    }

    sound.load();

    const data = window.ATC24_MAP_DATA;
    if (!data) {
      dom.chartHint.textContent = 'Chart database failed to load. Check that js/map-data.js is deployed.';
      dom.boot.dataset.complete = 'true';
      return;
    }

    dom.bootStatus.textContent = 'Loading chart database';
    window.Nav.chart.init(data);
    pass('chart');
    await wait(110);

    dom.bootStatus.textContent = 'Loading navigation fixes';
    populateSelects();
    window.Nav.route.restore();
    window.Nav.strip.init();
    pass('fixes');
    await wait(110);

    dom.bootStatus.textContent = 'Reading airspace boundaries';
    window.Nav.chart.onPick((point, event) => addFlow.open(point, event));
    window.Nav.route.onChange(renderAll);
    window.Nav.instruments.init();
    bindControls();
    pass('airspace');
    await wait(110);

    dom.bootStatus.textContent = 'Arming relay link';
    window.Nav.live.load();
    // Relay traffic is far more frequent than route edits, so it repaints only
    // the panels that depend on it rather than the whole planner.
    window.Nav.live.onChange(() => {
      renderLive();
      renderAtis();
      window.Nav.instruments.render();
    });
    window.Nav.live.connect();
    pass('relay');
    await wait(110);

    try {
      if (window.localStorage.getItem(PROFILE_KEY) === 'collapsed') {
        dom.app.dataset.profile = 'collapsed';
        dom.profileCollapse.textContent = 'Show';
        dom.profileCollapse.setAttribute('aria-expanded', 'false');
      }
    } catch (error) {
      // Default to open.
    }

    window.Nav.profile.init();
    alerts.render();
    renderAll();
    window.Nav.chart.fitTo(window.Nav.route.nodes());
    dom.bootStatus.textContent = 'Building vertical profile';
    pass('profile');

    if (document.fonts?.ready) {
      try {
        await document.fonts.ready;
      } catch (error) {
        // Font loading is not worth blocking the page on.
      }
    }
    await wait(200);

    const dismiss = () => {
      dom.boot.dataset.complete = 'true';
      dom.boot.setAttribute('aria-hidden', 'true');
      window.setTimeout(() => window.Nav.profile.render(), 60);
    };

    // Browsers will not play audio without a user gesture, so the chime rides on
    // the entry click instead of firing on load and being silently blocked.
    if (!sound.enabled()) {
      dom.bootStatus.textContent = 'Flight deck ready';
      await wait(320);
      dismiss();
      return;
    }

    dom.bootStatus.textContent = 'Flight deck ready';
    dom.bootEnter.hidden = false;
    window.setTimeout(() => dom.bootEnter.focus({ preventScroll: true }), 240);

    dom.bootEnter.addEventListener('click', async () => {
      dom.bootEnter.disabled = true;
      dom.bootEnter.hidden = true;
      dom.bootStatus.textContent = 'Welcome aboard';
      try {
        await sound.chime.play();
      } catch (error) {
        console.warn('Cabin chime could not play:', error);
      }
      dismiss();
    }, { once: true });
  }

  window.Nav.alerts = alerts;
  window.Nav.sound = sound;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
