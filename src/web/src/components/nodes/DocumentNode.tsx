import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';

const HANDLE_STYLE = { opacity: 0, width: 0, height: 0, pointerEvents: 'none' as const };

export type DocumentNodeData = {
  label: string;
  fullPath: string;
  color: string;
  dimmed?: boolean;
  focused?: boolean;
};

const DocumentNode = memo(function DocumentNode({ data }: { data: DocumentNodeData }) {
  if (data.dimmed) {
    return (
      <div style={{ width: 8, height: 8, borderRadius: '50%', background: data.color, opacity: 0.2, pointerEvents: 'none' }}>
        <Handle type="target" position={Position.Top} style={HANDLE_STYLE} />
        <Handle type="source" position={Position.Bottom} style={HANDLE_STYLE} />
      </div>
    );
  }

  return (
    <div
      className="px-3 py-1.5 cursor-grab"
      style={{
        background: `${data.color}18`,
        border: `2px solid ${data.color}`,
        borderRadius: 10,
        boxShadow: data.focused ? `0 0 0 3px ${data.color}60` : undefined,
      }}
    >
      <Handle type="target" position={Position.Top} style={HANDLE_STYLE} />
      <Handle type="source" position={Position.Bottom} style={HANDLE_STYLE} />
      <div className="text-[10px] font-medium whitespace-nowrap" style={{ color: data.color }}>
        {data.label}
      </div>
    </div>
  );
});

export default DocumentNode;
