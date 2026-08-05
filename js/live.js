/* ==========================================================================
   24Nav live data
   Client for the ATC24 Universal Relay. Opens one WebSocket to /v1/live,
   subscribes to ATIS and status, and tracks a single aircraft by Roblox
   username or in-game callsign. Everything the relay sends is fanned out to the
   guidance instruments, the caution system, the vertical profile and the ATIS
   panel.

   Note on the relay protocol: index.js sends store events as
   `{ type: "event", ...event }`, and the spread overwrites `type`, so topic
   events arrive as type "aircraft", "atis", "controllers", "flightPlan" or
   "status" rather than "event". Direct replies keep their own types.
   ========================================================================== */

window.Nav = window.Nav || {};

(() => {
  'use strict';

  const RELAY_KEY = '24nav.relay';
  const TRACK_KEY = '24nav.track';
  const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000, 30000];
  const STALE_AFTER_MS = 15000;

  const live = {
    socket: null,
    url: '',
    trackQuery: '',
    state: 'idle',
    attempt: 0,
    retryTimer: 0,
    lastMessageAt: 0,
    upstream: null,
    aircraft: null,
    flightPlan: null,
    atis: { departure: null, arrival: null },
    all: new Map(),
    listeners: [],
    staleTimer: 0,

    /* --- configuration --------------------------------------------------- */

    load() {
      try {
        this.url = window.localStorage.getItem(RELAY_KEY) || '';
        this.trackQuery = window.localStorage.getItem(TRACK_KEY) || '';
      } catch (error) {
        this.url = '';
        this.trackQuery = '';
      }
    },

    save() {
      try {
        window.localStorage.setItem(RELAY_KEY, this.url);
        window.localStorage.setItem(TRACK_KEY, this.trackQuery);
      } catch (error) {
        // Nothing to do. The session still works.
      }
    },

    /** Accepts a bare host, an http(s) origin or a ws(s) origin. */
    normalizeUrl(input) {
      let text = String(input || '').trim().replace(/\/+$/, '');
      if (!text) return '';
      if (!/^[a-z]+:\/\//i.test(text)) text = `https://${text}`;
      let parsed;
      try {
        parsed = new URL(text);
      } catch (error) {
        return '';
      }
      // A relay on http cannot be reached from a page served over https, so
      // upgrade the scheme rather than failing silently on mixed content.
      const secure = window.location.protocol === 'https:'
        || parsed.protocol === 'https:' || parsed.protocol === 'wss:';
      parsed.protocol = secure ? 'https:' : 'http:';
      // Assigning an empty string to URL.pathname puts '/' back, so the trailing
      // path is computed separately rather than written to the URL object.
      const path = parsed.pathname.replace(/\/v1\/live\/?$/, '').replace(/\/+$/, '');
      return parsed.origin + path;
    },

    httpBase() {
      return this.url;
    },

    wsUrl() {
      if (!this.url) return '';
      return `${this.url.replace(/^http/, 'ws')}/v1/live`;
    },

    setUrl(input) {
      const next = this.normalizeUrl(input);
      if (next === this.url) return;
      this.url = next;
      this.save();
      this.reconnect(true);
    },

    setTrack(query) {
      const next = String(query || '').trim();
      if (next === this.trackQuery) return;
      this.trackQuery = next;
      this.save();
      if (this.socket && this.state === 'open') {
        this.send(next ? { type: 'track', query: next, server: 'auto' } : { type: 'untrack' });
      }
      if (!next) this.clearAircraft();
      this.emit();
    },

    /* --- connection ------------------------------------------------------ */

    connect() {
      if (!this.url) {
        this.setState('unconfigured');
        return;
      }
      if (this.socket) return;
      const target = this.wsUrl();
      this.setState('connecting');
      let socket;
      try {
        socket = new WebSocket(target);
      } catch (error) {
        this.setState('error', String(error?.message || error));
        this.scheduleRetry();
        return;
      }
      this.socket = socket;

      socket.addEventListener('open', () => {
        this.attempt = 0;
        this.setState('open');
        this.send({ type: 'subscribe', topics: ['status', 'atis'] });
        if (this.trackQuery) this.send({ type: 'track', query: this.trackQuery, server: 'auto' });
        this.bootstrap();
      });

      socket.addEventListener('message', (event) => {
        this.lastMessageAt = Date.now();
        let message;
        try {
          message = JSON.parse(event.data);
        } catch (error) {
          return;
        }
        this.handle(message);
      });

      socket.addEventListener('close', () => {
        this.socket = null;
        if (this.state !== 'stopped') {
          this.setState('closed');
          this.scheduleRetry();
        }
      });

      socket.addEventListener('error', () => {
        this.setState('error', 'WebSocket error');
      });
    },

    disconnect() {
      window.clearTimeout(this.retryTimer);
      this.setState('stopped');
      if (this.socket) {
        try {
          this.socket.close();
        } catch (error) {
          // Already gone.
        }
        this.socket = null;
      }
    },

    reconnect(immediate = false) {
      window.clearTimeout(this.retryTimer);
      if (this.socket) {
        try {
          this.socket.close();
        } catch (error) {
          // Already gone.
        }
        this.socket = null;
      }
      this.attempt = 0;
      if (immediate) this.connect();
      else this.scheduleRetry();
    },

    scheduleRetry() {
      window.clearTimeout(this.retryTimer);
      if (!this.url) return;
      const wait = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
      this.attempt += 1;
      // Jitter, so a relay restart does not get hammered by every open tab at
      // the same instant.
      const jitter = Math.round(Math.random() * 400);
      this.retryTimer = window.setTimeout(() => this.connect(), wait + jitter);
    },

    send(payload) {
      if (!this.socket || this.socket.readyState !== 1) return;
      this.socket.send(JSON.stringify(payload));
    },

    setState(state, detail = '') {
      this.state = state;
      this.detail = detail;
      this.emit();
    },

    /* --- REST bootstrap -------------------------------------------------- */

    /**
     * ATIS is only pushed when an airport updates, so a fresh connection would
     * otherwise show nothing until someone retypes a report. One REST read fills
     * the gap.
     */
    async bootstrap() {
      if (!this.httpBase()) return;
      try {
        const response = await fetch(`${this.httpBase()}/v1/atis`, { mode: 'cors' });
        if (!response.ok) return;
        const payload = await response.json();
        for (const item of payload?.data || []) {
          const airport = item?.parsed?.airport || item?.raw?.airport;
          if (airport) this.all.set(String(airport).toUpperCase(), item.parsed || null);
        }
        this.applyAtis();
        this.emit();
      } catch (error) {
        // The WebSocket is the primary path. A failed bootstrap is not fatal.
      }
    },

    async probe() {
      if (!this.httpBase()) return null;
      try {
        const response = await fetch(`${this.httpBase()}/v1/status`, { mode: 'cors' });
        if (!response.ok) return null;
        const payload = await response.json();
        this.upstream = payload?.upstream || null;
        this.counts = payload?.counts || null;
        this.emit();
        return payload;
      } catch (error) {
        return null;
      }
    },

    /* --- inbound --------------------------------------------------------- */

    handle(message) {
      switch (message.type) {
        case 'hello':
          this.upstream = message.status?.upstream || null;
          this.counts = message.status?.counts || null;
          break;
        case 'status':
          this.upstream = message.data?.upstream || null;
          this.counts = message.data?.counts || null;
          break;
        case 'atis': {
          const airport = String(message.airport || message.data?.parsed?.airport || '').toUpperCase();
          if (airport) this.all.set(airport, message.data?.parsed || null);
          this.applyAtis();
          break;
        }
        case 'track_update':
          this.applyTrack(message.data);
          break;
        case 'untracked':
          this.clearAircraft();
          break;
        case 'error':
          this.detail = String(message.error || 'relay error');
          break;
        default:
          break;
      }
      this.emit();
    },

    applyTrack(result) {
      if (!result?.found) {
        this.aircraft = null;
        this.flightPlan = result?.flightPlan || null;
        window.Nav.instruments.clear();
        window.Nav.alerts.evaluate(null);
        this.armStale();
        return;
      }
      this.aircraft = result.aircraft || null;
      this.flightPlan = result.flightPlan || null;
      if (result.atis?.departure) {
        this.all.set(String(result.atis.departure.airport || '').toUpperCase(), result.atis.departure);
      }
      if (result.atis?.arrival) {
        this.all.set(String(result.atis.arrival.airport || '').toUpperCase(), result.atis.arrival);
      }
      this.applyAtis();

      if (this.aircraft?.position) {
        window.Nav.instruments.update({
          position: this.aircraft.position,
          altitude: this.aircraft.altitude,
          heading: this.aircraft.heading,
          speed: this.aircraft.speed,
          isOnGround: this.aircraft.isOnGround,
          aircraftType: this.aircraft.aircraftType,
          isEmergencyOccurring: this.aircraft.isEmergencyOccurring,
          displayCallsign: this.flightPlan?.callsign || this.aircraft.telemetryCallsign,
        });
        window.Nav.alerts.evaluate(this.aircraft);
      }
      this.armStale();
    },

    clearAircraft() {
      this.aircraft = null;
      window.Nav.instruments.clear();
      window.Nav.alerts.evaluate(null);
      window.clearTimeout(this.staleTimer);
    },

    /** Live data that stops arriving must stop driving the instruments. */
    armStale() {
      window.clearTimeout(this.staleTimer);
      this.staleTimer = window.setTimeout(() => {
        this.aircraft = null;
        window.Nav.instruments.clear();
        window.Nav.alerts.evaluate(null);
        this.emit();
      }, STALE_AFTER_MS);
    },

    /** Push the ATIS for the current route ends into the vertical profile. */
    applyAtis() {
      const route = window.Nav.route;
      this.atis = {
        departure: this.all.get(String(route.departure).toUpperCase()) || null,
        arrival: this.all.get(String(route.arrival).toUpperCase()) || null,
      };
      window.Nav.profile.setAtis('departure', this.atis.departure?.content || '');
      window.Nav.profile.setAtis('arrival', this.atis.arrival?.content || '');
    },

    atisFor(code) {
      return this.all.get(String(code || '').toUpperCase()) || null;
    },

    /**
     * Adopts a filed flight plan into the planner: endpoints, cruise level,
     * route fixes that exist in the chart database, and the callsign fields.
     * Returns the fixes it could not resolve so the pilot is told rather than
     * silently given a shorter route.
     */
    adoptFlightPlan(plan) {
      const source = plan || this.flightPlan;
      if (!source) return { applied: false, unknown: [] };
      const route = window.Nav.route;

      if (source.departure && route.point(source.departure)) route.departure = source.departure;
      if (source.arrival && route.point(source.arrival)) route.arrival = source.arrival;

      const unknown = [];
      const fixes = [];
      for (const token of String(source.route || '').toUpperCase().split(/[\s,]+/)) {
        const name = token.trim();
        if (!name || name === 'DCT' || name === 'N/A') continue;
        if (name === route.departure || name === route.arrival) continue;
        if (route.point(name)) fixes.push({ name, altitude: null });
        else unknown.push(name);
      }
      route.fixes = fixes;

      const level = Number(String(source.flightLevel || '').replace(/[^\d]/g, ''));
      if (Number.isFinite(level) && level > 0) route.cruiseFl = Math.min(450, Math.max(10, level));

      if (source.realCallsign) route.plan.ingameCallsign = source.realCallsign;
      if (source.callsign) route.plan.filedCallsign = source.callsign;
      if (source.aircraft) route.plan.aircraft = source.aircraft;
      if (source.robloxName) route.plan.robloxName = source.robloxName;
      if (source.flightRules) route.plan.flightRules = String(source.flightRules).toUpperCase() === 'VFR' ? 'VFR' : 'IFR';

      route.departureRunway = route.defaultRunway(route.departure, 'departure');
      route.arrivalRunway = route.defaultRunway(route.arrival, 'arrival');
      route.selection = null;
      route.commit();
      this.applyAtis();
      return { applied: true, unknown };
    },

    /** Sets the planner runways from the ATIS in use at each end. */
    adoptAtisRunways() {
      const route = window.Nav.route;
      const applied = [];
      const departure = this.atisFor(route.departure);
      const arrival = this.atisFor(route.arrival);
      const pick = (list, code) => (list || []).find((label) => route.runwayGeometry(code, label)) || null;

      const dep = pick(departure?.departureRunways, route.departure);
      if (dep) {
        route.departureRunway = dep;
        applied.push(`${route.departure} ${dep}`);
      }
      const arr = pick(arrival?.arrivalRunways, route.arrival);
      if (arr) {
        route.arrivalRunway = arr;
        applied.push(`${route.arrival} ${arr}`);
      }
      if (applied.length) route.commit();
      return applied;
    },

    /* --- plumbing -------------------------------------------------------- */

    onChange(handler) {
      this.listeners.push(handler);
    },

    emit() {
      for (const handler of this.listeners) handler(this);
    },

    summary() {
      const label = {
        idle: 'Idle',
        unconfigured: 'No relay set',
        connecting: 'Connecting',
        open: 'Connected',
        closed: 'Reconnecting',
        error: 'Relay error',
        stopped: 'Stopped',
      }[this.state] || this.state;
      const upstreamOk = Boolean(this.upstream?.connected);
      return {
        state: this.state,
        label,
        upstreamOk,
        upstreamState: this.upstream?.state || 'unknown',
        counts: this.counts || null,
        tracking: Boolean(this.trackQuery),
        hasAircraft: Boolean(this.aircraft),
      };
    },
  };

  window.Nav.live = live;
})();
