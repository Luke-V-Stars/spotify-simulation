/**
 * Physical dimensions of one bookshelf, in metres at scale 1.
 *
 * This is the single source of truth shared by layout, mesh generation and
 * picking, so what is drawn and what is clickable can't drift apart.
 *
 * Local space: origin on the floor at the centre of the shelf, +X to the viewer's
 * right, +Y up, +Z out of the shelf toward the viewer.
 */

export const MAX_RECORDS_PER_SHELF = 50;

const COLUMNS = 10;
const ROWS = 5;
const CELL_WIDTH = 0.29;
const CELL_HEIGHT = 0.31;
const BOARD = 0.03;
const PLINTH = 0.08;
const DEPTH = 0.2;
const HEADER_HEIGHT = 0.2;
const CAP_HEIGHT = 0.03;

export const SHELF = Object.freeze({
  columns: COLUMNS,
  rows: ROWS,
  cellWidth: CELL_WIDTH,
  cellHeight: CELL_HEIGHT,
  board: BOARD,
  plinth: PLINTH,
  depth: DEPTH,
  width: COLUMNS * CELL_WIDTH + 2 * BOARD,
  /** Up to the top of the highest shelf board. The header board stands on top of this. */
  height: PLINTH + ROWS * (BOARD + CELL_HEIGHT) + BOARD,
  headerHeight: HEADER_HEIGHT,
  capHeight: CAP_HEIGHT,
  totalHeight: PLINTH + ROWS * (BOARD + CELL_HEIGHT) + BOARD + HEADER_HEIGHT + CAP_HEIGHT,
  /** Half the width of a square album sleeve. */
  sleeveHalf: 0.135,
  /** Sleeves lean back slightly against the back panel, in radians. */
  recordLean: 0.08,
  /** Depth of the plane the sleeves' centres sit on. */
  recordZ: -0.04,
  /** The area of the header board that a shelf's name is engraved into. */
  labelWidth: COLUMNS * CELL_WIDTH - 0.1,
  labelHeight: HEADER_HEIGHT,
});

/** Slot index runs left to right, top to bottom. Returns the centre of the sleeve. */
export function recordCenter(slotIndex) {
  const column = slotIndex % COLUMNS;
  const rowFromTop = Math.floor(slotIndex / COLUMNS);
  const rowFromBottom = ROWS - 1 - rowFromTop;
  const cellBottom = PLINTH + BOARD + rowFromBottom * (BOARD + CELL_HEIGHT);
  return {
    x: (column + 0.5 - COLUMNS / 2) * CELL_WIDTH,
    y: cellBottom + SHELF.sleeveHalf * Math.cos(SHELF.recordLean) + 0.005,
    z: SHELF.recordZ,
  };
}
