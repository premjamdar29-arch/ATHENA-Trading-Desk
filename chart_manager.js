/* ATHENA chart lifecycle and per-instrument Lightweight Charts v5 adapter. */
(() => {
  const tfOptions = [5, 10, 15, 30, 60, 120, 300, 900, 1800, 3600, 14400, 86400];
  const labels = new Map([[5, '5s'], [10, '10s'], [15, '15s'], [30, '30s'], [60, '1m'],
    [120, '2m'], [300, '5m'], [900, '15m'], [1800, '30m'], [3600, '1h'],
    [14400, '4h'], [86400, '1d']]);
  const stamp = value => typeof value === 'number' ? Math.floor(value > 1e12 ? value / 1000 : value)
    : Math.floor(Date.parse(String(value)) / 1000);
  const toBar = c => ({ time: stamp(c.time), open: +c.open, high: +c.high,
    low: +c.low, close: +c.close });
  const istDate = seconds => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(seconds * 1000));
  const bucketStart = (seconds, timeframe) => {
    if (timeframe < 60) return Math.floor(seconds / timeframe) * timeframe;
    const day = istDate(seconds);
    const sessionOpen = Math.floor(Date.parse(day + 'T09:15:00+05:30') / 1000);
    if (timeframe >= 86400) return sessionOpen;
    return sessionOpen + Math.floor((seconds - sessionOpen) / timeframe) * timeframe;
  };

  class AthenaChartManager {
    constructor(host, maxPanels = 12) {
      this.host = host;
      this.maxPanels = maxPanels;
      this.panels = new Map();
      this.dark = false;
      this.currentPaper = null;
    }

    static key(contract) { return `${Number(contract.exchangeType)}:${String(contract.token)}`; }

    add(contract) {
      const key = AthenaChartManager.key(contract);
      if (this.panels.has(key)) return this.panels.get(key);
      if (this.panels.size >= this.maxPanels) throw new Error(`Chart limit reached (${this.maxPanels}). Remove a panel before adding another.`);
      if (!window.LightweightCharts) throw new Error('TradingView Lightweight Charts did not load. Check the local vendor file and refresh.');
      const card = document.createElement('article');
      card.className = 'market-chart-panel';
      const header = document.createElement('div');
      header.className = 'market-chart-head';
      const title = document.createElement('b');
      title.textContent = contract.kind === 'index'
        ? `${contract.underlying === 'NIFTY' ? 'NIFTY 50' : 'SENSEX'} Spot · Live`
        : contract.kind === 'equity'
          ? `${contract.symbol || contract.underlying} · NSE Cash · Live`
          : `${contract.underlying || ''} ${Number(contract.strike || 0).toLocaleString('en-IN')} ${contract.side || ''} · ${contract.expiry || ''}`;
      const quote = document.createElement('span');
      quote.className = 'market-chart-ltp'; quote.textContent = 'LTP —';
      const depthPopover = document.createElement('aside'); depthPopover.className = 'market-depth-overlay'; depthPopover.hidden = contract.kind === 'index';
      depthPopover.innerHTML = '<div class="market-depth-overlay-head"><div><b>Market Depth &amp; Quote</b><small class="market-depth-contract"></small></div></div><div class="market-depth-live-status"><i></i><span>Waiting for live depth</span></div><div class="market-depth-book-wrap"><table class="market-depth-table"><thead><tr><th>Qty.</th><th>Orders</th><th>Buy Price</th><th>Sell Price</th><th>Orders</th><th>Qty.</th></tr></thead><tbody></tbody></table></div><div class="market-depth-imbalance"><span></span><b class="depth-buy-total"></b><strong>Total Quantity</strong><b class="depth-sell-total"></b></div><div class="market-depth-stats"></div>';
      const depthTbody = depthPopover.querySelector('tbody'), depthContract = depthPopover.querySelector('.market-depth-contract'), depthStatus = depthPopover.querySelector('.market-depth-live-status span'), depthBuyTotal = depthPopover.querySelector('.depth-buy-total'), depthSellTotal = depthPopover.querySelector('.depth-sell-total'), depthStats = depthPopover.querySelector('.market-depth-stats'), depthBar = depthPopover.querySelector('.market-depth-imbalance span');
      const state = document.createElement('span');
      state.className = 'market-chart-state'; state.textContent = 'Loading history';
      let panel = null;
      const tradeActions = document.createElement('div');
      tradeActions.className = 'market-chart-actions';
      const buyPaper = document.createElement('button');
      buyPaper.className = 'btn chart-buy'; buyPaper.type = 'button'; buyPaper.textContent = 'BUY @ —';
      buyPaper.disabled = true;
      const lots = document.createElement('input');
      lots.className = 'market-chart-qty'; lots.type = 'number'; lots.min = '1'; lots.step = '1';
      lots.value = String(document.getElementById('lots')?.value || 1);
      lots.setAttribute('aria-label', 'Paper trade quantity in lots');
      const exitPaper = document.createElement('button');
      exitPaper.className = 'btn chart-sell'; exitPaper.type = 'button'; exitPaper.textContent = 'SELL @ —';
      exitPaper.disabled = true;
      const positionPnl = document.createElement('span');
      positionPnl.className = 'market-chart-position'; positionPnl.hidden = true;
      if (contract.kind === 'option') {
        tradeActions.append(buyPaper, lots, exitPaper, positionPnl);
        buyPaper.onclick = () => window.dispatchEvent(new CustomEvent('athena-chart-paper-action', {
          detail: { key: panel.key, action: 'buy', lots: lots.value }
        }));
        exitPaper.onclick = () => window.dispatchEvent(new CustomEvent('athena-chart-paper-action', {
          detail: { key: panel.key, action: 'exit' }
        }));
      }
      const timeframe = document.createElement('select');
      timeframe.className = 'market-chart-timeframe';
      timeframe.setAttribute('aria-label', 'Chart candle timeframe');
      for (const seconds of tfOptions) {
        const option = document.createElement('option');
        option.value = String(seconds);
        option.textContent = ({5:'5 seconds',10:'10 seconds',15:'15 seconds',30:'30 seconds',60:'1 minute',120:'2 minutes',300:'5 minutes',900:'15 minutes',1800:'30 minutes',3600:'1 hour',14400:'4 hours',86400:'1 day'})[seconds];
        timeframe.append(option);
      }
      timeframe.value = '60';
      const remove = document.createElement('button');
      remove.className = 'btn ghost small market-chart-remove'; remove.type = 'button'; remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg>';
      remove.setAttribute('aria-label', `Remove chart ${title.textContent}`);
      remove.title = 'Remove chart';
      header.append(title, quote, timeframe, state, remove);
      const host = document.createElement('div'); host.className = 'lightweight-chart-host';
      const footer = document.createElement('div'); footer.className = 'market-chart-footer';
      const current = document.createElement('span'); current.textContent = 'OHLC —';
      const fresh = document.createElement('span'); fresh.textContent = 'Waiting for market data';
      const fit = document.createElement('button'); fit.className = 'btn secondary small'; fit.type = 'button'; fit.textContent = 'Fit';
      const latest = document.createElement('button'); latest.className = 'btn secondary small'; latest.type = 'button'; latest.textContent = 'Go to latest';
      footer.append(current, fresh, fit, latest); card.append(header, host, footer, depthPopover); this.host.append(card);
      const chart = LightweightCharts.createChart(host, {
        autoSize: true, height: 360,
        layout: { background: { type: 'solid', color: this.dark ? '#111827' : '#fff' },
          textColor: this.dark ? '#cbd5e1' : '#66758a', fontFamily: 'Inter, system-ui, sans-serif', attributionLogo: false },
        grid: { vertLines: { color: this.dark ? '#273244' : '#eef1f5' }, horzLines: { color: this.dark ? '#273244' : '#eef1f5' } },
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal,
          vertLine: { color: this.dark ? '#344056' : '#e3e8ef' }, horzLine: { color: this.dark ? '#344056' : '#e3e8ef' } },
        rightPriceScale: { borderColor: this.dark ? '#344056' : '#e3e8ef', autoScale: true },
        timeScale: { borderColor: this.dark ? '#344056' : '#e3e8ef', timeVisible: true, secondsVisible: true,
          rightOffset: 4, barSpacing: 8, minBarSpacing: 2,
          tickMarkFormatter: time => new Intl.DateTimeFormat('en-IN', {
            timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false
          }).format(new Date(Number(time) * 1000)) },
        handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
        handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
        localization: { timeFormatter: time => new Intl.DateTimeFormat('en-IN', {
          timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit',
          hour12: false }).format(new Date(Number(time) * 1000) ) }
      });
      const series = chart.addSeries(LightweightCharts.CandlestickSeries, {
        upColor: '#16865a', downColor: '#cb4d52', borderVisible: false,
        wickUpColor: '#16865a', wickDownColor: '#cb4d52', priceLineVisible: true });
      if (contract.kind === 'option') host.append(tradeActions);
      panel = { key, contract, card, chart, series, title, quote, state, current, fresh,
        buyPaper, exitPaper, lots, positionPnl, depthPopover, depthTbody, depthContract, depthStatus, depthBuyTotal, depthSellTotal, depthStats, depthBar, depthQuote: null, tradeLines: [], tradeSignature: '', ltp: null,
        seconds: Number(timeframe.value), timeframe,
        baseBars: new Map(), lastTime: null, lastBar: null, historyRequestId: 0,
        dataSource: 'websocket-derived', resizeObserver: null };
      chart.subscribeCrosshairMove(param => {
        const bar = param?.seriesData?.get(series);
        current.textContent = bar ? `O ${bar.open.toFixed(2)} · H ${bar.high.toFixed(2)} · L ${bar.low.toFixed(2)} · C ${bar.close.toFixed(2)}` : 'OHLC —';
      });
      remove.onclick = () => this.remove(panel.key);
      timeframe.onchange = () => window.dispatchEvent(new CustomEvent('athena-chart-timeframe', {
        detail: { key: panel.key, seconds: Number(timeframe.value) }
      }));
      fit.onclick = () => chart.timeScale().fitContent();
      latest.onclick = () => chart.timeScale().scrollToRealTime();
      panel.resizeObserver = new ResizeObserver(entries => {
        const rect = entries[0]?.contentRect; if (rect?.width && rect?.height) chart.resize(rect.width, rect.height);
      });
      panel.resizeObserver.observe(host);
      this.panels.set(key, panel);
      this.host.classList?.toggle('single-chart', this.panels.size === 1);
      return panel;
    }

    replaceOption(contract) {
      const key = AthenaChartManager.key(contract);
      const optionPanels = [...this.panels.values()].filter(panel => panel.contract.kind === 'option');
      if (!optionPanels.length) {
        return this.add(contract);
      }
      const panel = optionPanels[0];
      const duplicate = this.panels.get(key);
      if (duplicate && duplicate !== panel) this.remove(duplicate.key);
      for (const extra of optionPanels) if (extra !== panel) this.remove(extra.key);
      this.panels.delete(panel.key);
      panel.historyRequestId++;
      clearTimeout(panel.historyLoadTimer); panel.historyLoadTimer = null;
      panel.key = key;
      panel.contract = contract;
      panel.depthPopover.hidden = contract.kind === 'index'; panel.depthQuote = null; panel.depthStatus.textContent = 'Waiting for live depth'; panel.depthTbody.innerHTML = '<tr><td colspan="6" class="market-depth-empty">Waiting for Angel One Snap Quote data.</td></tr>'; panel.depthStats.innerHTML = ''; panel.depthBuyTotal.textContent = ''; panel.depthSellTotal.textContent = '';
      panel.title.textContent = contract.kind === 'equity'
        ? `${contract.symbol || contract.underlying} · NSE Cash · Live`
        : `${contract.underlying || ''} ${Number(contract.strike || 0).toLocaleString('en-IN')} ${contract.side || ''} · ${contract.expiry || ''}`;
      panel.title.parentElement?.querySelector('.btn.ghost')?.setAttribute('aria-label', `Remove chart ${panel.title.textContent}`);
      panel.quote.textContent = 'LTP —';
      panel.state.textContent = 'Loading latest option data';
      panel.current.textContent = 'OHLC —';
      panel.fresh.textContent = 'Waiting for market data';
      panel.ltp = null;
      panel.baseBars.clear();
      panel.lastTime = null;
      panel.lastBar = null;
      panel.dataSource = 'websocket-derived';
      panel.provisional = false;
      for (const line of panel.tradeLines) { try { panel.series.removePriceLine(line); } catch (_) {} }
      panel.tradeLines = [];
      panel.tradeSignature = '';
      panel.series.setData([]);
      panel.chart.timeScale().fitContent();
      this.panels.set(key, panel);
      this.host.classList?.toggle('single-chart', this.panels.size === 1);
      this.syncPaper(this.currentPaper);
      return panel;
    }
    remove(key) {
      const panel = this.panels.get(key); if (!panel) return;
      panel.historyRequestId++; clearTimeout(panel.historyLoadTimer);
      panel.resizeObserver?.disconnect(); panel.chart.remove(); panel.card.remove(); this.panels.delete(key);
      this.host.classList?.toggle('single-chart', this.panels.size === 1);
      window.dispatchEvent(new CustomEvent('athena-chart-removed', { detail: { key, contract: panel.contract } }));
    }

    setTimeframe(key, seconds) {
      const panel = this.panels.get(key); if (!panel) return;
      panel.seconds = Number(seconds); panel.baseBars.clear(); panel.lastTime = null; panel.lastBar = null;
      panel.series.setData([]);
      panel.state.textContent = 'Loading selected timeframe';
    }

    setTheme(dark) {
      this.dark = Boolean(dark);
      const colors = this.dark
        ? { background: '#111827', text: '#cbd5e1', grid: '#273244', border: '#344056' }
        : { background: '#ffffff', text: '#66758a', grid: '#eef1f5', border: '#e3e8ef' };
      for (const panel of this.panels.values()) {
        panel.chart.applyOptions({
          layout: { background: { type: 'solid', color: colors.background }, textColor: colors.text },
          grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
          rightPriceScale: { borderColor: colors.border },
          timeScale: { borderColor: colors.border },
          crosshair: { vertLine: { color: colors.border }, horzLine: { color: colors.border } }
        });
      }
    }

    setData(key, candles, { fit = true, status = 'Historical data loaded', source = 'historical-api' } = {}) {
      const panel = this.panels.get(key); if (!panel) return;
      const ordered = new Map();
      for (const item of candles || []) {
        try {
          const bar = toBar(item);
          if (!Number.isFinite(bar.time) || ![bar.open, bar.high, bar.low, bar.close].every(Number.isFinite)) continue;
          const start = bucketStart(bar.time, panel.seconds);
          const prev = ordered.get(start);
          ordered.set(start, prev ? { time: start, open: prev.open,
            high: Math.max(prev.high, bar.high), low: Math.min(prev.low, bar.low), close: bar.close }
            : { ...bar, time: start });
        } catch (_) { /* reject malformed row */ }
      }
      // Keep socket updates that arrived while the history request was in flight.
      const latestHistoryTime = ordered.size ? Math.max(...ordered.keys()) : -Infinity;
      for (const bar of panel.baseBars.values()) {
        if (bar.time >= latestHistoryTime) ordered.set(bar.time, bar);
      }
      const data = [...ordered.values()].sort((a, b) => a.time - b.time);
      panel.series.setData(data); panel.lastBar = data.at(-1) || null; panel.lastTime = panel.lastBar?.time ?? null;
      panel.dataSource = source; panel.provisional = false; panel.state.textContent = status;
      if (fit && data.length) panel.chart.timeScale().fitContent();
      if (panel.lastBar) panel.current.textContent = `O ${panel.lastBar.open.toFixed(2)} · H ${panel.lastBar.high.toFixed(2)} · L ${panel.lastBar.low.toFixed(2)} · C ${panel.lastBar.close.toFixed(2)}`;
    }

    setQuote(key, ltp, receivedAt, status = 'LIVE', quoteData = null) {
      const panel = this.panels.get(key); if (!panel) return;
      panel.ltp = Number(ltp);
      if (quoteData && panel.contract.kind !== 'index') this.setDepth(key, quoteData);
      if (Number.isFinite(+ltp)) panel.quote.textContent = `LTP ₹${(+ltp).toFixed(2)}`;
      if (panel.lastTime == null && Number.isFinite(+ltp) && +ltp > 0) {
        const received = receivedAt ? stamp(receivedAt) : Math.floor(Date.now() / 1000);
        const time = bucketStart(received, panel.seconds);
        const bar = { time, open: +ltp, high: +ltp, low: +ltp, close: +ltp };
        panel.series.setData([bar]); panel.lastBar = bar; panel.lastTime = time; panel.provisional = true;
        panel.chart.timeScale().scrollToRealTime();
      }
      if (panel.buyPaper && Number(ltp) > 0) {
        panel.buyPaper.textContent = `BUY @ ${Number(ltp).toFixed(2)}`;
        panel.exitPaper.textContent = `SELL @ ${Number(ltp).toFixed(2)}`;
      }
      if (panel.buyPaper) panel.buyPaper.disabled = !(Number(ltp) > 0) || panel.exitPaper.disabled === false;
      panel.state.textContent = status;
      panel.fresh.textContent = receivedAt ? `Updated ${new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
      }).format(new Date(receivedAt))} IST` : 'Waiting for market data';
    }

    setDepth(key, quote) {
      const panel = this.panels.get(key); if (!panel || panel.contract.kind === 'index') return;
      panel.depthQuote = quote || null;
      if (!quote) { panel.depthStatus.textContent = 'Waiting for live depth'; panel.depthTbody.innerHTML = '<tr><td colspan="6" class="market-depth-empty">Waiting for Angel One Snap Quote data.</td></tr>'; return; }
      if (panel.depthPopover.hidden) return;
      const contract = panel.contract;
      panel.depthContract.textContent = `${contract.underlying || ''} ${Number(contract.strike || 0).toLocaleString('en-IN')} ${contract.side || ''} · ${contract.expiry || ''}`;
      const received = quote.receivedAt ? new Date(quote.receivedAt) : null;
      panel.depthStatus.textContent = received && Number.isFinite(received.getTime()) ? `Live · updated ${new Intl.DateTimeFormat('en-IN', {timeZone:'Asia/Kolkata', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false}).format(received)} IST` : 'Waiting for live depth';
      const bids = Array.isArray(quote.depth?.bids) ? quote.depth.bids : [], asks = Array.isArray(quote.depth?.asks) ? quote.depth.asks : [];
      const price = value => Number(value) > 0 ? Number(value).toFixed(2) : '—';
      const qty = value => Number(value) > 0 ? Number(value).toLocaleString('en-IN') : (Number(value) === 0 ? '0' : '—');
      if (!bids.length && !asks.length) panel.depthTbody.innerHTML = '<tr><td colspan="6" class="market-depth-empty">No depth levels in latest quote.</td></tr>';
      else panel.depthTbody.innerHTML = Array.from({length:5}, (_, i) => { const bid=bids[i], ask=asks[i]; return `<tr><td>${bid ? qty(bid.quantity) : '—'}</td><td>${bid ? qty(bid.orders) : '—'}</td><td class="depth-bid-price">${bid ? price(bid.price) : '—'}</td><td class="depth-ask-price">${ask ? price(ask.price) : '—'}</td><td>${ask ? qty(ask.orders) : '—'}</td><td>${ask ? qty(ask.quantity) : '—'}</td></tr>`; }).join('');
      const bidTotal = Number.isFinite(Number(quote.totalBuyQuantity)) ? Number(quote.totalBuyQuantity) : bids.reduce((sum, level) => sum + (Number(level.quantity) || 0), 0), askTotal = Number.isFinite(Number(quote.totalSellQuantity)) ? Number(quote.totalSellQuantity) : asks.reduce((sum, level) => sum + (Number(level.quantity) || 0), 0), total = bidTotal + askTotal;
      panel.depthBuyTotal.textContent = bidTotal.toLocaleString('en-IN'); panel.depthSellTotal.textContent = askTotal.toLocaleString('en-IN'); panel.depthBar.style.setProperty('--buy-share', (total ? bidTotal / total * 100 : 50) + '%');
      const stats = quote.stats || {}, fmt = value => Number(value) > 0 ? Number(value).toLocaleString('en-IN', {minimumFractionDigits:2, maximumFractionDigits:2}) : '—';
      const lastTrade = Number(stats.lastTradedTimestamp) > 0 ? new Intl.DateTimeFormat('en-IN', {timeZone:'Asia/Kolkata', day:'2-digit', month:'short', year:'numeric', hour:'numeric', minute:'2-digit', hour12:true}).format(new Date(Number(stats.lastTradedTimestamp)*1000)) : '—';
      const entries = [['Avg Price',fmt(stats.averagePrice)],['Prev Close',fmt(stats.previousClose)],['Volume',qty(stats.volume)],['OI',qty(stats.openInterest)],['LTQ',qty(stats.lastTradedQuantity)],['LTT',lastTrade],['LCL',fmt(stats.lowerCircuit)],['UCL',fmt(stats.upperCircuit)],['52W High',fmt(stats['52WeekHigh'])],['52W Low',fmt(stats['52WeekLow'])]];
      panel.depthStats.innerHTML = entries.map(([label,value]) => `<div class="market-depth-stat"><span>${label}</span><b>${value}</b></div>`).join('');
    }

    update(key, sourceCandle, sourceSeconds, receivedAt, fastCandle) {
      const panel = this.panels.get(key); if (!panel || !sourceCandle) return;
      // Use five-second locally aggregated bars for sub-minute views. The
      // one-minute engine remains authoritative for longer intervals.
      if (panel.seconds < 60 && fastCandle) { sourceCandle = fastCandle; sourceSeconds = 5; }
      const source = toBar(sourceCandle); const interval = Math.max(1, Number(sourceSeconds) || 60);
      const target = panel.seconds < 60 ? Math.max(5, panel.seconds) : Math.max(60, panel.seconds);
      const start = bucketStart(source.time, target);
      const prev = panel.baseBars.get(start);
      const next = prev ? { time: start, open: prev.open, high: Math.max(prev.high, source.high),
        low: Math.min(prev.low, source.low), close: source.close }
        : { time: start, open: source.open, high: source.high, low: source.low, close: source.close };
      panel.baseBars.set(start, next);
      const historicalUpdate = panel.lastTime != null && next.time < panel.lastTime;
      try { panel.series.update(next, historicalUpdate); }
      catch (_) { this.setData(key, [...panel.baseBars.values()], { fit: false, status: 'Reconciled live candle', source: 'websocket-reconciled' }); }
      if (panel.lastTime == null || next.time >= panel.lastTime) { panel.lastTime = next.time; panel.lastBar = next; }
      panel.current.textContent = `O ${next.open.toFixed(2)} · H ${next.high.toFixed(2)} · L ${next.low.toFixed(2)} · C ${next.close.toFixed(2)}`;
      panel.fresh.textContent = receivedAt ? `Updated ${new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
      }).format(new Date(receivedAt))} IST` : `Live ${labels.get(target) || target + 's'} update`;
      if (historicalUpdate) panel.state.textContent = 'Historical candle corrected';
      else panel.state.textContent = `Live · ${labels.get(target) || target + 's'} · ${panel.dataSource}`;
    }

    syncPaper(paper) {
      this.currentPaper = paper;
      for (const panel of this.panels.values()) {
        if (!panel.buyPaper) continue;
        const open = paper?.state === 'OPEN';
        const ownsThisChart = open && String(paper.token) === String(panel.contract.token);
        panel.buyPaper.disabled = !(panel.ltp > 0) || open;
        panel.exitPaper.disabled = !ownsThisChart || !(panel.ltp > 0);
        panel.positionPnl.hidden = !ownsThisChart;
        if (ownsThisChart) {
          const pnl = Number(paper.grossPnl ?? ((Number(paper.lastPrice) - Number(paper.entryPrice)) * Number(paper.units)));
          panel.positionPnl.textContent = `Open · ${pnl >= 0 ? '+' : ''}₹${pnl.toFixed(2)}`;
          panel.positionPnl.classList.toggle('positive', pnl >= 0);
          panel.positionPnl.classList.toggle('negative', pnl < 0);
        } else panel.positionPnl.textContent = '';

        const signature = ownsThisChart
          ? [paper.entryPrice, paper.targetPrice, paper.stopPrice, paper.tpState, paper.trailingState].join('|')
          : '';
        if (signature === panel.tradeSignature) continue;
        for (const line of panel.tradeLines) {
          try { panel.series.removePriceLine(line); } catch (_) { /* chart may be closing */ }
        }
        panel.tradeLines = []; panel.tradeSignature = signature;
        if (!ownsThisChart) continue;
        const lineStyle = window.LightweightCharts.LineStyle;
        const addLine = (price, color, title) => {
          if (!(Number(price) > 0)) return;
          panel.tradeLines.push(panel.series.createPriceLine({
            price: Number(price), color, lineWidth: 2,
            lineStyle: lineStyle?.Dashed ?? 2, axisLabelVisible: true, title
          }));
        };
        addLine(paper.entryPrice, '#5572d8', 'Entry');
        if (paper.tpState === 'ACTIVE') addLine(paper.targetPrice, '#16865a', 'TP');
        addLine(paper.stopPrice, '#cb4d52', paper.trailingState === 'TRAILING_ACTIVE' ? 'Trailing SL' : 'SL');
      }
    }
  }

  window.AthenaCharts = AthenaChartManager;
})();
