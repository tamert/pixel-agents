import { FurnitureType } from './types.js'
import type { FurnitureCatalogEntry } from './types.js'
import {
  DESK_SQUARE_SPRITE,
  BOOKSHELF_SPRITE,
  PLANT_SPRITE,
  COOLER_SPRITE,
  WHITEBOARD_SPRITE,
  CHAIR_SPRITE,
  PC_SPRITE,
  LAMP_SPRITE,
} from './sprites.js'

export const FURNITURE_CATALOG: FurnitureCatalogEntry[] = [
  { type: FurnitureType.DESK, label: 'Desk', footprintW: 2, footprintH: 2, sprite: DESK_SQUARE_SPRITE, isDesk: true },
  { type: FurnitureType.BOOKSHELF, label: 'Bookshelf', footprintW: 1, footprintH: 2, sprite: BOOKSHELF_SPRITE, isDesk: false },
  { type: FurnitureType.PLANT, label: 'Plant', footprintW: 1, footprintH: 1, sprite: PLANT_SPRITE, isDesk: false },
  { type: FurnitureType.COOLER, label: 'Cooler', footprintW: 1, footprintH: 1, sprite: COOLER_SPRITE, isDesk: false },
  { type: FurnitureType.WHITEBOARD, label: 'Whiteboard', footprintW: 2, footprintH: 1, sprite: WHITEBOARD_SPRITE, isDesk: false },
  { type: FurnitureType.CHAIR, label: 'Chair', footprintW: 1, footprintH: 1, sprite: CHAIR_SPRITE, isDesk: false },
  { type: FurnitureType.PC, label: 'PC', footprintW: 1, footprintH: 1, sprite: PC_SPRITE, isDesk: false },
  { type: FurnitureType.LAMP, label: 'Lamp', footprintW: 1, footprintH: 1, sprite: LAMP_SPRITE, isDesk: false },
]

export function getCatalogEntry(type: FurnitureType): FurnitureCatalogEntry | undefined {
  return FURNITURE_CATALOG.find((e) => e.type === type)
}
