import { useLocation, useNavigate } from 'react-router';
import { Activity, BarChart3, LayoutDashboard, LineChart } from 'lucide-react';
import type { ReactNode } from 'react';
import { CommandCenterPage } from '../command/CommandCenterPage';
import { OverviewPage } from '../overview/OverviewPage';
import { AiBiDashboardPage } from '../dashboard/AiBiDashboardPage';
import { ForecastPage } from '../serving/ForecastPage';

// One holistic operations surface. Each view has its own path (so links + sharing work);
// the toggle just navigates between them and this wrapper renders the matching view.
interface HubView { path: string; label: string; icon: ReactNode; el: ReactNode }
const VIEWS: HubView[] = [
  { path: '/command', label: 'Command Center', icon: <Activity className="h-3.5 w-3.5" />, el: <CommandCenterPage /> },
  { path: '/overview', label: 'Overview', icon: <BarChart3 className="h-3.5 w-3.5" />, el: <OverviewPage /> },
  { path: '/dashboard', label: 'AI/BI Dashboard', icon: <LayoutDashboard className="h-3.5 w-3.5" />, el: <AiBiDashboardPage /> },
  { path: '/forecast', label: 'Demand & Inventory Forecast', icon: <LineChart className="h-3.5 w-3.5" />, el: <ForecastPage /> },
];

export function OperationsHubPage() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const active = VIEWS.find((v) => v.path === pathname) ?? VIEWS[0];

  return (
    <div className="space-y-5 w-full max-w-7xl mx-auto">
      <div className="inline-flex flex-wrap rounded-lg border bg-card p-1 shadow-sm">
        {VIEWS.map((v) => (
          <button
            key={v.path}
            onClick={() => { void navigate(v.path); }}
            className={`flex items-center gap-1.5 text-sm rounded-md px-3 py-1.5 transition-colors ${
              active.path === v.path ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {v.icon} {v.label}
          </button>
        ))}
      </div>
      {active.el}
    </div>
  );
}
