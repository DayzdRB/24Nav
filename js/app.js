/* ==========================================================================
   24Nav app
   Boots the page, wires the chart to the route model, and owns the caution
   and warning layer. Live traffic arrives in a later step and feeds
   Nav.alerts.evaluate() with the same aircraft records the relay broadcasts.
   ========================================================================== */

window.Nav = window.Nav || {};

(() => {
  'use strict';

  const SOUND_KEY = '24nav.sound';
  const OVERSPEED_KT = 250;
  const OVERSPEED_ALT = 3000;
  const WARNING_COOLDOWN_MS = 20000;

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

    load() {
      this.chime = new Audio('assets/audio/cabin-chime.mp3');
      this.warning = new Audio('assets/audio/master-warning.mp3');
      this.chime.preload = 'auto';
      this.warning.preload = 'auto';
      this.warning.volume = 0.85;
    },

    play(which) {
      if (!this.enabled()) return;
      const audio = which === 'warning' ? this.warning : this.chime;
      if (!audio) return;
      audio.currentTime = 0;
      const attempt = audio.play();
      if (attempt?.catch) {
        attempt.catch(() => this.armOnGesture(which));
      }
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
    lastWarningAt: 0,
    active: null,

    show(text) {
      if (this.active === text) return;
      this.active = text;
      dom.bannerText.textContent = text;
      dom.banner.dataset.active = 'true';
      const now = Date.now();
      if (now - this.lastWarningAt > WARNING_COOLDOWN_MS) {
        this.lastWarningAt = now;
        sound.play('warning');
      }
    },

    clear() {
      if (!this.active) return;
      this.active = null;
      dom.banner.dataset.active = 'false';
    },

    /**
     * Evaluates one live aircraft record from the 24data feed. `speed` is the
     * airspeed the pilot reads on the flight deck, so the limit is checked
     * against that rather than the derived real-knot value.
     */
    evaluate(aircraft) {
      if (!aircraft) return this.clear();
      const speed = Number(aircraft.speed);
      const altitude = Number(aircraft.altitude);
      const onGround = aircraft.isOnGround === true;
      if (onGround || !Number.isFinite(speed) || !Number.isFinite(altitude)) return this.clear();
      if (speed > OVERSPEED_KT && altitude < OVERSPEED_ALT) {
        return this.show(`Overspeed  ${Math.round(speed)} kt  ${Math.round(altitude)} ft`);
      }
      return this.clear();
    },
  };

  /* --- readouts --------------------------------------------------------- */

  function renderReadouts() {
    const route = window.Nav.route;
    const nm = route.totalNm();
    const nodes = route.nodes();

    dom.readoutRoute.textContent = nodes.length >= 2
      ? `${route.departure} ${route.routeString()} ${route.arrival}`.replace(/\s+/g, ' ')
      : 'No route';
    dom.readoutDistance.textContent = `${nm.toFixed(1)} NM`;
    dom.readoutFixes.textContent = String(route.fixes.length);

    // Block time on the game's distance scale. An aircraft indicating 380 kt
    // crosses the ground at 380 * 0.592172785 = 225 kt, so real-world cruise
    // figures would understate every leg by a factor of about 1.7.
    if (nm > 0) {
      const groundKt = 380 * 0.592172785;
      const minutes = Math.round((nm / groundKt) * 60) + 3;
      dom.readoutEte.textContent = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    } else {
      dom.readoutEte.textContent = '--:--';
    }
  }

  function renderAll() {
    const route = window.Nav.route;
    window.Nav.strip.render();
    window.Nav.chart.drawRoute(route.nodes());
    window.Nav.chart.setSelected(
      route.selection?.type === 'fix' ? route.fixes[route.selection.index]?.name
      : route.selection?.type === 'departure' ? route.departure
      : route.selection?.type === 'arrival' ? route.arrival
      : null
    );
    window.Nav.profile.render();
    renderReadouts();
    dom.departure.value = route.departure;
    dom.arrival.value = route.arrival;
    dom.cruise.value = String(route.cruiseFl);
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
      dom.chartHint.innerHTML = `Inserting after <b>${name}</b>. Click a fix on the chart, or click ${name} in the list again to stop.`;
      return;
    }
    if (route.selection?.type) {
      dom.chartHint.innerHTML = `<b>${route.selection.type === 'departure' ? 'Departure' : 'Arrival'}</b> selected. Click an airport to change it.`;
      return;
    }
    dom.chartHint.innerHTML = '<b>Click a fix</b> to add it to the end of the route. Drag to pan, scroll to zoom.';
  }

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

  function bindControls() {
    dom.departure.addEventListener('change', () => window.Nav.route.setEndpoint('departure', dom.departure.value));
    dom.arrival.addEventListener('change', () => window.Nav.route.setEndpoint('arrival', dom.arrival.value));
    dom.cruise.addEventListener('change', () => window.Nav.route.setCruise(dom.cruise.value));
    dom.swap.addEventListener('click', () => window.Nav.route.swapEndpoints());

    const toggle = (button, name) => {
      button.addEventListener('click', () => {
        const next = button.getAttribute('aria-pressed') !== 'true';
        button.setAttribute('aria-pressed', String(next));
        window.Nav.chart.setLayer(name, next);
      });
    };
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
      const nodes = window.Nav.route.nodes();
      window.Nav.chart.fitTo(nodes.length ? nodes : Object.values(window.Nav.chart.airports));
    });

    dom.railToggle.addEventListener('click', () => {
      const next = dom.rail.dataset.open !== 'true';
      dom.rail.dataset.open = String(next);
      dom.railToggle.setAttribute('aria-expanded', String(next));
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (window.Nav.route.selection) window.Nav.route.select(null);
        if (window.Nav.chart.measureEnabled) dom.toggleMeasure.click();
      }
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
      'boot', 'rail', 'railToggle', 'departure', 'arrival', 'cruise', 'swap',
      'toggleFixes', 'toggleSectors', 'toggleGrid', 'toggleMeasure', 'resetView',
      'chartHint', 'readoutRoute', 'readoutDistance', 'readoutEte', 'readoutFixes',
      'banner', 'bannerText',
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

    window.Nav.chart.init(data);
    pass('chart');
    await wait(110);

    populateSelects();
    window.Nav.route.restore();
    window.Nav.strip.init();
    pass('fixes');
    await wait(110);

    window.Nav.chart.onPick((point) => window.Nav.route.addPoint(point));
    window.Nav.route.onChange(renderAll);
    bindControls();
    pass('airspace');
    await wait(110);

    window.Nav.profile.init();
    renderAll();
    window.Nav.chart.fitTo(window.Nav.route.nodes());
    pass('profile');

    if (document.fonts?.ready) {
      try {
        await document.fonts.ready;
      } catch (error) {
        // Font loading is not worth blocking the page on.
      }
    }
    await wait(260);

    dom.boot.dataset.complete = 'true';
    sound.play('chime');
    window.Nav.profile.render();
  }

  window.Nav.alerts = alerts;
  window.Nav.sound = sound;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
