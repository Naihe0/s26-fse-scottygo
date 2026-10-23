// Memory diagnostics dashboard: charts persisted memory samples, summarizes
// them, drills into peaks and flagged samples, and exports CSV.

interface MemorySample {
  timestamp: string;
  reason: string;
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb?: number;
  externalMb?: number;
  arrayBuffersMb?: number;
  uptimeSec?: number;
  peakRssMb?: number;
  peakHeapUsedMb?: number;
  warning: boolean;
  critical: boolean;
}

interface MemorySummary {
  rss?: { latestMb?: number; maxMb?: number; slopeMbPerMin?: number };
  heap?: { latestUsedMb?: number; maxUsedMb?: number };
  flags?: { warningCount?: number; criticalCount?: number };
  likelyCause?: string;
  recommendation?: string;
}

interface ChartPoint {
  sample: MemorySample;
  x: number;
}

const WARNING_RSS_MB = 420;
const CRITICAL_RSS_MB = 460;
const RENDER_MEMORY_LIMIT_MB = 512;
const PEAK_CONTEXT_MS = 2 * 60 * 1000;
const CHART_PADDING = 30;
const COLORS = {
  rss: '#007f8c',
  heap: '#df5a49',
  limit: '#7a3e00',
  grid: '#d6e4e6',
  muted: '#4b6b70'
};
const CSV_COLUMNS: (keyof MemorySample)[] = [
  'timestamp',
  'reason',
  'rssMb',
  'heapUsedMb',
  'heapTotalMb',
  'externalMb',
  'arrayBuffersMb',
  'uptimeSec',
  'peakRssMb',
  'peakHeapUsedMb',
  'warning',
  'critical'
];

const byId = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const limitInput = byId<HTMLInputElement>('limit');
const refreshInput = byId<HTMLInputElement>('refresh');
const statusEl = byId<HTMLElement>('status');
const metricsEl = byId<HTMLElement>('metrics');
const causeEl = byId<HTMLElement>('cause');
const recommendationEl = byId<HTMLElement>('recommendation');
const errorEl = byId<HTMLElement>('error');
const detailListEl = byId<HTMLUListElement>('detailList');
const canvas = byId<HTMLCanvasElement>('chart');
const tooltipEl = byId<HTMLElement>('tooltip');
const context = canvas.getContext('2d');

let refreshTimer: number | null = null;
let samples: MemorySample[] = [];
let chartPoints: ChartPoint[] = [];

const fmt = (value: number | undefined) =>
  Number.isFinite(value) ? value!.toFixed(1) : 'n/a';
const yesNo = (value: boolean) => (value ? 'yes' : 'no');
const clampInput = (input: HTMLInputElement, min: number, max: number) =>
  Math.max(min, Math.min(max, Number(input.value) || Number(input.defaultValue)));

window.addEventListener('error', (event) => {
  errorEl.textContent = `Runtime error: ${event.message || 'Unknown runtime error'}`;
});
window.addEventListener('unhandledrejection', (event) => {
  errorEl.textContent = `Unhandled promise rejection: ${String(event.reason ?? 'unknown')}`;
});

// ── Chart ──────────────────────────────────────────────────────────

function drawChart(points: MemorySample[]): void {
  chartPoints = [];
  if (!context) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (!points.length) {
    context.fillStyle = COLORS.muted;
    context.fillText('No samples yet', 10, 20);
    return;
  }

  const width = canvas.width - CHART_PADDING * 2;
  const height = canvas.height - CHART_PADDING * 2;
  const values = points.flatMap((s) => [s.rssMb, s.heapUsedMb]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(max - min, 1);
  const x = (index: number) =>
    CHART_PADDING + (index / Math.max(points.length - 1, 1)) * width;
  const y = (value: number) =>
    CHART_PADDING + height - ((value - min) / span) * height;

  context.strokeStyle = COLORS.grid;
  context.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const gridY = CHART_PADDING + (height * i) / 4;
    context.beginPath();
    context.moveTo(CHART_PADDING, gridY);
    context.lineTo(CHART_PADDING + width, gridY);
    context.stroke();
  }

  for (const [key, color] of [
    ['rssMb', COLORS.rss],
    ['heapUsedMb', COLORS.heap]
  ] as const) {
    context.strokeStyle = color;
    context.lineWidth = 2;
    context.beginPath();
    points.forEach((sample, index) => {
      if (index === 0) context.moveTo(x(index), y(sample[key]));
      else context.lineTo(x(index), y(sample[key]));
    });
    context.stroke();
  }

  const limitY = y(RENDER_MEMORY_LIMIT_MB);
  if (limitY >= CHART_PADDING && limitY <= CHART_PADDING + height) {
    context.save();
    context.setLineDash([6, 5]);
    context.strokeStyle = COLORS.limit;
    context.lineWidth = 1.5;
    context.beginPath();
    context.moveTo(CHART_PADDING, limitY);
    context.lineTo(CHART_PADDING + width, limitY);
    context.stroke();
    context.restore();
    context.fillStyle = COLORS.limit;
    context.fillText(
      `${RENDER_MEMORY_LIMIT_MB} MB limit`,
      CHART_PADDING + 6,
      Math.max(limitY - 6, 12)
    );
  }

  chartPoints = points.map((sample, index) => ({ sample, x: x(index) }));
  context.fillStyle = COLORS.muted;
  context.fillText(`min ${fmt(min)} MB`, CHART_PADDING, 15);
  context.fillText(`max ${fmt(max)} MB`, canvas.width - 120, 15);
}

function closestPoint(chartX: number): ChartPoint | null {
  let best: ChartPoint | null = null;
  for (const point of chartPoints) {
    if (!best || Math.abs(chartX - point.x) < Math.abs(chartX - best.x)) {
      best = point;
    }
  }
  return best;
}

canvas.addEventListener('mousemove', (event) => {
  const rect = canvas.getBoundingClientRect();
  const point = closestPoint(
    ((event.clientX - rect.left) / rect.width) * canvas.width
  );
  if (!point) {
    tooltipEl.style.display = 'none';
    return;
  }
  const s = point.sample;
  tooltipEl.style.display = 'block';
  tooltipEl.style.left = `${event.clientX - rect.left}px`;
  tooltipEl.style.top = `${event.clientY - rect.top}px`;
  tooltipEl.textContent = [
    `time: ${s.timestamp}`,
    `reason: ${s.reason}`,
    `rss: ${fmt(s.rssMb)} MB`,
    `heap: ${fmt(s.heapUsedMb)} MB`,
    `warning: ${yesNo(s.warning)}`,
    `critical: ${yesNo(s.critical)}`
  ].join('\n');
});

canvas.addEventListener('mouseleave', () => {
  tooltipEl.style.display = 'none';
});

// ── Drilldown ──────────────────────────────────────────────────────

function showDetails(items: MemorySample[]): void {
  const rows = items.map((s) => {
    const row = document.createElement('li');
    const time = document.createElement('strong');
    time.textContent = s.timestamp;
    row.append(
      time,
      ` | reason: ${s.reason} | rss: ${fmt(s.rssMb)} MB | heap: ${fmt(s.heapUsedMb)} MB` +
        ` | warning: ${yesNo(s.warning)} | critical: ${yesNo(s.critical)}`
    );
    return row;
  });
  if (rows.length === 0) {
    const empty = document.createElement('li');
    empty.textContent = 'No matching log data found.';
    rows.push(empty);
  }
  detailListEl.replaceChildren(...rows);
}

/** The highest sample by `key` and its neighbors within two minutes. */
function aroundPeak(key: 'rssMb' | 'heapUsedMb'): MemorySample[] {
  if (!samples.length) return [];
  const peak = samples.reduce((best, s) => (s[key] > best[key] ? s : best));
  const peakTime = Date.parse(peak.timestamp);
  return samples
    .filter((s) => Math.abs(Date.parse(s.timestamp) - peakTime) <= PEAK_CONTEXT_MS)
    .slice(-10)
    .reverse();
}

function rssSlopeSample(): MemorySample[] {
  if (samples.length < 2) return [];
  const first = samples[0];
  const last = samples[samples.length - 1];
  const minutes = Math.max(
    (Date.parse(last.timestamp) - Date.parse(first.timestamp)) / 60_000,
    0.001
  );
  const slope = (last.rssMb - first.rssMb) / minutes;
  return [
    {
      ...last,
      reason: `rss.slope ${fmt(slope)} MB/min from ${first.timestamp}`
    }
  ];
}

const latestSample = () => samples.slice(-1);
const flagged = (flag: 'warning' | 'critical') =>
  samples.filter((s) => s[flag]).slice(-25).reverse();

const METRIC_DETAILS: Record<string, () => MemorySample[]> = {
  rsslatest: latestSample,
  rssmax: () => aroundPeak('rssMb'),
  rssslope: rssSlopeSample,
  heaplatest: latestSample,
  heapmax: () => aroundPeak('heapUsedMb'),
  warnings: () => flagged('warning'),
  criticals: () => flagged('critical')
};

// ── Metrics ────────────────────────────────────────────────────────

function renderMetrics(summary: MemorySummary): void {
  const { rss = {}, heap = {}, flags = {} } = summary;
  const rssMaxClass =
    (rss.maxMb ?? 0) >= CRITICAL_RSS_MB
      ? 'crit'
      : (rss.maxMb ?? 0) >= WARNING_RSS_MB
        ? 'warn'
        : '';
  const metrics: [string, string, string, string][] = [
    ['RSS latest', `${fmt(rss.latestMb)} MB`, '', 'rsslatest'],
    ['RSS max', `${fmt(rss.maxMb)} MB`, rssMaxClass, 'rssmax'],
    ['RSS slope', `${fmt(rss.slopeMbPerMin)} MB/min`, '', 'rssslope'],
    ['Heap latest', `${fmt(heap.latestUsedMb)} MB`, '', 'heaplatest'],
    ['Heap max', `${fmt(heap.maxUsedMb)} MB`, '', 'heapmax'],
    ['Warnings', String(flags.warningCount ?? 0), 'warn', 'warnings'],
    ['Criticals', String(flags.criticalCount ?? 0), 'crit', 'criticals']
  ];

  metricsEl.replaceChildren(
    ...metrics.map(([label, value, className, action]) => {
      const card = document.createElement('div');
      card.className = 'metric';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'metricButton';
      button.dataset.action = action;
      button.setAttribute('aria-label', label);
      const labelEl = document.createElement('span');
      labelEl.className = 'metricLabel';
      labelEl.textContent = label;
      const valueEl = document.createElement('strong');
      valueEl.className = className;
      valueEl.textContent = value;
      button.append(labelEl, valueEl);
      card.append(button);
      return card;
    })
  );
  causeEl.textContent = summary.likelyCause || 'n/a';
  recommendationEl.textContent = summary.recommendation || 'n/a';
}

metricsEl.addEventListener('click', (event) => {
  const button = (event.target as Element).closest<HTMLElement>('.metricButton');
  if (!button) return;
  metricsEl
    .querySelectorAll('.metric')
    .forEach((card) => card.classList.remove('active'));
  button.closest('.metric')?.classList.add('active');
  const action = button.dataset.action ?? '';
  showDetails(METRIC_DETAILS[action]?.() ?? []);
  statusEl.textContent = `Metric selected: ${action || 'unknown'}`;
});

// ── Loading and export ─────────────────────────────────────────────

async function fetchPayload<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Memory endpoint request failed: ${response.status}`);
  }
  return ((await response.json()) as { payload: T }).payload;
}

async function reload(): Promise<void> {
  errorEl.textContent = '';
  statusEl.textContent = 'Loading...';
  const limit = clampInput(limitInput, 10, 2000);
  try {
    const [newestFirst, summary] = await Promise.all([
      fetchPayload<MemorySample[]>(`/transit/memory/samples?limit=${limit}`),
      fetchPayload<MemorySummary>(`/transit/memory/summary?limit=${limit}`)
    ]);
    samples = Array.isArray(newestFirst) ? [...newestFirst].reverse() : [];
    drawChart(samples);
    renderMetrics(summary ?? {});
    statusEl.textContent = `Updated ${new Date().toISOString()}`;
  } catch (error) {
    statusEl.textContent = 'Failed';
    drawChart([]);
    renderMetrics({});
    errorEl.textContent = error instanceof Error ? error.message : String(error);
  }
}

function restartRefreshTimer(): void {
  if (refreshTimer !== null) window.clearInterval(refreshTimer);
  const seconds = clampInput(refreshInput, 5, 300);
  refreshTimer = window.setInterval(() => void reload(), seconds * 1000);
}

function downloadCsv(): void {
  if (!samples.length) {
    statusEl.textContent = 'No samples to export yet';
    return;
  }
  const cell = (value: unknown) =>
    `"${(value == null ? '' : String(value)).replace(/"/g, '""')}"`;
  const csv = [
    CSV_COLUMNS,
    ...samples.map((sample) => CSV_COLUMNS.map((column) => sample[column]))
  ]
    .map((row) => row.map(cell).join(','))
    .join('\n');

  const url = URL.createObjectURL(
    new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = `scottygo-memory-samples-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  statusEl.textContent = `CSV exported (${samples.length} rows)`;
}

byId('reload').addEventListener('click', () => void reload());
byId('downloadCsv').addEventListener('click', downloadCsv);
refreshInput.addEventListener('change', restartRefreshTimer);

// Render placeholders immediately so the dashboard is never visually empty.
drawChart([]);
renderMetrics({});
void reload();
restartRefreshTimer();
