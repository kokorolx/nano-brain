import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchFlows } from '../api/client';
import { useAppStore } from '../store/app';

export default function FlowsView() {
  const workspace = useAppStore((state) => state.workspace);
  const { data, isLoading } = useQuery({
    queryKey: ['flows', workspace],
    queryFn: () => fetchFlows(workspace),
  });
  const [selectedFlowId, setSelectedFlowId] = useState<number | null>(null);
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [search, setSearch] = useState('');

  const flows = data?.flows ?? [];
  const filtered = flows.filter((f) => {
    if (typeFilter !== 'all' && f.flow_type !== typeFilter) return false;
    if (search && !f.label.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const selectedFlow = flows.find((f) => f.id === selectedFlowId);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Execution Flows</h1>
        <p className="mt-1 text-sm text-[#8888a0]">Entry-to-terminal call chains detected from code analysis.</p>
      </div>

      <div className="flex items-center gap-4">
        <select
          className="panel px-3 py-2 text-sm text-[#e4e4ed]"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
        >
          <option value="all">All types</option>
          <option value="intra_community">Intra-community</option>
          <option value="cross_community">Cross-community</option>
        </select>
        <input
          className="panel flex-1 px-3 py-2 text-sm text-[#e4e4ed] placeholder-[#8888a0]"
          placeholder="Search by symbol name..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="text-xs text-[#8888a0]">
          {isLoading ? 'Loading...' : `${filtered.length} of ${flows.length} flows`}
        </span>
      </div>

      <div className="grid grid-cols-[1fr_1fr] gap-6">
        <div className="space-y-2 overflow-auto" style={{ maxHeight: 'calc(100vh - 260px)' }}>
          {filtered.length === 0 && !isLoading && (
            <div className="card p-4 text-sm text-[#8888a0]">No flows found.</div>
          )}
          {filtered.map((flow) => (
            <div
              key={flow.id}
              className={`card cursor-pointer px-4 py-3 transition hover:bg-[#1c1c27] ${
                selectedFlowId === flow.id ? 'border-indigo-500/50 bg-[#1c1c27]' : ''
              }`}
              onClick={() => setSelectedFlowId(flow.id)}
            >
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">{flow.label}</p>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs ${
                    flow.flow_type === 'intra_community'
                      ? 'bg-blue-500/20 text-blue-400'
                      : 'bg-orange-500/20 text-orange-400'
                  }`}
                >
                  {flow.flow_type === 'intra_community' ? 'intra' : 'cross'}
                </span>
              </div>
              <p className="mt-1 text-xs text-[#8888a0]">
                {flow.step_count} steps · {flow.entry_file?.split('/').pop() ?? '?'} → {flow.terminal_file?.split('/').pop() ?? '?'}
              </p>
            </div>
          ))}
        </div>

        <div>
          {selectedFlow ? (
            <div className="card p-4">
              <h2 className="text-lg font-semibold">{selectedFlow.label}</h2>
              <p className="mt-1 text-xs text-[#8888a0]">
                {selectedFlow.flow_type} · {selectedFlow.step_count} steps
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                {selectedFlow.steps.map((step, i) => (
                  <Fragment key={step.step_index}>
                    {i > 0 && <span className="text-lg text-[#8888a0]">→</span>}
                    <div className="shrink-0 rounded-lg border border-[#232331] bg-[#1c1c27] px-3 py-2">
                      <p className="text-sm font-medium">{step.name}</p>
                      <p className="text-xs text-[#8888a0]">
                        {step.kind} · {step.file_path?.split('/').pop() ?? '?'}:{step.start_line}
                      </p>
                    </div>
                  </Fragment>
                ))}
              </div>
              <div className="mt-4 border-t border-[#1f1f2c] pt-3 text-xs text-[#8888a0]">
                <p>Entry: {selectedFlow.entry_name ?? '?'} ({selectedFlow.entry_file ?? '?'})</p>
                <p>Terminal: {selectedFlow.terminal_name ?? '?'} ({selectedFlow.terminal_file ?? '?'})</p>
              </div>
            </div>
          ) : (
            <div className="card p-4 text-sm text-[#8888a0]">Select a flow to see its call chain.</div>
          )}
        </div>
      </div>
    </div>
  );
}
