import { EditTool, TileType, FurnitureType } from './types.js'
import type { TileType as TileTypeVal, OfficeLayout } from './types.js'

export class EditorState {
  isEditMode = false
  activeTool: EditTool = EditTool.SELECT
  selectedTileType: TileTypeVal = TileType.TILE_FLOOR
  selectedFurnitureType: FurnitureType = FurnitureType.DESK

  // Ghost preview position
  ghostCol = -1
  ghostRow = -1
  ghostValid = false

  // Selection
  selectedFurnitureUid: string | null = null

  // Mouse drag state
  isDragging = false

  // Undo stack
  undoStack: OfficeLayout[] = []

  pushUndo(layout: OfficeLayout): void {
    this.undoStack.push(layout)
    // Limit undo stack size
    if (this.undoStack.length > 50) {
      this.undoStack.shift()
    }
  }

  popUndo(): OfficeLayout | null {
    return this.undoStack.pop() || null
  }

  clearSelection(): void {
    this.selectedFurnitureUid = null
  }

  clearGhost(): void {
    this.ghostCol = -1
    this.ghostRow = -1
    this.ghostValid = false
  }

  reset(): void {
    this.activeTool = EditTool.SELECT
    this.selectedFurnitureUid = null
    this.ghostCol = -1
    this.ghostRow = -1
    this.ghostValid = false
    this.isDragging = false
    this.undoStack = []
  }
}
