const assert = require('node:assert/strict');
const test = require('node:test');

global.window = global;
global.CustomEvent = class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } };
global.dispatchEvent = () => {};
global.document = {
  createElement() {
    return {
      className: '', textContent: '', children: [], style: {},
      append(...nodes) { this.children.push(...nodes); },
      setAttribute() {}, remove() { this.removed = true; },
    };
  },
  getElementById() { return { value: '60' }; },
};
global.ResizeObserver = class { observe() {} disconnect() {} };

const charts = new Map();
global.LightweightCharts = {
  CrosshairMode: { Normal: 0 },
  CandlestickSeries: {},
  createChart(host) {
    const state = { bars: [], removed: false };
    const series = {
      setData(data) { state.bars = [...data]; },
      update(bar, historicalUpdate = false) {
        const i = state.bars.findIndex(item => item.time === bar.time);
        if (i >= 0) {
          assert.ok(historicalUpdate || i === state.bars.length - 1, 'older correction requires historicalUpdate');
          state.bars[i] = bar;
        } else {
          assert.ok(!state.bars.length || bar.time > state.bars.at(-1).time, 'new bars must be chronological');
          state.bars.push(bar);
        }
      },
    };
    const chart = {
      addSeries() { return series; },
      subscribeCrosshairMove() {},
      remove() { state.removed = true; },
      resize() {},
      timeScale() { return { fitContent() {}, scrollToRealTime() {} }; },
    };
    state.chart = chart; state.series = series; charts.set(host, state); return chart;
  },
};

require('./chart_manager.js');
const contract = (token, strike) => ({ exchangeType: 2, token, underlying: 'NIFTY',
  expiry: '2026-10-20', strike, side: 'CE' });

test('initial history, live updates, new candle and historical correction', () => {
  const host = document.createElement('div');
  const manager = new AthenaCharts(host);
  const panel = manager.add(contract('101', 25000));
  manager.setData(panel.key, [
    { time: 1792208700, open: 100, high: 101, low: 99, close: 100.5 },
    { time: 1792208760, open: 100.5, high: 102, low: 100, close: 101 },
  ]);
  manager.update(panel.key, { time: 1792208760, open: 100.5, high: 103, low: 100, close: 102 },
    60, '2026-10-17T09:16:55+05:30');
  manager.update(panel.key, { time: 1792208820, open: 102, high: 104, low: 101, close: 103 },
    60, '2026-10-17T09:17:05+05:30');
  manager.update(panel.key, { time: 1792208760, open: 100.5, high: 103.5, low: 100, close: 102.5 },
    60, '2026-10-17T09:17:06+05:30');
  const state = charts.get(panel.chart._host) || [...charts.values()][0];
  assert.equal(state.bars.length, 3);
  assert.equal(state.bars[1].high, 103.5);
  assert.equal(state.bars[1].close, 102.5);
  assert.equal(state.bars[2].close, 103);
  manager.remove(panel.key);
  assert.equal(manager.panels.size, 0);
});

test('multiple instruments retain separate chart state', () => {
  const manager = new AthenaCharts(document.createElement('div'), 2);
  const ce = manager.add(contract('101', 25000));
  const pe = manager.add({ ...contract('102', 25000), side: 'PE' });
  assert.notEqual(ce.key, pe.key);
  manager.setData(ce.key, [{ time: 1792208700, open: 100, high: 101, low: 99, close: 100 }]);
  manager.setData(pe.key, [{ time: 1792208700, open: 200, high: 201, low: 199, close: 200 }]);
  assert.equal(manager.panels.size, 2);
  assert.throws(() => manager.add(contract('103', 25100)), /Chart limit reached/);
});

test('higher timeframe history rolls up on the IST 09:15 session boundary', () => {
  const manager = new AthenaCharts(document.createElement('div'));
  const panel = manager.add(contract('201', 25000));
  panel.seconds = 120;
  manager.setData(panel.key, [
    { time: 1792208700, open: 100, high: 102, low: 99, close: 101 },
    { time: 1792208760, open: 101, high: 103, low: 100, close: 102 },
  ]);
  const state = [...charts.values()].at(-1);
  assert.equal(state.bars.length, 1);
  assert.equal(state.bars[0].time, 1792208700);
  assert.equal(state.bars[0].high, 103);
  assert.equal(state.bars[0].close, 102);
});
