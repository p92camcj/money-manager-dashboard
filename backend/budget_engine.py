from collections import defaultdict

class BudgetEngine:
    """Motor de cálculo de presupuestos jerárquicos y categorización."""

    def __init__(self, base_currency='EUR', exchange_rates=None):
        self.base_currency = base_currency
        self.exchange_rates = exchange_rates or {'EUR': 1.0}

    def convert_amount(self, amount, currency):
        """Soporte multidivisa simple"""
        if currency == self.base_currency:
            return amount
        rate = self.exchange_rates.get(currency, 1.0)
        return amount / rate

    def process_hierarchy(self, transactions, budgets):
        """
        Construye el árbol jerárquico comparando presupuesto vs. transacciones reales.
        - transactions: Lista de diccionarios de transacciones
        - budgets: Datos del presupuesto desde la API de Money Manager
        """
        hierarchy = {}

        def init_cat(name):
            if name not in hierarchy:
                hierarchy[name] = {'budgeted': 0.0, 'spent_total': 0.0, 'subcategories': {}}

        def init_sub(cat, sub):
            init_cat(cat)
            if sub not in hierarchy[cat]['subcategories']:
                hierarchy[cat]['subcategories'][sub] = {'spent': 0.0, 'budgeted': 0.0}

        # 1. Cargar la estructura de presupuesto REAL (incluyendo subcategorías)
        if budgets and 'outcome' in budgets:
            for b in budgets['outcome']:
                cat_name = b.get('mcname', 'Desconocido')
                init_cat(cat_name)
                hierarchy[cat_name]['budgeted'] = float(b.get('budget', 0.0))
                
                # Cargar presupuestos de subcategorías si existen
                for child in b.get('childMclist', []):
                    sub_name = child.get('mcname', 'General')
                    init_sub(cat_name, sub_name)
                    hierarchy[cat_name]['subcategories'][sub_name]['budgeted'] = float(child.get('budget', 0.0))


        # 2. Agregar el gasto de las transacciones
        for t in transactions:
            # Transferencias no afectan el presupuesto (ignoramos inOutType = Transferencia)
            in_out_type = t.get('inOutType', '')
            if in_out_type != 'Gasto':
                continue

            cat_name = t.get('mbCategory', 'Sin Categoría')
            sub_name = t.get('subCategory', 'General')
            
            amount = float(t.get('mbCash', 0.0))
            currency = t.get('currency', self.base_currency) # Assuming currency field exists
            
            normalized_amount = self.convert_amount(amount, currency)

            init_sub(cat_name, sub_name)

            # Sumar al total de la categoría y al desglose por subcategoría
            hierarchy[cat_name]['spent_total'] += normalized_amount
            hierarchy[cat_name]['subcategories'][sub_name]['spent'] += normalized_amount

        # 3. Formatear salida para el Frontend
        result = []
        for cat, data in hierarchy.items():
            subs = []
            for sub_name, sub_data in data['subcategories'].items():
                sub_budget = sub_data.get('budgeted', 0.0)
                subs.append({
                    'name': sub_name,
                    'spent': sub_data['spent'],
                    'budgeted': sub_budget,
                    'performance_pct': (sub_data['spent'] / sub_budget) * 100 if sub_budget > 0 else 0
                })
            
            result.append({
                'category': cat,
                'budgeted': data['budgeted'],
                'spent_total': data['spent_total'],
                'performance_pct': (data['spent_total'] / data['budgeted']) * 100 if data['budgeted'] > 0 else 0,
                'subcategories': subs
            })

        # Ordenar: primero categorías con presupuesto > 0 (incluyendo sin gastos), luego por gasto desc
        return sorted(result, key=lambda x: (x['budgeted'] > 0 or x['spent_total'] > 0, x['budgeted'], x['spent_total']), reverse=True)

    def calculate_transfers_and_balances(self, transactions):
        """Identifica transferencias entre cuentas y calcula flujos de caja limpios."""
        flows = {'income': 0.0, 'expense': 0.0, 'transfers': 0.0}
        
        for t in transactions:
            amount = float(t.get('mbCash', 0.0))
            type_ = t.get('inOutType', '')
            
            if type_ == 'Ingreso':
                flows['income'] += amount
            elif type_ == 'Gasto':
                flows['expense'] += amount
            elif type_ == 'Transferencia':
                # Las transferencias mueven dinero entre cuentas, no alteran patrimonio neto
                flows['transfers'] += amount
                
        flows['net_cashflow'] = flows['income'] - flows['expense']
        return flows
