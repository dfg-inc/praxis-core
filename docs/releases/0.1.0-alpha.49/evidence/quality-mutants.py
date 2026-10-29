import json,subprocess,shutil,os,sys
S='/private/tmp/claude-501/-Users-serg-work-praxis-split-praxis-core/a884cedf-a7b5-4896-bd49-35635f61dbdd/scratchpad'
T=S+'/mut/tree'; APP=T+'/projects/orders-app'; SNAP=S+'/snap/orders-app'
CH=SNAP+'/.praxis/quality/WI-FILTR-ZAKAZOV-PO-STATUSU-001/checks.json'
# (id, target AC, file, old, new)
M=[
('M01','001-AC-01 drop Cancelled option','src/data/orders.js',"'Delivered', 'Cancelled']","'Delivered']"),
('M02','001-AC-01 label renamed (Статус->Filter)','src/pages/OrdersPage.jsx',"<label>Статус{' '}","<label>Filter{' '}"),
('M03','001-AC-01 filter moved BELOW table','src/pages/OrdersPage.jsx',None,None),
('M04','001-AC-02 default list hides last row','src/pages/OrdersPage.jsx',"const visible = filterOrders(orders, state.status);","const visible = filterOrders(orders, state.status).slice(0, state.status ? 99 : 6);"),
('M05','001-AC-03 select multiple','src/pages/OrdersPage.jsx',"<select value=","<select multiple value="),
('M06','001-AC-06 empty msg lacks status','src/pages/OrdersPage.jsx',"Нет заказов со статусом {state.status} ","Нет заказов "),
('M07','001-AC-06 reset button sets New','src/pages/OrdersPage.jsx',"onClick={() => setStatus('')}","onClick={() => setStatus('New')}"),
('M08','001-AC-07 Customer/Status cells swapped','src/pages/OrdersPage.jsx',"<td>{o.customer}</td><td>{o.status}</td>","<td>{o.status}</td><td>{o.customer}</td>"),
('M09','002-AC-01 selected class removed','src/pages/OrdersPage.jsx',"className={o.number === state.order ? 'selected' : ''} ",""),
('M10','002-AC-01 drawer on LEFT (not right)','src/pages/OrdersPage.jsx',"      {selected && <OrderDrawer order={selected} onClose={close} />}\n","")
,
('M11','002-AC-01 highlight CSS removed','src/styles/theme.css',"tr.selected {","tr.selectedX {"),
('M12','002-AC-02 filter hidden when drawer open','src/pages/OrdersPage.jsx',"<select value=","<select style={{display: state.order ? 'none':'inline-block'}} value="),
('M13','002-AC-03 Created/Total values swapped','src/components/OrderDrawer.jsx',"<dt>Created</dt><dd>{dash(order.createdAt)}</dd>\n        <dt>Total</dt><dd>{dash(order.total)}</dd>","<dt>Created</dt><dd>{dash(order.total)}</dd>\n        <dt>Total</dt><dd>{dash(order.createdAt)}</dd>"),
('M14','002-AC-04 Qty/Price cells swapped','src/components/OrderDrawer.jsx',"<td>{i.quantity}</td><td>{i.price}</td>","<td>{i.price}</td><td>{i.quantity}</td>"),
('M15','002-AC-04 Sum = qty+price','src/components/OrderDrawer.jsx',"i.quantity * i.price","i.quantity + i.price"),
('M16','002-AC-05 email/phone values swapped','src/components/OrderDrawer.jsx',"<dt>Email</dt><dd>{dash(order.email)}</dd>\n        <dt>Phone</dt><dd>{dash(order.phone)}</dd>","<dt>Email</dt><dd>{dash(order.phone)}</dd>\n        <dt>Phone</dt><dd>{dash(order.email)}</dd>"),
('M17','002-AC-06 add status history section titled "Status log"','src/components/OrderDrawer.jsx',"<h3>Items</h3>","<h3>Status log</h3><ul><li>New -> {order.status}</li></ul><h3>Items</h3>"),
('M18','002-AC-07 missing value rendered blank (dash() -> "")','src/components/OrderDrawer.jsx',"? '—' : value","? '' : value"),
('M19','002-AC-08 other-row click ignored while drawer open','src/pages/OrdersPage.jsx',"const open = (number) => update(","const open = (number) => state.order ? null : update("),
('M20','002-AC-09 Esc handler removed','src/components/OrderDrawer.jsx',"if (e.key === 'Escape') onClose();",""),
('M21','002-AC-09/004-AC-02 close() does not update URL','src/pages/OrdersPage.jsx',"const close = useCallback(() => update({ status: state.status, order: null }), [update, state.status]);","const close = useCallback(() => setState({ status: state.status, order: null, normalized: false }), [state.status]);"),
('M22','003-AC-01 filter change keeps open order even if filtered out','src/pages/OrdersPage.jsx',"order: reconcileOrder(orders, status, state.order)","order: state.order"),
('M23','003-AC-02 filter change always closes drawer','src/pages/OrdersPage.jsx',"order: reconcileOrder(orders, status, state.order)","order: null"),
('M24','004-AC-01 UI pushes status lower-cased in URL','src/pages/OrdersPage.jsx',"window.history.pushState(null, '', buildSearch(next) || window.location.pathname);","window.history.pushState(null, '', (buildSearch(next) || window.location.pathname).toLowerCase());"),
('M25','004-AC-04 initial state ignores URL','src/pages/OrdersPage.jsx',"useState(() => parseQuery(window.location.search, orders))","useState(() => parseQuery('', orders))"),
('M26','004-AC-06 URL cleanup effect (replaceState) removed','src/pages/OrdersPage.jsx',"if (state.normalized) window.history.replaceState(null, '', buildSearch(state) || window.location.pathname);\n  }, []);","}, []);"),
('M27','004-AC-03 popstate listener removed','src/pages/OrdersPage.jsx',"window.addEventListener('popstate', onPop);","/*removed*/"),
('M28','004-AC-05 unknown status kept (UI shows empty, not All)','src/lib/ordersQuery.js',"(STATUSES.includes(value) ? value : null)","(value || null)"),
('M29','005-AC-01 STATUSES gets extra Bogus value','src/data/orders.js',"'Cancelled'];","'Cancelled', 'Bogus'];"),
('M30','005-AC-02 createdAt not shown','src/components/OrderDrawer.jsx',"<dt>Created</dt><dd>{dash(order.createdAt)}</dd>",""),
('M31','005-AC-07 legacy order crashes list (reads order.items.length in row)','src/pages/OrdersPage.jsx',"<td>{o.number}</td>","<td>{o.number}{o.items.length ? '' : ''}</td>"),
('M32','005-AC-06 duplicate order number ORD-2002 in data','src/data/orders.js',"number: 'ORD-2004'","number: 'ORD-2002'"),
('M33','005-AC-05 drawer shows status twice w/ "History" absent but status from wrong field','src/components/OrderDrawer.jsx',"<dt>Status</dt><dd>{dash(order.status)}</dd>","<dt>Status</dt><dd>{dash(order.status)}</dd><dt>Prev</dt><dd>{dash(order.prevStatus)}</dd>"),
('M34','002-AC-09 close button does nothing','src/components/OrderDrawer.jsx',"aria-label=\"Close\" onClick={onClose}","aria-label=\"Close\""),
]
only=sys.argv[1:] 
for mid,desc,f,old,new in M:
    if only and mid not in only: continue
    shutil.rmtree(APP+'/src'); shutil.copytree(SNAP+'/src',APP+'/src')
    if mid=='M03':
        p=APP+'/'+f; t=open(p).read()
        sel=t[t.index('        <label>'):t.index('        <table>')]
        t=t.replace(sel,'',1); t=t.replace('        {visible.length === 0','%s        {visible.length === 0'%sel,1)
        open(p,'w').write(t)
    else:
        p=APP+'/'+f; t=open(p).read()
        if old not in t: print(mid,'PATCH NOT APPLIED'); continue
        if mid=='M10':
            t=t.replace(old,new,1).replace('    <div className="orders-layout">\n','    <div className="orders-layout">\n      {selected && <OrderDrawer order={selected} onClose={close} />}\n',1)
        else: t=t.replace(old,new,1)
        open(p,'w').write(t)
    b=subprocess.run(['node',T+'/qa-stand/build.mjs'],cwd=T+'/qa-stand',env={**os.environ,'ORDERS_PROJECT':APP},capture_output=True,text=True)
    if b.returncode: print(mid,'BUILD FAIL',b.stderr[-300:]); continue
    br=subprocess.run(['node',S+'/mut/runbrowser.mjs',APP+'/dist',CH,T+'/qa-stand'],capture_output=True,text=True)
    ur=subprocess.run(['node',S+'/mut/rununit.mjs',APP,CH],capture_output=True,text=True)
    try: bj=json.loads(br.stdout)['results']
    except Exception: bj={'ERR':br.stdout[-200:]+br.stderr[-200:]}
    try: uj=json.loads(ur.stdout)
    except Exception: uj={'ERR':ur.stdout[-200:]+ur.stderr[-200:]}
    fb=[k.replace('B-REQ-ORD-','') for k,v in bj.items() if v!='ok']
    fu=[k for k,v in uj.items() if v!='ok']
    print(mid,desc,'\n   browser-fail:',fb,'\n   unit-fail:',fu,flush=True)
