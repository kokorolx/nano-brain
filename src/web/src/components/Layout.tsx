import { PropsWithChildren } from 'react';
import { NavLink } from 'react-router-dom';
import { Activity, Network, Search, Waypoints } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { fetchStatus, fetchWorkspaces } from '../api/client';
import { useAppStore } from '../store/app';

const navItems = [
  { label: 'Dashboard', path: '/dashboard', icon: Activity },
  { label: 'Knowledge Graph', path: '/graph', icon: Network },
  { label: 'Code Dependencies', path: '/code', icon: Waypoints },
  { label: 'Search', path: '/search', icon: Search },
];

export default function Layout({ children }: PropsWithChildren) {
  const { data: status } = useQuery({ queryKey: ['status'], queryFn: fetchStatus });
  const { data: workspaces } = useQuery({ queryKey: ['workspaces'], queryFn: fetchWorkspaces });
  const workspace = useAppStore((state) => state.workspace);
  const setWorkspace = useAppStore((state) => state.setWorkspace);

  const workspaceOptions = workspaces?.workspaces ?? [];
  const selectedValue = workspace ?? workspaceOptions[0]?.hash ?? '';

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-[#e4e4ed]">
      <header className="flex items-center justify-between border-b border-[#1b1b26] bg-[#0f0f16] px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="h-3 w-3 rounded-full bg-gradient-to-r from-sky-500 via-indigo-500 to-fuchsia-500" />
          <div>
            <p className="text-sm uppercase tracking-[0.3em] text-[#8888a0]">nano-brain</p>
            <p className="text-lg font-semibold">Developer Dashboard</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right">
            <p className="text-xs text-[#8888a0]">Version</p>
            <p className="text-sm font-medium">{status?.version ?? 'loading'}</p>
          </div>
          <select
            className="panel px-3 py-2 text-sm text-[#e4e4ed]"
            value={selectedValue}
            onChange={(event) => setWorkspace(event.target.value)}
          >
            {workspaceOptions.map((ws) => (
              <option key={ws.hash} value={ws.hash}>
                {ws.name} · {ws.documentCount}
              </option>
            ))}
          </select>
        </div>
      </header>
      <div className="flex min-h-[calc(100vh-65px)]">
        <aside className="w-56 shrink-0 border-r border-[#1b1b26] bg-[#111118] p-4">
          <nav className="flex flex-col gap-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.path}
                  to={item.path}
                  className={({ isActive }) =>
                    `flex items-center gap-3 rounded-xl px-3 py-2 text-sm transition ${
                      isActive ? 'bg-[#1c1c27] text-white' : 'text-[#8888a0] hover:bg-[#16161f] hover:text-white'
                    }`
                  }
                >
                  <Icon size={18} />
                  {item.label}
                </NavLink>
              );
            })}
          </nav>
          <div className="mt-8 border-t border-[#1f1f2c] pt-4 text-xs text-[#8888a0]">
            <p>Workspace</p>
            <p className="mt-1 truncate text-sm text-[#e4e4ed]" title={status?.primaryWorkspace}>
              {status?.primaryWorkspace?.split('/').pop() ?? 'loading'}
            </p>
          </div>
        </aside>
        <main className="min-w-0 flex-1 overflow-auto px-6 py-6">{children}</main>
      </div>
    </div>
  );
}
