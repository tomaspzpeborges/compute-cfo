import * as XLSX from "xlsx";
import JSZip from "jszip";
import { saveAs } from "file-saver";
import { jsPDF } from "jspdf";
import React, { useMemo, useRef, useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
  CartesianGrid,
  Cell,
  ReferenceLine,
} from "recharts";

/* =========================================================
   Mock Data
   ========================================================= */

type Dept = "GenAI" | "Product" | "Audio" | "Platform" | "Research";

interface UtilRow {
  date: string; // YYYY-MM-DD
  department: Dept;
  project: string;
  customer?: string; // for B2B feature usage attribution
  vendor: "AWS" | "Coreweave" | "On-Prem" | "OpenAI";
  gpuType: string; // e.g. A100, H100
  ncc: number; // normalized compute credits
  cost: number; // USD
}

const depts: Dept[] = ["GenAI", "Product", "Audio", "Platform", "Research"];
const projects = {
  GenAI: ["Stable Diffusion v3", "Style Transfer", "Image Embedder"],
  Product: ["SDXL API", "Realtime Gen", "Batch Inference"],
  Audio: ["Stable Audio", "Podcast Cleaner"],
  Platform: ["Model Gateway", "Telemetry Fabric"],
  Research: ["LMM Prototype", "Tokenizer Lab"],
} as const;

const customers = [
  "Acme Studios",
  "Photon Labs",
  "RetailCo",
  "MediaForge",
  "NovaBank",
  "BioSynth",
  "IndieDev",
];

function rand(seed: number) {
  let x = seed % 2147483647;
  return () => (x = (x * 48271) % 2147483647) / 2147483647;
}

function makeMockRows(days = 30, seed = 42): UtilRow[] {
  const r = rand(seed);
  const start = new Date();
  start.setHours(12, 0, 0, 0);
  start.setDate(start.getDate() - days + 1);
  const vendors = ["AWS", "Coreweave", "On-Prem", "OpenAI"] as const;
  const gpus = ["A100-40GB", "A100-80GB", "H100-80GB", "RTX-A6000"];

  const rows: UtilRow[] = [];
  for (let d = 0; d < days; d++) {
    const day = new Date(start.getTime());
    day.setDate(start.getDate() + d);
    const date = day.toISOString().slice(0, 10);

    depts.forEach((dep) => {
      (projects as any)[dep].forEach((proj: string) => {
        const vendor = vendors[Math.floor(r() * vendors.length)];
        const gpuType = gpus[Math.floor(r() * gpus.length)];
        const ncc = Math.max(5, Math.round(r() * 500));
        const unit = 0.02 + r() * 0.08; // $/NCC
        const cost = +(ncc * unit).toFixed(2);
        const hasCustomer = dep === "Product" || dep === "GenAI";
        const customer =
          hasCustomer && r() > 0.4
            ? customers[Math.floor(r() * customers.length)]
            : undefined;
        rows.push({
          date,
          department: dep,
          project: proj,
          vendor,
          gpuType,
          ncc,
          cost,
          customer,
        });
      });
    });
  }
  return rows;
}

/* =========================================================
   Utilities
   ========================================================= */

function groupBy<T, K extends keyof any>(
  arr: T[],
  getKey: (t: T) => K
): Record<K, T[]> {
  return arr.reduce((acc, it) => {
    const k = getKey(it);
    (acc[k] ||= []).push(it);
    return acc;
  }, {} as Record<K, T[]>);
}

function downloadBlob(filename: string, data: Blob) {
  const url = URL.createObjectURL(data);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function toCSV<T extends Record<string, any>>(rows: T[]) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const escape = (v: any) => {
    const s = String(v ?? "");
    return s.match(/[",]/) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [headers.join(",")].concat(
    rows.map((r) => headers.map((h) => escape(r[h])).join(","))
  );
  return lines.join("\n");
}

// Treat On-Prem as Fixed; cloud + APIs as Variable
function splitCost(row: UtilRow) {
  const fixed = row.vendor === "On-Prem" ? row.cost : 0;
  const variable = row.cost - fixed;
  return { fixed, variable };
}

function percentile(values: number[], p: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((p / 100) * sorted.length))
  );
  return sorted[idx];
}

// stable 0..1 hash for strings (deterministic mock pricing/margins)
function hash01(s: string) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967295;
}

/* =========================================================
   Financial Overview (P&L-style)
   ========================================================= */

function FinancialOverviewPanel({ rows }: { rows: UtilRow[] }) {
  const {
    totalRevenue,
    totalCost,
    grossProfit,
    grossMarginPct,
    cogsFixed,
    cogsVariable,
    revByDay,
    cogsByDay,
  } = React.useMemo(() => {
    let revenue = 0, cost = 0, fixed = 0, variable = 0;
    const byDayRev = new Map<string, number>();
    const byDayCost = new Map<string, number>();

    for (const r of rows) {
      const { fixed: f, variable: v } = splitCost(r);
      cost += r.cost; fixed += f; variable += v;

      if (r.customer) {
        const m = 0.15 + hash01(r.customer) * 0.4;
        const rev = r.cost / (1 - m);
        revenue += rev;
        byDayRev.set(r.date, (byDayRev.get(r.date) || 0) + rev);
      } else {
        byDayRev.set(r.date, (byDayRev.get(r.date) || 0) + 0);
      }
      byDayCost.set(r.date, (byDayCost.get(r.date) || 0) + r.cost);
    }

    const gp = revenue - cost;
    const gm = revenue > 0 ? (gp / revenue) * 100 : 0;

    const revByDay = Array.from(byDayRev.entries())
      .map(([date, value]) => ({ date, value: +value.toFixed(2) }))
      .sort((a, b) => a.date.localeCompare(b.date));
    const cogsByDay = Array.from(byDayCost.entries())
      .map(([date, value]) => ({ date, value: +value.toFixed(2) }))
      .sort((a, b) => a.date.localeCompare(b.date));

    return {
      totalRevenue: +revenue.toFixed(2),
      totalCost: +cost.toFixed(2),
      grossProfit: +gp.toFixed(2),
      grossMarginPct: +gm.toFixed(2),
      cogsFixed: +fixed.toFixed(2),
      cogsVariable: +variable.toFixed(2),
      revByDay,
      cogsByDay,
    };
  }, [rows]);

  const cogsStack = [
    { name: "Total", Fixed: cogsFixed, Variable: cogsVariable, Total: +(cogsFixed + cogsVariable).toFixed(2) },
  ];

  const revCostDaily = React.useMemo(() => {
    const idx = new Map<string, { date: string; Revenue: number; COGS: number }>();
    for (const r of revByDay) idx.set(r.date, { date: r.date, Revenue: r.value, COGS: 0 });
    for (const c of cogsByDay) {
      const row = idx.get(c.date) || { date: c.date, Revenue: 0, COGS: 0 };
      row.COGS = c.value; idx.set(c.date, row);
    }
    return Array.from(idx.values()).sort((a, b) => a.date.localeCompare(b.date));
  }, [revByDay, cogsByDay]);

  const gmClass =
    grossMarginPct >= 50 ? "text-blue-400"
    : grossMarginPct >= 30 ? "text-slate-300"
    : "text-rose-500";

  return (
    <div className="card p-5">
      <h3 className="text-lg font-semibold mb-4">Financial Overview — P&amp;L Snapshot</h3>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <div className="card p-4">
          <div className="text-xs text-muted mb-1">Revenue (mock)</div>
          <div className="text-xl font-semibold kpi">${totalRevenue.toLocaleString()}</div>
        </div>
        <div className="card p-4">
          <div className="text-xs text-muted mb-1">Compute COGS</div>
          <div className="text-xl font-semibold kpi">${totalCost.toLocaleString()}</div>
        </div>
        <div className="card p-4">
          <div className="text-xs text-muted mb-1">Gross Profit</div>
          <div className="text-xl font-semibold kpi">${grossProfit.toLocaleString()}</div>
        </div>
        <div className="card p-4">
          <div className={`text-xl font-semibold ${gmClass}`}>{grossMarginPct.toFixed(1)}%</div>
          <div className="text-xs text-muted mt-1">Gross Margin</div>
        </div>
      </div>

      {/* Charts: Fixed/Variable -> Blue/Red, Rev vs COGS -> Blue/Slate */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card p-4">
          <h4 className="font-medium mb-2">COGS Composition (Fixed vs Variable)</h4>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={cogsStack}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-grid)" />
                <XAxis dataKey="name" tick={{ fill: "var(--color-axis)" }} />
                <YAxis tick={{ fill: "var(--color-axis)" }} />
                <Tooltip />
                <Legend />
                <Bar dataKey="Fixed" stackId="cogs" name="Fixed (USD)" fill="var(--chart-blue)" />
                <Bar dataKey="Variable" stackId="cogs" name="Variable (USD)" fill="var(--chart-amber)" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="card p-4">
          <h4 className="font-medium mb-2">Revenue vs Compute COGS (Daily)</h4>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={revCostDaily}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-grid)" />
                <XAxis dataKey="date" tick={{ fill: "var(--color-axis)" }} />
                <YAxis tick={{ fill: "var(--color-axis)" }} />
                <Tooltip />
                <Legend />
                <Bar dataKey="Revenue" name="Revenue (USD)" fill="var(--chart-blue)" />
                <Bar dataKey="COGS" name="COGS (USD)" fill="var(--chart-slate)" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
}

/* =========================================================
   Reports
   ========================================================= */

type ReportKind =
  | "spendByDeptProject"
  | "topCustomers"
  | "reconcileAwsInternal"
  | "customerGuardrails";

function ReportShell({
  title,
  children,
  actionsRef,
}: {
  title: string;
  children: React.ReactNode;
  actionsRef: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <div className="card p-6 shadow-sm print:shadow-none">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h2 className="text-xl font-semibold">{title}</h2>
          <p className="text-sm text-muted">Generated {new Date().toLocaleString()}</p>
        </div>
        <div ref={actionsRef} className="flex gap-2 print:hidden" />
      </div>
      <div className="prose prose-zinc dark:prose-invert max-w-none">{children}</div>
    </div>
  );
}

function SpendByDeptProject({ rows }: { rows: UtilRow[] }) {
  const agg = useMemo(() => {
    const key = (r: UtilRow) => `${r.department}||${r.project}`;
    const map = new Map<
      string,
      {
        department: string;
        project: string;
        ncc: number;
        cost: number;
        costFixed: number;
        costVariable: number;
      }
    >();
    for (const r of rows) {
      const k = key(r);
      if (!map.has(k)) {
        map.set(k, {
          department: r.department,
          project: r.project,
          ncc: 0,
          cost: 0,
          costFixed: 0,
          costVariable: 0,
        });
      }
      const x = map.get(k)!;
      const { fixed, variable } = splitCost(r);
      x.ncc += r.ncc;
      x.cost += r.cost;
      x.costFixed += fixed;
      x.costVariable += variable;
    }
    return Array.from(map.values()).sort((a, b) => b.cost - a.cost);
  }, [rows]);

  const byDept = useMemo(() => {
    const g = groupBy(agg, (x) => x.department);
    return Object.entries(g).map(([department, list]) => ({
      department,
      costFixed: +list.reduce((s, x) => s + x.costFixed, 0).toFixed(2),
      costVariable: +list.reduce((s, x) => s + x.costVariable, 0).toFixed(2),
      ncc: list.reduce((s, x) => s + x.ncc, 0),
      totalCost: +list.reduce((s, x) => s + x.cost, 0).toFixed(2),
    }));
  }, [agg]);

  return (
    <div>
      <p>
        This report shows <strong>compute spend</strong> by <strong>department</strong> and{" "}
        <strong>project</strong>, split into <strong>Fixed</strong> (On-Prem / amortized) and{" "}
        <strong>Variable</strong> (cloud & APIs). Adjust the rule in <code>splitCost</code>.
      </p>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card p-4">
          <h3 className="font-medium mb-2">Spend by Department (Stacked)</h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={byDept}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-grid)" />
                <XAxis dataKey="department" tick={{ fill: "var(--color-axis)" }} />
                <YAxis tick={{ fill: "var(--color-axis)" }} />
                <Tooltip />
                <Legend />
                <Bar dataKey="costFixed" name="Fixed (USD)" stackId="cost" fill="var(--chart-blue)" />
                <Bar dataKey="costVariable" name="Variable (USD)" stackId="cost" fill="var(--chart-amber)" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="overflow-auto card p-0">
          <table className="min-w-full text-sm">
            <thead className="bg-surface-2">
              <tr>
                <th className="text-left p-3">Department</th>
                <th className="text-left p-3">Project</th>
                <th className="text-right p-3">NCC</th>
                <th className="text-right p-3">Fixed ($)</th>
                <th className="text-right p-3">Variable ($)</th>
                <th className="text-right p-3">Total ($)</th>
              </tr>
            </thead>
            <tbody>
              {agg.map((row, i) => (
                <tr key={i} className="border-t border-border/60">
                  <td className="p-3">{row.department}</td>
                  <td className="p-3">{row.project}</td>
                  <td className="p-3 text-right kpi">{row.ncc.toLocaleString()}</td>
                  <td className="p-3 text-right kpi">
                    $
                    {row.costFixed.toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </td>
                  <td className="p-3 text-right kpi">
                    $
                    {row.costVariable.toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </td>
                  <td className="p-3 text-right kpi">
                    $
                    {row.cost.toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function TopCustomers({ rows }: { rows: UtilRow[] }) {
  const filtered = rows.filter((r) => !!r.customer);

  const agg = useMemo(() => {
    type Vendors = { AWS: number; Coreweave: number; OnPrem: number; OpenAI: number };

    const m = new Map<
      string,
      {
        customer: string;
        cost: number;
        ncc: number;
        costFixed: number;
        costVariable: number;
        projects: Set<string>;
        vendors: Vendors;
      }
    >();

    const toKey = (v: UtilRow["vendor"]): keyof Vendors =>
      v === "On-Prem" ? "OnPrem" : (v as keyof Vendors);

    for (const r of filtered) {
      const key = r.customer!;
      if (!m.has(key)) {
        m.set(key, {
          customer: key,
          cost: 0,
          ncc: 0,
          costFixed: 0,
          costVariable: 0,
          projects: new Set(),
          vendors: { AWS: 0, Coreweave: 0, OnPrem: 0, OpenAI: 0 },
        });
      }
      const x = m.get(key)!;

      // Table totals (unchanged)
      const { fixed, variable } = splitCost(r);
      x.cost += r.cost;
      x.ncc += r.ncc;
      x.costFixed += fixed;
      x.costVariable += variable;
      x.projects.add(r.project);

      // Vendor/source breakdown for stacked chart
      const vk = toKey(r.vendor);
      x.vendors[vk] += r.cost;
    }

    return Array.from(m.values())
      .map((x) => ({ ...x, projectsCount: x.projects.size }))
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 20);
  }, [filtered]);

  // Data for the stacked vendor chart
  const top10Stack = useMemo(
    () =>
      agg.slice(0, 10).map((x) => ({
        customer: x.customer,
        AWS: +x.vendors.AWS.toFixed(2),
        Coreweave: +x.vendors.Coreweave.toFixed(2),
        OnPrem: +x.vendors.OnPrem.toFixed(2),
        OpenAI: +x.vendors.OpenAI.toFixed(2),
      })),
    [agg]
  );

  // Guaranteed-unique colors per vendor (no duplicates)
  const VENDOR_COLORS = {
    AWS: "var(--chart-blue)",
    Coreweave: "var(--chart-rose)",
    OnPrem: "var(--chart-amber)",
    OpenAI: "var(--chart-emerald)",
  } as const;

  return (
    <div>
      <p>
        This ranks <strong>customers</strong> by compute spend. The chart shows spend by{" "}
        <strong>source</strong> (AWS, CoreWeave, On-Prem, OpenAI API). The table still includes{" "}
        <strong>Fixed</strong> vs <strong>Variable</strong> for margin context.
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Stacked by source (vendor) with unique colors */}
        <div className="card p-4">
          <h3 className="font-medium mb-2">Top 10 Customers — Spend by Source</h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={top10Stack}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-grid)" />
                <XAxis dataKey="customer" tick={{ fill: "var(--color-axis)" }} />
                <YAxis tick={{ fill: "var(--color-axis)" }} />
                <Tooltip />
                <Legend />
                <Bar dataKey="AWS" stackId="cost" name="AWS" fill={VENDOR_COLORS.AWS} />
                <Bar dataKey="Coreweave" stackId="cost" name="CoreWeave" fill={VENDOR_COLORS.Coreweave} />
                <Bar dataKey="OnPrem" stackId="cost" name="On-Prem" fill={VENDOR_COLORS.OnPrem} />
                <Bar dataKey="OpenAI" stackId="cost" name="OpenAI API" fill={VENDOR_COLORS.OpenAI} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Table (unchanged) */}
        <div className="overflow-auto card p-0">
          <table className="min-w-full text-sm">
            <thead className="bg-surface-2">
              <tr>
                <th className="text-left p-3">Customer</th>
                <th className="text-right p-3">Projects</th>
                <th className="text-right p-3">NCC</th>
                <th className="text-right p-3">Fixed ($)</th>
                <th className="text-right p-3">Variable ($)</th>
                <th className="text-right p-3">Total ($)</th>
              </tr>
            </thead>
            <tbody>
              {agg.map((row, i) => (
                <tr key={i} className="border-t border-border/60">
                  <td className="p-3">{row.customer}</td>
                  <td className="p-3 text-right kpi">{row.projectsCount}</td>
                  <td className="p-3 text-right kpi">{row.ncc.toLocaleString()}</td>
                  <td className="p-3 text-right kpi">
                    $
                    {row.costFixed.toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </td>
                  <td className="p-3 text-right kpi">
                    $
                    {row.costVariable.toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </td>
                  <td className="p-3 text-right kpi">
                    $
                    {row.cost.toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function ReconcileAwsInternal({ rows }: { rows: UtilRow[] }) {
  const recon = React.useMemo(() => computeAwsBudgetReconciliation(rows), [rows]);

  return (
    <div>
      <p>
        Reconciliation of <strong>Budget</strong> vs <strong>AWS Billing</strong> with
        an automatic allocation of the <strong>difference</strong> to departments
        (pro-rata by actual AWS usage on each day).
      </p>

      {/* KPI summary */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 my-4">
        <div className="card p-4">
          <div className="text-xs text-muted mb-1">Budget (USD)</div>
          <div className="text-xl font-semibold kpi">
            ${recon.totals.budget.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </div>
        </div>
        <div className="card p-4">
          <div className="text-xs text-muted mb-1">AWS Billed (USD)</div>
          <div className="text-xl font-semibold kpi">
            ${recon.totals.awsBilled.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </div>
        </div>
        <div className="card p-4">
          <div className="text-xs text-muted mb-1">Difference (Billed − Budget)</div>
          <div
            className={[
              "text-xl font-semibold kpi",
              recon.totals.variance === 0
                ? "text-slate-300"
                : recon.totals.variance > 0
                ? "text-rose-500"
                : "text-blue-400",
            ].join(" ")}
          >
            {recon.totals.variance >= 0 ? "" : "−"}$
            {Math.abs(recon.totals.variance).toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </div>
        </div>
      </div>

      {/* Chart: Budget vs AWS vs Difference (daily) */}
      <div className="card p-4 mb-6">
        <h4 className="font-medium mb-2">Budget vs AWS Billing vs Difference (Daily)</h4>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={recon.byDay}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-grid)" />
              <XAxis dataKey="date" tick={{ fill: "var(--color-axis)" }} />
              <YAxis tick={{ fill: "var(--color-axis)" }} />
              <Tooltip />
              <Legend />
              <Bar dataKey="budget" name="Budget" fill="var(--chart-slate)" />
              <Bar dataKey="awsBilled" name="AWS Billed" fill="var(--chart-blue)" />
              <Bar dataKey="variance" name="Difference" fill="var(--chart-rose)" />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <p className="text-xs text-muted mt-2">
          “Difference” is <em>AWS Billed − Budget</em>. Positive bars indicate overspend vs budget (red);
          negative bars indicate underspend (shown in red below the axis).
        </p>
      </div>

      {/* Daily table */}
      <div className="card overflow-auto p-0 mb-6">
        <table className="min-w-full text-sm">
          <thead className="bg-surface-2">
            <tr>
              <th className="text-left p-3">Date</th>
              <th className="text-right p-3">Budget ($)</th>
              <th className="text-right p-3">AWS Billed ($)</th>
              <th className="text-right p-3">Difference ($)</th>
              <th className="text-right p-3">Diff %</th>
              <th className="text-center p-3">Status</th>
            </tr>
          </thead>
          <tbody>
            {recon.byDay.map((row) => (
              <tr key={row.date} className="border-t border-border/60">
                <td className="p-3">{row.date}</td>
                <td className="p-3 text-right kpi">
                  ${row.budget.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </td>
                <td className="p-3 text-right kpi">
                  ${row.awsBilled.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </td>
                <td
                  className={[
                    "p-3 text-right kpi",
                    row.variance === 0
                      ? ""
                      : row.variance > 0
                      ? "text-rose-500 font-medium"
                      : "text-blue-400 font-medium",
                  ].join(" ")}
                >
                  {row.variance.toFixed(2)}
                </td>
                <td className="p-3 text-right">{row.variancePct.toFixed(2)}%</td>
                <td className="p-3 text-center">{row.status}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-surface-2/70">
              <td className="p-3 font-medium">Totals</td>
              <td className="p-3 text-right font-medium">
                ${recon.totals.budget.toLocaleString(undefined, { minimumFractionDigits: 2 })}
              </td>
              <td className="p-3 text-right font-medium">
                ${recon.totals.awsBilled.toLocaleString(undefined, { minimumFractionDigits: 2 })}
              </td>
              <td className="p-3 text-right font-medium">
                {recon.totals.variance.toLocaleString(undefined, { minimumFractionDigits: 2 })}
              </td>
              <td className="p-3" />
              <td className="p-3" />
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Variance Allocation (pro-rata) */}
      <div className="card p-4">
        <h4 className="font-medium mb-2">Automatic Variance Allocation — by Department</h4>
        <p className="text-xs text-muted mb-3">
          Allocated daily, proportional to each department’s share of actual AWS cost that day.
          Positive = overspend assigned; negative = underspend (credit).
        </p>
        <div className="overflow-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-surface-2">
              <tr>
                <th className="text-left p-3">Department</th>
                <th className="text-right p-3">AWS Actual ($)</th>
                <th className="text-right p-3">Share %</th>
                <th className="text-right p-3">Allocated Difference ($)</th>
              </tr>
            </thead>
            <tbody>
              {recon.allocationByDept.map((r) => (
                <tr key={r.department} className="border-t border-border/60">
                  <td className="p-3">{r.department}</td>
                  <td className="p-3 text-right kpi">
                    ${r.awsActual.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  </td>
                  <td className="p-3 text-right">{r.sharePct.toFixed(2)}%</td>
                  <td
                    className={[
                      "p-3 text-right kpi",
                      r.allocatedVariance === 0
                        ? ""
                        : r.allocatedVariance > 0
                        ? "text-rose-500 font-medium"
                        : "text-blue-400 font-medium",
                    ].join(" ")}
                  >
                    {r.allocatedVariance.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-surface-2/70">
                <td className="p-3 font-medium">TOTAL</td>
                <td className="p-3 text-right font-medium">
                  $
                  {recon.allocationByDept
                    .reduce((s, x) => s + x.awsActual, 0)
                    .toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </td>
                <td className="p-3" />
                <td className="p-3 text-right font-semibold">
                  {recon.allocationByDept
                    .reduce((s, x) => s + x.allocatedVariance, 0)
                    .toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}

/* =========================================================
   Insights
   ========================================================= */

function InsightsPanel({ rows }: { rows: UtilRow[] }) {
  // --- Aggregations we need ---
  const perDepartment = React.useMemo(() => {
    const m = new Map<string, { department: string; cost: number; fixed: number; variable: number; ncc: number }>();
    for (const r of rows) {
      const key = r.department;
      if (!m.has(key)) m.set(key, { department: key, cost: 0, fixed: 0, variable: 0, ncc: 0 });
      const { fixed, variable } = splitCost(r);
      const x = m.get(key)!;
      x.cost += r.cost; x.fixed += fixed; x.variable += variable; x.ncc += r.ncc;
    }
    return Array.from(m.values()).map((x) => ({
      ...x,
      variableShare: x.cost ? x.variable / x.cost : 0,
    }));
  }, [rows]);

  const perProject = React.useMemo(() => {
    const m = new Map<string, { key: string; department: string; project: string; cost: number; ncc: number; fixed: number; variable: number }>();
    for (const r of rows) {
      const key = `${r.department}||${r.project}`;
      if (!m.has(key)) m.set(key, { key, department: r.department, project: r.project, cost: 0, ncc: 0, fixed: 0, variable: 0 });
      const x = m.get(key)!;
      const { fixed, variable } = splitCost(r);
      x.cost += r.cost; x.ncc += r.ncc; x.fixed += fixed; x.variable += variable;
    }
    return Array.from(m.values()).map((x) => ({
      ...x,
      usdPerNcc: x.ncc ? x.cost / x.ncc : Infinity,
      variableShare: x.cost ? x.variable / x.cost : 0,
    }));
  }, [rows]);

  // --- Compute misallocation (simple) ---
  const variableHeavyDepartments = React.useMemo(
    () =>
      perDepartment
        .filter((d) => d.variableShare >= 0.7 && d.cost > 0)
        .sort((a, b) => b.variableShare - a.variableShare),
    [perDepartment]
  );

  const costlyProjects = React.useMemo(
    () =>
      perProject
        .filter((p) => isFinite(p.usdPerNcc) && p.cost > 500) // ignore tiny/degenerate
        .sort((a, b) => b.usdPerNcc - a.usdPerNcc)
        .slice(0, 6),
    [perProject]
  );

  // --- Customer pricing & margins (uses existing guardrail logic) ---
  const econ = React.useMemo(() => buildCustomerEconomics(rows), [rows]);
  const belowFloor = React.useMemo(
    () => econ.filter((e) => e.status === "FAIL").sort((a, b) => a.gmPct - b.gmPct).slice(0, 6),
    [econ]
  );
  const belowTarget = React.useMemo(
    () => econ.filter((e) => e.status === "WARN").sort((a, b) => a.gmPct - b.gmPct).slice(0, 6),
    [econ]
  );

  return (
    <div className="card p-5">
      <h3 className="text-lg font-semibold mb-3">Insights — Misallocation & Customer Margins</h3>

      {/* Compute Misallocation */}
      <div className="mb-4">
        <div className="flex items-center gap-2 mb-2">
          <span className="inline-flex h-2.5 w-2.5 rounded-full bg-blue-400" />
          <h4 className="font-medium">Variable-heavy departments (≥ 70% variable)</h4>
        </div>
        {variableHeavyDepartments.length === 0 ? (
          <p className="text-sm text-muted">No departments exceed the 70% variable threshold.</p>
        ) : (
          <ul className="text-sm list-disc pl-5 space-y-1">
            {variableHeavyDepartments.map((d) => (
              <li key={d.department}>
                <strong>{d.department}</strong>: {(d.variableShare * 100).toFixed(0)}% variable on $
                {d.cost.toLocaleString(undefined, { maximumFractionDigits: 0 })}.
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mb-4">
        <div className="flex items-center gap-2 mb-2">
          <span className="inline-flex h-2.5 w-2.5 rounded-full bg-slate-500" />
          <h4 className="font-medium">Projects with highest $/NCC</h4>
        </div>
        {costlyProjects.length === 0 ? (
          <p className="text-sm text-muted">No projects stand out on $/NCC.</p>
        ) : (
          <ul className="text-sm list-disc pl-5 space-y-1">
            {costlyProjects.map((p) => (
              <li key={p.key}>
                <strong>{p.department} — {p.project}</strong>: ${p.usdPerNcc.toFixed(3)}/NCC on $
                {p.cost.toLocaleString(undefined, { maximumFractionDigits: 0 })}.
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Customer pricing & margins */}
      <div className="mb-4">
        <div className="flex items-center gap-2 mb-2">
          <span className="inline-flex h-2.5 w-2.5 rounded-full bg-rose-500" />
          <h4 className="font-medium">Customers below margin floor</h4>
        </div>
        {belowFloor.length === 0 ? (
          <p className="text-sm text-muted">No customers are below the floor.</p>
        ) : (
          <ul className="text-sm list-disc pl-5 space-y-1">
            {belowFloor.map((c) => (
              <li key={c.customer}>
                <strong>{c.customer}</strong>: GM {(c.gmPct * 100).toFixed(1)}% (floor {(GUARDRAILS.floorGM * 100).toFixed(0)}%).
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <div className="flex items-center gap-2 mb-2">
          <span className="inline-flex h-2.5 w-2.5 rounded-full bg-amber-500" />
          <h4 className="font-medium">Customers below target (but above floor)</h4>
        </div>
        {belowTarget.length === 0 ? (
          <p className="text-sm text-muted">All customers are at or above target.</p>
        ) : (
          <ul className="text-sm list-disc pl-5 space-y-1">
            {belowTarget.map((c) => (
              <li key={c.customer}>
                <strong>{c.customer}</strong>: GM {(c.gmPct * 100).toFixed(1)}% (target {(GUARDRAILS.targetGM * 100).toFixed(0)}%).
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}


/* =========================================================
   Guardrails
   ========================================================= */

function nsDate(input: string | Date) {
  const d = new Date(input);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${mm}/${dd}/${yyyy}`;
}

const NS_ACCOUNTS = {
  cogs: "5000 COGS - Compute",
  expense: "6100 Compute Expense",
  depreciation: "6200 Depreciation - GPUs",
};
const NS_DEFAULTS = {
  subsidiary: "",
  location: "",
  class: "",
  currency: "USD",
};

function exportNetSuiteJournal(rows: UtilRow[], periodLabel: string) {
  const byDept = new Map<string, number>();
  let total = 0;
  for (const r of rows) {
    const v = byDept.get(r.department) || 0;
    byDept.set(r.department, v + r.cost);
    total += r.cost;
  }

  const externalId = `JE-COMPUTE-${periodLabel}`;
  const dateStr = nsDate(new Date());
  const memo = `Compute COGS allocation (${periodLabel})`;

  const rowsOut: Record<string, string | number>[] = [];

  for (const [department, amount] of Array.from(byDept.entries())) {
    if (!amount) continue;
    rowsOut.push({
      "External ID": externalId,
      Date: dateStr,
      Memo: memo,
      Subsidiary: NS_DEFAULTS.subsidiary,
      "Line Account": NS_ACCOUNTS.cogs,
      "Line Debit": +amount.toFixed(2),
      "Line Credit": "",
      "Line Department": department,
      "Line Class": NS_DEFAULTS.class,
      "Line Location": NS_DEFAULTS.location,
    });
  }

  rowsOut.push({
    "External ID": externalId,
    Date: dateStr,
    Memo: memo,
    Subsidiary: NS_DEFAULTS.subsidiary,
    "Line Account": NS_ACCOUNTS.expense,
    "Line Debit": "",
    "Line Credit": +total.toFixed(2),
    "Line Department": "",
    "Line Class": NS_DEFAULTS.class,
    "Line Location": NS_DEFAULTS.location,
  });

  const csv = toCSV(rowsOut as any[]);
  downloadBlob(
    `netsuite_journal_entry_${periodLabel}.csv`,
    new Blob([csv], { type: "text/csv" })
  );
}

function exportNetSuiteVendorBills(rows: UtilRow[], periodLabel: string) {
  const byVendor = new Map<UtilRow["vendor"], number>();
  for (const r of rows) byVendor.set(r.vendor, (byVendor.get(r.vendor) || 0) + r.cost);

  const vendorAccount: Record<string, string> = {
    AWS: NS_ACCOUNTS.expense,
    Coreweave: NS_ACCOUNTS.expense,
    OpenAI: NS_ACCOUNTS.expense,
    "On-Prem": NS_ACCOUNTS.depreciation,
  };

  const headers = [
    "External ID",
    "Vendor",
    "Date",
    "Account",
    "Amount",
    "Memo",
    "Department",
    "Class",
    "Location",
    "Currency",
  ];

  const dateStr = nsDate(new Date());
  const memo = `Compute spend summary (${periodLabel})`;
  const rowsOut: Record<string, string | number>[] = [];

  for (const [vendor, amount] of Array.from(byVendor.entries())) {
    if (!amount) continue;
    const externalId = `VB-COMPUTE-${vendor}-${periodLabel}`;
    rowsOut.push({
      "External ID": externalId,
      Vendor: vendor,
      Date: dateStr,
      Account: vendorAccount[vendor] || NS_ACCOUNTS.expense,
      Amount: +amount.toFixed(2),
      Memo: memo,
      Department: "",
      Class: NS_DEFAULTS.class,
      Location: NS_DEFAULTS.location,
      Currency: NS_DEFAULTS.currency,
    });
  }

  const csv = toCSV(rowsOut as any[]);
  downloadBlob(
    `netsuite_vendor_bills_${periodLabel}.csv`,
    new Blob([csv], { type: "text/csv" })
  );
}

function buildVarianceCsv(rows: UtilRow[]) {
  const intern = groupBy(
    rows.filter((r) => r.vendor === "AWS"),
    (r) => r.date
  );
  const byDayInternal = Object.entries(intern).map(([date, list]) => ({
    date,
    internalCost: +(
      (list as UtilRow[]).reduce((s, x) => s + x.cost, 0) as number
    ).toFixed(2),
  }));

  const cur = byDayInternal.map((d) => {
    const h = [...d.date].reduce((s, ch) => s + ch.charCodeAt(0), 0);
    const drift = 1 + ((h % 21) - 10) / 1000; // -1.0%..+1.0%
    const billed = +(d.internalCost * drift).toFixed(2);
    return { date: d.date, awsBilled: billed };
  });

  const map = new Map(cur.map((r) => [r.date, r.awsBilled]));
  const joined = byDayInternal.map((d) => {
    const awsBilled = map.get(d.date) ?? 0;
    const variance = +(awsBilled - d.internalCost).toFixed(2);
    const variancePct = d.internalCost
      ? +(((variance / d.internalCost) * 100).toFixed(2))
      : 0;
    const status = Math.abs(variancePct) < 1 ? "OK" : Math.abs(variancePct) < 3 ? "WARN" : "FAIL";
    return { date: d.date, internalCost: d.internalCost, awsBilled, variance, variancePct, status };
  });

  const csv = toCSV(joined as any[]);
  return { csv, joined };
}

function makeCfoSummaryPdf({
  periodLabel,
  kpis,
  topFindings,
}: {
  periodLabel: string;
  kpis: {
    revenue: number;
    cogs: number;
    gp: number;
    gmPct: number;
    fixed: number;
    variable: number;
  };
  topFindings: string[];
}) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const L = 54,
    W = 487;
  const title = `Compute — Month-End Close Summary (${periodLabel})`;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text(title, L, 72);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  const lines = [
    `Revenue (mock): $${kpis.revenue.toLocaleString()}`,
    `Compute COGS: $${kpis.cogs.toLocaleString()} (Fixed $${kpis.fixed.toLocaleString()} / Variable $${kpis.variable.toLocaleString()})`,
    `Gross Profit: $${kpis.gp.toLocaleString()}`,
    `Gross Margin: ${kpis.gmPct.toFixed(1)}%`,
  ];
  lines.forEach((t, i) => doc.text(t, L, 110 + i * 18));

  doc.setFont("helvetica", "bold");
  doc.text("Highlights & Actions", L, 190);
  doc.setFont("helvetica", "normal");
  const content = topFindings.length
    ? topFindings
    : ["No critical exceptions detected for this period."];
  let y = 210;
  content.forEach((t) => {
    const wrapped = doc.splitTextToSize(`• ${t}`, W);
    doc.text(wrapped, L, y);
    y += 16 * wrapped.length + 4;
  });

  return doc.output("blob");
}

/* =========================================================
   Customer Margin Guardrails
   ========================================================= */

const GUARDRAILS = {
  targetGM: 0.5,
  floorGM: 0.35,
};

function revenueFromCustomerCost(customer: string, cost: number) {
  const m = 0.15 + hash01(customer) * 0.4;
  return cost / (1 - m);
}

type CustomerEcon = {
  customer: string;
  cost: number;
  ncc: number;
  revenue: number;
  gmPct: number;
  pricePerNcc: number;
  cogsPerNcc: number;
  minPriceFloor: number;
  minPriceTarget: number;
  status: "OK" | "WARN" | "FAIL";
  rec: string;
};

function buildCustomerEconomics(rows: UtilRow[]): CustomerEcon[] {
  const m = new Map<string, { cost: number; ncc: number }>();
  for (const r of rows) {
    if (!r.customer) continue;
    const x = m.get(r.customer) || { cost: 0, ncc: 0 };
    x.cost += r.cost;
    x.ncc += r.ncc;
    m.set(r.customer, x);
  }

  const out: CustomerEcon[] = [];
  for (const [customer, v] of Array.from(m.entries())) {
    const revenue = revenueFromCustomerCost(customer, v.cost);
    const gmPct = revenue > 0 ? (revenue - v.cost) / revenue : 0;
    const cogsPerNcc = v.ncc ? v.cost / v.ncc : 0;
    const pricePerNcc = v.ncc ? revenue / v.ncc : 0;
    const minPriceFloor =
      GUARDRAILS.floorGM < 1 ? cogsPerNcc / (1 - GUARDRAILS.floorGM) : pricePerNcc;
    const minPriceTarget =
      GUARDRAILS.targetGM < 1 ? cogsPerNcc / (1 - GUARDRAILS.targetGM) : pricePerNcc;

    let status: CustomerEcon["status"] = "OK";
    if (gmPct < GUARDRAILS.floorGM) status = "FAIL";
    else if (gmPct < GUARDRAILS.targetGM) status = "WARN";

    let rec = "";
    if (status === "FAIL") {
      const uplift = minPriceFloor && pricePerNcc ? minPriceFloor / pricePerNcc - 1 : 0;
      rec = `Raise price floor by ${(uplift * 100).toFixed(0)}% or reduce COGS; enforce minimums/commits.`;
    } else if (status === "WARN") {
      const uplift = minPriceTarget && pricePerNcc ? minPriceTarget / pricePerNcc - 1 : 0;
      rec = `Tighten discounts (≈${(uplift * 100).toFixed(0)}% uplift) or migrate workload to cheaper GPUs/providers.`;
    } else {
      rec = "Within guardrails — monitor and preserve pricing power.";
    }

    out.push({
      customer,
      cost: +v.cost.toFixed(2),
      ncc: v.ncc,
      revenue: +revenue.toFixed(2),
      gmPct: +gmPct.toFixed(4),
      pricePerNcc: +pricePerNcc.toFixed(4),
      cogsPerNcc: +cogsPerNcc.toFixed(4),
      minPriceFloor: +minPriceFloor.toFixed(4),
      minPriceTarget: +minPriceTarget.toFixed(4),
      status,
      rec,
    });
  }

  return out.sort((a, b) => b.cost - a.cost);
}

function exportCustomerGuardrailsCsv(rows: UtilRow[], periodLabel: string) {
  const econ = buildCustomerEconomics(rows);
  const flat = econ.map((e) => ({
    Customer: e.customer,
    Revenue: e.revenue,
    COGS: e.cost,
    "GM %": +(e.gmPct * 100).toFixed(2),
    "Current $/NCC": e.pricePerNcc,
    "COGS $/NCC": e.cogsPerNcc,
    "Min $/NCC (Floor)": e.minPriceFloor,
    "Min $/NCC (Target)": e.minPriceTarget,
    Status: e.status,
    Recommendation: e.rec,
  }));
  const csv = toCSV(flat as any[]);
  downloadBlob(
    `customer_margin_guardrails_${periodLabel}.csv`,
    new Blob([csv], { type: "text/csv" })
  );
}

function CustomerMarginGuardrailsPanel({ rows }: { rows: UtilRow[] }) {
  const data = React.useMemo(() => buildCustomerEconomics(rows), [rows]);
  const top = data.slice(0, 10).map((d) => ({
    customer: d.customer,
    gmPct: +(d.gmPct * 100).toFixed(2),
    status: d.status,
  }));

  const colorForStatus = (gm: number) => {
    if (gm < GUARDRAILS.floorGM * 100) return "var(--chart-rose)";      // red
    if (gm < GUARDRAILS.targetGM * 100) return "var(--chart-slate)";     // steel warn
    return "var(--chart-blue)";                                          // blue ok
  };

  return (
    <div className="card p-5">
      <div className="flex items-start justify-between mb-3">
        <h3 className="text-lg font-semibold">Customer Margin Guardrails — Pricing Leverage</h3>
        <div className="text-sm text-muted">
          Target: {(GUARDRAILS.targetGM * 100).toFixed(0)}% • Floor: {(GUARDRAILS.floorGM * 100).toFixed(0)}%
        </div>
      </div>

      <div className="card p-4 mb-4">
        <h4 className="font-medium mb-2">Top Customers — Gross Margin %</h4>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={top}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-grid)" />
              <XAxis dataKey="customer" tick={{ fill: "var(--color-axis)" }} />
              <YAxis domain={[0, 100]} tick={{ fill: "var(--color-axis)" }} />
              <Tooltip />
              <Legend />
              <Bar dataKey="gmPct" name="GM %">
                {top.map((entry, idx) => (
                  <Cell key={idx} fill={colorForStatus(entry.gmPct)} />
                ))}
              </Bar>
              <ReferenceLine y={GUARDRAILS.floorGM * 100} stroke="var(--chart-rose)" strokeDasharray="3 3" label="Floor" />
              <ReferenceLine y={GUARDRAILS.targetGM * 100} stroke="var(--chart-blue)" strokeDasharray="3 3" label="Target" />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <p className="text-xs text-muted">Bars: blue ≥ target, steel between floor/target, red &lt; floor.</p>
      </div>

      <div className="overflow-auto card p-0">
        <table className="min-w-full text-sm">
          <thead className="bg-surface-2">
            <tr>
              <th className="text-left p-3">Customer</th>
              <th className="text-right p-3">Revenue ($)</th>
              <th className="text-right p-3">COGS ($)</th>
              <th className="text-right p-3">GM %</th>
              <th className="text-right p-3">Current $/NCC</th>
              <th className="text-right p-3">Min $/NCC (Floor)</th>
              <th className="text-right p-3">Min $/NCC (Target)</th>
              <th className="text-left p-3">Status</th>
              <th className="text-left p-3">Recommendation</th>
            </tr>
          </thead>
          <tbody>
            {data.map((e) => {
              const gmPct = e.gmPct * 100;
              const gmClass =
                gmPct < GUARDRAILS.floorGM * 100 ? "text-rose-500" :
                gmPct < GUARDRAILS.targetGM * 100 ? "text-slate-300" :
                "text-blue-400";
              return (
                <tr key={e.customer} className="border-t border-border/60">
                  <td className="p-3">{e.customer}</td>
                  <td className="p-3 text-right kpi">${e.revenue.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                  <td className="p-3 text-right kpi">${e.cost.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                  <td className={["p-3 text-right", gmClass].join(" ")}>{gmPct.toFixed(1)}%</td>
                  <td className="p-3 text-right kpi">${e.pricePerNcc.toFixed(4)}</td>
                  <td className="p-3 text-right kpi">${e.minPriceFloor.toFixed(4)}</td>
                  <td className="p-3 text-right kpi">${e.minPriceTarget.toFixed(4)}</td>
                  <td className="p-3">{e.status}</td>
                  <td className="p-3">{e.rec}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* =========================================================
   Benchmark + Idle Resale
   ========================================================= */

type BenchRow = { gpuType: string; spot: number; avg7d: number; spreadPct: number; vol7dPct: number };
type IdleResaleParams = {
  sellThroughPct: number;
  pricePctOfBenchmark: number;
  incrementalCostPerNcc: number;
  marketplaceFeePct: number;
};
type IdleResaleRow = {
  gpuType: string;
  idleNcc: number;
  resaleNcc: number;
  price: number;
  revenue: number;
  incrCost: number;
  fees: number;
  contribution: number;
};

const ONPREM_CAPACITY: Record<string, { rigs: number; nccPerRigPerDay: number }> = {
  "H100-80GB": { rigs: 8, nccPerRigPerDay: 12000 },
  "A100-80GB": { rigs: 12, nccPerRigPerDay: 9000 },
  "A100-40GB": { rigs: 10, nccPerRigPerDay: 6500 },
  "RTX-A6000": { rigs: 16, nccPerRigPerDay: 4000 },
};

function benchmarkFor(gpuType: string, shockMultiplier = 1): BenchRow {
  const h = hash01(gpuType);
  const base = 0.018 + h * 0.022;
  const drift = (hash01(gpuType + "7") - 0.5) * 0.004;
  const spot = +(Math.max(0, (base + drift) * shockMultiplier)).toFixed(4);
  const avg7d = +(Math.max(0, base * shockMultiplier)).toFixed(4);
  const spreadPct = +(0.02 + h * 0.03).toFixed(3);
  const vol7dPct = +(0.08 + h * 0.12).toFixed(3);
  return { gpuType, spot, avg7d, spreadPct, vol7dPct };
}

function aggregateOnPremNccByDayAndGpu(rows: UtilRow[]) {
  const used = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (r.vendor !== "On-Prem") continue;
    if (!used.has(r.date)) used.set(r.date, new Map());
    const m = used.get(r.date)!;
    m.set(r.gpuType, (m.get(r.gpuType) || 0) + r.ncc);
  }
  return used;
}

function buildIdleResaleModel(
  rows: UtilRow[],
  params: IdleResaleParams,
  shockPct = 0
): { byGpu: IdleResaleRow[]; totals: IdleResaleRow } {
  const byDay = aggregateOnPremNccByDayAndGpu(rows);
  const sumByGpu: Record<string, number> = {};

  for (const [, byGpu] of byDay.entries()) {
    for (const [gpu, usedNcc] of byGpu.entries()) {
      const capDef = ONPREM_CAPACITY[gpu];
      if (!capDef) continue;
      const cap = capDef.rigs * capDef.nccPerRigPerDay;
      const idle = Math.max(0, cap - usedNcc);
      sumByGpu[gpu] = (sumByGpu[gpu] || 0) + idle;
    }
    for (const gpu of Object.keys(ONPREM_CAPACITY)) {
      if (!byGpu.has(gpu)) {
        const capDef = ONPREM_CAPACITY[gpu];
        const cap = capDef.rigs * capDef.nccPerRigPerDay;
        sumByGpu[gpu] = (sumByGpu[gpu] || 0) + cap;
      }
    }
  }

  const rowsOut: IdleResaleRow[] = [];
  for (const gpu of Object.keys(ONPREM_CAPACITY)) {
    const idleNcc = Math.max(0, sumByGpu[gpu] || 0);
    const resaleNcc = idleNcc * params.sellThroughPct;
    const bench = benchmarkFor(gpu, 1 + shockPct);
    const price = bench.spot * params.pricePctOfBenchmark;
    const gross = resaleNcc * price;
    const fees = gross * params.marketplaceFeePct;
    const incrCost = resaleNcc * params.incrementalCostPerNcc;
    const contr = gross - incrCost - fees;

    rowsOut.push({
      gpuType: gpu,
      idleNcc: Math.round(idleNcc),
      resaleNcc: Math.round(resaleNcc),
      price: +price.toFixed(4),
      revenue: +gross.toFixed(2),
      incrCost: +incrCost.toFixed(2),
      fees: +fees.toFixed(2),
      contribution: +contr.toFixed(2),
    });
  }

  const totals: IdleResaleRow = rowsOut.reduce(
    (acc, r) => ({
      gpuType: "Total",
      idleNcc: acc.idleNcc + r.idleNcc,
      resaleNcc: acc.resaleNcc + r.resaleNcc,
      price: 0,
      revenue: +(acc.revenue + r.revenue).toFixed(2),
      incrCost: +(acc.incrCost + r.incrCost).toFixed(2),
      fees: +(acc.fees + r.fees).toFixed(2),
      contribution: +(acc.contribution + r.contribution).toFixed(2),
    }),
    { gpuType: "Total", idleNcc: 0, resaleNcc: 0, price: 0, revenue: 0, incrCost: 0, fees: 0, contribution: 0 }
  );

  rowsOut.sort((a, b) => b.contribution - a.contribution);
  return { byGpu: rowsOut, totals };
}

/* =========================================================
   Scenario Studio + Benchmark Panels
   ========================================================= */

function BenchmarkFeedPanel({ marketShockPct = 0 }: { marketShockPct?: number }) {
  const gpuTypes = Object.keys(ONPREM_CAPACITY);

  const feed = React.useMemo(() => {
    return gpuTypes.map((g) => {
      const b = benchmarkFor(g, 1 + marketShockPct);
      const cap = ONPREM_CAPACITY[g]?.nccPerRigPerDay ?? 0;
      const rigPerDay = +(b.spot * cap).toFixed(2);
      return { ...b, rigPerDay };
    });
  }, [gpuTypes, marketShockPct]);

  return (
    <div className="card p-5">
      <div className="flex items-start justify-between mb-3">
        <h3 className="text-lg font-semibold">Benchmark Feed — Absolute Price & $/NCC</h3>
        <div className="text-sm text-muted">
          Shock applied: <strong>{Math.round(marketShockPct * 100)}%</strong>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card p-4">
          <h4 className="font-medium mb-2">Spot vs 7-day Avg ($/NCC)</h4>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={feed}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-grid)" />
                <XAxis dataKey="gpuType" tick={{ fill: "var(--color-axis)" }} />
                <YAxis tick={{ fill: "var(--color-axis)" }} />
                <Tooltip />
                <Legend />
                <Bar dataKey="avg7d" name="Avg 7d $/NCC" fill="var(--chart-slate)" />
                <Bar dataKey="spot" name="Spot $/NCC" fill="var(--chart-blue)" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="card p-4">
          <h4 className="font-medium mb-2">Implied $/Rig/Day (Spot × Capacity)</h4>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={feed}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-grid)" />
                <XAxis dataKey="gpuType" tick={{ fill: "var(--color-axis)" }} />
                <YAxis tick={{ fill: "var(--color-axis)" }} />
                <Tooltip />
                <Legend />
                <Bar dataKey="rigPerDay" name="$ / Rig / Day" fill="var(--chart-blue)" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      <div className="overflow-auto card p-0 mt-4">
        <table className="min-w-full text-sm">
          <thead className="bg-surface-2">
            <tr>
              <th className="text-left p-3">GPU</th>
              <th className="text-right p-3">Spot $/NCC</th>
              <th className="text-right p-3">$ / Rig / Day</th>
              <th className="text-left p-3">Signal</th>
            </tr>
          </thead>
          <tbody>
            {feed
              .slice()
              .sort((a, b) => b.rigPerDay - a.rigPerDay)
              .map((r) => {
                const highVol = r.vol7dPct >= 0.16;
                const wideSpread = r.spreadPct >= 0.035;
                return (
                  <tr key={r.gpuType} className="border-t border-border/60">
                    <td className="p-3 font-medium">{r.gpuType}</td>
                    <td className="p-3 text-right kpi">${r.spot.toFixed(4)}</td>
                    <td className="p-3 text-right kpi">${r.rigPerDay.toLocaleString()}</td>
                    <td className="p-3">
                      <div className="flex flex-wrap gap-1">
                        {highVol && (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-rose-900/30 text-rose-300">
                            High Volatility
                          </span>
                        )}
                        {wideSpread && (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-rose-900/30 text-rose-300">
                            Wide Spread
                          </span>
                        )}
                        {!highVol && !wideSpread && (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-blue-900/30 text-blue-300">
                            Stable
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted mt-2">
        Sorted by daily $ impact per rig. “High Volatility” and “Wide Spread” flag risk (red). Stable signals are blue.
      </p>
    </div>
  );
}

/*** ScenarioStudioPanel — idle resale + market shock ***/
function ScenarioStudioPanel({
  params,
  onChange,
  marketShockPct,
  setMarketShockPct,
}: {
  params: {
    resale: {
      sellThroughPct: number;
      pricePctOfBenchmark: number;
      incrementalCostPerNcc: number;
      marketplaceFeePct: number;
    };
  };
  onChange: (p: {
    resale: {
      sellThroughPct: number;
      pricePctOfBenchmark: number;
      incrementalCostPerNcc: number;
      marketplaceFeePct: number;
    };
  }) => void;
  marketShockPct: number;
  setMarketShockPct: (v: number) => void;
}) {
  const update = (patch: Partial<typeof params>) => onChange({ ...params, ...(patch as any) });

  return (
    <div className="card p-5">
      <h3 className="text-lg font-semibold mb-3">Scenario Studio — Idle Compute Resale</h3>

      <div className="card p-4 mb-4">
        <h4 className="font-medium mb-2">Market Price Shock</h4>
        <p className="text-xs text-muted mb-2">
          Shift benchmark $/NCC spot & 7-day average (−30% .. +30%). Propagates to resale pricing.
        </p>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={-30}
            max={30}
            step={1}
            value={Math.round(marketShockPct * 100)}
            onChange={(e) => setMarketShockPct(parseInt(e.target.value) / 100)}
            className="w-full accent-blue-500"
            aria-label="Market price shock percent"
          />
          <div
            className={`text-sm w-20 text-right ${
              marketShockPct === 0 ? "text-muted" : marketShockPct > 0 ? "text-emerald-500" : "text-rose-500"
            }`}
          >
            {Math.round(marketShockPct * 100)}%
          </div>
        </div>
      </div>

      <div className="card p-4">
        <h4 className="font-medium mb-2">Resale Variables</h4>
        <p className="text-xs text-muted mb-3">
          Monetize on-prem idle NCC at a fraction of benchmark spot; contribution nets out marketplace fees and incremental $/NCC.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <label className="text-sm block">
            Sell-through %
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={Math.round(params.resale.sellThroughPct * 100)}
              onChange={(e) =>
                update({ resale: { ...params.resale, sellThroughPct: parseInt(e.target.value) / 100 } })
              }
              className="w-full accent-blue-500"
              aria-label="Sell through percentage"
            />
            <span className="text-xs text-muted">{Math.round(params.resale.sellThroughPct * 100)}% of idle NCC</span>
          </label>

          <label className="text-sm block">
            Price vs Spot %
            <input
              type="range"
              min={60}
              max={110}
              step={5}
              value={Math.round(params.resale.pricePctOfBenchmark * 100)}
              onChange={(e) =>
                update({ resale: { ...params.resale, pricePctOfBenchmark: parseInt(e.target.value) / 100 } })
              }
              className="w-full accent-blue-500"
              aria-label="Price vs spot percent"
            />
            <span className="text-xs text-muted">{Math.round(params.resale.pricePctOfBenchmark * 100)}% of spot</span>
          </label>

          <label className="text-sm block">
            Incremental $/NCC
            <input
              type="number"
              step="0.001"
              value={params.resale.incrementalCostPerNcc}
              onChange={(e) =>
                update({
                  resale: { ...params.resale, incrementalCostPerNcc: parseFloat(e.target.value || "0") },
                })
              }
              className="w-full rounded-xl border border-border bg-surface px-2 py-2"
              aria-label="Incremental dollars per NCC"
            />
            <span className="text-xs text-muted">Power/ops/egress</span>
          </label>

          <label className="text-sm block">
            Marketplace Fee %
            <input
              type="range"
              min={0}
              max={15}
              step={1}
              value={Math.round(params.resale.marketplaceFeePct * 100)}
              onChange={(e) =>
                update({ resale: { ...params.resale, marketplaceFeePct: parseInt(e.target.value) / 100 } })
              }
              className="w-full accent-blue-500"
              aria-label="Marketplace fee percent"
            />
            <span className="text-xs text-muted">
              {Math.round(params.resale.marketplaceFeePct * 100)}% of revenue
            </span>
          </label>
        </div>
      </div>
    </div>
  );
}

/* =========================================================
   Scenario (P&L) Engine
   ========================================================= */

type ScenarioParams = {
  priceUpliftWarnFailPct: number;
  reservedPctByVendor: Partial<Record<UtilRow["vendor"], number>>;
  vendorShift: { from: UtilRow["vendor"]; to: UtilRow["vendor"]; pct: number };
};

const COMMIT_DISCOUNT = 0.2;
const VENDOR_UNIT_INDEX: Record<UtilRow["vendor"], number> = {
  AWS: 1.0,
  Coreweave: 0.9,
  "On-Prem": 0.75,
  OpenAI: 1.1,
};

function computeBaselineKPIs(rows: UtilRow[]) {
  let revenue = 0,
    cogs = 0,
    fixed = 0,
    variable = 0;
  for (const r of rows) {
    const { fixed: f, variable: v } = splitCost(r);
    cogs += r.cost;
    fixed += f;
    variable += v;
    if (r.customer) {
      const m = 0.15 + hash01(r.customer) * 0.4;
      revenue += r.cost / (1 - m);
    }
  }
  const gp = revenue - cogs;
  const gmPct = revenue > 0 ? (gp / revenue) * 100 : 0;
  return {
    revenue: +revenue.toFixed(2),
    cogs: +cogs.toFixed(2),
    gp: +gp.toFixed(2),
    gmPct: +gmPct.toFixed(2),
    fixed: +fixed.toFixed(2),
    variable: +variable.toFixed(2),
  };
}

function runScenario(
  rows: UtilRow[],
  params: ScenarioParams & {
    resale?: IdleResaleParams;
    marketShockPct?: number; // propagates shock into resale pricing
  }
) {
  const baseline = computeBaselineKPIs(rows);

  // --- 1) Price uplift (WARN/FAIL customers) ---
  const econ = buildCustomerEconomics(rows);
  const upliftMap = new Map<string, number>();
  const priceUpliftFactor = 1 + params.priceUpliftWarnFailPct / 100;
  for (const e of econ) {
    upliftMap.set(e.customer, e.status === "WARN" || e.status === "FAIL" ? priceUpliftFactor : 1);
  }

  let revenueScenario = 0;
  for (const r of rows) {
    if (r.customer) {
      const baseRev = revenueFromCustomerCost(r.customer, r.cost);
      const factor = upliftMap.get(r.customer) ?? 1;
      revenueScenario += baseRev * factor;
    }
  }

  // --- 2) Variable cost by vendor + vendor shift + commit discounts ---
  const costByVendor: Record<UtilRow["vendor"], number> = {
    AWS: 0,
    Coreweave: 0,
    "On-Prem": 0,
    OpenAI: 0,
  };
  let fixedCost = 0;
  for (const r of rows) {
    const { fixed, variable } = splitCost(r);
    fixedCost += fixed;
    costByVendor[r.vendor] += variable;
  }

  // Vendor shift (price normalized to unit index)
  const shift = params.vendorShift;
  if (shift && shift.pct > 0 && shift.from !== shift.to) {
    const fromUnit = VENDOR_UNIT_INDEX[shift.from];
    const toUnit = VENDOR_UNIT_INDEX[shift.to];
    const moveBase = costByVendor[shift.from] * shift.pct;
    const movedPricedAtTo = moveBase * (toUnit / fromUnit);
    costByVendor[shift.from] -= moveBase;
    costByVendor[shift.to] += movedPricedAtTo;
  }

  // Commit discounts
  for (const v of Object.keys(costByVendor) as UtilRow["vendor"][]) {
    const reservedPct = params.reservedPctByVendor?.[v] ?? 0;
    const eligible = costByVendor[v];
    const discount = eligible * reservedPct * COMMIT_DISCOUNT;
    costByVendor[v] -= discount;
  }

  let variableScenario = Object.values(costByVendor).reduce((s, v) => s + v, 0);

  // --- 3) Idle resale impact (now affects P&L) ---
  let resaleTotals:
    | { revenue: number; incrCost: number; fees: number; contribution: number; resaleNcc: number }
    | null = null;

  if (params.resale) {
    const resaleModel = buildIdleResaleModel(
      rows,
      params.resale,
      params.marketShockPct ?? 0
    );
    resaleTotals = resaleModel.totals;
    // Add resale revenue to scenario revenue…
    revenueScenario += resaleTotals.revenue;
    // …and add resale incremental costs + marketplace fees to scenario COGS (all variable)
    variableScenario += resaleTotals.incrCost + resaleTotals.fees;
  }

  const cogsScenario = +(fixedCost + variableScenario).toFixed(2);
  const gpScenario = +(revenueScenario - cogsScenario).toFixed(2);
  const gmPctScenario = revenueScenario > 0 ? +(((gpScenario / revenueScenario) * 100).toFixed(2)) : 0;

  const deltas = {
    revenue: +(revenueScenario - baseline.revenue).toFixed(2),
    cogs: +(cogsScenario - baseline.cogs).toFixed(2),
    gp: +(gpScenario - baseline.gp).toFixed(2),
    gmPct: +(gmPctScenario - baseline.gmPct).toFixed(2),
  };

  return {
    baseline,
    scenario: {
      revenue: +revenueScenario.toFixed(2),
      cogs: cogsScenario,
      gp: gpScenario,
      gmPct: gmPctScenario,
      fixed: baseline.fixed, // fixed cost unchanged by knobs we model
      variable: +variableScenario.toFixed(2),
    },
    deltas,
    detail: {
      costByVendor,
      fixedCost,
      upliftMap,
      resaleTotals, // included for transparency in exports / debugging
    },
  };
}

/* =========================================================
   Simulation Outputs
   ========================================================= */

function SimulationOutputsPanel({
  rows,
  marketShockPct,
  params,
}: {
  rows: UtilRow[];
  marketShockPct: number;
  params: {
    priceUpliftWarnFailPct: number;
    reservedPctByVendor: Partial<Record<UtilRow["vendor"], number>>;
    vendorShift: { from: UtilRow["vendor"]; to: UtilRow["vendor"]; pct: number };
    resale: {
      sellThroughPct: number;
      pricePctOfBenchmark: number;
      incrementalCostPerNcc: number;
      marketplaceFeePct: number;
    };
  };
}) {
  // Scenario now incorporates resale + shock so any knob updates the P&L chart
  const scen = React.useMemo(
    () =>
      runScenario(rows, {
        priceUpliftWarnFailPct: params.priceUpliftWarnFailPct,
        reservedPctByVendor: params.reservedPctByVendor,
        vendorShift: params.vendorShift,
        resale: params.resale,
        marketShockPct,
      }),
    [rows, params, marketShockPct]
  );

  const resaleModel = React.useMemo(
    () =>
      buildIdleResaleModel(
        rows,
        {
          sellThroughPct: params.resale.sellThroughPct,
          pricePctOfBenchmark: params.resale.pricePctOfBenchmark,
          incrementalCostPerNcc: params.resale.incrementalCostPerNcc,
          marketplaceFeePct: params.resale.marketplaceFeePct,
        },
        marketShockPct
      ),
    [rows, params, marketShockPct]
  );

  const kpiBars = [
    { k: "Revenue", Baseline: scen.baseline.revenue, Scenario: scen.scenario.revenue },
    { k: "COGS", Baseline: scen.baseline.cogs, Scenario: scen.scenario.cogs },
    { k: "Gross Profit", Baseline: scen.baseline.gp, Scenario: scen.scenario.gp },
  ];

  return (
    <div className="card p-5">
      <h3 className="text-lg font-semibold mb-4">Simulation Outputs</h3>

      <div className="grid grid-cols-1 gap-6 mb-6">
        <div className="card p-4">
          <h4 className="font-medium mb-2">P&amp;L Impact — Baseline vs Scenario</h4>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={kpiBars}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-grid)" />
                <XAxis dataKey="k" tick={{ fill: "var(--color-axis)" }} />
                <YAxis tick={{ fill: "var(--color-axis)" }} />
                <Tooltip />
                <Legend />
                <Bar dataKey="Baseline" fill="var(--chart-slate)" />
                <Bar dataKey="Scenario" fill="var(--chart-emerald)" />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="text-xs text-muted mt-2">
            Δ Revenue: <strong>${scen.deltas.revenue.toLocaleString()}</strong> • Δ COGS:{" "}
            <strong>${scen.deltas.cogs.toLocaleString()}</strong> • Δ GP:{" "}
            <strong>${scen.deltas.gp.toLocaleString()}</strong> • Δ GM%:{" "}
            <strong>{scen.deltas.gmPct.toFixed(2)}%</strong>
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
        <div className="card p-3">
          <div className="text-xs text-muted">Total Contribution</div>
          <div className="text-lg font-semibold kpi">
            ${resaleModel.totals.contribution.toLocaleString()}
          </div>
        </div>
        <div className="card p-3">
          <div className="text-xs text-muted">Resale NCC</div>
          <div className="text-lg font-semibold kpi">
            {resaleModel.totals.resaleNcc.toLocaleString()}
            <span className="text-xs text-muted ml-1">NCC</span>
          </div>
        </div>
        <div className="card p-3">
          <div className="text-xs text-muted">Top Driver</div>
          <div className="text-sm">
            {resaleModel.byGpu.slice().sort((a, b) => b.contribution - a.contribution)[0]?.gpuType ?? "—"}
          </div>
        </div>
      </div>

      <div className="overflow-auto card p-0">
        <table className="min-w-full text-sm">
          <thead className="bg-surface-2">
            <tr>
              <th className="text-left p-3">GPU</th>
              <th className="text-right p-3">Contribution $</th>
              <th className="text-right p-3">Resale NCC</th>
              <th className="text-right p-3">Price $/NCC</th>
              <th className="text-left p-3">Why it matters</th>
            </tr>
          </thead>
          <tbody>
            {resaleModel.byGpu
              .slice()
              .sort((a, b) => b.contribution - a.contribution)
              .map((r) => {
                const priceLed = r.price >= 0.035;
                const story = priceLed
                  ? "High unit price drives profit — protect pricing."
                  : "Idle volume drives profit — focus sell-through.";
                return (
                  <tr key={r.gpuType} className="border-t border-border/60">
                    <td className="p-3 font-medium">{r.gpuType}</td>
                    <td className="p-3 text-right font-medium kpi">
                      ${r.contribution.toLocaleString()}
                    </td>
                    <td className="p-3 text-right kpi">{r.resaleNcc.toLocaleString()}</td>
                    <td className="p-3 text-right kpi">${r.price.toFixed(4)}</td>
                    <td className="p-3">{story}</td>
                  </tr>
                );
              })}
          </tbody>
          <tfoot>
            <tr className="bg-surface-2/70">
              <td className="p-3 font-medium">TOTAL</td>
              <td className="p-3 text-right font-semibold">
                ${resaleModel.totals.contribution.toLocaleString()}
              </td>
              <td className="p-3 text-right kpi">{resaleModel.totals.resaleNcc.toLocaleString()}</td>
              <td className="p-3"></td>
              <td className="p-3"></td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="mt-2 flex flex-wrap gap-2">
        <button
          onClick={() => {
            const period = `simulate_${Date.now()}`;
            exportScenarioBenchmarkResaleXLSX(rows, params, period, marketShockPct);
          }}
          className="btn"
          title="Export Scenario + Benchmark + Idle Resale workbook"
        >
          Export XLSX (Scenario + Benchmark + Resale)
        </button>
      </div>
    </div>
  );
}

function exportScenarioBenchmarkResaleXLSX(
  rows: UtilRow[],
  params: {
    priceUpliftWarnFailPct: number;
    reservedPctByVendor: Partial<Record<UtilRow["vendor"], number>>;
    vendorShift: { from: UtilRow["vendor"]; to: UtilRow["vendor"]; pct: number };
    resale: {
      sellThroughPct: number;
      pricePctOfBenchmark: number;
      incrementalCostPerNcc: number;
      marketplaceFeePct: number;
    };
  },
  periodLabel: string,
  marketShockPct = 0
) {
  // Scenario now includes resale impact + shock so summary matches UI chart
  const scen = runScenario(rows, {
    priceUpliftWarnFailPct: params.priceUpliftWarnFailPct,
    reservedPctByVendor: params.reservedPctByVendor,
    vendorShift: params.vendorShift,
    resale: params.resale,
    marketShockPct,
  });

  const scenarioSummary = [
    { Metric: "Revenue", Baseline: scen.baseline.revenue, Scenario: scen.scenario.revenue, Delta: scen.deltas.revenue },
    { Metric: "COGS", Baseline: scen.baseline.cogs, Scenario: scen.scenario.cogs, Delta: scen.deltas.cogs },
    { Metric: "Gross Profit", Baseline: scen.baseline.gp, Scenario: scen.scenario.gp, Delta: scen.deltas.gp },
    { Metric: "GM %", Baseline: scen.baseline.gmPct, Scenario: scen.scenario.gmPct, Delta: scen.deltas.gmPct },
  ];

  const scenarioVendors = Object.entries(scen.detail.costByVendor).map(([vendor, cost]) => ({
    Metric: `Vendor Variable Cost — ${vendor}`,
    Baseline: "",
    Scenario: cost,
    Delta: "",
  }));

  const gpuTypes = Object.keys(ONPREM_CAPACITY);
  const benchmarkFeed = gpuTypes.map((g) => {
    const b = benchmarkFor(g, 1 + marketShockPct);
    const cap = ONPREM_CAPACITY[g]?.nccPerRigPerDay ?? 0;
    const rigPerDay = +(b.spot * cap).toFixed(2);
    return {
      GPU: g,
      "Avg 7d $/NCC": b.avg7d,
      "Spot $/NCC": b.spot,
      "Spread %": b.spreadPct,
      "Vol 7d %": b.vol7dPct,
      "$ / Rig / Day": rigPerDay,
    };
  });

  const resaleModel = buildIdleResaleModel(
    rows,
    {
      sellThroughPct: params.resale.sellThroughPct,
      pricePctOfBenchmark: params.resale.pricePctOfBenchmark,
      incrementalCostPerNcc: params.resale.incrementalCostPerNcc,
      marketplaceFeePct: params.resale.marketplaceFeePct,
    },
    marketShockPct
  );

  const resaleRows = [
    ...resaleModel.byGpu.map((r) => ({
      "GPU Type": r.gpuType,
      "Idle NCC": r.idleNcc,
      "Resale NCC": r.resaleNcc,
      "Price $/NCC": r.price,
      "Revenue $": r.revenue,
      "Marketplace Fees $": r.fees,
      "Incremental Cost $": r.incrCost,
      "Contribution $": r.contribution,
    })),
    {
      "GPU Type": "TOTAL",
      "Idle NCC": resaleModel.totals.idleNcc,
      "Resale NCC": resaleModel.totals.resaleNcc,
      "Price $/NCC": "",
      "Revenue $": resaleModel.totals.revenue,
      "Marketplace Fees $": resaleModel.totals.fees,
      "Incremental Cost $": resaleModel.totals.incrCost,
      "Contribution $": resaleModel.totals.contribution,
    },
  ];

  const wb = XLSX.utils.book_new();

  const wsScenario = XLSX.utils.json_to_sheet(scenarioSummary);
  XLSX.utils.sheet_add_json(wsScenario, scenarioVendors, { origin: { r: scenarioSummary.length + 2, c: 0 } });
  XLSX.utils.book_append_sheet(wb, wsScenario, "Scenario");

  const wsBench = XLSX.utils.json_to_sheet(benchmarkFeed);
  XLSX.utils.book_append_sheet(wb, wsBench, "Benchmark");

  const wsResale = XLSX.utils.json_to_sheet(resaleRows);
  XLSX.utils.book_append_sheet(wb, wsResale, "Idle Resale");

  const filename = `scenario_benchmark_resale_${periodLabel}.xlsx`;
  const wbout = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  const blob = new Blob([wbout], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  saveAs(blob, filename);
}

/* =========================================================
   Top Bar (drop-in replacement)
   ========================================================= */

function TopBar({
  active,
  onChange,
}: {
  active: "compute" | "simulate";
  onChange: (tab: "compute" | "simulate") => void;
}) {
  const tabClass = (tab: "compute" | "simulate") =>
    [
      "relative px-3 sm:px-4 py-1.5 rounded-lg text-sm font-medium transition-all",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/40",
      active === tab
        ? [
            "text-white",
            "ring-1 ring-white/10",
            "bg-[linear-gradient(180deg,#1a2230_0%,#141b24_100%)]",
            "shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06),0_12px_30px_-16px_rgba(47,111,235,0.45)]",
          ].join(" ")
        : "text-muted hover:text-text hover:bg-white/5",
    ].join(" ");

  return (
    <div className="sticky top-0 z-30 mb-8">
      <div className="relative overflow-hidden rounded-2xl border border-[--color-blue]/35 backdrop-blur-xl">
        {/* Steel header stripe */}
        <div className="absolute inset-x-0 -top-px h-px bg-gradient-to-r from-transparent via-[--color-blue] to-transparent opacity-70" />
        {/* Bar content */}
        <div className="relative px-4 sm:px-5 py-3 sm:py-4 bg-[linear-gradient(180deg,#0f141a_0%,#0e1217_100%)]">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="font-semibold leading-tight truncate">Nora</div>
              <div className="text-[11px] text-muted -mt-0.5">Compute Finance Intelligence</div>
            </div>

            {/* Segmented control */}
            <div
              role="tablist"
              aria-label="Primary views"
              className="relative inline-flex items-center gap-1 rounded-xl p-1 border border-[--color-blue]/35 bg-white/5 dark:bg-black/10"
            >
              <button
                role="tab"
                aria-selected={active === "compute"}
                className={tabClass("compute")}
                onClick={() => onChange("compute")}
                title="Compute Spend"
              >
                <span className="hidden sm:inline">Compute Spend</span>
                <span className="sm:hidden">Spend</span>
                {active === "compute" && (
                  <span aria-hidden className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-[--color-blue] ring-2 ring-[--color-surface]" />
                )}
              </button>

              <button
                role="tab"
                aria-selected={active === "simulate"}
                className={tabClass("simulate")}
                onClick={() => onChange("simulate")}
                title="Compute Market Simulation"
              >
                <span className="hidden sm:inline">Compute Market Simulation</span>
                <span className="sm:hidden">Simulation</span>
                {active === "simulate" && (
                  <span aria-hidden className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-[--color-blue] ring-2 ring-[--color-surface]" />
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ChatBar({
  query,
  setQuery,
  onGo,
  onInsights,
  suggested,
  seed,
  setSeed,
}: {
  query: string;
  setQuery: (v: string) => void;
  onGo: () => void;
  onInsights: () => void;
  suggested: string[];
  seed: number;
  setSeed: React.Dispatch<React.SetStateAction<number>>;
}) {
  const [isLoading, setIsLoading] = React.useState(false);
  const [progress, setProgress] = React.useState(0);
  const prevQueryRef = React.useRef<string>("");
  const timersRef = React.useRef<number[]>([]);

  // Build 2–3 relevant "activity" messages based on the current query and action
  function activityScriptsForQuery(q: string, mode: "ask" | "insights"): string[] {
    const s = q.toLowerCase();
    const isDept = s.includes("department") || s.includes("compute spend");
    const isCust = s.includes("customer") || s.includes("spend more compute");
    const isRecon = s.includes("reconciliation") || s.includes("aws") || s.includes("internal");
    const isGuard = s.includes("guardrails") || s.includes("pricing leverage") || s.includes("margin");

    const vendorHint =
      s.includes("aws") ? "AWS bill" :
      s.includes("coreweave") ? "CoreWeave usage" :
      s.includes("openai") ? "OpenAI invoice" :
      "provider feeds";

    if (mode === "insights") {
      return [
        "scanning for $/NCC outliers…",
        "flagging variable-heavy departments…",
        "ranking inefficient projects…",
      ];
    }

    if (isRecon) {
      return [
        `fetching latest ${vendorHint}…`,
        "joining with internal utilization ledger…",
        "checking variance thresholds…",
      ];
    }
    if (isCust) {
      return [
        "ranking customers by compute spend…",
        "computing unit economics ($/NCC)…",
        "splitting fixed vs variable COGS…",
      ];
    }
    if (isGuard) {
      return [
        "computing gross margin per customer…",
        "applying pricing guardrails…",
        "building recommendations…",
      ];
    }
    if (isDept) {
      return [
        "aggregating NCC by department & project…",
        "splitting fixed vs variable spend…",
        "rendering stacked bars…",
      ];
    }
    // Generic
    return [
      "hydrating utilization rows…",
      `fetching ${vendorHint}…`,
      "warming chart engines…",
    ];
  }

  function startLoadingThen(action: "ask" | "insights") {
    if (isLoading) return;

    const scripts = activityScriptsForQuery(query, action === "ask" ? "ask" : "insights");
    prevQueryRef.current = query;
    setIsLoading(true);
    setProgress(0);

    // Disable input & cycle messages by temporarily writing into the input
    const totalMs = 5000; // ⏱️ 5 seconds
    const stepMs = 90; // progress resolution
    const msgMs = Math.floor(totalMs / scripts.length);

    // Kick off first message
    setQuery(`⏳ ${scripts[0]}`);

    // Progress ticker
    const progId = window.setInterval(() => {
      setProgress((p) => Math.min(100, p + (100 * stepMs) / totalMs));
    }, stepMs);
    timersRef.current.push(progId);

    // Message rotator
    scripts.slice(1).forEach((msg, i) => {
      const id = window.setTimeout(() => setQuery(`⏳ ${msg}`), msgMs * (i + 1));
      timersRef.current.push(id);
    });

    // Finish after 5s: restore query, clear timers, call the original action
    const doneId = window.setTimeout(() => {
      timersRef.current.forEach((t) => clearInterval(t) || clearTimeout(t));
      timersRef.current = [];

      setIsLoading(false);
      setProgress(100);
      setQuery(prevQueryRef.current);

      window.setTimeout(() => {
        setProgress(0);
        if (action === "ask") onGo();
        else onInsights();
      }, 60);
    }, totalMs);
    timersRef.current.push(doneId);
  }

  // Clean up on unmount
  React.useEffect(() => {
    return () => {
      timersRef.current.forEach((t) => clearInterval(t) || clearTimeout(t));
      timersRef.current = [];
    };
  }, []);

  const runAsk = () => startLoadingThen("ask");
  const runInsights = () => startLoadingThen("insights");

  return (
    <div className="mb-6">
      <div
        className={[
          "relative rounded-2xl border border-[--color-blue]/30",
          "bg-gradient-to-b from-[--color-surface-2] to-[--color-surface]",
          "shadow-[0_12px_40px_-8px_rgba(59,130,246,0.25)]",
          "backdrop-blur p-3"
        ].join(" ")}
      >
        {/* Top progress bar (subtle) */}
        <div
          aria-hidden
          className="absolute left-0 top-0 h-0.5 rounded-t-2xl bg-[--color-blue] transition-[width] duration-75"
          style={{ width: isLoading ? `${progress}%` : "0%" }}
        />

        {/* Input row with integrated action */}
        <div className="flex items-center gap-3">
          <span aria-hidden className="select-none text-xl">💬</span>
          <input
            className="flex-1 bg-transparent placeholder:text-muted px-2 py-2 text-base outline-none disabled:opacity-70"
            placeholder="Type a question or click a quick prompt…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => !isLoading && e.key === "Enter" && runAsk()}
            aria-label="Ask a question"
            disabled={isLoading}
          />
          <button
            onClick={runAsk}
            disabled={isLoading}
            className={[
              "inline-flex items-center gap-2 rounded-xl px-4 py-2",
              "bg-[--color-blue] text-white font-medium",
              "shadow-lg shadow-blue-500/20 hover:shadow-blue-500/30",
              "focus-visible:ring-2 focus-visible:ring-blue-400/40",
              isLoading ? "opacity-80 cursor-not-allowed" : ""
            ].join(" ")}
            title="Run"
          >
            {isLoading ? (
              <>
                <span className="h-4 w-4 inline-block rounded-full border-2 border-white/70 border-t-transparent animate-spin" />
                Working…
              </>
            ) : (
              "Ask"
            )}
          </button>
          <button
            onClick={runInsights}
            disabled={isLoading}
            className={[
              "inline-flex items-center gap-2 rounded-xl px-4 py-2",
              "bg-[--color-blue] text-white font-medium",
              "shadow-lg shadow-blue-500/20 hover:shadow-blue-500/30",
              "focus-visible:ring-2 focus-visible:ring-blue-400/40",
              isLoading ? "opacity-80 cursor-not-allowed" : ""
            ].join(" ")}
            title="Reveal optimization insights and guardrails"
          >
            {isLoading ? (
              <>
                <span className="h-4 w-4 inline-block rounded-full border-2 border-white/70 border-t-transparent animate-spin" />
                Working…
              </>
            ) : (
              <>✨ Find Compute Insights</>
            )}
          </button>
        </div>

        {/* Quick prompts as chips (not buttons) */}
        <div className="mt-3 flex flex-wrap gap-2">
          {suggested.map((s, i) => (
            <button
              key={i}
              onClick={() => !isLoading && setQuery(s)}
              className={[
                "inline-flex items-center rounded-full",
                "border border-[--color-blue]/25 bg-surface-2/60",
                "px-3 py-1 text-xs text-muted hover:text-text hover:border-[--color-blue]/40",
                "transition",
                isLoading ? "opacity-60 cursor-not-allowed" : ""
              ].join(" ")}
              title="Use this prompt"
              disabled={isLoading}
            >
              {s}
            </button>
          ))}
        </div>

        {/* Secondary actions row */}
        <div className="mt-3 flex items-center gap-3">
          <details className="ml-auto relative text-sm">
            <summary className="cursor-pointer inline-flex items-center gap-2 rounded-full border border-border bg-surface-2 px-3 py-1 hover:bg-surface select-none">
              Advanced
            </summary>
            <div className="absolute right-0 mt-2 w-80 rounded-xl border border-border bg-surface-2 p-3 shadow-xl z-10">
              <div className="flex items-center gap-2">
                <label className="text-xs text-muted w-20">Seed</label>
                <input
                  type="number"
                  value={seed}
                  onChange={(e) => setSeed(parseInt(e.target.value || "0", 10))}
                  className="w-28 rounded-xl border border-border bg-surface px-3 py-2"
                  placeholder="Seed"
                  title="Seed for deterministic data"
                  disabled={isLoading}
                />
                <button
                  onClick={() => setSeed((s) => s + 1)}
                  className={[
                    "rounded-xl px-3 py-2 border border-border bg-surface hover:bg-surface-2",
                    isLoading ? "opacity-60 cursor-not-allowed" : ""
                  ].join(" ")}
                  title="Regenerate data"
                  disabled={isLoading}
                >
                  Regenerate
                </button>
              </div>
              <p className="mt-2 text-xs text-muted">
                Seed controls deterministic mock data for the last 30 days.
              </p>
            </div>
          </details>
        </div>

        {/* Screen-reader live region for activity updates */}
        <div className="sr-only" aria-live="polite">
          {isLoading ? "Working on your request…" : ""}
        </div>
      </div>
    </div>
  );
}

/* ========= Timespan helpers ========= */

type Timespan =
  | { mode: "last"; days: number }
  | { mode: "range"; start: string; end: string };

function iso(d: Date) {
  return d.toISOString().slice(0, 10);
}

function addDays(isoDate: string, delta: number) {
  const d = new Date(isoDate + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + delta);
  return iso(d);
}

function clampIso(date: string, minIso: string, maxIso: string) {
  if (date < minIso) return minIso;
  if (date > maxIso) return maxIso;
  return date;
}

function getBounds(rows: UtilRow[]) {
  if (!rows.length) return { min: "", max: "" };
  let min = rows[0].date, max = rows[0].date;
  for (const r of rows) {
    if (r.date < min) min = r.date;
    if (r.date > max) max = r.date;
  }
  return { min, max };
}

function periodLabelFromTimespan(ts: Timespan, bounds: { min: string; max: string }, seed: number) {
  if (ts.mode === "last") return `last_${ts.days}_days_seed_${seed}`;
  return `from_${ts.start}_to_${ts.end}_seed_${seed}`;
}

function filterRowsByTimespan(
  rows: UtilRow[],
  ts: Timespan,
  bounds: { min: string; max: string }
) {
  if (!rows.length) return rows;
  const { min: minIso, max: maxIso } = bounds;

  let start = minIso, end = maxIso;

  if (ts.mode === "last") {
    // use the data’s latest date as “today” anchor so mock data stays deterministic
    end = maxIso;
    start = addDays(end, -(ts.days - 1));
    if (start < minIso) start = minIso;
  } else {
    start = clampIso(ts.start, minIso, maxIso);
    end = clampIso(ts.end, start, maxIso); // ensure start <= end and within bounds
  }

  return rows.filter((r) => r.date >= start && r.date <= end);
}

/* ========= UI: TimespanFilter ========= */

function TimespanFilter({
  bounds,
  value,
  onChange,
  className = "",
}: {
  bounds: { min: string; max: string };
  value: Timespan;
  onChange: (v: Timespan) => void;
  className?: string;
}) {
  const showing =
    value.mode === "last"
      ? { start: addDays(bounds.max, -(value.days - 1)) < bounds.min ? bounds.min : addDays(bounds.max, -(value.days - 1)), end: bounds.max }
      : { start: value.start, end: value.end };

  const daysOptions = [7, 14, 30, 60, 90];

  return (
    <div className={["card p-4 mb-4", className].join(" ")}>
      <div className="flex flex-col md:flex-row md:items-end gap-3">
        {/* Mode: Last N days */}
        <div className="flex-1">
          <label className="text-xs text-muted block mb-1">Quick range</label>
          <div className="flex items-center gap-2">
            <select
              value={value.mode === "last" ? value.days : ""}
              onChange={(e) => {
                const v = parseInt(e.target.value || "30", 10);
                onChange({ mode: "last", days: isNaN(v) ? 30 : v });
              }}
              className="rounded-xl border border-border bg-surface px-3 py-2 w-36"
              aria-label="Last N days"
            >
              {daysOptions.map((d) => (
                <option key={d} value={d}>
                  Last {d} days
                </option>
              ))}
            </select>
            <button
              onClick={() => onChange({ mode: "last", days: 30 })}
              className="btn"
              title="Reset to last 30 days"
            >
              Reset
            </button>
          </div>
          <p className="text-xs text-muted mt-1">
            Data available: <strong>{bounds.min}</strong> → <strong>{bounds.max}</strong>
          </p>
        </div>

        {/* Mode: Custom range */}
        <div className="flex-1">
          <label className="text-xs text-muted block mb-1">Custom range</label>
          <div className="flex items-center gap-2">
            <input
              type="date"
              min={bounds.min}
              max={bounds.max}
              value={value.mode === "range" ? value.start : addDays(bounds.max, -29)}
              onChange={(e) => {
                const start = clampIso(e.target.value, bounds.min, bounds.max);
                const end =
                  value.mode === "range"
                    ? clampIso(value.end, start, bounds.max)
                    : clampIso(bounds.max, start, bounds.max);
                onChange({ mode: "range", start, end });
              }}
              className="rounded-xl border border-border bg-surface px-3 py-2"
              aria-label="Start date"
            />
            <span className="text-sm text-muted">to</span>
            <input
              type="date"
              min={bounds.min}
              max={bounds.max}
              value={value.mode === "range" ? value.end : bounds.max}
              onChange={(e) => {
                const end = clampIso(e.target.value, bounds.min, bounds.max);
                const start =
                  value.mode === "range"
                    ? clampIso(value.start, bounds.min, end)
                    : clampIso(addDays(end, -29), bounds.min, end);
                onChange({ mode: "range", start, end });
              }}
              className="rounded-xl border border-border bg-surface px-3 py-2"
              aria-label="End date"
            />
          </div>
        </div>

        {/* Display */}
        <div className="md:w-64">
          <div className="text-xs text-muted mb-1">Showing</div>
          <div className="rounded-xl border border-border bg-surface px-3 py-2">
            <div className="text-sm">
              {showing.start} → {showing.end}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** =========================================================
 * Budget vs AWS Billing reconciliation + variance allocation
 * ========================================================= */
function computeAwsBudgetReconciliation(rows: UtilRow[]) {
  // 1) Aggregate AWS internal usage by day (serves as the anchor for mock budget/billing)
  const awsDaily = groupBy(
    rows.filter((r) => r.vendor === "AWS"),
    (r) => r.date
  );
  const byDayBase = Object.entries(awsDaily).map(([date, list]) => {
    const internal = +(list as UtilRow[]).reduce((s, x) => s + x.cost, 0).toFixed(2);
    return { date, internal };
  });

  // 2) Deterministic "budget" (plan) and "AWS billed" (actual)
  //    Budget: internal * (0.95 .. 1.05), Billed: internal * (0.98 .. 1.02)
  const byDay = byDayBase.map((d) => {
    const fBudget = 0.95 + hash01("budget" + d.date) * 0.10; // ±5%
    const fBilled = 0.98 + (hash01("billed" + d.date) - 0.5) * 0.04; // ±2%
    const budget = +(d.internal * fBudget).toFixed(2);
    const awsBilled = +(d.internal * fBilled).toFixed(2);
    const variance = +(awsBilled - budget).toFixed(2);
    const variancePct = budget ? +(((variance / budget) * 100).toFixed(2)) : 0;
    const status =
      Math.abs(variancePct) < 1 ? "✅" : Math.abs(variancePct) < 3 ? "⚠️" : "❌";
    return { date: d.date, budget, awsBilled, variance, variancePct, status };
  });

  // 3) Variance allocation — pro-rata by each department’s share of AWS actual per day
  //    Also collect total AWS actual per department across the period for context.
  const allocationMap = new Map<
    string,
    { department: string; awsActual: number; allocatedVariance: number }
  >();

  for (const day of byDay) {
    const list = (awsDaily[day.date] || []) as UtilRow[];
    const byDept = groupBy(list, (r) => r.department);
    const totalAwsDay = list.reduce((s, x) => s + x.cost, 0);

    for (const [department, items] of Object.entries(byDept)) {
      const deptActual = (items as UtilRow[]).reduce((s, x) => s + x.cost, 0);
      const share = totalAwsDay > 0 ? deptActual / totalAwsDay : 0;
      const alloc = day.variance * share;

      const curr =
        allocationMap.get(department) ||
        { department, awsActual: 0, allocatedVariance: 0 };
      curr.awsActual += deptActual;
      curr.allocatedVariance += alloc;
      allocationMap.set(department, curr);
    }
  }

  const allocationByDept = Array.from(allocationMap.values())
    .map((x) => ({
      department: x.department,
      awsActual: +x.awsActual.toFixed(2),
      allocatedVariance: +x.allocatedVariance.toFixed(2),
      sharePct: x.awsActual > 0
        ? +(((x.awsActual) /
            Array.from(allocationMap.values()).reduce((s, y) => s + y.awsActual, 0)) *
            100).toFixed(2)
        : 0,
    }))
    .sort((a, b) => Math.abs(b.allocatedVariance) - Math.abs(a.allocatedVariance));

  // 4) Totals
  const totals = {
    budget: +byDay.reduce((s, x) => s + x.budget, 0).toFixed(2),
    awsBilled: +byDay.reduce((s, x) => s + x.awsBilled, 0).toFixed(2),
    variance: +byDay.reduce((s, x) => s + x.variance, 0).toFixed(2),
  };

  return { byDay, allocationByDept, totals };
}

/* =========================================================
   App
   ========================================================= */

export default function App() {
  const [activeTab, setActiveTab] = useState<"compute" | "simulate">("compute");
  const [showInsights, setShowInsights] = useState(false);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<ReportKind | null>(null);

  // Generate a wider history so the timespan filter can slice freely
  const [seed, setSeed] = useState<number>(1337);
  const [allDays] = useState(180); // was fixed 30; now we keep 6 months of mock data
  const allRows = useMemo(() => makeMockRows(allDays, seed), [allDays, seed]);
  const bounds = useMemo(() => getBounds(allRows), [allRows]);

  // Timespan state (default: last 30 days)
  const [timespan, setTimespan] = useState<Timespan>({ mode: "last", days: 30 });
  const viewRows = useMemo(() => filterRowsByTimespan(allRows, timespan, bounds), [allRows, timespan, bounds]);

  const [marketShockPct, setMarketShockPct] = useState(0);
  const actionsRef = useRef<HTMLDivElement>(null);

  const [scenarioParams, setScenarioParams] = useState({
    priceUpliftWarnFailPct: 8,
    reservedPctByVendor: { AWS: 0.4, Coreweave: 0.3, OpenAI: 0.2 } as Partial<
      Record<UtilRow["vendor"], number>
    >,
    vendorShift: { from: "AWS" as UtilRow["vendor"], to: "Coreweave" as UtilRow["vendor"], pct: 0.2 },
    resale: {
      sellThroughPct: 0.6,
      pricePctOfBenchmark: 0.9,
      incrementalCostPerNcc: 0.003,
      marketplaceFeePct: 0.05,
    },
  });

  function detectIntent(q: string): ReportKind | null {
    const s = q.toLowerCase();
    if (s.includes("compute spend") || s.includes("department")) return "spendByDeptProject";
    if (s.includes("customers") || s.includes("spend more compute")) return "topCustomers";
    if (s.includes("reconciliation") || s.includes("aws") || s.includes("internal")) return "reconcileAwsInternal";
    if (s.includes("guardrails") || s.includes("pricing leverage") || s.includes("margin guardrails"))
      return "customerGuardrails";
    return null;
  }

  function run() {
    const k = detectIntent(query);
    setKind(k);
    setShowInsights(false);
  }

  function revealInsightsOnly() {
    setShowInsights(true);
    setKind(null);
  }

  // Derive a period label that matches the visible slice
  const periodLabel = useMemo(
    () => periodLabelFromTimespan(timespan, bounds, seed),
    [timespan, bounds, seed]
  );

  function exportCurrent(format: "csv" | "json") {
    const rows = viewRows; // use filtered slice everywhere below
    let data: any[] = [];
    if (kind === "spendByDeptProject") {
      const byKey: Record<string, any> = {};
      rows.forEach((r) => {
        const k = `${r.department}||${r.project}`;
        const { fixed, variable } = splitCost(r);
        if (!byKey[k])
          byKey[k] = {
            department: r.department,
            project: r.project,
            ncc: 0,
            costFixed: 0,
            costVariable: 0,
            cost: 0,
          };
        byKey[k].ncc += r.ncc;
        byKey[k].costFixed += fixed;
        byKey[k].costVariable += variable;
        byKey[k].cost += r.cost;
      });
      data = Object.values(byKey).map((x: any) => ({
        ...x,
        costFixed: +x.costFixed.toFixed(2),
        costVariable: +x.costVariable.toFixed(2),
        cost: +x.cost.toFixed(2),
      }));
    } else if (kind === "topCustomers") {
      const map: Record<string, any> = {};
      rows
        .filter((r) => r.customer)
        .forEach((r) => {
          const { fixed, variable } = splitCost(r);
          const k = r.customer!;
          if (!map[k]) map[k] = { customer: k, ncc: 0, costFixed: 0, costVariable: 0, cost: 0 };
          map[k].ncc += r.ncc;
          map[k].costFixed += fixed;
          map[k].costVariable += variable;
          map[k].cost += r.cost;
        });
      data = Object.values(map).map((x: any) => ({
        ...x,
        costFixed: +x.costFixed.toFixed(2),
        costVariable: +x.costVariable.toFixed(2),
        cost: +x.cost.toFixed(2),
      }));
    } else if (kind === "reconcileAwsInternal") {
      const recon = computeAwsBudgetReconciliation(rows);
      // Export the daily reconciliation view
      data = recon.byDay.map((d) => ({
        date: d.date,
        budget: d.budget,
        awsBilled: d.awsBilled,
        difference: d.variance,
        differencePct: d.variancePct,
        status: d.status,
      }));
    } else if (kind === "customerGuardrails") {
      const econ = buildCustomerEconomics(rows);
      data = econ.map((e) => ({
        customer: e.customer,
        revenue: e.revenue,
        cogs: e.cost,
        gmPct: +(e.gmPct * 100).toFixed(2),
        pricePerNcc: e.pricePerNcc,
        cogsPerNcc: e.cogsPerNcc,
        minPriceFloor: e.minPriceFloor,
        minPriceTarget: e.minPriceTarget,
        status: e.status,
        recommendation: e.rec,
      }));
    } else {
      data = rows;
    }
    const filenameBase = (kind ?? "report") + "_" + periodLabel;
    if (format === "json") {
      downloadBlob(
        `${filenameBase}.json`,
        new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
      );
    } else {
      downloadBlob(`${filenameBase}.csv`, new Blob([toCSV(data)], { type: "text/csv" }));
    }
  }

  function printReport() {
    window.print();
  }

  const suggested = [
    "Show me compute spend by department and project",
    "Show me who are the customers that spend more compute",
    "Do the reconciliation between AWS billing and internal data",
    "Show customer margin guardrails and pricing leverage",
  ];

  React.useEffect(() => {
    if (activeTab !== "compute") setShowInsights(false);
  }, [activeTab]);

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-background/60 text-text">
      <div className="mx-auto max-w-6xl px-4 py-6">
        <TopBar active={activeTab} onChange={setActiveTab} />

        {activeTab === "compute" && (
          <>
            <header className="mb-6">
              <h1 className="sr-only">Compute Finance Demo</h1>
            </header>

            <ChatBar
              query={query}
              setQuery={setQuery}
              onGo={run}
              onInsights={revealInsightsOnly}
              suggested={suggested}
              seed={seed}
              setSeed={setSeed}
            />

            {/* Show timespan control only after the user runs a prompt or reveals insights */}
            {(kind || showInsights) && (
              <TimespanFilter
                bounds={bounds}
                value={timespan}
                onChange={setTimespan}
                className="print:hidden"
              />
            )}

            {showInsights && (
              <div className="mb-6">
                <InsightsPanel rows={viewRows} />
              </div>
            )}

            {kind && (
              <div className="flex flex-wrap gap-2 mb-4 print:hidden items-center">
                <button onClick={() => exportCurrent("csv")} className="btn">
                  Export CSV
                </button>
                <button onClick={() => exportCurrent("json")} className="btn">
                  Export JSON
                </button>
                <button onClick={printReport} className="btn">
                  Print / Save PDF
                </button>

                <span className="mx-2 text-muted">|</span>

                <button
                  onClick={() => {
                    exportNetSuiteJournal(viewRows, periodLabel);
                  }}
                  className="btn"
                  title="CSV for NetSuite Journal Entry import"
                >
                  NetSuite: Journal Entry CSV
                </button>
                <button
                  onClick={() => {
                    exportNetSuiteVendorBills(viewRows, periodLabel);
                  }}
                  className="btn"
                  title="CSV for NetSuite Vendor Bill import"
                >
                  NetSuite: Vendor Bills CSV
                </button>
              </div>
            )}

            {!kind && !showInsights && (
              <div className="card border-dashed p-8 text-muted">
                Pick a suggested prompt, then press <strong className="text-text">Go</strong>. Or press{" "}
                <strong className="text-text">Find Compute Insights</strong> to reveal optimization and margin sections.
              </div>
            )}

            {kind === "spendByDeptProject" && (
              <ReportShell title="Compute Spend by Department & Project" actionsRef={actionsRef}>
                <SpendByDeptProject rows={viewRows} />
              </ReportShell>
            )}
            {kind === "topCustomers" && (
              <ReportShell title="Top Customers by Compute Consumption" actionsRef={actionsRef}>
                <TopCustomers rows={viewRows} />
              </ReportShell>
            )}
            {kind === "reconcileAwsInternal" && (
              <ReportShell title="AWS Billing vs Internal Ledger — Reconciliation" actionsRef={actionsRef}>
                <ReconcileAwsInternal rows={viewRows} />
              </ReportShell>
            )}
            {kind === "customerGuardrails" && (
              <ReportShell title="Customer Margin Guardrails — Pricing Leverage" actionsRef={actionsRef}>
                <CustomerMarginGuardrailsPanel rows={viewRows} />
              </ReportShell>
            )}

            <footer className="mt-10 text-xs text-muted">
              Data is generated deterministically from the current <strong>seed</strong> and a{" "}
              <strong>{allDays}-day</strong> window. Use the time span filter above to adjust the visible range.
            </footer>
          </>
        )}

        {activeTab === "simulate" && (
          <>
            <div className="mb-6">
              <BenchmarkFeedPanel marketShockPct={marketShockPct} />
            </div>
            <div className="mb-6">
              <ScenarioStudioPanel
                params={scenarioParams}
                onChange={setScenarioParams}
                marketShockPct={marketShockPct}
                setMarketShockPct={setMarketShockPct}
              />
            </div>
            <div className="mb-6">
              <SimulationOutputsPanel rows={allRows} marketShockPct={marketShockPct} params={scenarioParams} />
            </div>
          </>
        )}
      </div>

      <style>{`
        @media print { 
          body { background: white; }
          .print\\:hidden { display: none !important; }
        }
      `}</style>
    </div>
  );
}