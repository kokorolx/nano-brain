import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import { TYPE_COLORS, DEFAULT_TYPE_COLOR } from '../../lib/colors';

const HANDLE_STYLE = { opacity: 0, width: 0, height: 0, pointerEvents: 'none' as const };

export type EntityNodeData = {
  label: string;
  entityType: string;
  degree: number;
  description?: string | null;
  firstLearnedAt?: string | null;
  lastConfirmedAt?: string | null;
  contradictedAt?: string | null;
  dimmed?: boolean;
  focused?: boolean;
};

const EntityNode = memo(function EntityNode({ data }: { data: EntityNodeData }) {
  const tc = TYPE_COLORS[data.entityType] || DEFAULT_TYPE_COLOR;
  const t = tc.dark;
  const isHub = data.degree >= 4;

  // Collapsed dot for unrelated nodes — no label, no space taken by text
  if (data.dimmed) {
    return (
      <div style={{ width: 10, height: 10, borderRadius: '50%', background: tc.border, opacity: 0.2 }}>
        <Handle type="target" position={Position.Top} style={HANDLE_STYLE} />
        <Handle type="source" position={Position.Bottom} style={HANDLE_STYLE} />
      </div>
    );
  }

  return (
    <div
      className="px-4 py-1.5 cursor-grab"
      style={{
        background: t.bg,
        border: `2px solid ${data.focused ? '#fff' : tc.border}`,
        borderRadius: 20,
        boxShadow: data.focused
          ? `0 0 0 3px ${tc.border}80, 0 0 12px ${tc.border}60`
          : isHub ? `0 0 8px ${tc.border}40` : undefined,
      }}
    >
      <Handle type="target" position={Position.Top} style={HANDLE_STYLE} />
      <Handle type="source" position={Position.Bottom} style={HANDLE_STYLE} />
      <div className="text-[11px] font-semibold whitespace-nowrap" style={{ color: t.text }}>
        {data.label}
      </div>
      <div className="text-[9px] text-center" style={{ color: t.text, opacity: 0.6 }}>
        {data.entityType}
      </div>
    </div>
  );
});

export default EntityNode;
