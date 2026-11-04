// Real coastlines for the server: is a [lon, lat] point on land? Uses the same world outline as the landing page.
const fs = require('fs'), path = require('path');
module.exports = function landTester(file) {
  let polys = [];
  try {
    const txt = fs.readFileSync(file || path.join(__dirname, 'public', 'landing-land.js'), 'utf8');
    const g = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
    for (const geo of g.geometries || []) {
      const list = geo.type === 'Polygon' ? [geo.coordinates] : geo.type === 'MultiPolygon' ? geo.coordinates : [];
      for (const rings of list) {
        let x0 = 180, x1 = -180, y0 = 90, y1 = -90;
        for (const [x, y] of rings[0]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        polys.push({ rings, b: [x0, y0, x1, y1] });
      }
    }
  } catch (e) { polys = null; }
  if (!polys || !polys.length) return null;
  const inRing = (x, y, r) => { let inside = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside; } return inside; };
  return ([x, y]) => { for (const p of polys) { const b = p.b; if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue; if (inRing(x, y, p.rings[0]) && !p.rings.slice(1).some(h => inRing(x, y, h))) return true; } return false; };
};
