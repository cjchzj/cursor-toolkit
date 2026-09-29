const { readSession } = require('./auth');

const SUMMARY_URL = 'https://cursor.com/api/usage-summary';
const EVENTS_URL = 'https://cursor.com/api/dashboard/get-filtered-usage-events';
const PERIOD_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage';

function asNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function parsePercent(message) {
  if (typeof message !== 'string') return null;
  const match = message.match(/(\d+(?:\.\d+)?)\s*%/);
  return match ? Number(match[1]) : null;
}

function poolOf(model) {
  const name = String(model || '').toLowerCase();
  if (name.includes('grok') || name.includes('composer')) return 'grok';
  return 'other';
}

function findEvents(body) {
  if (!body || typeof body !== 'object') return [];
  for (const key of ['usageEventsDisplay', 'usageEvents', 'events', 'items']) {
    if (Array.isArray(body[key])) return body[key];
  }
  return [];
}

function eventTime(event) {
  const raw = event.timestamp ?? event.time ?? event.createdAt ?? event.date;
  const num = asNumber(raw);
  if (num != null) return num < 1e12 ? num * 1000 : num;
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

function eventCents(event) {
  const charged = asNumber(event.chargedCents);
  if (charged != null) return charged;
  const total = asNumber(event.tokenUsage?.totalCents ?? event.totalCents);
  if (total != null) return total;
  const dollars = asNumber(event.usageBasedCosts ?? event.requestsCosts);
  if (dollars != null) return dollars > 5 ? dollars : dollars * 100;
  return null;
}

function normalizeEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const model = String(event.model || event.modelIntent || event.modelName || '未知模型');
  return {
    model,
    pool: poolOf(model),
    cents: eventCents(event),
    at: eventTime(event),
    inputTokens: asNumber(event.tokenUsage?.inputTokens ?? event.inputTokens ?? event.promptTokens),
    outputTokens: asNumber(event.tokenUsage?.outputTokens ?? event.outputTokens ?? event.completionTokens),
    cacheReadTokens: asNumber(event.tokenUsage?.cacheReadTokens ?? event.cacheReadTokens),
    cacheWriteTokens: asNumber(event.tokenUsage?.cacheWriteTokens ?? event.cacheWriteTokens),
  };
}

function pickPercents(summary) {
  const plan = summary?.individualUsage?.plan || summary?.planUsage || summary?.plan || {};
  let grok = asNumber(plan.autoPercentUsed);
  let other = asNumber(plan.apiPercentUsed);
  if (grok == null) grok = parsePercent(summary?.autoModelSelectedDisplayMessage);
  if (other == null) other = parsePercent(summary?.namedModelSelectedDisplayMessage);
  return {
    grok,
    other,
    total: asNumber(plan.totalPercentUsed),
    plan: summary?.membershipType || summary?.individualMembershipType || plan.planName || '',
    resetsAt: summary?.billingCycleEnd || summary?.planInfo?.billingCycleEnd || null,
    unlimited: summary?.isUnlimited === true,
  };
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  return { status: response.status, body };
}

function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

function cookieHeaders(session) {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Cookie: `WorkosCursorSessionToken=${session.cookie}`,
    Origin: 'https://cursor.com',
    Referer: 'https://cursor.com/dashboard/usage',
  };
}

class UsageMonitor {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.session = null;
    this.sessionAt = 0;
    this.cache = null;
    this.cacheAt = 0;
    this.refreshing = null;
  }

  async sessionNow(force) {
    if (!force && this.session && Date.now() - this.sessionAt < 10 * 60 * 1000) return this.session;
    this.session = await readSession(this.dbPath);
    this.sessionAt = Date.now();
    return this.session;
  }

  async refresh(force) {
    if (!force && this.cache && Date.now() - this.cacheAt < 20000) return this.cache;
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.load().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  async load() {
    try {
      let session = await this.sessionNow(false);
      if (!session) {
        this.cache = emptyUsage('没有读到 Cursor 登录状态');
        this.cacheAt = Date.now();
        return this.cache;
      }
      let summary = await this.loadSummary(session);
      if (summary.status === 401 || summary.status === 403) {
        session = await this.sessionNow(true);
        if (!session) {
          this.cache = emptyUsage('登录已失效，请在 Cursor 里重新登录');
          this.cacheAt = Date.now();
          return this.cache;
        }
        summary = await this.loadSummary(session);
      }
      const percents = summary.body ? pickPercents(summary.body) : {};
      if (percents.grok == null && percents.other == null) {
        const period = await this.loadPeriod(session);
        if (period.body) Object.assign(percents, pickPercents(period.body));
      }
      const recent = await this.loadRecent(session);
      const last = recent[0] || null;
      this.cache = {
        ok: percents.grok != null || percents.other != null,
        error: percents.grok == null && percents.other == null ? '额度接口没有返回百分比' : null,
        grok: percents.grok,
        other: percents.other,
        total: percents.total,
        plan: percents.plan || '',
        resetsAt: percents.resetsAt || null,
        unlimited: Boolean(percents.unlimited),
        last,
        recent: recent.slice(0, 3),
        updatedAt: Date.now(),
      };
      this.cacheAt = Date.now();
      return this.cache;
    } catch {
      this.cache = emptyUsage('暂时连不上额度服务');
      this.cacheAt = Date.now();
      return this.cache;
    }
  }

  async loadSummary(session) {
    return fetchJson(SUMMARY_URL, {
      headers: cookieHeaders(session),
      signal: timeoutSignal(12000),
    });
  }

  async loadPeriod(session) {
    return fetchJson(PERIOD_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.token}`,
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
      },
      body: '{}',
      signal: timeoutSignal(12000),
    });
  }

  async loadRecent(session) {
    const end = Date.now();
    const start = end - 14 * 24 * 3600 * 1000;
    const first = await fetchJson(EVENTS_URL, {
      method: 'POST',
      headers: cookieHeaders(session),
      body: JSON.stringify({
        startDate: String(start),
        endDate: String(end),
        page: 1,
        pageSize: 30,
      }),
      signal: timeoutSignal(12000),
    });
    let events = findEvents(first.body).map(normalizeEvent).filter(Boolean);
    if (!events.length) {
      const wider = await fetchJson(EVENTS_URL, {
        method: 'POST',
        headers: cookieHeaders(session),
        body: JSON.stringify({ page: 1, pageSize: 20 }),
        signal: timeoutSignal(12000),
      });
      events = findEvents(wider.body).map(normalizeEvent).filter(Boolean);
    }
    events.sort((a, b) => b.at - a.at);
    return events;
  }
}

function emptyUsage(error) {
  return {
    ok: false,
    error,
    grok: null,
    other: null,
    total: null,
    plan: '',
    resetsAt: null,
    unlimited: false,
    last: null,
    recent: [],
    updatedAt: Date.now(),
  };
}

module.exports = { UsageMonitor, poolOf };
