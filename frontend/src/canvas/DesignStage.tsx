// Renders a Design with Konva. Read-only (thumbnails, render route) or interactive (editor canvas).
import type { CSSProperties, ReactNode, Ref } from 'react';
import type Konva from 'konva';
import { Group, Layer as KLayer, Rect, Stage } from 'react-konva';
import { PALETTE } from '../brand';
import type { Design } from '../types';
import { col, LayerView, usesPixelHit, type Detail } from './LayerView';

export interface DesignStageProps {
  design: Design;
  /** Display px per design px. */
  scale: number;
  detail?: Detail;
  interactive?: boolean;
  stageRef?: Ref<Konva.Stage>;
  editingId?: string | null;
  onLayerDown?: (id: string, shift: boolean) => void;
  onBackgroundDown?: () => void;
  onLayerDragEnd?: (id: string, node: Konva.Node) => void;
  onLayerTransformEnd?: (id: string, node: Konva.Node) => void;
  onLayerDblClick?: (id: string) => void;
  onTextMeasured?: (id: string, height: number) => void;
  /** Extra Konva content drawn above the design (transformer, highlights, safe zone). */
  overlay?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export function DesignStage({
  design,
  scale,
  detail = 'full',
  interactive = false,
  stageRef,
  editingId,
  onLayerDown,
  onBackgroundDown,
  onLayerDragEnd,
  onLayerTransformEnd,
  onLayerDblClick,
  onTextMeasured,
  overlay,
  className,
  style,
}: DesignStageProps) {
  const W = design.width;
  const H = design.height;
  return (
    <Stage
      ref={stageRef}
      width={Math.max(1, Math.round(W * scale))}
      height={Math.max(1, Math.round(H * scale))}
      scaleX={scale}
      scaleY={scale}
      className={className}
      style={style}
      listening={interactive}
      onMouseDown={
        interactive
          ? (e) => {
              if (e.target === e.target.getStage()) onBackgroundDown?.();
            }
          : undefined
      }
      onTouchStart={
        interactive
          ? (e) => {
              if (e.target === e.target.getStage()) onBackgroundDown?.();
            }
          : undefined
      }
    >
      <KLayer listening={interactive}>
        <Rect
          name="design-bg"
          width={W}
          height={H}
          fill={col(design.background, PALETTE.white)}
          onMouseDown={interactive ? () => onBackgroundDown?.() : undefined}
          onTouchStart={interactive ? () => onBackgroundDown?.() : undefined}
        />
        {design.layers.map((l) => (
          <Group
            key={l.id}
            id={l.id}
            name="layer"
            x={l.x}
            y={l.y}
            rotation={l.rotation ?? 0}
            opacity={l.opacity ?? 1}
            visible={!l.hidden}
            draggable={interactive && !l.locked}
            listening={interactive}
            onMouseDown={
              interactive
                ? (e) => {
                    e.cancelBubble = true;
                    onLayerDown?.(l.id, e.evt.shiftKey);
                  }
                : undefined
            }
            onTouchStart={
              interactive
                ? (e) => {
                    e.cancelBubble = true;
                    onLayerDown?.(l.id, false);
                  }
                : undefined
            }
            onDragEnd={interactive ? (e) => onLayerDragEnd?.(l.id, e.target) : undefined}
            onTransformEnd={interactive ? (e) => onLayerTransformEnd?.(l.id, e.target) : undefined}
            onDblClick={interactive ? () => onLayerDblClick?.(l.id) : undefined}
            onDblTap={interactive ? () => onLayerDblClick?.(l.id) : undefined}
          >
            {interactive && !usesPixelHit(l) ? (
              <Rect name="hitbox" width={Math.max(1, l.width)} height={Math.max(1, l.height)} fill="rgba(0,0,0,0)" />
            ) : null}
            <LayerView
              layer={l}
              detail={detail}
              interactive={interactive}
              hideText={editingId === l.id}
              onMeasured={onTextMeasured}
            />
          </Group>
        ))}
      </KLayer>
      {overlay ? <KLayer name="overlay">{overlay}</KLayer> : null}
    </Stage>
  );
}
