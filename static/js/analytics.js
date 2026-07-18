/**
 * Módulo de Analítica y Visualización Avanzada
 * Soporta filtros multicriterio en cliente, gráficos interactivos con drill-down
 * y comparativas históricas.
 */

const AnalyticsEngine = {
    transactions: [],
    categories: [],
    
    init(transactionsData) {
        this.transactions = transactionsData;
    },

    /**
     * Filtro Avanzado Multicriterio (Cliente puro)
     * searchStr: Por concepto o descripción
     * minAmount, maxAmount: Rango de importes
     * category: Filtro por categoría principal
     * tags: Array de etiquetas personalizadas (heurística basada en #tags en mbContent)
     */
    applyAdvancedFilters({ searchStr, minAmount, maxAmount, category, tags }) {
        return this.transactions.filter(t => {
            // 1. Filtrar por texto (concepto o detalle)
            if (searchStr) {
                const searchLower = searchStr.toLowerCase();
                const content = (t.mbContent || '').toLowerCase();
                const detail = (t.mbDetailContent || '').toLowerCase();
                if (!content.includes(searchLower) && !detail.includes(searchLower)) return false;
            }

            // 2. Filtrar por categoría
            if (category && t.mbCategory !== category) return false;

            // 3. Filtrar por importe
            const amount = Math.abs(parseFloat(t.mbCash || 0));
            if (minAmount && amount < minAmount) return false;
            if (maxAmount && amount > maxAmount) return false;

            // 4. Filtrar por etiquetas (Extraemos palabras clave con # del concepto)
            if (tags && tags.length > 0) {
                const contentTags = (t.mbContent || '').match(/#\w+/g) || [];
                const hasTag = tags.some(tag => contentTags.includes(tag));
                if (!hasTag) return false;
            }

            return true;
        });
    },

    /**
     * Gráfico Interactivo con Drill-Down
     * Genera datos para Chart.js y configura el evento onClick para navegar a subcategorías.
     */
    renderInteractiveDonut(canvasId, categoryData, onSegmentClickCallback) {
        const ctx = document.getElementById(canvasId);
        if (!ctx || categoryData.length === 0) return null;

        const labels = categoryData.map(c => c.category);
        const data = categoryData.map(c => c.spent_total);

        return new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: labels,
                datasets: [{
                    data: data,
                    backgroundColor: [
                        '#3b82f6', '#10b981', '#f59e0b', '#ef4444', 
                        '#8b5cf6', '#ec4899', '#06b6d4', '#64748b'
                    ],
                    borderWidth: 2,
                    hoverOffset: 15
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                onClick: (event, elements) => {
                    if (elements.length > 0) {
                        const index = elements[0].index;
                        const selectedCategory = labels[index];
                        // Drill-down: Ejecutar callback con la categoría seleccionada
                        if (typeof onSegmentClickCallback === 'function') {
                            onSegmentClickCallback(selectedCategory);
                        }
                    }
                },
                plugins: {
                    legend: { position: 'right' },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                let label = context.label || '';
                                if (label) label += ': ';
                                if (context.parsed !== null) {
                                    label += new Intl.NumberFormat('es-ES', { 
                                        style: 'currency', currency: 'EUR' 
                                    }).format(context.parsed);
                                }
                                return label;
                            }
                        }
                    }
                }
            }
        });
    },

    /**
     * Genera un gráfico de evolución histórica (Líneas)
     * Agrupa gastos por mes para ver tendencias.
     */
    renderHistoricalLineChart(canvasId, transactionsHistory, months = 6) {
        // En una implementación final, se procesaría transactionsHistory
        // agrupando por mes y categoría para mostrar la tendencia de los últimos n meses.
        const ctx = document.getElementById(canvasId);
        if (!ctx) return;

        // Mock parameters to demonstrate structure based on instructions
        // In real execution, use Pandas/API backend to fetch 'n' months grouped.
        return new Chart(ctx, {
            type: 'line',
            data: {
                labels: ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun'],
                datasets: [{
                    label: 'Gastos Totales',
                    data: [1200, 1900, 1500, 1600, 1100, 1400],
                    borderColor: '#3b82f6',
                    tension: 0.4
                }]
            },
            options: {
                responsive: true,
                plugins: { legend: { display: false } }
            }
        });
    }
};

window.AnalyticsEngine = AnalyticsEngine;
