import { TILE_SIZE } from './types.js'
import type { Character, DeskSlot, FurnitureInstance, TileType as TileTypeVal, OfficeLayout } from './types.js'
import { createCharacter, updateCharacter } from './characters.js'
import { getWalkableTiles } from './tileMap.js'
import {
  createDefaultLayout,
  layoutToTileMap,
  layoutToFurnitureInstances,
  layoutToDeskSlots,
  getBlockedTiles,
} from './layoutSerializer.js'

export class OfficeState {
  layout: OfficeLayout
  tileMap: TileTypeVal[][]
  deskSlots: DeskSlot[]
  blockedTiles: Set<string>
  furniture: FurnitureInstance[]
  walkableTiles: Array<{ col: number; row: number }>
  characters: Map<number, Character> = new Map()
  private nextPalette = 0

  constructor(layout?: OfficeLayout) {
    this.layout = layout || createDefaultLayout()
    this.tileMap = layoutToTileMap(this.layout)
    this.blockedTiles = getBlockedTiles(this.layout.furniture)
    this.furniture = layoutToFurnitureInstances(this.layout.furniture)
    this.deskSlots = layoutToDeskSlots(this.layout.furniture, this.blockedTiles)
    this.walkableTiles = getWalkableTiles(this.tileMap, this.blockedTiles)
  }

  /** Rebuild all derived state from a new layout. Reassigns existing characters. */
  rebuildFromLayout(layout: OfficeLayout): void {
    this.layout = layout
    this.tileMap = layoutToTileMap(layout)
    this.blockedTiles = getBlockedTiles(layout.furniture)
    this.furniture = layoutToFurnitureInstances(layout.furniture)
    this.deskSlots = layoutToDeskSlots(layout.furniture, this.blockedTiles)
    this.walkableTiles = getWalkableTiles(this.tileMap, this.blockedTiles)

    // Reassign characters to new desk slots
    // First, clear all slot assignments
    for (const slot of this.deskSlots) {
      slot.assigned = false
    }

    for (const ch of this.characters.values()) {
      // Try to assign to a free desk slot
      let slotIndex = -1
      for (let i = 0; i < this.deskSlots.length; i++) {
        if (!this.deskSlots[i].assigned) {
          slotIndex = i
          break
        }
      }

      if (slotIndex >= 0) {
        this.deskSlots[slotIndex].assigned = true
        ch.deskSlot = slotIndex
      } else {
        // No desks available — wander
        ch.deskSlot = -1
      }
    }
  }

  getLayout(): OfficeLayout {
    return this.layout
  }

  addAgent(id: number): void {
    if (this.characters.has(id)) return

    // Find first unassigned desk
    let slotIndex = -1
    for (let i = 0; i < this.deskSlots.length; i++) {
      if (!this.deskSlots[i].assigned) {
        slotIndex = i
        break
      }
    }

    const palette = this.nextPalette % 6
    this.nextPalette++

    if (slotIndex >= 0) {
      this.deskSlots[slotIndex].assigned = true
      const ch = createCharacter(id, palette, slotIndex, this.deskSlots[slotIndex])
      this.characters.set(id, ch)
    } else {
      // No desks — spawn at random walkable tile, set deskSlot = -1
      const spawn = this.walkableTiles.length > 0
        ? this.walkableTiles[Math.floor(Math.random() * this.walkableTiles.length)]
        : { col: 1, row: 1 }
      const ch: Character = {
        id,
        state: 'type' as const,
        dir: 0 as const,
        x: spawn.col * TILE_SIZE + TILE_SIZE / 2,
        y: spawn.row * TILE_SIZE + TILE_SIZE / 2,
        tileCol: spawn.col,
        tileRow: spawn.row,
        path: [],
        moveProgress: 0,
        currentTool: null,
        palette,
        frame: 0,
        frameTimer: 0,
        wanderTimer: 0,
        isActive: true,
        deskSlot: -1,
      }
      this.characters.set(id, ch)
    }
  }

  removeAgent(id: number): void {
    const ch = this.characters.get(id)
    if (!ch) return
    if (ch.deskSlot >= 0 && ch.deskSlot < this.deskSlots.length) {
      this.deskSlots[ch.deskSlot].assigned = false
    }
    this.characters.delete(id)
  }

  setAgentActive(id: number, active: boolean): void {
    const ch = this.characters.get(id)
    if (ch) {
      ch.isActive = active
    }
  }

  setAgentTool(id: number, tool: string | null): void {
    const ch = this.characters.get(id)
    if (ch) {
      ch.currentTool = tool
    }
  }

  update(dt: number): void {
    for (const ch of this.characters.values()) {
      updateCharacter(ch, dt, this.walkableTiles, this.deskSlots, this.tileMap, this.blockedTiles)
    }
  }

  getCharacters(): Character[] {
    return Array.from(this.characters.values())
  }

  /** Get character at pixel position (for hit testing). Returns id or null. */
  getCharacterAt(worldX: number, worldY: number): number | null {
    const chars = this.getCharacters().sort((a, b) => b.y - a.y)
    for (const ch of chars) {
      // Character sprite is 16x24, anchored bottom-center
      const left = ch.x - 8
      const right = ch.x + 8
      const top = ch.y - 24
      const bottom = ch.y
      if (worldX >= left && worldX <= right && worldY >= top && worldY <= bottom) {
        return ch.id
      }
    }
    return null
  }
}
