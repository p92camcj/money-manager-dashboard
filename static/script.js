// Variables globales y estado
let assetsData = [];
let transactionsData = [];
let budgetsData = []; // Ahora es el array hierarchy
let currentTab = 'dashboard';
let chartInstance = null;
let currentFilter = { category: null, subCategory: null, searchStr: null, minAmount: null, maxAmount: null, tags: null };
let currentPeriod = { startDate: '', endDate: '', label: '' };
let lastProposals = []; // última tanda de propuestas de conciliación, para que confirmMatch() encuentre fecha/importe/descripción por source_id
let lastOrphans = []; // última tanda de huérfanos de Money Manager sin equivalente en el extracto (Propuesta #11, arqueo de caja)
let pendingFiles = []; // ficheros seleccionados pendientes de etiquetar/confirmar antes de subir
let currentLabelFilter = 'all'; // etiqueta de origen seleccionada en el filtro de propuestas
// Propuesta #16 (BACKLOG.md): badges de #reconciliationSummaryBar como filtros multiseleccionables
// (no excluyentes entre sí) -- valores posibles: 'matched', 'pending', 'bankOnly', 'mmOnly'.
// Conjunto vacío == sin filtro de estado activo (se muestra todo, igual que antes de esta
// propuesta). Se combina en AND con currentLabelFilter y con la búsqueda Ctrl+F, nunca los
// sustituye. Vive junto a currentLabelFilter porque comparte el mismo ciclo de vida: se resetea
// al analizar una tanda nueva (datos completamente distintos), pero sobrevive a re-renders,
// cambios de etiqueta y confirmaciones de match/enlace dentro de la misma tanda.
let activeSummaryFilters = new Set();
let manualLinkMode = false; // modo de enlace manual banco <-> Money Manager activo en Conciliación
// Propuesta #16 (BACKLOG.md): selección múltiple en ambos lados (antes un único id por radio) --
// Sets de source_id/id, para permitir enlaces N:M (varias líneas de banco <-> varios registros MM).
let manualLinkSelectedBankSourceIds = new Set();
let manualLinkSelectedOrphanIds = new Set();
let manualLinkEditingOrphanId = null; // id de mm_orphans cuyo modal de edición está abierto desde el modo manual (Propuesta #15)
// Última conciliación confirmada EN ESTA SESIÓN (por confirmMatch() o confirmManualLink()), para
// que undoLastReconciliation() (Propuesta #14) pueda revertir el estado local al instante sin
// tener que volver a analizar el Excel. Si el usuario deshace algo confirmado en una sesión
// anterior (o tras recargar la página), esto es null y undoLastReconciliation() se degrada a
// avisar que hay que volver a analizar el fichero para verlo reflejado. Propuesta #16: `keys` es
// ahora siempre un array (una clave por línea de banco implicada, aunque sea solo 1), y
// `bankChanges`/`orphansRemoved` son arrays -- un enlace N:M puede tocar varias propuestas y
// varios huérfanos a la vez, y deshacer debe revertirlos todos como una sola unidad.
let lastConfirmedAction = null;

// Mapa nombre de categoría/subcategoría -> mcid/mcscid reales de Money Manager (Bug #2,
// BACKLOG.md: confirmado contra el móvil real que create/update IGNORAN mbCategory/subCategory
// si no van acompañados del mcid/mcscid correspondiente -- sin ellos, el móvil guarda
// mbCategory literalmente como "None"). Se construye una sola vez desde moneyBook/getInitData,
// la misma fuente que usa el propio cliente oficial de PC Manager (reference/all_mm.js).
let categoryMapData = { income: {}, expense: {} };

// --- UTILIDADES DE CACHÉ ---
function setCache(key, data) {
    if (!data) return;
    localStorage.setItem(`mm_v4_${key}`, JSON.stringify({
        timestamp: Date.now(),
        data: data
    }));
}

function getCache(key) {
    const cached = localStorage.getItem(`mm_v4_${key}`);
    if (!cached) return null;
    try {
        const parsed = JSON.parse(cached);
        return parsed.data;
    } catch { return null; }
}

// --- NORMALIZACIÓN ---
function normalizeCategory(str) {
    if (!str) return "";
    let clean = str.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '');
    clean = clean.replace(/[^\w\sáéíóúÁÉÍÓÚñÑ]/g, ' ');
    return clean.trim().toLowerCase().replace(/\s+/g, ' ');
}

function formatCurrency(v) { return (parseFloat(v) || 0).toLocaleString('es-ES', { minimumFractionDigits: 2 }) + "\u00A0€"; }

// --- GESTIÓN DE PERIODOS ---
function getPeriod(type, customStart, customEnd) {
    const now = new Date();
    let start, end, label;

    if (type === 'current_economic' || type === 'previous_economic') {
        let baseDate = new Date(now);
        if (type === 'previous_economic') baseDate.setMonth(baseDate.getMonth() - 1);
        let day = baseDate.getDate();
        let month = baseDate.getMonth();
        let year = baseDate.getFullYear();

        if (day >= 28) {
            start = new Date(year, month, 28);
            end = new Date(year, month + 1, 27);
        } else {
            start = new Date(year, month - 1, 28);
            end = new Date(year, month, 27);
        }
        label = `${start.toLocaleDateString('es-ES', {month:'short'})} (28) - ${end.toLocaleDateString('es-ES', {month:'short'})} (27)`;
    } else if (type === 'current_month') {
        start = new Date(now.getFullYear(), now.getMonth(), 1);
        end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
        label = now.toLocaleDateString('es-ES', {month:'long', year:'numeric'});
    } else if (type === 'custom') {
        start = new Date(customStart);
        end = new Date(customEnd);
        label = "Rango Personalizado";
    }

    const format = (d) => {
        // Corrección estricta de huso horario local para evitar desfases de 1 día en toISOString()
        const localD = new Date(d.getTime() - (d.getTimezoneOffset() * 60000));
        return localD.toISOString().split('T')[0];
    };
    return { startDate: format(start), endDate: format(end), label: label };
}

async function handlePeriodChange() {
    const val = document.getElementById('periodSelector').value;
    if (val === 'custom') {
        const start = prompt("Inicio (YYYY-MM-DD):", currentPeriod.startDate);
        const end = prompt("Fin (YYYY-MM-DD):", currentPeriod.endDate);
        if (start && end) currentPeriod = getPeriod('custom', start, end);
        else return;
    } else {
        currentPeriod = getPeriod(val);
    }
    loadData();
}

// --- CARGA DE DATOS ---
async function loadData() {
    if (!currentPeriod.startDate) currentPeriod = getPeriod('current_economic');
    document.getElementById('periodLabel').textContent = currentPeriod.label;
    
    assetsData = getCache('assets') || [];
    transactionsData = getCache('transactions') || [];
    budgetsData = getCache('budgets') || [];
    categoryMapData = getCache('categoryMap') || { income: {}, expense: {} };
    
    if (window.AnalyticsEngine) AnalyticsEngine.init(transactionsData);
    
    updateUI();
    updateConnectionStatus('connecting');
    
    Promise.allSettled([
        fetchAssets(),
        fetchTransactions(),
        fetchBudgets(),
        fetchCategoryMap(),
        loadIPConfig()
    ]).then(results => {
        const anySuccess = results.some(r => r.status === 'fulfilled' && r.value === true);
        if (anySuccess) updateConnectionStatus('online');
        else updateConnectionStatus('offline');
    });
}

function updateConnectionStatus(state) {
    const el = document.getElementById('connectionStatus');
    if (state === 'online') {
        el.textContent = 'En Línea';
        el.className = 'status online';
    } else if (state === 'offline') {
        el.textContent = 'Modo Offline (Caché)';
        el.className = 'status offline';
    } else {
        el.textContent = 'Sincronizando...';
        el.className = 'status loading-status';
    }
}

// Bug #1 (BACKLOG.md): el backend distingue un fallo real de conexión con el móvil (campo
// `mm_connection_error`, o el `demo_mode` ya existente del proxy genérico) de un "cero
// resultados" válido. Antes, updateConnectionStatus() solo se llamaba desde loadData() -- un
// fallo a mitad de sesión (al subir un Excel, al cambiar de periodo...) no lo reflejaba en el
// indicador de conexión del header, que se quedaba mostrando "En Línea" aunque ya no lo estuviera.
// Cualquier fetch* que dependa del móvil comprueba esto y actualiza el indicador compartido, en
// vez de crear un aviso nuevo.
function isMmConnectionError(data) {
    return !!(data && (data.mm_connection_error || data.demo_mode));
}

async function fetchAssets() {
    try {
        const resp = await fetch('/api/proxy/moneyBook/getAssetData', { method: 'GET' });
        const data = await resp.json();
        if (isMmConnectionError(data)) { updateConnectionStatus('offline'); return false; }
        if (data && !data.error) {
            assetsData = data;
            setCache('assets', data);
            renderAccountList();
            updateConnectionStatus('online');
            return true;
        }
    } catch (e) { updateConnectionStatus('offline'); return false; }
}

async function fetchTransactions() {
    try {
        const resp = await fetch(`/api/proxy/moneyBook/getDataByPeriod?startDate=${currentPeriod.startDate}&endDate=${currentPeriod.endDate}`);
        const data = await resp.json();
        if (isMmConnectionError(data)) { updateConnectionStatus('offline'); return false; }
        if (Array.isArray(data)) {
            transactionsData = data;
            setCache('transactions', data);
            if (window.AnalyticsEngine) AnalyticsEngine.init(transactionsData);
            if (currentTab === 'transactions') renderTransactions();
            updateSummaries();
            updateConnectionStatus('online');
            return true;
        }
    } catch { updateConnectionStatus('offline'); return false; }
}

async function fetchBudgets() {
    try {
        const resp = await fetch(`/api/budget-hierarchy?startDate=${currentPeriod.startDate}&endDate=${currentPeriod.endDate}`);
        const data = await resp.json();
        if (isMmConnectionError(data)) { updateConnectionStatus('offline'); return false; }
        if (data && data.hierarchy) {
            budgetsData = data.hierarchy;
            setCache('budgets', data.hierarchy);
            if (currentTab === 'budgets') renderBudgets();
            if (currentTab === 'dashboard') renderChart();
            updateConnectionStatus('online');
            return true;
        }
    } catch { updateConnectionStatus('offline'); return false; }
}

// moneyBook/getInitData es el mismo endpoint que usa el cliente oficial de PC Manager para
// poblar sus combos de categoría (reference/all_mm.js) -- category_0 son categorías de Ingreso,
// category_1 de Gasto, cada una con su mcid real y sus subcategorías (mcsc) con su mcscid real.
// Necesario para que submitTransaction() pueda enviar mcid/mcscid junto al nombre (ver Bug #2).
function buildCategoryMap(list) {
    const map = {};
    (list || []).forEach(c => {
        const subs = {};
        (c.mcsc || []).forEach(s => { subs[s.mcscname] = s.mcscid; });
        map[c.mcname] = { mcid: c.mcid, subs };
    });
    return map;
}

async function fetchCategoryMap() {
    try {
        const resp = await fetch('/api/proxy/moneyBook/getInitData');
        const data = await resp.json();
        if (isMmConnectionError(data)) { updateConnectionStatus('offline'); return false; }
        if (data && !data.error) {
            categoryMapData = {
                income: buildCategoryMap(data.category_0),
                expense: buildCategoryMap(data.category_1),
            };
            setCache('categoryMap', categoryMapData);
            updateConnectionStatus('online');
            return true;
        }
    } catch { updateConnectionStatus('offline'); return false; }
}

// --- RENDERIZADO UI ---
const ASSET_TYPE_MAP = {
    '1': '🏦 Bancos', '3': '💳 Débito', '4': '🐖 Ahorros', '5': '📉 Préstamos', '11': '💵 Efectivo', 
    'de3f7285-e5d9-442f-92d1-15c289c518bf': '🇪🇺 Revolut'
};

function renderAccountList() {
    const list = document.getElementById('accountList');
    if (!list) return;
    list.innerHTML = '';
    if (!Array.isArray(assetsData)) return;

    assetsData.forEach(group => {
        const label = ASSET_TYPE_MAP[group.assetGroupId] || group.assetName;
        const groupEl = document.createElement('div');
        groupEl.className = 'account-group';
        groupEl.innerHTML = `<strong>${label}</strong>: ${formatCurrency(group.assetMoney)}`;
        
        group.children.forEach(item => {
            const itemEl = document.createElement('div');
            itemEl.className = 'account-item';
            itemEl.innerHTML = `<span class="dot" style="background:${item.color || '#4facfe'}"></span> ${item.assetName}: ${formatCurrency(item.assetMoney)}`;
            groupEl.appendChild(itemEl);
        });
        list.appendChild(groupEl);
    });
}

function updateSummaries() {
    let inc = 0, out = 0;
    transactionsData.forEach(t => { if (t.inOutType === 'Ingreso') inc += parseFloat(t.mbCash); else out += parseFloat(t.mbCash); });
    document.getElementById('totalIncome').textContent = formatCurrency(inc);
    document.getElementById('totalOutcome').textContent = formatCurrency(out);
}

function renderChart() {
    if (!window.AnalyticsEngine || budgetsData.length === 0) return;
    
    // Cambiar dinámicamente el título del gráfico
    const h3 = document.querySelector('#dashboardTab .chart-container h3');
    if (h3) h3.textContent = 'Distribución de Gastos vs Categoría';

    if (chartInstance) chartInstance.destroy();
    
    // Filtramos categorías con gastos para el gráfico
    const chartData = budgetsData.filter(c => c.spent_total > 5);
    
    // Usamos el motor analítico para dibujar el rosco y atrapar clics (Drill-down)
    chartInstance = AnalyticsEngine.renderInteractiveDonut('assetsChart', chartData, (selectedCat) => {
        applyFilter(selectedCat, null); // Drill down -> transactions filtered by cat
    });
}

function renderBudgets() {
    const tree = document.getElementById('budgetTree');
    if (!tree) return;
    tree.innerHTML = '';

    if (!budgetsData || budgetsData.length === 0) {
        tree.innerHTML = '<div class="card glass" style="padding:40px; text-align:center; color:var(--text-muted);">Cargando presupuestos... Si tarda, verifica la conexión en Ajustes.</div>';
        return;
    }

    budgetsData.forEach((catObj, idx) => {
        const catName = catObj.category;
        const spent = catObj.spent_total;
        const limit = catObj.budgeted;
        const percent = catObj.performance_pct;

        const node = document.createElement('div');
        node.className = 'tree-node';
        node.id = `node-${idx}`;
        
        let subsHtml = '';
        if (catObj.subcategories && catObj.subcategories.length > 0) {
            catObj.subcategories.sort((a,b) => (b.spent || 0) - (a.spent || 0)).forEach(sub => {
                const subBudget = sub.budgeted || 0;
                const subSpent = sub.spent || 0;
                const budgetInfo = subBudget > 0 ? ` / ${formatCurrency(subBudget)}` : '';
                subsHtml += `<div class="sub-item ripple" onclick="applyFilter('${catName}', '${sub.name}')">
                    <span>${sub.name}</span><strong>${formatCurrency(subSpent)}${budgetInfo}</strong>
                </div>`;
            });
        } else {
            subsHtml = '<div class="sub-item" style="color:var(--text-muted); font-size:0.8rem;">Sin subcategorías definidas</div>';
        }

        node.innerHTML = `
            <div class="tree-header" onclick="toggleNode('${idx}')">
                <div class="title"><span class="toggle-icon">▶</span> ${catName}</div>
                <div class="tree-info">
                    <strong>${formatCurrency(spent)}</strong> / ${formatCurrency(limit)}
                    <div class="progress-mini"><div class="progress-mini-bar" style="width:${Math.min(percent, 100)}%; background:${percent > 90 ? '#ef4444' : '#4facfe'}"></div></div>
                </div>
            </div>
            <div class="tree-children" id="children-${idx}">${subsHtml}</div>
        `;
        tree.appendChild(node);
    });
    reapplyInPageSearch();
}

function toggleNode(idx) { document.getElementById(`node-${idx}`).classList.toggle('expanded'); }
function expandAllBudgets() { document.querySelectorAll('.tree-node').forEach(n => n.classList.add('expanded')); }

// --- ORDENACIÓN Y TABLAS ---
let sortState = { column: -1, ascending: true };
let currentEditingId = null;
// Propuesta #10 (BACKLOG.md): true mientras el modal de edición está abierto desde "Ver Registro
// Asociado" en Conciliación -- evita que submitTransaction()/submitTransfer() naveguen a la
// pestaña Transacciones al guardar, para que el usuario no pierda el sitio en su revisión.
let modalOpenedFromConciliation = false;

function getAssetName(assetId, fallbackName) {
    if (fallbackName && fallbackName !== 'Desconocida' && fallbackName !== '') return fallbackName;
    if (!assetId) return 'Desconocida';
    for (let group of assetsData) {
        if (group.children) {
            let match = group.children.find(a => String(a.assetId) === String(assetId));
            if (match) return match.assetName;
        }
    }
    return 'Desconocida';
}

function sortTable(colIndex) {
    if (sortState.column === colIndex) {
        sortState.ascending = !sortState.ascending;
    } else {
        sortState.column = colIndex;
        sortState.ascending = true;
    }
    renderTransactions();
}

function renderTransactions() {
    const body = document.getElementById('transBody');
    if (!body) return;
    
    let filtered = [];
    if (window.AnalyticsEngine) {
        filtered = AnalyticsEngine.applyAdvancedFilters(currentFilter);
    } else {
        filtered = transactionsData;
    }

    // Aplicar ordenación
    if (sortState.column >= 0) {
        filtered.sort((a, b) => {
            let valA, valB;
            switch(sortState.column) {
                case 0: valA = a.mbDate || ''; valB = b.mbDate || ''; break;
                case 1: valA = (a.mbCategory || '').toLowerCase(); valB = (b.mbCategory || '').toLowerCase(); break;
                case 2: valA = (a.subCategory || '').toLowerCase(); valB = (b.subCategory || '').toLowerCase(); break;
                case 3: valA = (a.mbContent || '').toLowerCase(); valB = (b.mbContent || '').toLowerCase(); break;
                case 4: 
                    valA = getAssetName(a.assetId, a.assetName).toLowerCase(); 
                    valB = getAssetName(b.assetId, b.assetName).toLowerCase(); 
                    break;
                case 5: valA = parseFloat(a.mbCash || 0) * (a.inOutType==='Gasto'? -1 : 1); valB = parseFloat(b.mbCash || 0) * (b.inOutType==='Gasto'? -1 : 1); break;
            }
            if (valA < valB) return sortState.ascending ? -1 : 1;
            if (valA > valB) return sortState.ascending ? 1 : -1;
            return 0;
        });
    }

    body.innerHTML = filtered.length ? '' : '<tr><td colspan="6" style="text-align:center; padding:40px;">Sin movimientos registrados</td></tr>';
    filtered.forEach(t => {
        // Una transferencia interna de Money Manager NO se lee con inOutType "Transferencia" --
        // se confirmó contra el móvil real (2026-07-19, ver CLAUDE.md) que el texto real es
        // "Dinero gastado" para inOutCode "3" (el único observado en datos reales; "4" es el lado
        // invertido, contemplado por Money Manager pero nunca visto en 10 años de datos reales).
        // inOutCode es la señal fiable, no el texto de inOutType.
        const isTrans = t.inOutCode === '3' || t.inOutCode === '4';
        const isInc = t.inOutType === 'Ingreso';
        let amountText = formatCurrency(t.mbCash);
        let amountClass = isTrans ? 'text-muted' : (isInc ? 'income-text' : 'outcome-text');

        // Manejar separación de hora si mbDate contiene espacio (ej: "2026-03-27 10:30")
        let dateObj = t.mbDate ? t.mbDate.split(' ') : [''];
        let datePart = dateObj[0];
        let timePart = dateObj[1] || '';

        // Recuperar nombre de cuenta real cruzando assetId con la lista de activos
        let accountName = getAssetName(t.assetId, t.assetName);

        // Para una transferencia, categoría/subcategoría no aplican -- se muestra origen/destino
        // en su lugar (origen ya se ve en la columna "Cuenta Origen" vía accountName).
        let categoryCell, subCategoryCell;
        if (isTrans) {
            const origin = t.inOutCode === '4' ? t.toAssetId : t.assetId;
            const dest = t.inOutCode === '4' ? t.assetId : t.toAssetId;
            categoryCell = `<span class="badge badge-info" title="Transferencia entre cuentas propias de Money Manager">🔁 Transferencia</span>`;
            subCategoryCell = `<span class="badge subcategory-badge" title="Cuenta destino">→ ${getAssetName(dest, '')}</span>`;
        } else {
            categoryCell = `<span class="badge category-badge" onclick="applyFilter('${t.mbCategory}', null)" title="${t.mbCategory}">${t.mbCategory}</span>`;
            subCategoryCell = `<span class="badge subcategory-badge" onclick="applyFilter('${t.mbCategory}', '${t.subCategory}')" title="${t.subCategory || '-'}">${t.subCategory || '-'}</span>`;
        }

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>
                <div>${datePart}</div>
                ${timePart ? `<div style="font-size:0.7rem; color:var(--text-muted)">🕒 ${timePart}</div>` : ''}
            </td>
            <td>${categoryCell}</td>
            <td>${subCategoryCell}</td>
            <td onclick="editTransaction('${t.id}')" style="cursor:pointer;" title="Ver/Editar Detalles"><div>${t.mbContent}</div><div style="font-size:0.7rem; color:var(--text-muted)">${t.mbDetailContent || ''}</div></td>
            <td><div style="font-size:0.8rem">${accountName}</div></td>
            <td class="${amountClass}" style="text-align:right; font-weight:600">${amountText}</td>
            <td style="text-align:center;">
                <button class="btn-secondary btn-sm" onclick="editTransaction('${t.id}')" style="padding:2px 5px" title="Editar">✏️</button>
                <button class="btn-secondary btn-sm" onclick="deleteTransaction('${t.id}')" style="padding:2px 5px; color:#ff4d4f;" title="Borrar">🗑️</button>
            </td>
        `;
        body.appendChild(tr);
    });
    reapplyInPageSearch();
}

// --- CONTROLES DE FILTROS Y PESTAÑAS ---
function switchTab(id) {
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    document.getElementById(`${id}Tab`).classList.add('active');
    document.querySelectorAll('nav li').forEach(l => {
        l.classList.toggle('active', l.textContent.toLowerCase().includes(id.substring(0,3)));
    });
    currentTab = id;
    updateUI();
    // updateUI() ya reaplica la búsqueda activa para transactions/budgets (vía renderTransactions()/
    // renderBudgets()) -- para conciliation, cuyas tarjetas no se reconstruyen al cambiar de
    // pestaña, hace falta este pase explícito para que la búsqueda siga aplicada a su DOM ya
    // existente.
    reapplyInPageSearch();
}

function applyFilter(c, s) { 
    currentFilter.category = c;
    currentFilter.subCategory = s;
    switchTab('transactions'); 
}

function applyAdvancedFiltersUI() {
    currentFilter.searchStr = document.getElementById('filterSearch').value || null;
    const minM = document.getElementById('filterMin').value;
    const maxM = document.getElementById('filterMax').value;
    currentFilter.minAmount = minM ? parseFloat(minM) : null;
    currentFilter.maxAmount = maxM ? parseFloat(maxM) : null;
    renderTransactions();
}

function resetFilterUI() { 
    currentFilter = { category: null, subCategory: null, searchStr: null, minAmount: null, maxAmount: null, tags: null };
    document.getElementById('filterSearch').value = '';
    document.getElementById('filterMin').value = '';
    document.getElementById('filterMax').value = '';
    renderTransactions(); 
}

// --- COMPONENTES MODAL / CONFIG / CONCILIACIÓN ---
async function loadIPConfig() {
    try {
        const resp = await fetch('/api/config');
        const config = await resp.json();
        if (config.phone_ip) {
            document.getElementById('phoneIpInput').value = config.phone_ip;
            return true;
        }
    } catch { return false; }
}

async function saveIPConfig() {
    const ip = document.getElementById('phoneIpInput').value;
    const resp = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone_ip: ip, phone_port: "8888" })
    });
    if (resp.ok) {
        alert("¡Configuración guardada en el servidor!");
        loadData();
    }
}

function populateModalAccounts() {
    const selAcc = document.getElementById('editAccount');
    const selTargetAcc = document.getElementById('editTargetAccount');
    if (!selAcc) return;
    
    // Guardar valores actuales
    const currAcc = selAcc.value;
    const currTgt = selTargetAcc.value;
    
    selAcc.innerHTML = '';
    selTargetAcc.innerHTML = '';
    
    assetsData.forEach(g => {
        if (!g.children) return;
        g.children.forEach(a => {
            const opt1 = document.createElement('option');
            opt1.value = a.assetId;
            opt1.textContent = a.assetName;
            selAcc.appendChild(opt1);
            
            const opt2 = document.createElement('option');
            opt2.value = a.assetId;
            opt2.textContent = a.assetName;
            selTargetAcc.appendChild(opt2);
        });
    });
    
    if (currAcc) selAcc.value = currAcc;
    if (currTgt) selTargetAcc.value = currTgt;
}

function openAddModal() {
    currentEditingId = null;
    modalOpenedFromConciliation = false;
    const modalTitle = document.querySelector('#editModal h2');
    if (modalTitle) modalTitle.innerText = "Nueva Transacción";
    
    const now = new Date();
    document.getElementById('editDate').value = now.toISOString().split('T')[0];
    document.getElementById('editTime').value = now.toTimeString().substring(0,5);
    document.getElementById('editContent').value = '';
    
    if (document.getElementById('editDetailContent')) {
        document.getElementById('editDetailContent').value = '';
    }
    document.getElementById('editAmount').value = '';
    
    document.getElementById('editModal').style.display = 'flex'; 
    populateModalAccounts();
    updateModalCategories();
    
    // Diagnóstico: Verificar que las categorías están pobladas
    const catSel = document.getElementById('editCategory');
    console.log('[DIAG] openAddModal: budgetsData.length=', budgetsData.length, 'transactionsData.length=', transactionsData.length, 'catSel.options.length=', catSel.options.length, 'catSel.value=', catSel.value);
}

function openEditModal(tId) {
    currentEditingId = tId;
    const modalTitle = document.querySelector('#editModal h2');
    if (modalTitle) modalTitle.innerText = "Modificar Transacción";
    document.getElementById('editModal').style.display = 'flex'; 
    populateModalAccounts();
    updateModalCategories();
}

function closeModal() {
    currentEditingId = null;
    modalOpenedFromConciliation = false;
    manualLinkEditingOrphanId = null;
    document.getElementById('editModal').style.display = 'none';
}

window.onclick = function(event) {
    const modal = document.getElementById('editModal');
    if (event.target == modal) {
        closeModal();
    }
    const novedadesModal = document.getElementById('novedadesModal');
    if (event.target == novedadesModal) {
        closeNovedadesModal();
    }
}

async function editTransaction(tId) {
    let t = transactionsData.find(x => String(x.id) === String(tId));
    if (!t) return;
    modalOpenedFromConciliation = false;
    openEditModal(tId);
    populateEditFormFromTransaction(t);
}

// Rellena los campos del modal de edición ya abierto (openEditModal()/openAddModal() ya lo
// hicieron visible) a partir de un objeto de transacción de Money Manager -- extraído de
// editTransaction() para poder reutilizarlo también desde viewAssociatedRecord() (Propuesta #10,
// BACKLOG.md), que puede necesitar un registro que no esté en transactionsData.
function populateEditFormFromTransaction(t) {
    // inOutCode es la señal fiable de que es una transferencia, no el texto de inOutType (ver
    // renderTransactions() y CLAUDE.md -- el texto real de lectura es "Dinero gastado", nunca
    // "Transferencia"/"Transfer"). Con el mapeo antiguo, editar una transferencia real abría el
    // modal como si fuera un Ingreso.
    const isTrans = t.inOutCode === '3' || t.inOutCode === '4';

    let datePart = '', timePart = '12:00';
    if(t.mbDate) {
        let parts = t.mbDate.includes('T') ? t.mbDate.split('T') : t.mbDate.split(' ');
        datePart = parts[0];
        if (parts.length > 1) {
            timePart = parts[1].substring(0,5);
        }
    }

    document.getElementById('editType').value = isTrans ? 'Transferencia' : (t.inOutType === 'Ingreso' ? 'Ingreso' : 'Gasto');

    updateModalCategories();

    if (datePart) document.getElementById('editDate').value = datePart;
    document.getElementById('editTime').value = timePart;

    document.getElementById('editAmount').value = Math.abs(t.mbCash || 0.0);
    document.getElementById('editContent').value = t.mbContent || '';
    if (document.getElementById('editDetailContent')) {
        document.getElementById('editDetailContent').value = t.mbDetailContent || '';
    }

    if (isTrans) {
        // inOutCode "3" (el único observado en datos reales): assetId = cuenta origen, toAssetId
        // = cuenta destino. "4" es el lado invertido que contempla el propio Money Manager
        // (reference/moneybook.js) aunque no se haya observado nunca en datos reales.
        const originId = t.inOutCode === '4' ? t.toAssetId : t.assetId;
        const destId = t.inOutCode === '4' ? t.assetId : t.toAssetId;
        if (originId) document.getElementById('editAccount').value = originId;
        if (destId) document.getElementById('editTargetAccount').value = destId;
    } else {
        if (t.assetId) document.getElementById('editAccount').value = t.assetId;
        if (t.mbCategory) document.getElementById('editCategory').value = t.mbCategory;
        // Minibug (BACKLOG.md, 2026-07-20): updateModalCategories() ya llamó a
        // updateModalSubCategories() más arriba, pero en ese momento editCategory.value todavía
        // tenía la categoría PREVIA (o ninguna, en la primera apertura de la sesión) -- el
        // <select> de subcategoría quedaba poblado para esa categoría antigua, no para
        // t.mbCategory, que se acaba de fijar en la línea de arriba. Asignar editSubCategory.value
        // directamente después no seleccionaba nada (un <select> ignora en silencio un value que
        // no coincide con ninguna de sus <option>): la subcategoría se veía vacía. Recalcular aquí,
        // ya con la categoría correcta, antes de fijar el valor de subcategoría.
        updateModalSubCategories();
        if (t.subCategory) document.getElementById('editSubCategory').value = t.subCategory;
    }
}

async function deleteTransaction(tId) {
    if (!confirm("¿Seguro que quieres borrar este registro?")) return;
    
    const payload = new URLSearchParams();
    payload.append('ids', `:${tId}`); // El payload del móvil usa el prefijo ':'
    
    try {
        const resp = await fetch(`/api/proxy/moneyBook/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: payload.toString()
        });
        const text = await resp.text();
        if (text === 'true' || text.includes('success:true') || text.includes('success') || resp.ok) {
            alert("Borrado correctamente.");
            loadData();
        } else {
            alert("Error al borrar: " + text);
        }
    } catch(e) {
        alert("Fallo de conexión: " + e.message);
    }
}

function updateModalCategories() {
    const type = document.getElementById('editType').value;
    const catSel = document.getElementById('editCategory');
    const subCatCont = document.getElementById('subCatContainer');
    const tgtAccCont = document.getElementById('targetAccountContainer');
    
    // Guardar selección previa
    const prevCat = catSel.value;
    catSel.innerHTML = '';
    
    if (type === 'Transferencia') {
        catSel.disabled = true;
        subCatCont.style.display = 'none';
        tgtAccCont.style.display = 'block';
    } else {
        catSel.disabled = false;
        subCatCont.style.display = 'block';
        tgtAccCont.style.display = 'none';
        
        // Construir set único de categorías desde presupuestos Y transacciones
        const catSet = new Map();
        
        // Fuente 1: Presupuestos (incluye categorías sin gasto)
        budgetsData.forEach(c => {
            if (!catSet.has(c.category)) {
                catSet.set(c.category, c.subcategories || []);
            }
        });
        
        // Fuente 2: Transacciones reales (para categorías no presupuestadas)
        transactionsData.forEach(t => {
            if (t.mbCategory && !catSet.has(t.mbCategory)) {
                catSet.set(t.mbCategory, []);
            }
        });
        
        catSet.forEach((subs, catName) => {
            const opt = document.createElement('option');
            opt.value = catName;
            opt.textContent = catName;
            catSel.appendChild(opt);
        });
        
        // Restaurar selección previa si existe
        if (prevCat && [...catSel.options].some(o => o.value === prevCat)) {
            catSel.value = prevCat;
        }
        
        updateModalSubCategories();
    }
}

function updateModalSubCategories() {
    const catName = document.getElementById('editCategory').value;
    const subSel = document.getElementById('editSubCategory');
    const prevSub = subSel.value;
    subSel.innerHTML = '';
    
    // Fuente 1: Subcategorías del presupuesto
    const subSet = new Set();
    const catObj = budgetsData.find(c => c.category === catName);
    if (catObj && catObj.subcategories) {
        catObj.subcategories.forEach(s => {
            subSet.add(s.name);
        });
    }
    
    // Fuente 2: Subcategorías de transacciones reales
    transactionsData.forEach(t => {
        if (t.mbCategory === catName && t.subCategory) {
            subSet.add(t.subCategory);
        }
    });
    
    subSet.forEach(subName => {
        const opt = document.createElement('option');
        opt.value = subName;
        opt.textContent = subName;
        subSel.appendChild(opt);
    });
    
    // Restaurar selección previa si existe
    if (prevSub && [...subSel.options].some(o => o.value === prevSub)) {
        subSel.value = prevSub;
    }
}

async function submitTransaction() {
    const typeStr = document.getElementById('editType').value;

    // Una transferencia NO se crea/edita con moneyBook/create-update (Bug de Tarea 2, ver
    // BACKLOG.md y CLAUDE.md) -- Money Manager usa un endpoint y unos nombres de campo
    // completamente distintos (moneyBook/moveAsset y moneyBook/modifyMoveAsset, confirmado
    // contra reference/all_mm.js y contra el móvil real). Enviar una transferencia por
    // moneyBook/create (como se hacía antes) "tenía éxito" pero guardaba la cuenta destino como
    // null -- una transferencia rota, silenciosamente.
    if (typeStr === 'Transferencia') {
        return submitTransfer();
    }

    // Forzamos la decodificación tipo application/x-www-form-urlencoded para el API heredada
    const payload = new URLSearchParams();

    // inOutCode confirmado contra el móvil real (Bug #2, BACKLOG.md): "0"=Ingreso, "1"=Gasto --
    // el mapeo previo ('Ingreso': '2') se confirmó roto: el móvil respondía {success:true} pero
    // la transacción nunca llegaba a persistir (invisible incluso en un rango de 10 años
    // completo). inOutType (el texto) se confirmó puramente cosmético: el móvil deriva el
    // inOutType real de lectura ("Gasto"/"Ingreso") a partir de inOutCode, no del texto recibido
    // -- se sigue enviando el nombre en español tal cual para no depender de esa asunción
    // indefinidamente.
    let inOutCodeMap = {'Gasto': '1', 'Ingreso': '0'};

    payload.append('inOutType', typeStr);
    payload.append('inOutCode', inOutCodeMap[typeStr] || '1');
    payload.append('mbDate', `${document.getElementById('editDate').value} ${document.getElementById('editTime').value}:00`);
    payload.append('mbContent', document.getElementById('editContent').value);

    const dContent = document.getElementById('editDetailContent') ? document.getElementById('editDetailContent').value : '';
    if (dContent) payload.append('mbDetailContent', dContent);

    payload.append('mbCash', document.getElementById('editAmount').value);

    let accountId = document.getElementById('editAccount').value;
    payload.append('assetId', accountId);
    payload.append('payType', getAssetName(accountId, ''));

    const cat = document.getElementById('editCategory').value;
    const sub = document.getElementById('editSubCategory').value;
    if (cat) payload.append('mbCategory', cat);
    if (sub) payload.append('subCategory', sub);

    // Bug #2 (BACKLOG.md): el móvil ignora mbCategory/subCategory si no van acompañados
    // del mcid/mcscid real -- sin ellos guarda mbCategory literalmente como "None". Se
    // resuelve por nombre contra categoryMapData (ver fetchCategoryMap()).
    const catMap = (typeStr === 'Ingreso' ? categoryMapData.income : categoryMapData.expense) || {};
    const catEntry = catMap[cat];
    if (catEntry) {
        payload.append('mcid', catEntry.mcid);
        if (sub && catEntry.subs[sub]) {
            payload.append('mcscid', catEntry.subs[sub]);
        }
    } else if (cat) {
        console.warn('[submitTransaction] No se encontró mcid para la categoría', cat, '-- puede no guardarse correctamente. ¿Se ha sincronizado categoryMapData?');
    }

    if (currentEditingId) {
        payload.append('id', currentEditingId);
    }

    if (!payload.get('mbDate') || !payload.get('mbContent') || !payload.get('mbCash')) {
        alert("Por favor, completa todos los campos obligatorios.");
        return;
    }

    const endpoint = currentEditingId ? `/api/proxy/moneyBook/update` : `/api/proxy/moneyBook/create`;

    try {
        const resp = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: payload.toString()
        });
        
        const text = await resp.text();
        if (text === 'true' || text.includes('success:true') || text.includes('success') || resp.ok) {
            // Capturar ANTES de closeModal(), que pone currentEditingId/modalOpenedFromConciliation/
            // manualLinkEditingOrphanId a su valor por defecto -- leerlos después (como hacía antes
            // este bloque) hacía que targetId y el mensaje de "modificada" nunca acertaran tras una
            // edición.
            const wasEditingId = currentEditingId;
            const cameFromConciliation = modalOpenedFromConciliation;
            const editedOrphanId = manualLinkEditingOrphanId;
            closeModal();
            // Refrescar en silencio los datos de sqlite
            await fetchTransactions();

            if (editedOrphanId) {
                // Propuesta #15 (BACKLOG.md): editado desde una fila de huérfano del modo de
                // enlace manual -- refresca solo ese huérfano en lastOrphans (y su fila en el modo
                // manual) con los datos ya corregidos, sin esperar a un re-análisis completo.
                await refreshEditedOrphan(editedOrphanId);
            }

            if (cameFromConciliation) {
                // Abierto desde "Ver Registro Asociado" en Conciliación (Propuesta #10,
                // BACKLOG.md) -- no navegar de pestaña, el usuario debe quedar exactamente donde
                // estaba en su revisión de propuestas.
                alert(wasEditingId ? "Transacción modificada." : "Transacción añadida exitosamente.");
                return;
            }

            // Si es edición usamos el ID, si es nueva buscamos el max ID
            let targetId = wasEditingId;
            if (!targetId && transactionsData.length > 0) {
                targetId = Math.max(...transactionsData.map(t => parseInt(t.id || 0)));
            }
            // Enseñar en pantalla aislada la transacción
            if (targetId) {
                showTransaction(targetId);
            } else {
                renderTransactions();
            }
            alert(wasEditingId ? "Transacción modificada." : "Transacción añadida exitosamente.");
        } else {
            alert("Error al guardar: " + resp.status + " | " + text);
        }
    } catch(e) {
        alert("Error de conexión al guardar: " + e.message);
    }
}

// Crea/edita una transferencia entre cuentas propias de Money Manager. Endpoint y campos
// verificados contra reference/all_mm.js (formulario assetMoveForm) y confirmados contra el
// móvil real (Tarea 2, BACKLOG.md): moneyBook/create-update NO sirve para esto -- "tenía éxito"
// pero guardaba la cuenta destino (toAssetId) como null. moveDate es solo fecha (sin hora, a
// diferencia de mbDate) -- así es como el propio Money Manager guarda sus transferencias.
async function submitTransfer() {
    const payload = new URLSearchParams();

    const fromAssetId = document.getElementById('editAccount').value;
    const toAssetId = document.getElementById('editTargetAccount').value;
    const amount = document.getElementById('editAmount').value;
    const content = document.getElementById('editContent').value;
    const moveDate = document.getElementById('editDate').value;

    if (!moveDate || !fromAssetId || !toAssetId || !amount || !content) {
        alert("Por favor, completa todos los campos obligatorios.");
        return;
    }
    if (fromAssetId === toAssetId) {
        alert("La cuenta origen y la cuenta destino no pueden ser la misma.");
        return;
    }

    payload.append('moveDate', moveDate);
    payload.append('fromAssetId', fromAssetId);
    payload.append('fromAssetName', getAssetName(fromAssetId, ''));
    payload.append('toAssetId', toAssetId);
    payload.append('toAssetName', getAssetName(toAssetId, ''));
    payload.append('moveMoney', amount);
    payload.append('moneyContent', content);

    const dContent = document.getElementById('editDetailContent') ? document.getElementById('editDetailContent').value : '';
    if (dContent) payload.append('mbDetailContent', dContent);

    let endpoint;
    if (currentEditingId) {
        payload.append('id', currentEditingId);
        endpoint = '/api/proxy/moneyBook/modifyMoveAsset';
    } else {
        endpoint = '/api/proxy/moneyBook/moveAsset';
    }

    try {
        const resp = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: payload.toString()
        });

        const text = await resp.text();
        if (text === 'true' || text.includes('success:true') || text.includes('success') || resp.ok) {
            // Capturar antes de closeModal() -- ver mismo comentario en submitTransaction().
            const wasEditingId = currentEditingId;
            const editedOrphanId = manualLinkEditingOrphanId;
            closeModal();
            await fetchTransactions();
            renderTransactions();
            if (editedOrphanId) {
                // Propuesta #15 (BACKLOG.md): mismo refresco que en submitTransaction(). Caso raro
                // sin cubrir del todo: el id de una transferencia CAMBIA tras cada edición (ver
                // CLAUDE.md, "Transferencias internas de Money Manager") -- si el huérfano editado
                // era una transferencia, refreshEditedOrphan() ya no encuentra el id viejo y no
                // hace nada (se degrada en silencio, sin refrescar esa fila hasta el próximo
                // análisis completo), en vez de fallar.
                await refreshEditedOrphan(editedOrphanId);
            }
            alert(wasEditingId ? "Transferencia modificada." : "Transferencia añadida exitosamente.");
        } else {
            alert("Error al guardar la transferencia: " + resp.status + " | " + text);
        }
    } catch (e) {
        alert("Error de conexión al guardar: " + e.message);
    }
}

function defaultLabelFor(filename) {
    return (filename || '').replace(/\.[^/.]+$/, '') || filename;
}

function handleFilesSelected() {
    const fileInput = document.getElementById('excelInput');
    const files = Array.from(fileInput.files || []);
    if (files.length === 0) return;
    pendingFiles = files.map(file => ({ file, label: defaultLabelFor(file.name), accountIds: [] }));
    renderFileLabelsList();
}

function updatePendingLabel(idx, value) {
    pendingFiles[idx].label = value.trim() || defaultLabelFor(pendingFiles[idx].file.name);
}

// Lista plana {assetId, assetName, linkAssetId, groupName} de todas las cuentas/tarjetas reales
// de Money Manager, para el selector "cuentas asociadas" de cada fichero subido en conciliación.
// Una tarjeta vinculada a una cuenta (p.ej. una tarjeta de débito) trae `linkAssetId` apuntando
// al assetId de esa cuenta -- así se puede auto-marcar la tarjeta en cuanto el usuario elige la
// cuenta, sin que tenga que recordar manualmente qué tarjetas cuelgan de dónde.
function flattenAssets() {
    const out = [];
    (assetsData || []).forEach(g => {
        if (!g.children) return;
        g.children.forEach(a => out.push({
            assetId: a.assetId,
            assetName: a.assetName,
            linkAssetId: a.linkAssetId || null,
            groupName: g.assetName || '',
        }));
    });
    return out;
}

function linkedCardIdsFor(accountId) {
    return flattenAssets()
        .filter(a => a.linkAssetId && String(a.linkAssetId) === String(accountId))
        .map(a => String(a.assetId));
}

function accountOptionsMultiHtml(selectedIds) {
    const selected = new Set((selectedIds || []).map(String));
    const groups = {};
    flattenAssets().forEach(a => {
        (groups[a.groupName] || (groups[a.groupName] = [])).push(a);
    });
    return Object.entries(groups).map(([groupName, items]) => {
        const opts = items.map(a =>
            `<option value="${a.assetId}" ${selected.has(String(a.assetId)) ? 'selected' : ''}>${a.assetName}</option>`
        ).join('');
        return `<optgroup label="${groupName}">${opts}</optgroup>`;
    }).join('');
}

// Al añadir una cuenta a la selección, auto-marca también sus tarjetas vinculadas (editable
// después: el usuario puede quitarlas o añadir más a mano). Quitar una cuenta NO quita sus
// tarjetas automáticamente -- solo se auto-AÑADE, nunca se auto-quita, para no sorprender al
// usuario deseleccionando algo que marcó a mano.
function updatePendingAccounts(idx, selectEl) {
    const newSelected = Array.from(selectEl.selectedOptions).map(o => o.value);
    const prevSelected = pendingFiles[idx].accountIds || [];
    const addedNow = newSelected.filter(v => !prevSelected.includes(v));

    const finalSelected = new Set(newSelected);
    addedNow.forEach(accId => linkedCardIdsFor(accId).forEach(cardId => finalSelected.add(cardId)));

    pendingFiles[idx].accountIds = Array.from(finalSelected);
    Array.from(selectEl.options).forEach(o => { o.selected = finalSelected.has(o.value); });
}

function cancelPendingFiles() {
    pendingFiles = [];
    document.getElementById('excelInput').value = '';
    renderFileLabelsList();
}

function renderFileLabelsList() {
    const container = document.getElementById('fileLabelsList');
    if (pendingFiles.length === 0) {
        container.style.display = 'none';
        container.innerHTML = '';
        return;
    }
    container.style.display = 'block';
    const rowsHtml = pendingFiles.map((pf, idx) => `
        <div style="display:flex; align-items:center; gap:10px; margin-bottom:8px;">
            <span style="flex:1; font-size:0.9rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${pf.file.name}">${pf.file.name}</span>
            <input type="text" value="${pf.label}" onchange="updatePendingLabel(${idx}, this.value)"
                   placeholder="Etiqueta" style="width:180px; padding:6px 10px; background:rgba(0,0,0,0.3); border:1px solid var(--glass-border); border-radius:8px; color:white;">
            <select multiple size="5" onchange="updatePendingAccounts(${idx}, this)"
                    title="Cuentas/tarjetas de Money Manager asociadas a este fichero (opcional). Al elegir una cuenta se auto-marcan sus tarjetas vinculadas -- puedes quitarlas o añadir más a mano (Ctrl/Cmd+clic para selección múltiple). Acota el matching a estas cuentas/tarjetas y permite reconocer transferencias entre cuentas propias."
                    style="width:220px; padding:6px 10px; background:rgba(0,0,0,0.3); border:1px solid var(--glass-border); border-radius:8px; color:white;">
                ${accountOptionsMultiHtml(pf.accountIds)}
            </select>
        </div>
    `).join('');
    container.innerHTML = `
        <h3>Ficheros seleccionados (${pendingFiles.length})</h3>
        <p style="color:var(--text-muted); font-size:0.85rem; margin:5px 0 15px;">Ponle una etiqueta corta a cada uno (p.ej. "Revolut", "Cuenta Sabadell") para distinguirlos en la lista de propuestas. Las cuentas asociadas son opcionales (Ctrl/Cmd+clic para marcar varias): al elegir una cuenta se auto-marcan sus tarjetas vinculadas, editable después. Acotan el matching a esas cuentas/tarjetas y permiten reconocer transferencias entre cuentas propias — si una línea del extracto no encaja en ninguna de las cuentas marcadas, se busca igualmente en el resto de Money Manager y se avisa con un badge.</p>
        <div>${rowsHtml}</div>
        <div class="modal-buttons" style="margin-top:15px;">
            <button class="btn-secondary btn-sm" onclick="cancelPendingFiles()">Cancelar</button>
            <button class="btn-primary btn-sm" onclick="confirmUploadFiles()">Analizar ${pendingFiles.length} fichero(s)</button>
        </div>
    `;
}

async function confirmUploadFiles() {
    if (pendingFiles.length === 0) return;
    const fileInput = document.getElementById('excelInput');
    const list = document.getElementById('proposalsList');

    try {
        const formData = new FormData();
        pendingFiles.forEach(pf => {
            formData.append('files', pf.file);
            formData.append('labels', pf.label);
            formData.append('accountIds', (pf.accountIds || []).join(','));
        });
        formData.append('windowDays', 3);

        document.getElementById('fileLabelsList').style.display = 'none';
        list.innerHTML = `<p>Analizando ${pendingFiles.length} fichero(s)... Por favor espera.</p>`;

        const res = await fetch('/api/analyze-excel', { method: 'POST', body: formData });
        const data = await res.json();

        // Bug #1 (BACKLOG.md): un fallo de conexión real con el móvil a mitad de sesión (p.ej.
        // se cerró Money Manager mientras se subía el Excel) no debe mostrarse como si fuera un
        // error cualquiera ni, sobre todo, dejar renderizar propuestas como si fueran válidas --
        // el backend ya aborta antes de generar ninguna en este caso (mm_connection_error).
        if (isMmConnectionError(data)) {
            updateConnectionStatus('offline');
            list.innerHTML = `<p style="color:#f87171">⚠️ No se pudo conectar con Money Manager en el móvil. No se ha generado ninguna propuesta -- verifica que la app esté abierta y PC Manager activo, y vuelve a intentarlo.</p>`;
            return;
        }

        if (!data || data.error) {
            list.innerHTML = `<p style="color:#f87171">Error al analizar: ${data ? data.error : 'Desconocido'}</p>`;
            return;
        }

        updateConnectionStatus('online');
        lastProposals = data.proposals || [];
        lastOrphans = data.mm_orphans || [];
        currentLabelFilter = 'all';
        activeSummaryFilters = new Set();

        if (data.file_errors && data.file_errors.length > 0) {
            const detalle = data.file_errors.map(fe => `${fe.filename} (${fe.label}): ${fe.error}`).join('\n');
            alert(`Algunos ficheros no se pudieron leer:\n\n${detalle}`);
        }

        updateLabelFilterBar();
        renderProposalsList();
        renderMmOrphansList();
        renderReconciliationSummary();
        // Datos nuevos -> cualquier selección del modo de enlace manual quedaría apuntando a
        // objetos que ya no están en lastProposals/lastOrphans.
        manualLinkSelectedBankSourceIds = new Set();
        manualLinkSelectedOrphanIds = new Set();
        renderManualLinkSection();
    } catch (e) {
        list.innerHTML = '';
        alert("Error crítico subiendo ficheros: " + e.message);
    } finally {
        pendingFiles = [];
        fileInput.value = '';
        renderFileLabelsList();
    }
}

function updateLabelFilterBar() {
    const bar = document.getElementById('proposalsFilterBar');
    const labels = [...new Set([...lastProposals.map(p => p.source_label), ...lastOrphans.map(o => o.source_label)])];

    if (labels.length <= 1) {
        bar.style.display = 'none';
        bar.innerHTML = '';
        currentLabelFilter = 'all';
        return;
    }

    bar.style.display = 'flex';
    const countAll = lastProposals.length + lastOrphans.length;
    const options = labels.map(l => {
        const count = lastProposals.filter(p => p.source_label === l).length + lastOrphans.filter(o => o.source_label === l).length;
        return `<option value="${l}" ${currentLabelFilter === l ? 'selected' : ''}>${l} (${count})</option>`;
    }).join('');
    bar.innerHTML = `
        <label style="color:var(--text-muted); font-size:0.85rem;">Filtrar por origen:</label>
        <select onchange="handleLabelFilterChange(this.value)" style="background:rgba(0,0,0,0.3); color:var(--text-main); border:1px solid var(--glass-border); border-radius:8px; padding:6px 10px;">
            <option value="all" ${currentLabelFilter === 'all' ? 'selected' : ''}>Todos (${countAll})</option>
            ${options}
        </select>
    `;
}

function handleLabelFilterChange(value) {
    currentLabelFilter = value;
    renderProposalsList();
    renderMmOrphansList();
}

// Propuesta #16 (BACKLOG.md): traduce el status de una propuesta a la categoría de badge del
// resumen a la que pertenece -- el mismo mapeo que ya usaba renderReconciliationSummary() para
// contar, ahora reutilizado también para filtrar. Los huérfanos de MM no tienen "status" propio
// -- pertenecen siempre (y solo) a la categoría 'mmOnly', tratados aparte en
// matchesActiveSummaryFilters() de más abajo.
function summaryCategoryForProposal(p) {
    if (p.status === 'exact_match' || p.status === 'reconciled') return 'matched';
    if (p.status === 'suggested_match' || p.status === 'probable_match') return 'pending';
    if (p.status === 'new') return 'bankOnly';
    return null;
}

// Sin filtros activos (conjunto vacío) se muestra todo, igual que antes de esta propuesta -- los
// badges empiezan "sin pulsar" y no ocultan nada por sí solos.
function matchesActiveSummaryFilters(p) {
    if (activeSummaryFilters.size === 0) return true;
    return activeSummaryFilters.has(summaryCategoryForProposal(p));
}

function toggleSummaryFilter(kind) {
    if (activeSummaryFilters.has(kind)) {
        activeSummaryFilters.delete(kind);
    } else {
        activeSummaryFilters.add(kind);
    }
    renderReconciliationSummary();
    renderProposalsList();
    renderMmOrphansList();
}

function renderProposalsList() {
    const list = document.getElementById('proposalsList');
    list.innerHTML = '';

    if (lastProposals.length === 0) {
        return;
    }

    const visible = (currentLabelFilter === 'all'
        ? lastProposals
        : lastProposals.filter(p => p.source_label === currentLabelFilter)
    ).filter(matchesActiveSummaryFilters).slice().sort((a, b) => new Date(b.date) - new Date(a.date));

    visible.forEach(p => {
        const card = document.createElement('div');
        let isDuplicate = p.status !== 'new';
        let badgeColor = p.status === 'reconciled' ? 'badge-info' :
                         (isDuplicate ? (p.status === 'exact_match' ? 'badge-danger' : 'badge-warning') : 'badge-success');
        let badgeText = p.status === 'reconciled' ? 'Ya Conciliado' :
                       (p.status === 'exact_match' ? 'Duplicado Exacto' :
                       (p.status === 'new' ? 'Nuevo Movimiento' : 'Posible Coincidencia'));

        let candidatesHtml = '';
        if (p.status === 'exact_match' || p.status === 'reconciled') {
            candidatesHtml = `<div style="margin-top:10px;"><button class="btn-secondary btn-sm" onclick="viewAssociatedRecord('${p.suggested_mm_ref}', '${p.date}')">👁 Ver Registro Asociado</button></div>`;
        } else if (p.status === 'suggested_match' || p.status === 'probable_match') {
            candidatesHtml = `<div style="margin-top:10px;"><strong>Posibles Asociados en MoneyManager:</strong><ul style="list-style:none; padding-left:0; margin-top:5px;">`;
            (p.candidates || []).forEach(cand => {
                const candTransferTag = cand.is_transfer ? ` <span class="badge badge-info" style="font-size:0.7rem;">🔁 Transferencia</span>` : '';
                candidatesHtml += `<li style="font-size:0.85rem; padding:5px; background:rgba(255,255,255,0.05); margin-bottom:5px; border-radius:4px; display:flex; justify-content:space-between; align-items:center;">
                                   <div>${cand.date} | <strong>${formatCurrency(cand.amount)}</strong> | ${cand.description.substring(0,25)}... | <em>${cand.asset}</em>${candTransferTag}</div>
                                    <button class="btn-primary btn-sm" style="padding:2px 8px; font-size:0.75rem;" onclick="confirmMatch('${p.source_id}', '${cand.id}')">Confirmar Este</button>
                                   </li>`;
            });
            candidatesHtml += `</ul></div>`;
        } else if (p.status === 'new') {
            // Deducir la cuenta base mirando si hay algún "exact_match" en el array para copiar su cuenta original
            let defaultAccount = '';
            let matchAcc = lastProposals.find(pr => pr.status === 'exact_match' && pr.suggested_mm_ref);
            if (matchAcc && window.transactionsData) {
                let mmRecord = transactionsData.find(t => String(t.id) === String(matchAcc.suggested_mm_ref));
                if (mmRecord) defaultAccount = mmRecord.assetId;
            }
            let cleanDesc = (p.description || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
            candidatesHtml = `<div style="margin-top:10px;"><button class="btn-primary btn-sm" onclick="prefillAddModal('${p.date}', ${p.amount}, '${cleanDesc}', '${defaultAccount}')">📥 Pre-rellenar y Añadir</button></div>`;
        }

        const transferTag = p.is_transfer
            ? `<span class="badge badge-info" title="Esta línea encaja con una transferencia entre cuentas propias en Money Manager${p.transfer_role ? ` (lado ${p.transfer_role})` : ''}.">🔁 Transferencia interna</span>`
            : '';
        const fallbackTag = p.account_fallback
            ? `<span class="badge badge-warning" title="No se encontró dentro de las cuentas/tarjetas que marcaste para este fichero -- esta coincidencia viene de otra cuenta de Money Manager. Revísala con más atención antes de confirmar.">⚠️ Fuera de la cuenta esperada</span>`
            : '';

        // Propuesta #8 (BACKLOG.md): exact_match/reconciled ya son un check correcto -- se
        // atenúan (clase proposal-resolved). suggested_match/probable_match/new sí requieren
        // revisión del usuario -- se mantienen a plena opacidad y ganan un acento de color
        // (clase proposal-attention + status-<estado> para el matiz, ver style.css).
        const isResolved = p.status === 'exact_match' || p.status === 'reconciled';
        card.className = `card glass proposal-card status-${p.status} ${isResolved ? 'proposal-resolved' : 'proposal-attention'}`;
        card.innerHTML = `
            <div class="proposal-header">
                <strong>${p.date}</strong>
                <span style="display:flex; gap:6px; flex-wrap:wrap;">
                    <span class="badge badge-info" title="${p.source_filename || ''}">${p.source_label || ''}</span>
                    <span class="badge ${badgeColor}">${badgeText}</span>
                    ${fallbackTag}
                    ${transferTag}
                </span>
            </div>
            <p>${p.description}</p>
            <p class="amount ${p.amount < 0 ? 'outcome-text' : 'income-text'}">${formatCurrency(p.amount)}</p>
            ${candidatesHtml}
        `;
        list.appendChild(card);
    });
    reapplyInPageSearch();
}

// Propuesta #11 (BACKLOG.md), arqueo de caja: sentido contrario al de renderProposalsList()
// (MM -> banco, no banco -> MM) -- sección visualmente aparte a propósito (ver CLAUDE.md,
// "Arqueo de caja: huérfanos de Money Manager sin equivalente en el extracto"), para que no se
// lea como "falta hacer algo" del mismo tipo que un `new`/`suggested_match` de #proposalsList.
function renderMmOrphansList() {
    const section = document.getElementById('mmOrphansSection');
    const list = document.getElementById('mmOrphansList');
    list.innerHTML = '';

    if (!lastOrphans || lastOrphans.length === 0) {
        section.style.display = 'none';
        return;
    }
    section.style.display = 'block';

    // A diferencia de una propuesta, un huérfano de MM solo pertenece a la categoría 'mmOnly' del
    // resumen -- si hay algún filtro activo y no incluye 'mmOnly', ningún huérfano puede
    // "cuadrar" ni ser "solo del banco", así que la lista completa queda oculta.
    const visible = (currentLabelFilter === 'all'
        ? lastOrphans
        : lastOrphans.filter(o => o.source_label === currentLabelFilter)
    ).filter(() => activeSummaryFilters.size === 0 || activeSummaryFilters.has('mmOnly'))
     .slice().sort((a, b) => new Date(b.date) - new Date(a.date));

    visible.forEach(o => {
        const card = document.createElement('div');
        const transferTag = o.is_transfer
            ? `<span class="badge badge-info" title="Transferencia interna de Money Manager${o.transfer_side ? ` (lado ${o.transfer_side})` : ''}. Si el otro banco de esta transferencia no está en esta tanda, es normal que aparezca aquí.">🔁 Transferencia interna</span>`
            : '';
        card.className = 'card glass proposal-card mm-orphan-card';
        card.innerHTML = `
            <div class="proposal-header">
                <strong>${o.date}</strong>
                <span style="display:flex; gap:6px; flex-wrap:wrap;">
                    <span class="badge badge-info" title="${o.source_filename || ''}">${o.source_label || ''}</span>
                    <span class="badge badge-warning">Solo en Money Manager</span>
                    ${transferTag}
                </span>
            </div>
            <p>${o.description}${o.category ? ` <span style="color:var(--text-muted); font-size:0.85rem;">· ${o.category}</span>` : ''}</p>
            <p class="amount ${o.amount < 0 ? 'outcome-text' : 'income-text'}">${formatCurrency(o.amount)}</p>
            <div style="margin-top:10px;"><button class="btn-secondary btn-sm" onclick="viewAssociatedRecord('${o.id}', '${o.date}')">👁 Ver Registro</button></div>
        `;
        list.appendChild(card);
    });
    reapplyInPageSearch();
}

// Resumen del arqueo de caja "de un vistazo" -- cuánto cuadra, cuánto falta por revisar, cuánto
// falta solo por el lado del banco y cuánto falta solo por el lado de Money Manager. Deliberadamente
// NO se filtra por `currentLabelFilter` (a diferencia de las listas): es un resumen global de la
// tanda completa, no de la etiqueta seleccionada en cada momento.
function renderReconciliationSummary() {
    const bar = document.getElementById('reconciliationSummaryBar');
    if (lastProposals.length === 0 && (!lastOrphans || lastOrphans.length === 0)) {
        bar.style.display = 'none';
        bar.innerHTML = '';
        return;
    }
    const matched = lastProposals.filter(p => p.status === 'exact_match' || p.status === 'reconciled').length;
    const pending = lastProposals.filter(p => p.status === 'suggested_match' || p.status === 'probable_match').length;
    const bankOnly = lastProposals.filter(p => p.status === 'new').length;
    const mmOnly = (lastOrphans || []).length;
    bar.style.display = 'flex';
    // Propuesta #16 (BACKLOG.md): cada badge es ahora un <button> que alterna su categoría dentro
    // de `activeSummaryFilters` (multiseleccionable, no excluyente) y filtra proposalsList/
    // mmOrphansList en combinación con el filtro de etiqueta y la búsqueda Ctrl+F -- ver
    // toggleSummaryFilter()/matchesActiveSummaryFilters(). La clase 'active' (estilo en style.css)
    // es la única señal visual de qué filtro(s) están aplicados ahora mismo.
    const btn = (kind, colorClass, icon, count, label, title) => `
        <button type="button" class="badge ${colorClass} badge-filter ${activeSummaryFilters.has(kind) ? 'active' : ''}"
                title="${title}" onclick="toggleSummaryFilter('${kind}')">${icon} ${count} ${label}</button>
    `;
    bar.innerHTML = [
        btn('matched', 'badge-success', '✅', matched, 'cuadran', 'Movimientos del banco que coinciden con Money Manager (ya conciliados o coincidencia exacta). Clic para filtrar.'),
        btn('pending', 'badge-warning', '❓', pending, 'por revisar', 'Movimientos del banco con varios candidatos posibles en Money Manager, pendientes de que elijas uno. Clic para filtrar.'),
        btn('bankOnly', 'badge-danger', '🏦', bankOnly, 'solo en el banco', 'Movimientos del banco que no existen todavía en Money Manager. Clic para filtrar.'),
        btn('mmOnly', 'badge-warning', '📱', mmOnly, 'solo en Money Manager', 'Movimientos en Money Manager (dentro de la cuenta/periodo de algún fichero con cuenta asociada) que no aparecen en ningún extracto subido. Clic para filtrar.'),
    ].join('');
}

function prefillAddModal(date, amount, content, defaultAccount) {
    openAddModal();
    if (date) document.getElementById('editDate').value = date;
    if (amount) {
        document.getElementById('editAmount').value = Math.abs(amount);
        document.getElementById('editType').value = amount < 0 ? 'Gasto' : 'Ingreso';
        updateModalCategories(); // Refrescar las categorías basadas en Gasto/Ingreso
    }
    if (content) document.getElementById('editContent').value = content;
    if (defaultAccount) document.getElementById('editAccount').value = defaultAccount;
    document.getElementById('editModal').scrollIntoView({behavior: 'smooth'});
}

function showTransaction(id) {
    currentFilter.searchStr = null; // Resetear texto
    document.getElementById('filterSearch').value = '';

    // Filtrar para mostrar solo esta id temporalmente
    let filtered = transactionsData.filter(t => String(t.id) === String(id));
    if(filtered.length > 0) {
        switchTab('transactions'); // Ir a ventana de transacciones
        let savedData = window.AnalyticsEngine ? AnalyticsEngine.applyAdvancedFilters : null;
        if(savedData) AnalyticsEngine.applyAdvancedFilters = () => filtered; // Forzar tabla a mostrar 1 resultado
        renderTransactions();
        if(savedData) setTimeout(() => { AnalyticsEngine.applyAdvancedFilters = savedData; }, 5000); // Restaurar tras 5s
    } else {
        alert("Transacción original no encontrada en el set actual de datos de 1 mes.");
    }
}

// Busca puntualmente un registro de Money Manager por id en una ventana de fechas alrededor de
// `aroundDate`, sin tocar transactionsData/caché -- para no interferir con lo que ya se muestra
// en Dashboard/Transacciones (que sólo cubren currentPeriod, ver loadData()/fetchTransactions()).
// Usado por viewAssociatedRecord() cuando el registro conciliado cae fuera de ese periodo, algo
// habitual porque el rango del extracto bancario conciliado no tiene por qué coincidir con el
// periodo actualmente seleccionado en el Dashboard.
async function fetchTransactionById(mmId, aroundDate) {
    try {
        const base = aroundDate ? new Date(aroundDate) : new Date();
        if (isNaN(base.getTime())) return null;
        const pad = (d, days) => {
            const r = new Date(d);
            r.setDate(r.getDate() + days);
            return r.toISOString().split('T')[0];
        };
        const resp = await fetch(`/api/proxy/moneyBook/getDataByPeriod?startDate=${pad(base, -31)}&endDate=${pad(base, 31)}`);
        const data = await resp.json();
        if (isMmConnectionError(data) || !Array.isArray(data)) return null;
        return data.find(t => String(t.id) === String(mmId)) || null;
    } catch (e) {
        return null;
    }
}

// Propuesta #10 (BACKLOG.md): "Ver Registro Asociado" abre el registro de Money Manager
// correspondiente en el mismo modal de edición ya existente, en vez de navegar a la pestaña
// Transacciones -- así el usuario no pierde su posición de scroll ni el filtro de etiqueta activo
// en Conciliación (el modal es un overlay `position: fixed`, no desplaza la página de debajo; ver
// style.css). modalOpenedFromConciliation evita además que guardar cambios aquí navegue de
// pestaña (ver submitTransaction()/submitTransfer()).
async function viewAssociatedRecord(mmId, proposalDate) {
    let t = transactionsData.find(x => String(x.id) === String(mmId));
    if (!t) {
        t = await fetchTransactionById(mmId, proposalDate);
    }
    if (!t) {
        alert("No se encontró el registro asociado en Money Manager.");
        return;
    }
    modalOpenedFromConciliation = true;
    openEditModal(t.id);
    populateEditFormFromTransaction(t);
}

// Propuesta #15 (BACKLOG.md): igual que viewAssociatedRecord(), pero desde una fila de huérfano
// de MM del modo de enlace manual -- para corregir un error de introducción (fecha, céntimos,
// categoría...) ANTES de confirmar el enlace, en vez de descubrirlo después. Reutiliza el mismo
// modal/flujo de guardado que Propuesta #10 (modalOpenedFromConciliation evita navegar de
// pestaña); manualLinkEditingOrphanId es lo único distinto -- submitTransaction()/submitTransfer()
// lo comprueban tras guardar para refrescar SOLO ese huérfano en lastOrphans con los datos ya
// corregidos, en vez de dejar la fila con el valor antiguo hasta el próximo análisis completo.
async function editOrphanFromManualLink(mmId, date) {
    let t = transactionsData.find(x => String(x.id) === String(mmId));
    if (!t) {
        t = await fetchTransactionById(mmId, date);
    }
    if (!t) {
        alert("No se encontró el registro de Money Manager.");
        return;
    }
    modalOpenedFromConciliation = true;
    manualLinkEditingOrphanId = mmId;
    openEditModal(t.id);
    populateEditFormFromTransaction(t);
}

// Tras editar un huérfano desde el modo de enlace manual (editOrphanFromManualLink()), refresca
// SOLO ese registro en lastOrphans con los datos ya guardados -- una consulta puntual igual que
// fetchTransactionById(), sin tocar transactionsData/caché del Dashboard, para que la fila del
// modo manual deje de mostrar el valor antiguo sin esperar a un re-análisis completo del Excel.
// Si el registro editado ya no encaja en ninguna fecha cercana (p.ej. se cambió la fecha muy
// lejos), simplemente no se encuentra y la fila se deja tal cual -- un caso raro, no un error.
async function refreshEditedOrphan(mmId) {
    const idx = (lastOrphans || []).findIndex(o => String(o.id) === String(mmId));
    if (idx === -1) return;
    const fresh = await fetchTransactionById(mmId, lastOrphans[idx].date);
    if (!fresh) return;
    const isTransfer = fresh.inOutCode === '3' || fresh.inOutCode === '4';
    lastOrphans[idx] = {
        ...lastOrphans[idx],
        date: fresh.mbDate ? fresh.mbDate.split(/[ T]/)[0] : lastOrphans[idx].date,
        amount: parseFloat(fresh.mbCash) || 0,
        description: fresh.mbContent || '',
        category: isTransfer ? '' : (fresh.mbCategory || ''),
    };
    renderMmOrphansList();
    renderManualLinkSection();
}

async function confirmMatch(sourceId, candId) {
    const proposal = lastProposals.find(p => p.source_id === sourceId);
    if (!proposal) {
        alert("No se encontró la propuesta original (¿recargaste la página desde el último análisis?). Vuelve a subir el Excel.");
        return;
    }

    try {
        const resp = await fetch('/api/reconciliations/confirm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                date: proposal.date,
                amount: proposal.amount,
                description: proposal.description,
                mm_id: candId
            })
        });
        const data = await resp.json();
        if (!resp.ok || data.error) {
            alert("Error al confirmar el match: " + (data.error || resp.status));
            return;
        }
        // Match enlazado localmente (NUNCA se escribe en el móvil). Bug #9 (BACKLOG.md): antes
        // solo se atenuaba la tarjeta en el DOM directamente (opacity + ocultar la lista de
        // candidatos), sin actualizar `proposal` dentro de `lastProposals` -- el badge seguía
        // diciendo "Posible Coincidencia" incluso justo después de confirmar, y cualquier
        // re-render posterior en la misma sesión sin volver a pedir datos al backend (p.ej.
        // cambiar el filtro de etiqueta en `#proposalsFilterBar`) reconstruía la tarjeta desde
        // el estado viejo y la mostraba otra vez con dudas y los botones "Confirmar Este"
        // activos, aunque el backend ya la tuviera persistida como conciliada (verificado que el
        // backend en sí -- make_key() y la sobreescritura a 'reconciled' en analyze_excel() --
        // ya funcionaba correctamente; el estado desincronizado vivía solo aquí). Replicamos el
        // mismo resultado que calcularía analyze_excel() al re-analizar (ver app.py) para que el
        // estado local quede coherente con el del backend en cualquier re-render.
        // Captura ANTES de sobreescribir -- undoLastReconciliation() (Propuesta #14) la usa para
        // restaurar la tarjeta al instante si el usuario deshace esto en la misma sesión.
        // Propuesta #16: formato unificado de lastConfirmedAction (arrays) para que
        // undoLastReconciliation() trate igual un enlace 1:1 (confirmMatch(), esta función) y un
        // enlace N:M (confirmManualLink()) -- aquí siempre listas de un solo elemento.
        lastConfirmedAction = {
            keys: [data.key],
            bankChanges: [{ sourceId, previousState: { status: proposal.status, confidence: proposal.confidence, suggested_mm_ref: proposal.suggested_mm_ref, reconciled_mm_ids: proposal.reconciled_mm_ids, candidates: proposal.candidates } }],
            orphansRemoved: [],
        };
        proposal.status = 'reconciled';
        proposal.confidence = 100;
        proposal.suggested_mm_ref = candId;
        proposal.reconciled_mm_ids = [candId];
        proposal.candidates = [];
        renderProposalsList();
        // Propuesta #16 (BACKLOG.md): faltaba -- confirmManualLink()/undoLastReconciliation() ya
        // recalculaban el resumen tras mutar el estado local, pero confirmMatch() no, así que los
        // badges de #reconciliationSummaryBar quedaban desactualizados (mismo recuento de "por
        // revisar"/"cuadran" de antes de confirmar) hasta el siguiente análisis completo.
        renderReconciliationSummary();
    } catch (e) {
        alert("Error crítico confirmando match: " + e.message);
    }
}

// --- MODO DE ENLACE MANUAL BANCO <-> MONEY MANAGER (huérfanos) ---
// Caso motivador: un cargo de Amazon en el banco solo trae el número de pedido como concepto,
// mientras que en Money Manager se guarda con un concepto distinto y a veces con la fecha
// desplazada uno o dos días -- el matching automático no los cruza, y ambos quedan como huérfanos
// (la línea del banco como "new" en `lastProposals`, la transacción de MM en `lastOrphans`).
// Este modo muestra ambas listas en paralelo para que el usuario elija a mano una de cada una y
// las enlace. NO es un mecanismo nuevo de persistencia: reutiliza el mismo
// `/api/reconciliations/confirm` que ya usa confirmMatch() -- un enlace manual es, en el fondo, un
// match confirmado por el usuario con menos certeza automática que un exact_match/candidato
// sugerido. Nunca escribe en Money Manager, solo vincula localmente los dos registros que ya
// existen allí y en el extracto.
function toggleManualLinkMode() {
    manualLinkMode = !manualLinkMode;
    const section = document.getElementById('manualLinkSection');
    const btn = document.getElementById('manualLinkToggleBtn');
    manualLinkSelectedBankSourceIds = new Set();
    manualLinkSelectedOrphanIds = new Set();
    if (manualLinkMode) {
        section.style.display = 'block';
        btn.classList.remove('btn-secondary');
        btn.classList.add('btn-primary');
        renderManualLinkSection();
    } else {
        section.style.display = 'none';
        btn.classList.remove('btn-primary');
        btn.classList.add('btn-secondary');
    }
}

// Propuesta #16 (BACKLOG.md): selección múltiple en checkboxes (antes radios de un único
// elemento) -- alterna la pertenencia al Set en vez de sustituir un único id seleccionado.
function selectManualLinkBank(sourceId) {
    if (manualLinkSelectedBankSourceIds.has(sourceId)) manualLinkSelectedBankSourceIds.delete(sourceId);
    else manualLinkSelectedBankSourceIds.add(sourceId);
    renderManualLinkSection();
}

function selectManualLinkOrphan(orphanId) {
    if (manualLinkSelectedOrphanIds.has(orphanId)) manualLinkSelectedOrphanIds.delete(orphanId);
    else manualLinkSelectedOrphanIds.add(orphanId);
    renderManualLinkSection();
}

// Deliberadamente NO se filtra por `currentLabelFilter` (a diferencia de renderProposalsList()/
// renderMmOrphansList()) -- el caso motivador (Amazon) es precisamente uno donde el cargo del
// banco y su contrapartida en Money Manager pueden venir de ficheros/etiquetas distintas, así que
// limitar por etiqueta activa iría en contra del propio propósito de este modo.
// Bug real (BACKLOG.md): con un extracto bancario real puede haber más de un movimiento con la
// MISMA fecha/importe/descripción -- dos compras idénticas el mismo día en el mismo comercio no
// son un caso raro (confirmado con datos reales de samples/: "COMPRA T.C. CARL.S JR PLAZA MAYOR"
// y "COMPRA T.C. GELATOMARE S.L." aparecen dos veces cada una, mismo importe, mismo día, en un
// único extracto real). El mecanismo de confirmManualLink()/renderManualLinkSection() identifica
// cada fila por su `source_id`/`id` real (nunca por fecha/importe/descripción), así que confirmar
// una de dos filas idénticas SÍ quita solo esa -- pero al ojo humano, sin nada que las distinga,
// la fila gemela que queda parece "la misma que no desapareció". Se calcula un ordinal (p.ej.
// "1/2", "2/2") para cada grupo de filas con la misma fecha/importe/descripción visible, y se
// muestra como badge SOLO cuando hay más de una -- no cambia nada del comportamiento, solo hace
// visible una ambigüedad que ya existía en los datos.
function computeDuplicateOrdinals(items, keyFn) {
    const counts = {};
    items.forEach(it => { const k = keyFn(it); counts[k] = (counts[k] || 0) + 1; });
    const seen = {};
    return items.map(it => {
        const k = keyFn(it);
        seen[k] = (seen[k] || 0) + 1;
        return counts[k] > 1 ? { ordinal: seen[k], total: counts[k] } : null;
    });
}

// Propuesta #16 (BACKLOG.md): suma con signo tal cual de los importes bancarios seleccionados --
// el importe del banco SÍ lleva un convenio de signo fiable (el del propio extracto), a diferencia
// de mm_orphans[].amount (ver más abajo).
function sumSelectedBankAmounts(bankItems) {
    return bankItems.filter(p => manualLinkSelectedBankSourceIds.has(p.source_id)).reduce((s, p) => s + p.amount, 0);
}

// A diferencia del banco, `mm_orphans[].amount` no lleva un convenio de signo consistente en los
// datos reales de Money Manager (confirmado contra datos reales -- ver comentario histórico más
// abajo en el ordenamiento por cercanía): sumar con signo mezclaría magnitudes que en realidad
// deberían compararse en valor absoluto. Se suman magnitudes absolutas -- el sumador existe para
// "comparar a ojo" (tal y como pide la propuesta), no para una igualdad matemática con signo.
function sumSelectedOrphanAmounts(orphanItems) {
    return orphanItems.filter(o => manualLinkSelectedOrphanIds.has(o.id)).reduce((s, o) => s + Math.abs(o.amount), 0);
}

function renderManualLinkSection() {
    if (!manualLinkMode) return;
    const bankList = document.getElementById('manualLinkBankList');
    const orphanList = document.getElementById('manualLinkOrphanList');
    const confirmBtn = document.getElementById('manualLinkConfirmBtn');

    const bankItems = lastProposals.filter(p => p.status === 'new');
    const selectedBankItems = bankItems.filter(p => manualLinkSelectedBankSourceIds.has(p.source_id));

    // Mejora de usabilidad sugerida en la propuesta: con algún movimiento del banco seleccionado,
    // ordena los huérfanos de MM por cercanía de importe (a la SUMA de lo ya marcado en el banco)
    // en vez de dejarlos solo por fecha -- no obliga a buscar a ojo en una lista larga. Bug real
    // (BACKLOG.md): comparar los importes directamente (con signo) estaba roto porque
    // `mm_orphans[].amount` no lleva un convenio de signo consistente en los datos reales de Money
    // Manager (algunas filas vienen en positivo, otras en negativo, para el mismo tipo de
    // movimiento -- confirmado contra datos reales), a diferencia del importe del banco, que
    // siempre lleva el signo real del extracto. Comparar por MAGNITUD absoluta en ambos lados es
    // correcto independientemente del convenio de signo de cada uno.
    let orphanItems = (lastOrphans || []).slice();
    if (selectedBankItems.length > 0) {
        const bankMagnitude = Math.abs(sumSelectedBankAmounts(bankItems));
        orphanItems.sort((a, b) => Math.abs(Math.abs(a.amount) - bankMagnitude) - Math.abs(Math.abs(b.amount) - bankMagnitude));
    } else {
        orphanItems.sort((a, b) => new Date(b.date) - new Date(a.date));
    }

    const bankOrdinals = computeDuplicateOrdinals(bankItems, p => `${p.date}|${p.amount}|${(p.description || '').trim()}`);
    bankList.innerHTML = bankItems.length ? bankItems.map((p, idx) => {
        const dup = bankOrdinals[idx];
        const dupTag = dup
            ? `<span class="badge badge-warning" style="font-size:0.7rem;" title="Hay ${dup.total} movimientos del banco con esta misma fecha, importe y descripción -- revisa cuál es cuál antes de confirmar (p.ej. dos compras idénticas el mismo día).">🔢 ${dup.ordinal}/${dup.total}</span>`
            : '';
        const checked = manualLinkSelectedBankSourceIds.has(p.source_id);
        return `
        <label class="manual-link-row ${checked ? 'manual-link-row-selected' : ''}">
            <input type="checkbox" value="${p.source_id}" ${checked ? 'checked' : ''} onchange="selectManualLinkBank('${p.source_id}')">
            <span class="manual-link-row-text">
                <strong>${p.date}</strong> · ${formatCurrency(p.amount)}
                <span class="manual-link-row-desc">${p.description}</span>
                <span class="badge badge-info" style="font-size:0.7rem;">${p.source_label || ''}</span>
                ${dupTag}
            </span>
        </label>
    `;
    }).join('') : '<p class="text-muted" style="padding:10px;">No hay movimientos del banco sin match en esta tanda.</p>';

    // Fila reestructurada en div > (label + botón), no solo <label>, para poder meter el botón
    // "Editar" (Propuesta #15) como hermano del label en vez de anidado dentro de él -- un botón
    // anidado en un <label> reactiva también el checkbox asociado al hacer clic (comportamiento
    // estándar de <label>), lo que habría marcado el huérfano como seleccionado sin querer al
    // pulsar "editar". Las filas del banco (arriba) no lo necesitan y se quedan como <label> solo.
    const orphanOrdinals = computeDuplicateOrdinals(orphanItems, o => `${o.date}|${o.amount}|${(o.description || '').trim()}|${o.category || ''}`);
    orphanList.innerHTML = orphanItems.length ? orphanItems.map((o, idx) => {
        const bankMagnitude = selectedBankItems.length > 0 ? Math.abs(sumSelectedBankAmounts(bankItems)) : null;
        const closeAmount = bankMagnitude !== null && Math.abs(Math.abs(o.amount) - bankMagnitude) < 0.01;
        const dup = orphanOrdinals[idx];
        const dupTag = dup
            ? `<span class="badge badge-warning" style="font-size:0.7rem;" title="Hay ${dup.total} registros de Money Manager con esta misma fecha, importe y descripción -- revisa cuál es cuál antes de confirmar.">🔢 ${dup.ordinal}/${dup.total}</span>`
            : '';
        const checked = manualLinkSelectedOrphanIds.has(o.id);
        return `
        <div class="manual-link-row ${checked ? 'manual-link-row-selected' : ''} ${closeAmount ? 'manual-link-row-suggested' : ''}">
            <label class="manual-link-row-main">
                <input type="checkbox" value="${o.id}" ${checked ? 'checked' : ''} onchange="selectManualLinkOrphan('${o.id}')">
                <span class="manual-link-row-text">
                    <strong>${o.date}</strong> · ${formatCurrency(o.amount)}
                    <span class="manual-link-row-desc">${o.description}${o.category ? ` · ${o.category}` : ''}</span>
                    <span class="badge badge-info" style="font-size:0.7rem;">${o.source_label || ''}</span>
                    ${closeAmount ? '<span class="badge badge-success" style="font-size:0.7rem;">💡 Importe parecido</span>' : ''}
                    ${dupTag}
                </span>
            </label>
            <button type="button" class="btn-secondary btn-sm manual-link-edit-btn" onclick="editOrphanFromManualLink('${o.id}', '${o.date}')" title="Editar este registro de Money Manager antes de enlazarlo (p.ej. si tiene un error de fecha/importe/categoría)">✏️</button>
        </div>
    `;
    }).join('') : '<p class="text-muted" style="padding:10px;">No hay movimientos de Money Manager sin equivalente en esta tanda.</p>';

    renderManualLinkSums(bankItems, orphanItems);
    confirmBtn.disabled = !(manualLinkSelectedBankSourceIds.size > 0 && manualLinkSelectedOrphanIds.size > 0);
}

// Propuesta #16 (BACKLOG.md): sumador en tiempo real de ambos lados, para comparar a ojo mientras
// se seleccionan filas -- y aviso no bloqueante (no impide confirmar) si al terminar de
// seleccionar las sumas no coinciden exactamente (tolerancia de 1 céntimo, igual que el resto de
// comparaciones de importe de este proyecto).
function renderManualLinkSums(bankItems, orphanItems) {
    const sumsEl = document.getElementById('manualLinkSums');
    const warningEl = document.getElementById('manualLinkMismatchWarning');
    const bankCount = manualLinkSelectedBankSourceIds.size;
    const orphanCount = manualLinkSelectedOrphanIds.size;

    if (bankCount === 0 && orphanCount === 0) {
        sumsEl.innerHTML = '';
        warningEl.style.display = 'none';
        return;
    }

    const bankSum = sumSelectedBankAmounts(bankItems);
    const orphanSum = sumSelectedOrphanAmounts(orphanItems);
    sumsEl.innerHTML = `
        <div class="manual-link-sum-col">Banco (${bankCount} seleccionado${bankCount === 1 ? '' : 's'}): <span class="manual-link-sum-value">${formatCurrency(bankSum)}</span></div>
        <div class="manual-link-sum-col">Money Manager (${orphanCount} seleccionado${orphanCount === 1 ? '' : 's'}): <span class="manual-link-sum-value">${formatCurrency(orphanSum)}</span></div>
    `;

    const mismatch = bankCount > 0 && orphanCount > 0 && Math.abs(Math.abs(bankSum) - orphanSum) >= 0.01;
    if (mismatch) {
        const diff = Math.abs(Math.abs(bankSum) - orphanSum);
        warningEl.style.display = 'block';
        warningEl.innerHTML = `⚠️ Las sumas no coinciden exactamente (diferencia de ${formatCurrency(diff)}). Puedes confirmar igualmente -- es una conciliación informal, no tiene por qué cuadrar al céntimo -- y se te ofrecerá añadir una observación a los registros de Money Manager con el detalle de qué movimientos del banco representa.`;
    } else {
        warningEl.style.display = 'none';
    }
}

// Propuesta #16 (BACKLOG.md): añade una observación a uno o varios registros de Money Manager,
// EXPLÍCITAMENTE pedida por el usuario (nunca automática/silenciosa) tras un enlace N:M cuyas
// sumas no cuadraban exactamente -- ver confirmManualLink(). Reutiliza moneyBook/update, el mismo
// mecanismo de escritura ya verificado en submitTransaction(), añadiendo el texto al `mbContent`
// existente sin tocar el resto de campos -- incluye mcid/mcscid resueltos por nombre contra
// categoryMapData (Bug #2, BACKLOG.md: sin ellos el móvil guarda la categoría como "None"). Las
// transferencias (inOutCode "3"/"4") usan un endpoint y campos totalmente distintos
// (moneyBook/moveAsset, ver CLAUDE.md) -- se excluyen aquí y se le pide al usuario que las edite a
// mano desde "Ver Registro Asociado" en vez de arriesgarse a corromper una transferencia real.
async function appendNoteToMmRecords(mmIds, noteText) {
    const results = [];
    for (const mmId of mmIds) {
        let t = transactionsData.find(x => String(x.id) === String(mmId));
        if (!t) t = await fetchTransactionById(mmId, null);
        if (!t) {
            results.push({ mmId, ok: false, reason: 'No se encontró el registro.' });
            continue;
        }
        if (t.inOutCode === '3' || t.inOutCode === '4') {
            results.push({ mmId, ok: false, reason: 'Es una transferencia -- añádela a mano desde "Ver Registro Asociado".' });
            continue;
        }

        let datePart = '', timePart = '12:00';
        if (t.mbDate) {
            const parts = t.mbDate.includes('T') ? t.mbDate.split('T') : t.mbDate.split(' ');
            datePart = parts[0];
            if (parts.length > 1) timePart = parts[1].substring(0, 5);
        }

        const typeStr = t.inOutType === 'Ingreso' ? 'Ingreso' : 'Gasto';
        const inOutCodeMap = { 'Gasto': '1', 'Ingreso': '0' };
        const newContent = `${t.mbContent || ''} [${noteText}]`.trim();

        const payload = new URLSearchParams();
        payload.append('inOutType', typeStr);
        payload.append('inOutCode', inOutCodeMap[typeStr]);
        payload.append('mbDate', `${datePart} ${timePart}:00`);
        payload.append('mbContent', newContent);
        payload.append('mbCash', Math.abs(t.mbCash || 0));
        payload.append('assetId', t.assetId);
        payload.append('payType', getAssetName(t.assetId, ''));
        if (t.mbCategory) payload.append('mbCategory', t.mbCategory);
        if (t.subCategory) payload.append('subCategory', t.subCategory);
        const catMap = (typeStr === 'Ingreso' ? categoryMapData.income : categoryMapData.expense) || {};
        const catEntry = catMap[t.mbCategory];
        if (catEntry) {
            payload.append('mcid', catEntry.mcid);
            if (t.subCategory && catEntry.subs[t.subCategory]) payload.append('mcscid', catEntry.subs[t.subCategory]);
        }
        payload.append('id', mmId);

        try {
            const resp = await fetch('/api/proxy/moneyBook/update', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: payload.toString(),
            });
            const text = await resp.text();
            const ok = text === 'true' || text.includes('success:true') || text.includes('success') || resp.ok;
            results.push({ mmId, ok });
        } catch (e) {
            results.push({ mmId, ok: false, reason: e.message });
        }
    }
    return results;
}

// Propuesta #16 (BACKLOG.md): enlace N:M -- varias líneas del banco seleccionadas (checkboxes) con
// varios registros de Money Manager seleccionados, en vez del 1:1 original. Reutiliza
// /api/reconciliations/confirm-group (una entrada por línea de banco, todas comparten group_id y
// la lista completa de mm_ids -- ver confirm_group() en reconciliation_store.py), NUNCA escribe en
// Money Manager como PARTE de la conciliación en sí (igual que el resto de este modo) -- la
// observación opcional de más abajo es una acción EXPLÍCITA aparte, solo si el usuario la acepta.
async function confirmManualLink() {
    const bankItems = lastProposals.filter(p => p.status === 'new');
    const selectedBankProposals = bankItems.filter(p => manualLinkSelectedBankSourceIds.has(p.source_id));
    const selectedOrphans = (lastOrphans || []).filter(o => manualLinkSelectedOrphanIds.has(o.id));
    if (selectedBankProposals.length === 0 || selectedOrphans.length === 0) {
        alert("Selecciona al menos un movimiento del banco y uno de Money Manager antes de confirmar.");
        return;
    }

    const bankSum = sumSelectedBankAmounts(bankItems);
    const orphanSum = sumSelectedOrphanAmounts(selectedOrphans);
    const mismatch = Math.abs(Math.abs(bankSum) - orphanSum) >= 0.01;
    if (mismatch) {
        const diff = Math.abs(Math.abs(bankSum) - orphanSum);
        if (!confirm(`Las sumas no coinciden exactamente (banco: ${formatCurrency(bankSum)}, Money Manager: ${formatCurrency(orphanSum)}, diferencia de ${formatCurrency(diff)}).\n\n¿Confirmar el enlace igualmente? Es una conciliación informal, no tiene por qué cuadrar al céntimo.`)) {
            return;
        }
    }

    const mmIds = selectedOrphans.map(o => o.id);
    const bankLines = selectedBankProposals.map(p => ({ date: p.date, amount: p.amount, description: p.description }));
    const note = mismatch
        ? `Conciliación N:M (suma no exacta: banco ${formatCurrency(bankSum)} vs MM ${formatCurrency(orphanSum)}). Movimientos de banco: ` +
          bankLines.map(l => `${l.date} ${formatCurrency(l.amount)} "${l.description.trim()}"`).join('; ')
        : null;

    try {
        const resp = await fetch('/api/reconciliations/confirm-group', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bank_lines: bankLines, mm_ids: mmIds, note }),
        });
        const data = await resp.json();
        if (!resp.ok || data.error) {
            alert("Error al confirmar el enlace: " + (data.error || resp.status));
            return;
        }

        // Mismo patrón que confirmMatch(): reflejar en el estado local el mismo resultado que
        // calcularía analyze_excel() al re-analizar, para no depender de volver a subir el Excel.
        // Los huérfanos se quitan de lastOrphans aquí mismo -- el backend solo los excluiría en el
        // PRÓXIMO análisis (excluded_mm_ids se recalcula a partir de data/reconciliations.json),
        // no de forma retroactiva sobre esta respuesta ya recibida.
        // Captura ANTES de mutar nada -- undoLastReconciliation() (Propuesta #14) necesita tanto
        // el estado previo de cada propuesta como los huérfanos completos (se descartan de
        // lastOrphans más abajo, así que sin esta copia no habría forma de reinsertarlos tal cual).
        lastConfirmedAction = {
            keys: data.keys,
            bankChanges: selectedBankProposals.map(p => ({
                sourceId: p.source_id,
                previousState: { status: p.status, confidence: p.confidence, suggested_mm_ref: p.suggested_mm_ref, reconciled_mm_ids: p.reconciled_mm_ids, candidates: p.candidates },
            })),
            orphansRemoved: selectedOrphans.map(o => ({ ...o })),
        };
        selectedBankProposals.forEach(p => {
            p.status = 'reconciled';
            p.confidence = 100;
            p.suggested_mm_ref = mmIds[0];
            p.reconciled_mm_ids = mmIds;
            p.candidates = [];
        });
        const removedIds = new Set(mmIds.map(String));
        lastOrphans = (lastOrphans || []).filter(o => !removedIds.has(String(o.id)));

        manualLinkSelectedBankSourceIds = new Set();
        manualLinkSelectedOrphanIds = new Set();

        renderProposalsList();
        renderMmOrphansList();
        renderReconciliationSummary();
        renderManualLinkSection();

        if (mismatch) {
            if (confirm("¿Añadir una observación a los registros de Money Manager implicados con el detalle de qué movimientos del banco representa esta suma?")) {
                const results = await appendNoteToMmRecords(mmIds, note);
                const failed = results.filter(r => !r.ok);
                if (failed.length > 0) {
                    alert(`Enlace confirmado. No se pudo añadir la observación a ${failed.length} de ${mmIds.length} registro(s): ` + failed.map(f => f.reason).join(' / '));
                } else {
                    alert("Enlace manual confirmado y observación añadida a Money Manager.");
                }
                await fetchTransactions();
            } else {
                alert("Enlace manual confirmado -- vinculado localmente, no se ha escrito nada en Money Manager.");
            }
        } else {
            alert("Enlace manual confirmado -- vinculado localmente, no se ha escrito nada en Money Manager.");
        }
    } catch (e) {
        alert("Error crítico confirmando el enlace: " + e.message);
    }
}

// Propuesta #14 (BACKLOG.md): deshace la última conciliación confirmada, sea por "Confirmar Este"
// (confirmMatch()) o por el modo de enlace manual (confirmManualLink()) -- ambas escriben en el
// mismo almacén (`data/reconciliations.json`), así que un único mecanismo de deshacer sirve para
// las dos. Pide siempre confirmación mostrando fecha/importe/descripción de lo que se va a
// deshacer (vía GET /api/reconciliations/last, la fuente de verdad del backend -- no se fía de
// `lastConfirmedAction`, que solo existe si la confirmación se hizo EN ESTA SESIÓN) antes de
// llamar a POST /api/reconciliations/undo. NUNCA toca Money Manager: el vínculo era solo local.
async function undoLastReconciliation() {
    let last;
    try {
        const resp = await fetch('/api/reconciliations/last');
        const data = await resp.json();
        if (!resp.ok || data.error) {
            alert("Error consultando la última conciliación: " + (data.error || resp.status));
            return;
        }
        last = data.last;
    } catch (e) {
        alert("Error crítico consultando la última conciliación: " + e.message);
        return;
    }

    if (!last) {
        alert("No hay ninguna conciliación confirmada que deshacer.");
        return;
    }

    // Propuesta #16: /api/reconciliations/last unificó su contrato a listas (`bank_lines`,
    // `mm_ids`) para cubrir tanto un enlace 1:1 de toda la vida como un grupo N:M -- se listan
    // todas las líneas de banco implicadas, no solo la primera. Entradas guardadas antes de que
    // confirm() empezara a persistir date/amount/description (ver reconciliation_store.py) llegan
    // aquí como bank_lines con esos campos a null -- se degradan a mostrar los mm_ids en vez de
    // fallar.
    const bankLines = last.bank_lines || [];
    const validLines = bankLines.filter(l => l.date && l.amount !== undefined && l.amount !== null && l.description);
    const desc = validLines.length === bankLines.length && validLines.length > 0
        ? validLines.map(l => `${l.date} · ${formatCurrency(l.amount)} · ${l.description}`).join('\n')
        : `${bankLines.length} línea(s) de banco vinculada(s) a Money Manager (${(last.mm_ids || []).join(', ')})`;
    const groupNote = bankLines.length > 1 || (last.mm_ids || []).length > 1
        ? `\n\n(Enlace N:M -- ${bankLines.length} línea(s) de banco y ${(last.mm_ids || []).length} registro(s) de Money Manager, se deshace todo junto).`
        : '';
    if (!confirm(`¿Deshacer la conciliación de:\n\n${desc}${groupNote}\n\nVolverá a aparecer como pendiente (el movimiento del banco como "Nuevo"/con dudas; si estaba enlazado a un huérfano de Money Manager, ese huérfano reaparecerá al volver a analizar el fichero).`)) {
        return;
    }

    try {
        const resp = await fetch('/api/reconciliations/undo', { method: 'POST' });
        const data = await resp.json();
        if (!resp.ok || data.error) {
            alert("Error al deshacer: " + (data.error || resp.status));
            return;
        }

        // Reversión instantánea y precisa solo si la propia acción se confirmó en esta sesión
        // (lastConfirmedAction) Y coincide con lo que el backend acaba de deshacer (mismo
        // conjunto de `keys` -- podría no coincidir si el usuario deshizo algo confirmado en otra
        // sesión/pestaña). Si no coincide, degradar a pedir un re-análisis en vez de arriesgarse a
        // reconstruir un estado que no se conoce con certeza (candidatos originales, etc.).
        const removedKeys = (data.removed || []).map(e => e.key).slice().sort();
        const localKeys = (lastConfirmedAction ? lastConfirmedAction.keys : []).slice().sort();
        const sameGroup = lastConfirmedAction && removedKeys.length === localKeys.length &&
            removedKeys.every((k, i) => k === localKeys[i]);

        if (sameGroup) {
            lastConfirmedAction.bankChanges.forEach(({ sourceId, previousState }) => {
                const proposal = lastProposals.find(p => p.source_id === sourceId);
                if (proposal) Object.assign(proposal, previousState);
            });
            if (lastConfirmedAction.orphansRemoved.length > 0) {
                lastOrphans = [...(lastOrphans || []), ...lastConfirmedAction.orphansRemoved];
            }
            lastConfirmedAction = null;
            renderProposalsList();
            renderMmOrphansList();
            renderReconciliationSummary();
            renderManualLinkSection();
            alert("Conciliación deshecha.");
        } else {
            alert("Conciliación deshecha. Vuelve a analizar el fichero para verlo reflejado como pendiente.");
        }
    } catch (e) {
        alert("Error crítico deshaciendo la conciliación: " + e.message);
    }
}

function updateUI() {
    renderAccountList();
    if (currentTab === 'dashboard') renderChart();
    if (currentTab === 'transactions') renderTransactions();
    if (currentTab === 'budgets') renderBudgets();
    updateSummaries();
}

async function loadAppVersion() {
    try {
        const resp = await fetch('/api/version');
        const data = await resp.json();
        const el = document.getElementById('appVersion');
        if (el) el.textContent = `v${data.version}`;
    } catch { /* footer opcional, no bloquea la app si falla */ }
}

// --- AVISO DE NOVEDADES TRAS AUTO-ACTUALIZAR (ver CLAUDE.md) ---
function renderNovedadesEntry(entry) {
    const items = (entry.summary || []).map(line => `<li>${line}</li>`).join('');
    return `
        <div class="novedad-entry">
            <div class="novedad-version">Versión ${entry.version} <span class="novedad-date">(${entry.date})</span></div>
            <ul>${items || '<li>Sin detalle.</li>'}</ul>
        </div>
    `;
}

function showNovedadesModal(entries, isFullHistory) {
    const modal = document.getElementById('novedadesModal');
    const title = document.getElementById('novedadesTitle');
    const body = document.getElementById('novedadesBody');
    if (!modal || !body) return;

    title.textContent = isFullHistory ? 'Histórico de novedades' : '🎉 Se ha actualizado la aplicación';
    body.innerHTML = entries.length
        ? entries.map(renderNovedadesEntry).join('')
        : '<p style="color:var(--text-muted)">Sin novedades registradas todavía.</p>';
    modal.style.display = 'flex';
}

function closeNovedadesModal() {
    const modal = document.getElementById('novedadesModal');
    if (modal) modal.style.display = 'none';
}

// Se llama una vez al arrancar. Si hay versiones más nuevas que la última que el usuario vio,
// muestra el aviso automático y marca la versión actual como vista de inmediato (no al cerrar el
// aviso) -- si el usuario lo cierra sin leerlo entero, "Ver novedades" en el footer sigue dando
// acceso al histórico completo en cualquier momento.
async function checkNovedades() {
    try {
        const resp = await fetch('/api/novedades');
        const data = await resp.json();
        if (data && Array.isArray(data.new_entries) && data.new_entries.length > 0) {
            showNovedadesModal(data.new_entries, false);
            fetch('/api/novedades/mark-seen', { method: 'POST' }).catch(() => {});
        }
    } catch { /* no bloquea el arranque si falla */ }
}

async function showFullNovedades() {
    try {
        const resp = await fetch('/api/novedades');
        const data = await resp.json();
        showNovedadesModal(data.entries || [], true);
    } catch (e) {
        alert('No se pudo cargar el histórico de novedades: ' + e.message);
    }
}

// --- BUSCADOR "CTRL+F" EN TODA LA PANTALLA ---
// Intercepta Ctrl+F/Cmd+F dentro de la ventana de la app (preventDefault) y abre una barra de
// búsqueda propia, en vez de dejar que el navegador/WebView abra el suyo -- en el .exe la app
// corre dentro de una ventana pywebview sin barra de direcciones, donde el buscador nativo del
// navegador puede ni estar accesible. Filtra por substring (sin distinguir mayúsculas/tildes)
// contra el texto visible de la vista activa (Transacciones, Conciliación, Presupuestos),
// ocultando lo que no coincide en vez de solo resaltarlo. Independiente del filtro de texto que
// ya existía en Transacciones (#filterSearch, que solo busca por columnas concretas de esa
// tabla) -- este buscador es genérico y funciona igual en cualquier pestaña con una lista.
let inPageSearchQuery = '';
// Propuesta #17 (BACKLOG.md): navegación entre coincidencias, no solo ocultar lo que no coincide.
// inPageSearchMatches son los elementos que coinciden AHORA MISMO, en el mismo orden en que
// getInPageSearchItems() los devuelve (orden del DOM); inPageSearchActiveIndex es la posición
// dentro de ese array que está "activa" (resaltada + con scroll hecho hasta ella).
let inPageSearchMatches = [];
let inPageSearchActiveIndex = -1;

// El rango de la clase de caracteres es el bloque Unicode "Combining Diacritical Marks"
// (U+0300-U+036F) escrito literalmente -- tras normalize('NFD') una tilde queda como su letra
// base más uno de estos caracteres sueltos, así que quitarlos deja el texto sin acentos.
function normalizeForSearch(str) {
    return (str || '').toString().normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// Granularidad de "un resultado" según la pestaña activa: fila de tabla en Transacciones,
// tarjeta de propuesta/huérfano en Conciliación, nodo de categoría en Presupuestos. En
// Dashboard/Ajustes no hay una lista que filtrar -- la barra se puede abrir igual, pero no oculta
// nada (lista vacía).
function getInPageSearchItems() {
    switch (currentTab) {
        case 'transactions': return Array.from(document.querySelectorAll('#transBody > tr'));
        case 'conciliation': return Array.from(document.querySelectorAll('#proposalsList > .proposal-card, #mmOrphansList > .proposal-card'));
        case 'budgets': return Array.from(document.querySelectorAll('#budgetTree > .tree-node'));
        default: return [];
    }
}

function updateInPageSearchCount() {
    const el = document.getElementById('inPageSearchCount');
    if (!el) return;
    if (!inPageSearchQuery) { el.textContent = ''; return; }
    const total = inPageSearchMatches.length;
    el.textContent = total > 0 ? `${inPageSearchActiveIndex + 1} / ${total}` : 'Sin resultados aquí';
}

// Quita el resaltado de "coincidencia activa" de todas y lo pone en la de inPageSearchActiveIndex
// -- distinto de .search-hidden (oculta lo que NO coincide): esto distingue, DENTRO de lo ya
// visible, cuál de las posiblemente muchas coincidencias es la que está "seleccionada" ahora
// mismo, y hace scroll hasta ella si `scroll` es true. Estar oculto (search-hidden) no implica
// estar ya visible en pantalla si hay más coincidencias de las que caben en el viewport.
function focusActiveMatch(scroll) {
    inPageSearchMatches.forEach(el => el.classList.remove('search-active-match'));
    if (inPageSearchActiveIndex >= 0 && inPageSearchMatches[inPageSearchActiveIndex]) {
        const el = inPageSearchMatches[inPageSearchActiveIndex];
        el.classList.add('search-active-match');
        if (scroll) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    updateInPageSearchCount();
}

// resetActive=true (por defecto): nueva búsqueda o texto cambiado -- salta a la primera
// coincidencia. resetActive=false: reaplicación tras un re-render con la MISMA búsqueda todavía
// activa (reapplyInPageSearch()) -- los nodos del DOM son nuevos (innerHTML los reconstruyó), así
// que no se puede seguir "el mismo elemento"; se mantiene la misma POSICIÓN dentro de la lista de
// coincidencias en vez de saltar a la primera, para no deshacer la navegación manual del usuario
// por un refresco de datos de fondo. scroll=false evita un scroll brusco no solicitado por el
// usuario en ese caso.
function applyInPageSearch(resetActive, scroll) {
    if (resetActive === undefined) resetActive = true;
    if (scroll === undefined) scroll = true;

    const items = getInPageSearchItems();
    if (!inPageSearchQuery) {
        items.forEach(el => { el.classList.remove('search-hidden'); el.classList.remove('search-active-match'); });
        inPageSearchMatches = [];
        inPageSearchActiveIndex = -1;
        updateInPageSearchCount();
        return;
    }

    const q = normalizeForSearch(inPageSearchQuery);
    inPageSearchMatches = [];
    items.forEach(el => {
        const isMatch = normalizeForSearch(el.textContent).includes(q);
        el.classList.toggle('search-hidden', !isMatch);
        el.classList.remove('search-active-match');
        if (isMatch) inPageSearchMatches.push(el);
    });

    if (resetActive || inPageSearchActiveIndex < 0) {
        inPageSearchActiveIndex = inPageSearchMatches.length > 0 ? 0 : -1;
    } else {
        inPageSearchActiveIndex = Math.min(inPageSearchActiveIndex, inPageSearchMatches.length - 1);
    }
    focusActiveMatch(scroll);
}

function goToNextMatch() {
    if (inPageSearchMatches.length === 0) return;
    inPageSearchActiveIndex = (inPageSearchActiveIndex + 1) % inPageSearchMatches.length;
    focusActiveMatch(true);
}

function goToPrevMatch() {
    if (inPageSearchMatches.length === 0) return;
    inPageSearchActiveIndex = (inPageSearchActiveIndex - 1 + inPageSearchMatches.length) % inPageSearchMatches.length;
    focusActiveMatch(true);
}

// Enter = siguiente, Shift+Enter = anterior -- comportamiento estándar de Ctrl+F en navegadores.
// Atado al keydown del propio #inPageSearchInput (no al listener global de document), para no
// interferir con Enter en cualquier otro campo de la app.
function handleInPageSearchKeydown(e) {
    if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) goToPrevMatch(); else goToNextMatch();
    }
}

// Los render*() de listas reconstruyen su contenido con innerHTML, perdiendo cualquier clase
// search-hidden/search-active-match ya aplicada -- se llama al final de cada uno de ellos
// (renderTransactions(), renderProposalsList(), renderMmOrphansList(), renderBudgets()) para que
// la búsqueda activa sobreviva a un refresco de datos o a un cambio de filtro/etiqueta. No-op si
// no hay búsqueda activa. resetActive=false/scroll=false: ver applyInPageSearch().
function reapplyInPageSearch() {
    if (inPageSearchQuery) applyInPageSearch(false, false);
}

function openInPageSearch() {
    const bar = document.getElementById('inPageSearchBar');
    if (!bar) return;
    bar.style.display = 'flex';
    const input = document.getElementById('inPageSearchInput');
    input.value = inPageSearchQuery;
    input.focus();
    input.select();
    applyInPageSearch();
}

function closeInPageSearch() {
    const bar = document.getElementById('inPageSearchBar');
    if (bar) bar.style.display = 'none';
    inPageSearchQuery = '';
    inPageSearchMatches = [];
    inPageSearchActiveIndex = -1;
    const input = document.getElementById('inPageSearchInput');
    if (input) input.value = '';
    // Limpia también los ítems de otras pestañas por si se dejaron ocultos al cambiar de pestaña
    // con la búsqueda todavía activa.
    document.querySelectorAll('.search-hidden').forEach(el => el.classList.remove('search-hidden'));
    document.querySelectorAll('.search-active-match').forEach(el => el.classList.remove('search-active-match'));
}

function handleInPageSearchInput(value) {
    inPageSearchQuery = value;
    applyInPageSearch(true, true);
}

document.addEventListener('keydown', (e) => {
    const key = (e.key || '').toLowerCase();
    if ((e.ctrlKey || e.metaKey) && key === 'f') {
        e.preventDefault();
        openInPageSearch();
        return;
    }
    if (key === 'escape') {
        const bar = document.getElementById('inPageSearchBar');
        if (bar && bar.style.display !== 'none') closeInPageSearch();
    }
});

document.addEventListener('DOMContentLoaded', () => {
    loadData();
    loadAppVersion();
    checkNovedades();
    const saveBtn = document.querySelector('#settingsTab button');
    if (saveBtn) saveBtn.onclick = saveIPConfig;
});
