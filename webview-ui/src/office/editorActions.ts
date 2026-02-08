import { MAP_COLS, MAP_ROWS } from './types.js'
import type { TileType as TileTypeVal, OfficeLayout, PlacedFurniture, FurnitureType } from './types.js'
import { getCatalogEntry } from './furnitureCatalog.js'

/** Paint a single tile. Returns new layout (immutable). */
export function paintTile(layout: OfficeLayout, col: number, row: number, tileType: TileTypeVal): OfficeLayout {
  const idx = row * layout.cols + col
  if (idx < 0 || idx >= layout.tiles.length) return layout
  if (layout.tiles[idx] === tileType) return layout
  const tiles = [...layout.tiles]
  tiles[idx] = tileType
  return { ...layout, tiles }
}

/** Place furniture. Returns new layout (immutable). */
export function placeFurniture(layout: OfficeLayout, item: PlacedFurniture): OfficeLayout {
  if (!canPlaceFurniture(layout, item.type, item.col, item.row)) return layout
  return { ...layout, furniture: [...layout.furniture, item] }
}

/** Remove furniture by uid. Returns new layout (immutable). */
export function removeFurniture(layout: OfficeLayout, uid: string): OfficeLayout {
  const filtered = layout.furniture.filter((f) => f.uid !== uid)
  if (filtered.length === layout.furniture.length) return layout
  return { ...layout, furniture: filtered }
}

/** Move furniture to new position. Returns new layout (immutable). */
export function moveFurniture(layout: OfficeLayout, uid: string, newCol: number, newRow: number): OfficeLayout {
  const item = layout.furniture.find((f) => f.uid === uid)
  if (!item) return layout
  if (!canPlaceFurniture(layout, item.type, newCol, newRow, uid)) return layout
  return {
    ...layout,
    furniture: layout.furniture.map((f) => (f.uid === uid ? { ...f, col: newCol, row: newRow } : f)),
  }
}

/** Check if furniture can be placed at (col, row) without overlapping. */
export function canPlaceFurniture(
  layout: OfficeLayout,
  type: FurnitureType,
  col: number,
  row: number,
  excludeUid?: string,
): boolean {
  const entry = getCatalogEntry(type)
  if (!entry) return false

  // Check bounds
  if (col < 0 || row < 0 || col + entry.footprintW > MAP_COLS || row + entry.footprintH > MAP_ROWS) {
    return false
  }

  // Build occupied set excluding the item being moved
  const occupied = new Set<string>()
  for (const f of layout.furniture) {
    if (f.uid === excludeUid) continue
    const e = getCatalogEntry(f.type)
    if (!e) continue
    for (let dr = 0; dr < e.footprintH; dr++) {
      for (let dc = 0; dc < e.footprintW; dc++) {
        occupied.add(`${f.col + dc},${f.row + dr}`)
      }
    }
  }

  // Check overlap
  for (let dr = 0; dr < entry.footprintH; dr++) {
    for (let dc = 0; dc < entry.footprintW; dc++) {
      if (occupied.has(`${col + dc},${row + dr}`)) return false
    }
  }

  return true
}
