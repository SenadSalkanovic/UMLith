import { useI18n } from './i18n';
import { NodeResizer, ViewportPortal, type NodeProps } from '@xyflow/react';
import type { DiagramNode } from './lib/model';

export default function CommentFrame({ id, data, selected, width, height, positionAbsoluteX, positionAbsoluteY }: NodeProps<DiagramNode>) {
  const { t } = useI18n();
  return (
    <>
      {selected && <ViewportPortal>
        <div className="comment-resize-overlay" style={{ width, height, transform: `translate(${positionAbsoluteX}px, ${positionAbsoluteY}px)` }}>
          <NodeResizer
            nodeId={id}
            minWidth={280}
            minHeight={160}
            maxWidth={10000}
            maxHeight={10000}
            handleClassName="comment-resize-handle"
            lineClassName="comment-resize-line"
          />
        </div>
      </ViewportPortal>}
      <div className={`comment-frame ${selected ? 'is-selected' : ''}`}>
        <div className="comment-frame-heading">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <path d="M8 5h1m6 0h1M8 12h1m6 0h1M8 19h1m6 0h1" />
          </svg>
          <strong>{data.label || t('untitled')}</strong>
        </div>
        <div className="comment-frame-body nodrag nowheel">
          {data.body}
        </div>
      </div>
    </>
  );
}
