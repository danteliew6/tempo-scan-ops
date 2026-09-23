import { createBrowserRouter, RouterProvider, NavLink, Outlet, Navigate, useLocation } from 'react-router';
import { useState } from 'react';
import {
  Button,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  useIsMobile,
} from '@databricks/appkit-ui/react';
import { Menu } from 'lucide-react';
import { OperationsHubPage } from './pages/hub/OperationsHubPage';
import { AskTempoPage } from './pages/genie/AskTempoPage';
import { DocumentIntelligencePage } from './pages/documents/DocumentIntelligencePage';
import { SovereigntyPage } from './pages/governance/SovereigntyPage';
import { ArchitecturePage } from './pages/architecture/ArchitecturePage';

// Drop the official logo into client/public/ as tempo-scan-logo.png (or .svg) — it is
// picked up automatically. Until then, a gold "TEMPO SCAN" wordmark badge is shown.
const LOGO_CANDIDATES = ['/tempo-scan-logo.png', '/tempo-scan-logo.svg'];

function TempoScanMark() {
  const [idx, setIdx] = useState(0);
  const logoOk = idx < LOGO_CANDIDATES.length;
  if (logoOk) {
    // Official wordmark sits in a white pill so it reads on the gold header.
    return (
      <div className="flex items-center gap-3">
        <div className="rounded-md bg-white px-2.5 py-1.5 shadow-sm">
          <img
            src={LOGO_CANDIDATES[idx]}
            alt="Tempo Scan"
            className="h-6 w-auto max-w-[160px] object-contain"
            onError={() => setIdx((i) => i + 1)}
          />
        </div>
        <span className="hidden sm:inline text-white/85 text-sm border-l border-white/30 pl-3">
          Molecule to Shelf
        </span>
      </div>
    );
  }
  // Gold-wordmark fallback (no official logo file present).
  return (
    <div className="flex items-center gap-2.5">
      <div className="flex h-9 w-9 items-center justify-center rounded-md bg-white shadow-sm">
        <svg width="24" height="24" viewBox="0 0 64 64" aria-hidden="true">
          {/* stylized "molecule" mark — three linked nodes */}
          <g stroke="#a8842a" strokeWidth="4" fill="none">
            <line x1="18" y1="20" x2="44" y2="20" />
            <line x1="18" y1="20" x2="30" y2="46" />
            <line x1="44" y1="20" x2="30" y2="46" />
          </g>
          <circle cx="18" cy="20" r="7" fill="#a8842a" />
          <circle cx="44" cy="20" r="7" fill="#6b5518" />
          <circle cx="30" cy="46" r="7" fill="#c9a54a" />
        </svg>
      </div>
      <div className="leading-tight">
        <div className="text-white font-bold text-base tracking-[0.14em]">TEMPO SCAN</div>
        <div className="text-white/70 text-[11px] -mt-0.5">Molecule to Shelf</div>
      </div>
    </div>
  );
}

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
    isActive ? 'bg-white/20 text-white' : 'text-white/80 hover:bg-white/10 hover:text-white'
  }`;

const mobileNavLinkClass = ({ isActive }: { isActive: boolean }) =>
  `block px-3 py-2 rounded-md text-sm font-medium transition-colors ${
    isActive ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
  }`;

type NavLinkClassFn = (props: { isActive: boolean }) => string;

// The Operations Hub groups the four Lakebase-served operational views under one tab.
const HUB_PATHS = ['/command', '/overview', '/dashboard', '/forecast'];

const LINKS: { to: string; label: string; match?: string[] }[] = [
  { to: '/command', label: 'Operations Hub', match: HUB_PATHS },
  { to: '/ask', label: 'Ask Tempo' },
  { to: '/documents', label: 'Document Intelligence' },
  { to: '/access', label: 'Sovereignty & Governance' },
  { to: '/architecture', label: 'Architecture' },
];

function NavLinks({ className, linkClass, onClick }: { className?: string; linkClass: NavLinkClassFn; onClick?: () => void }) {
  const { pathname } = useLocation();
  return (
    <nav className={className}>
      {LINKS.map((l) => {
        // The hub link stays active across all of its sub-view paths.
        const active = l.match ? l.match.includes(pathname) : pathname === l.to;
        return (
          <NavLink key={l.to} to={l.to} className={linkClass({ isActive: active })} onClick={onClick} end>
            {l.label}
          </NavLink>
        );
      })}
    </nav>
  );
}

function Layout() {
  const isMobile = useIsMobile();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="ts-header px-4 md:px-6 py-3 flex items-center gap-6 shadow-md">
        <TempoScanMark />
        <NavLinks className="hidden md:flex gap-1" linkClass={navLinkClass} />
        <div className="ml-auto hidden lg:block text-white/70 text-xs">
          Powered by Databricks · Governed in Indonesia (AWS Jakarta)
        </div>
        <div className="ml-auto md:hidden">
          <Sheet open={isMobile && mobileNavOpen} onOpenChange={setMobileNavOpen}>
            <Button variant="ghost" size="icon" className="text-white hover:bg-white/10" onClick={() => setMobileNavOpen(true)}>
              <Menu className="h-5 w-5" />
              <span className="sr-only">Open navigation</span>
            </Button>
            <SheetContent side="left">
              <SheetHeader>
                <SheetTitle>Tempo Scan</SheetTitle>
              </SheetHeader>
              <NavLinks className="flex flex-col gap-1 mt-4" linkClass={mobileNavLinkClass} onClick={() => setMobileNavOpen(false)} />
            </SheetContent>
          </Sheet>
        </div>
      </header>
      <main className="flex-1 p-4 md:p-6 bg-muted/30">
        <Outlet />
      </main>
    </div>
  );
}

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: '/', element: <Navigate to="/command" replace /> },
      { path: '/command', element: <OperationsHubPage /> },
      { path: '/overview', element: <OperationsHubPage /> },
      { path: '/dashboard', element: <OperationsHubPage /> },
      { path: '/forecast', element: <OperationsHubPage /> },
      { path: '/ask', element: <AskTempoPage /> },
      { path: '/documents', element: <DocumentIntelligencePage /> },
      { path: '/access', element: <SovereigntyPage /> },
      { path: '/architecture', element: <ArchitecturePage /> },
    ],
  },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
