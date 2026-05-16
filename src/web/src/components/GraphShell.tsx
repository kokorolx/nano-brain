import { type ReactNode } from 'react';

export type TruncationInfo = { shown: number; total: number };

type GraphShellProps = {
  children: ReactNode;
  truncated?: TruncationInfo;
  unit?: string;
};

export default function GraphShell({ children, truncated, unit = 'nodes' }: GraphShellProps) {
  return (
    <div className="card graph-shell overflow-hidden relative">
      {truncated && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 px-3 py-1 rounded-full bg-[#1c1c27]/90 border border-[#3a3a5c] text-[11px] text-[#8888a0] whitespace-nowrap pointer-events-none">
          Showing top {truncated.shown} of {truncated.total.toLocaleString()} {unit} by connection degree
        </div>
      )}
      {children}
    </div>
  );
}
