(() => {
  const byId = id => document.getElementById(id);
  const root = byId('page-screener');
  if (!root) return;
  let snapshot = null;
  let selectedSymbol = null;
  let lastRenderedAt = null;
  let density = 0;
  let liveEnabled = true;
  let pollInFlight = false;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const fmt = (value, digits = 2) => Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-IN',{minimumFractionDigits:digits,maximumFractionDigits:digits}) : '—';
  const fmtPct = value => Number.isFinite(Number(value)) ? `${Number(value)>0?'+':''}${fmt(value,2)}%` : '—';
  const compact = value => Number(value||0).toLocaleString('en-IN',{notation:'compact',maximumFractionDigits:1});
  const allStocks = () => snapshot?.stocks || [];
  const getStock = symbol => allStocks().find(stock => stock.symbol === symbol) || null;
  const apiPost = async (path, body) => {
    const response = await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Request failed.');
    return data;
  };
  function renderSummary() {
    const state = snapshot?.state || 'DISCONNECTED';
    const labels = {DISCONNECTED:'Connect Angel One to scan',SCANNING:'Scanning F&O stocks…',READY:'Live screener ready',ERROR:'Last screener scan failed'};
    byId('screenerState').textContent = labels[state] || state;
    const live=byId('screenerLiveIndicator');if(live){byId('screenerLiveLabel').textContent=!liveEnabled?'PAUSED':state==='READY'?'LIVE':state==='SCANNING'?'SCANNING':'OFFLINE';live.classList.toggle('offline',!liveEnabled||state==='DISCONNECTED'||state==='ERROR');}
    byId('screenerUniverse').textContent = snapshot?.universeCount ? Number(snapshot.universeCount).toLocaleString('en-IN') : '—';
    byId('screenerBullCount').textContent = snapshot?.bullishCount ?? '—';
    byId('screenerBearCount').textContent = snapshot?.bearishCount ?? '—';
    byId('screenerOiBasis').textContent = snapshot?.oiBasis || '—';
    const updated=byId('screenerUpdateAt');if(updated)updated.textContent=snapshot?.updatedAt?`Scan updated · ${new Date(snapshot.updatedAt).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}`:'Waiting for first scan';
    const liveToggle=byId('screenerLiveToggle');if(liveToggle){liveToggle.setAttribute('aria-pressed',String(liveEnabled));liveToggle.querySelector('span').textContent=liveEnabled?'Live · 1s':'Paused';}
    byId('screenerExpiry').textContent = snapshot?.expiry ? `Nearest option expiry · ${snapshot.expiry}` : 'Nearest available option expiry';
    byId('screenerBullShown').textContent = String(snapshot?.bullish?.length || 0);
    byId('screenerBearShown').textContent = String(snapshot?.bearish?.length || 0);
    const footnote = byId('screenerFootnote');
    if (snapshot?.error) footnote.innerHTML = `<span class="screener-error">${escape(snapshot.error)}</span> · ${escape(snapshot.oiBasis || '')}`;
    else footnote.textContent = snapshot?.oiBasis
      ? `Auto-checks the latest snapshot every second. Full NSE F&O scans use Angel One's rate-limited quote batches; futures OI is ${snapshot.oiBasis}. Signals are for research, not trade recommendations.`
      : 'Auto-checks the latest snapshot every second. The first completed scan establishes the futures OI baseline.';
  }
  function renderFan() {
    const svg=byId('screenerFan'),marks=byId('screenerFanMarks'),stage=byId('screenerLayout'),map=stage?.querySelector('.screen-map-wrap'),empty=byId('screenerMapEmpty');
    if(!svg||!marks||!stage||!map)return;
    const sr=stage.getBoundingClientRect(),mr=map.getBoundingClientRect(),width=Math.max(320,Math.round(sr.width)),height=Math.max(320,Math.round(sr.height));
    svg.setAttribute('viewBox',`0 0 ${width} ${height}`);
    const universe=snapshot?.universe||[],ranked=[...(snapshot?.bullish||[]),...(snapshot?.bearish||[])];
    if(!universe.length){marks.innerHTML='';empty.hidden=false;return}empty.hidden=true;
    const origin=stage.querySelector('.screen-flow-origin'),or=origin?.getBoundingClientRect(),x0=or?or.left-sr.left+Math.min(12,or.width/2):mr.left-sr.left+10,y0=or?or.top-sr.top+or.height/2:mr.top-sr.top+mr.height/2;
    const fallbackX=mr.right-sr.left-10,maxPct=Math.max(.5,...universe.map(item=>Math.abs(Number(item.changePct)||0))),scale=(mr.height/2-18)/maxPct;
    marks.innerHTML=universe.map(item=>{
      const symbol=String(item.symbol||''),pct=Number(item.changePct)||0,bull=pct>=0,stock=ranked.find(row=>row.symbol===symbol),card=stock&&stage.querySelector(`[data-screener-symbol="${CSS.escape(symbol)}"]`),cr=card?.getBoundingClientRect(),x1=cr?cr.left-sr.left+2:fallbackX,y1=cr?cr.top+cr.height/2-sr.top:mr.top-sr.top+mr.height/2-pct*scale,cx1=x0+(x1-x0)*.35,cx2=x0+(x1-x0)*.72,selected=symbol===selectedSymbol;
      return `<path d="M${x0} ${y0} C${cx1} ${y0},${cx2} ${y1},${x1} ${y1}" class="fan-path ${bull?'bullish':'bearish'} ${selected?'selected':''}" pathLength="1"/>`;
    }).join('');
    requestAnimationFrame(()=>marks.querySelectorAll('.fan-path').forEach(path=>path.classList.add('drawn')));
  }
  function renderList(rows, hostId, side) {
    const host = byId(hostId);
    const before = new Map([...host.querySelectorAll('[data-screener-symbol]')].map(node => [node.dataset.screenerSymbol,node.getBoundingClientRect()]));
    if (!rows?.length) {
      host.innerHTML = `<div class="empty">${snapshot?.state==='SCANNING'?'The first Angel One snapshot is loading…':snapshot?.error?'Waiting for a successful scan.':'No stocks on this side of the market right now.'}</div>`;
      return;
    }
    host.innerHTML = rows.map((stock,index) => {
      const bullish = side === 'bullish';
      const oi = stock.oiChangePct == null ? 'OI baseline' : `Fut OI ${fmtPct(stock.oiChangePct)}`;
      return `<button type="button" class="screener-row ${bullish?'bullish':'bearish'} ${selectedSymbol===stock.symbol?'selected':''} ${before.has(stock.symbol)?'existing':''}" data-screener-symbol="${escape(stock.symbol)}" aria-pressed="${selectedSymbol===stock.symbol}" aria-label="${bullish?'Bullish':'Bearish'} rank ${stock.rank}, ${escape(stock.symbol)}, ${fmtPct(stock.changePct)}" style="--row-index:${index%20}">
        <span class="screener-rank">${String(stock.rank).padStart(2,'0')}</span><span class="screener-symbol-cell"><span class="screener-symbol-line"><b class="screener-symbol">${escape(stock.symbol)}</b><span class="screener-flow">${escape(stock.flow)}</span></span></span><span class="screener-delta">${fmtPct(stock.changePct)}</span>
        <span class="screener-row-meta"><span>${oi}</span><span>VWAP ${fmtPct(stock.vwapDeviation)}</span><span>PCR ${stock.pcr == null?'—':fmt(stock.pcr,2)}</span></span><span class="screener-row-extra">₹${fmt(stock.price)} · score ${fmt(stock.score,2)} · support ${stock.support?fmt(stock.support):'—'} · resistance ${stock.resistance?fmt(stock.resistance):'—'}</span></button>`;
    }).join('');
    host.querySelectorAll('[data-screener-symbol]').forEach(button => {
      button.onclick = () => selectStock(button.dataset.screenerSymbol);
      const old = before.get(button.dataset.screenerSymbol);
      const next = button.getBoundingClientRect();
      if (old && !reducedMotion) {
        const dx = old.left-next.left, dy = old.top-next.top;
        if (dx || dy) button.animate([{transform:`translate(${dx}px,${dy}px)`},{transform:'none'}],{duration:440,easing:'cubic-bezier(.2,.7,.2,1)'});
      }
    });
  }
  function renderDetail() {
    const host = byId('screenerDetail');
    const stock = getStock(selectedSymbol);
    if (!stock) {
      host.classList.remove('has-stock');
      host.innerHTML = '<div class="empty">Select a stock to inspect its signal and option-chain OI.</div>';
      drawSelectionLink();
      return;
    }
    const bullish = stock.side === 'bullish';
    const chain = stock.chain || [];
    const maxOi = Math.max(1,...chain.flatMap(row=>[Number(row.callOI)||0,Number(row.putOI)||0]));
    const chainRows = chain.map(row => {
      const callWidth = Math.max(0,Math.min(100,(Number(row.callOI)||0)/maxOi*100));
      const putWidth = Math.max(0,Math.min(100,(Number(row.putOI)||0)/maxOi*100));
      const wall = row.strike===stock.support||row.strike===stock.resistance;
      return `<tr class="${wall?'screener-wall':''}"><td class="screener-call"><span class="screener-oi" style="--oi-width:${callWidth}%"></span><span class="screener-oi-value">${compact(row.callOI)}</span></td><td class="screener-call">${fmt(row.callLtp,2)}</td><td>${fmt(row.strike,2)}</td><td class="screener-put">${fmt(row.putLtp,2)}</td><td class="screener-put"><span class="screener-oi" style="--oi-width:${putWidth}%"></span><span class="screener-oi-value">${compact(row.putOI)}</span></td></tr>`;
    }).join('');
    host.classList.add('has-stock');
    host.innerHTML = `<div class="screener-detail-head"><span class="signal-mark ${bullish?'bullish':'bearish'}">${bullish?'▲':'▼'}</span><h2>${escape(stock.symbol)}</h2><span class="screener-delta">${fmtPct(stock.changePct)}</span><button type="button" class="screen-detail-close" id="closeScreenerDetail" aria-label="Close stock details">×</button></div>
      <div class="screener-detail-sub">${escape(stock.name)} · NSE cash · ${bullish?'Bullish':'Bearish'} rank #${stock.rank} · score ${fmt(stock.score,2)}</div>
      <div class="screener-detail-actions"><button type="button" class="btn small" id="openScreenerChart">Open stock chart</button><button type="button" class="btn secondary small" id="addScreenWatchlist">Add to watchlist</button></div>
      <div class="screener-signal-grid"><div class="screener-signal-cell"><span>Spot price</span><b>₹${fmt(stock.price)}</b></div><div class="screener-signal-cell"><span>Spot change</span><b class="${bullish?'positive':'negative'}">${fmtPct(stock.changePct)}</b></div><div class="screener-signal-cell"><span>Futures OI change</span><b>${stock.oiChangePct==null?'Baseline pending':fmtPct(stock.oiChangePct)}</b></div><div class="screener-signal-cell"><span>Price vs VWAP</span><b>${fmtPct(stock.vwapDeviation)}</b></div><div class="screener-signal-cell"><span>Option PCR · ATM ±5</span><b>${stock.pcr==null?'—':fmt(stock.pcr,2)}</b></div><div class="screener-signal-cell"><span>Call / Put OI</span><b>${compact(stock.callOI)} / ${compact(stock.putOI)}</b></div><div class="screener-signal-cell"><span>Put OI support</span><b>${stock.support?`₹${fmt(stock.support)}`:'—'}</b></div><div class="screener-signal-cell"><span>Call OI resistance</span><b>${stock.resistance?`₹${fmt(stock.resistance)}`:'—'}</b></div></div>
      <div class="screener-chain-head"><b>Nearest expiry option OI</b><span>${escape(stock.expiry||'')} · ATM ±5 strikes</span></div>
      ${chain.length?`<div class="screener-chain-wrap"><table class="screener-chain"><thead><tr><th colspan="2">CALLS · OI / LTP</th><th>STRIKE</th><th colspan="2">PUTS · LTP / OI</th></tr></thead><tbody>${chainRows}</tbody></table></div>`:'<div class="screener-empty-chain">Angel One did not return current option quotes for this symbol.</div>'}`;
    byId('closeScreenerDetail').onclick = () => selectStock(stock.symbol);
    byId('openScreenerChart').onclick = () => void openStockChart(stock);
    byId('addScreenWatchlist').onclick = () => addToWatchlist(stock);
    if (!reducedMotion) host.animate([{opacity:.6,transform:'translateY(4px)'},{opacity:1,transform:'none'}],{duration:180,easing:'cubic-bezier(.2,.7,.2,1)'});
    drawSelectionLink();
  }
  function selectStock(symbol) {
    selectedSymbol = selectedSymbol === symbol ? null : symbol;
    byId('screenerLayout').classList.toggle('has-selection',!!selectedSymbol);
    renderFan();
    renderList(snapshot?.bullish,'screenerBullRows','bullish');
    renderList(snapshot?.bearish,'screenerBearRows','bearish');
    renderDetail();
  }
  function drawSelectionLink() {
    const layout=byId('screenerLayout'),detail=byId('screenerDetail'),path=byId('screenerLinkPath'),dot=byId('screenerLinkDot'),svg=byId('screenerLink');
    const card=layout.querySelector(`[data-screener-symbol="${CSS.escape(selectedSymbol||'')}"].selected`);
    if (!card || !stockVisible(card) || innerWidth<721) { svg.classList.remove('active'); return; }
    const rect=layout.getBoundingClientRect(),a=card.getBoundingClientRect(),b=detail.getBoundingClientRect();
    const x1=a.right-rect.left,y1=a.top+a.height/2-rect.top,x2=b.left-rect.left,y2=b.top+Math.min(36,b.height/2)-rect.top,m=(x1+x2)/2;
    path.setAttribute('d',`M${x1} ${y1} C${m} ${y1}, ${m} ${y2}, ${x2} ${y2}`);path.style.stroke=card.classList.contains('bearish')?'var(--red)':'var(--green)';
    path.style.strokeDasharray='1';path.style.strokeDashoffset='1';dot.setAttribute('cx',x2);dot.setAttribute('cy',y2);dot.style.fill=path.style.stroke;svg.classList.add('active');
    requestAnimationFrame(()=>path.style.strokeDashoffset='0');
  }
  function stockVisible(card) { const panel=card.closest('.screener-list');return !!panel&&card.getBoundingClientRect().bottom>panel.getBoundingClientRect().top&&card.getBoundingClientRect().top<panel.getBoundingClientRect().bottom; }
  function renderSnapshot(next) {
    const changed = next?.updatedAt !== lastRenderedAt || next?.state !== snapshot?.state || !!next?.error !== !!snapshot?.error;
    snapshot=next||snapshot;
    renderSummary();
    if (changed) {
      if (!getStock(selectedSymbol)) selectedSymbol=null;
      byId('screenerLayout').classList.toggle('has-selection',!!selectedSymbol);
      renderList(snapshot?.bullish,'screenerBullRows','bullish');
      renderList(snapshot?.bearish,'screenerBearRows','bearish');
      renderDetail();
      renderFan();
      lastRenderedAt=snapshot?.updatedAt||lastRenderedAt;
    }
  }
  async function poll() {
    if(pollInFlight)return;pollInFlight=true;
    try {
      const response=await fetch('/api/market/screener',{cache:'no-store'}),data=await response.json();
      if(!response.ok)throw new Error(data.error||'Could not load screener state.');
      renderSnapshot(data);
      const pollAt=byId('screenerPollAt');if(pollAt)pollAt.textContent=`Checked ${new Date().toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}`;
    } catch(error) { byId('screenerState').textContent='Screener service unavailable';byId('screenerFootnote').textContent=error.message; }
    finally { pollInFlight=false; }
  }
  async function openStockChart(stock) {
    try {
      const result=await apiPost('/api/angel/screener-chart',{action:'add',exchange:'NSE',token:stock.chartInstrument.token});
      for(const panel of [...chartManager.panels.values()])if(panel.contract.kind==='index')chartManager.remove(panel.key);
      for(const panel of [...chartManager.panels.values()])if(panel.contract.kind==='equity'&&String(panel.contract.token)!==String(stock.chartInstrument.token))chartManager.remove(panel.key);
      const instrument={...result.instrument,kind:'equity'};
      const panel=chartManager.add(instrument);
      const optionChain=byId('optionChain');optionChain.classList.add('screener-chart-mode');
      optionChain.querySelector('.chain-layout')?.classList.add('screener-chart-mode');
      const title=document.querySelector('#page-markets .page-heading h1');if(title)title.textContent=`${stock.symbol} · Stock chart`;
      const back=document.querySelector('#page-markets .page-heading .screener-chart-back');
      if(!back){const button=document.createElement('button');button.type='button';button.className='btn secondary small screener-chart-back';button.textContent='← Back to screener';button.onclick=backToScreener;document.querySelector('#page-markets .page-heading')?.append(button);}
      showPage('chain');
      panel.state.textContent='Loading NSE stock history';
      void loadPanelHistory(panel);
      requestAnimationFrame(()=>panel.card.scrollIntoView({behavior:reducedMotion?'auto':'smooth',block:'center'}));
    } catch(error) { byId('screenerState').textContent=error.message; }
  }
  function backToScreener() {
    for(const panel of [...chartManager.panels.values()])if(panel.contract.kind==='equity')chartManager.remove(panel.key);
    byId('optionChain').classList.remove('screener-chart-mode');
    byId('optionChain').querySelector('.chain-layout')?.classList.remove('screener-chart-mode');
    const title=document.querySelector('#page-markets .page-heading h1');if(title)title.textContent='Charts & Order Flow';
    document.querySelector('#page-markets .page-heading .screener-chart-back')?.remove();
    showPage('screener');
  }
  async function addToWatchlist(stock) {
    try {
      const item={kind:'market',category:'stock',symbol:stock.symbol,name:stock.name,token:String(stock.chartInstrument.token),exchange:'NSE',exchangeType:1,liveSupported:true};
      const list=JSON.parse(localStorage.getItem('athena-watchlist-v1')||'[]');
      const key=`market:NSE:${item.token}`;
      if(list.some(row=>`market:${row.exchange}:${row.token}`===key)){toast(`${stock.symbol} is already on your watchlist.`);return;}
      if(list.filter(row=>row.kind==='market').length>=300){toast('The watchlist can contain up to 300 Angel One instruments.');return;}
      list.push(item);localStorage.setItem('athena-watchlist-v1',JSON.stringify(list));toast(`${stock.symbol} added to the watchlist.`);
      if(typeof renderMarketWorkspace==='function')renderMarketWorkspace();
    } catch(error) { toast(error.message||'Could not save this stock to your watchlist.'); }
  }
  byId('screenerLiveToggle').onclick=()=>{liveEnabled=!liveEnabled;renderSummary();if(liveEnabled)void poll();};
  byId('screenerExit').onclick=()=>showPage('dashboard');
  function setDensity(value){density=Math.max(0,Math.min(2,Math.round(value)));root.dataset.density=String(density);byId('screenerDensity').textContent=['COMPACT','DETAIL','EXPANDED'][density];requestAnimationFrame(()=>{renderFan();drawSelectionLink();});}
  byId('screenerZoomIn').onclick=()=>setDensity(density+1);
  byId('screenerZoomOut').onclick=()=>setDensity(density-1);
  const board=document.querySelector('.screen-board');
  board?.addEventListener('wheel',event=>{if(event.ctrlKey||event.metaKey){event.preventDefault();setDensity(density+(event.deltaY<0?1:-1));}},{passive:false});
  const pointers=new Map();let pinchDistance=0;
  board?.addEventListener('pointerdown',event=>pointers.set(event.pointerId,event));
  board?.addEventListener('pointermove',event=>{if(!pointers.has(event.pointerId))return;pointers.set(event.pointerId,event);if(pointers.size===2){const [a,b]=[...pointers.values()],distance=Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY);if(pinchDistance&&Math.abs(distance-pinchDistance)>28)setDensity(density+(distance>pinchDistance?1:-1));pinchDistance=distance;}});
  ['pointerup','pointercancel','pointerleave'].forEach(name=>board?.addEventListener(name,event=>{pointers.delete(event.pointerId);if(pointers.size<2)pinchDistance=0;}));
  window.addEventListener('keydown',event=>{if(event.key==='Escape'&&selectedSymbol)selectStock(selectedSymbol);else if(event.key==='+'||event.key==='=')setDensity(density+1);else if(event.key==='-')setDensity(density-1);});
  document.querySelectorAll('.primary-nav a[data-page="screener"]').forEach(link=>link.addEventListener('click',()=>{void poll();requestAnimationFrame(()=>{renderFan();drawSelectionLink();});}));
  document.querySelectorAll('.primary-nav a[data-page="chain"]').forEach(link=>link.addEventListener('click',()=>{if(byId('optionChain').classList.contains('screener-chart-mode')){byId('optionChain').classList.remove('screener-chart-mode');byId('optionChain').querySelector('.chain-layout')?.classList.remove('screener-chart-mode');const title=document.querySelector('#page-markets .page-heading h1');if(title)title.textContent='Charts & Order Flow';document.querySelector('#page-markets .page-heading .screener-chart-back')?.remove();}}));
  document.querySelector('#page-markets .page-heading')?.addEventListener('click',event=>{if(event.target.closest('.screener-chart-back'))backToScreener();});
  window.addEventListener('resize',()=>{renderFan();drawSelectionLink();});
  document.querySelectorAll('.screener-list').forEach(panel=>panel.addEventListener('scroll',()=>{drawSelectionLink();renderFan();},{passive:true}));
  void poll();
  setInterval(()=>{if(liveEnabled&&root.classList.contains('active'))void poll();},1000);
})();


