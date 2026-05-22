//! Business metrics and KPIs for Riverside OS

use crate::metrics::MetricRegistry;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use std::collections::HashMap;
use chrono::{Utc, Duration as ChronoDuration};
use rust_decimal::Decimal;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BusinessMetrics {
    pub sales_metrics: SalesMetrics,
    pub customer_metrics: CustomerMetrics,
    pub inventory_metrics: InventoryMetrics,
    pub order_metrics: OrderMetrics,
    pub financial_metrics: FinancialMetrics,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SalesMetrics {
    pub total_revenue_today: Decimal,
    pub total_transactions_today: u64,
    pub average_transaction_value: Decimal,
    pub revenue_by_hour: HashMap<String, Decimal>,
    pub top_selling_products: Vec<ProductSales>,
    pub sales_by_category: HashMap<String, Decimal>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProductSales {
    pub product_id: uuid::Uuid,
    pub product_name: String,
    pub quantity_sold: u32,
    pub revenue: Decimal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomerMetrics {
    pub new_customers_today: u64,
    pub active_customers_today: u64,
    pub customer_retention_rate: f64,
    pub average_customer_lifetime_value: Decimal,
    pub customers_by_segment: HashMap<String, u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InventoryMetrics {
    pub total_inventory_value: Decimal,
    pub low_stock_products: u64,
    pub out_of_stock_products: u64,
    pub inventory_turnover_rate: f64,
    pub days_of_inventory: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderMetrics {
    pub orders_today: u64,
    pub orders_fulfilled_today: u64,
    pub fulfillment_rate: f64,
    pub average_fulfillment_time: ChronoDuration,
    pub orders_by_status: HashMap<String, u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FinancialMetrics {
    pub gross_profit_today: Decimal,
    pub gross_profit_margin: f64,
    pub daily_expenses: Decimal,
    pub net_profit_today: Decimal,
    pub accounts_receivable: Decimal,
    pub cash_flow_today: Decimal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum BusinessKpi {
    RevenueGrowthRate { period: String, rate: f64 },
    CustomerAcquisitionCost { cost: Decimal },
    CustomerLifetimeValue { value: Decimal },
    InventoryTurnover { ratio: f64 },
    GrossMargin { percentage: f64 },
    NetPromoterScore { score: f64 },
    OrderFulfillmentRate { rate: f64 },
    AverageOrderValue { value: Decimal },
}

impl BusinessMetrics {
    pub async fn collect(pool: &PgPool, registry: &mut MetricRegistry) -> Result<Self, sqlx::Error> {
        let start_time = std::time::Instant::now();

        // Collect sales metrics
        let sales_metrics = Self::collect_sales_metrics(pool).await?;

        // Collect customer metrics
        let customer_metrics = Self::collect_customer_metrics(pool).await?;

        // Collect inventory metrics
        let inventory_metrics = Self::collect_inventory_metrics(pool).await?;

        // Collect order metrics
        let order_metrics = Self::collect_order_metrics(pool).await?;

        // Collect financial metrics
        let financial_metrics = Self::collect_financial_metrics(pool).await?;

        // Record metrics to registry
        Self::record_metrics_to_registry(&sales_metrics, &customer_metrics, &inventory_metrics, &order_metrics, &financial_metrics, registry).await;

        let collection_time = start_time.elapsed();
        registry.record_timer("business_metrics_collection_duration", collection_time, HashMap::new());

        Ok(BusinessMetrics {
            sales_metrics,
            customer_metrics,
            inventory_metrics,
            order_metrics,
            financial_metrics,
        })
    }

    async fn collect_sales_metrics(pool: &PgPool) -> Result<SalesMetrics, sqlx::Error> {
        let today = Utc::now().date_naive();

        // Total revenue today
        let total_revenue_today: Option<Decimal> = sqlx::query_scalar(
            r#"
            SELECT COALESCE(SUM(total_amount), 0)
            FROM transactions
            WHERE DATE(created_at) = $1
            AND status = 'completed'
            "#
        )
        .bind(today)
        .fetch_one(pool)
        .await?;

        // Total transactions today
        let total_transactions_today: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*)
            FROM transactions
            WHERE DATE(created_at) = $1
            AND status = 'completed'
            "#
        )
        .bind(today)
        .fetch_one(pool)
        .await?;

        // Average transaction value
        let average_transaction_value = if total_transactions_today > 0 {
            total_revenue_today.unwrap_or(Decimal::ZERO) / Decimal::from(total_transactions_today)
        } else {
            Decimal::ZERO
        };

        // Revenue by hour
        let revenue_by_hour_raw: Vec<(String, Decimal)> = sqlx::query_as(
            r#"
            SELECT EXTRACT(HOUR FROM created_at)::text as hour, COALESCE(SUM(total_amount), 0)
            FROM transactions
            WHERE DATE(created_at) = $1
            AND status = 'completed'
            GROUP BY EXTRACT(HOUR FROM created_at)
            ORDER BY hour
            "#
        )
        .bind(today)
        .fetch_all(pool)
        .await?;

        let revenue_by_hour: HashMap<String, Decimal> = revenue_by_hour_raw.into_iter().collect();

        // Top selling products today
        let top_selling_products_raw: Vec<(uuid::Uuid, String, i64, Decimal)> = sqlx::query_as(
            r#"
            SELECT
                p.id,
                COALESCE(p.name, 'Unknown'),
                COALESCE(SUM(tl.quantity), 0),
                COALESCE(SUM(tl.quantity * tl.unit_price), 0)
            FROM transaction_lines tl
            INNER JOIN transactions t ON t.id = tl.transaction_id
            INNER JOIN product_variants pv ON pv.id = tl.variant_id
            INNER JOIN products p ON p.id = tl.product_id
            WHERE DATE(t.created_at) = $1
            AND t.status = 'completed'
            GROUP BY p.id, p.name
            ORDER BY SUM(tl.quantity) DESC
            LIMIT 10
            "#
        )
        .bind(today)
        .fetch_all(pool)
        .await?;

        let top_selling_products: Vec<ProductSales> = top_selling_products_raw.into_iter()
            .map(|(id, name, quantity, revenue)| ProductSales {
                product_id: id,
                product_name: name,
                quantity_sold: quantity as u32,
                revenue,
            })
            .collect();

        // Sales by category
        let sales_by_category_raw: Vec<(String, Decimal)> = sqlx::query_as(
            r#"
            SELECT
                COALESCE(c.name, 'Uncategorized'),
                COALESCE(SUM(tl.quantity * tl.unit_price), 0)
            FROM transaction_lines tl
            INNER JOIN transactions t ON t.id = tl.transaction_id
            INNER JOIN product_variants pv ON pv.id = tl.variant_id
            INNER JOIN products p ON p.id = tl.product_id
            LEFT JOIN categories c ON c.id = p.category_id
            WHERE DATE(t.created_at) = $1
            AND t.status = 'completed'
            GROUP BY c.name
            ORDER BY SUM(tl.quantity * tl.unit_price) DESC
            "#
        )
        .bind(today)
        .fetch_all(pool)
        .await?;

        let sales_by_category: HashMap<String, Decimal> = sales_by_category_raw.into_iter().collect();

        Ok(SalesMetrics {
            total_revenue_today: total_revenue_today.unwrap_or(Decimal::ZERO),
            total_transactions_today: total_transactions_today as u64,
            average_transaction_value,
            revenue_by_hour,
            top_selling_products,
            sales_by_category,
        })
    }

    async fn collect_customer_metrics(pool: &PgPool) -> Result<CustomerMetrics, sqlx::Error> {
        let today = Utc::now().date_naive();
        let _thirty_days_ago = today - ChronoDuration::days(30);

        // New customers today
        let new_customers_today: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM customers WHERE DATE(created_at) = $1"
        )
        .bind(today)
        .fetch_one(pool)
        .await?;

        // Active customers today (customers with transactions)
        let active_customers_today: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(DISTINCT customer_id)
            FROM transactions
            WHERE DATE(created_at) = $1
            AND customer_id IS NOT NULL
            AND status = 'completed'
            "#
        )
        .bind(today)
        .fetch_one(pool)
        .await?;

        // Customer retention rate (simplified - customers who returned within 30 days)
        let retention_rate: f64 = sqlx::query_scalar(
            r#"
            WITH first_time_customers AS (
                SELECT customer_id, MIN(DATE(created_at)) as first_date
                FROM transactions
                WHERE customer_id IS NOT NULL
                AND status = 'completed'
                GROUP BY customer_id
            ),
            returning_customers AS (
                SELECT ftc.customer_id
                FROM first_time_customers ftc
                INNER JOIN transactions t ON t.customer_id = ftc.customer_id
                WHERE DATE(t.created_at) > ftc.first_date
                AND DATE(t.created_at) <= ftc.first_date + INTERVAL '30 days'
                AND t.status = 'completed'
            )
            SELECT
                CASE
                    WHEN (SELECT COUNT(*) FROM first_time_customers) = 0 THEN 0
                    ELSE (COUNT(rc.customer_id)::float / (SELECT COUNT(*) FROM first_time_customers)::float) * 100
                END
            FROM returning_customers rc
            "#
        )
        .fetch_one(pool)
        .await?;

        // Average customer lifetime value (simplified)
        let avg_clv: Option<Decimal> = sqlx::query_scalar(
            r#"
            SELECT AVG(lifetime_value)
            FROM (
                SELECT
                    customer_id,
                    SUM(total_amount) as lifetime_value
                FROM transactions
                WHERE customer_id IS NOT NULL
                AND status = 'completed'
                GROUP BY customer_id
            ) customer_values
            "#
        )
        .fetch_one(pool)
        .await?;

        // Customers by segment (simplified - based on total spend)
        let customers_by_segment_raw: Vec<(String, i64)> = sqlx::query_as(
            r#"
            SELECT
                CASE
                    WHEN total_spend < 100 THEN 'Low'
                    WHEN total_spend < 500 THEN 'Medium'
                    WHEN total_spend < 1000 THEN 'High'
                    ELSE 'VIP'
                END as segment,
                COUNT(*)
            FROM (
                SELECT
                    customer_id,
                    SUM(total_amount) as total_spend
                FROM transactions
                WHERE customer_id IS NOT NULL
                AND status = 'completed'
                GROUP BY customer_id
            ) customer_spending
            GROUP BY segment
            "#
        )
        .fetch_all(pool)
        .await?;

        let customers_by_segment: HashMap<String, u64> = customers_by_segment_raw.into_iter()
            .map(|(segment, count)| (segment, count as u64))
            .collect();

        Ok(CustomerMetrics {
            new_customers_today: new_customers_today as u64,
            active_customers_today: active_customers_today as u64,
            customer_retention_rate: retention_rate,
            average_customer_lifetime_value: avg_clv.unwrap_or(Decimal::ZERO),
            customers_by_segment,
        })
    }

    async fn collect_inventory_metrics(pool: &PgPool) -> Result<InventoryMetrics, sqlx::Error> {
        // Total inventory value
        let total_inventory_value: Option<Decimal> = sqlx::query_scalar(
            r#"
            SELECT COALESCE(SUM(pv.stock_on_hand * p.cost_price), 0)
            FROM product_variants pv
            INNER JOIN products p ON p.id = pv.product_id
            WHERE pv.stock_on_hand > 0
            "#
        )
        .fetch_one(pool)
        .await?;

        // Low stock products (less than 10 units)
        let low_stock_products: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*)
            FROM product_variants pv
            INNER JOIN products p ON p.id = pv.product_id
            WHERE pv.stock_on_hand > 0 AND pv.stock_on_hand <= 10
            "#
        )
        .fetch_one(pool)
        .await?;

        // Out of stock products
        let out_of_stock_products: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*)
            FROM product_variants pv
            INNER JOIN products p ON p.id = pv.product_id
            WHERE pv.stock_on_hand = 0
            "#
        )
        .fetch_one(pool)
        .await?;

        // Inventory turnover rate (simplified - last 30 days vs average inventory)
        let turnover_rate: f64 = sqlx::query_scalar(
            r#"
            WITH last_30_days_sales AS (
                SELECT COALESCE(SUM(tl.quantity), 0) as total_sold
                FROM transaction_lines tl
                INNER JOIN transactions t ON t.id = tl.transaction_id
                WHERE t.created_at >= NOW() - INTERVAL '30 days'
                AND t.status = 'completed'
            ),
            avg_inventory AS (
                SELECT COALESCE(AVG(stock_on_hand), 0) as avg_stock
                FROM product_variants pv
                INNER JOIN products p ON p.id = pv.product_id
            )
            SELECT
                CASE
                    WHEN avg_inventory = 0 THEN 0
                    ELSE (total_sold::float / avg_inventory::float)
                END
            FROM last_30_days_sales, avg_inventory
            "#
        )
        .fetch_one(pool)
        .await?;

        // Days of inventory (simplified)
        let days_of_inventory: f64 = if turnover_rate > 0.0 {
            30.0 / turnover_rate
        } else {
            999.0 // Very high days of inventory when no turnover
        };

        Ok(InventoryMetrics {
            total_inventory_value: total_inventory_value.unwrap_or(Decimal::ZERO),
            low_stock_products: low_stock_products as u64,
            out_of_stock_products: out_of_stock_products as u64,
            inventory_turnover_rate: turnover_rate,
            days_of_inventory,
        })
    }

    async fn collect_order_metrics(pool: &PgPool) -> Result<OrderMetrics, sqlx::Error> {
        let today = Utc::now().date_naive();

        // Orders today
        let orders_today: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM transactions WHERE DATE(created_at) = $1"
        )
        .bind(today)
        .fetch_one(pool)
        .await?;

        // Orders fulfilled today
        let orders_fulfilled_today: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*)
            FROM transactions
            WHERE DATE(created_at) = $1
            AND is_fulfilled = true
            "#
        )
        .bind(today)
        .fetch_one(pool)
        .await?;

        // Fulfillment rate
        let fulfillment_rate: f64 = if orders_today > 0 {
            (orders_fulfilled_today as f64 / orders_today as f64) * 100.0
        } else {
            0.0
        };

        // Average fulfillment time (simplified)
        let avg_fulfillment_hours: Option<f64> = sqlx::query_scalar(
            r#"
            SELECT AVG(EXTRACT(EPOCH FROM (fulfilled_at - created_at)) / 3600)
            FROM transactions
            WHERE fulfilled_at IS NOT NULL
            AND created_at >= NOW() - INTERVAL '7 days'
            "#
        )
        .fetch_one(pool)
        .await?;

        let average_fulfillment_time = avg_fulfillment_hours
            .map(|hours| ChronoDuration::hours(hours as i64))
            .unwrap_or(ChronoDuration::zero());

        // Orders by status
        let orders_by_status_raw: Vec<(String, i64)> = sqlx::query_as(
            r#"
            SELECT status, COUNT(*)
            FROM transactions
            GROUP BY status
            "#
        )
        .fetch_all(pool)
        .await?;

        let orders_by_status: HashMap<String, u64> = orders_by_status_raw.into_iter()
            .map(|(status, count)| (status, count as u64))
            .collect();

        Ok(OrderMetrics {
            orders_today: orders_today as u64,
            orders_fulfilled_today: orders_fulfilled_today as u64,
            fulfillment_rate,
            average_fulfillment_time,
            orders_by_status,
        })
    }

    async fn collect_financial_metrics(pool: &PgPool) -> Result<FinancialMetrics, sqlx::Error> {
        let today = Utc::now().date_naive();

        // Gross profit today (simplified - revenue minus cost of goods sold)
        let gross_profit_today: Option<Decimal> = sqlx::query_scalar(
            r#"
            SELECT COALESCE(SUM(tl.quantity * (tl.unit_price - p.cost_price)), 0)
            FROM transaction_lines tl
            INNER JOIN transactions t ON t.id = tl.transaction_id
            INNER JOIN product_variants pv ON pv.id = tl.variant_id
            INNER JOIN products p ON p.id = tl.product_id
            WHERE DATE(t.created_at) = $1
            AND t.status = 'completed'
            "#
        )
        .bind(today)
        .fetch_one(pool)
        .await?;

        // Total revenue today for margin calculation
        let revenue_today: Option<Decimal> = sqlx::query_scalar(
            r#"
            SELECT COALESCE(SUM(total_amount), 0)
            FROM transactions
            WHERE DATE(created_at) = $1
            AND status = 'completed'
            "#
        )
        .bind(today)
        .fetch_one(pool)
        .await?;

        // Gross profit margin
        let gross_profit_margin: f64 = match revenue_today {
            Some(rev) if rev > Decimal::ZERO => {
                let profit = gross_profit_today.unwrap_or(Decimal::ZERO);
                (profit / rev * Decimal::from(100)).to_string().parse().unwrap_or(0.0)
            }
            _ => 0.0,
        };

        // Daily expenses (simplified - would need expense tracking table)
        let daily_expenses = Decimal::from(500); // Placeholder

        // Net profit today
        let net_profit_today = gross_profit_today.unwrap_or(Decimal::ZERO) - daily_expenses;

        // Accounts receivable (unpaid transactions)
        let accounts_receivable: Option<Decimal> = sqlx::query_scalar(
            r#"
            SELECT COALESCE(SUM(total_amount - paid_amount), 0)
            FROM transactions
            WHERE status = 'completed'
            AND total_amount > paid_amount
            "#
        )
        .fetch_one(pool)
        .await?;

        // Cash flow today (simplified)
        let cash_flow_today = net_profit_today;

        Ok(FinancialMetrics {
            gross_profit_today: gross_profit_today.unwrap_or(Decimal::ZERO),
            gross_profit_margin,
            daily_expenses,
            net_profit_today,
            accounts_receivable: accounts_receivable.unwrap_or(Decimal::ZERO),
            cash_flow_today,
        })
    }

    async fn record_metrics_to_registry(
        sales: &SalesMetrics,
        customer: &CustomerMetrics,
        inventory: &InventoryMetrics,
        orders: &OrderMetrics,
        financial: &FinancialMetrics,
        registry: &mut MetricRegistry,
    ) {
        // Sales metrics
        registry.record_gauge(
            "sales_revenue_today",
            sales.total_revenue_today.to_string().parse().unwrap_or(0.0),
            HashMap::new(),
        );
        registry.record_counter(
            "sales_transactions_today",
            sales.total_transactions_today as f64,
            HashMap::new(),
        );
        registry.record_gauge(
            "sales_average_transaction_value",
            sales.average_transaction_value.to_string().parse().unwrap_or(0.0),
            HashMap::new(),
        );

        // Customer metrics
        registry.record_counter(
            "customers_new_today",
            customer.new_customers_today as f64,
            HashMap::new(),
        );
        registry.record_gauge(
            "customers_active_today",
            customer.active_customers_today as f64,
            HashMap::new(),
        );
        registry.record_gauge(
            "customers_retention_rate",
            customer.customer_retention_rate,
            HashMap::new(),
        );

        // Inventory metrics
        registry.record_gauge(
            "inventory_total_value",
            inventory.total_inventory_value.to_string().parse().unwrap_or(0.0),
            HashMap::new(),
        );
        registry.record_gauge(
            "inventory_low_stock_products",
            inventory.low_stock_products as f64,
            HashMap::new(),
        );
        registry.record_gauge(
            "inventory_out_of_stock_products",
            inventory.out_of_stock_products as f64,
            HashMap::new(),
        );
        registry.record_gauge(
            "inventory_turnover_rate",
            inventory.inventory_turnover_rate,
            HashMap::new(),
        );

        // Order metrics
        registry.record_counter(
            "orders_today",
            orders.orders_today as f64,
            HashMap::new(),
        );
        registry.record_counter(
            "orders_fulfilled_today",
            orders.orders_fulfilled_today as f64,
            HashMap::new(),
        );
        registry.record_gauge(
            "orders_fulfillment_rate",
            orders.fulfillment_rate,
            HashMap::new(),
        );

        // Financial metrics
        registry.record_gauge(
            "financial_gross_profit_today",
            financial.gross_profit_today.to_string().parse().unwrap_or(0.0),
            HashMap::new(),
        );
        registry.record_gauge(
            "financial_gross_profit_margin",
            financial.gross_profit_margin,
            HashMap::new(),
        );
        registry.record_gauge(
            "financial_net_profit_today",
            financial.net_profit_today.to_string().parse().unwrap_or(0.0),
            HashMap::new(),
        );
        registry.record_gauge(
            "financial_accounts_receivable",
            financial.accounts_receivable.to_string().parse().unwrap_or(0.0),
            HashMap::new(),
        );
    }
}
