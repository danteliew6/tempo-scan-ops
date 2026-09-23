import { createApp, analytics, genie, server, lakebase } from '@databricks/appkit';
import { z } from 'zod';

// Write-back payload: an ops decision on an at-risk SKU x DC (expiry / stockout).
const ReplenishmentInput = z.object({
  product_id: z.string().min(1).max(64),
  dc_id: z.string().min(1).max(64),
  product_name: z.string().max(160).optional(),
  brand: z.string().max(64).optional(),
  region: z.string().max(64).optional(),
  expiry_risk_pct: z.number().int().min(0).max(100).optional(),
  stockout_risk_pct: z.number().int().min(0).max(100).optional(),
  action: z.enum(['expedite', 'redistribute', 'promote', 'hold', 'dismiss']),
  note: z.string().max(500).optional(),
});

createApp({
  plugins: [
    analytics(),
    genie(),
    server(),
    // serving() omitted: this workspace's UC metastore is at its registered-model
    // quota, so the demand/expiry model can't be served. The Forecast page's live
    // "what-if" degrades gracefully; the forecast chart + risk worklist read Lakebase.
    lakebase(),
  ],
  // Operational-serving reads: the curated gold layer is synced into Lakebase
  // Postgres (see lakebase/setup_synced_tables.sh). These routes serve live-ops
  // state to the app at OLTP latency instead of re-aggregating on the warehouse.
  // Write-back: ops decisions persist to an app-owned schema (ops.replenishment_orders)
  // — reads come from public.gold_* (read-only, SP granted SELECT); writes go to
  // a separate schema the service principal creates and owns.
  async onPluginsReady(appkit) {
    // Schema init — runs once at startup; the app SP creates and owns `ops`.
    await appkit.lakebase.query(`
      CREATE SCHEMA IF NOT EXISTS ops;
      CREATE TABLE IF NOT EXISTS ops.replenishment_orders (
        id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        product_id         TEXT NOT NULL,
        dc_id              TEXT NOT NULL,
        product_name       TEXT,
        brand              TEXT,
        region             TEXT,
        expiry_risk_pct    INTEGER,
        stockout_risk_pct  INTEGER,
        action             TEXT NOT NULL,
        note               TEXT,
        created_by         TEXT NOT NULL,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_replenishment_created_at
        ON ops.replenishment_orders (created_at DESC);
    `);

    appkit.server.extend((app) => {
      // --- Write-back: record an operational decision on a SKU x DC ---
      app.post('/api/ops/replenishment-orders', async (req, res) => {
        const parsed = ReplenishmentInput.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: 'Invalid input', details: parsed.error.issues });
          return;
        }
        const o = parsed.data;
        const createdBy = req.header('x-forwarded-email') ?? 'local-dev';
        try {
          const { rows } = await appkit.lakebase.query(
            `INSERT INTO ops.replenishment_orders
               (product_id, dc_id, product_name, brand, region, expiry_risk_pct, stockout_risk_pct, action, note, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             RETURNING id, product_id, dc_id, product_name, brand, region,
                       expiry_risk_pct, stockout_risk_pct, action, note, created_by, created_at`,
            [
              o.product_id, o.dc_id, o.product_name ?? null, o.brand ?? null, o.region ?? null,
              o.expiry_risk_pct ?? null, o.stockout_risk_pct ?? null, o.action, o.note ?? null, createdBy,
            ],
          );
          res.status(201).json(rows[0]);
        } catch (e) {
          res.status(500).json({ error: String(e) });
        }
      });

      // --- Read-back: recent operational decisions (proves persistence) ---
      app.get('/api/ops/replenishment-orders', async (_req, res) => {
        try {
          const { rows } = await appkit.lakebase.query(
            `SELECT id, product_id, dc_id, product_name, brand, region,
                    expiry_risk_pct, stockout_risk_pct, action, note, created_by, created_at
             FROM ops.replenishment_orders ORDER BY created_at DESC LIMIT 100`,
          );
          res.json(rows);
        } catch (e) {
          res.status(500).json({ error: String(e) });
        }
      });

      // Numeric columns are cast to ::int / ::float8 so node-postgres returns JS numbers
      // (bigint/numeric would arrive as strings). Reads are sub-second vs warehouse cold starts.
      const lbGet = (path: string, sql: string) =>
        app.get(path, async (_req, res) => {
          try {
            const { rows } = await appkit.lakebase.query(sql);
            res.json(rows);
          } catch (e) {
            res.status(500).json({ error: String(e) });
          }
        });

      // ---------------------------------------------------------------------
      // Command Center + Overview national KPIs (public.gold_national_daily)
      // ---------------------------------------------------------------------
      lbGet('/api/lakebase/national-kpis', `
        SELECT ROUND((SUM(net_idr)/1e9)::numeric, 2)::float8              AS revenue_bn_idr,
               ROUND((SUM(revenue_at_risk_idr)/1e9)::numeric, 2)::float8  AS revenue_at_risk_bn_idr,
               SUM(demand_units)::bigint                                  AS demand_units,
               SUM(order_count)::bigint                                   AS order_count,
               SUM(backorder_count)::bigint                               AS backorder_count,
               ROUND(AVG(fill_rate)::numeric, 4)::float8                  AS fill_rate,
               ROUND(AVG(stockout_rate)::numeric, 4)::float8              AS stockout_rate
        FROM public.gold_national_daily
        WHERE sales_date >= (SELECT MAX(sales_date) - INTERVAL '30 days' FROM public.gold_national_daily)`);

      // National daily trend (for Overview line charts + Command Center timeline scrubber)
      lbGet('/api/lakebase/national-daily', `
        SELECT to_char(sales_date, 'YYYY-MM-DD')                      AS sales_date,
               ROUND((net_idr/1e9)::numeric, 3)::float8               AS revenue_bn_idr,
               ROUND((revenue_at_risk_idr/1e6)::numeric, 1)::float8   AS revenue_at_risk_m_idr,
               demand_units::int                                      AS demand_units,
               ROUND(fill_rate::numeric, 4)::float8                   AS fill_rate,
               ROUND(stockout_rate::numeric, 4)::float8               AS stockout_rate,
               backorder_count::int                                   AS backorder_count
        FROM public.gold_national_daily
        WHERE sales_date >= (SELECT MAX(sales_date) - INTERVAL '30 days' FROM public.gold_national_daily)
        ORDER BY sales_date`);

      // ---------------------------------------------------------------------
      // Region snapshot for the map + region health (public.gold_region_daily)
      // Latest available day per region.
      // ---------------------------------------------------------------------
      lbGet('/api/lakebase/region-latest', `
        WITH latest AS (
          SELECT region, MAX(sales_date) AS d FROM public.gold_region_daily GROUP BY region
        )
        SELECT g.region,
               to_char(g.sales_date, 'YYYY-MM-DD')                    AS sales_date,
               g.demand_units::int                                    AS demand_units,
               ROUND(g.fill_rate::numeric, 4)::float8                 AS fill_rate,
               ROUND(g.stockout_rate::numeric, 4)::float8             AS stockout_rate,
               ROUND((g.revenue_at_risk_idr/1e6)::numeric, 1)::float8 AS revenue_at_risk_m_idr,
               g.backorder_count::int                                 AS backorder_count
        FROM public.gold_region_daily g
        JOIN latest l ON l.region = g.region AND l.d = g.sales_date
        ORDER BY g.demand_units DESC`);

      // Region demand trend (Overview: demand by region over the window)
      lbGet('/api/lakebase/region-trend', `
        SELECT region,
               to_char(sales_date, 'YYYY-MM-DD') AS sales_date,
               demand_units::int                 AS demand_units
        FROM public.gold_region_daily
        WHERE sales_date >= (SELECT MAX(sales_date) - INTERVAL '30 days' FROM public.gold_region_daily)
        ORDER BY region, sales_date`);

      // ---------------------------------------------------------------------
      // At-risk SKU worklist (public.gold_product_risk) — Forecast + Command Center
      // ---------------------------------------------------------------------
      lbGet('/api/lakebase/product-risk', `
        SELECT product_id, dc_id, product_name, brand, division, region, dc_name,
               ROUND(expiry_risk_score * 100)::int   AS expiry_risk_pct,
               ROUND(stockout_risk_score * 100)::int AS stockout_risk_pct,
               days_to_expiry::int                   AS days_to_expiry,
               on_hand_units::bigint                 AS on_hand_units,
               ROUND(days_of_supply::numeric, 1)::float8 AS days_of_supply,
               at_risk_expiry_units::bigint          AS at_risk_expiry_units,
               recommended_action
        FROM public.gold_product_risk
        WHERE expiry_risk_score >= 0.5 OR stockout_risk_score >= 0.5
        ORDER BY GREATEST(expiry_risk_score, stockout_risk_score) DESC
        LIMIT 60`);

      // Division revenue mix for Overview (public.gold_sales_serving)
      lbGet('/api/lakebase/division-mix', `
        SELECT division,
               COUNT(*)::int                                 AS orders,
               ROUND((SUM(net_idr)/1e9)::numeric, 3)::float8 AS net_bn_idr
        FROM public.gold_sales_serving
        GROUP BY division ORDER BY net_bn_idr DESC`);

      // Recent sell-through / backorder feed (public.gold_sales_serving) — NO PII
      lbGet('/api/lakebase/recent-sales', `
        SELECT sale_id, to_char(order_ts, 'YYYY-MM-DD HH24:MI') AS order_ts,
               region, city, division, brand, product_name,
               units_ordered::int   AS units_ordered,
               units_fulfilled::int AS units_fulfilled,
               ROUND((net_idr/1e6)::numeric, 2)::float8 AS net_m_idr,
               status
        FROM public.gold_sales_serving
        WHERE status IN ('backorder', 'partial')
        ORDER BY order_ts DESC
        LIMIT 40`);

      // ---------------------------------------------------------------------
      // Demand forecast (public.gold_demand_forecast) — Forecast page STAR chart
      // ---------------------------------------------------------------------
      lbGet('/api/lakebase/demand-forecast', `
        SELECT region,
               to_char(forecast_date, 'YYYY-MM-DD') AS forecast_date,
               ROUND(forecast_units)::bigint        AS forecast_units,
               ROUND(lower)::bigint                 AS lower,
               ROUND(upper)::bigint                 AS upper
        FROM public.gold_demand_forecast
        ORDER BY region, forecast_date`);

      // Forecast totals by region (bar summary)
      lbGet('/api/lakebase/forecast-by-region', `
        SELECT region, ROUND(SUM(forecast_units))::bigint AS forecast_units
        FROM public.gold_demand_forecast
        GROUP BY region ORDER BY forecast_units DESC`);
    });
  },
}).catch(console.error);
