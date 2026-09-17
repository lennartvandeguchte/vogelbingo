// EPSG:28992 (RD New / Amersfoort) projection and the 10x10 km cell grid.
// Build-time only: the browser never projects anything.
import proj4 from 'proj4';

// Definition from epsg.io/28992 (with the 7-parameter Bessel → WGS84 shift).
proj4.defs(
  'EPSG:28992',
  '+proj=sterea +lat_0=52.15616055555555 +lon_0=5.38763888888889 +k=0.9999079 ' +
    '+x_0=155000 +y_0=463000 +ellps=bessel ' +
    '+towgs84=565.417,50.3319,465.552,-0.398957,0.343988,-1.8774,4.0725 +units=m +no_defs',
);

export const CELL_SIZE = 10000; // metres
export const ORIGIN = [0, 300000]; // RD x, y of the grid's south-west corner
export const COLS = 28; // 0 .. 280 km
export const ROWS = 33; // 300 .. 630 km

/** WGS84 lon/lat → RD [x, y] in metres. */
export function toRD(lon, lat) {
  return proj4('EPSG:4326', 'EPSG:28992', [lon, lat]);
}

/** RD [x, y] → integer cell id, or null when outside the grid. */
export function cellIdFromRD(x, y) {
  const col = Math.floor((x - ORIGIN[0]) / CELL_SIZE);
  const row = Math.floor((y - ORIGIN[1]) / CELL_SIZE);
  if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return null;
  return row * 100 + col;
}

export function cellId(lon, lat) {
  const [x, y] = toRD(lon, lat);
  return cellIdFromRD(x, y);
}

export function cellRowCol(id) {
  return { row: Math.floor(id / 100), col: id % 100 };
}

/** Cell ids in the square ring at Chebyshev distance `ring` around `id` (ring 0 = the cell). */
export function ringCells(id, ring) {
  const { row, col } = cellRowCol(id);
  const out = [];
  for (let r = row - ring; r <= row + ring; r++) {
    for (let c = col - ring; c <= col + ring; c++) {
      if (Math.max(Math.abs(r - row), Math.abs(c - col)) !== ring) continue;
      if (r < 0 || r >= ROWS || c < 0 || c >= COLS) continue;
      out.push(r * 100 + c);
    }
  }
  return out;
}

/** Approximate radius in km covered by `ring` rings around a cell. */
export function ringRadiusKm(ring) {
  return (ring + 0.5) * (CELL_SIZE / 1000);
}
