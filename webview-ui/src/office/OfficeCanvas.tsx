import { useRef, useEffect, useCallback } from 'react'
import type { OfficeState } from './officeState.js'
import type { EditorState } from './editorState.js'
import type { EditorRenderState } from './renderer.js'
import { startGameLoop } from './gameLoop.js'
import { renderFrame } from './renderer.js'
import { SCALE, TILE_SIZE, MAP_COLS, MAP_ROWS, EditTool } from './types.js'
import { getCatalogEntry } from './furnitureCatalog.js'
import { canPlaceFurniture } from './editorActions.js'

interface OfficeCanvasProps {
  officeState: OfficeState
  onHover: (agentId: number | null, screenX: number, screenY: number) => void
  onClick: (agentId: number) => void
  isEditMode: boolean
  editorState: EditorState
  onEditorTileAction: (col: number, row: number) => void
  editorTick: number
}

export function OfficeCanvas({ officeState, onHover, onClick, isEditMode, editorState, onEditorTileAction, editorTick: _editorTick }: OfficeCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const offsetRef = useRef({ x: 0, y: 0 })

  // Resize canvas to fill container
  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return
    const rect = container.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    canvas.width = rect.width * dpr
    canvas.height = rect.height * dpr
    canvas.style.width = `${rect.width}px`
    canvas.style.height = `${rect.height}px`
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.scale(dpr, dpr)
    }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    resizeCanvas()

    const observer = new ResizeObserver(() => resizeCanvas())
    if (containerRef.current) {
      observer.observe(containerRef.current)
    }

    const stop = startGameLoop(canvas, {
      update: (dt) => {
        officeState.update(dt)
      },
      render: (ctx) => {
        const dpr = window.devicePixelRatio || 1
        const w = canvas.width / dpr
        const h = canvas.height / dpr
        ctx.save()

        // Build editor render state
        let editorRender: EditorRenderState | undefined
        if (isEditMode) {
          editorRender = {
            showGrid: true,
            ghostSprite: null,
            ghostCol: editorState.ghostCol,
            ghostRow: editorState.ghostRow,
            ghostValid: editorState.ghostValid,
            selectedCol: 0,
            selectedRow: 0,
            selectedW: 0,
            selectedH: 0,
            hasSelection: false,
          }

          // Ghost preview for furniture placement
          if (editorState.activeTool === EditTool.FURNITURE_PLACE && editorState.ghostCol >= 0) {
            const entry = getCatalogEntry(editorState.selectedFurnitureType)
            if (entry) {
              editorRender.ghostSprite = entry.sprite
              editorRender.ghostValid = canPlaceFurniture(
                officeState.getLayout(),
                editorState.selectedFurnitureType,
                editorState.ghostCol,
                editorState.ghostRow,
              )
            }
          }

          // Selection highlight
          if (editorState.selectedFurnitureUid) {
            const item = officeState.getLayout().furniture.find((f) => f.uid === editorState.selectedFurnitureUid)
            if (item) {
              const entry = getCatalogEntry(item.type)
              if (entry) {
                editorRender.hasSelection = true
                editorRender.selectedCol = item.col
                editorRender.selectedRow = item.row
                editorRender.selectedW = entry.footprintW
                editorRender.selectedH = entry.footprintH
              }
            }
          }
        }

        const { offsetX, offsetY } = renderFrame(
          ctx,
          w,
          h,
          officeState.tileMap,
          officeState.furniture,
          officeState.getCharacters(),
          editorRender,
        )
        offsetRef.current = { x: offsetX, y: offsetY }
        ctx.restore()
      },
    })

    return () => {
      stop()
      observer.disconnect()
    }
  }, [officeState, resizeCanvas, isEditMode, editorState, _editorTick])

  const screenToWorld = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current
      if (!canvas) return null
      const rect = canvas.getBoundingClientRect()
      const sx = clientX - rect.left
      const sy = clientY - rect.top
      const worldX = (sx - offsetRef.current.x) / SCALE
      const worldY = (sy - offsetRef.current.y) / SCALE
      return { worldX, worldY, screenX: sx, screenY: sy }
    },
    [],
  )

  const screenToTile = useCallback(
    (clientX: number, clientY: number): { col: number; row: number } | null => {
      const pos = screenToWorld(clientX, clientY)
      if (!pos) return null
      const col = Math.floor(pos.worldX / TILE_SIZE)
      const row = Math.floor(pos.worldY / TILE_SIZE)
      if (col < 0 || col >= MAP_COLS || row < 0 || row >= MAP_ROWS) return null
      return { col, row }
    },
    [screenToWorld],
  )

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (isEditMode) {
        const tile = screenToTile(e.clientX, e.clientY)
        if (tile) {
          editorState.ghostCol = tile.col
          editorState.ghostRow = tile.row
          // Paint on drag
          if (editorState.isDragging && editorState.activeTool === EditTool.TILE_PAINT) {
            onEditorTileAction(tile.col, tile.row)
          }
        } else {
          editorState.ghostCol = -1
          editorState.ghostRow = -1
        }
        const canvas = canvasRef.current
        if (canvas) {
          canvas.style.cursor = 'crosshair'
        }
        return
      }

      const pos = screenToWorld(e.clientX, e.clientY)
      if (!pos) return
      const hitId = officeState.getCharacterAt(pos.worldX, pos.worldY)
      const canvas = canvasRef.current
      if (canvas) {
        canvas.style.cursor = hitId !== null ? 'pointer' : 'default'
      }
      const containerRect = containerRef.current?.getBoundingClientRect()
      const relX = containerRect ? e.clientX - containerRect.left : pos.screenX
      const relY = containerRect ? e.clientY - containerRect.top : pos.screenY
      onHover(hitId, relX, relY)
    },
    [officeState, onHover, screenToWorld, screenToTile, isEditMode, editorState, onEditorTileAction],
  )

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!isEditMode) return
      editorState.isDragging = true
      const tile = screenToTile(e.clientX, e.clientY)
      if (tile) {
        onEditorTileAction(tile.col, tile.row)
      }
    },
    [isEditMode, editorState, screenToTile, onEditorTileAction],
  )

  const handleMouseUp = useCallback(() => {
    editorState.isDragging = false
  }, [editorState])

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (isEditMode) return // handled by mouseDown
      const pos = screenToWorld(e.clientX, e.clientY)
      if (!pos) return
      const hitId = officeState.getCharacterAt(pos.worldX, pos.worldY)
      if (hitId !== null) {
        onClick(hitId)
      }
    },
    [officeState, onClick, screenToWorld, isEditMode],
  )

  const handleMouseLeave = useCallback(() => {
    editorState.isDragging = false
    editorState.ghostCol = -1
    editorState.ghostRow = -1
    if (!isEditMode) {
      onHover(null, 0, 0)
    }
  }, [onHover, editorState, isEditMode])

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        overflow: 'hidden',
        background: '#1E1E2E',
      }}
    >
      <canvas
        ref={canvasRef}
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onClick={handleClick}
        onMouseLeave={handleMouseLeave}
        style={{ display: 'block' }}
      />
    </div>
  )
}
