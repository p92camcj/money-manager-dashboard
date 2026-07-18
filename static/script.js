// Variables globales y estado
let assetsData = [];
let transactionsData = [];
let budgetsData = []; // Ahora es el array hierarchy
let currentTab = 'dashboard';
let chartInstance = null;
let currentFilter = { category: null, subCategory: null, searchStr: null, minAmount: null, maxAmount: null, tags: null };
let currentPeriod = { startDate: '', endDate: '', label: '' };
let lastProposals = []; // última tanda de propuestas de conciliación, para que confirmMatch() encuentre fecha/importe/descripción por source_id
let pendingFiles = []; // ficheros seleccionados pendientes de etiquetar/confirmar antes de subir
let currentLabelFilter = 'all'; // etiqueta de origen seleccionada en el filtro de propuestas

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
    
    if (window.AnalyticsEngine) AnalyticsEngine.init(transactionsData);
    
    updateUI();
    updateConnectionStatus('connecting');
    
    Promise.allSettled([
        fetchAssets(),
        fetchTransactions(),
        fetchBudgets(),
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

async function fetchAssets() {
    try {
        const resp = await fetch('/api/proxy/moneyBook/getAssetData', { method: 'GET' });
        const data = await resp.json();
        if (data && !data.error) {
            assetsData = data;
            setCache('assets', data);
            renderAccountList();
            return true;
        }
    } catch (e) { return false; }
}

async function fetchTransactions() {
    try {
        const resp = await fetch(`/api/proxy/moneyBook/getDataByPeriod?startDate=${currentPeriod.startDate}&endDate=${currentPeriod.endDate}`);
        const data = await resp.json();
        if (Array.isArray(data)) {
            transactionsData = data;
            setCache('transactions', data);
            if (window.AnalyticsEngine) AnalyticsEngine.init(transactionsData);
            if (currentTab === 'transactions') renderTransactions();
            updateSummaries();
            return true;
        }
    } catch { return false; }
}

async function fetchBudgets() {
    try {
        const resp = await fetch(`/api/budget-hierarchy?startDate=${currentPeriod.startDate}&endDate=${currentPeriod.endDate}`);
        const data = await resp.json();
        if (data && data.hierarchy) {
            budgetsData = data.hierarchy;
            setCache('budgets', data.hierarchy);
            if (currentTab === 'budgets') renderBudgets();
            if (currentTab === 'dashboard') renderChart();
            return true;
        }
    } catch { return false; }
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
}

function toggleNode(idx) { document.getElementById(`node-${idx}`).classList.toggle('expanded'); }
function expandAllBudgets() { document.querySelectorAll('.tree-node').forEach(n => n.classList.add('expanded')); }

// --- ORDENACIÓN Y TABLAS ---
let sortState = { column: -1, ascending: true };
let currentEditingId = null;

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
        const isInc = t.inOutType === 'Ingreso';
        const isTrans = t.inOutType === 'Transferencia';
        let amountText = formatCurrency(t.mbCash);
        let amountClass = isTrans ? 'text-muted' : (isInc ? 'income-text' : 'outcome-text');
        
        // Manejar separación de hora si mbDate contiene espacio (ej: "2026-03-27 10:30")
        let dateObj = t.mbDate ? t.mbDate.split(' ') : [''];
        let datePart = dateObj[0];
        let timePart = dateObj[1] || '';

        // Recuperar nombre de cuenta real cruzando assetId con la lista de activos
        let accountName = getAssetName(t.assetId, t.assetName);

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>
                <div>${datePart}</div>
                ${timePart ? `<div style="font-size:0.7rem; color:var(--text-muted)">🕒 ${timePart}</div>` : ''}
            </td>
            <td><span class="badge category-badge" onclick="applyFilter('${t.mbCategory}', null)" title="${t.mbCategory}">${t.mbCategory}</span></td>
            <td><span class="badge subcategory-badge" onclick="applyFilter('${t.mbCategory}', '${t.subCategory}')" title="${t.subCategory || '-'}">${t.subCategory || '-'}</span></td>
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
    document.getElementById('editModal').style.display = 'none'; 
}

window.onclick = function(event) {
    const modal = document.getElementById('editModal');
    if (event.target == modal) {
        closeModal();
    }
}

async function editTransaction(tId) {
    let t = transactionsData.find(x => String(x.id) === String(tId));
    if (!t) return;
    
    let datePart = '', timePart = '12:00';
    if(t.mbDate) {
        let parts = t.mbDate.includes('T') ? t.mbDate.split('T') : t.mbDate.split(' ');
        datePart = parts[0];
        if (parts.length > 1) {
            timePart = parts[1].substring(0,5);
        }
    }
    
    openEditModal(tId);
    
    document.getElementById('editType').value = t.inOutType === 'Gasto' || t.inOutType === 'Egreso' ? 'Gasto' : 
                                               (t.inOutType === 'Transfer' || t.inOutType === 'Transferencia' ? 'Transferencia' : 'Ingreso');
    
    updateModalCategories();
    
    if (datePart) document.getElementById('editDate').value = datePart;
    document.getElementById('editTime').value = timePart;
    
    document.getElementById('editAmount').value = Math.abs(t.mbCash || 0.0);
    document.getElementById('editContent').value = t.mbContent || '';
    if (document.getElementById('editDetailContent')) {
        document.getElementById('editDetailContent').value = t.mbDetailContent || '';
    }
    
    if (t.assetId) document.getElementById('editAccount').value = t.assetId;
    
    if (t.mbCategory) document.getElementById('editCategory').value = t.mbCategory;
    if (t.subCategory) document.getElementById('editSubCategory').value = t.subCategory;
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
    // Forzamos la decodificación tipo application/x-www-form-urlencoded para el API heredada
    const payload = new URLSearchParams();
    const typeStr = document.getElementById('editType').value;
    
    let inOutTypeMap = {'Gasto': 'Egreso', 'Ingreso': 'Ingreso', 'Transferencia': 'Transfer'};
    let inOutCodeMap = {'Gasto': '1', 'Ingreso': '2', 'Transferencia': '3'};
    
    payload.append('inOutType', inOutTypeMap[typeStr] || typeStr);
    payload.append('inOutCode', inOutCodeMap[typeStr] || '1');
    payload.append('mbDate', `${document.getElementById('editDate').value} ${document.getElementById('editTime').value}:00`);
    payload.append('mbContent', document.getElementById('editContent').value);
    
    const dContent = document.getElementById('editDetailContent') ? document.getElementById('editDetailContent').value : '';
    if (dContent) payload.append('mbDetailContent', dContent);
    
    payload.append('mbCash', document.getElementById('editAmount').value);
    
    let accountId = document.getElementById('editAccount').value;
    payload.append('assetId', accountId);
    payload.append('payType', getAssetName(accountId, ''));
    
    if (typeStr === 'Transferencia') {
        payload.append('targetAssetId', document.getElementById('editTargetAccount').value);
    } else {
    const cat = document.getElementById('editCategory').value;
        const sub = document.getElementById('editSubCategory').value;
        console.log('[DIAG] submitTransaction: cat=', cat, 'sub=', sub);
        if (cat) payload.append('mbCategory', cat);
        if (sub) payload.append('subCategory', sub);
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
            closeModal();
            // Refrescar en silencio los datos de sqlite
            await fetchTransactions(); 
            
            // Si es edición usamos el ID, si es nueva buscamos el max ID
            let targetId = currentEditingId;
            if (!targetId && transactionsData.length > 0) {
                targetId = Math.max(...transactionsData.map(t => parseInt(t.id || 0)));
            }
            // Enseñar en pantalla aislada la transacción
            if (targetId) {
                showTransaction(targetId);
            } else {
                renderTransactions();
            }
            alert(currentEditingId ? "Transacción modificada." : "Transacción añadida exitosamente.");
        } else {
            alert("Error al guardar: " + resp.status + " | " + text);
        }
    } catch(e) {
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
    pendingFiles = files.map(file => ({ file, label: defaultLabelFor(file.name) }));
    renderFileLabelsList();
}

function updatePendingLabel(idx, value) {
    pendingFiles[idx].label = value.trim() || defaultLabelFor(pendingFiles[idx].file.name);
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
        </div>
    `).join('');
    container.innerHTML = `
        <h3>Ficheros seleccionados (${pendingFiles.length})</h3>
        <p style="color:var(--text-muted); font-size:0.85rem; margin:5px 0 15px;">Ponle una etiqueta corta a cada uno (p.ej. "Revolut", "Cuenta Sabadell") para distinguirlos en la lista de propuestas.</p>
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
        });
        formData.append('windowDays', 3);

        document.getElementById('fileLabelsList').style.display = 'none';
        list.innerHTML = `<p>Analizando ${pendingFiles.length} fichero(s)... Por favor espera.</p>`;

        const res = await fetch('/api/analyze-excel', { method: 'POST', body: formData });
        const data = await res.json();

        if (!data || data.error) {
            list.innerHTML = `<p style="color:#f87171">Error al analizar: ${data ? data.error : 'Desconocido'}</p>`;
            return;
        }

        lastProposals = data.proposals || [];
        currentLabelFilter = 'all';

        if (data.file_errors && data.file_errors.length > 0) {
            const detalle = data.file_errors.map(fe => `${fe.filename} (${fe.label}): ${fe.error}`).join('\n');
            alert(`Algunos ficheros no se pudieron leer:\n\n${detalle}`);
        }

        updateLabelFilterBar();
        renderProposalsList();
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
    const labels = [...new Set(lastProposals.map(p => p.source_label))];

    if (labels.length <= 1) {
        bar.style.display = 'none';
        bar.innerHTML = '';
        currentLabelFilter = 'all';
        return;
    }

    bar.style.display = 'flex';
    const countAll = lastProposals.length;
    const options = labels.map(l => {
        const count = lastProposals.filter(p => p.source_label === l).length;
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
    ).slice().sort((a, b) => new Date(b.date) - new Date(a.date));

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
            candidatesHtml = `<div style="margin-top:10px;"><button class="btn-secondary btn-sm" onclick="showTransaction('${p.suggested_mm_ref}')">👁 Ver Registro Asociado</button></div>`;
        } else if (p.status === 'suggested_match' || p.status === 'probable_match') {
            candidatesHtml = `<div style="margin-top:10px;"><strong>Posibles Asociados en MoneyManager:</strong><ul style="list-style:none; padding-left:0; margin-top:5px;">`;
            (p.candidates || []).forEach(cand => {
                candidatesHtml += `<li style="font-size:0.85rem; padding:5px; background:rgba(255,255,255,0.05); margin-bottom:5px; border-radius:4px; display:flex; justify-content:space-between; align-items:center;">
                                   <div>${cand.date} | <strong>${formatCurrency(cand.amount)}</strong> | ${cand.description.substring(0,25)}... | <em>${cand.asset}</em></div>
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

        card.className = `card glass proposal-card ${isDuplicate ? 'duplicate' : 'new'}`;
        card.innerHTML = `
            <div class="proposal-header">
                <strong>${p.date}</strong>
                <span style="display:flex; gap:6px;">
                    <span class="badge badge-info" title="${p.source_filename || ''}">${p.source_label || ''}</span>
                    <span class="badge ${badgeColor}">${badgeText}</span>
                </span>
            </div>
            <p>${p.description}</p>
            <p class="amount ${p.amount < 0 ? 'outcome-text' : 'income-text'}">${formatCurrency(p.amount)}</p>
            ${candidatesHtml}
        `;
        list.appendChild(card);
    });
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

async function confirmMatch(sourceId, candId) {
    // Capturar referencias antes del await: el objeto global `event` no sobrevive de forma fiable tras un await
    const card = event.target.closest('.proposal-card');
    const list = event.target.closest('ul');

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
        // Match enlazado localmente (NUNCA se escribe en el móvil). Ocultar visualmente.
        if (card) card.style.opacity = '0.4';
        if (list) list.style.display = 'none';
    } catch (e) {
        alert("Error crítico confirmando match: " + e.message);
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

document.addEventListener('DOMContentLoaded', () => {
    loadData();
    loadAppVersion();
    const saveBtn = document.querySelector('#settingsTab button');
    if (saveBtn) saveBtn.onclick = saveIPConfig;
});
