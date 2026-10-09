import React from 'react';
import { GraphCanvas, type GraphCanvasProps } from './GraphCanvas';

export type CanvasProps = GraphCanvasProps;
export const Canvas: React.FC<CanvasProps> = (props) => {
  return <GraphCanvas {...props} />;
};

export { GraphCanvas };
